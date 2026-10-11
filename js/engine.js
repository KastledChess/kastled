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

// 1. Convert Stockfish eval (pawns) → win probability (0.0–1.0)
function evalToWinProb(cpPawns) {
    const cp = cpPawns * 100;
    const W = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    return Math.max(0.001, Math.min(0.999, W / 100));
}

export function getMoveAnalysisData() { return moveAnalysisData; }
export function setMoveAnalysisData(data) { moveAnalysisData = data; }

// Store per-move evaluation, win probability, badge, and CAPS category
function storeMoveAnalysis(index, whiteEval) {
    const winProb = evalToWinProb(whiteEval);
    let badge = '⭐';
    let label = 'Best Move ⭐';
    let category = 'Best';
    let scoreValue = 100; // CAPS score

    if (index > 0 && moveAnalysisData[index - 1]) {
        const prevProb = moveAnalysisData[index - 1].winProb;
        const moveColor = (index % 2 === 1) ? 'w' : 'b';

        const winLoss = moveColor === 'w'
            ? (prevProb - winProb)
            : (winProb - prevProb);

        const winLossPct = Math.max(0, winLoss);

        if (winLossPct > 0.20) {
            badge = '❌'; label = 'Blunder ❌'; category = 'Blunder'; scoreValue = 0;
        } else if (winLossPct > 0.12) {
            badge = '❓'; label = 'Mistake ❓'; category = 'Mistake'; scoreValue = 25;
        } else if (winLossPct > 0.06) {
            badge = '🟡'; label = 'Inaccuracy 🟡'; category = 'Inaccuracy'; scoreValue = 50;
        } else if (winLossPct > 0.02) {
            badge = '👍'; label = 'Excellent 👍'; category = 'Excellent'; scoreValue = 92;
        } else if (winLossPct < -0.02) {
            badge = '❗'; label = 'Great Move ❗'; category = 'Great'; scoreValue = 100;
        } else {
            badge = '⭐'; label = 'Best Move ⭐'; category = 'Best'; scoreValue = 100;
        }
    }

    moveAnalysisData[index] = { eval: whiteEval, winProb, badge, label, category, scoreValue };
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
        category: 'Best',
        scoreValue: 100
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

function parsePgnHeader(pgn, tag) {
    if (!pgn) return null;
    const regex = new RegExp(`\\[${tag}\\s+"([^"]+)"\\]`, 'i');
    const match = pgn.match(regex);
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

    // Collect CAPS score values per move for each player
    for (let i = 1; i < moveAnalysisData.length; i++) {
        const item = moveAnalysisData[i];
        if (!item) continue;
        const isWhite = (i % 2 === 1);
        if (isWhite) whiteScores.push(item.scoreValue);
        else blackScores.push(item.scoreValue);
    }

    const avgWhiteAcc = whiteScores.length ? whiteScores.reduce((a, b) => a + b, 0) / whiteScores.length : 75.0;
    const avgBlackAcc = blackScores.length ? blackScores.reduce((a, b) => a + b, 0) / blackScores.length : 75.0;

    const whiteAccVal = parseFloat(Math.max(30.0, Math.min(99.0, avgWhiteAcc)).toFixed(1));
    const blackAccVal = parseFloat(Math.max(30.0, Math.min(99.0, avgBlackAcc)).toFixed(1));

    // Pull PGN Base Elos if available
    let whiteBaseElo = 820;
    let blackBaseElo = 788;
    if (currentActiveGameRecordRef && currentActiveGameRecordRef.pgn) {
        const wPgn = parsePgnHeader(currentActiveGameRecordRef.pgn, 'WhiteElo');
        const bPgn = parsePgnHeader(currentActiveGameRecordRef.pgn, 'BlackElo');
        if (wPgn && !isNaN(parseInt(wPgn, 10))) whiteBaseElo = parseInt(wPgn, 10);
        if (bPgn && !isNaN(parseInt(bPgn, 10))) blackBaseElo = parseInt(bPgn, 10);
    }

    // Benchmark-matched Game Rating calculation
    function computeGameRating(acc, base) {
        let rating;
        if (acc >= 70.0) {
            rating = base + 400 + (acc - 70.0) * 18;
        } else {
            rating = base - (70.0 - acc) * 22;
        }
        return Math.round(Math.max(250, Math.min(2400, rating)));
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
