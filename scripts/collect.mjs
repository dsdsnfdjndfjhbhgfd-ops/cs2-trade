// Сборщик: снимает текущие цены с Skinport и Steam Market и дописывает свечи в data/.
// Запускается из GitHub Actions каждые 30 минут (см. .github/workflows/update.yml).
import {
  httpGetJson, itemId, readJson, writeJson, addObservation, closeAt, pct, sleep, HOUR, DAY,
} from './lib.mjs';

const MAX_ITEMS = Number(process.env.MAX_ITEMS || 300); // сколько скинов отслеживать
const STEAM_ITEMS = Number(process.env.STEAM_ITEMS || 40); // сколько из них опрашивать в Steam за запуск
const STEAM_DELAY_MS = 3500; // у Steam жёсткий лимит частоты запросов

const now = Math.floor(Date.now() / 1000);
const SP = 'https://api.skinport.com/v1';

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

async function main() {
  console.log('Skinport: items + sales history...');
  const [items, history] = await Promise.all([
    httpGetJson(`${SP}/items?app_id=730&currency=USD&tradable=0`),
    httpGetJson(`${SP}/sales/history?app_id=730&currency=USD`),
  ]);
  const itemsByName = new Map(items.map((i) => [i.market_hash_name, i]));
  const histByName = new Map(history.map((h) => [h.market_hash_name, h]));
  console.log(`  ${items.length} listings, ${history.length} sales rows`);

  const tracked = await readJson('tracked.json', []);
  const added = pickNewItems(history, tracked, MAX_ITEMS - tracked.length);
  tracked.push(...added);
  if (added.length) console.log(`  +${added.length} new tracked items (total ${tracked.length})`);
  await writeJson('tracked.json', tracked);

  const docs = new Map();
  for (const name of tracked) {
    const id = itemId(name);
    const doc = await readJson(`items/${id}.json`, { n: name, sp: {}, st: {} });
    const it = itemsByName.get(name);
    const h = histByName.get(name);
    if (it) addObservation(doc.sp, now, it.min_price, h?.last_24_hours?.volume ?? null, it.quantity);
    doc.spUrl = it?.item_page || h?.item_page || doc.spUrl;
    doc.sales = h ? {
      d1: h.last_24_hours, d7: h.last_7_days, d30: h.last_30_days, d90: h.last_90_days,
    } : doc.sales;
    docs.set(name, doc);
  }

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
        addObservation(docs.get(name).st, now, price, parseSteamInt(r.volume), null);
        steamOk++;
      }
    } catch (e) {
      console.warn(`  steam ${name}: ${e.message}`);
      if (e.status === 429) { console.warn('  Steam rate limit, stopping Steam phase'); break; }
    }
    await sleep(STEAM_DELAY_MS);
  }
  console.log(`  ok: ${steamOk}`);

  const index = [];
  for (const [name, doc] of docs) {
    const id = itemId(name);
    await writeJson(`items/${id}.json`, doc);
    const lastSp = doc.sp.h?.at(-1);
    const lastSt = doc.st.h?.at(-1);
    const p = lastSp?.[4] ?? null;
    index.push({
      id,
      n: name,
      p,
      c24: pct(p, closeAt(doc.sp, now - DAY)),
      c7: pct(p, closeAt(doc.sp, now - 7 * DAY)),
      v24: doc.sales?.d1?.volume ?? null,
      v7: doc.sales?.d7?.volume ?? null,
      v30: doc.sales?.d30?.volume ?? null,
      q: lastSp?.[6] ?? null,
      sp: lastSt && lastSt[0] >= now - 2 * DAY ? lastSt[4] : null,
      // Если своей истории ещё нет, показываем изменение по средним ценам продаж Skinport.
      a24: doc.sales?.d1?.avg ?? null,
      a7: doc.sales?.d7?.avg ?? null,
      fresh: !!lastSp && lastSp[0] >= Math.floor(now / HOUR) * HOUR - 3 * HOUR,
    });
  }
  index.sort((a, b) => (b.v30 ?? 0) * (b.p ?? 0) - (a.v30 ?? 0) * (a.p ?? 0));
  await writeJson('index.json', { updated: now, currency: 'USD', items: index });
  console.log(`Done: ${index.length} items written`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
