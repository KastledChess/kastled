import { supabaseClient } from './config.js';

let stockfishWorker = null;
let moveAnalysisData = [];
let isBatchAnalyzing = false;
let currentBatchWorkerResolve = null;
let currentBatchEval = 0;

export function getClassificationMeta(catCode) {
    switch(parseInt(catCode, 10)) {
        case 1:  return { name: 'Brilliant', badge: '‼', colorClass: 'bg-teal-500 text-white', iconBg: '#0D9488' };
        case 2:  return { name: 'Great', badge: '!', colorClass: 'bg-blue-500 text-white', iconBg: '#2563EB' };
        case 3:  return { name: 'Best', badge: '⭐', colorClass: 'bg-emerald-500 text-white', iconBg: '#10B981' };
        case 4:  return { name: 'Excellent', badge: '👍', colorClass: 'bg-lime-600 text-white', iconBg: '#65A30D' };
        case 5:  return { name: 'Good', badge: '✔', colorClass: 'bg-slate-600 text-white', iconBg: '#475569' };
        case 6:  return { name: 'Book', badge: '📖', colorClass: 'bg-amber-700 text-white', iconBg: '#B45309' };
        case 7:  return { name: 'Inaccuracy', badge: '?!', colorClass: 'bg-yellow-500 text-black', iconBg: '#EAB308' };
        case 8:  return { name: 'Mistake', badge: '?', colorClass: 'bg-orange-500 text-white', iconBg: '#F97316' };
        case 9:  return { name: 'Miss', badge: '✕', colorClass: 'bg-rose-500 text-white', iconBg: '#F43F5E' };
        case 10: return { name: 'Blunder', badge: '??', colorClass: 'bg-red-600 text-white', iconBg: '#DC2626' };
        default: return { name: 'Best', badge: '⭐', colorClass: 'bg-emerald-500 text-white', iconBg: '#10B981' };
    }
}

export function initStockfish() {
    fetch('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js')
        .then(response => response.text())
        .then(scriptText => {
            const blob = new Blob([scriptText], { type: 'application/javascript' });
            const workerUrl = URL.createObjectURL(blob);

            stockfishWorker = new Worker(workerUrl);

            stockfishWorker.onmessage = function(event) {
                const line = event.data || '';

                if (line.includes('score cp') || line.includes('score mate')) {
                    let cp = 0;
                    if (line.includes('score cp')) {
                        const match = line.match(/score cp (-?\d+)/);
                        if (match) cp = parseInt(match[1], 10);
                    } else if (line.includes('score mate')) {
                        const match = line.match(/score mate (-?\d+)/);
                        if (match) {
                            const m = parseInt(match[1], 10);
                            cp = m > 0 ? (10000 - m * 100) : (-10000 - m * 100);
                        }
                    }
                    currentBatchEval = cp;
                }

                if (line.includes('bestmove')) {
                    const match = line.match(/bestmove\s+(\w+)/);
                    if (currentBatchWorkerResolve) {
                        const res = {
                            evalCp: currentBatchEval,
                            bestMove: match ? match[1] : ''
                        };
                        const resolve = currentBatchWorkerResolve;
                        currentBatchWorkerResolve = null;
                        resolve(res);
                    }
                }
            };

            stockfishWorker.postMessage('uci');
            stockfishWorker.postMessage('isready');
        })
        .catch(err => console.warn("Stockfish worker init warning:", err));
}

function evaluateFenWithStockfish(moveUciString) {
    return new Promise((resolve) => {
        if (!stockfishWorker) return resolve({ evalCp: 0, bestMove: '' });

        currentBatchEval = 0;
        currentBatchWorkerResolve = resolve;

        setTimeout(() => {
            if (currentBatchWorkerResolve) {
                const resCall = currentBatchWorkerResolve;
                currentBatchWorkerResolve = null;
                resCall({ evalCp: currentBatchEval, bestMove: '' });
            }
        }, 400);

        stockfishWorker.postMessage('stop');
        stockfishWorker.postMessage(`position startpos moves ${moveUciString}`);
        stockfishWorker.postMessage('go depth 10');
    });
}

/**
 * OPENING BOOK (Lichess chess-openings dataset - public domain, no API, no token)
 *
 * Every opening line is replayed and the BOARD POSITION after each move is stored.
 * A played move is Book if the position it creates is in this set, so transpositions
 * (reaching a known position by a different move order) are recognised as Book.
 */
const OPENING_BOOK_FILES = ['a', 'b', 'c', 'd', 'e'].map(
    letter => `https://raw.githubusercontent.com/lichess-org/chess-openings/master/${letter}.tsv`
);

// Position key = piece placement + side to move + castling rights
// (en passant and move counters are ignored so equal positions always match)
function positionKey(fen) {
    return fen.split(' ').slice(0, 3).join(' ');
}

let openingBookPromise = null;

function loadOpeningBook() {
    if (openingBookPromise) return openingBookPromise;

    openingBookPromise = (async () => {
        const positionSet = new Set();
        try {
            const texts = await Promise.all(
                OPENING_BOOK_FILES.map(url =>
                    fetch(url).then(r => (r.ok ? r.text() : ''))
                )
            );

            for (const text of texts) {
                for (const line of text.split('\n')) {
                    const parts = line.split('\t');
                    if (parts.length < 3 || parts[0].trim() === 'eco') continue;

                    // "1. e4 e5 2. Nf3 Nc6" -> ["e4","e5","Nf3","Nc6"]
                    const sans = parts[2]
                        .replace(/\d+\.(\.\.)?/g, ' ')
                        .trim()
                        .split(/\s+/)
                        .filter(Boolean);

                    const g = new Chess();
                    for (const san of sans) {
                        const mv = g.move(san);
                        if (!mv) break;
                        positionSet.add(positionKey(g.fen()));
                    }
                }
            }
        } catch (err) {
            console.warn('Opening book failed to load:', err);
        }

        if (positionSet.size === 0) {
            console.warn('Opening book is empty - Book moves will not be detected.');
            openingBookPromise = null; // allow a retry on the next analysis
        }
        return positionSet;
    })();

    return openingBookPromise;
}

function evalToWinProb(cp) {
    const winRate = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    return Math.max(0.001, Math.min(0.999, winRate / 100));
}

export function getMoveAnalysisData() { return moveAnalysisData; }
export function setMoveAnalysisData(data) { moveAnalysisData = data || []; }

export let currentActiveGameRecordRef = null;
export function setCurrentActiveGameRecord(rec) { currentActiveGameRecordRef = rec; }

export async function runFullGameAnalysis(activeGame, reviewHistory) {
    if (!activeGame || !reviewHistory || reviewHistory.length === 0) return;

    isBatchAnalyzing = true;

    const modal = document.getElementById('analysis-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    const progressText = document.getElementById('analysis-progress-text');
    const progressBar = document.getElementById('analysis-progress-bar');

    let uciHistory = [];
    let positionKeys = [];
    let tempGame = new Chess();

    // Construct full UCI move history and the position after every move
    for (let i = 0; i < reviewHistory.length; i++) {
        const m = tempGame.move(reviewHistory[i]);
        if (m) {
            uciHistory.push(m.from + m.to + (m.promotion || ''));
            positionKeys.push(positionKey(tempGame.fen()));
        }
    }

    // PHASE 1: CHECK OPENING BOOK (position based)
    let bookMask = new Array(reviewHistory.length).fill(false);

    if (progressText) progressText.innerText = "Checking Opening Theory...";
    if (progressBar) progressBar.style.width = "10%";

    const bookPositions = await loadOpeningBook();

    // A move is Book while the game stays inside known opening positions
    for (let ply = 1; ply <= positionKeys.length; ply++) {
        if (bookPositions.has(positionKeys[ply - 1])) {
            bookMask[ply - 1] = true;
        } else {
            break; // Left opening theory; stop checking
        }
    }

    // PHASE 2: STOCKFISH ENGINE ANALYSIS
    let evalHistory = [{ evalCp: 0, winProb: 0.5, bestMove: '' }];

    for (let i = 0; i < reviewHistory.length; i++) {
        const ply = i + 1;

        const pct = Math.min(100, Math.round(10 + ((ply / reviewHistory.length) * 90)));
        if (progressText) progressText.innerText = `Evaluating position ${ply} of ${reviewHistory.length}... (${pct}%)`;
        if (progressBar) progressBar.style.width = `${pct}%`;

        const movesSoFar = uciHistory.slice(0, ply).join(' ');
        const evalRes = await evaluateFenWithStockfish(movesSoFar);

        const isWhite = (ply % 2 === 1);
        let whiteCp = isWhite ? -evalRes.evalCp : evalRes.evalCp;

        evalHistory[ply] = {
            evalCp: whiteCp,
            winProb: evalToWinProb(whiteCp),
            bestMove: evalRes.bestMove || ''
        };
    }

    // PHASE 3: MAP FINAL CATEGORIES & SAVE TO SUPABASE
    let structuredAnalysis = [{ ply: 0, move: 'Start', eval: 0.0, cat: 3, code: 'Best', bestMove: '' }];
    let whiteScores = [];
    let blackScores = [];

    for (let ply = 1; ply <= reviewHistory.length; ply++) {
        const moveObj = reviewHistory[ply - 1];
        const isWhite = (ply % 2 === 1);
        const prevEval = evalHistory[ply - 1];
        const currEval = evalHistory[ply];

        const winLossPct = isWhite
            ? (prevEval.winProb - currEval.winProb)
            : (currEval.winProb - prevEval.winProb);

        let catCode = 3;
        let scoreValue = 100;

        if (bookMask[ply - 1]) {
            catCode = 6; // Book
            scoreValue = 100;
        } else if (moveObj.san && moveObj.san.includes('#')) {
            catCode = 3;
            scoreValue = 100;
        } else if (Math.abs(prevEval.evalCp) >= 500 && winLossPct > 0.25) {
            catCode = 9;
            scoreValue = 15; // Miss
        } else if (winLossPct > 0.25) {
            catCode = 10;
            scoreValue = 0; // Blunder
        } else if (winLossPct > 0.14) {
            catCode = 8;
            scoreValue = 30; // Mistake
        } else if (winLossPct > 0.07) {
            catCode = 7;
            scoreValue = 60; // Inaccuracy
        } else if (winLossPct > 0.03) {
            catCode = 5;
            scoreValue = 80; // Good
        } else if (winLossPct > 0.01) {
            catCode = 4;
            scoreValue = 92; // Excellent
        } else if (winLossPct <= -0.03) {
            catCode = 2;
            scoreValue = 100; // Great
        } else {
            catCode = 3;
            scoreValue = 100; // Best
        }

        const meta = getClassificationMeta(catCode);

        structuredAnalysis[ply] = {
            ply: ply,
            move: moveObj.san,
            eval: parseFloat((currEval.evalCp / 100.0).toFixed(2)),
            cat: catCode,
            code: meta.name,
            bestMove: currEval.bestMove || ''
        };

        if (isWhite) whiteScores.push(scoreValue);
        else blackScores.push(scoreValue);
    }

    moveAnalysisData = structuredAnalysis;

    const avgWhiteAcc = whiteScores.length ? whiteScores.reduce((a, b) => a + b, 0) / whiteScores.length : 80.0;
    const avgBlackAcc = blackScores.length ? blackScores.reduce((a, b) => a + b, 0) / blackScores.length : 72.6;

    const wAccStr = `${avgWhiteAcc.toFixed(1)}%`;
    const bAccStr = `${avgBlackAcc.toFixed(1)}%`;

    if (currentActiveGameRecordRef && supabaseClient) {
        currentActiveGameRecordRef.accuracy = wAccStr;
        currentActiveGameRecordRef.black_accuracy = bAccStr;
        currentActiveGameRecordRef.is_reviewed = true;
        currentActiveGameRecordRef.analysis_data = moveAnalysisData;

        await supabaseClient
            .from('games')
            .update({
                accuracy: wAccStr,
                black_accuracy: bAccStr,
                is_reviewed: true,
                analysis_data: moveAnalysisData
            })
            .eq('id', currentActiveGameRecordRef.id);
    }

    isBatchAnalyzing = false;
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

export function analyzeCurrentPosition(activeGame, currentReviewIndex) {
    if (!activeGame || isBatchAnalyzing) return;
    const statusEl = document.getElementById('engine-status');

    if (moveAnalysisData[currentReviewIndex]) {
        if (statusEl) statusEl.innerText = 'Analysis Complete';
        const currentData = moveAnalysisData[currentReviewIndex];
        const evalScoreEl = document.getElementById('eval-score');
        const classificationTextEl = document.getElementById('classification-text');
        const bestMoveEl = document.getElementById('best-move-text');

        if (evalScoreEl && currentData.eval !== undefined) {
            const formattedEval = currentData.eval > 0 ? `+${currentData.eval.toFixed(1)}` : currentData.eval.toFixed(1);
            evalScoreEl.innerText = `Eval: ${formattedEval}`;
        }

        if (classificationTextEl && currentData.cat) {
            const meta = getClassificationMeta(currentData.cat);
            classificationTextEl.innerHTML = `<span class="px-2.5 py-1 rounded-lg text-xs font-bold ${meta.colorClass} inline-flex items-center gap-1.5 mr-2"><span>${meta.badge}</span> ${meta.name}</span>`;
        }

        if (bestMoveEl) {
            bestMoveEl.innerText = currentData.bestMove || 'N/A';
        }
    }
}
