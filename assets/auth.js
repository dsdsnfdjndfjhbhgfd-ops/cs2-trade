// Вход через Steam. Сам вход делает edge-функция Supabase steam-auth
// (supabase/functions/steam-auth): она проверяет ответ Steam и возвращает
// браузер сюда с сессией во фрагменте адреса (#access_token=…&refresh_token=…).
(() => {
  'use strict';

  // Публичные значения: адрес проекта и publishable-ключ можно хранить в коде сайта.
  const SUPABASE_URL = 'https://fblexuxfxbbhgrhcntju.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_R6yEKxSHc-yrYFnT1x_YtA_EAuuavcf';
  const LOGIN_URL = `${SUPABASE_URL}/functions/v1/steam-auth`;
  const RETURN_KEY = 'cs2trade.returnHash';

  const box = document.getElementById('auth');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* без хранилища просто не вернёмся к скину */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ничего */ } },
  };

  // Разбираем ответ функции входа синхронно, до того как app.js прочитает адрес:
  // фрагмент с токенами заменяем на скин, который был открыт до входа.
  const frag = new URLSearchParams(location.hash.slice(1));
  const tokens = frag.get('access_token') && frag.get('refresh_token')
    ? { access_token: frag.get('access_token'), refresh_token: frag.get('refresh_token') }
    : null;
  let loginError = frag.get('login_error');
  if (tokens || loginError) {
    history.replaceState(null, '', location.pathname + location.search + (store.get(RETURN_KEY) || ''));
    store.del(RETURN_KEY);
  }

  if (!window.supabase) { box.hidden = true; return; }
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  function render(session) {
    const u = session?.user;
    if (!u) {
      box.innerHTML = `<button type="button" class="steam-btn" id="login">Войти через Steam</button>` +
        (loginError ? `<span class="auth-err" role="alert">${esc(loginError)}</span>` : '');
      document.getElementById('login').addEventListener('click', login);
      return;
    }
    const m = u.user_metadata || {};
    const name = m.name || 'Steam';
    box.innerHTML =
      `<a class="profile" href="${esc(m.profile_url || '#')}" target="_blank" rel="noopener" title="Профиль Steam">` +
        (m.avatar ? `<img src="${esc(m.avatar)}" alt="" width="26" height="26">` : '') +
        `<span>${esc(name)}</span></a>` +
      `<button type="button" class="logout" id="logout">Выйти</button>`;
    document.getElementById('logout').addEventListener('click', () => client.auth.signOut());
  }

  function login() {
    store.set(RETURN_KEY, location.hash);
    const site = location.origin + location.pathname;
    location.href = `${LOGIN_URL}?redirect=${encodeURIComponent(site)}`;
  }

  client.auth.onAuthStateChange((_event, session) => {
    if (session) loginError = null;
    // Колбэк вызывается внутри блокировки supabase-js, поэтому рисуем после неё.
    setTimeout(() => render(session), 0);
  });

  (async () => {
    if (tokens) {
      const { error } = await client.auth.setSession(tokens);
      if (error) loginError = 'Не удалось войти, попробуйте ещё раз';
    }
    const { data } = await client.auth.getSession();
    render(data.session);
  })();

  window.cs2auth = client; // на будущее: избранное, портфель и т. п.
})();
