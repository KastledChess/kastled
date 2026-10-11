import { supabaseClient } from './config.js';

export async function checkAuthSession() {
    if (!supabaseClient) return null;
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        return session ? session.user : null;
    } catch (e) {
        console.warn("Supabase auth session check skipped:", e);
        return null;
    }
}

export async function loadProfileData(currentUser) {
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

export async function handleProfileUpdate(e, currentUser) {
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
            id: currentUser.id, full_name: fullName, email: newEmail || currentUser.email,
            chesscom_alias: chesscomAlias, lichess_alias: lichessAlias, updated_at: new Date()
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

export async function fetchGamesFromDatabase(currentUser, renderGamesListCallback) {
    if (!currentUser || !supabaseClient) return [];

    const { data, error } = await supabaseClient
        .from('games')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false });

    if (!error && data) {
        renderGamesListCallback(data);
        return data;
    }
    console.error('Error fetching games:', error);
    return [];
}
