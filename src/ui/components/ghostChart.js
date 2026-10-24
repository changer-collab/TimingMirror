// 幽灵线双面板（S1 单笔卖出替换；T2-1/M1-C9） 纯 SVG 渲染组件：无第三方图表库、无 canvas。
const NS = 'http://www.w3.org/2000/svg';
const W = 1000;          // 两面板共用 viewBox 宽度 → 日期 x 轴严格对齐
const H1 = 250;          // 上：资产路径
const H2 = 190;          // 下：收盘价与买卖点
const PAD = { l: 76, r: 20, t: 16, b: 34 };

function svgEl(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    n.append(c);
  }
  return n;
}
function svgText(x, y, str, cls, attrs = {}) {
  const n = svgEl('text', { x, y, class: cls, ...attrs });
  n.append(document.createTextNode(String(str)));
  return n;
}
function div(cls, children = []) {
  const n = document.createElement('div');
  n.setAttribute('class', cls);
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    n.append(c);
  }
  return n;
}
function textNode(str) { return document.createTextNode(String(str)); }

const xStep = (n) => (W - PAD.l - PAD.r) / Math.max(n - 1, 1);
const xPos = (i, n) => (n <= 1 ? PAD.l + (W - PAD.l - PAD.r) / 2 : PAD.l + xStep(n) * i);
const AXIS_FMT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const MONEY_FMT = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAxis = (v) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}万` : AXIS_FMT.format(v));
const fmtMoney = (v) => `¥${MONEY_FMT.format(v)}`;
const fmtPrice = (v) => MONEY_FMT.format(v);

function extent(values) {
  const v = values.filter(Number.isFinite);
  if (v.length === 0) return null;
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (lo === hi) { lo -= 1; hi += 1; } 
  return { lo, hi };
}
const yPos = (v, ext, H) => PAD.t + (1 - (v - ext.lo) / (ext.hi - ext.lo)) * (H - PAD.t - PAD.b);

function lineD(points, key, xs, ys) {
  let d = '';
  let run = [];
  const flush = () => {
    if (run.length) { d += 'M' + run.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L'); run = []; }
  };
  for (let i = 0; i < points.length; i++) {
    const v = points[i][key];
    if (Number.isFinite(v)) run.push([xs(i), ys(v)]);
    else flush();
  }
  flush();
  return d;
}

function isolatedPoints(points, key, xs, ys, cls) {
  const g = svgEl('g', { class: `${cls}-points` });
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i][key])) continue;
    const prev = points[i - 1]?.[key];
    const next = points[i + 1]?.[key];
    if (Number.isFinite(prev) || Number.isFinite(next)) continue;
    g.append(svgEl('circle', { cx: xs(i), cy: ys(points[i][key]), r: 3.5, class: `${cls} gc-isolated-point` }));
  }
  return g;
}

function isolatedLabels(points, xs, ys) {
  const g = svgEl('g', { class: 'gc-isolated-labels' });
  const keys = [
    ['actual', '实际'],
    ['ghost', '对照'],
    ['cf', '反事实'],
    ['benchmark', '沪深300'],
  ];
  for (let i = 0; i < points.length; i++) {
    const isolated = keys.filter(([key]) => Number.isFinite(points[i][key])
      && !Number.isFinite(points[i - 1]?.[key]) && !Number.isFinite(points[i + 1]?.[key]));
    const groups = new Map();
    for (const [key, label] of isolated) {
      const y = ys(points[i][key]);
      const group = groups.get(y) ?? { y, labels: [] };
      group.labels.push(label);
      groups.set(y, group);
    }
    for (const { y, labels } of groups.values()) {
      const textY = y < PAD.t + 22 ? y + 18 : y - 10;
      g.append(svgText(W - PAD.r - 8, textY, `断线后有效值（${labels.join('／')}）`, 'gc-isolated-label', { 'text-anchor': 'end' }));
    }
  }
  return g;
}

function isolatedCloseLabels(points, xs, ys) {
  const g = svgEl('g', { class: 'gc-isolated-labels' });
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i].close)
      || Number.isFinite(points[i - 1]?.close) || Number.isFinite(points[i + 1]?.close)) continue;
    const y = ys(points[i].close);
    const textY = y < PAD.t + 22 ? y + 18 : y - 10;
    g.append(svgText(W - PAD.r - 8, textY, `断线后收盘价有效（${points[i].date}）`, 'gc-isolated-label', { 'text-anchor': 'end' }));
  }
  return g;
}

function gapD(points, xs, yActual, yCf) {
  let d = '';
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const fwd = run.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L');
      const bwd = [...run].reverse().map((p) => `${p[0].toFixed(2)},${p[2].toFixed(2)}`).join('L');
      d += `M${fwd}L${bwd}Z`;
    }
    run = [];
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (Number.isFinite(p.actual) && Number.isFinite(p.cf)) run.push([xs(i), yActual(p.actual), yCf(p.cf)]);
    else flush();
  }
  flush();
  return d;
}

function frame(ext, H) {
  const g = svgEl('g');
  for (const f of [0.25, 0.5, 0.75]) {
    const y = PAD.t + f * (H - PAD.t - PAD.b);
    g.append(svgEl('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, class: 'gc-grid' }));
  }
  if (ext) {
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const y = PAD.t + f * (H - PAD.t - PAD.b);
      g.append(svgText(PAD.l - 8, y + 4, fmtAxis(ext.hi - f * (ext.hi - ext.lo)), 'gc-axis gc-axis-end'));
    }
  }
  return g;
}

function axisLabels(n) {
  if (n <= 1) return [0];
  const last = n - 1;
  return [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(last * f)))];
}

function axisLabelAttrs(i, n) {
  if (i === 0) return { 'text-anchor': 'start' };
  if (i === n - 1) return { 'text-anchor': 'end' };
  return { 'text-anchor': 'middle' };
}

export function renderGhostChart(root, cf) {
  const { series, markers } = cf;
  const compact = cf.compact === true;
  const merged = cf.merged === true;
  const points = series.points;
  const n = points.length;
  const xs = (i) => xPos(i, n);
  const hasBenchmark = points.some((p) => Number.isFinite(p.benchmark));
  const extA = extent(points.flatMap((p) => [p.actual, p.ghost, p.cf, hasBenchmark ? p.benchmark : null]));
  const extC = extent(points.map((p) => p.close));
  const yA = (v) => yPos(v, extA, H1);
  const yC = (v) => yPos(v, extC, H2);
  const xIdx = axisLabels(n);
  const dateIndex = new Map(points.map((p, i) => [p.date, i]));

  const wrap = div('gc-wrap');
  const tip = div('gc-tip');
  tip.setAttribute('style', 'display:none');

  if (!compact && !merged) {
    wrap.append(div('gc-reading-guide', [
      textNode('读图提示：上图比较你的实际结果、买入后持有，以及“这笔卖出没有发生”的假设结果；下图只显示每日收盘价和交易发生的时间点。'),
    ]));
  }

  //  上：资产路径 
  if (!merged) wrap.append(div('gc-panel-title', [textNode(compact ? '资产价值' : '资产价值变化：实际操作 / 买入后持有 / 假如这笔卖出没有发生；红色带表示两者差额')]));
  const svg1 = svgEl('svg', { viewBox: `0 0 ${W} ${H1}`, class: 'gc-svg', role: 'img' });
  svg1.append(frame(extA, H1));
  const gapPath = gapD(points, xs, yA, yA);
  if (gapPath) svg1.append(svgEl('path', { d: gapPath, class: 'gc-gap-area' }));
  const lines1 = [
    ['actual', 'gc-line gc-line-actual'],
    ['ghost', 'gc-line gc-line-ghost'],
    ['cf', 'gc-line gc-line-cf'],
  ];
  if (hasBenchmark) lines1.push(['benchmark', 'gc-line gc-line-benchmark']);
  for (const [key, cls] of lines1) {
    const d = lineD(points, key, xs, yA);
    if (d) svg1.append(svgEl('path', { d, class: cls, fill: 'none' }));
    svg1.append(isolatedPoints(points, key, xs, yA, cls));
  }
  svg1.append(isolatedLabels(points, xs, yA));
  if (merged) {
    let sellNo = 0;
    let lastSellX = -999;
    const ordered = [...markers].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    for (const m of ordered) {
      const i = dateIndex.get(m.trade_date);
      if (i === undefined) continue;
      const x = xs(i);
      const value = points[i].actual;
      const y = Number.isFinite(value) ? yA(value) : H1 - PAD.b;
      const buy = m.side === 'buy';
      svg1.append(svgEl('line', {
        x1: x, x2: x, y1: PAD.t + 10, y2: H1 - PAD.b,
        class: `gc-trade-line ${buy ? 'is-buy' : 'is-sell'}`,
      }));
      if (Number.isFinite(value)) {
        svg1.append(svgEl('circle', {
          cx: x, cy: y, r: buy ? 2.4 : 3.2,
          class: `gc-trade-dot ${buy ? 'is-buy' : 'is-sell'}`,
        }));
      }
      if (!buy) {
        sellNo += 1;
        const labelY = Math.abs(x - lastSellX) < 40 && sellNo % 2 === 0 ? PAD.t + 14 : 14;
        svg1.append(svgText(x, labelY, String(sellNo).padStart(2, '0'), 'gc-trade-label is-sell', { 'text-anchor': 'middle' }));
        lastSellX = x;
      }
    }
  }
  for (const i of xIdx) svg1.append(svgText(xs(i), H1 - 10, points[i].date, 'gc-axis', axisLabelAttrs(i, n)));
  const cross1 = svgEl('line', { class: 'gc-cross', y1: PAD.t, y2: H1 - PAD.b, style: 'display:none' });
  svg1.append(cross1);
  if (!merged) wrap.append(svg1);

  //  下：收盘价与买卖点 
  let cross2 = null;
  if (!merged) {
    wrap.append(div('gc-panel-title', [textNode(compact ? '收盘价与买卖点' : '每日收盘价与交易时间点：绿色为买入，红色为卖出，橙色圈为本次模拟的卖出笔')]));
    const svg2 = svgEl('svg', { viewBox: `0 0 ${W} ${H2}`, class: 'gc-svg', role: 'img' });
    svg2.append(frame(extC, H2));
    const closeD = lineD(points, 'close', xs, yC);
    if (closeD) svg2.append(svgEl('path', { d: closeD, class: 'gc-line gc-line-close', fill: 'none' }));
    svg2.append(isolatedPoints(points, 'close', xs, yC, 'gc-line-close'));
    svg2.append(isolatedCloseLabels(points, xs, yC));
    for (const m of markers) {
      const i = dateIndex.get(m.trade_date);
      if (i === undefined) continue;
      const x = xs(i);
      const known = Number.isFinite(points[i].close);
      const y = known ? yC(points[i].close) : H2 - PAD.b; // 缺价日标在底缘（价格未知，不猜测）
      if (!known) {
        svg2.append(svgText(x - 10, y - 24, `${m.trade_date}：交易日缺价`, 'gc-missing-marker-label', { 'text-anchor': 'end' }));
      }
      if (m.side === 'buy') {
        svg2.append(svgEl('path', { d: `M${x.toFixed(2)},${(y - 8).toFixed(2)}L${(x - 6).toFixed(2)},${(y + 5).toFixed(2)}L${(x + 6).toFixed(2)},${(y + 5).toFixed(2)}Z`, class: 'gc-marker gc-marker-buy' }));
      } else {
        svg2.append(svgEl('path', { d: `M${x.toFixed(2)},${(y + 8).toFixed(2)}L${(x - 6).toFixed(2)},${(y - 5).toFixed(2)}L${(x + 6).toFixed(2)},${(y - 5).toFixed(2)}Z`, class: 'gc-marker gc-marker-sell' }));
      }
      if (m.replaced) {
        svg2.append(svgEl('circle', { cx: x, cy: known ? y : y - 14, r: 12, class: 'gc-marker-ring' }));
      }
    }
    for (const i of xIdx) svg2.append(svgText(xs(i), H2 - 10, points[i].date, 'gc-axis', axisLabelAttrs(i, n)));
    cross2 = svgEl('line', { class: 'gc-cross', y1: PAD.t, y2: H2 - PAD.b, style: 'display:none' });
    svg2.append(cross2);
    wrap.append(svg2);
  }

  //  图例 
  const benchmarkLabel = series.benchmark?.name ? `${series.benchmark.name}（同额）` : '沪深300（同额）';
  const benchmarkLegend = hasBenchmark
    ? [div('gc-legend-item', [spanSw('gc-sw gc-sw-benchmark'), textNode(benchmarkLabel)])]
    : [];
  const legend = div('gc-legend', merged ? [
    div('gc-legend-item', [spanSw('gc-sw gc-sw-actual'), textNode('实际')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-ghost'), textNode('一直持有')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-cf'), textNode('假如没卖')]),
    ...benchmarkLegend,
    div('gc-legend-item', [spanSw('gc-sw gc-sw-gap'), textNode('差额')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-trade is-buy'), textNode('买入点')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-trade is-sell'), textNode('卖出点')]),
  ] : compact ? [
    div('gc-legend-item', [spanSw('gc-sw gc-sw-actual'), textNode('实际')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-ghost'), textNode('一直持有')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-cf'), textNode('假如没卖')]),
    ...benchmarkLegend,
    div('gc-legend-item', [spanSw('gc-sw gc-sw-gap'), textNode('差额')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-buy'), textNode('买')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-sell'), textNode('卖')]),
  ] : [
    div('gc-legend-item', [spanSw('gc-sw gc-sw-actual'), textNode('实际结果（你的操作）')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-ghost'), textNode('买入后持有')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-cf'), textNode('假如这笔卖出没发生')]),
    ...benchmarkLegend,
    div('gc-legend-item', [spanSw('gc-sw gc-sw-gap'), textNode('差额：正值＝不卖可挽回；负值＝这笔卖出反而更好')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-buy'), textNode('买入')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-sell'), textNode('卖出')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-replaced'), textNode('当前替换笔')]),
  ]);

  const missingNote = series.complete === false || series.missing_dates.length > 0
    ? div('banner warn-banner gc-missing', [
      textNode(`序列不完整：缺少价格数据，路径已断开（${series.missing_dates.join('、')}）缺价日不回退其他日期，相应日期不参与连线。`),
      textNode(' 底缘买卖标记表示该交易日缺价，不表示价格为零或跌到底部。'),
    ])
    : null;

  const marketCaption = cf.marketSource && cf.marketSource.dynamic
    ? 'Tushare 动态日线（最新已收盘，服务端获取，非实时，草案口径）'
    : (cf.marketSource?.demo ? '合成行情 · 仅用于演示' : '合成行情 · 非真实行情（m0 合成夹具，草案口径）');
  const benchmarkSource = series.benchmark?.source === 'tushare.index_daily'
    ? 'Tushare index_daily'
    : (series.benchmark?.source ?? '指数日线');
  const benchmarkCaption = hasBenchmark ? `；${benchmarkLabel}按同一买入本金折算（${benchmarkSource}）` : '';
  const caption = div(merged ? 'gc-caption scale-note' : 'gc-caption', [
    textNode(compact
      ? `${marketCaption}；只替换所选卖出，其余成交不变${benchmarkCaption}。`
      : `${marketCaption}：仅替换所选卖出笔，其余成交不变${benchmarkCaption}；不构成投资建议`),
  ]);

  if (merged) {
    const head = div('chart-head', [
      legend,
      div('chart-range', [textNode('DAILY / 本地收盘价 · 单位 元')]),
    ]);
    const stage = div('chart-stage', [svg1, tip]);
    const foot = div('chart-foot');
    const addFoot = (text) => {
      const item = document.createElement('span');
      item.textContent = text;
      foot.append(item);
    };
    const sells = [...markers]
      .filter((m) => m.side !== 'buy')
      .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    sells.forEach((m, i) => {
      addFoot(`${String(i + 1).padStart(2, '0')} 卖出 ${cf.symbol || ''} · ${m.trade_date}`);
    });
    if (points[n - 1]?.date) addFoot(`${points[n - 1].date} 估值日`);
    wrap.append(head, stage);
    if (missingNote) wrap.append(missingNote);
    wrap.append(foot, caption);
  } else {
    wrap.append(tip, legend);
    if (missingNote) wrap.append(missingNote);
    wrap.append(caption);
  }

  //  十字线：上下面板同步 
  const fmtValue = (v) => (Number.isFinite(v) ? fmtMoney(v) : '—（缺价）');
  const fmtClose = (v) => (Number.isFinite(v) ? fmtPrice(v) : '—（缺价）');
  function setIndex(i) {
    if (i === null || i === undefined || i < 0 || i >= n) {
      cross1.setAttribute('style', 'display:none');
      if (cross2) cross2.setAttribute('style', 'display:none');
      tip.setAttribute('style', 'display:none');
      return;
    }
    const x = xs(i);
    for (const c of [cross1, cross2]) {
      if (!c) continue;
      c.setAttribute('style', '');
      c.setAttribute('x1', String(x));
      c.setAttribute('x2', String(x));
    }
    const p = points[i];
    tip.replaceChildren(
      div('gc-tip-date', [textNode(p.date)]),
      div('gc-tip-row', [textNode(`实际 ${fmtValue(p.actual)}`)]),
      div('gc-tip-row', [textNode(`对照 ${fmtValue(p.ghost)}`)]),
      div('gc-tip-row', [textNode(`反事实 ${fmtValue(p.cf)}`)]),
      ...(hasBenchmark ? [div('gc-tip-row', [textNode(`${benchmarkLabel} ${fmtValue(p.benchmark)}`)])] : []),
      div('gc-tip-row', [textNode(`缺口 ${fmtValue(p.gap)}`)]),
      div('gc-tip-row', [textNode(`收盘价 ${fmtClose(p.close)}${merged ? ' 元' : ''}`)]),
    );
    tip.setAttribute('style', '');
  }
  wrap.addEventListener('mousemove', (e) => {
    const rect = typeof wrap.getBoundingClientRect === 'function' ? wrap.getBoundingClientRect() : { width: W };
    const scale = (rect && rect.width ? rect.width : W) / W;
    const vx = (e && Number.isFinite(e.offsetX) ? e.offsetX : 0) / scale;
    const i = Math.max(0, Math.min(n - 1, Math.round((vx - PAD.l) / xStep(n))));
    setIndex(i);
  });
  wrap.addEventListener('mouseleave', () => setIndex(null));

  root.append(wrap);
  return { el: wrap, setIndex };
}

function spanSw(cls) {
  const n = document.createElement('span');
  n.setAttribute('class', cls);
  return n;
}
