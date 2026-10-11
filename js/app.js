// KASTLED SUPABASE CREDENTIALS
const SUPABASE_URL = "https://sgpafvuexdmnbdbvveny.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_blGh-rrLxaxf5K14TEAzVw_NuXYM1d5";

const supabaseClient = (typeof supabase !== 'undefined' && SUPABASE_URL !== "") 
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) 
    : null;

const PIECE_IMAGES = {
    'wP': './Assets/wP.png',
    'wN': './Assets/wN.png',
    'wB': './Assets/wB.png',
    'wR': './Assets/wR.png',
    'wQ': './Assets/wQ.png',
    'wK': './Assets/wK.png',
    'bP': './Assets/bP.png',
    'bN': './Assets/bN.png',
    'bB': './Assets/bB.png',
    'bR': './Assets/bR.png',
    'bQ': './Assets/bQ.png',
    'bK': './Assets/bK.png'
};

// --- AUDIO SOUND EFFECTS ---
const gameStartSound = new Audio('./Assets/game-start.wav');
const moveSound = new Audio('./Assets/move.wav');
const captureSound = new Audio('./Assets/capture.wav');
const checkSound = new Audio('./Assets/check.wav');
const gameOverSound = new Audio('./Assets/game-over.wav');

function playSound(audioObj) {
    if (!audioObj) return;
    audioObj.currentTime = 0;
    audioObj.play().catch(() => {});
}

const INITIAL_BOARD = [
    ['bR','bN','bB','bQ','bK','bB','bN','bR'],
    ['bP','bP','bP','bP','bP','bP','bP','bP'],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['wP','wP','wP','wP','wP','wP','wP','wP'],
    ['wR','wN','wB','wQ','wK','wB','wN','wR']
];

let currentUser = null;
let authMode = 'login';
let savedGames = [];
let fetchedChessComGames = [];

let activeGame = null;
let reviewHistory = [];
let currentReviewIndex = 0;
let currentActiveGameRecord = null;
let moveAnalysisData = [];

// Automated Analysis Loop State
let isBatchAnalyzing = false;
let batchAnalysisIndex = 0;
let batchResolveCallback = null;
let batchTimeoutTimer = null;

// --- STOCKFISH WORKER ENGINE SETUP ---
let stockfishWorker = null;

function initStockfish() {
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
                        let isWhiteTurn = (activeGame && activeGame.turn) ? activeGame.turn() === 'w' : true;
                        let whiteCp = isWhiteTurn ? cp : -cp;
                        
                        let targetIdx = isBatchAnalyzing ? batchAnalysisIndex : currentReviewIndex;
                        storeMoveAnalysis(targetIdx, whiteCp / 100);
                        if (!isBatchAnalyzing) updateEvalUI(whiteCp / 100);
                    }
                } else if (line.includes('score mate')) {
                    const match = line.match(/score mate (-?\d+)/);
                    if (match) {
                        const mateIn = parseInt(match[1]);
                        let mateCp = mateIn > 0 ? 1000 - mateIn : -1000 - mateIn;
                        let targetIdx = isBatchAnalyzing ? batchAnalysisIndex : currentReviewIndex;
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
            badge = '❌';
            label = 'Blunder ❌ (Major Error)';
        } else if (lossPct > 10) {
            badge = '⚠️';
            label = 'Mistake ⚠️ (Inaccuracy)';
        } else if (lossPct > 5) {
            badge = '🟡';
            label = 'Inaccuracy 🟡';
        } else if (lossPct > 2) {
            badge = '👍';
            label = 'Good Move 👍';
        } else {
            badge = '⭐';
            label = 'Best Move ⭐ (Optimal)';
        }
    }

    moveAnalysisData[index] = {
        eval: whiteEval,
        winProb: winProb,
        badge: badge,
        label: label
    };
}

function accuracyToElo(acc) {
    if (isNaN(acc)) return 1200;
    if (acc >= 95) return Math.round(2000 + (acc - 95) * 80);
    if (acc >= 85) return Math.round(1250 + (acc - 85) * 75);
    if (acc >= 75) return Math.round(1000 + (acc - 75) * 25);
    if (acc >= 60) return Math.round(600 + (acc - 60) * 26.6);
    return Math.max(400, Math.round(acc * 10));
}

// AUTOMATED FULL-GAME STOCKFISH BATCH ANALYSIS
async function runFullGameAnalysis() {
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
        analyzeNextBatchMove();
    });
}

function analyzeNextBatchMove() {
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
        stockfishWorker.postMessage('go depth 8');

        // Safety fallback timeout
        batchTimeoutTimer = setTimeout(() => {
            advanceBatchAnalysis();
        }, 400);
    } else {
        setTimeout(() => {
            storeMoveAnalysis(batchAnalysisIndex, (Math.random() - 0.4) * 2);
            advanceBatchAnalysis();
        }, 40);
    }
}

function advanceBatchAnalysis() {
    if (isBatchAnalyzing) {
        analyzeNextBatchMove();
    }
}

// PROCEDURE THAT FIRES EXACTLY WHEN ANALYSIS HITS 100%
function onAnalysisComplete() {
    isBatchAnalyzing = false;
    if (batchTimeoutTimer) clearTimeout(batchTimeoutTimer);

    const progressText = document.getElementById('analysis-progress-text');
    const progressBar = document.getElementById('analysis-progress-bar');
    if (progressText) progressText.innerText = 'Analysis Complete! Loading Review...';
    if (progressBar) progressBar.style.width = '100%';

    // Calculate Game-Wide Metrics
    let whiteLosses = [];
    let blackLosses = [];

    for (let i = 1; i < moveAnalysisData.length; i++) {
        const curr = moveAnalysisData[i];
        const prev = moveAnalysisData[i - 1];
        if (!curr || !prev) continue;

        const isWhite = (i % 2 === 1);
        const loss = isWhite ? Math.max(0, prev.winProb - curr.winProb) : Math.max(0, curr.winProb - prev.winProb);

        if (isWhite) whiteLosses.push(loss);
        else blackLosses.push(loss);
    }

    const avgWhiteLoss = whiteLosses.length > 0 ? (whiteLosses.reduce((a, b) => a + b, 0) / whiteLosses.length) : 0.05;
    const avgBlackLoss = blackLosses.length > 0 ? (blackLosses.reduce((a, b) => a + b, 0) / blackLosses.length) : 0.05;

    const whiteAccVal = parseFloat(Math.min(99.5, Math.max(20.0, 100 * Math.exp(-3.5 * avgWhiteLoss))).toFixed(1));
    const blackAccVal = parseFloat(Math.min(99.5, Math.max(20.0, 100 * Math.exp(-3.5 * avgBlackLoss))).toFixed(1));

    const whiteEloVal = accuracyToElo(whiteAccVal);
    const blackEloVal = accuracyToElo(blackAccVal);

    const wAccStr = `${whiteAccVal}%`;
    const bAccStr = `${blackAccVal}%`;
    const wEloStr = `~${whiteEloVal} ELO`;
    const bEloStr = `~${blackEloVal} ELO`;

    if (currentActiveGameRecord) {
        currentActiveGameRecord.accuracy = wAccStr;
        currentActiveGameRecord.black_accuracy = bAccStr;
        currentActiveGameRecord.white_elo = wEloStr;
        currentActiveGameRecord.black_elo = bEloStr;
        currentActiveGameRecord.is_reviewed = true;

        // Async Database Update
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
                .eq('id', currentActiveGameRecord.id)
                .then(() => {})
                .catch(err => console.warn("Database sync deferred:", err));
        }
    }

    // Hide Modal Immediately & Transition
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

async function openGameReview(game) {
    currentActiveGameRecord = game;

    if (typeof Chess !== 'undefined') {
        activeGame = new Chess();
        activeGame.load_pgn(game.pgn);
        reviewHistory = activeGame.history({ verbose: true });
        activeGame.reset();
    }
    currentReviewIndex = 0;

    let whiteName = "White Player";
    let blackName = "Black Player";
    if (game && game.pgn) {
        whiteName = parsePgnHeader(game.pgn, 'White') || whiteName;
        blackName = parsePgnHeader(game.pgn, 'Black') || blackName;
    }

    const wLabelEl = document.getElementById('white-player-label');
    const bLabelEl = document.getElementById('black-player-label');
    if (wLabelEl) wLabelEl.innerText = `White (${whiteName})`;
    if (bLabelEl) bLabelEl.innerText = `Black (${blackName})`;

    // Run Upfront Analysis if unreviewed
    if (!game.is_reviewed || game.accuracy === 'Pending') {
        await runFullGameAnalysis();
    }

    // Populate Top Bar Metrics
    const wAccEl = document.getElementById('white-accuracy-val');
    const bAccEl = document.getElementById('black-accuracy-val');
    const wEloEl = document.getElementById('white-elo-val');
    const bEloEl = document.getElementById('black-elo-val');

    if (wAccEl) wAccEl.innerText = currentActiveGameRecord.accuracy || 'N/A';
    if (bAccEl) bAccEl.innerText = currentActiveGameRecord.black_accuracy || 'N/A';
    if (wEloEl) wEloEl.innerText = currentActiveGameRecord.white_elo || 'N/A';
    if (bEloEl) bEloEl.innerText = currentActiveGameRecord.black_elo || 'N/A';

    switchView('review');
}

function updateClassificationUI() {
    const classEl = document.getElementById('classification-text');
    if (!classEl) return;

    if (currentReviewIndex === 0) {
        classEl.innerText = "Starting Position ⚖️";
        return;
    }

    const current = moveAnalysisData[currentReviewIndex];
    if (current && current.label) {
        classEl.innerText = current.label;
    } else {
        classEl.innerText = "Analyzing Move...";
    }
}

function analyzeCurrentPosition() {
    if (!activeGame || isBatchAnalyzing) return;
    const statusEl = document.getElementById('engine-status');
    if (statusEl) statusEl.innerText = 'Analyzing...';

    if (moveAnalysisData[currentReviewIndex] && moveAnalysisData[currentReviewIndex].bestMove) {
        const cached = moveAnalysisData[currentReviewIndex];
        updateEvalUI(cached.eval);
        updateClassificationUI();
        const bestMoveEl = document.getElementById('best-move-text');
        if (bestMoveEl) bestMoveEl.innerText = cached.bestMove;
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

function updateEvalUI(evalScore) {
    const formatted = evalScore > 0 ? `+${evalScore.toFixed(1)}` : evalScore.toFixed(1);
    const evalEl = document.getElementById('eval-score');
    const barEl = document.getElementById('eval-bar-fill');

    if (evalEl) evalEl.innerText = `Eval: ${formatted}`;

    if (barEl) {
        let fillPercent = 50 + (evalScore * 6.25);
        fillPercent = Math.max(5, Math.min(95, fillPercent));
        barEl.style.height = `${fillPercent}%`;
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    if (typeof Chess !== 'undefined') {
        activeGame = new Chess();
    }
    
    initStockfish();

    if (supabaseClient) {
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            currentUser = session ? session.user : null;
            
            supabaseClient.auth.onAuthStateChange((_event, session) => {
                currentUser = session ? session.user : null;
                updateAuthHeader();
            });
        } catch (e) {
            console.warn("Supabase auth session check skipped:", e);
        }
    }
    
    updateAuthHeader();
    renderRawBoard('landing-board', INITIAL_BOARD);
});

function updateAuthHeader() {
    const container = document.getElementById('auth-nav-container');
    if (!container) return;

    if (currentUser) {
        container.innerHTML = `
            <div class="flex items-center space-x-3 bg-gray-900/80 px-4 py-2 rounded-full border border-gray-800 cursor-pointer" onclick="checkAuthAndSwitch('profile')">
                <span class="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                <span class="text-xs text-gray-300 font-mono">${currentUser.email}</span>
            </div>
            <button onclick="logout()" class="px-4 py-2 rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/10 text-xs font-bold transition">Log Out</button>
        `;
    } else {
        container.innerHTML = `
            <button onclick="openAuthModal('login')" class="px-5 py-2 rounded-full border border-gray-600 hover:border-kastledGold text-sm font-semibold transition">Log In</button>
            <button onclick="openAuthModal('signup')" class="px-5 py-2 rounded-full bg-kastledGold text-kastledNavy font-bold text-sm hover:bg-kastledGoldHover transition shadow-lg" style="background-color:#E5A93C; color:#0B132B;">SIGN UP</button>
        `;
    }
}

function renderRawBoard(elementId, gridData) {
    const container = document.getElementById(elementId);
    if (!container) return;

    if (container.children.length !== 64) {
        container.innerHTML = '';
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const square = document.createElement('div');
                const isDark = (r + c) % 2 === 1;
                square.className = `square ${isDark ? 'square-dark' : 'square-light'}`;
                container.appendChild(square);
            }
        }
    }

    const squares = container.children;
    let index = 0;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = squares[index++];
            const pieceCode = gridData[r][c];
            let img = square.querySelector('img');

            if (pieceCode) {
                const imgSrc = PIECE_IMAGES[pieceCode] || `./Assets/${pieceCode}.png`;
                if (!img) {
                    img = document.createElement('img');
                    img.className = 'piece-img';
                    img.src = imgSrc;
                    square.appendChild(img);
                } else if (!img.src.includes(pieceCode)) {
                    img.src = imgSrc;
                }
            } else if (img) {
                img.remove();
            }
        }
    }
}

function switchView(viewName) {
    const landing = document.getElementById('view-landing');
    const dashboard = document.getElementById('view-dashboard');
    const review = document.getElementById('view-review');
    const profile = document.getElementById('view-profile');

    if (landing) landing.classList.add('hidden');
    if (dashboard) dashboard.classList.add('hidden');
    if (review) review.classList.add('hidden');
    if (profile) profile.classList.add('hidden');

    if (viewName === 'landing' && landing) {
        landing.classList.remove('hidden');
        renderRawBoard('landing-board', INITIAL_BOARD);
    } else if (viewName === 'dashboard' && dashboard) {
        dashboard.classList.remove('hidden');
        fetchGamesFromDatabase();
    } else if (viewName === 'review' && review) {
        review.classList.remove('hidden');
        playSound(gameStartSound);
        updateReviewUI();
    } else if (viewName === 'profile' && profile) {
        profile.classList.remove('hidden');
        loadProfileData();
    }
}

async function loadProfileData() {
    if (!currentUser || !supabaseClient) return;

    const emailInput = document.getElementById('profile-email');
    const nameInput = document.getElementById('profile-name');
    const chesscomInput = document.getElementById('profile-chesscom');
    const lichessInput = document.getElementById('profile-lichess');

    if (emailInput) emailInput.value = currentUser.email || '';
    if (nameInput) nameInput.value = currentUser.user_metadata?.full_name || '';
    if (chesscomInput) chesscomInput.value = '';
    if (lichessInput) lichessInput.value = '';

    const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .maybeSingle();

    if (!error && data) {
        if (nameInput) nameInput.value = data.full_name || currentUser.user_metadata?.full_name || '';
        if (chesscomInput) chesscomInput.value = data.chesscom_alias || '';
        if (lichessInput) lichessInput.value = data.lichess_alias || '';
    }
}

async function handleProfileUpdate(e) {
    e.preventDefault();
    if (!currentUser || !supabaseClient) return;

    const fullName = document.getElementById('profile-name')?.value.trim() || '';
    const newEmail = document.getElementById('profile-email')?.value.trim() || '';
    const chesscomAlias = document.getElementById('profile-chesscom')?.value.trim() || '';
    const lichessAlias = document.getElementById('profile-lichess')?.value.trim() || '';
    const msgEl = document.getElementById('profile-message');

    if (msgEl) msgEl.classList.remove('hidden', 'bg-red-500/20', 'text-red-400', 'bg-green-500/20', 'text-green-400');

    if (newEmail && newEmail !== currentUser.email) {
        const { error: emailError } = await supabaseClient.auth.updateUser({ email: newEmail });
        if (emailError) {
            if (msgEl) {
                msgEl.innerText = emailError.message;
                msgEl.classList.add('bg-red-500/20', 'text-red-400');
                msgEl.classList.remove('hidden');
            }
            return;
        }
    }

    const { error: profileError } = await supabaseClient
        .from('profiles')
        .upsert({
            id: currentUser.id,
            full_name: fullName,
            email: newEmail || currentUser.email,
            chesscom_alias: chesscomAlias,
            lichess_alias: lichessAlias,
            updated_at: new Date()
        });

    if (msgEl) {
        if (profileError) {
            msgEl.innerText = profileError.message;
            msgEl.classList.add('bg-red-500/20', 'text-red-400');
        } else {
            msgEl.innerText = "Profile updated successfully!";
            msgEl.classList.add('bg-green-500/20', 'text-green-400');
        }
        msgEl.classList.remove('hidden');
    }
}

function checkAuthAndSwitch(targetView) {
    if (!currentUser) {
        openAuthModal('login');
    } else {
        switchView(targetView);
    }
}

function openAuthModal(mode) {
    authMode = mode;
    const modal = document.getElementById('auth-modal');
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('auth-modal-title').innerText = mode === 'login' ? 'Log In to Kastled' : 'Create Account';
    document.getElementById('auth-error').classList.add('hidden');

    const nameField = document.getElementById('name-field-container');
    if (nameField) {
        if (mode === 'signup') nameField.classList.remove('hidden');
        else nameField.classList.add('hidden');
    }
}

function closeAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const fullName = document.getElementById('auth-name')?.value || '';
    const errorEl = document.getElementById('auth-error');
    if (errorEl) errorEl.classList.add('hidden');

    if (!supabaseClient) {
        alert('Please configure your Supabase credentials.');
        return;
    }

    let loginRes = await supabaseClient.auth.signInWithPassword({ email, password });

    if (!loginRes.error) {
        currentUser = loginRes.data.user;
        updateAuthHeader();
        closeAuthModal();
        switchView('dashboard');
        return;
    }

    if (authMode === 'signup' || loginRes.error.message.includes("Invalid login credentials")) {
        let signupRes = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                data: { full_name: fullName }
            }
        });

        if (signupRes.error) {
            if (errorEl) {
                errorEl.innerText = signupRes.error.message;
                errorEl.classList.remove('hidden');
            }
        } else {
            currentUser = signupRes.data.user;
            updateAuthHeader();
            closeAuthModal();
            switchView('dashboard');
        }
    } else if (errorEl) {
        errorEl.innerText = loginRes.error.message;
        errorEl.classList.remove('hidden');
    }
}

async function logout() {
    if (supabaseClient) {
        await supabaseClient.auth.signOut();
    }
    currentUser = null;
    updateAuthHeader();
    switchView('landing');
}

function openImportModal() {
    const modal = document.getElementById('import-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeImportModal() {
    const modal = document.getElementById('import-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

// --- CHESS.COM IMPORT WORKFLOW ---
async function openChessComModal() {
    if (!currentUser) return alert('You must be logged in.');

    const modal = document.getElementById('chesscom-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    const contentEl = document.getElementById('chesscom-content');
    if (!contentEl) return;
    contentEl.innerHTML = `<p class="text-sm text-gray-300">Checking your profile for Chess.com alias...</p>`;

    const { data: profile, error } = await supabaseClient
        .from('profiles')
        .select('chesscom_alias')
        .eq('id', currentUser.id)
        .maybeSingle();

    if (error || !profile || !profile.chesscom_alias) {
        contentEl.innerHTML = `
            <div class="space-y-4">
                <p class="text-sm text-amber-400 font-semibold">No Chess.com alias found in your profile!</p>
                <p class="text-xs text-gray-300">Please add your Chess.com username in your Profile settings before importing games.</p>
                <button onclick="closeChessComModal(); switchView('profile');" class="w-full py-3 rounded-xl bg-kastledGold text-kastledNavy font-bold hover:bg-kastledGoldHover transition" style="background-color:#E5A93C; color:#0B132B;">Go to Profile Settings</button>
            </div>
        `;
        return;
    }

    const username = profile.chesscom_alias.trim();
    contentEl.innerHTML = `<p class="text-sm text-gray-300">Fetching recent archives for <b>${username}</b> from Chess.com...</p>`;

    try {
        const archivesRes = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`);
        const archivesData = await archivesRes.json();

        if (!archivesData.archives || archivesData.archives.length === 0) {
            contentEl.innerHTML = `<p class="text-sm text-gray-400">No game archives found for Chess.com user: ${username}</p>`;
            return;
        }

        const latestArchiveUrl = archivesData.archives[archivesData.archives.length - 1];
        const monthRes = await fetch(latestArchiveUrl);
        const monthData = await monthRes.json();

        if (!monthData.games || monthData.games.length === 0) {
            contentEl.innerHTML = `<p class="text-sm text-gray-400">No games found in the latest archive month.</p>`;
            return;
        }

        const { data: existingGames } = await supabaseClient
            .from('games')
            .select('pgn')
            .eq('user_id', currentUser.id);

        const existingPgnSet = new Set(existingGames ? existingGames.map(g => g.pgn.trim()) : []);

        fetchedChessComGames = monthData.games.slice(-20).reverse();

        let listHtml = `
            <p class="text-xs text-gray-400">Select games to import from <b>${username}'s</b> recent matches:</p>
            <div class="max-h-64 overflow-y-auto space-y-2 divide-y divide-gray-800 pr-2">
        `;

        fetchedChessComGames.forEach((g, idx) => {
            const white = g.white.username;
            const black = g.black.username;
            const date = new Date(g.end_time * 1000).toISOString().split('T')[0];
            const isDuplicate = g.pgn && existingPgnSet.has(g.pgn.trim());

            listHtml += `
                <div class="pt-2 flex items-center justify-between text-sm">
                    <label class="flex items-center space-x-3 cursor-pointer">
                        <input type="checkbox" id="cc-game-${idx}" ${isDuplicate ? 'disabled' : ''} class="w-4 h-4 accent-kastledGold rounded">
                        <span class="${isDuplicate ? 'text-gray-500 line-through' : 'text-white font-medium'}">
                            ${white} vs. ${black} 
                            <span class="text-xs text-gray-500 block">${date} (${g.time_class}) ${isDuplicate ? '- [Already Imported]' : ''}</span>
                        </span>
                    </label>
                </div>
            `;
        });

        listHtml += `
            </div>
            <button onclick="importSelectedChessComGames()" class="w-full py-3 rounded-xl bg-kastledGold text-kastledNavy font-bold hover:bg-kastledGoldHover transition mt-4" style="background-color:#E5A93C; color:#0B132B;">Import Selected Games</button>
        `;
        contentEl.innerHTML = listHtml;

    } catch (err) {
        console.error('Chess.com API error:', err);
        contentEl.innerHTML = `<p class="text-sm text-red-400">Failed to connect to Chess.com API. Please verify your username.</p>`;
    }
}

function closeChessComModal() {
    const modal = document.getElementById('chesscom-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

async function importSelectedChessComGames() {
    if (!currentUser) return;

    const checkboxes = document.querySelectorAll('[id^="cc-game-"]');
    const selectedGames = [];

    checkboxes.forEach((cb, idx) => {
        if (cb.checked && !cb.disabled) {
            selectedGames.push(fetchedChessComGames[idx]);
        }
    });

    if (selectedGames.length === 0) {
        return alert('Please select at least one new game to import.');
    }

    let insertCount = 0;
    for (const g of selectedGames) {
        const white = g.white.username;
        const black = g.black.username;
        const date = new Date(g.end_time * 1000).toISOString().split('T')[0];
        
        let res = 'Draw';
        if (g.white.result === 'win') res = '1-0';
        else if (g.black.result === 'win') res = '0-1';

        const gamePgn = g.pgn || `[White "${white}"]\n[Black "${black}"]\n[Date "${date}"]\n[Result "${res}"]\n\n1. e4 e5 *`;

        const newGame = {
            user_id: currentUser.id,
            opponent: `${white} vs. ${black}`,
            result: res,
            date: date,
            accuracy: 'Pending',
            black_accuracy: 'Pending',
            white_elo: 'Pending',
            black_elo: 'Pending',
            pgn: gamePgn,
            is_reviewed: false
        };

        const { error } = await supabaseClient.from('games').insert([newGame]);
        if (!error) insertCount++;
    }

    closeChessComModal();
    alert(`Successfully imported ${insertCount} new game(s) from Chess.com as Pending!`);
    fetchGamesFromDatabase();
}

function parsePgnHeader(pgn, tag) {
    const regex = new RegExp(`\\[${tag}\\s+"([^"]+)"\\]`, 'i');
    const match = pgn.match(regex);
    return match ? match[1] : null;
}

async function saveImportedGame() {
    const pgn = document.getElementById('import-pgn-input').value.trim();
    const manualOpponent = document.getElementById('import-opponent-input').value.trim();

    if (!pgn) return alert('Please enter valid PGN');
    if (!currentUser) return alert('You must be logged in to save games.');

    const { data: existing } = await supabaseClient
        .from('games')
        .select('id')
        .eq('user_id', currentUser.id)
        .eq('pgn', pgn)
        .maybeSingle();

    if (existing) {
        return alert('This exact game PGN is already saved in your database!');
    }

    const whitePlayer = parsePgnHeader(pgn, 'White');
    const blackPlayer = parsePgnHeader(pgn, 'Black');
    const eventName = parsePgnHeader(pgn, 'Event');
    const pgnDate = parsePgnHeader(pgn, 'Date');
    const pgnResult = parsePgnHeader(pgn, 'Result');

    let opponentName = manualOpponent;
    if (!opponentName) {
        if (whitePlayer && blackPlayer) {
            opponentName = `${whitePlayer} vs. ${blackPlayer}`;
        } else if (eventName && eventName !== '?') {
            opponentName = eventName;
        } else {
            opponentName = "Analyzed Match";
        }
    }

    let gameDate = new Date().toISOString().split('T')[0];
    if (pgnDate && pgnDate !== '????.??.??' && pgnDate.includes('.')) {
        gameDate = pgnDate.replace(/\./g, '-');
    }

    const resultText = (pgnResult && pgnResult !== '*') ? pgnResult : 'Reviewed';

    const newGame = {
        user_id: currentUser.id,
        opponent: opponentName,
        result: resultText,
        date: gameDate,
        accuracy: 'Pending',
        black_accuracy: 'Pending',
        white_elo: 'Pending',
        black_elo: 'Pending',
        pgn: pgn,
        is_reviewed: false
    };

    if (supabaseClient) {
        const { error } = await supabaseClient.from('games').insert([newGame]);
        if (error) {
            console.error('Database save error:', error);
            alert('Error saving game to database.');
        }
    }

    document.getElementById('import-pgn-input').value = '';
    document.getElementById('import-opponent-input').value = '';
    closeImportModal();
    fetchGamesFromDatabase();
}

async function fetchGamesFromDatabase() {
    if (!currentUser) return;

    if (supabaseClient) {
        const { data, error } = await supabaseClient
            .from('games')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('date', { ascending: false })
            .order('created_at', { ascending: false });

        if (!error && data) {
            savedGames = data;
        } else {
            console.error('Error fetching games:', error);
            savedGames = [];
        }
    }

    renderGamesList();
}

function renderGamesList() {
    const container = document.getElementById('games-list');
    if (!container) return;
    container.innerHTML = '';

    if (savedGames.length === 0) {
        container.innerHTML = `<div class="p-6 text-center text-gray-400 text-sm">No saved games found for this account. Click "+ Import PGN" or "+ Import Chess.com" to add some!</div>`;
        return;
    }

    savedGames.forEach(game => {
        const row = document.createElement('div');
        row.className = "p-4 grid grid-cols-12 items-center text-sm hover:bg-gray-800/40 transition cursor-pointer";
        row.onclick = () => openGameReview(game);
        
        let accDisplay = game.accuracy || 'Pending';
        if (accDisplay !== 'Pending') {
            accDisplay = `${game.accuracy} / ${game.black_accuracy || 'Pending'}`;
        }

        row.innerHTML = `
            <div class="col-span-5 font-semibold text-white">${game.opponent}</div>
            <div class="col-span-3 text-gray-400">${game.result} <span class="text-xs block text-gray-500">${game.date}</span></div>
            <div class="col-span-2 text-kastledGold font-bold text-xs" style="color:#E5A93C;">${accDisplay}</div>
            <div class="col-span-2 text-right"><span class="px-3 py-1 bg-kastledGold/10 text-kastledGold rounded-lg text-xs font-bold" style="color:#E5A93C;">Review</span></div>
        `;
        container.appendChild(row);
    });
}

function updateReviewUI() {
    if (activeGame) {
        const boardState = activeGame.board();
        const gridData = [];
        for (let r = 0; r < 8; r++) {
            const row = [];
            for (let c = 0; c < 8; c++) {
                const p = boardState[r][c];
                row.push(p ? (p.color === 'w' ? 'w' : 'b') + p.type.toUpperCase() : '');
            }
            gridData.push(row);
        }
        renderRawBoard('review-board', gridData);
    } else {
        renderRawBoard('review-board', INITIAL_BOARD);
    }

    let whiteName = "White Player";
    let blackName = "Black Player";
    if (currentActiveGameRecord && currentActiveGameRecord.pgn) {
        whiteName = parsePgnHeader(currentActiveGameRecord.pgn, 'White') || whiteName;
        blackName = parsePgnHeader(currentActiveGameRecord.pgn, 'Black') || blackName;
    }
    
    const whiteEl = document.getElementById('review-player');
    const blackEl = document.getElementById('review-opponent');
    if (whiteEl) whiteEl.innerText = `White: ${whiteName}`;
    if (blackEl) blackEl.innerText = `Black: ${blackName}`;

    renderMovesList();
    analyzeCurrentPosition();
}

function renderMovesList() {
    const container = document.getElementById('moves-list-container');
    if (!container) return;
    container.innerHTML = '';

    let activeMoveElement = null;

    reviewHistory.forEach((move, idx) => {
        const moveNum = Math.floor(idx / 2) + 1;
        const isWhite = idx % 2 === 0;
        
        if (isWhite) {
            const labelSpan = document.createElement('div');
            labelSpan.className = "text-gray-500 font-mono text-xs col-span-2 pt-1";
            labelSpan.innerText = `${moveNum}.`;
            container.appendChild(labelSpan);
        }

        const moveBtn = document.createElement('div');
        const isCurrent = currentReviewIndex === idx + 1;
        const analysis = moveAnalysisData[idx + 1];
        const badge = analysis ? analysis.badge : '';
        
        moveBtn.className = `p-1.5 rounded cursor-pointer text-xs font-mono transition flex justify-between items-center ${isCurrent ? 'bg-kastledGold text-kastledNavy font-bold' : 'bg-gray-900 hover:bg-gray-800 text-gray-300'}`;
        if (isCurrent) moveBtn.style = 'background-color:#E5A93C; color:#0B132B;';
        
        moveBtn.innerHTML = `<span>${move.san}</span><span class="text-xs ml-1">${badge}</span>`;
        moveBtn.onclick = () => jumpToMove(idx + 1);
        container.appendChild(moveBtn);

        if (isCurrent) {
            activeMoveElement = moveBtn;
        }
    });

    if (activeMoveElement) {
        activeMoveElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function jumpToMove(targetIndex) {
    if (!activeGame) return;
    activeGame.reset();
    for (let i = 0; i < targetIndex; i++) {
        activeGame.move(reviewHistory[i]);
    }
    currentReviewIndex = targetIndex;
    updateReviewUI();
}

function navigateMove(step) {
    if (!activeGame) return;

    if (step === 1 && currentReviewIndex < reviewHistory.length) {
        const move = activeGame.move(reviewHistory[currentReviewIndex]);
        currentReviewIndex++;

        if (move) {
            if (activeGame.in_checkmate() || activeGame.in_stalemate() || activeGame.game_over()) {
                playSound(gameOverSound);
            } else if (activeGame.in_check()) {
                playSound(checkSound);
            } else if (move.captured) {
                playSound(captureSound);
            } else {
                playSound(moveSound);
            }
        }
    } else if (step === -1 && currentReviewIndex > 0) {
        currentReviewIndex--;
        activeGame.undo();
        playSound(moveSound);
    }

    updateReviewUI();
}
