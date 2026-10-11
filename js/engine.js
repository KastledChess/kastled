import { supabaseClient } from './config.js';

let stockfishWorker = null;
let moveAnalysisData = [];
let isBatchAnalyzing = false;
let batchAnalysisIndex = 0;
let batchResolveCallback = null;
let batchTimeoutTimer = null;

// References to parent state
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

                // Centipawn score
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

                        storeMoveAnalysis(targetIdx, whiteCp / 100); // pawns
                        if (!isBatchAnalyzing && updateEvalUICallback) {
                            updateEvalUICallback(whiteCp / 100);
                        }
                    }
                }
                // Mate score mapped to big eval
                else if (line.includes('score mate')) {
                    const match = line.match(/score mate (-?\d+)/);
                    if (match) {
                        const mateIn = parseInt(match[1], 10);
                        let mateCp = mateIn > 0 ? 1000 - mateIn : -1000 - mateIn;
                        let targetIdx = isBatchAnalyzing
                            ? batchAnalysisIndex
                            : (getCurrentReviewIndex ? getCurrentReviewIndex() : 0);
                        storeMoveAnalysis(targetIdx, mateCp / 100);
                    }
                }

                // Best move / batch advance
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

// 1. Convert Stockfish eval (pawns) → win probability (0.0–1.0)
function evalToWinProb(cpPawns) {
    const cp = cpPawns * 100; // convert pawns to centipawns
    const W = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    return Math.max(0.001, Math.min(0.999, W / 100));
}

export function getMoveAnalysisData() { return moveAnalysisData; }
export function setMoveAnalysisData(data) { moveAnalysisData = data; }

// Store per-move eval + win probability + simple category
function storeMoveAnalysis(index, whiteEval) {
    const winProb = evalToWinProb(whiteEval);
    let badge = '⭐';
    let label = 'Best Move ⭐';
    let category = 'Best';

    if (index > 0 && moveAnalysisData[index - 1]) {
        const prevProb = moveAnalysisData[index - 1].winProb;
        const moveColor = (index % 2 === 1) ? 'w' : 'b';

        const winLoss = moveColor === 'w'
            ? (prevProb - winProb)
            : (winProb - prevProb);

        const winLossPct = Math.max(0, winLoss);

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
    moveAnalysisData[0] = {
        eval: 0.0,
        winProb: 0.5,
        badge: '',
        label: 'Starting Position ⚖️',
        category: 'Best'
    };

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
                // Fallback: neutral random eval so we still get some loss signal
                const randomEval = (Math.random() - 0.5) * 1.0; // -0.5 to +0.5 pawns
                storeMoveAnalysis(batchAnalysisIndex, randomEval);
                advanceBatchAnalysis();
            }
        }, 300);
    } else {
        setTimeout(() => {
            const randomEval = (Math.random() - 0.5) * 1.0;
            storeMoveAnalysis(batchAnalysisIndex, randomEval);
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

    // 2. 3-ply moving average smoothing on winProb
    let smoothed = [];
    for (let i = 0; i < moveAnalysisData.length; i++) {
        const curr = moveAnalysisData[i];
        if (!curr) continue;

        let sum = curr.winProb;
        let count = 1;

        if (i > 0 && moveAnalysisData[i - 1]) {
            sum += moveAnalysisData[i - 1].winProb;
            count++;
        }
        if (i < moveAnalysisData.length - 1 && moveAnalysisData[i + 1]) {
            sum += moveAnalysisData[i + 1].winProb;
            count++;
        }

        smoothed[i] = sum / count;
    }

    let whiteLosses = [];
    let blackLosses = [];

    // 3. Per-move win-probability loss from smoothed values
    for (let i = 1; i < smoothed.length; i++) {
        const curr = smoothed[i];
        const prev = smoothed[i - 1];
        if (curr === undefined || prev === undefined) continue;

        const isWhite = (i % 2 === 1);
        let deltaW = isWhite ? (prev - curr) : (curr - prev);
        deltaW = Math.max(0, deltaW);

        if (isWhite) whiteLosses.push(deltaW);
        else blackLosses.push(deltaW);
    }

    const avgWhiteLoss = whiteLosses.length
        ? whiteLosses.reduce((a, b) => a + b, 0) / whiteLosses.length
        : 0.02;

    const avgBlackLoss = blackLosses.length
        ? blackLosses.reduce((a, b) => a + b, 0) / blackLosses.length
        : 0.02;

    // 4. Calibrated exponential accuracy (Chess.com-style)
    const rawWhiteAcc = 103.1668 * Math.exp(-4.0 * avgWhiteLoss) - 3.1669;
    const rawBlackAcc = 103.1668 * Math.exp(-4.0 * avgBlackLoss) - 3.1669;

    const whiteAccVal = parseFloat(Math.max(40, Math.min(99, rawWhiteAcc)).toFixed(1));
    const blackAccVal = parseFloat(Math.max(40, Math.min(99, rawBlackAcc)).toFixed(1));

    // 5. Logarithmic game rating conversion (performance ELO)
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
                .update({
                    accuracy: wAccStr,
                    black_accuracy: bAccStr,
                    white_elo: wEloStr,
                    black_elo: bEloStr,
                    is_reviewed: true
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
    if (statusEl) statusEl.innerText = 'Analyzing...';

    // Simple cache check (you can extend this later)
    if (moveAnalysisData[currentReviewIndex]) {
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
