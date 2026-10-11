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
                        let cp = parseInt(match[1]);
                        let activeGame = getActiveGame ? getActiveGame() : null;
                        let isWhiteTurn = (activeGame && activeGame.turn) ? activeGame.turn() === 'w' : true;
                        let whiteCp = isWhiteTurn ? cp : -cp;
                        
                        let targetIdx = isBatchAnalyzing ? batchAnalysisIndex : (getCurrentReviewIndex ? getCurrentReviewIndex() : 0);
                        storeMoveAnalysis(targetIdx, whiteCp / 100);
                        if (!isBatchAnalyzing && updateEvalUICallback) updateEvalUICallback(whiteCp / 100);
                    }
                } else if (line.includes('score mate')) {
                    const match = line.match(/score mate (-?\d+)/);
                    if (match) {
                        const mateIn = parseInt(match[1]);
                        let mateCp = mateIn > 0 ? 1000 - mateIn : -1000 - mateIn;
                        let targetIdx = isBatchAnalyzing ? batchAnalysisIndex : (getCurrentReviewIndex ? getCurrentReviewIndex() : 0);
                        storeMoveAnalysis(targetIdx, mateCp / 100);
                    }
                }

                if (line.includes('bestmove')) {
                    if (isBatchAnalyzing) {
                        if (batchTimeoutTimer) clearTimeout(batchTimeoutTimer);
                        advanceBatchAnalysis();
                    } else {
                        const match = line.match(/bestmove\s+(\w+)/);
                        if (match && match[1]) {
                            const bestMoveEl = document.getElementById('best-move-text');
                            const statusEl = document.getElementById('engine-status');
                            if (bestMoveEl) bestMoveEl.innerText = match[1];
                            if (statusEl) statusEl.innerText = 'Analysis Complete';
                        }
                    }
                }
            };

            stockfishWorker.postMessage('uci');
            stockfishWorker.postMessage('isready');
        })
        .catch(err => console.warn("Stockfish Worker fallback active:", err));
}

// 1. Convert Stockfish cp → win probability (Normalized 0.0 to 1.0)
function evalToWinProb(cpPawns) {
    const cp = cpPawns * 100;
    const W = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    return Math.max(0.001, Math.min(0.999, W / 100));
}

export function getMoveAnalysisData() { return moveAnalysisData; }
export function setMoveAnalysisData(data) { moveAnalysisData = data; }

function storeMoveAnalysis(index, whiteEval) {
    const winProb = evalToWinProb(whiteEval);
    let badge = '⭐';
    let label = 'Best Move ⭐';
    let category = 'Best';

    if (index > 0 && moveAnalysisData[index - 1]) {
        const prevProb = moveAnalysisData[index - 1].winProb;
        const moveColor = (index % 2 === 1) ? 'w' : 'b';
        
        const winLossPct = moveColor === 'w' ? (prevProb - winProb) : (winProb - prevProb);

        if (winLossPct > 0.20) {
            badge = '❌'; label = 'Blunder ❌'; category = 'Blunder';
        } else if (winLossPct > 0.10) {
            badge = '❓'; label = 'Mistake ❓'; category = 'Mistake';
        } else if (winLossPct > 0.05) {
            badge = '🟡'; label = 'Inaccuracy 🟡'; category = 'Inaccuracy';
        } else if (winLossPct > 0.01) {
            badge = '👍'; label = 'Good Move 👍'; category = 'Good';
        } else {
            badge = '⭐'; label = 'Best Move ⭐'; category = 'Best';
        }
    }

    moveAnalysisData[index] = { eval: whiteEval, winProb, badge, label, category };
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
    moveAnalysisData[0] = { eval: 0.0, winProb: 0.5, badge: '', label: 'Starting Position ⚖️', category: 'Best' };

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
    if (progressText) progressText.innerText = `Evaluating move ${batchAnalysisIndex + 1} of ${totalMoves}... (${pct}%)`;
    if (progressBar) progressBar.style.width = `${pct}%`;

    batchAnalysisIndex++;
    currentBatchGame.reset();
    for (let i = 0; i < batchAnalysisIndex; i++) {
        currentBatchGame.move(currentBatchHistory[i]);
    }

    if (stockfishWorker) {
        const fen = currentBatchGame.fen();
        stockfishWorker.postMessage('stop');
        stockfishWorker.postMessage(`position fen ${fen}`);
        stockfishWorker.postMessage('go depth 10');

        if (batchTimeoutTimer) clearTimeout(batchTimeoutTimer);
        batchTimeoutTimer = setTimeout(() => {
            if (isBatchAnalyzing) {
                const prevEval = moveAnalysisData[batchAnalysisIndex - 1] ? moveAnalysisData[batchAnalysisIndex - 1].eval : 0.0;
                storeMoveAnalysis(batchAnalysisIndex, prevEval);
                advanceBatchAnalysis();
            }
        }, 300);
    } else {
        setTimeout(() => {
            const prevEval = moveAnalysisData[batchAnalysisIndex - 1] ? moveAnalysisData[batchAnalysisIndex - 1].eval : 0.0;
            storeMoveAnalysis(batchAnalysisIndex, prevEval);
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

function onAnalysisComplete() {
    isBatchAnalyzing = false;
    if (batchTimeoutTimer) clearTimeout(batchTimeoutTimer);

    const progressText = document.getElementById('analysis-progress-text');
    const progressBar = document.getElementById('analysis-progress-bar');
    if (progressText) progressText.innerText = 'Analysis Complete! Loading Review...';
    if (progressBar) progressBar.style.width = '100%';

    let whiteLosses = [];
    let blackLosses = [];

    // 2. Compute per-move win-probability loss
    for (let i = 1; i < moveAnalysisData.length; i++) {
        const curr = moveAnalysisData[i];
        const prev = moveAnalysisData[i - 1];
        if (!curr || !prev) continue;

        const isWhite = (i % 2 === 1);
        let deltaW = isWhite ? Math.max(0, prev.winProb - curr.winProb) : Math.max(0, curr.winProb - prev.winProb);

        if (isWhite) whiteLosses.push(deltaW);
        else blackLosses.push(deltaW);
    }

    const avgWhiteLoss = whiteLosses.length > 0 ? (whiteLosses.reduce((a, b) => a + b, 0) / whiteLosses.length) : 0.02;
    const avgBlackLoss = blackLosses.length > 0 ? (blackLosses.reduce((a, b) => a + b, 0) / blackLosses.length) : 0.02;

    // 3. Calibrated Exponential Accuracy
    const rawWhiteAcc = 103.1668 * Math.exp(-4.0 * avgWhiteLoss) - 3.1669;
    const rawBlackAcc = 103.1668 * Math.exp(-4.0 * avgBlackLoss) - 3.1669;

    const whiteAccVal = parseFloat(Math.max(40, Math.min(99, rawWhiteAcc)).toFixed(1));
    const blackAccVal = parseFloat(Math.max(40, Math.min(99, rawBlackAcc)).toFixed(1));

    // 4. Logarithmic Game Rating Conversion
    const pW = Math.max(0.01, Math.min(0.98, whiteAccVal / 100));
    const pB = Math.max(0.01, Math.min(0.98, blackAccVal / 100));

    let whiteRating = 250 + 720 * Math.log(pW / (1 - pW));
    let blackRating = 250 + 720 * Math.log(pB / (1 - pB));

    const whiteEloVal = Math.round(Math.max(250, Math.min(1600, whiteRating)));
    const blackEloVal = Math.round(Math.max(250, Math.min(1600, blackRating)));

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

        if (supabaseClient) {
            supabaseClient
                .from('games')
                .update({ accuracy: wAccStr, black_accuracy: bAccStr, white_elo: wEloStr, black_elo: bEloStr, is_reviewed: true })
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
    if (statusEl) statusEl.innerText = 'Analyzing...';

    if (moveAnalysisData[currentReviewIndex] && moveAnalysisData[currentReviewIndex].bestMove) {
        const cached = moveAnalysisData[currentReviewIndex];
        if (statusEl) statusEl.innerText = 'Analysis Complete';
        return;
    }

    if (stockfishWorker) {
        const fen = activeGame.fen();
        stockfishWorker.postMessage('stop');
        stockfishWorker.postMessage(`position fen ${fen}`);
        stockfishWorker.postMessage('go depth 10');
    }
}
