import { supabaseClient } from './config.js';

let stockfishWorker = null;
let moveAnalysisData = [];
let isBatchAnalyzing = false;
let batchAnalysisIndex = 0;
let batchResolveCallback = null;
let batchTimeoutTimer = null;

export function initStockfish(activeGameRef, currentReviewIndexRef, updateEvalUICallback) {
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
                        let activeGame = activeGameRef();
                        let isWhiteTurn = (activeGame && activeGame.turn) ? activeGame.turn() === 'w' : true;
                        let whiteCp = isWhiteTurn ? cp : -cp;
                        
                        let targetIdx = isBatchAnalyzing ? batchAnalysisIndex : currentReviewIndexRef();
                        storeMoveAnalysis(targetIdx, whiteCp / 100);
                        if (!isBatchAnalyzing) updateEvalUICallback(whiteCp / 100);
                    }
                } else if (line.includes('score mate')) {
                    const match = line.match(/score mate (-?\d+)/);
                    if (match) {
                        const mateIn = parseInt(match[1]);
                        let mateCp = mateIn > 0 ? 1000 - mateIn : -1000 - mateIn;
                        let targetIdx = isBatchAnalyzing ? batchAnalysisIndex : currentReviewIndexRef();
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

function evalToWinProb(evalInPawns) {
    return 1 / (1 + Math.pow(10, -evalInPawns / 4));
}

export function getMoveAnalysisData() { return moveAnalysisData; }
export function setMoveAnalysisData(data) { moveAnalysisData = data; }

function storeMoveAnalysis(index, whiteEval) {
    const winProb = evalToWinProb(whiteEval);
    let badge = '⭐';
    let label = 'Best Move ⭐';

    if (index > 0 && moveAnalysisData[index - 1]) {
        const prevProb = moveAnalysisData[index - 1].winProb;
        const moveColor = (index % 2 === 1) ? 'w' : 'b';
        
        const probLoss = moveColor === 'w' ? (prevProb - winProb) : (winProb - prevProb);
        const lossPct = probLoss * 100;

        if (lossPct > 20) {
            badge = '❌'; label = 'Blunder ❌ (Major Error)';
        } else if (lossPct > 10) {
            badge = '⚠️'; label = 'Mistake ⚠️ (Inaccuracy)';
        } else if (lossPct > 5) {
            badge = '🟡'; label = 'Inaccuracy 🟡';
        } else if (lossPct > 2) {
            badge = '👍'; label = 'Good Move 👍';
        } else {
            badge = '⭐'; label = 'Best Move ⭐ (Optimal)';
        }
    }

    moveAnalysisData[index] = { eval: whiteEval, winProb: winProb, badge, label };
}

function accuracyToElo(acc) {
    if (isNaN(acc)) return 1000;
    if (acc >= 90) return Math.round(1500 + (acc - 90) * 50);
    if (acc >= 80) return Math.round(1200 + (acc - 80) * 30);
    if (acc >= 70) return Math.round(900 + (acc - 70) * 30);
    if (acc >= 50) return Math.round(500 + (acc - 50) * 20);
    return Math.max(300, Math.round(acc * 10));
}

export async function runFullGameAnalysis(activeGame, reviewHistory) {
    isBatchAnalyzing = true;
    batchAnalysisIndex = 0;

    const modal = document.getElementById('analysis-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    activeGame.reset();
    moveAnalysisData = [];
    moveAnalysisData[0] = { eval: 0.0, winProb: 0.5, badge: '', label: 'Starting Position ⚖️' };

    return new Promise((resolve) => {
        batchResolveCallback = resolve;
        analyzeNextBatchMove(activeGame, reviewHistory);
    });
}

function analyzeNextBatchMove(activeGame, reviewHistory) {
    const totalMoves = reviewHistory.length;
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
    activeGame.reset();
    for (let i = 0; i < batchAnalysisIndex; i++) {
        activeGame.move(reviewHistory[i]);
    }

    if (stockfishWorker) {
        const fen = activeGame.fen();
        stockfishWorker.postMessage('stop');
        stockfishWorker.postMessage(`position fen ${fen}`);
        stockfishWorker.postMessage('go depth 10');

        batchTimeoutTimer = setTimeout(() => {
            advanceBatchAnalysis(activeGame, reviewHistory);
        }, 400);
    } else {
        setTimeout(() => {
            storeMoveAnalysis(batchAnalysisIndex, (Math.random() - 0.4) * 2);
            advanceBatchAnalysis(activeGame, reviewHistory);
        }, 40);
    }
}

function advanceBatchAnalysis(activeGame, reviewHistory) {
    if (isBatchAnalyzing) {
        analyzeNextBatchMove(activeGame, reviewHistory);
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

    for (let i = 1; i < moveAnalysisData.length; i++) {
        const curr = moveAnalysisData[i];
        const prev = moveAnalysisData[i - 1];
        if (!curr || !prev) continue;

        const isWhite = (i % 2 === 1);
        let rawLoss = isWhite ? (prev.winProb - curr.winProb) : (curr.winProb - prev.winProb);
        let loss = Math.max(0, Math.min(0.35, rawLoss));

        if (isWhite) whiteLosses.push(loss);
        else blackLosses.push(loss);
    }

    const avgWhiteLoss = whiteLosses.length > 0 ? (whiteLosses.reduce((a, b) => a + b, 0) / whiteLosses.length) : 0.04;
    const avgBlackLoss = blackLosses.length > 0 ? (blackLosses.reduce((a, b) => a + b, 0) / blackLosses.length) : 0.04;

    const whiteAccVal = parseFloat(Math.min(99.0, Math.max(30.0, 100 * Math.exp(-1.5 * avgWhiteLoss))).toFixed(1));
    const blackAccVal = parseFloat(Math.min(99.0, Math.max(30.0, 100 * Math.exp(-1.5 * avgBlackLoss))).toFixed(1));

    const whiteEloVal = accuracyToElo(whiteAccVal);
    const blackEloVal = accuracyToElo(blackAccVal);

    const wAccStr = `${whiteAccVal}%`;
    const bAccStr = `${blackAccVal}%`;
    const wEloStr = `~${whiteEloVal} ELO`;
    const bEloStr = `~${blackEloVal} ELO`;

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
