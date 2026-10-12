// 报告 · 证据：浅色大屏样板（数值来自 m0 合成预期夹具；计算引擎未接入）
// 交互保持：场景 A/A′ 切换、标的切换、证据展开。A/A′ 切换时同步已加载账单（来源与确认状态一致）。
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';

const fmtMoney = (v) => '¥' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const fmtPP = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;

function fmtDeltaValue(path, v) {
  if (path.endsWith('.actualRet') || path.endsWith('.ghostRet')) return fmtPct(v);
  if (path.endsWith('.drag')) return fmtPP(v);
  return fmtMoney(v);
}

function billStatusText(bill) {
  if (bill.status === 'confirmed') return `已确认（${bill.trades.length} 条）`;
  if (bill.status === 'loaded') return `已加载（${bill.trades.length} 条，未确认）`;
  return '未加载（演示数据可直接查看）';
}

// A/A′ 切换：同步已加载账单的成交、来源与警告；保持原确认状态不变
async function switchScenario(key, ctx) {
  const { state, set } = ctx;
  const status = state.bill.status;
  set({ report: { scenario: key } });
  if (status === 'loaded' || status === 'confirmed') {
    try {
      const bill = await demo.loadDemoBill(key);
      set({ bill: { scenario: key, trades: bill.trades, warnings: bill.warnings, sourceNote: bill.sourceNote, resultLabelling: bill.resultLabelling } });
    } catch (e) {
      set({ bill: { scenario: key, error: e.message } });
    }
  } else {
    set({ bill: { scenario: key } });
  }
}

function metric(label, value, note, kind, sub) {
  const card = el('div', { class: `rp-metric ${kind}`.trim() });
  card.append(el('div', { class: 'label' }, [label]));
  card.append(el('div', { class: 'value' }, [value]));
  if (sub) card.append(el('div', { class: 'value-sub' }, [sub]));
  if (note) card.append(el('div', { class: 'note' }, [note]));
  return card;
}

export function renderReport(root, ctx) {
  const { state } = ctx;
  const page = el('div', { class: 'report-page' });
  root.append(page);
  page.append(el('div', { class: 'rp-loading' }, ['加载演示数据…']));

  demo.loadIndicators(state.report.scenario).then((ind) => {
    page.replaceChildren();
    buildPage(page, ind, ctx);
  }).catch((e) => {
    page.replaceChildren(el('div', { class: 'rp-error' }, [
      '演示数据加载失败：' + e.message + '（请先运行 npm run dev 启动本地服务，并访问 http://localhost:5180/#/report）',
    ]));
  });
}

function buildPage(page, ind, ctx) {
  const { state } = ctx;
  const isPool = state.report.symbol === 'pool';
  const m = isPool ? ind.pool : ind.perStock[state.report.symbol];

  /* —— 页头：标题 + 场景/标的切换（首屏）—— */
  const top = el('div', { class: 'rp-top' });
  const titleBox = el('div', { class: 'rp-title' });
  titleBox.append(el('div', { class: 'rp-kicker' }, ['REPORT · EVIDENCE']));
  titleBox.append(el('h1', {}, ['报告 · 证据']));
  titleBox.append(el('div', { class: 'sub' }, ['演示样板（浅色版式）· 数值来自合成预期夹具，非运行计算结果']));
  top.append(titleBox);

  const controls = el('div', { class: 'rp-controls' });

  const scenGroup = el('div', { class: 'rp-control-group' });
  scenGroup.append(el('span', { class: 'rp-control-label' }, ['演示场景']));
  const scenSeg = el('div', { class: 'rp-seg' });
  for (const [key, label] of [['A', '基准账单 A'], ['Aprime', 'A′（仅改一笔卖出）']]) {
    scenSeg.append(el('button', {
      class: state.report.scenario === key ? 'active' : '',
      onclick: () => switchScenario(key, ctx),
    }, [label]));
  }
  scenGroup.append(scenSeg);
  controls.append(scenGroup);

  const symGroup = el('div', { class: 'rp-control-group' });
  symGroup.append(el('span', { class: 'rp-control-label' }, ['标的']));
  const symSeg = el('div', { class: 'rp-seg' });
  for (const [key, label] of [['pool', '组合'], ...Object.keys(ind.perStock).map((s) => [s, s])]) {
    symSeg.append(el('button', {
      class: state.report.symbol === key ? 'active' : '',
      onclick: () => ctx.set({ report: { symbol: key } }),
    }, [label]));
  }
  symGroup.append(symSeg);
  controls.append(symGroup);
  top.append(controls);
  page.append(top);

  /* —— 状态条：数据 / 来源 / 口径 / 能力（常显，不折叠）—— */
  const status = el('div', { class: 'rp-status' });
  status.append(el('span', { class: 'rp-chip demo' }, ['演示数据 · 合成夹具']));
  status.append(el('span', { class: 'rp-chip' }, [`来源：${ind.sourceFile}（m0/csv-input/fixtures）`]));
  status.append(el('span', { class: 'rp-chip' }, [`口径：${ind.resultLabelling.fees_taxes}；${ind.resultLabelling.dividend}`]));
  status.append(el('span', { class: 'rp-chip cap' }, [demo.CAPABILITY.engine.label]));
  status.append(el('span', { class: 'rp-chip cap' }, [demo.CAPABILITY.bailian.label]));
  status.append(el('span', { class: 'rp-chip cap' }, [demo.CAPABILITY.marketCache.label]));
  page.append(status);

  if (!m) {
    page.append(el('div', { class: 'rp-error' }, ['未找到该标的的演示指标']));
    return;
  }

  /* —— 核心指标（首屏大字号）—— */
  const metrics = el('div', { class: 'rp-metrics' });
  metrics.append(metric('实际收益', m.display.actualRet, '你的真实操作结果（合成样例）', 'actual'));
  metrics.append(metric('对照收益', m.display.ghostRet, '买入不动口径：买入后持有不动的对照路径', 'ghost'));
  metrics.append(metric('择时损耗', m.display.drag, '对照 − 实际；正值＝相对损耗', 'drag', m.display.dragMoney));
  metrics.append(metric('股票本身涨幅', '—', '公式未定义（Q9：已移出 CSV 范围，待计算结果接口）', 'stock'));
  page.append(metrics);

  /* —— 信息行 —— */
  const meta = el('div', { class: 'rp-meta' });
  meta.append(el('span', {}, ['买入成本 ', el('b', {}, [fmtMoney(m.buyCost)])]));
  meta.append(isPool
    ? el('span', {}, ['期末持仓 ', el('b', {}, ['—']), '（组合不汇总个股股数）'])
    : el('span', {}, ['期末持仓 ', el('b', {}, [`${m.heldShares} 股`])]));
  meta.append(isPool
    ? el('span', {}, ['现价 ', el('b', {}, ['—']), '（组合不使用单一现价）'])
    : el('span', {}, ['现价（合成声明值） ', el('b', {}, [String(ind.assumptions.asof_prices[state.report.symbol])])]));
  meta.append(el('span', {}, ['账单状态 ', el('b', {}, [billStatusText(state.bill)])]));
  page.append(meta);

  /* —— 证据（可展开：手算推导 + 口径 + 开发说明）—— */
  const det = el('details', { class: 'rp-evidence' });
  det.append(el('summary', {}, ['查看证据与计算路径']));
  const body = el('div', { class: 'rp-evidence-body' });

  body.append(el('div', { class: 'rp-sub' }, ['手算推导（合成样例）']));
  const ledger = el('div', { class: 'rp-ledger' });
  ind.handCalc.forEach((line, i) => {
    ledger.append(el('div', { class: 'rp-row' }, [
      el('i', {}, [String(i + 1).padStart(2, '0')]),
      el('span', {}, [line]),
    ]));
  });
  body.append(ledger);

  body.append(el('div', { class: 'rp-sub' }, ['数据来源与口径']));
  body.append(el('div', { class: 'rp-calc' }, [`来源文件：${ind.sourceFile}（合成夹具，占位代码非真实证券）。`]));
  body.append(el('div', { class: 'rp-calc' }, [`公式基础：${ind.assumptions.formula_basis}`]));
  body.append(el('div', { class: 'rp-calc' }, [`现价声明：${JSON.stringify(ind.assumptions.asof_prices)}（${ind.assumptions.asof_note}）`]));

  body.append(el('div', { class: 'rp-dev' }, [
    '开发说明（折叠区）：数值经演示适配层 src/demo/adapter.js 读取 m0 合成夹具的预期值；计算引擎、独立复核与 provenance（逐笔来源引用）尚未接入，接入后本页数字将由确定性计算产出并附来源行。本页为浅色报告样板，其余三页暂保持原版式。',
  ]));
  det.append(body);
  page.append(det);

  /* —— A′ 差异面板 —— */
  if (ind.delta) {
    const d = el('div', { class: 'rp-delta' });
    d.append(el('div', { class: 'rp-sub' }, [
      `与基准 A 的差异（仅改第 ${ind.delta.changed_cell.line} 行卖出价：${ind.delta.changed_cell.from} → ${ind.delta.changed_cell.to}）`,
    ]));
    d.append(el('div', { class: 'rp-sub2' }, ['受影响指标（按预期变化）']));
    const grid = el('div', { class: 'rp-delta-grid' });
    for (const item of ind.delta.affected) {
      grid.append(el('div', { class: 'rp-delta-row' }, [
        el('span', { class: 'p' }, [item.path]),
        el('span', { class: 'from' }, [fmtDeltaValue(item.path, item.from)]),
        el('span', { class: 'arrow' }, ['→']),
        el('span', { class: 'to' }, [fmtDeltaValue(item.path, item.to)]),
      ]));
    }
    d.append(grid);
    d.append(el('div', { class: 'rp-sub2' }, ['保持不变（示例）']));
    d.append(el('div', { class: 'rp-calc unchanged' }, [ind.delta.unchanged.join('、')]));
    page.append(d);
  }
}
