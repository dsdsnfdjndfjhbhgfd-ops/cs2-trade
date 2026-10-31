// Необязательная загрузка прошлой истории цен из Steam Market (за годы назад).
// Steam отдаёт историю только авторизованным пользователям, поэтому нужен cookie
// steamLoginSecure в секрете репозитория STEAM_LOGIN_SECURE. Запуск вручную:
// Actions → "Backfill Steam history" → Run workflow.
import { httpGetJson, itemId, readJson, writeJson, sleep, HOUR, DAY, HOURLY_RETENTION_DAYS } from './lib.mjs';

const cookie = process.env.STEAM_LOGIN_SECURE;
if (!cookie) {
  console.error('STEAM_LOGIN_SECURE is not set');
  process.exit(1);
}
const LIMIT = Number(process.env.BACKFILL_LIMIT || 1000);
const now = Math.floor(Date.now() / 1000);

// "Oct 30 2026 01: +0" → unix time (UTC)
function parseSteamDate(s) {
  const m = /^(\w{3}) (\d{2}) (\d{4}) (\d{2})/.exec(s);
  if (!m) return null;
  return Math.floor(Date.parse(`${m[1]} ${m[2]} ${m[3]} ${m[4]}:00:00 UTC`) / 1000);
}

function buildCandles(points) {
  const d = [];
  const h = [];
  const minH = now - HOURLY_RETENTION_DAYS * DAY;
  for (const [t, price, vol] of points) {
    const day = Math.floor(t / DAY) * DAY;
    const last = d.at(-1);
    if (last && last[0] === day) {
      last[2] = Math.max(last[2], price);
      last[3] = Math.min(last[3], price);
      last[4] = price;
      last[5] += vol;
    } else {
      d.push([day, price, price, price, price, vol, null]);
    }
  }
  // Часовые свечи: объём — скользящая сумма продаж за 24 часа, как у сборщика.
  const recent = points.filter(([t]) => t >= minH - DAY);
  let windowSum = 0;
  let j = 0;
  for (let i = 0; i < recent.length; i++) {
    const [t, price, vol] = recent[i];
    windowSum += vol;
    while (recent[j][0] <= t - DAY) windowSum -= recent[j++][2];
    if (t >= minH) h.push([Math.floor(t / HOUR) * HOUR, price, price, price, price, windowSum, null]);
  }
  return { h, d };
}

// Склеиваем: загруженная история идёт только раньше уже собранных свечей.
const merge = (old = [], fresh) => {
  const first = old[0]?.[0] ?? Infinity;
  return [...fresh.filter((c) => c[0] < first), ...old];
};

async function main() {
  const tracked = (await readJson('tracked.json', [])).slice(0, LIMIT);
  let ok = 0;
  for (const name of tracked) {
    const id = itemId(name);
    const doc = await readJson(`items/${id}.json`, { n: name, sp: {}, st: {} });
    try {
      const r = await httpGetJson(
        `https://steamcommunity.com/market/pricehistory/?appid=730&currency=1&market_hash_name=${encodeURIComponent(name)}`,
        { Cookie: `steamLoginSecure=${cookie}` },
      );
      if (r.success && Array.isArray(r.prices)) {
        const points = r.prices
          .map(([ds, price, vol]) => [parseSteamDate(ds), Number(price), Number(vol) || 0])
          .filter(([t, p]) => t && p > 0);
        const { h, d } = buildCandles(points);
        doc.st = { h: merge(doc.st?.h, h), d: merge(doc.st?.d, d) };
        await writeJson(`items/${id}.json`, doc);
        ok++;
        console.log(`${name}: ${d.length} days`);
      }
    } catch (e) {
      console.warn(`${name}: ${e.message}`);
      if (e.status === 429) {
        console.warn('Rate limited, waiting 60s');
        await sleep(60000);
      }
      if ((e.status === 400 || e.status === 403) && ok === 0) {
        console.error('Steam rejected the cookie — check STEAM_LOGIN_SECURE');
        process.exit(1);
      }
    }
    await sleep(4000);
  }
  console.log(`Backfilled ${ok}/${tracked.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
