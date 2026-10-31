(() => {
  'use strict';

  const HOUR = 3600;
  const DAY = 86400;
  const $ = (id) => document.getElementById(id);

  const state = { index: [], item: null, id: null };

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
  const LC = LightweightCharts;
  const COLORS = {
    up: '#26a69a', down: '#ef5350', qty: '#f0b90b', ma7: '#ba68c8', ma25: '#ff9800', cmp: '#66c0f4',
    upVol: 'rgba(38,166,154,.45)', downVol: 'rgba(239,83,80,.45)',
  };
  const SRC_NAME = { ag: 'Рынок', sp: 'Skinport', mc: 'market.csgo.com', wp: 'Waxpeer', ls: 'Lis-Skins', st: 'Steam' };
  const SOURCES = Object.keys(SRC_NAME);

  // Настройки графика запоминаются в браузере.
  const cs = { source: 'ag', tf: '4h', range: 'all', type: 'candle', vol: true, qty: false, ma7: false, ma25: false, cmp: '' };
  const CS_KEY = 'cs2trade.chart';
  try {
    const saved = JSON.parse(localStorage.getItem(CS_KEY) || 'null');
    if (saved && typeof saved === 'object') for (const k of Object.keys(cs)) if (typeof saved[k] === typeof cs[k]) cs[k] = saved[k];
    if (!SRC_NAME[cs.source]) cs.source = 'ag';
    if (cs.cmp && !SRC_NAME[cs.cmp]) cs.cmp = '';
  } catch { /* хранилище недоступно — настройки по умолчанию */ }
  const saveCs = () => { try { localStorage.setItem(CS_KEY, JSON.stringify(cs)); } catch { /* не страшно */ } };

  let rangeSetAt = 0; // когда программа последний раз сама меняла видимую область
  const daily = () => cs.tf === '1d' || cs.tf === '1w';
  // Часовые свечи показываем по местному времени, дневные и недельные — датой (они отсчитываются по UTC).
  function fmtTime(t, long) {
    const d = new Date(t * 1000);
    if (daily()) {
      return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: long ? 'numeric' : undefined, timeZone: 'UTC' }) +
        (long && cs.tf === '1w' ? ' (неделя)' : '');
    }
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function tickMark(t, type) {
    const d = new Date(t * 1000);
    const tz = daily() ? 'UTC' : undefined;
    if (type === LC.TickMarkType.Year) return String(d.toLocaleDateString('ru-RU', { year: 'numeric', timeZone: tz })).replace(/\s*г\.?$/, '');
    if (type === LC.TickMarkType.Month) return d.toLocaleDateString('ru-RU', { month: 'short', timeZone: tz }).replace('.', '');
    if (type === LC.TickMarkType.DayOfMonth) return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: tz }).replace('.', '');
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  const chart = LC.createChart($('chart'), {
    autoSize: true,
    layout: { background: { color: '#151a21' }, textColor: '#8a939f', fontSize: 12 },
    grid: { vertLines: { color: '#1e252e' }, horzLines: { color: '#1e252e' } },
    rightPriceScale: { borderColor: '#262e39' },
    timeScale: { borderColor: '#262e39', timeVisible: true, secondsVisible: false, rightOffset: 4, tickMarkFormatter: tickMark },
    crosshair: { mode: LC.CrosshairMode.Normal },
    // Под ценами — место для столбиков продаж: отрицательные отметки шкалы там не нужны.
    localization: { locale: 'ru-RU', priceFormatter: (p) => (p < 0 ? '' : fmtMoney(p)), timeFormatter: (t) => fmtTime(t, true) },
    watermark: { visible: true, color: 'rgba(138,147,159,.07)', fontSize: 28, horzAlign: 'center', vertAlign: 'center', text: '' },
  });
  chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });

  const noLabels = { lastValueVisible: false, priceLineVisible: false };
  const main = {
    candle: chart.addCandlestickSeries({
      upColor: COLORS.up, downColor: COLORS.down, borderVisible: false, wickUpColor: COLORS.up, wickDownColor: COLORS.down,
    }),
    line: chart.addLineSeries({ color: COLORS.up, lineWidth: 2, crosshairMarkerRadius: 4 }),
    area: chart.addAreaSeries({
      lineColor: COLORS.up, topColor: 'rgba(38,166,154,.35)', bottomColor: 'rgba(38,166,154,.02)', lineWidth: 2,
    }),
  };
  const volume = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', ...noLabels });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const qty = chart.addLineSeries({ color: COLORS.qty, lineWidth: 1, priceScaleId: 'qty', priceFormat: { type: 'volume' }, ...noLabels });
  chart.priceScale('qty').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.3 }, visible: false });
  const ma7 = chart.addLineSeries({ color: COLORS.ma7, lineWidth: 1, crosshairMarkerVisible: false, ...noLabels });
  const ma25 = chart.addLineSeries({ color: COLORS.ma25, lineWidth: 1, crosshairMarkerVisible: false, ...noLabels });
  const cmp = chart.addLineSeries({ color: COLORS.cmp, lineWidth: 2, lineStyle: LC.LineStyle.Dashed, crosshairMarkerRadius: 3 });

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
    const s = item?.[source] || {};
    if (tf === '15m') return s.m || [];
    if (tf === '30m') return aggregate(s.m || [], 30 * 60, false);
    if (tf === '1h') return s.h || [];
    if (tf === '4h') return aggregate(s.h || [], 4 * HOUR, false);
    if (tf === '1d') return s.d || [];
    return aggregate(s.d || [], 'week', true);
  }

  // Скользящая средняя цены закрытия за n свечей.
  function sma(data, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i][4];
      if (i >= n) sum -= data[i - n][4];
      if (i >= n - 1) out.push({ time: data[i][0], value: Math.round((sum / n) * 100) / 100 });
    }
    return out;
  }

  // Что сейчас нарисовано: нужно легенде, статистике периода и снимку.
  const view = { data: [], byTime: new Map(), cmpByTime: new Map(), ma7: new Map(), ma25: new Map() };
  const toMap = (arr) => new Map(arr.map((p) => [p.time, p.value]));

  function drawChart(keepRange) {
    const item = state.item;
    if (!item) return;
    rangeSetAt = Date.now(); // перерисовка сама двигает шкалу — это не ручная прокрутка
    const data = seriesFor(item, cs.source, cs.tf);
    view.data = data;
    view.byTime = new Map(data.map((c) => [c[0], c]));

    const ohlc = data.map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] }));
    const closes = data.map((c) => ({ time: c[0], value: c[4] }));
    main.candle.setData(cs.type === 'candle' ? ohlc : []);
    main.line.setData(cs.type === 'line' ? closes : []);
    main.area.setData(cs.type === 'area' ? closes : []);
    // Цвет линии — по изменению за весь показанный период.
    const rising = data.length < 2 || data[data.length - 1][4] >= data[0][1];
    const col = rising ? COLORS.up : COLORS.down;
    main.line.applyOptions({ color: col });
    main.area.applyOptions({ lineColor: col, topColor: rising ? 'rgba(38,166,154,.35)' : 'rgba(239,83,80,.35)', bottomColor: 'rgba(21,26,33,0)' });

    volume.setData(cs.vol ? data.filter((c) => c[5] != null).map((c) => ({
      time: c[0], value: c[5], color: c[4] >= c[1] ? COLORS.upVol : COLORS.downVol,
    })) : []);
    const showQty = cs.qty && cs.source !== 'st';
    qty.setData(showQty ? data.filter((c) => c[6] != null).map((c) => ({ time: c[0], value: c[6] })) : []);
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: cs.vol ? 0.25 : 0.06 } });

    const m7 = cs.ma7 ? sma(data, 7) : [];
    const m25 = cs.ma25 ? sma(data, 25) : [];
    ma7.setData(m7);
    ma25.setData(m25);
    view.ma7 = toMap(m7);
    view.ma25 = toMap(m25);

    const cmpOn = cs.cmp && cs.cmp !== cs.source;
    const cmpData = cmpOn ? seriesFor(item, cs.cmp, cs.tf).map((c) => ({ time: c[0], value: c[4] })) : [];
    cmp.setData(cmpData);
    cmp.applyOptions({ title: cmpOn ? SRC_NAME[cs.cmp] : '' });
    view.cmpByTime = toMap(cmpData);

    chart.applyOptions({ watermark: { text: splitName(item.n)[0] } });
    if (!keepRange) applyRange();

    const empty = $('empty');
    const srcName = SRC_NAME[cs.source];
    if (data.length < 3) {
      empty.hidden = false;
      const src = cs.source === 'ag' ? 'рыночной цене' : srcName;
      empty.textContent = data.length === 0
        ? `По ${src} для этого скина данных пока нет.` +
          (cs.source === 'st' ? ' В Steam опрашиваются только самые ходовые позиции.' : cs.source !== 'ag' ? ' Возможно, скин сейчас не продаётся на этой площадке.' : '')
        : `История по ${src} только начала собираться: данные обновляются каждые 15 минут. Выберите свечу 15м или 30м, чтобы видеть больше свечей в первые дни.`;
    } else {
      empty.hidden = true;
    }
    setLegend(null);
    updatePeriod();
  }

  // ---------- Период ----------
  const RANGE_SPAN = { '1d': DAY, '1w': 7 * DAY, '1m': 30 * DAY, '3m': 91 * DAY };
  // Свеча, которая подходит к периоду: около 20–200 свечей на экране.
  const RANGE_TF = { '1d': '15m', '1w': '1h', '1m': '4h', '3m': '1d' };

  function applyRange() {
    rangeSetAt = Date.now();
    const data = view.data;
    const span = RANGE_SPAN[cs.range];
    if (!span || data.length < 2 || data[data.length - 1][0] - data[0][0] <= span) {
      chart.timeScale().fitContent();
    } else {
      const to = data[data.length - 1][0];
      chart.timeScale().setVisibleRange({ from: to - span, to });
    }
  }

  // Ручная прокрутка или масштаб снимают выбор периода.
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    if (Date.now() - rangeSetAt > 400 && cs.range) {
      cs.range = '';
      syncControls();
      saveCs();
    }
    updatePeriod();
  });

  function visibleBars() {
    const r = chart.timeScale().getVisibleLogicalRange();
    const d = view.data;
    if (!r || !d.length) return d;
    return d.slice(Math.max(0, Math.ceil(r.from)), Math.min(d.length, Math.floor(r.to) + 1));
  }

  function updatePeriod() {
    const bars = visibleBars();
    const el = $('period');
    if (bars.length < 2) { el.innerHTML = ''; return; }
    const first = bars[0];
    const last = bars[bars.length - 1];
    const ch = pct(last[4], first[1]);
    let hi = bars[0], lo = bars[0];
    for (const b of bars) { if (b[2] > hi[2]) hi = b; if (b[3] < lo[3]) lo = b; }
    const vols = bars.map((b) => b[5]).filter((v) => v != null);
    const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
    const volLabel = cs.tf === '1w' ? 'Продаж в неделю, в среднем' : 'Продаж за сутки, в среднем';
    el.innerHTML =
      `<span class="muted">${fmtTime(first[0])} — ${fmtTime(last[0])}</span>` +
      `<span>Изменение <b class="${cls(ch)}">${fmtPct(ch)}</b></span>` +
      `<span>Макс <b>${fmtMoney(hi[2])}</b> <small class="muted">${fmtTime(hi[0])}</small></span>` +
      `<span>Мин <b>${fmtMoney(lo[3])}</b> <small class="muted">${fmtTime(lo[0])}</small></span>` +
      (avgVol != null ? `<span>${volLabel} <b>${fmtInt(Math.round(avgVol))}</b></span>` : '');
  }

  // ---------- Легенда ----------
  function setLegend(time) {
    const d = view.data;
    const c = (time != null && view.byTime.get(time)) || d[d.length - 1];
    if (!c) { $('legend').innerHTML = ''; return; }
    const ch = pct(c[4], c[1]);
    const val = (label, v, color) => (v == null ? '' : ` <span class="lg"><i style="background:${color}"></i>${label} <b>${fmtMoney(v)}</b></span>`);
    const otherPrice = cs.cmp && cs.cmp !== cs.source ? view.cmpByTime.get(c[0]) : null;
    const volLabel = cs.tf === '1w' ? 'Продаж за неделю' : 'Продаж за 24ч';
    $('legend').innerHTML =
      `<div><span class="muted">${fmtTime(c[0], true)}</span> ` +
      (cs.type === 'candle'
        ? `О <b>${fmtMoney(c[1])}</b> М <b>${fmtMoney(c[2])}</b> Н <b>${fmtMoney(c[3])}</b> З <b class="${cls(ch)}">${fmtMoney(c[4])}</b>`
        : `Цена <b class="${cls(ch)}">${fmtMoney(c[4])}</b>`) +
      ` <b class="${cls(ch)}">${fmtPct(ch)}</b></div>` +
      (c[5] != null ? `<div>${volLabel} <b>${fmtInt(c[5])}</b> · ` : '<div>') + (c[6] != null ? `Лотов <b>${fmtInt(c[6])}</b>` : '') +
      val('MA 7', view.ma7.get(c[0]), COLORS.ma7) + val('MA 25', view.ma25.get(c[0]), COLORS.ma25) +
      (otherPrice != null
        ? val(SRC_NAME[cs.cmp], otherPrice, COLORS.cmp) + ` <span class="muted">(${fmtPct(pct(otherPrice, c[4]))})</span>`
        : '') +
      `</div>`;
  }
  chart.subscribeCrosshairMove((p) => setLegend(p.time ?? null));

  // ---------- Управление ----------
  function syncControls() {
    for (const [id, key] of [['tf', 'tf'], ['range', 'range'], ['ctype', 'type']]) {
      for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === cs[key]);
    }
    $('source').value = cs.source;
    for (const b of $('layers').querySelectorAll('button[data-k]')) {
      const k = b.dataset.k;
      b.classList.toggle('on', !!cs[k]);
      b.setAttribute('aria-pressed', String(!!cs[k]));
      if (k === 'qty') b.disabled = cs.source === 'st';
    }
    const sel = $('cmp');
    sel.innerHTML = '<option value="">Сравнить…</option>' +
      SOURCES.filter((k) => k !== cs.source).map((k) => `<option value="${k}">${SRC_NAME[k]}</option>`).join('');
    sel.value = cs.cmp && cs.cmp !== cs.source ? cs.cmp : '';
    sel.parentElement.classList.toggle('on', !!sel.value);
    const qb = $('layers').querySelector('[data-k=qty]');
    qb.title = cs.source === 'st' ? 'Steam не сообщает число лотов' :
      cs.source === 'ag' ? 'Сколько лотов выставлено на всех площадках вместе' : 'Сколько лотов выставлено на продажу';
  }

  function onSeg(id, fn) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      fn(b.dataset.v);
      syncControls();
      saveCs();
    });
  }
  $('source').addEventListener('change', (e) => { cs.source = e.target.value; drawChart(); syncControls(); saveCs(); });
  $('cmp').addEventListener('change', (e) => { cs.cmp = e.target.value; drawChart(true); syncControls(); saveCs(); });
  onSeg('tf', (v) => { cs.tf = v; drawChart(); });
  onSeg('ctype', (v) => { cs.type = v; drawChart(true); });
  onSeg('range', (v) => {
    cs.range = v;
    if (RANGE_TF[v] && RANGE_TF[v] !== cs.tf) { cs.tf = RANGE_TF[v]; drawChart(); } else applyRange();
  });
  $('layers').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b || b.disabled) return;
    cs[b.dataset.k] = !cs[b.dataset.k];
    drawChart(true);
    syncControls();
    saveCs();
  });

  const showAll = () => { cs.range = 'all'; applyRange(); syncControls(); saveCs(); };
  $('fit').addEventListener('click', showAll);
  $('chart').addEventListener('dblclick', showAll);

  $('full').addEventListener('click', () => {
    const area = $('chartArea');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (area.requestFullscreen) area.requestFullscreen().catch(() => area.classList.toggle('pseudo-full'));
    else area.classList.toggle('pseudo-full'); // iPhone: полноэкранный режим только для видео
  });
  document.addEventListener('fullscreenchange', () => {
    $('full').classList.toggle('on', !!document.fullscreenElement);
    setTimeout(applyRange, 50); // после смены размера заново показываем выбранный период
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('chartArea').classList.remove('pseudo-full');
  });

  // Снимок: график с подписью (скин, площадка, свеча, дата) — удобно отправить в чат.
  $('shot').addEventListener('click', () => {
    if (!state.item) return;
    const shot = chart.takeScreenshot();
    const pad = 44;
    const cv = document.createElement('canvas');
    cv.width = shot.width;
    cv.height = shot.height + pad;
    const g = cv.getContext('2d');
    g.fillStyle = '#151a21';
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(shot, 0, pad);
    const scale = shot.width / $('chart').clientWidth;
    const tfName = { '15m': '15 минут', '30m': '30 минут', '1h': '1 час', '4h': '4 часа', '1d': '1 день', '1w': '1 неделя' }[cs.tf];
    g.font = `600 ${15 * scale}px Inter, system-ui, sans-serif`;
    g.fillStyle = '#e6e8ea';
    g.fillText(state.item.n, 12 * scale, 20 * scale);
    g.font = `${12 * scale}px Inter, system-ui, sans-serif`;
    g.fillStyle = '#8a939f';
    g.fillText(`${SRC_NAME[cs.source]} · свеча ${tfName} · ${new Date().toLocaleString('ru-RU')} · CS2 Trade`, 12 * scale, 36 * scale);
    cv.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.item.n.replace(/[\\/:*?"<>|★™]+/g, ' ').replace(/\s+/g, ' ').trim()} ${cs.tf}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  });

  syncControls();

  // ---------- Карточка скина ----------
  const MARKET_LINK = {
    sp: (n, now) => now?.url || null,
    mc: (n) => `https://market.csgo.com/en/?search=${encodeURIComponent(n)}`,
    wp: (n) => `https://waxpeer.com/?game=csgo&search=${encodeURIComponent(n)}`,
    ls: (n, now) => now?.url || null,
    st: (n) => 'https://steamcommunity.com/market/listings/730/' + encodeURIComponent(n),
  };
  const safeUrl = (u) => (/^https:\/\//.test(u || '') ? u : null);

  // Таблица «Цены на площадках»: самое дешёвое предложение на каждой и разница с рыночной ценой.
  function renderMarkets(meta, item) {
    const now = item.now || {};
    const fresh = Math.floor(Date.now() / 1000) - 2 * HOUR;
    const rows = ['sp', 'mc', 'wp', 'ls', 'st'].map((k) => ({ k, x: now[k] })).filter((r) => r.x?.p);
    if (!rows.length) { $('markets').innerHTML = ''; return; }
    rows.sort((a, b) => (a.k === 'st') - (b.k === 'st') || a.x.p - b.x.p);
    const bestK = rows.find((r) => r.k !== 'st' && r.x.t >= fresh)?.k;
    $('markets').innerHTML = `<h2>Цены на площадках</h2>
      <table>
        <thead><tr><th>Площадка</th><th title="Самое дешёвое предложение">Мин. цена</th><th title="Разница с рыночной ценой">К рынку</th><th>Лотов</th></tr></thead>
        <tbody>${rows.map(({ k, x }) => {
          const url = safeUrl(MARKET_LINK[k](item.n, x));
          const d = meta.p ? pct(x.p, meta.p) : null;
          const old = x.t < fresh;
          const title = k === 'mc' || k === 'wp' ? 'Найти скин на площадке' : 'Открыть скин на площадке';
          const nameHtml = url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="${title}">${SRC_NAME[k]} ↗</a>` : SRC_NAME[k];
          return `<tr class="${k === bestK ? 'best' : ''}${old ? ' old' : ''}">
            <td>${nameHtml}${k === bestK ? ' <span class="tag">дешевле всех</span>' : ''}${k === 'st' ? ' <span class="muted" title="Steam не входит в рыночную цену: там цены выше из-за комиссии, а деньги нельзя вывести">*</span>' : ''}</td>
            <td><b>${fmtMoney(x.p)}</b>${old ? ` <span class="muted" title="Цена не обновлялась больше 2 часов">· устарела</span>` : ''}</td>
            <td class="${d != null && d < 0 ? 'up' : 'muted'}">${fmtPct(d)}</td>
            <td>${k === 'st' ? `<span class="muted" title="Продаж в Steam за 24 часа">${fmtInt(x.v)} прод.</span>` : fmtInt(x.q)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }

  function renderHead(meta, item) {
    $('name').textContent = item.n;
    document.title = `${item.n} — CS2 Trade`;
    const steamUrl = 'https://steamcommunity.com/market/listings/730/' + encodeURIComponent(item.n);
    $('links').innerHTML =
      (item.spUrl ? `<a href="${esc(item.spUrl)}" target="_blank" rel="noopener">Skinport ↗</a>` : '') +
      `<a href="${steamUrl}" target="_blank" rel="noopener">Steam Market ↗</a>`;
    $('price').textContent = fmtMoney(meta.p);
    $('price').title = 'Рыночная цена: медиана самых дешёвых предложений на Skinport, market.csgo.com, Waxpeer и Lis-Skins';
    const c = change24(meta);
    $('change').innerHTML =
      (meta.best ? `<div class="best-line">Дешевле всего: <b>${fmtMoney(meta.best.p)}</b> на ${SRC_NAME[meta.best.m]}</div>` : '') +
      `<span class="${cls(c)}">${fmtPct(c)}</span> <span class="muted">за 24ч</span>` +
      (meta.c7 != null ? ` · <span class="${cls(meta.c7)}">${fmtPct(meta.c7)}</span> <span class="muted">за 7д</span>` : '');
    renderMarkets(meta, item);

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
      `<div class="stat"><h3>Лотов на всех площадках</h3><div class="big">${fmtInt(meta.qa)}</div>
        <div class="row"><span>Steam, продаж за 24ч</span><span>${fmtInt(item.now?.st?.v)}</span></div></div>`;
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
