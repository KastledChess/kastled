export const SUPABASE_URL = "https://sgpafvuexdmnbdbvveny.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_blGh-rrLxaxf5K14TEAzVw_NuXYM1d5";

export const supabaseClient = (typeof supabase !== 'undefined' && SUPABASE_URL !== "") 
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) 
    : null;

export const PIECE_IMAGES = {
    'wP': './Assets/wP.png', 'wN': './Assets/wN.png', 'wB': './Assets/wB.png',
    'wR': './Assets/wR.png', 'wQ': './Assets/wQ.png', 'wK': './Assets/wK.png',
    'bP': './Assets/bP.png', 'bN': './Assets/bN.png', 'bB': './Assets/bB.png',
    'bR': './Assets/bR.png', 'bQ': './Assets/bQ.png', 'bK': './Assets/bK.png'
};

export const INITIAL_BOARD = [
    ['bR','bN','bB','bQ','bK','bB','bN','bR'],
    ['bP','bP','bP','bP','bP','bP','bP','bP'],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['wP','wP','wP','wP','wP','wP','wP','wP'],
    ['wR','wN','wB','wQ','wK','wB','wN','wR']
];

// Audio Sound Effects
export const sounds = {
    gameStart: new Audio('./Assets/game-start.wav'),
    move: new Audio('./Assets/move.wav'),
    capture: new Audio('./Assets/capture.wav'),
    check: new Audio('./Assets/check.wav'),
    gameOver: new Audio('./Assets/game-over.wav')
};

export function playSound(audioObj) {
    if (!audioObj) return;
    audioObj.currentTime = 0;
    audioObj.play().catch(() => {});
}
