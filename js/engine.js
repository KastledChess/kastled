import { supabaseClient } from './config.js';

let stockfishWorker = null;
let moveAnalysisData = [];
let isBatchAnalyzing = false;
let batchAnalysisIndex = 0;
let batchResolveCallback = null;
let batchTimeoutTimer = null;

let getActiveGame = null;
let getCurrentReviewIndex = null;
let updateEvalUICallback = null;

// 10-Category Definitions with Vibrant Badge Styling
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

                if (line.includes('score cp')) {
                    const match = line.match(/score cp (-?\d+)/);
                    if (match) {
                        let cp = parseInt(match[1], 10);
                        let activeGame = getActiveGame ? getActiveGame() : null;
                        let isWhiteTurn = (activeGame && activeGame.turn) ? activeGame.turn() === 'w' : true;
                        let whiteCp = isWhiteTurn ? cp : -cp;

                        let targetIdx = isBatchAnalyzing
                            ? batchAnalysisIndex
                            : (getCurrentReviewIndex ? getCurrentReviewIndex() : 0);

                        storeMoveEvalOnly(targetIdx, whiteCp / 100);
                        if (!isBatchAnalyzing && updateEvalUICallback) {
                            updateEvalUICallback(whiteCp / 100);
                        }
                    }
                } else if (line.includes('score mate')) {
                    const match = line.match(/score mate (-?\d+)/);
                    if (match) {
                        const mateIn = parseInt(match[1], 10);
                        let mateCp = mateIn > 0 ? 1000 - mateIn : -1000 - mateIn;
                        let targetIdx = isBatchAnalyzing
                            ? batchAnalysisIndex
                            : (getCurrentReviewIndex ? getCurrentReviewIndex() : 0);
                        storeMoveEvalOnly(targetIdx, mateCp / 100);
                    }
                }

                if (line.includes('bestmove')) {
                    const match = line.match(/bestmove\s+(\w+)/);
                    let bestFound = match && match[1] ? match[1] : '';
                    
                    if (isBatchAnalyzing) {
                        if (moveAnalysisData[batchAnalysisIndex]) {
                            moveAnalysisData[batchAnalysisIndex].bestMove = bestFound;
                        }
                        if (batchTimeoutTimer) clearTimeout(batchTimeoutTimer);
                        advanceBatchAnalysis();
                    } else {
                        const bestMoveEl = document.getElementById('best-move-text');
                        const statusEl = document.getElementById('engine-status');
                        if (bestMoveEl) bestMoveEl.innerText = bestFound || 'Analysis Complete';
                        if (statusEl) statusEl.innerText = 'Analysis Complete';
                    }
                }
            };

            stockfishWorker.postMessage('uci');
            stockfishWorker.postMessage('isready');
        })
        .catch(err => console.warn("Stockfish Worker fallback active:", err));
}

function evalToWinProb(cpPawns) {
    const cp = cpPawns * 100;
    const winRate = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    return Math.max(0.001, Math.min(0.999, winRate / 100));
}

export function getMoveAnalysisData() { return moveAnalysisData; }
export function setMoveAnalysisData(data) { moveAnalysisData = data || []; }

function storeMoveEvalOnly(index, whiteEval) {
    const winProb = evalToWinProb(whiteEval);
    if (!moveAnalysisData[index]) moveAnalysisData[index] = {};
    moveAnalysisData[index].eval = whiteEval;
    moveAnalysisData[index].winProb = winProb;
}

let currentBatchGame = null;
let currentBatchHistory = [];

export async function runFullGameAnalysis(activeGame, reviewHistory) {
    isBatchAnalyzing = true;
    batchAnalysisIndex = 0;
    currentBatchGame = activeGame;
    currentBatchHistory = reviewHistory;

    const modal = document.getElementById('analysis-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    currentBatchGame.reset();
    moveAnalysisData = [];
    moveAnalysisData[0] = { eval: 0.0, winProb: 0.5, cat: 3, bestMove: '' };

    return new Promise((resolve) => {
        batchResolveCallback = resolve;
        analyzeNextBatchMove();
    });
}

function analyzeNextBatchMove() {
    if (!currentBatchHistory) return;
    const totalMoves = currentBatchHistory.length;
    const progressText = document.getElementById('analysis-progress-text');
    const progressBar = document.getElementById('analysis-progress-bar');

    if (batchAnalysisIndex >= totalMoves) {
        onAnalysisComplete();
        return;
    }

    const pct = Math.min(100, Math.round(((batchAnalysisIndex + 1) / totalMoves) * 100));
    if (progressText) {
        progressText.innerText = `Evaluating move ${batchAnalysisIndex + 1} of ${totalMoves}... (${pct}%)`;
    }
    if (progressBar) progressBar.style.width = `${pct}%`;

    batchAnalysisIndex++;
    
    // Construct sequential move string for Stockfish
    let moveUcis = [];
    currentBatchGame.reset();
    for (let i = 0; i < batchAnalysisIndex; i++) {
        const m = currentBatchGame.move(currentBatchHistory[i]);
        if (m) moveUcis.push(m.from + m.to + (m.promotion || ''));
    }

    if (stockfishWorker) {
        stockfishWorker.postMessage('stop');
        stockfishWorker.postMessage(`position startpos moves ${moveUcis.join(' ')}`);
        stockfishWorker.postMessage('go depth 12');

        if (batchTimeoutTimer) clearTimeout(batchTimeoutTimer);
        batchTimeoutTimer = setTimeout(() => {
            if (isBatchAnalyzing) {
                const prevEval = moveAnalysisData[batchAnalysisIndex - 1] ? moveAnalysisData[batchAnalysisIndex - 1].eval : 0.0;
                storeMoveEvalOnly(batchAnalysisIndex, prevEval);
                advanceBatchAnalysis();
            }
        }, 400);
    } else {
        setTimeout(() => {
            const prevEval = moveAnalysisData[batchAnalysisIndex - 1] ? moveAnalysisData[batchAnalysisIndex - 1].eval : 0.0;
            storeMoveEvalOnly(batchAnalysisIndex, prevEval);
            advanceBatchAnalysis();
        }, 50);
    }
}

function advanceBatchAnalysis() {
    if (isBatchAnalyzing) {
        analyzeNextBatchMove();
    }
}

export let currentActiveGameRecordRef = null;
export function setCurrentActiveGameRecord(rec) { currentActiveGameRecordRef = rec; }

function parsePgnHeader(pgnText, tag) {
    if (!pgnText) return null;
    const regex = new RegExp(`\\[${tag}\\s+"([^"]+)"\\]`, 'i');
    const match = pgnText.match(regex);
    return match ? match[1] : null;
}

function onAnalysisComplete() {
    isBatchAnalyzing = false;
    if (batchTimeoutTimer) clearTimeout(batchTimeoutTimer);

    const progressText = document.getElementById('analysis-progress-text');
    const progressBar = document.getElementById('analysis-progress-bar');
    if (progressText) progressText.innerText = 'Analysis Complete! Saving Classifications...';
    if (progressBar) progressBar.style.width = '100%';

    let structuredAnalysis = [];
    let whiteScores = [];
    let blackScores = [];

    structuredAnalysis[0] = { ply: 0, move: 'Start', eval: 0.0, cat: 3, code: 'Best', bestMove: '' };

    for (let i = 1; i <= currentBatchHistory.length; i++) {
        const curr = moveAnalysisData[i] || { eval: 0.0, winProb: 0.5 };
        const prev = moveAnalysisData[i - 1] || { eval: 0.0, winProb: 0.5 };
        const moveObj = currentBatchHistory[i - 1];

        const isWhite = (i % 2 === 1);
        const winLossPct = isWhite ? (prev.winProb - curr.winProb) : (curr.winProb - prev.winProb);
        const opponentPrevWinLoss = isWhite 
            ? ((moveAnalysisData[i - 2]?.winProb || 0.5) - prev.winProb) 
            : (prev.winProb - (moveAnalysisData[i - 2]?.winProb || 0.5));

        let catCode = 3; // Default Best (⭐)
        let scoreValue = 100;

        if (i <= 8 && winLossPct >= -0.02) {
            catCode = 6; // Book (📖)
            scoreValue = 100;
        } else if (winLossPct > 0.22) {
            catCode = 10; // Blunder (??)
            scoreValue = 0;
        } else if (opponentPrevWinLoss > 0.15 && winLossPct > 0.08) {
            catCode = 9; // Miss (✕)
            scoreValue = 20;
        } else if (winLossPct > 0.12) {
            catCode = 8; // Mistake (?)
            scoreValue = 25;
        } else if (winLossPct > 0.05) {
            catCode = 7; // Inaccuracy (?!)
            scoreValue = 50;
        } else if (winLossPct > 0.01) {
            catCode = 5; // Good (✔)
            scoreValue = 75;
        } else if (winLossPct > -0.01) {
            catCode = 4; // Excellent (👍)
            scoreValue = 90;
        } else if (moveObj && (moveObj.flags.includes('c') || moveObj.captured) && winLossPct <= -0.02) {
            catCode = 1; // Brilliant (‼)
            scoreValue = 100;
        } else if (winLossPct <= -0.03) {
            catCode = 2; // Great (!)
            scoreValue = 100;
        } else {
            catCode = 3; // Best (⭐)
            scoreValue = 100;
        }

        const meta = getClassificationMeta(catCode);
        const moveStr = moveObj ? moveObj.san : '';

        structuredAnalysis[i] = {
            ply: i,
            move: moveStr,
            eval: curr.eval,
            cat: catCode,
            code: meta.name,
            bestMove: curr.bestMove || ''
        };

        if (isWhite) whiteScores.push(scoreValue);
        else blackScores.push(scoreValue);
    }

    moveAnalysisData = structuredAnalysis;

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
            supabaseClient
                .from('games')
                .update({
                    accuracy: wAccStr,
                    black_accuracy: bAccStr,
                    white_elo: wEloStr,
                    black_elo: bEloStr,
                    is_reviewed: true,
                    analysis_data: moveAnalysisData
                })
                .eq('id', currentActiveGameRecordRef.id)
                .then(() => {})
                .catch(err => console.warn("Database sync deferred:", err));
        }
    }

    setTimeout(() => {
        const modal = document.getElementById('analysis-modal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        if (batchResolveCallback) {
            const resolve = batchResolveCallback;
            batchResolveCallback = null;
            resolve();
        }
    }, 200);
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
        return;
    }

    if (stockfishWorker) {
        const fen = activeGame.fen();
        stockfishWorker.postMessage('stop');
        stockfishWorker.postMessage(`position fen ${fen}`);
        stockfishWorker.postMessage('go depth 10');
    }
}
