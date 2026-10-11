// KASTLEDDATA SUPABASE CREDENTIALS
const SUPABASE_URL = "https://sgpafvuexdmnbdbvveny.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_blGh-rrLxaxf5K14TEAzVw_NuXYM1d5";

const supabaseClient = (SUPABASE_URL !== "YOUR_SUPABASE_URL_HERE" && SUPABASE_URL !== "") 
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) 
    : null;

const PIECE_IMAGES = {
    'wP': 'Assets/wP.png',
    'wN': 'Assets/wN.png',
    'wB': 'Assets/wB.png',
    'wR': 'Assets/wR.png',
    'wQ': 'Assets/wQ.png',
    'wK': 'Assets/wK.png',
    'bP': 'Assets/bP.png',
    'bN': 'Assets/bN.png',
    'bB': 'Assets/bB.png',
    'bR': 'Assets/bR.png',
    'bQ': 'Assets/bQ.png',
    'bK': 'Assets/bK.png'
};

// --- AUDIO SOUND EFFECTS ---
const gameStartSound = new Audio('Assets/game-start.wav');
const moveSound = new Audio('Assets/move.wav');
const captureSound = new Audio('Assets/capture.wav');
const checkSound = new Audio('Assets/check.wav');
const gameOverSound = new Audio('Assets/game-over.wav');

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

let activeGame = typeof Chess !== 'undefined' ? new Chess() : null;
let reviewHistory = [];
let currentReviewIndex = 0;

// --- STOCKFISH BLOB WORKER ENGINE SETUP ---
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
                        if (activeGame && activeGame.turn() === 'b') cp = -cp;
                        updateEvalUI(cp / 100);
                    }
                } else if (line.includes('score mate')) {
                    const match = line.match(/score mate (-?\d+)/);
                    if (match) {
                        const mateIn = parseInt(match[1]);
                        const formatted = mateIn > 0 ? `#M${mateIn}` : `#M${Math.abs(mateIn)}`;
                        document.getElementById('eval-score').innerText = `Eval: ${formatted}`;
                        document.getElementById('classification-text').innerText = mateIn > 0 ? "White Forced Mate 🏆" : "Black Forced Mate ⚠️";
                        document.getElementById('eval-bar-fill').style.height = mateIn > 0 ? '100%' : '0%';
                    }
                }

                if (line.includes('bestmove')) {
                    const match = line.match(/bestmove\s+(\w+)/);
                    if (match && match[1]) {
                        document.getElementById('best-move-text').innerText = match[1];
                        document.getElementById('engine-status').innerText = 'Analysis Complete';
                    }
                }
            };

            stockfishWorker.postMessage('uci');
            stockfishWorker.postMessage('isready');
        })
        .catch(err => console.warn("Stockfish Blob initialization fallback active:", err));
}

function analyzeCurrentPosition() {
    if (!activeGame) return;

    document.getElementById('engine-status').innerText = 'Analyzing...';

    if (stockfishWorker) {
        const fen = activeGame.fen();
        stockfishWorker.postMessage('stop');
        stockfishWorker.postMessage(`position fen ${fen}`);
        stockfishWorker.postMessage('go depth 12');
    } else {
        calculateMaterialEval();
    }
}

function calculateMaterialEval() {
    if (!activeGame) return;
    const pieceValues = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    let score = 0;
    const board = activeGame.board();

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = board[r][c];
            if (piece) {
                const val = pieceValues[piece.type] || 0;
                score += (piece.color === 'w') ? val : -val;
            }
        }
    }

    updateEvalUI(score);
    document.getElementById('best-move-text').innerText = "Calculating...";
    document.getElementById('engine-status').innerText = 'Material Eval';
}

function updateEvalUI(evalScore) {
    const formatted = evalScore > 0 ? `+${evalScore.toFixed(1)}` : evalScore.toFixed(1);
    document.getElementById('eval-score').innerText = `Eval: ${formatted}`;

    if (evalScore > 1.5) {
        document.getElementById('classification-text').innerText = "White Advantage 📈";
    } else if (evalScore < -1.5) {
        document.getElementById('classification-text').innerText = "Black Advantage 📉";
    } else {
        document.getElementById('classification-text').innerText = "Equal Position ⚖️";
    }

    let fillPercent = 50 + (evalScore * 6.25);
    fillPercent = Math.max(5, Math.min(95, fillPercent));
    document.getElementById('eval-bar-fill').style.height = `${fillPercent}%`;
}

window.addEventListener('DOMContentLoaded', async () => {
    initStockfish();

    if (supabaseClient) {
        const { data: { session } } = await supabaseClient.auth.getSession();
        currentUser = session ? session.user : null;
        
        supabaseClient.auth.onAuthStateChange((_event, session) => {
            currentUser = session ? session.user : null;
            updateAuthHeader();
        });
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
    container.innerHTML = '';

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const square = document.createElement('div');
            const isDark = (r + c) % 2 === 1;
            square.className = `square ${isDark ? 'square-dark' : 'square-light'}`;

            const pieceCode = gridData[r][c];
            if (pieceCode) {
                const img = document.createElement('img');
                img.className = 'piece-img';
                img.src = PIECE_IMAGES[pieceCode] || '';
                square.appendChild(img);
            }
            container.appendChild(square);
        }
    }
}

function switchView(viewName) {
    document.getElementById('view-landing').classList.add('hidden');
    document.getElementById('view-dashboard').classList.add('hidden');
    document.getElementById('view-review').classList.add('hidden');
    document.getElementById('view-profile').classList.add('hidden');

    if(viewName === 'landing') {
        document.getElementById('view-landing').classList.remove('hidden');
        renderRawBoard('landing-board', INITIAL_BOARD);
    } else if(viewName === 'dashboard') {
        document.getElementById('view-dashboard').classList.remove('hidden');
        fetchGamesFromDatabase();
    } else if(viewName === 'review') {
        document.getElementById('view-review').classList.remove('hidden');
        gameStartSound.currentTime = 0;
        gameStartSound.play().catch(() => {});
        updateReviewUI();
    } else if(viewName === 'profile') {
        document.getElementById('view-profile').classList.remove('hidden');
        loadProfileData();
    }
}

async function loadProfileData() {
    if (!currentUser || !supabaseClient) return;

    document.getElementById('profile-email').value = currentUser.email || '';

    const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .single();

    if (!error && data) {
        document.getElementById('profile-name').value = data.full_name || '';
        document.getElementById('profile-chesscom').value = data.chesscom_alias || '';
        document.getElementById('profile-lichess').value = data.lichess_alias || '';
    }
}

async function handleProfileUpdate(e) {
    e.preventDefault();
    if (!currentUser || !supabaseClient) return;

    const fullName = document.getElementById('profile-name').value.trim();
    const newEmail = document.getElementById('profile-email').value.trim();
    const chesscomAlias = document.getElementById('profile-chesscom').value.trim();
    const lichessAlias = document.getElementById('profile-lichess').value.trim();
    const msgEl = document.getElementById('profile-message');

    msgEl.classList.remove('hidden', 'bg-red-500/20', 'text-red-400', 'bg-green-500/20', 'text-green-400');

    if (newEmail && newEmail !== currentUser.email) {
        const { error: emailError } = await supabaseClient.auth.updateUser({ email: newEmail });
        if (emailError) {
            msgEl.innerText = emailError.message;
            msgEl.classList.add('bg-red-500/20', 'text-red-400');
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

    if (profileError) {
        msgEl.innerText = profileError.message;
        msgEl.classList.add('bg-red-500/20', 'text-red-400');
    } else {
        msgEl.innerText = "Profile updated successfully!";
        msgEl.classList.add('bg-green-500/20', 'text-green-400');
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
    document.getElementById('auth-modal').classList.remove('hidden');
    document.getElementById('auth-modal').classList.add('flex');
    document.getElementById('auth-modal-title').innerText = mode === 'login' ? 'Log In to Kastled' : 'Create Account';
    document.getElementById('auth-error').classList.add('hidden');

    const nameField = document.getElementById('name-field-container');
    if (mode === 'signup') {
        nameField.classList.remove('hidden');
    } else {
        nameField.classList.add('hidden');
    }
}

function closeAuthModal() {
    document.getElementById('auth-modal').classList.add('hidden');
    document.getElementById('auth-modal').classList.remove('flex');
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const fullName = document.getElementById('auth-name').value;
    const errorEl = document.getElementById('auth-error');
    errorEl.classList.add('hidden');

    if (!supabaseClient) {
        alert('Please configure your Supabase URL and Key in the script header.');
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
            errorEl.innerText = signupRes.error.message;
            errorEl.classList.remove('hidden');
        } else {
            currentUser = signupRes.data.user;
            updateAuthHeader();
            closeAuthModal();
            switchView('dashboard');
        }
    } else {
        errorEl.innerText = loginRes.error.message;
        errorEl.classList.add('hidden');
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
    document.getElementById('import-modal').classList.remove('hidden');
    document.getElementById('import-modal').classList.add('flex');
}

function closeImportModal() {
    document.getElementById('import-modal').classList.add('hidden');
    document.getElementById('import-modal').classList.remove('flex');
}

// --- CHESS.COM IMPORT WORKFLOW WITH DUPLICATE PREVENTION ---
async function openChessComModal() {
    if (!currentUser) return alert('You must be logged in.');

    document.getElementById('chesscom-modal').classList.remove('hidden');
    document.getElementById('chesscom-modal').classList.add('flex');
    const contentEl = document.getElementById('chesscom-content');
    contentEl.innerHTML = `<p class="text-sm text-gray-300">Checking your profile for Chess.com alias...</p>`;

    const { data: profile, error } = await supabaseClient
        .from('profiles')
        .select('chesscom_alias')
        .eq('id', currentUser.id)
        .single();

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

        // Fetch user's existing games from database to check for duplicates
        const { data: existingGames } = await supabaseClient
            .from('games')
            .select('pgn')
            .eq('user_id', currentUser.id);

        const existingPgnSet = new Set(existingGames ? existingGames.map(g => g.pgn.trim()) : []);

        fetchedChessComGames = monthData.games.slice(-20).reverse();

        let listHtml = `
            <p class="text-xs text-gray-400">Select games to import from <b>${username}'s</b> recent matches (duplicates are marked):</p>
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
    document.getElementById('chesscom-modal').classList.add('hidden');
    document.getElementById('chesscom-modal').classList.remove('flex');
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
            pgn: gamePgn
        };

        const { error } = await supabaseClient.from('games').insert([newGame]);
        if (!error) insertCount++;
    }

    closeChessComModal();
    alert(`Successfully imported ${insertCount} new game(s) from Chess.com!`);
    fetchGamesFromDatabase();
}

// Helper to extract PGN Header Tags
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

    // Check if this exact PGN is already saved for this user
    const { data: existing } = await supabaseClient
        .from('games')
        .select('id')
        .eq('user_id', currentUser.id)
        .eq('pgn', pgn)
        .single();

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
    const accuracyValue = 'Pending';

    const newGame = {
        user_id: currentUser.id,
        opponent: opponentName,
        result: resultText,
        date: gameDate,
        accuracy: accuracyValue,
        pgn: pgn
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
    container.innerHTML = '';

    if (savedGames.length === 0) {
        container.innerHTML = `<div class="p-6 text-center text-gray-400 text-sm">No saved games found for this account. Click "+ Import PGN" or "+ Import Chess.com" to add some!</div>`;
        return;
    }

    savedGames.forEach(game => {
        const row = document.createElement('div');
        row.className = "p-4 grid grid-cols-12 items-center text-sm hover:bg-gray-800/40 transition cursor-pointer";
        row.onclick = () => openGameReview(game);
        row.innerHTML = `
            <div class="col-span-5 font-semibold text-white">${game.opponent}</div>
            <div class="col-span-3 text-gray-400">${game.result} <span class="text-xs block text-gray-500">${game.date}</span></div>
            <div class="col-span-2 text-kastledGold font-bold" style="color:#E5A93C;">${game.accuracy}</div>
            <div class="col-span-2 text-right"><span class="px-3 py-1 bg-kastledGold/10 text-kastledGold rounded-lg text-xs font-bold" style="color:#E5A93C;">Review</span></div>
        `;
        container.appendChild(row);
    });
}

function openGameReview(game) {
    if (typeof Chess !== 'undefined') {
        activeGame = new Chess();
        activeGame.load_pgn(game.pgn);
        reviewHistory = activeGame.history({ verbose: true });
        activeGame.reset();
    }
    currentReviewIndex = 0;
    switchView('review');
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
    
    analyzeCurrentPosition();
}

function navigateMove(step) {
    if (!activeGame) return;

    if (step === 1 && currentReviewIndex < reviewHistory.length) {
        const move = activeGame.move(reviewHistory[currentReviewIndex]);
        currentReviewIndex++;

        if (move) {
            if (activeGame.in_checkmate() || activeGame.in_stalemate() || activeGame.game_over()) {
                gameOverSound.currentTime = 0;
                gameOverSound.play().catch(() => {});
            } else if (activeGame.in_check()) {
                checkSound.currentTime = 0;
                checkSound.play().catch(() => {});
            } else if (move.captured) {
                captureSound.currentTime = 0;
                captureSound.play().catch(() => {});
            } else {
                moveSound.currentTime = 0;
                moveSound.play().catch(() => {});
            }
        }
    } else if (step === -1 && currentReviewIndex > 0) {
        currentReviewIndex--;
        activeGame.undo();

        moveSound.currentTime = 0;
        moveSound.play().catch(() => {});
    }

    updateReviewUI();
}
