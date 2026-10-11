import { supabaseClient } from './config.js';
import { initStockfish, runFullGameAnalysis, analyzeCurrentPosition, getMoveAnalysisData, setCurrentActiveGameRecord } from './engine.js';
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

window.openChessComModal = async function() {
    if (!currentUser) return alert('You must be logged in.');
    const modal = document.getElementById('chesscom-modal');
    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }

    const contentEl = document.getElementById('chesscom-content');
    if (!contentEl) return;
    contentEl.innerHTML = `<p class="text-sm text-gray-300">Checking your profile for Chess.com alias...</p>`;

    const { data: profile } = await supabaseClient
        .from('profiles').select('chesscom_alias').eq('id', currentUser.id).maybeSingle();

    if (!profile || !profile.chesscom_alias) {
        contentEl.innerHTML = `<p class="text-sm text-amber-400 font-semibold">No Chess.com alias found in your profile!</p>`;
        return;
    }

    const username = profile.chesscom_alias.trim();
    try {
        const archivesRes = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`);
        const archivesData = await archivesRes.json();
        const latestArchiveUrl = archivesData.archives[archivesData.archives.length - 1];
        const monthRes = await fetch(latestArchiveUrl);
        const monthData = await monthRes.json();

        fetchedChessComGames = monthData.games.slice(-20).reverse();
        let listHtml = `<div class="max-h-64 overflow-y-auto space-y-2">`;
        fetchedChessComGames.forEach((g, idx) => {
            listHtml += `<label class="flex items-center space-x-3 cursor-pointer"><input type="checkbox" id="cc-game-${idx}" class="w-4 h-4"><span>${g.white.username} vs ${g.black.username}</span></label>`;
        });
        listHtml += `</div><button onclick="window.importSelectedChessComGames()" class="w-full mt-4 py-2 bg-kastledGold text-kastledNavy font-bold rounded">Import Selected</button>`;
        contentEl.innerHTML = listHtml;
    } catch (err) {
        contentEl.innerHTML = `<p class="text-sm text-red-400">Failed to connect to Chess.com API.</p>`;
    }
};

window.closeChessComModal = function() {
    const modal = document.getElementById('chesscom-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
};

window.importSelectedChessComGames = async function() {
    // Handled in modular workflow
    window.closeChessComModal();
};

window.saveImportedGame = async function() {
    const pgn = document.getElementById('import-pgn-input').value.trim();
    if (!pgn) return alert('Please enter valid PGN');
    if (!currentUser) return alert('You must be logged in.');

    const newGame = {
        user_id: currentUser.id, opponent: parsePgnHeader(pgn, 'White') + " vs " + parsePgnHeader(pgn, 'Black'),
        result: '*', date: new Date().toISOString().split('T')[0], accuracy: 'Pending', black_accuracy: 'Pending',
        white_elo: 'Pending', black_elo: 'Pending', pgn, is_reviewed: false
    };

    await supabaseClient.from('games').insert([newGame]);
    window.closeImportModal();
    window.switchView('dashboard');
};

function renderGamesList() {
    const container = document.getElementById('games-list');
    if (!container) return;
    container.innerHTML = '';

    if (savedGames.length === 0) {
        container.innerHTML = `<div class="p-6 text-center text-gray-400 text-sm">No saved games found.</div>`;
        return;
    }

    savedGames.forEach(game => {
        const row = document.createElement('div');
        row.className = "p-4 grid grid-cols-12 items-center text-sm hover:bg-gray-800/40 transition cursor-pointer";
        row.onclick = () => openGameReview(game);
        row.innerHTML = `<div class="col-span-5 font-semibold text-white">${game.opponent}</div><div class="col-span-3 text-gray-400">${game.result}</div><div class="col-span-2 text-kastledGold font-bold">${game.accuracy}</div><div class="col-span-2 text-right">Review</div>`;
        container.appendChild(row);
    });
}

async function openGameReview(game) {
    currentActiveGameRecord = game;
    setCurrentActiveGameRecord(game);

    activeGame = new Chess();
    activeGame.load_pgn(game.pgn);
    reviewHistory = activeGame.history({ verbose: true });
    activeGame.reset();
    currentReviewIndex = 0;

    if (!game.is_reviewed || game.accuracy === 'Pending') {
        await runFullGameAnalysis(activeGame, reviewHistory);
    }

    document.getElementById('white-accuracy-val').innerText = currentActiveGameRecord.accuracy || 'N/A';
    document.getElementById('black-accuracy-val').innerText = currentActiveGameRecord.black_accuracy || 'N/A';
    document.getElementById('white-elo-val').innerText = currentActiveGameRecord.white_elo || 'N/A';
    document.getElementById('black-elo-val').innerText = currentActiveGameRecord.black_elo || 'N/A';

    window.switchView('review');
}

function updateReviewUI() {
    if (activeGame) {
        const boardState = activeGame.board();
        const gridData = boardState.map(row => row.map(p => p ? (p.color === 'w' ? 'w' : 'b') + p.type.toUpperCase() : ''));
        renderRawBoard('review-board', gridData);
    }
    renderMovesList();
    analyzeCurrentPosition(activeGame, currentReviewIndex);
}

function renderMovesList() {
    const container = document.getElementById('moves-list-container');
    if (!container) return;
    container.innerHTML = '';
    const moveAnalysisData = getMoveAnalysisData();

    reviewHistory.forEach((move, idx) => {
        const moveBtn = document.createElement('div');
        const isCurrent = currentReviewIndex === idx + 1;
        const analysis = moveAnalysisData[idx + 1];
        moveBtn.className = `p-1.5 rounded cursor-pointer text-xs font-mono flex justify-between ${isCurrent ? 'bg-kastledGold text-kastledNavy font-bold' : 'bg-gray-900 text-gray-300'}`;
        moveBtn.innerHTML = `<span>${move.san}</span><span>${analysis ? analysis.badge : ''}</span>`;
        moveBtn.onclick = () => {
            activeGame.reset();
            for (let i = 0; i <= idx; i++) activeGame.move(reviewHistory[i]);
            currentReviewIndex = idx + 1;
            updateReviewUI();
        };
        container.appendChild(moveBtn);
    });
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
    activeGame = new Chess();
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
