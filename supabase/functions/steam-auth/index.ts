// Вход через Steam (OpenID 2.0) для статического сайта на GitHub Pages.
//
// 1. Сайт отправляет браузер сюда: /functions/v1/steam-auth?redirect=<адрес сайта>
// 2. Функция перенаправляет на страницу входа Steam.
// 3. Steam возвращает браузер сюда с подписанным ответом; функция проверяет его
//    у самого Steam (check_authentication), находит или создаёт пользователя Supabase
//    и отправляет браузер обратно на сайт с сессией во фрагменте адреса (#access_token=…).
//
// Деплой: verify_jwt = false — браузер приходит сюда обычным переходом, без токена.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STEAM_API_KEY = Deno.env.get("STEAM_API_KEY"); // необязательно: без ключа профиль берётся из открытого XML
const SELF = `${SUPABASE_URL}/functions/v1/steam-auth`;
const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const DEFAULT_SITE = "https://dsdsnfdjndfjhbhgfd-ops.github.io/cs2-trade/";

// Куда можно возвращать пользователя после входа. Дополнительные адреса — через
// переменную ALLOWED_REDIRECTS (префиксы через запятую).
const ALLOWED_PREFIXES = [
  DEFAULT_SITE,
  ...(Deno.env.get("ALLOWED_REDIRECTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
];
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;

function safeRedirect(raw: string | null): string {
  if (!raw) return DEFAULT_SITE;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return DEFAULT_SITE;
  }
  u.hash = "";
  const s = u.toString();
  return ALLOWED_PREFIXES.some((p) => s.startsWith(p)) || LOCALHOST.test(s) ? s : DEFAULT_SITE;
}

const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
const backWithError = (site: string, msg: string) => redirect(`${site}#login_error=${encodeURIComponent(msg)}`);

function startLogin(site: string): Response {
  const returnTo = `${SELF}?redirect=${encodeURIComponent(site)}`;
  const p = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": new URL(SUPABASE_URL).origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return redirect(`${STEAM_OPENID}?${p}`);
}

// Проверяем ответ Steam и возвращаем SteamID64 или null.
async function verifySteam(params: URLSearchParams, site: string): Promise<string | null> {
  if (params.get("openid.op_endpoint") !== STEAM_OPENID) return null;
  // return_to должен указывать на эту функцию и на тот же сайт, что и в запросе.
  const returnTo = params.get("openid.return_to") ?? "";
  if (!returnTo.startsWith(`${SELF}?`)) return null;
  if (safeRedirect(new URL(returnTo).searchParams.get("redirect")) !== site) return null;
  const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(params.get("openid.claimed_id") ?? "");
  if (!m) return null;

  const body = new URLSearchParams();
  for (const [k, v] of params) if (k.startsWith("openid.")) body.set(k, v);
  body.set("openid.mode", "check_authentication");
  const res = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  return /^is_valid\s*:\s*true$/m.test(text) ? m[1] : null;
}

type Profile = { name: string; avatar: string | null; profile_url: string };

async function steamProfile(id: string): Promise<Profile> {
  const fallback = { name: `Steam ${id}`, avatar: null, profile_url: `https://steamcommunity.com/profiles/${id}` };
  try {
    if (STEAM_API_KEY) {
      const r = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${id}`,
      );
      const p = (await r.json())?.response?.players?.[0];
      if (p) return { name: p.personaname, avatar: p.avatarmedium ?? null, profile_url: p.profileurl ?? fallback.profile_url };
    }
    const xml = await (await fetch(`https://steamcommunity.com/profiles/${id}/?xml=1`)).text();
    const tag = (t: string) => new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`).exec(xml)?.[1]?.trim();
    return { name: tag("steamID") || fallback.name, avatar: tag("avatarMedium") || null, profile_url: fallback.profile_url };
  } catch {
    return fallback;
  }
}

async function signIn(steamId: string) {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const profile = await steamProfile(steamId);
  // У пользователей Steam нет почты: адрес служебный, на него ничего не отправляется.
  const email = `steam_${steamId}@users.cs2-trade.invalid`;
  const meta = { steam_id: steamId, ...profile };

  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { steam_id: steamId },
    user_metadata: meta,
  });
  if (created.error && !/already|exists|registered/i.test(created.error.message)) throw created.error;

  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) throw link.error;
  if (!created.data.user) await admin.auth.admin.updateUserById(link.data.user.id, { user_metadata: meta });

  const otp = await admin.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  if (otp.error || !otp.data.session) throw otp.error ?? new Error("no session");
  return otp.data.session;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const site = safeRedirect(url.searchParams.get("redirect"));
  const mode = url.searchParams.get("openid.mode");

  if (!mode) return startLogin(site);
  if (mode === "cancel") return backWithError(site, "Вход отменён");
  if (mode !== "id_res") return backWithError(site, "Неожиданный ответ Steam");

  try {
    const steamId = await verifySteam(url.searchParams, site);
    if (!steamId) return backWithError(site, "Steam не подтвердил вход");
    const s = await signIn(steamId);
    const frag = new URLSearchParams({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_in: String(s.expires_in),
      token_type: "bearer",
    });
    return redirect(`${site}#${frag}`);
  } catch (e) {
    console.error("steam-auth", e);
    return backWithError(site, "Не удалось войти, попробуйте ещё раз");
  }
});
