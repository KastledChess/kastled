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
                        let cp = parseInt(match[1], 10);
                        let activeGame = getActiveGame ? getActiveGame() : null;
                        let isWhiteTurn = (activeGame && activeGame.turn) ? activeGame.turn() === 'w' : true;
                        let whiteCp = isWhiteTurn ? cp : -cp;

                        let targetIdx = isBatchAnalyzing
                            ? batchAnalysisIndex
                            : (getCurrentReviewIndex ? getCurrentReviewIndex() : 0);

                        storeMoveAnalysis(targetIdx, whiteCp / 100);
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

function evalToWinProb(cpPawns) {
    const cp = cpPawns * 100;
    const winRate = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    return Math.max(0.001, Math.min(0.999, winRate / 100));
}

export function getMoveAnalysisData() { return moveAnalysisData; }
export function setMoveAnalysisData(data) { moveAnalysisData = data; }

function storeMoveAnalysis(index, whiteEval) {
    const winProb = evalToWinProb(whiteEval);
    moveAnalysisData[index] = { eval: whiteEval, winProb };
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
    moveAnalysisData[0] = { eval: 0.0, winProb: 0.5 };

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
                const prevEval = moveAnalysisData[batchAnalysisIndex - 1] ? moveAnalysisData[batchAnalysisIndex - 1].eval : 0.0;
                storeMoveAnalysis(batchAnalysisIndex, prevEval);
                advanceBatchAnalysis();
            }
        }, 400);
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
    if (progressText) progressText.innerText = 'Analysis Complete! Loading Review...';
    if (progressBar) progressBar.style.width = '100%';

    let whiteScores = [];
    let blackScores = [];

    // Post-process all moves cleanly after Stockfish pass completes
    for (let i = 1; i < moveAnalysisData.length; i++) {
        const curr = moveAnalysisData[i];
        const prev = moveAnalysisData[i - 1];
        if (!curr || !prev) continue;

        const isWhite = (i % 2 === 1);
        const winLossPct = isWhite ? (prev.winProb - curr.winProb) : (curr.winProb - prev.winProb);

        let scoreValue = 100;
        let category = 'Best';
        let badge = '⭐';
        let label = 'Best Move ⭐';

        if (winLossPct > 0.15) {
            scoreValue = 0; category = 'Blunder'; badge = '❌'; label = 'Blunder ❌';
        } else if (winLossPct > 0.08) {
            scoreValue = 25; category = 'Mistake'; badge = '❓'; label = 'Mistake ❓';
        } else if (winLossPct > 0.04) {
            scoreValue = 50; category = 'Inaccuracy'; badge = '🟡'; label = 'Inaccuracy 🟡';
        } else if (winLossPct > 0.01) {
            scoreValue = 75; category = 'Good'; badge = '👍'; label = 'Good Move 👍';
        } else if (winLossPct > 0.002) {
            scoreValue = 92; category = 'Excellent'; badge = '👍'; label = 'Excellent 👍';
        } else if (winLossPct < -0.02) {
            scoreValue = 100; category = 'Great'; badge = '❗'; label = 'Great Move ❗';
        }

        moveAnalysisData[i].category = category;
        moveAnalysisData[i].badge = badge;
        moveAnalysisData[i].label = label;
        moveAnalysisData[i].scoreValue = scoreValue;

        if (isWhite) whiteScores.push(scoreValue);
        else blackScores.push(scoreValue);
    }

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
