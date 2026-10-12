import { supabaseClient } from './config.js';

let stockfishWorker = null;
let moveAnalysisData = [];
let isBatchAnalyzing = false;
let batchAnalysisIndex = 0;
let batchResolveCallback = null;

let getActiveGame = null;
let getCurrentReviewIndex = null;
let updateEvalUICallback = null;

// 10-Category Definitions with Visual Styles
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

export function initStockfish(activeGameRef, currentReviewIndexRef, evalCallback) {
    getActiveGame = activeGameRef;
    getCurrentReviewIndex = currentReviewIndexRef;
    updateEvalUICallback = evalCallback;

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

                    if (currentBatchWorkerResolve) {
                        currentBatchEval = cp;
                    }
                }

                if (line.includes('bestmove')) {
                    const match = line.match(/bestmove\s+(\w+)/);
                    if (currentBatchWorkerResolve) {
                        const res = { evalCp: currentBatchEval, bestMove: match ? match[1] : '' };
                        const resolve = currentBatchWorkerResolve;
                        currentBatchWorkerResolve = null;
                        resolve(res);
                    }
                }
            };

            stockfishWorker.postMessage('uci');
            stockfishWorker.postMessage('isready');
        })
        .catch(err => console.warn("Stockfish Worker fallback active:", err));
}

let currentBatchEval = 0;
let currentBatchWorkerResolve = null;

function evaluateFenWithStockfish(moveUciString) {
    return new Promise((resolve) => {
        if (!stockfishWorker) {
            return resolve({ evalCp: 0, bestMove: '' });
        }
        currentBatchEval = 0;
        currentBatchWorkerResolve = resolve;
        stockfishWorker.postMessage('stop');
        stockfishWorker.postMessage(`position startpos moves ${moveUciString}`);
        stockfishWorker.postMessage('go depth 13');
    });
}

function evalToWinProb(cp) {
    const winRate = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    return Math.max(0.001, Math.min(0.999, winRate / 100));
}

export function getMoveAnalysisData() { return moveAnalysisData; }
export function setMoveAnalysisData(data) { moveAnalysisData = data || []; }

export let currentActiveGameRecordRef = null;
export function setCurrentActiveGameRecord(rec) { currentActiveGameRecordRef = rec; }

function parsePgnHeader(pgnText, tag) {
    if (!pgnText) return null;
    const regex = new RegExp(`\\[${tag}\\s+"([^"]+)"\\]`, 'i');
    const match = pgnText.match(regex);
    return match ? match[1] : null;
}

// BATCH ANALYSIS WITH DUAL-EVALUATION DELTA LOGIC
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

    let structuredAnalysis = [];
    structuredAnalysis[0] = { ply: 0, move: 'Start', eval: 0.0, cat: 3, code: 'Best', bestMove: '' };

    let uciHistory = [];
    let tempGame = new Chess();

    let whiteScores = [];
    let blackScores = [];

    // Evaluate opening moves up to move 6 (ply 12) as book moves
    const BOOK_PLY_DEPTH = 10;

    for (let i = 0; i < reviewHistory.length; i++) {
        const ply = i + 1;
        const moveObj = reviewHistory[i];
        const isWhite = (ply % 2 === 1);

        const pct = Math.min(100, Math.round((ply / reviewHistory.length) * 100));
        if (progressText) progressText.innerText = `Analyzing move ${ply} of ${reviewHistory.length}... (${pct}%)`;
        if (progressBar) progressBar.style.width = `${pct}%`;

        // Get board state before move
        const uciBefore = uciHistory.join(' ');
        const preEvalRes = await evaluateFenWithStockfish(uciBefore);

        // Apply move to get board state after move
        const m = tempGame.move(moveObj);
        if (m) uciHistory.push(m.from + m.to + (m.promotion || ''));
        const uciAfter = uciHistory.join(' ');
        const postEvalRes = await evaluateFenWithStockfish(uciAfter);

        // Convert centipawns to White perspective
        let preWhiteCp = isWhite ? preEvalRes.evalCp : -preEvalRes.evalCp;
        let postWhiteCp = isWhite ? -postEvalRes.evalCp : postEvalRes.evalCp;

        let preWinProb = evalToWinProb(preWhiteCp);
        let postWinProb = evalToWinProb(postWhiteCp);

        // Delta win probability for the active player
        let winLossPct = isWhite ? (preWinProb - postWinProb) : (postWinProb - preWinProb);

        let catCode = 3;
        let scoreValue = 100;

        // CHECKMATE DELIVERED
        if (moveObj.san.includes('#')) {
            catCode = 3; // Best / Mate
            scoreValue = 100;
        }
        // BOOK MOVES
        else if (ply <= BOOK_PLY_DEPTH && winLossPct <= 0.03) {
            catCode = 6; // Book (📖)
            scoreValue = 100;
        }
        // MISSED CHECKMATE OR MISSED HUGE WIN
        else if (Math.abs(preWhiteCp) >= 500 && winLossPct > 0.25) {
            catCode = 9; // Miss (✕)
            scoreValue = 15;
        }
        // BLUNDER
        else if (winLossPct > 0.25) {
            catCode = 10; // Blunder (??)
            scoreValue = 0;
        }
        // MISTAKE
        else if (winLossPct > 0.14) {
            catCode = 8; // Mistake (?)
            scoreValue = 30;
        }
        // INACCURACY
        else if (winLossPct > 0.07) {
            catCode = 7; // Inaccuracy (?!)
            scoreValue = 60;
        }
        // GOOD MOVE
        else if (winLossPct > 0.03) {
            catCode = 5; // Good (✔)
            scoreValue = 80;
        }
        // EXCELLENT MOVE
        else if (winLossPct > 0.01) {
            catCode = 4; // Excellent (👍)
            scoreValue = 92;
        }
        // GREAT MOVE
        else if (winLossPct <= -0.03) {
            catCode = 2; // Great (!)
            scoreValue = 100;
        }
        // BEST MOVE
        else {
            catCode = 3; // Best (⭐)
            scoreValue = 100;
        }

        const meta = getClassificationMeta(catCode);
        const evalInPawns = postWhiteCp / 100.0;

        structuredAnalysis[ply] = {
            ply: ply,
            move: moveObj.san,
            eval: parseFloat(evalInPawns.toFixed(2)),
            cat: catCode,
            code: meta.name,
            bestMove: preEvalRes.bestMove || ''
        };

        if (isWhite) whiteScores.push(scoreValue);
        else blackScores.push(scoreValue);
    }

    moveAnalysisData = structuredAnalysis;

    // Calculate game accuracies and ELO
    const avgWhiteAcc = whiteScores.length ? whiteScores.reduce((a, b) => a + b, 0) / whiteScores.length : 80.0;
    const avgBlackAcc = blackScores.length ? blackScores.reduce((a, b) => a + b, 0) / blackScores.length : 72.6;

    const whiteAccVal = parseFloat(Math.max(30.0, Math.min(99.0, avgWhiteAcc)).toFixed(1));
    const blackAccVal = parseFloat(Math.max(30.0, Math.min(99.0, avgBlackAcc)).toFixed(1));

    let pgnString = currentActiveGameRecordRef ? currentActiveGameRecordRef.pgn : null;
    let whiteBaseElo = 820;
    let blackBaseElo = 788;

    if (pgnString) {
        const wPgn = parsePgnHeader(pgnString, 'WhiteElo');
        const bPgn = parsePgnHeader(pgnString, 'BlackElo');
        if (wPgn && !isNaN(parseInt(wPgn, 10))) whiteBaseElo = parseInt(wPgn, 10);
        if (bPgn && !isNaN(parseInt(bPgn, 10))) blackBaseElo = parseInt(bPgn, 10);
    }

    function computeGameRating(acc, baseElo) {
        const delta = acc - 70.0;
        let rating = baseElo + 400 + (delta * 18.0);
        if (acc < 70.0) {
            rating = baseElo - ((70.0 - acc) * 22.0);
        }
        return Math.round(Math.max(250, Math.min(2600, rating)));
    }

    const whiteEloVal = computeGameRating(whiteAccVal, whiteBaseElo);
    const blackEloVal = computeGameRating(blackAccVal, blackBaseElo);

    const wAccStr = `${whiteAccVal}%`;
    const bAccStr = `${blackAccVal}%`;
    const wEloStr = `~${whiteEloVal} Game Rating`;
    const bEloStr = `~${blackEloVal} Game Rating`;

    if (currentActiveGameRecordRef) {
        currentActiveGameRecordRef.accuracy = wAccStr;
        currentActiveGameRecordRef.black_accuracy = bAccStr;
        currentActiveGameRecordRef.white_elo = wEloStr;
        currentActiveGameRecordRef.black_elo = bEloStr;
        currentActiveGameRecordRef.is_reviewed = true;
        currentActiveGameRecordRef.analysis_data = moveAnalysisData;

        if (supabaseClient) {
            try {
                await supabaseClient
                    .from('games')
                    .update({
                        accuracy: wAccStr,
                        black_accuracy: bAccStr,
                        white_elo: wEloStr,
                        black_elo: bEloStr,
                        is_reviewed: true,
                        analysis_data: moveAnalysisData
                    })
                    .eq('id', currentActiveGameRecordRef.id);
            } catch (err) {
                console.warn("Database sync error:", err);
            }
        }
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
