import { PIECE_IMAGES, INITIAL_BOARD, playSound, sounds } from './config.js';

export function renderRawBoard(elementId, gridData) {
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

export function updateAuthHeader(currentUser, openAuthModalCb, logoutCb, checkAuthAndSwitchCb) {
    const container = document.getElementById('auth-nav-container');
    if (!container) return;

    if (currentUser) {
        container.innerHTML = `
            <div class="flex items-center space-x-3 bg-gray-900/80 px-4 py-2 rounded-full border border-gray-800 cursor-pointer" onclick="window.checkAuthAndSwitch('profile')">
                <span class="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                <span class="text-xs text-gray-300 font-mono">${currentUser.email}</span>
            </div>
            <button onclick="window.logout()" class="px-4 py-2 rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/10 text-xs font-bold transition">Log Out</button>
        `;
    } else {
        container.innerHTML = `
            <button onclick="window.openAuthModal('login')" class="px-5 py-2 rounded-full border border-gray-600 hover:border-kastledGold text-sm font-semibold transition">Log In</button>
            <button onclick="window.openAuthModal('signup')" class="px-5 py-2 rounded-full bg-kastledGold text-kastledNavy font-bold text-sm hover:bg-kastledGoldHover transition shadow-lg" style="background-color:#E5A93C; color:#0B132B;">SIGN UP</button>
        `;
    }
}

export function updateEvalUI(evalScore) {
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

export function parsePgnHeader(pgn, tag) {
    const regex = new RegExp(`\\[${tag}\\s+"([^"]+)"\\]`, 'i');
    const match = pgn.match(regex);
    return match ? match[1] : null;
}
