(() => {
  'use strict';

  const HOUR = 3600;
  const DAY = 86400;
  const $ = (id) => document.getElementById(id);

  const state = { index: [], item: null, id: null, source: 'sp', tf: '4h', showQty: false };

  const fmtMoney = (v) => (v == null ? '—' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const fmtInt = (v) => (v == null ? '—' : v.toLocaleString('ru-RU'));
  const fmtPct = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
  const cls = (v) => (v == null || v === 0 ? 'muted' : v > 0 ? 'up' : 'down');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (a, b) => (a && b ? ((a - b) / b) * 100 : null);

  // "★ Butterfly Knife | Fade (Factory New)" → ["★ Butterfly Knife | Fade", "Factory New"]
  function splitName(n) {
    const m = /^(.*) \(([^()]+)\)$/.exec(n);
    return m ? [m[1], m[2]] : [n, ''];
  }

  // Изменение за 24ч: по собранной истории, а пока её нет — по средним ценам продаж Skinport.
  const change24 = (it) => (it.c24 != null ? it.c24 : pct(it.a24, it.a7));

  // ---------- Ликвидность ----------
  // Оценка 0–100 относительно остальных отслеживаемых скинов:
  // 65% — сколько штук продаётся в день, 35% — какая доля выставленных лотов уходит за день.
  const perDay = (it) => (it.v7 != null ? it.v7 / 7 : it.v30 != null ? it.v30 / 30 : it.v24 ?? null);
  function turnover(it) {
    const r = perDay(it);
    if (r == null || it.q == null) return null;
    return it.q > 0 ? r / it.q : r > 0 ? Infinity : 0;
  }
  // Доля значений строго меньше x плюс половина равных: 0…1.
  function rankFn(values) {
    const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
    const lower = (x) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return lo; };
    const upper = (x) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; } return lo; };
    return (x) => (x == null || !sorted.length ? null : (lower(x) + upper(x)) / 2 / sorted.length);
  }
  function computeLiquidity(items) {
    const rVol = rankFn(items.map(perDay));
    const rTurn = rankFn(items.map(turnover));
    for (const it of items) {
      const a = rVol(perDay(it));
      const b = rTurn(turnover(it));
      it.liq = a == null ? null : Math.round(100 * (b == null ? a : 0.65 * a + 0.35 * b));
    }
  }
  const liqLevel = (v) => (v == null ? 0 : v >= 67 ? 3 : v >= 34 ? 2 : 1);
  const liqName = ['нет данных', 'низкая', 'средняя', 'высокая'];
  const liqBars = (v) => `<i class="liq l${liqLevel(v)}" title="Ликвидность: ${v == null ? 'нет данных' : v + ' из 100'}"><b></b><b></b><b></b></i>`;

  // ---------- Список рынка ----------
  const SORTS = {
    value: { key: (it) => (it.v30 != null && it.p != null ? it.v30 * it.p : null), desc: 'Сначала больший оборот', asc: 'Сначала меньший оборот' },
    price: { key: (it) => it.p, desc: 'Сначала дорогие', asc: 'Сначала дешёвые' },
    liq: { key: (it) => it.liq, desc: 'Сначала ликвидные', asc: 'Сначала неликвидные' },
    volume: { key: (it) => perDay(it), desc: 'Сначала больше продаж', asc: 'Сначала меньше продаж' },
    change: { key: (it) => change24(it), desc: 'Сначала растущие', asc: 'Сначала падающие' },
  };
  const sortState = { by: 'value', dir: 'desc' };
  try {
    const saved = JSON.parse(localStorage.getItem('cs2trade.sort') || 'null');
    if (saved && SORTS[saved.by] && (saved.dir === 'asc' || saved.dir === 'desc')) Object.assign(sortState, saved);
  } catch { /* хранилище недоступно — используем сортировку по умолчанию */ }

  function setSort(by, dir) {
    sortState.by = by;
    sortState.dir = dir;
    try { localStorage.setItem('cs2trade.sort', JSON.stringify(sortState)); } catch { /* не страшно */ }
    renderList();
  }

  function renderSortControls() {
    const { by, dir } = sortState;
    $('sort').value = by;
    const d = $('dir');
    d.textContent = dir === 'desc' ? '↓' : '↑';
    d.title = SORTS[by][dir] + ' (нажмите, чтобы развернуть)';
    for (const b of document.querySelectorAll('.market-head [data-sort]')) {
      const on = b.dataset.sort === by;
      b.classList.toggle('on', on);
      b.dataset.arrow = on ? (dir === 'desc' ? '↓' : '↑') : '';
    }
  }

  function renderList() {
    renderSortControls();
    const q = $('search').value.trim().toLowerCase();
    const key = SORTS[sortState.by].key;
    const sign = sortState.dir === 'desc' ? -1 : 1;
    // Скины без значения всегда в конце списка, в каком бы направлении ни сортировали.
    const rows = state.index
      .filter((it) => !q || it.n.toLowerCase().includes(q))
      .map((it) => ({ it, k: key(it) }))
      .sort((a, b) => (a.k == null) - (b.k == null) || (a.k == null ? 0 : sign * (a.k - b.k)))
      .map((r) => r.it);
    $('list').innerHTML = rows.map((it) => {
      const [main, sub] = splitName(it.n);
      const c = change24(it);
      return `<li data-id="${it.id}" class="${it.id === state.id ? 'sel' : ''}">
        <span class="nm" title="${esc(it.n)}">${esc(main)}<small>${liqBars(it.liq)}${sub ? esc(sub) : ''}</small></span>
        <span>${fmtMoney(it.p)}</span>
        <span class="${cls(c)}">${fmtPct(c)}</span>
      </li>`;
    }).join('') || '<li class="muted" style="display:block">Ничего не найдено</li>';
  }

  $('list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) location.hash = li.dataset.id;
  });
  $('search').addEventListener('input', renderList);
  $('sort').addEventListener('change', (e) => setSort(e.target.value, 'desc'));
  $('dir').addEventListener('click', () => setSort(sortState.by, sortState.dir === 'desc' ? 'asc' : 'desc'));
  document.querySelector('.market-head').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    const by = b.dataset.sort;
    setSort(by, by === sortState.by && sortState.dir === 'desc' ? 'asc' : 'desc');
  });

  // ---------- График ----------
  const chart = LightweightCharts.createChart($('chart'), {
    autoSize: true,
    layout: { background: { color: '#151a21' }, textColor: '#8a939f', fontSize: 12 },
    grid: { vertLines: { color: '#1e252e' }, horzLines: { color: '#1e252e' } },
    rightPriceScale: { borderColor: '#262e39' },
    timeScale: { borderColor: '#262e39', timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { locale: 'ru-RU', priceFormatter: (p) => '$' + p.toFixed(2) },
  });
  const candles = chart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  });
  const volume = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const qty = chart.addLineSeries({
    color: '#f0b90b', lineWidth: 1, priceScaleId: 'qty', visible: false,
    priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
  });
  chart.priceScale('qty').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.3 }, visible: false });

  // Свечи хранятся как [t, o, h, l, c, объём за 24ч, лоты].
  function aggregate(list, size, sumVolume) {
    const out = [];
    for (const c of list) {
      const b = size === 'week' ? weekStart(c[0]) : Math.floor(c[0] / size) * size;
      const last = out[out.length - 1];
      if (last && last[0] === b) {
        last[2] = Math.max(last[2], c[2]);
        last[3] = Math.min(last[3], c[3]);
        last[4] = c[4];
        last[5] = sumVolume ? (last[5] || 0) + (c[5] || 0) : c[5];
        last[6] = c[6];
      } else {
        out.push([b, c[1], c[2], c[3], c[4], c[5], c[6]]);
      }
    }
    return out;
  }
  const weekStart = (t) => { const d = Math.floor(t / DAY); return (d - ((d + 3) % 7)) * DAY; }; // понедельник

  function seriesFor(item, source, tf) {
    const s = item[source] || {};
    if (tf === '1h') return s.h || [];
    if (tf === '4h') return aggregate(s.h || [], 4 * HOUR, false);
    if (tf === '1d') return s.d || [];
    return aggregate(s.d || [], 'week', true);
  }

  function drawChart() {
    const item = state.item;
    if (!item) return;
    const data = seriesFor(item, state.source, state.tf);
    candles.setData(data.map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] })));
    volume.setData(data.filter((c) => c[5] != null).map((c) => ({
      time: c[0], value: c[5], color: c[4] >= c[1] ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)',
    })));
    qty.setData(data.filter((c) => c[6] != null).map((c) => ({ time: c[0], value: c[6] })));
    qty.applyOptions({ visible: state.showQty && state.source === 'sp' });
    chart.timeScale().fitContent();

    const empty = $('empty');
    const srcName = state.source === 'sp' ? 'Skinport' : 'Steam';
    if (data.length < 3) {
      empty.hidden = false;
      empty.textContent = data.length === 0
        ? `По ${srcName} для этого скина данных пока нет.` + (state.source === 'st' ? ' В Steam опрашиваются только самые ходовые позиции.' : '')
        : `История по ${srcName} только начала собираться: новая свеча появляется с каждым обновлением. Переключите таймфрейм на 1ч, чтобы видеть больше свечей в первые дни.`;
    } else {
      empty.hidden = true;
    }
    setLegend(data[data.length - 1]);
  }

  function setLegend(c) {
    if (!c) { $('legend').innerHTML = ''; return; }
    const ch = pct(c[4], c[1]);
    $('legend').innerHTML =
      `O <b>${fmtMoney(c[1])}</b> H <b>${fmtMoney(c[2])}</b> L <b>${fmtMoney(c[3])}</b> C <b class="${cls(ch)}">${fmtMoney(c[4])}</b>` +
      ` · Продаж за 24ч <b>${fmtInt(c[5])}</b>` + (c[6] != null ? ` · Лотов <b>${fmtInt(c[6])}</b>` : '');
  }

  chart.subscribeCrosshairMove((p) => {
    if (!state.item) return;
    const data = seriesFor(state.item, state.source, state.tf);
    const c = p.time != null ? data.find((x) => x[0] === p.time) : null;
    setLegend(c || data[data.length - 1]);
  });

  function bindSeg(id, key) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state[key] = b.dataset.v;
      for (const x of $(id).children) x.classList.toggle('on', x === b);
      drawChart();
    });
  }
  bindSeg('source', 'source');
  bindSeg('tf', 'tf');
  $('showQty').addEventListener('change', (e) => { state.showQty = e.target.checked; drawChart(); });

  // ---------- Карточка скина ----------
  function renderHead(meta, item) {
    $('name').textContent = item.n;
    document.title = `${item.n} — CS2 Trade`;
    const steamUrl = 'https://steamcommunity.com/market/listings/730/' + encodeURIComponent(item.n);
    $('links').innerHTML =
      (item.spUrl ? `<a href="${esc(item.spUrl)}" target="_blank" rel="noopener">Skinport ↗</a>` : '') +
      `<a href="${steamUrl}" target="_blank" rel="noopener">Steam Market ↗</a>`;
    $('price').textContent = fmtMoney(meta.p);
    const c = change24(meta);
    $('change').innerHTML = `<span class="${cls(c)}">${fmtPct(c)}</span> <span class="muted">за 24ч</span>` +
      (meta.c7 != null ? ` · <span class="${cls(meta.c7)}">${fmtPct(meta.c7)}</span> <span class="muted">за 7д</span>` : '');

    const s = item.sales || {};
    const block = (title, p) => `<div class="stat"><h3>${title}</h3>
      <div class="big">${fmtInt(p?.volume)} <span class="muted" style="font-size:12px;font-weight:400">продаж</span></div>
      <div class="row"><span>Средняя</span><span>${fmtMoney(p?.avg)}</span></div>
      <div class="row"><span>Мин / Макс</span><span>${fmtMoney(p?.min)} / ${fmtMoney(p?.max)}</span></div>
    </div>`;
    $('stats').innerHTML =
      block('Skinport · 24 часа', s.d1) + block('Skinport · 7 дней', s.d7) +
      block('Skinport · 30 дней', s.d30) + block('Skinport · 90 дней', s.d90) +
      `<div class="stat"><h3>Ликвидность</h3>
        <div class="big">${meta.liq == null ? '—' : meta.liq} <span class="muted" style="font-size:12px;font-weight:400">из 100 · ${liqName[liqLevel(meta.liq)]}</span></div>
        <div class="row"><span>Продаж в день</span><span>${perDay(meta) == null ? '—' : perDay(meta).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}</span></div>
        <div class="row"><span>Лотов на Skinport</span><span>${fmtInt(meta.q)}</span></div></div>` +
      `<div class="stat"><h3>Цена в Steam</h3><div class="big">${fmtMoney(meta.sp)}</div>
        <div class="row"><span>Разница со Skinport</span><span>${meta.sp && meta.p ? fmtPct(pct(meta.sp, meta.p)) : '—'}</span></div></div>`;
  }

  async function openItem(id) {
    const meta = state.index.find((x) => x.id === id) || state.index[0];
    if (!meta) return;
    state.id = meta.id;
    for (const li of $('list').querySelectorAll('li')) li.classList.toggle('sel', li.dataset.id === meta.id);
    const res = await fetch(`data/items/${meta.id}.json`, { cache: 'no-cache' });
    if (!res.ok) return;
    const item = await res.json();
    if (state.id !== meta.id) return; // пользователь уже выбрал другой скин
    state.item = item;
    renderHead(meta, item);
    drawChart();
  }

  window.addEventListener('hashchange', () => openItem(location.hash.slice(1)));

  async function init() {
    try {
      const res = await fetch('data/index.json', { cache: 'no-cache' });
      const idx = await res.json();
      state.index = idx.items;
      computeLiquidity(state.index);
      const d = new Date(idx.updated * 1000);
      $('updated').textContent = `Обновлено ${d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })} · ${idx.items.length} скинов`;
      renderList();
      openItem(location.hash.slice(1));
    } catch (e) {
      $('updated').textContent = 'Данные ещё не собраны: дождитесь первого запуска сборщика.';
      console.error(e);
    }
  }
  init();
})();
