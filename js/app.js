import { supabaseClient } from './config.js';
import { initStockfish, runFullGameAnalysis, analyzeCurrentPosition, getMoveAnalysisData, setCurrentActiveGameRecord, getClassificationMeta } from './engine.js';
import { checkAuthSession, loadProfileData, handleProfileUpdate, fetchGamesFromDatabase } from './supabase-service.js';
import { renderRawBoard, updateAuthHeader, updateEvalUI, parsePgnHeader } from './ui.js';

let currentUser = null;
let authMode = 'login';
let savedGames = [];
let fetchedChessComGames = [];

let activeGame = null;
let reviewHistory = [];
let currentReviewIndex = 0;
let currentActiveGameRecord = null;

window.switchView = function(viewName) {
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
        renderRawBoard('landing-board', [
            ['bR','bN','bB','bQ','bK','bB','bN','bR'],['bP','bP','bP','bP','bP','bP','bP','bP'],
            ['','','','','','','',''],['','','','','','','',''],['','','','','','','',''],['','','','','','','',''],
            ['wP','wP','wP','wP','wP','wP','wP','wP'],['wR','wN','wB','wQ','wK','wB','wN','wR']
        ]);
    } else if (viewName === 'dashboard' && dashboard) {
        dashboard.classList.remove('hidden');
        fetchGamesFromDatabase(currentUser, (data) => {
            savedGames = data;
            renderGamesList();
        });
    } else if (viewName === 'review' && review) {
        review.classList.remove('hidden');
        updateReviewUI();
    } else if (viewName === 'profile' && profile) {
        profile.classList.remove('hidden');
        loadProfileData(currentUser);
    }
};

window.checkAuthAndSwitch = function(targetView) {
    if (!currentUser) {
        window.openAuthModal('login');
    } else {
        window.switchView(targetView);
    }
};

window.openAuthModal = function(mode) {
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
};

window.closeAuthModal = function() {
    const modal = document.getElementById('auth-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

// --- FIXED AUTH SUBMIT HANDLER ---
window.handleAuthSubmit = async function(event) {
    event.preventDefault();
    
    const emailInput = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');
    const nameInput = document.getElementById('auth-name');
    const errorEl = document.getElementById('auth-error');
    
    if (errorEl) errorEl.classList.add('hidden');

    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const fullName = nameInput ? nameInput.value.trim() : '';

    if (!email || !password) return;

    if (authMode === 'login') {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            if (errorEl) {
                errorEl.innerText = error.message;
                errorEl.classList.remove('hidden');
            }
            return;
        }

        currentUser = data.user;
        updateAuthHeader(currentUser);
        window.closeAuthModal();
        window.switchView('dashboard');

    } else {
        const { data, error } = await supabaseClient.auth.signUp({
            email: email,
            password: password,
            options: {
                data: { full_name: fullName }
            }
        });

        if (error) {
            if (errorEl) {
                errorEl.innerText = error.message;
                errorEl.classList.remove('hidden');
            }
            return;
        }

        currentUser = data.user ? data.user : (data.session ? data.session.user : null);
        updateAuthHeader(currentUser);
        window.closeAuthModal();
        window.switchView('dashboard');
    }
};

window.logout = async function() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    currentUser = null;
    updateAuthHeader(currentUser);
    window.switchView('landing');
};

window.openImportModal = function() {
    const modal = document.getElementById('import-modal');
    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
};

window.closeImportModal = function() {
    const modal = document.getElementById('import-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
};

// --- RESTORED CHESS.COM IMPORT WORKFLOW ---
window.openChessComModal = async function() {
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
                <button onclick="window.closeChessComModal(); window.switchView('profile');" class="w-full py-3 rounded-xl bg-kastledGold text-kastledNavy font-bold hover:bg-kastledGoldHover transition" style="background-color:#E5A93C; color:#0B132B;">Go to Profile Settings</button>
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

        fetchedChessComGames = monthData.games.sort((a, b) => b.end_time - a.end_time).slice(0, 20);

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
            <button onclick="window.importSelectedChessComGames()" class="w-full py-3 rounded-xl bg-kastledGold text-kastledNavy font-bold hover:bg-kastledGoldHover transition mt-4" style="background-color:#E5A93C; color:#0B132B;">Import Selected Games</button>
        `;
        contentEl.innerHTML = listHtml;

    } catch (err) {
        console.error('Chess.com API error:', err);
        contentEl.innerHTML = `<p class="text-sm text-red-400">Failed to connect to Chess.com API. Please verify your username.</p>`;
    }
};

window.closeChessComModal = function() {
    const modal = document.getElementById('chesscom-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

window.importSelectedChessComGames = async function() {
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

    window.closeChessComModal();
    alert(`Successfully imported ${insertCount} new game(s) from Chess.com as Pending!`);
    fetchGamesFromDatabase(currentUser, (data) => {
        savedGames = data;
        renderGamesList();
    });
};

window.saveImportedGame = async function() {
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
    window.closeImportModal();
    fetchGamesFromDatabase(currentUser, (data) => {
        savedGames = data;
        renderGamesList();
    });
};

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

async function openGameReview(game) {
    currentActiveGameRecord = game;
    setCurrentActiveGameRecord(game);

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

    // If game has stored analysis JSONB, load it directly; otherwise run analysis
    if (game.analysis_data && Array.isArray(game.analysis_data)) {
        import('./engine.js').then(engine => {
            engine.setMoveAnalysisData(game.analysis_data);
        });
    } else if (!game.is_reviewed || game.accuracy === 'Pending') {
        await runFullGameAnalysis(activeGame, reviewHistory);
    }

    const wAccEl = document.getElementById('white-accuracy-val');
    const bAccEl = document.getElementById('black-accuracy-val');
    const wEloEl = document.getElementById('white-elo-val');
    const bEloEl = document.getElementById('black-elo-val');

    if (wAccEl) wAccEl.innerText = currentActiveGameRecord.accuracy || 'N/A';
    if (bAccEl) bAccEl.innerText = currentActiveGameRecord.black_accuracy || 'N/A';
    if (wEloEl) wEloEl.innerText = currentActiveGameRecord.white_elo || 'N/A';
    if (bEloEl) bEloEl.innerText = currentActiveGameRecord.black_elo || 'N/A';

    window.switchView('review');
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
    analyzeCurrentPosition(activeGame, currentReviewIndex);
}

function renderMovesList() {
    const container = document.getElementById('moves-list-container');
    if (!container) return;
    container.innerHTML = '';
    const moveAnalysisData = getMoveAnalysisData();

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
        
        // Map 1-10 category code to correct badge using getClassificationMeta
        let badgeSymbol = '';
        if (analysis && analysis.cat) {
            const meta = getClassificationMeta(analysis.cat);
            badgeSymbol = meta.badge;
        }
        
        moveBtn.className = `p-1.5 rounded cursor-pointer text-xs font-mono transition flex justify-between items-center ${isCurrent ? 'bg-kastledGold text-kastledNavy font-bold' : 'bg-gray-900 hover:bg-gray-800 text-gray-300'}`;
        if (isCurrent) moveBtn.style = 'background-color:#E5A93C; color:#0B132B;';
        
        moveBtn.innerHTML = `<span>${move.san}</span><span class="text-xs ml-1">${badgeSymbol}</span>`;
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

window.navigateMove = function(step) {
    if (!activeGame) return;

    if (step === 1 && currentReviewIndex < reviewHistory.length) {
        activeGame.move(reviewHistory[currentReviewIndex]);
        currentReviewIndex++;
    } else if (step === -1 && currentReviewIndex > 0) {
        currentReviewIndex--;
        activeGame.undo();
    }

    updateReviewUI();
};

window.addEventListener('DOMContentLoaded', async () => {
    if (typeof Chess !== 'undefined') {
        activeGame = new Chess();
    }
    
    initStockfish(() => activeGame, () => currentReviewIndex, updateEvalUI);

    currentUser = await checkAuthSession();
    if (supabaseClient) {
        supabaseClient.auth.onAuthStateChange((_event, session) => {
            currentUser = session ? session.user : null;
            updateAuthHeader(currentUser);
        });
    }
    
    updateAuthHeader(currentUser);
    window.switchView('landing');
});
