// Общие функции сборщика: HTTP через curl, хранение свечей, файлы данных.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

export const DATA_DIR = process.env.DATA_DIR || 'data';
export const HOUR = 3600;
export const DAY = 86400;
export const MIN15 = 15 * 60;
// Сколько дней хранить часовые и 15-минутные свечи (дневные хранятся всегда).
export const HOURLY_RETENTION_DAYS = 45;
export const MIN15_RETENTION_DAYS = 7;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// curl, а не fetch: Skinport требует Accept-Encoding: br, а встроенный fetch
// в Node не всегда отправляет этот заголовок как есть.
export async function httpGetJson(url, headers = {}) {
  const args = ['-sS', '--compressed', '--max-time', '120', '-w', '\n%{http_code}', '-H', 'Accept-Encoding: br, gzip'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  const { stdout } = await execFileP('curl', args, { maxBuffer: 256 * 1024 * 1024 });
  const cut = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(cut + 1));
  const body = stdout.slice(0, cut);
  if (status !== 200) {
    const err = new Error(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    err.status = status;
    throw err;
  }
  return JSON.parse(body);
}

export const itemId = (name) => createHash('sha1').update(name).digest('hex').slice(0, 12);

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, value) {
  const full = path.join(DATA_DIR, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(value));
}

const round = (x) => Math.round(x * 100) / 100;

// Свеча: [время, open, high, low, close, объём продаж за 24ч, кол-во лотов]
function upsertCandle(list, bucket, price, vol, qty) {
  const last = list[list.length - 1];
  if (last && last[0] === bucket) {
    last[2] = Math.max(last[2], price);
    last[3] = Math.min(last[3], price);
    last[4] = price;
    last[5] = vol;
    last[6] = qty;
  } else if (!last || last[0] < bucket) {
    list.push([bucket, price, price, price, price, vol, qty]);
  }
}

// Добавить наблюдение цены в серию источника { m: [...15 мин], h: [...час], d: [...день] }.
export function addObservation(series, t, price, vol, qty) {
  if (price == null || !(price > 0)) return;
  price = round(price);
  series.m ||= [];
  series.h ||= [];
  series.d ||= [];
  upsertCandle(series.m, Math.floor(t / MIN15) * MIN15, price, vol ?? null, qty ?? null);
  upsertCandle(series.h, Math.floor(t / HOUR) * HOUR, price, vol ?? null, qty ?? null);
  upsertCandle(series.d, Math.floor(t / DAY) * DAY, price, vol ?? null, qty ?? null);
  const minH = t - HOURLY_RETENTION_DAYS * DAY;
  while (series.h.length && series.h[0][0] < minH) series.h.shift();
  const minM = t - MIN15_RETENTION_DAYS * DAY;
  while (series.m.length && series.m[0][0] < minM) series.m.shift();
}

export function median(values) {
  const v = values.filter((x) => x != null && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Цена закрытия свечи, ближайшей к моменту t (не позже), для расчёта изменения.
export function closeAt(series, t) {
  const list = series?.h?.length ? series.h : series?.d;
  if (!list?.length) return null;
  let best = null;
  for (const c of list) {
    if (c[0] <= t) best = c;
    else break;
  }
  return best ? best[4] : null;
}

export const pct = (now, before) => (now && before ? round(((now - before) / before) * 100) : null);
