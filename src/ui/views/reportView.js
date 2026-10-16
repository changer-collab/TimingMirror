// 报告 · 证据（引擎接线版，浅色样板）
// 数据链路：页面只调 src/demo/adapter.js；adapter 内部走引擎。
//   演示模式：夹具 CSV → csvNormalize → marketCache(合成夹具) → indicators → provenance（A/A′ 对比）。
//   用户账单模式（bill.confirmed 且 sourceType=local）：确认后的标准化账单 → 同一市场段 → runReview 发布门槛 → published_facts。
// 标注：行情均为 m0 合成夹具（占位代码、合成价格）——非真实账户、非真实行情；用户模式额外标注文件名与数据模式。
// 展示规则：数字一律使用引擎 display 字段（F-2），页面不重新格式化；用户模式只发布 runReview.published_facts 中的事实，
//   组合结论只在 review.portfolio_published 时展示（B4）；阻断时不发布对应结论，不回退演示数据。
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';
import { renderGhostChart } from '../components/ghostChart.js';

function billStatusText(bill) {
  if (bill.status === 'confirmed') return `已确认（${bill.trades.length} 条）`;
  if (bill.status === 'loaded') return `已加载（${bill.trades.length} 条，未确认）`;
  return '未加载（演示数据可直接查看）';
}

function metric(label, value, note, kind, sub) {
  const card = el('div', { class: `rp-metric ${kind}`.trim() });
  card.append(el('div', { class: 'label' }, [label]));
  card.append(el('div', { class: 'value' }, [value]));
  if (sub) card.append(el('div', { class: 'value-sub' }, [sub]));
  if (note) card.append(el('div', { class: 'note' }, [note]));
  return card;
}

function safeJson(v) {
  try {
    return JSON.stringify(v) ?? '{}';
  } catch {
    return '{}';
  }
}

/* —— 单笔反事实区（S1 幽灵线；演示与用户账单共用）——
   数据一律来自 adapter.loadSellCounterfactual（内部唯一调用 replaceSell）；
   页面不计算 actual/ghost/cf/gap/收盘价，引擎 display 原样展示。 */
function cfSection({ trades, symbol, selectedId, set }) {
  const box = el('div', { class: 'rp-cf' });
  box.append(el('div', { class: 'rp-sub' }, ['单笔反事实：如果这笔卖出没有发生（S1 单笔卖出替换）']));
  const body = el('div', {});
  box.append(body);
  // 跨标的/跨场景残留防护：selectedId 不属于当前标的的卖出笔时传 null（adapter 默认该标的按时间第一笔）
  const applicable = typeof selectedId === 'string'
    && trades.some((t) => t && t.symbol === symbol && t.side === 'sell' && t.trade_id === selectedId);
  demo.loadSellCounterfactual({ trades, symbol, tradeId: applicable ? selectedId : null })
    .then((cf) => {
      if (!cf.ok) {
        body.replaceChildren(el('div', { class: 'rp-error' }, [`该反事实结论不发布：${cf.code} · ${cf.message}`]));
        return;
      }
      body.replaceChildren();
      if (cf.sellOptions.length > 1) {
        const row = el('div', { class: 'rp-cf-picker' });
        row.append(el('span', { class: 'rp-control-label' }, ['替换哪笔卖出：']));
        const sel = el('select', {
          class: 'input',
          onchange: (e) => set({ report: { cfTradeId: e.target.value } }),
        });
        for (const o of cf.sellOptions) sel.append(el('option', { value: o.trade_id }, [`${o.trade_id} · ${o.trade_date} · ${o.price} × ${o.quantity}`]));
        sel.value = cf.tradeId;
        row.append(sel);
        body.append(row);
      } else {
        body.append(el('div', { class: 'muted small' }, [
          `可替换卖出笔：${cf.sellOptions.map((o) => `${o.trade_id} · ${o.trade_date} · ${o.price} × ${o.quantity}`).join('；')}`,
        ]));
      }
      const chartBox = el('div', {});
      body.append(chartBox);
      renderGhostChart(chartBox, cf);
      const r = cf.replace;
      body.append(el('div', { class: 'rp-calc' }, [
        `本次模拟：不发生 ${r.replaced.trade_id} 这笔卖出（${r.replaced.trade_date} · ${r.replaced.price} × ${r.replaced.quantity}）｜假设结果价值 ${r.display.cfValue} ｜ 假设收益 ${r.display.cfRet} ｜ 相对改善 ${r.display.recoveredPP} ｜ 剩余损耗金额 ${r.display.remainingDragMoney}`,
      ]));
      body.append(el('div', { class: 'rp-calc unchanged' }, [
        `说明：正的“相对改善”表示不卖这笔会更好；负值表示这笔卖出反而优于持有，不是错误。公式标识：${[...new Set(Object.values(r.formula_ids))].join(' / ')}（可在「查看证据与计算路径」中复核）。`,
      ]));
    })
    .catch((e) => {
      body.replaceChildren(el('div', { class: 'rp-error' }, [
        `反事实数据加载失败：${String(e && e.message ? e.message : e)}（该反事实结论不发布）`,
      ]));
    });
  return box;
}

function cfPoolHint() {
  return el('div', { class: 'rp-cf rp-cf-hint muted' }, ['请选择一个标的查看单笔卖出反事实（组合 scope 不绘制单笔反事实图）。']);
}

export function renderReport(root, ctx) {
  const page = el('div', { class: 'report-page' });
  root.append(page);
  const bill = ctx.state.bill;
  if (bill.status === 'confirmed' && bill.sourceType === 'local') {
    page.append(el('div', { class: 'rp-loading' }, ['加载用户账单报告…（合成演示行情）']));
    demo.loadUserBillReport(bill)
      .then((bundle) => {
        page.replaceChildren();
        buildUserBillPage(page, bundle, ctx);
      })
      .catch((e) => {
        page.replaceChildren(el('div', { class: 'rp-error' }, [
          `用户账单报告加载失败：${String(e && e.message ? e.message : e)}（不回退演示数据；请返回导入页重新确认）`,
        ]));
      });
    return;
  }
  page.append(el('div', { class: 'rp-loading' }, ['加载引擎数据…（合成演示）']));

  loadBundles(ctx)
    .then(({ bundle, baseBundle }) => {
      page.replaceChildren();
      buildPage(page, bundle, baseBundle, ctx);
    })
    .catch((e) => {
      page.replaceChildren(el('div', { class: 'rp-error' }, [
        `报告数据加载失败：${String(e && e.message ? e.message : e)}（请先运行 npm run dev 启动本地服务）`,
      ]));
    });
}

async function loadBundles(ctx) {
  const scenario = ctx.state.report.scenario === 'Aprime' ? 'Aprime' : 'A';
  if (scenario === 'Aprime') {
    const [alt, base] = await Promise.all([demo.loadReportEngine('Aprime'), demo.loadReportEngine('A')]);
    return { bundle: alt, baseBundle: base };
  }
  return { bundle: await demo.loadReportEngine('A'), baseBundle: null };
}

function buildPage(page, b, baseBundle, ctx) {
  const { state } = ctx;

  /* —— 页头：标题 + 场景/标的切换 —— */
  const top = el('div', { class: 'rp-top' });
  const titleBox = el('div', { class: 'rp-title' });
  titleBox.append(el('div', { class: 'rp-kicker' }, ['REPORT · EVIDENCE']));
  titleBox.append(el('h1', {}, ['报告 · 证据']));
  titleBox.append(el('div', { class: 'sub' }, ['本地确定性引擎计算 · 合成演示数据（非真实账户 / 非真实行情）']));
  top.append(titleBox);

  const controls = el('div', { class: 'rp-controls' });

  const scenGroup = el('div', { class: 'rp-control-group' });
  scenGroup.append(el('span', { class: 'rp-control-label' }, ['演示场景']));
  const scenSeg = el('div', { class: 'rp-seg' });
  for (const key of ['A', 'Aprime']) {
    scenSeg.append(el('button', {
      class: b.scenario === key ? 'active' : '',
      onclick: () => ctx.set({ report: { scenario: key } }),
    }, [demo.SCENARIOS[key].label]));
  }
  scenGroup.append(scenSeg);
  controls.append(scenGroup);

  const symbolKeys = ['pool', ...Object.keys(b.perStock), ...b.blockedSymbols];
  const scope = symbolKeys.includes(state.report.symbol) ? state.report.symbol : 'pool';
  const symGroup = el('div', { class: 'rp-control-group' });
  symGroup.append(el('span', { class: 'rp-control-label' }, ['标的']));
  const symSeg = el('div', { class: 'rp-seg' });
  for (const key of symbolKeys) {
    symSeg.append(el('button', {
      class: scope === key ? 'active' : '',
      onclick: () => ctx.set({ report: { symbol: key } }),
    }, [key === 'pool' ? '组合' : key]));
  }
  symGroup.append(symSeg);
  controls.append(symGroup);
  top.append(controls);
  page.append(top);

  /* —— 状态条：数据模式 / 行情 / 估值日 / 口径（常显，不折叠）—— */
  const status = el('div', { class: 'rp-status' });
  status.append(el('span', { class: 'rp-chip demo' }, [b.dataMode.label]));
  status.append(el('span', { class: 'rp-chip' }, [
    b.marketRange ? `行情：m0 合成夹具（非真实行情）· ${b.marketRange.start} → ${b.marketRange.end}` : '行情：不可用',
  ]));
  status.append(el('span', { class: 'rp-chip' }, [
    b.valuation
      ? (b.valuation.blocked ? `估值日：${b.valuation.requested_date} 无法解析（${b.valuation.code}）` : `估值日：${b.valuation.requested_date} → ${b.valuation.effective_date}`)
      : '估值日：不可用',
  ]));
  status.append(el('span', { class: 'rp-chip' }, [`口径：${b.labels.fees_taxes}；${b.labels.dividend}`]));
  status.append(el('span', { class: 'rp-chip cap' }, ['行情清单未签收·草案口径']));
  page.append(status);

  /* —— 诊断：错误（阻断）与警告（照实展示，不静默隐藏）—— */
  if (b.errors.length > 0) {
    const eb = el('div', { class: 'banner warn-banner' });
    eb.append(el('strong', {}, ['阻断/错误（对应结论不发布）']));
    for (const e of b.errors) eb.append(el('div', {}, [`${e.code}${e.line ? `（第 ${e.line} 行）` : ''} · ${e.message}`]));
    page.append(eb);
  }
  if (b.warnings.length > 0) {
    const wb = el('div', { class: 'banner' });
    wb.append(el('strong', {}, ['警告（照实展示）']));
    for (const w of b.warnings) wb.append(el('div', {}, [`${w.code}${w.line ? `（第 ${w.line} 行）` : ''}${w.column ? ` · ${w.column}` : ''} · ${w.message}`]));
    page.append(wb);
  }

  /* —— 当前范围：组合 / 标的 —— */
  const entry = scope === 'pool' ? b.pool : b.perStock[scope];
  const scopeBlocked = scope === 'pool' ? (!b.pool && b.poolBlocked) : (!entry && b.blockedSymbols.includes(scope));

  if (scopeBlocked) {
    const blockedBox = el('div', { class: 'rp-error' });
    blockedBox.append(el('div', {}, [`「${scope === 'pool' ? '组合' : scope}」结果不发布：`]));
    const reasons = scope === 'pool'
      ? b.errors.filter((e) => e.code && (e.code.indexOf('E_PRICE') === 0 || e.code.indexOf('E_VALUATION') === 0))
      : b.errors.filter((e) => e.message && e.message.includes(scope));
    for (const r of (reasons.length ? reasons : b.errors)) blockedBox.append(el('div', {}, [`· ${r.code} · ${r.message}`]));
    blockedBox.append(el('div', { class: 'muted small' }, ['不使用替代值、其他估值日或“剩余标的组合”冒充完整结果（B4）。']));
    page.append(blockedBox);
  } else if (!entry) {
    page.append(el('div', { class: 'rp-error' }, [`未找到「${scope}」的结果（引擎输出不含该范围，照实提示，不猜测）。`]));
  } else {
    const metrics = el('div', { class: 'rp-metrics' });
    metrics.append(metric('实际收益', entry.display.actualRet, '你的实际操作结果（合成样例）', 'actual'));
    metrics.append(metric('对照收益', entry.display.ghostRet, '买入不动口径：买入后持有不动的对照路径', 'ghost'));
    metrics.append(metric('择时损耗', entry.display.drag, '对照 − 实际；正值＝相对损耗，负值＝实际操作优于对照', 'drag', entry.display.dragMoney));
    metrics.append(metric('股票本身涨幅', '口径未定义', 'Q9：公式未定（待负责人定夺）——不临时计算、不用 — 掩盖', 'stock'));
    page.append(metrics);

    /* —— 信息行 —— */
    const meta = el('div', { class: 'rp-meta' });
    meta.append(el('span', {}, ['买入成本 ', el('b', {}, [entry.display.buyCost])]));
    meta.append(scope === 'pool'
      ? el('span', {}, ['期末持仓 ', el('b', {}, ['组合不汇总个股股数'])])
      : el('span', {}, ['期末持仓 ', el('b', {}, [`${entry.heldShares} 股`])]));
    meta.append(el('span', {}, ['估值日 ', el('b', {}, [b.valuation && !b.valuation.blocked ? b.valuation.effective_date : '不可用'])]));
    meta.append(el('span', {}, ['账单状态 ', el('b', {}, [billStatusText(state.bill)])]));
    page.append(meta);

    const rec = el('div', { class: 'rp-calc unchanged' }, [
      `记录值（仅记录与标注，不入公式，Q1）：费用合计 ${entry.recorded.fee_recorded_sum} 元；税费合计 ${entry.recorded.tax_recorded_sum} 元；` +
      `费用缺失行 ${entry.recorded.fee_missing_lines.length ? entry.recorded.fee_missing_lines.join('、') : '无'}；税费缺失行 ${entry.recorded.tax_missing_lines.length ? entry.recorded.tax_missing_lines.join('、') : '无'}`,
    ]);
    page.append(rec);
  }

  if (scope === 'pool') {
    page.append(cfPoolHint());
  } else if (!scopeBlocked && entry) {
    page.append(cfSection({ trades: b.trades, symbol: scope, selectedId: state.report.cfTradeId, set: ctx.set }));
  }

  /* —— 证据：计算路径（provenance；引擎输出，含 formula / inputs / steps）—— */
  const det = el('details', { class: 'rp-evidence' });
  det.append(el('summary', {}, ['查看证据与计算路径']));
  const body = el('div', { class: 'rp-evidence-body' });
  const prov = b.provenance;
  if (!prov) {
    body.append(el('div', { class: 'rp-calc' }, ['计算路径不可用：本次运行未产出 provenance（不掩盖，照实提示）。']));
  } else {
    body.append(el('div', { class: 'rp-sub' }, [`计算路径（fact ${prov.summary.n} 项 · 阻断 ${prov.summary.blocked_n} 项）`]));
    if (prov.blocked || prov.dangling_refs.length > 0) {
      const pb = el('div', { class: 'banner warn-banner' });
      pb.append(el('strong', {}, ['该视图存在阻断项（不发布部分路径）']));
      for (const d of prov.dangling_refs) pb.append(el('div', {}, [`· ${d.fact_id} · ${d.message}`]));
      if (prov.errors) for (const e of prov.errors) pb.append(el('div', {}, [`· ${e.code} · ${e.message}`]));
      body.append(pb);
    }
    const ledger = el('div', { class: 'rp-ledger' });
    prov.items.forEach((it, i) => {
      const row = el('div', { class: 'rp-row' });
      row.append(el('i', {}, [String(i + 1).padStart(2, '0')]));
      const cell = el('span', {});
      cell.append(el('b', {}, [`${it.fact_id}`]));
      cell.append(` · ${it.formula_id ?? '（无公式编号）'} · ${it.display ?? String(it.value)}${it.blocked ? ' · 阻断不发布' : ''}`);
      row.append(cell);
      if (it.formula_text) row.append(el('div', { class: 'rp-calc muted small' }, [it.formula_text]));
      row.append(el('div', { class: 'rp-calc muted small' }, [`inputs：${safeJson(it.inputs)}`]));
      if (Array.isArray(it.steps) && it.steps.length) {
        row.append(el('div', { class: 'rp-calc muted small' }, [`steps：${it.steps.map((s) => `${s.step_id} ${s.label}`).join(' → ')}`]));
      }
      ledger.append(row);
    });
    body.append(ledger);
    body.append(el('div', { class: 'rp-dev' }, [
      '口径与来源：数字由本地确定性引擎（csvNormalize → marketCache → indicators → provenance）计算；行情为 m0 合成夹具（占位代码、合成价格；非真实行情），清单尚未签收（草案·演示口径）。未接线：真实 CSV 上传、真实行情、百炼、契约匹配。',
    ]));
  }
  det.append(body);
  page.append(det);

  /* —— A′ 差异面板（引擎输出对比；非夹具期望值）—— */
  if (b.scenario === 'Aprime') {
    const d = el('div', { class: 'rp-delta' });
    d.append(el('div', { class: 'rp-sub' }, [`与基准 A 的差异（${b.scenarioMeta.note}）`]));
    const delta = demo.computeScopeDelta(baseBundle, b, scope);
    if (!delta) {
      d.append(el('div', { class: 'rp-calc' }, ['差异不可用：该范围在 A 或 A′ 下被阻断，不发布差异结论。']));
    } else {
      d.append(el('div', { class: 'rp-sub2' }, ['受影响指标（引擎 A 与 A′ 输出对比）']));
      const grid = el('div', { class: 'rp-delta-grid' });
      for (const c of delta.changed) {
        grid.append(el('div', { class: 'rp-delta-row' }, [
          el('span', { class: 'p' }, [c.field]),
          el('span', { class: 'from' }, [c.from]),
          el('span', { class: 'arrow' }, ['→']),
          el('span', { class: 'to' }, [c.to]),
        ]));
      }
      if (delta.changed.length === 0) grid.append(el('div', { class: 'rp-delta-row' }, [el('span', { class: 'p' }, ['无字段变化'])]));
      d.append(grid);
      d.append(el('div', { class: 'rp-sub2' }, ['保持不变']));
      d.append(el('div', { class: 'rp-calc unchanged' }, [delta.unchanged.join('、') || '（无）']));
    }
    page.append(d);
  }
}

function buildUserBillPage(page, b, ctx) {
  const { state } = ctx;
  const review = b.review;

  const top = el('div', { class: 'rp-top' });
  const titleBox = el('div', { class: 'rp-title' });
  titleBox.append(el('div', { class: 'rp-kicker' }, ['REPORT · EVIDENCE']));
  titleBox.append(el('h1', {}, ['报告 · 证据（用户本地账单）']));
  titleBox.append(el('div', { class: 'sub' }, ['本地确定性引擎计算 · 合成演示行情（非真实账户 / 非真实行情；原始 CSV 未上传）']));
  top.append(titleBox);
  page.append(top);

  const status = el('div', { class: 'rp-status' });
  status.append(el('span', { class: 'rp-chip demo' }, [`用户本地账单 · 文件名：${b.fileName || '（未知）'}`]));
  status.append(el('span', { class: 'rp-chip demo' }, [b.dataMode ? b.dataMode.label : '数据模式未知']));
  status.append(el('span', { class: 'rp-chip' }, [
    b.marketRange ? `行情：m0 合成夹具 / 非真实行情 · ${b.marketRange.start} → ${b.marketRange.end}` : '行情：不可用',
  ]));
  status.append(el('span', { class: 'rp-chip' }, [
    b.valuation
      ? (b.valuation.blocked ? `估值日：${b.valuation.requested_date} 无法解析（${b.valuation.code}）` : `估值日：${b.valuation.requested_date} → ${b.valuation.effective_date}`)
      : '估值日：不可用',
  ]));
  status.append(el('span', { class: 'rp-chip' }, [`口径：${b.labels.fees_taxes}；${b.labels.dividend}`]));
  status.append(el('span', { class: `rp-chip ${review ? (review.status === 'published' ? 'ok' : review.status === 'degraded' ? 'demo' : 'cap') : 'cap'}` }, [`复核：${review ? review.status : '未运行'}`]));
  page.append(status);

  if (b.errors.length > 0) {
    const eb = el('div', { class: 'banner warn-banner' });
    eb.append(el('strong', {}, ['阻断/错误（对应结论不发布）']));
    for (const e of b.errors) eb.append(el('div', {}, [`${e.code}${e.line ? `（第 ${e.line} 行）` : ''} · ${e.message}`]));
    page.append(eb);
  }
  if (b.warnings.length > 0) {
    const wb = el('div', { class: 'banner' });
    wb.append(el('strong', {}, ['警告（照实展示）']));
    for (const w of b.warnings) wb.append(el('div', {}, [`${w.code}（第 ${w.line} 行）${w.column ? ` · ${w.column}` : ''} · ${w.message}`]));
    page.append(wb);
  }

  if (!review) {
    page.append(el('div', { class: 'rp-error' }, ['复核未运行：行情层阻断，无已发布事实（不回退演示数据）。']));
    return;
  }

  const stockScopes = Object.keys(b.factsByScope).filter((s) => s !== 'portfolio');
  const symbolKeys = ['pool', ...stockScopes, ...b.blockedSymbols.filter((s) => !stockScopes.includes(s))];
  const scope = symbolKeys.includes(state.report.symbol) ? state.report.symbol : 'pool';
  const symGroup = el('div', { class: 'rp-control-group' });
  symGroup.append(el('span', { class: 'rp-control-label' }, ['标的']));
  const symSeg = el('div', { class: 'rp-seg' });
  for (const key of symbolKeys) {
    symSeg.append(el('button', {
      class: scope === key ? 'active' : '',
      onclick: () => ctx.set({ report: { symbol: key } }),
    }, [key === 'pool' ? '组合' : key]));
  }
  symGroup.append(symSeg);
  page.append(symGroup);

  const entry = scope === 'pool' ? b.factsByScope.portfolio : b.factsByScope[scope];
  const scopeBlocked = scope === 'pool' ? review.portfolio_published !== true : !entry;

  if (scopeBlocked) {
    const blockedBox = el('div', { class: 'rp-error' });
    blockedBox.append(el('div', {}, [scope === 'pool' ? '「组合」结果不发布：' : `「${scope}」结果不发布：`]));
    const reasons = scope === 'pool' ? b.errors : b.errors.filter((e) => e.message && e.message.includes(scope));
    for (const r of (reasons.length ? reasons : b.errors)) blockedBox.append(el('div', {}, [`· ${r.code} · ${r.message}`]));
    blockedBox.append(el('div', { class: 'muted small' }, [
      scope === 'pool'
        ? '存在缺价/超范围标的时不按剩余标的重新计算组合（B4）；部分标的可显示不代表完整组合结论。'
        : '不使用替代值或其他估值日冒充该标的结果。',
    ]));
    page.append(blockedBox);
  } else if (!entry) {
    page.append(el('div', { class: 'rp-error' }, [`未找到「${scope}」的已发布事实（照实提示，不猜测）。`]));
  } else {
    const metrics = el('div', { class: 'rp-metrics' });
    metrics.append(metric('实际收益', entry.actualRet.display, '你的实际操作结果（本机账单 · 合成行情估值）', 'actual'));
    metrics.append(metric('对照收益', entry.ghostRet.display, '买入不动口径：买入后持有不动的对照路径', 'ghost'));
    metrics.append(metric('择时损耗', entry.drag.display, '对照 − 实际；正值＝相对损耗，负值＝实际操作优于对照', 'drag', entry.dragMoney.display));
    metrics.append(metric('股票本身涨幅', '口径未定义', 'Q9：公式未定（待负责人定夺）——不临时计算、不用 — 掩盖', 'stock'));
    page.append(metrics);

    const meta = el('div', { class: 'rp-meta' });
    meta.append(el('span', {}, ['买入成本 ', el('b', {}, [entry.buyCost.display])]));
    meta.append(scope === 'pool'
      ? el('span', {}, ['期末持仓 ', el('b', {}, ['组合不汇总个股股数'])])
      : el('span', {}, ['期末持仓 ', el('b', {}, [`${entry.heldShares.value} 股`])]));
    meta.append(el('span', {}, ['估值日 ', el('b', {}, [b.valuation && !b.valuation.blocked ? b.valuation.effective_date : '不可用'])]));
    meta.append(el('span', {}, ['账单状态 ', el('b', {}, [`已确认 · ${b.fileName}`])]));
    page.append(meta);
  }

  if (scope === 'pool') {
    page.append(cfPoolHint());
  } else if (!scopeBlocked && entry) {
    page.append(cfSection({ trades: state.bill.trades, symbol: scope, selectedId: state.report.cfTradeId, set: ctx.set }));
  }

  const det = el('details', { class: 'rp-evidence' });
  det.append(el('summary', {}, ['复核与发布记录']));
  const body = el('div', { class: 'rp-evidence-body' });
  body.append(el('div', { class: 'rp-sub' }, [
    `复核状态：${review.status} · 已发布事实 ${review.published_facts.length} 项 · 阻断事实 ${review.blocked_facts.length} 项 · 组合${review.portfolio_published ? '已发布' : '不发布'}`,
  ]));
  body.append(el('div', { class: 'rp-calc muted small' }, [
    `verify_id：${review.meta.verify_id ?? '（未产出）'} · 重算尝试 ${review.meta.recompute_attempts} 次（本轮用户链路未提供重算来源，如实降级）`,
  ]));
  for (const d of review.degraded) {
    body.append(el('div', { class: 'rp-calc' }, [`· ${d.code}${d.scope ? `（${d.scope}）` : ''} · ${d.message}`]));
  }
  for (const bf of review.blocked_facts) {
    body.append(el('div', { class: 'rp-calc muted small' }, [`· ${bf.fact_id} · ${bf.final_status} · ${bf.reason_codes.join('、')}`]));
  }
  for (const r of review.recompute_log) {
    body.append(el('div', { class: 'rp-calc muted small' }, [`· ${r.recompute_id} · attempt ${r.attempt} · ${r.path_used} · ${r.result}/${r.final_status}${r.code ? ` · ${r.code}` : ''}`]));
  }
  det.append(body);
  page.append(det);

  const evd = el('details', { class: 'rp-evidence' });
  evd.append(el('summary', {}, ['查看证据与计算路径']));
  const evBody = el('div', { class: 'rp-evidence-body' });
  const prov = b.provenance;
  if (!prov) {
    evBody.append(el('div', { class: 'rp-calc' }, ['计算路径不可用：本次运行未产出 provenance（不掩盖，照实提示）。']));
  } else {
    evBody.append(el('div', { class: 'rp-sub' }, [`计算路径（fact ${prov.summary.n} 项 · 阻断 ${prov.summary.blocked_n} 项）`]));
    if (prov.blocked || prov.dangling_refs.length > 0) {
      const pb = el('div', { class: 'banner warn-banner' });
      pb.append(el('strong', {}, ['该视图存在阻断项（不发布部分路径）']));
      for (const d of prov.dangling_refs) pb.append(el('div', {}, [`· ${d.fact_id} · ${d.message}`]));
      if (prov.errors) for (const e of prov.errors) pb.append(el('div', {}, [`· ${e.code} · ${e.message}`]));
      evBody.append(pb);
    }
    for (const it of prov.items) {
      evBody.append(el('div', { class: 'rp-calc muted small' }, [
        `${it.fact_id} · ${it.formula_id ?? '（无公式编号）'} · ${it.display ?? String(it.value)}${it.blocked ? ' · 阻断不发布' : ''}`,
      ]));
    }
  }
  evBody.append(el('div', { class: 'rp-dev' }, [
    '口径与来源：数字由本地确定性引擎（csvNormalize → marketCache → indicators → verify → provenance）计算，经 runReview 发布门槛过滤；行情为 m0 合成夹具（占位代码、合成价格；非真实行情，清单未签收·草案口径）。原始 CSV 仅在本机读取与校验，未上传。',
  ]));
  evd.append(evBody);
  page.append(evd);
}