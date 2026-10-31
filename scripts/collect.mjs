// Сборщик: снимает текущие цены с нескольких площадок и дописывает свечи в data/.
// Запускается из GitHub Actions каждые 15 минут (см. .github/workflows/update.yml).
//
// За один запуск площадки опрашиваются POLLS раз с паузой POLL_INTERVAL_S, поэтому у 15-минутных
// свечей есть настоящие открытие, максимум, минимум и закрытие, а не одна точка.
//
// Источники (ключи серий в data/items/*.json):
//   sp — Skinport, st — Steam Community Market, mc — market.csgo.com, wp — Waxpeer, ls — Lis-Skins,
//   ag — «Рынок»: медиана самых дешёвых предложений на Skinport, market.csgo.com, Waxpeer и Lis-Skins.
//        Steam в неё не входит: там цены выше из-за комиссии, а деньги со счёта Steam нельзя вывести.
import {
  httpGetJson, itemId, readJson, writeJson, addObservation, closeAt, pct, median, sleep, HOUR, DAY,
} from './lib.mjs';

const MAX_ITEMS = Number(process.env.MAX_ITEMS || 300); // сколько скинов отслеживать
const STEAM_ITEMS = Number(process.env.STEAM_ITEMS || 40); // сколько из них опрашивать в Steam за запуск
const STEAM_DELAY_MS = 3500; // у Steam жёсткий лимит частоты запросов
const POLLS = Math.max(1, Number(process.env.POLLS || 1)); // сколько раз опросить площадки за запуск
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_S || 300) * 1000; // Skinport кэширует ответ 5 минут

const SP = 'https://api.skinport.com/v1';
const nowSec = () => Math.floor(Date.now() / 1000);

// Площадки с открытым списком цен. parse → [название, мин. цена в $, число лотов, ссылка?]
const MARKETS = {
  mc: {
    name: 'market.csgo.com',
    url: 'https://market.csgo.com/api/v2/prices/USD.json',
    parse: (j) => j.items.map((x) => [x.market_hash_name, Number(x.price), Number(x.volume)]),
  },
  wp: {
    name: 'Waxpeer',
    url: 'https://api.waxpeer.com/v1/prices?game=csgo&minified=1',
    parse: (j) => j.items.map((x) => [x.name, x.min / 1000, x.count]), // цена в тысячных долях доллара
  },
  ls: {
    name: 'Lis-Skins',
    url: 'https://lis-skins.com/market_export_json/csgo.json',
    // Ссылка попадает на сайт как href, поэтому берём только адреса самой площадки.
    parse: (j) => j.map((x) => [x.name, Number(x.price), x.count, /^https:\/\/lis-skins\.com\//.test(x.url) ? x.url : null]),
  },
};
const AGG_SOURCES = ['sp', 'mc', 'wp', 'ls'];

function pickNewItems(history, tracked, limit) {
  const have = new Set(tracked);
  const rows = history
    .filter((h) => !have.has(h.market_hash_name) && (h.last_30_days?.median ?? 0) >= 0.5 && h.last_30_days?.volume > 0)
    .map((h) => ({
      name: h.market_hash_name,
      vol: h.last_30_days.volume,
      value: h.last_30_days.volume * h.last_30_days.median,
    }));
  // Две трети — по обороту в $, треть — по количеству продаж: так в список
  // попадают и дорогие ножи, и ходовые дешёвые скины.
  const byValue = [...rows].sort((a, b) => b.value - a.value);
  const byVol = [...rows].sort((a, b) => b.vol - a.vol);
  const want = Math.max(0, limit);
  const out = new Set(byValue.slice(0, Math.ceil((want * 2) / 3)).map((r) => r.name));
  for (const r of [...byVol, ...byValue]) {
    if (out.size >= want) break;
    out.add(r.name);
  }
  return [...out];
}

const parseSteamMoney = (s) => (s ? Number(String(s).replace(/[^0-9.]/g, '')) || null : null);
const parseSteamInt = (s) => (s ? Number(String(s).replace(/[^0-9]/g, '')) || 0 : null);

// Скачать списки цен всех площадок. Упавшая площадка просто пропускается.
async function fetchMarkets() {
  const keys = Object.keys(MARKETS);
  const res = await Promise.allSettled(keys.map((k) => httpGetJson(MARKETS[k].url)));
  const out = {};
  res.forEach((r, i) => {
    const k = keys[i];
    if (r.status !== 'fulfilled') { console.warn(`  ${MARKETS[k].name}: ${r.reason?.message}`); return; }
    try {
      const map = new Map();
      for (const [name, price, qty, url] of MARKETS[k].parse(r.value)) {
        if (name && price > 0) map.set(name, { price, qty: qty ?? null, url: url ?? null });
      }
      out[k] = map;
    } catch (e) {
      console.warn(`  ${MARKETS[k].name}: unexpected format: ${e.message}`);
    }
  });
  return out;
}

// Один опрос: Skinport + остальные площадки, запись наблюдений и «Рынка».
async function poll(docs, histByName, first) {
  const [spItems, markets] = await Promise.all([
    httpGetJson(`${SP}/items?app_id=730&currency=USD&tradable=0`).catch((e) => {
      if (first) throw e; // без первого снимка Skinport запуск не имеет смысла
      console.warn(`  Skinport: ${e.message}`);
      return null;
    }),
    fetchMarkets(),
  ]);
  const t = nowSec();
  const spByName = new Map((spItems || []).map((i) => [i.market_hash_name, i]));
  console.log(`  poll @${new Date(t * 1000).toISOString()}: skinport ${spByName.size}, ` +
    Object.entries(markets).map(([k, m]) => `${k} ${m.size}`).join(', '));

  for (const [name, doc] of docs) {
    const h = histByName.get(name);
    const vol24 = h?.last_24_hours?.volume ?? null;
    doc.now ||= {};
    const it = spByName.get(name);
    if (it) {
      addObservation(doc.sp, t, it.min_price, vol24, it.quantity);
      doc.now.sp = { p: it.min_price, q: it.quantity, url: it.item_page || doc.spUrl || null, t };
    }
    for (const k of Object.keys(MARKETS)) {
      const row = markets[k]?.get(name);
      if (!row) continue;
      doc[k] ||= {};
      addObservation(doc[k], t, row.price, null, row.qty);
      doc.now[k] = { p: row.price, q: row.qty, url: row.url, t };
    }
    // «Рынок» — только по свежим ценам этого опроса, чтобы старая цена площадки не тянула медиану.
    const fresh = AGG_SOURCES.map((k) => doc.now[k]).filter((x) => x && x.t === t);
    const mid = median(fresh.map((x) => x.p));
    if (mid != null) {
      doc.ag ||= {};
      addObservation(doc.ag, t, mid, vol24, fresh.reduce((s, x) => s + (x.q || 0), 0));
    }
  }
  return spItems ? spItems.length : 0;
}

async function steamPhase(docs, histByName, tracked) {
  // Steam: опрашиваем самые оборотные позиции из отслеживаемых.
  const steamList = [...tracked]
    .sort((a, b) => {
      const va = histByName.get(a)?.last_30_days; const vb = histByName.get(b)?.last_30_days;
      return (vb?.volume ?? 0) * (vb?.median ?? 0) - (va?.volume ?? 0) * (va?.median ?? 0);
    })
    .slice(0, STEAM_ITEMS);
  console.log(`Steam: ${steamList.length} items...`);
  let steamOk = 0;
  for (const name of steamList) {
    try {
      const r = await httpGetJson(
        `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(name)}`,
      );
      if (r.success) {
        const price = parseSteamMoney(r.lowest_price) ?? parseSteamMoney(r.median_price);
        const vol = parseSteamInt(r.volume);
        const t = nowSec();
        const doc = docs.get(name);
        addObservation(doc.st, t, price, vol, null);
        if (price) doc.now.st = { p: price, v: vol, t };
        steamOk++;
      }
    } catch (e) {
      console.warn(`  steam ${name}: ${e.message}`);
      if (e.status === 429) { console.warn('  Steam rate limit, stopping Steam phase'); break; }
    }
    await sleep(STEAM_DELAY_MS);
  }
  console.log(`  ok: ${steamOk}`);
}

function indexRow(name, doc, now) {
  const id = itemId(name);
  const sp = doc.sp.h?.at(-1);
  const ag = doc.ag?.h?.at(-1);
  const lastSt = doc.st.h?.at(-1);
  const p = ag?.[4] ?? sp?.[4] ?? null;
  // Изменение — по «Рынку», а пока его история короче суток — по Skinport.
  const change = (back) => pct(p, closeAt(doc.ag, now - back)) ?? pct(sp?.[4], closeAt(doc.sp, now - back));
  // Самое дешёвое свежее предложение (не старше 2 часов).
  let best = null;
  for (const k of AGG_SOURCES) {
    const x = doc.now?.[k];
    if (x && x.t >= now - 2 * HOUR && (!best || x.p < best.p)) best = { p: x.p, m: k };
  }
  return {
    id,
    n: name,
    p,
    best,
    c24: change(DAY),
    c7: change(7 * DAY),
    v24: doc.sales?.d1?.volume ?? null,
    v7: doc.sales?.d7?.volume ?? null,
    v30: doc.sales?.d30?.volume ?? null,
    q: sp?.[6] ?? null, // лоты на Skinport — для оценки ликвидности
    qa: ag?.[6] ?? null, // лоты на всех площадках
    sp: lastSt && lastSt[0] >= now - 2 * DAY ? lastSt[4] : null,
    // Если своей истории ещё нет, показываем изменение по средним ценам продаж Skinport.
    a24: doc.sales?.d1?.avg ?? null,
    a7: doc.sales?.d7?.avg ?? null,
    fresh: !!sp && sp[0] >= Math.floor(now / HOUR) * HOUR - 3 * HOUR,
  };
}

async function main() {
  console.log('Skinport: sales history...');
  const history = await httpGetJson(`${SP}/sales/history?app_id=730&currency=USD`);
  const histByName = new Map(history.map((h) => [h.market_hash_name, h]));
  console.log(`  ${history.length} sales rows`);

  const tracked = await readJson('tracked.json', []);
  const added = pickNewItems(history, tracked, MAX_ITEMS - tracked.length);
  tracked.push(...added);
  if (added.length) console.log(`  +${added.length} new tracked items (total ${tracked.length})`);
  await writeJson('tracked.json', tracked);

  const docs = new Map();
  for (const name of tracked) {
    const doc = await readJson(`items/${itemId(name)}.json`, { n: name, sp: {}, st: {} });
    const h = histByName.get(name);
    doc.spUrl = h?.item_page || doc.spUrl;
    doc.sales = h ? { d1: h.last_24_hours, d7: h.last_7_days, d30: h.last_30_days, d90: h.last_90_days } : doc.sales;
    docs.set(name, doc);
  }

  const start = Date.now();
  for (let i = 0; i < POLLS; i++) {
    if (i > 0) await sleep(Math.max(0, start + i * POLL_INTERVAL_MS - Date.now()));
    console.log(`Poll ${i + 1}/${POLLS}`);
    await poll(docs, histByName, i === 0);
    if (i === 0) await steamPhase(docs, histByName, tracked); // Steam медленный: опрашиваем его в паузе между опросами
  }

  const now = nowSec();
  const index = [];
  for (const [name, doc] of docs) {
    await writeJson(`items/${itemId(name)}.json`, doc);
    index.push(indexRow(name, doc, now));
  }
  index.sort((a, b) => (b.v30 ?? 0) * (b.p ?? 0) - (a.v30 ?? 0) * (a.p ?? 0));
  const markets = { sp: 'Skinport', st: 'Steam', ...Object.fromEntries(Object.entries(MARKETS).map(([k, m]) => [k, m.name])) };
  await writeJson('index.json', { updated: now, currency: 'USD', markets, items: index });
  console.log(`Done: ${index.length} items written`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
