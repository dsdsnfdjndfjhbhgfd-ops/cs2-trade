// Вход на сайт: через Steam или по почте и паролю (Supabase Auth).
//
// Steam: вход делает edge-функция steam-auth (supabase/functions/steam-auth). Она проверяет ответ
// Steam и возвращает браузер сюда с сессией во фрагменте адреса (#access_token=…&refresh_token=…).
// Почта: регистрация и вход идут напрямую в Supabase Auth. Ссылка из письма-подтверждения
// тоже возвращает сюда с сессией во фрагменте адреса.
(() => {
  'use strict';

  // Публичные значения: адрес проекта и publishable-ключ можно хранить в коде сайта.
  const SUPABASE_URL = 'https://fblexuxfxbbhgrhcntju.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_R6yEKxSHc-yrYFnT1x_YtA_EAuuavcf';
  const STEAM_LOGIN_URL = `${SUPABASE_URL}/functions/v1/steam-auth`;
  const RETURN_KEY = 'cs2trade.returnHash';
  const MIN_PASSWORD = 8;

  const $ = (id) => document.getElementById(id);
  const box = $('auth');
  const dlg = $('authDialog');
  const form = $('authForm');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* без хранилища просто не вернёмся к скину */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ничего */ } },
  };
  const siteUrl = () => location.origin + location.pathname;
  const rememberPlace = () => store.set(RETURN_KEY, location.hash);

  // Разбираем возврат после входа синхронно, до того как app.js прочитает адрес:
  // фрагмент с токенами или ошибкой заменяем на скин, который был открыт до входа.
  const frag = new URLSearchParams(location.hash.slice(1));
  const tokens = frag.get('access_token') && frag.get('refresh_token')
    ? { access_token: frag.get('access_token'), refresh_token: frag.get('refresh_token') }
    : null;
  let loginError = frag.get('login_error') ||
    (frag.get('error_code') === 'otp_expired' ? 'Ссылка из письма устарела. Войдите, чтобы получить новую.' : null) ||
    (frag.get('error') ? frag.get('error_description') || 'Не удалось войти' : null);
  const fromEmail = frag.get('type') === 'signup' || frag.get('type') === 'magiclink';
  if (tokens || loginError) {
    history.replaceState(null, '', location.pathname + location.search + (store.get(RETURN_KEY) || ''));
    store.del(RETURN_KEY);
  }

  if (!window.supabase) { box.hidden = true; return; }
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  // ---------- Шапка ----------
  function render(session) {
    const u = session?.user;
    if (!u) {
      box.innerHTML = `<button type="button" class="login-btn" id="openLogin">Войти</button>`;
      $('openLogin').addEventListener('click', () => openDialog('login'));
      return;
    }
    const m = u.user_metadata || {};
    const isSteam = !!u.app_metadata?.steam_id;
    const name = isSteam ? m.name || 'Steam' : u.email;
    const inner = (m.avatar ? `<img src="${esc(m.avatar)}" alt="" width="26" height="26">` : `<i class="ava">${esc((name || '?')[0].toUpperCase())}</i>`) +
      `<span>${esc(name)}</span>`;
    box.innerHTML =
      (isSteam && m.profile_url
        ? `<a class="profile" href="${esc(m.profile_url)}" target="_blank" rel="noopener" title="Профиль Steam">${inner}</a>`
        : `<span class="profile" title="${esc(name)}">${inner}</span>`) +
      `<button type="button" class="logout" id="logout">Выйти</button>`;
    $('logout').addEventListener('click', () => client.auth.signOut());
  }

  // ---------- Окно входа ----------
  let mode = 'login';
  const msg = (text, kind = 'err') => {
    const el = $('authMsg');
    el.textContent = text || '';
    el.className = 'auth-msg ' + kind;
    el.hidden = !text;
  };

  function setMode(m) {
    mode = m;
    for (const b of dlg.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === m);
    const reg = m === 'signup';
    $('authPassword2Row').hidden = !reg;
    $('authPassword2').required = reg;
    $('authPassword').autocomplete = reg ? 'new-password' : 'current-password';
    $('authPassword').minLength = reg ? MIN_PASSWORD : 0;
    $('authSubmit').textContent = reg ? 'Зарегистрироваться' : 'Войти';
    $('authHint').hidden = !reg;
    msg('');
  }

  function openDialog(m) {
    setMode(m);
    form.reset();
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('authEmail').focus();
  }
  const closeDialog = () => (typeof dlg.close === 'function' ? dlg.close() : dlg.removeAttribute('open'));

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeDialog(); // клик по затемнению
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('authClose').addEventListener('click', closeDialog);
  $('steamLogin').addEventListener('click', () => {
    rememberPlace();
    location.href = `${STEAM_LOGIN_URL}?redirect=${encodeURIComponent(siteUrl())}`;
  });

  // Ответы Supabase Auth — по-русски.
  function explain(error) {
    const code = error?.code || '';
    const text = error?.message || '';
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(text)) return 'Неверная почта или пароль.';
    if (code === 'email_not_confirmed' || /not confirmed/i.test(text)) return 'Почта не подтверждена: откройте ссылку из письма.';
    if (code === 'user_already_exists' || /already registered/i.test(text)) return 'Эта почта уже зарегистрирована. Войдите.';
    if (code === 'weak_password' || /password/i.test(text) && /weak|short|least/i.test(text)) return `Слишком простой пароль: нужно не меньше ${MIN_PASSWORD} символов.`;
    if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(text)) return 'Проверьте адрес почты.';
    if (code === 'email_address_not_authorized' || /not authorized/i.test(text)) return 'Сайт пока не может отправлять письма на этот адрес. Войдите через Steam или попробуйте позже.';
    if (code === 'signup_disabled' || /signups not allowed/i.test(text)) return 'Регистрация по почте сейчас отключена.';
    if (/rate limit/i.test(code + text) || error?.status === 429) return 'Слишком много попыток. Подождите немного и попробуйте снова.';
    return 'Не удалось выполнить запрос. Попробуйте ещё раз.';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    msg('');
    if (/\.invalid$/i.test(email)) return msg('Проверьте адрес почты.');
    if (mode === 'signup') {
      if (password.length < MIN_PASSWORD) return msg(`Пароль должен быть не короче ${MIN_PASSWORD} символов.`);
      if (password !== $('authPassword2').value) return msg('Пароли не совпадают.');
    }

    const btn = $('authSubmit');
    btn.disabled = true;
    try {
      if (mode === 'login') {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) return msg(explain(error));
        closeDialog();
      } else {
        rememberPlace();
        const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: siteUrl() } });
        if (error) return msg(explain(error));
        if (data.session) return closeDialog(); // подтверждение почты выключено — сразу вошли
        // Supabase не сообщает прямо, что почта уже занята: в этом случае у пользователя нет identities.
        if (data.user && data.user.identities?.length === 0) return msg(explain({ code: 'user_already_exists' }));
        form.reset();
        msg(`Мы отправили письмо на ${email}. Откройте ссылку из него, чтобы подтвердить почту и войти.`, 'ok');
      }
    } catch {
      msg('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Сессия ----------
  client.auth.onAuthStateChange((_event, session) => {
    // Колбэк вызывается внутри блокировки supabase-js, поэтому рисуем после неё.
    setTimeout(() => render(session), 0);
  });

  (async () => {
    if (tokens) {
      const { error } = await client.auth.setSession(tokens);
      if (error) loginError = fromEmail ? 'Ссылка из письма недействительна. Попробуйте войти.' : 'Не удалось войти, попробуйте ещё раз';
    }
    const { data } = await client.auth.getSession();
    render(data.session);
    // Ошибку входа (отмена в Steam, устаревшая ссылка из письма) показываем в окне входа.
    if (!data.session && loginError) {
      openDialog('login');
      msg(loginError);
      loginError = null;
    }
  })();

  window.cs2auth = client; // на будущее: избранное, портфель и т. п.
})();
