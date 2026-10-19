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
    g.append(svgText(PAD.l - 8, yPos(ext.hi, ext, H) + 4, ext.hi, 'gc-axis gc-axis-end'));
    g.append(svgText(PAD.l - 8, yPos(ext.lo, ext, H) + 4, ext.lo, 'gc-axis gc-axis-end'));
  }
  return g;
}

function axisLabels(n) {
  if (n <= 1) return [0];
  return [0, Math.floor((n - 1) / 2), n - 1];
}

function axisLabelAttrs(i, n) {
  if (i === 0) return { 'text-anchor': 'start' };
  if (i === n - 1) return { 'text-anchor': 'end' };
  return { 'text-anchor': 'middle' };
}

export function renderGhostChart(root, cf) {
  const { series, markers } = cf;
  const points = series.points;
  const n = points.length;
  const xs = (i) => xPos(i, n);
  const extA = extent(points.flatMap((p) => [p.actual, p.ghost, p.cf]));
  const extC = extent(points.map((p) => p.close));
  const yA = (v) => yPos(v, extA, H1);
  const yC = (v) => yPos(v, extC, H2);
  const xIdx = axisLabels(n);

  const wrap = div('gc-wrap');
  const tip = div('gc-tip');
  tip.setAttribute('style', 'display:none');

  wrap.append(div('gc-reading-guide', [
    textNode('读图提示：上图比较你的实际结果、买入后持有，以及“这笔卖出没有发生”的假设结果；下图只显示每日收盘价和交易发生的时间点。'),
  ]));

  //  上：资产路径 
  wrap.append(div('gc-panel-title', [textNode('资产价值变化：实际操作 / 买入后持有 / 假如这笔卖出没有发生；红色带表示两者差额')]));
  const svg1 = svgEl('svg', { viewBox: `0 0 ${W} ${H1}`, class: 'gc-svg', role: 'img' });
  svg1.append(frame(extA, H1));
  const gapPath = gapD(points, xs, yA, yA);
  if (gapPath) svg1.append(svgEl('path', { d: gapPath, class: 'gc-gap-area' }));
  const lines1 = [
    ['actual', 'gc-line gc-line-actual'],
    ['ghost', 'gc-line gc-line-ghost'],
    ['cf', 'gc-line gc-line-cf'],
  ];
  for (const [key, cls] of lines1) {
    const d = lineD(points, key, xs, yA);
    if (d) svg1.append(svgEl('path', { d, class: cls, fill: 'none' }));
    svg1.append(isolatedPoints(points, key, xs, yA, cls));
  }
  svg1.append(isolatedLabels(points, xs, yA));
  for (const i of xIdx) svg1.append(svgText(xs(i), H1 - 10, points[i].date, 'gc-axis', axisLabelAttrs(i, n)));
  const cross1 = svgEl('line', { class: 'gc-cross', y1: PAD.t, y2: H1 - PAD.b, style: 'display:none' });
  svg1.append(cross1);
  wrap.append(svg1);

  //  下：收盘价与买卖点 
  wrap.append(div('gc-panel-title', [textNode('每日收盘价与交易时间点：绿色为买入，红色为卖出，橙色圈为本次模拟的卖出笔')]));
  const svg2 = svgEl('svg', { viewBox: `0 0 ${W} ${H2}`, class: 'gc-svg', role: 'img' });
  svg2.append(frame(extC, H2));
  const closeD = lineD(points, 'close', xs, yC);
  if (closeD) svg2.append(svgEl('path', { d: closeD, class: 'gc-line gc-line-close', fill: 'none' }));
  svg2.append(isolatedPoints(points, 'close', xs, yC, 'gc-line-close'));
  svg2.append(isolatedCloseLabels(points, xs, yC));
  const dateIndex = new Map(points.map((p, i) => [p.date, i]));
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
  const cross2 = svgEl('line', { class: 'gc-cross', y1: PAD.t, y2: H2 - PAD.b, style: 'display:none' });
  svg2.append(cross2);
  wrap.append(svg2);

  wrap.append(tip);

  //  图例 
  const legend = div('gc-legend', [
    div('gc-legend-item', [spanSw('gc-sw gc-sw-actual'), textNode('实际结果（你的操作）')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-ghost'), textNode('买入后持有')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-cf'), textNode('假如这笔卖出没发生')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-gap'), textNode('差额：正值＝不卖可挽回；负值＝这笔卖出反而更好')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-buy'), textNode('买入')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-sell'), textNode('卖出')]),
    div('gc-legend-item', [spanSw('gc-sw gc-sw-replaced'), textNode('当前替换笔')]),
  ]);
  wrap.append(legend);

  if (series.complete === false || series.missing_dates.length > 0) {
    wrap.append(div('banner warn-banner gc-missing', [
      textNode(`序列不完整：缺少价格数据，路径已断开（${series.missing_dates.join('、')}）缺价日不回退其他日期（B4），相应日期不参与连线。`),
      textNode(' 底缘买卖标记表示该交易日缺价，不表示价格为零或跌到底部。'),
    ]));
  }

  const marketCaption = cf.marketSource && cf.marketSource.dynamic
    ? 'Tushare 动态日线（最新已收盘，服务端获取，非实时，草案口径）'
    : '合成行情 · 非真实行情（m0 合成夹具，草案口径）';
  wrap.append(div('gc-caption', [
    textNode(`${marketCaption}｜ S1 单笔卖出替换：仅替换所选卖出笔，其余成交不变；不构成投资建议`),
  ]));

  //  十字线：上下面板同步 
  const fmt = (v) => (Number.isFinite(v) ? String(v) : '—（缺价）');
  function setIndex(i) {
    if (i === null || i === undefined || i < 0 || i >= n) {
      cross1.setAttribute('style', 'display:none');
      cross2.setAttribute('style', 'display:none');
      tip.setAttribute('style', 'display:none');
      return;
    }
    const x = xs(i);
    for (const c of [cross1, cross2]) {
      c.setAttribute('style', '');
      c.setAttribute('x1', String(x));
      c.setAttribute('x2', String(x));
    }
    const p = points[i];
    tip.replaceChildren(
      div('gc-tip-date', [textNode(p.date)]),
      div('gc-tip-row', [textNode(`实际 ${fmt(p.actual)}`)]),
      div('gc-tip-row', [textNode(`对照 ${fmt(p.ghost)}`)]),
      div('gc-tip-row', [textNode(`反事实 ${fmt(p.cf)}`)]),
      div('gc-tip-row', [textNode(`缺口 ${fmt(p.gap)}`)]),
      div('gc-tip-row', [textNode(`收盘价 ${fmt(p.close)}`)]),
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
