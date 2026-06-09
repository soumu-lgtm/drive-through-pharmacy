// ===== Supabase Auth モジュール (auth.js) =====
// 電子カルテ v0.9 — ログイン認証

let authUser = null;

async function initAuth() {
  if (!supabaseClient) return false;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    authUser = session.user;
    showApp();
    return true;
  }
  showLoginScreen();
  return false;
}

function showLoginScreen() {
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('appContainer').style.display = 'none';
}

function showApp() {
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('appContainer').style.display = '';
  const badge = document.getElementById('authUserBadge');
  if (badge && authUser) {
    badge.textContent = authUser.email;
    badge.style.display = '';
  }
}

async function handleLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';

  if (!email || !password) {
    errorEl.textContent = 'メールアドレスとパスワードを入力してください';
    return;
  }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = 'ログイン中...';

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      errorEl.textContent = 'ログイン失敗: ' + error.message;
      btn.disabled = false;
      btn.textContent = 'ログイン';
      return;
    }
    authUser = data.user;
    showApp();
  } catch (e) {
    errorEl.textContent = 'エラー: ' + e.message;
    btn.disabled = false;
    btn.textContent = 'ログイン';
  }
}

async function handleLogout() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  authUser = null;
  showLoginScreen();
}

// Listen for auth state changes (token refresh, etc.)
function setupAuthListener() {
  if (!supabaseClient) return;
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      authUser = null;
      showLoginScreen();
    } else if (session) {
      authUser = session.user;
    }
  });
}
