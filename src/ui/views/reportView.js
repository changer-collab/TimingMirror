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

  /* —— 证据：演示计算路径（provenance；未经 runReview，不使用复核发布措辞）—— */
  const det = el('details', { class: 'rp-evidence' });
  det.append(el('summary', {}, [
    '查看证据与计算路径',
    el('span', { class: 'rp-summary-note' }, ['以下为演示计算路径，未经过复核发布流程（runReview），不代表复核结果。']),
  ]));
  const body = el('div', { class: 'rp-evidence-body' });
  const prov = b.provenance;
  if (!prov) {
    body.append(el('div', { class: 'rp-calc rp-bad-text' }, ['演示计算路径不可用：本次运行未产出计算路径（不掩盖，照实提示）。']));
  } else {
    const factScope = scope === 'pool' ? 'portfolio' : scope;
    const items = prov.items.filter((it) => it.scope === factScope);
    body.append(el('div', { class: 'rp-sub' }, [`演示计算路径（当前范围「${scopeLabel(scope)}」· ${items.length} 项）`]));
    if (prov.blocked || prov.dangling_refs.length > 0) {
      const pb = el('div', { class: 'banner warn-banner' });
      pb.append(el('strong', {}, ['演示计算路径存在阻断项：相关条目不能作为有效结果引用']));
      for (const d of prov.dangling_refs) pb.append(el('div', {}, [`${factName(d.fact_id)} · ${d.message}`]));
      body.append(pb);
    }
    if (items.length === 0) {
      body.append(el('div', { class: 'rp-calc rp-bad-text' }, [
        `「${scopeLabel(scope)}」没有演示计算路径：${b.blockedSymbols.includes(scope) ? '该标的缺价或超出行情支持范围，未进入计算' : '引擎未输出该范围的计算记录'}，不展示替代数字。`,
      ]));
    }
    for (const it of items) body.append(demoFactEvidence(it));
  }
  body.append(el('div', { class: 'rp-dev' }, [
    '口径与来源：数字由本地确定性引擎（csvNormalize → marketCache → indicators → provenance）计算；行情为 m0 合成夹具（占位代码、合成价格；非真实行情），清单尚未签收（草案·演示口径）。未接线：真实 CSV 上传、真实行情、百炼、契约匹配。',
  ]));
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
  const blockedFactScopes = (review.blocked_facts ?? []).map((f) => f.scope).filter((s) => s !== 'portfolio');
  const symbolKeys = ['pool', ...new Set([...stockScopes, ...b.blockedSymbols, ...blockedFactScopes])];
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
    page.append(userBlockedBox(b, review, scope));
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

  page.append(reviewSection(review));
  page.append(evidenceSection(b, review, scope));
}

/* —— 用户账单：复核与发布记录 / 证据与计算路径 ——
   数据只来自 runReview 输出（review.*）与其 provenance；展示值只取引擎 display，页面不重算。
   未发布事实一律显示“未发布”：provenance 条目里可能仍带有按剩余标的算出的值（B4 扣发），不得外露。 */
const FACT_LABELS = Object.freeze({
  buyCost: '买入成本',
  sellProceeds: '卖出所得',
  heldShares: '期末持仓',
  actualValue: '实际期末价值',
  ghostValue: '对照期末价值',
  actualRet: '实际收益',
  ghostRet: '对照收益',
  dragMoney: '择时损耗金额',
  drag: '择时损耗',
});

const REVIEW_STATUS_TEXT = Object.freeze({
  published: '全部事实通过复核并发布',
  degraded: '部分发布：有事实被扣发',
  blocked: '未发布：没有可发布的事实',
});

const FINAL_STATUS_TEXT = Object.freeze({ blocked: '阻断', insufficient_evidence: '证据不足' });

const REASON_TEXT = Object.freeze({
  E_PRICE_MISSING: '估值日缺价或超出行情支持范围',
  E_REVIEW_PORTFOLIO_WITHHELD: '存在缺价标的，组合结论整体扣发（不按剩余标的重算）',
  E_REVIEW_PROVENANCE_BLOCKED: '计算路径不完整，不能追溯',
  E_REVIEW_PROVENANCE_FAILED: '计算路径生成失败',
  E_REVIEW_RECOMPUTE_NO_ALTERNATIVE: '复核未通过，且没有备用重算来源',
  E_VERIFY_IDENTITY_BREAK: '恒等式校验未通过',
  E_VERIFY_SOURCE_UNRESOLVED: '有成交无法定位到账单源文件的行',
  E_VERIFY_RECOMPUTE_MISMATCH: '独立重算结果与主计算不一致',
  E_VERIFY_DUAL_PATH_MISMATCH: '两条计算路径结果不一致',
  E_VERIFY_PROVENANCE_MISSING: '缺少公式编号或计算记录',
  E_PROV_DANGLING_REF: '计算路径引用的成交无法定位到源文件的行',
  E_REVIEW_INPUT_INVALID: '复核输入不完整',
  E_REVIEW_COMPUTE_FAILED: '计算失败',
  E_REVIEW_VERIFY_FAILED: '独立复核运行失败',
  E_REVIEW_RECOMPUTE_TOOL_ERROR: '重算过程出错',
  E_REVIEW_CANDIDATE_SCOPE_CHANGED: '重算候选的标的范围与原范围不一致，未采纳',
  E_REVIEW_CANDIDATE_CLOSE_INVALID: '重算候选缺少有效收盘价，未采纳',
});

// 只有这两类原因才属于“行情侧”阻断（B4）；其余均视为复核/证据问题，照实列码，不归因到缺价。
const PRICE_BLOCK_CODES = new Set(['E_PRICE_MISSING', 'E_REVIEW_PORTFOLIO_WITHHELD']);

function collectBlockReasons(b, review, scope) {
  const isPool = scope === 'pool';
  const factScope = isPool ? 'portfolio' : scope;
  const items = [];
  const add = (code, message) => {
    if (!code) return;
    const same = items.find((i) => i.code === code);
    if (same && (!message || same.message === message)) return;
    if (same && !same.message) { same.message = message; return; }
    items.push({ code, message: message || null });
  };
  for (const s of review.blocked_symbols ?? []) if (isPool || s.symbol === scope) add(s.code, s.message);
  for (const e of b.errors) {
    if (!e.message) continue;
    if (isPool ? PRICE_BLOCK_CODES.has(e.code) : e.message.includes(scope)) add(e.code, e.message);
  }
  for (const d of review.degraded ?? []) {
    const related = !d.scope || d.scope === factScope || (isPool && PRICE_BLOCK_CODES.has(d.code));
    if (related) add(d.code, d.message);
  }
  for (const f of review.blocked_facts ?? []) if (f.scope === factScope) for (const c of f.reason_codes) add(c, null);
  return items;
}

function userBlockedBox(b, review, scope) {
  const name = scope === 'pool' ? '组合' : scope;
  const items = collectBlockReasons(b, review, scope);
  const priceRelated = items.some((i) => PRICE_BLOCK_CODES.has(i.code));
  const evidenceRelated = items.some((i) => !PRICE_BLOCK_CODES.has(i.code));
  const box = el('div', { class: 'rp-error' });
  box.append(el('div', {}, [`「${name}」结果不发布：`]));
  if (items.length === 0) {
    box.append(el('div', {}, ['· 复核输出中没有该范围的具体阻断记录（照实提示，不猜测原因）。']));
  }
  for (const i of items) box.append(el('div', {}, [i.message ? `· ${i.code} · ${i.message}` : `· ${reasonText(i.code)}`]));
  if (priceRelated) {
    box.append(el('div', { class: 'muted small' }, [
      scope === 'pool'
        ? '存在缺价/超范围标的时不按剩余标的重新计算组合（B4），也不回退其他日期；部分标的可显示不代表完整组合结论。'
        : '不使用替代值或其他估值日冒充该标的结果（B4）。',
    ]));
  }
  if (evidenceRelated) {
    box.append(el('div', { class: 'muted small' }, [
      `复核或证据不足导致「${name}」结果不发布：问题出在复核与计算路径环节，结果不能被追溯核对，因此不展示任何被阻断的数字。详见下方“复核与发布记录”。`,
    ]));
  }
  return box;
}

const RECOMPUTE_RESULT_TEXT = Object.freeze({
  no_alternative: '没有备用来源',
  pass: '重算后通过',
  improved: '重算后有改善',
  no_improvement: '重算无改善',
  rejected: '重算候选被拒绝',
  error: '重算出错',
});
const RECOMPUTE_FINAL_TEXT = Object.freeze({ adopted: '已采纳', not_adopted: '未采纳', aborted: '已停止' });

const SIDE_TEXT = Object.freeze({ buy: '买入', sell: '卖出' });

function scopeLabel(scope) {
  return scope === 'portfolio' || scope === 'pool' ? '组合' : scope;
}

function factName(factId) {
  const i = String(factId).indexOf('.');
  const scope = i > 0 ? factId.slice(0, i) : 'portfolio';
  const key = i > 0 ? factId.slice(i + 1) : factId;
  return `${scopeLabel(scope)} · ${FACT_LABELS[key] ?? key}`;
}

function reasonText(code) {
  return REASON_TEXT[code] ? `${code}（${REASON_TEXT[code]}）` : code;
}

function table(headers, rows) {
  const tbl = el('table', { class: 'tbl rp-tbl' });
  const thead = el('thead', {});
  thead.append(el('tr', {}, headers.map((h) => el('th', {}, [h]))));
  tbl.append(thead);
  const tbody = el('tbody', {});
  for (const r of rows) {
    const tr = el('tr', {});
    for (const c of r) tr.append(c instanceof Node ? el('td', {}, [c]) : el('td', {}, [c ?? '']));
    tbody.append(tr);
  }
  tbl.append(tbody);
  return el('div', { class: 'table-wrap' }, [tbl]);
}

function statusTag(text, kind) {
  return el('span', { class: `rp-tag ${kind}` }, [text]);
}

function overviewItem(label, value, kind = '') {
  return el('div', { class: `rp-ov-item ${kind}`.trim() }, [
    el('div', { class: 'k' }, [label]),
    el('div', { class: 'v' }, [value]),
  ]);
}

function publishedDisplay(fact, provItem) {
  return fact.display ?? (provItem && provItem.display) ?? '（引擎未提供展示值）';
}

function reviewSection(review) {
  const det = el('details', { class: 'rp-evidence' });
  det.append(el('summary', {}, ['复核与发布记录']));
  const body = el('div', { class: 'rp-evidence-body' });
  const provById = new Map((review.provenance ? review.provenance.items : []).map((i) => [i.fact_id, i]));

  /* 复核概览 */
  body.append(el('div', { class: 'rp-sub' }, ['复核概览']));
  const ov = el('div', { class: 'rp-overview' });
  ov.append(overviewItem('复核状态', `${review.status} · ${REVIEW_STATUS_TEXT[review.status] ?? '未知状态'}`, review.status === 'published' ? 'ok' : 'bad'));
  ov.append(overviewItem('复核编号 verify_id', review.meta.verify_id ?? '未产出（复核未运行）', review.meta.verify_id ? '' : 'bad'));
  ov.append(overviewItem('已发布事实', `已发布事实 ${review.published_facts.length} 项`));
  ov.append(overviewItem('阻断事实', `阻断事实 ${review.blocked_facts.length} 项`, review.blocked_facts.length ? 'bad' : ''));
  ov.append(overviewItem('组合结论', review.portfolio_published ? '组合已发布' : '组合不发布', review.portfolio_published ? 'ok' : 'bad'));
  body.append(ov);
  if (review.degraded.length > 0) {
    const db = el('div', { class: 'banner warn-banner' });
    db.append(el('strong', {}, ['降级说明']));
    for (const d of review.degraded) db.append(el('div', {}, [`${d.scope ? `「${scopeLabel(d.scope)}」` : ''}${reasonText(d.code)}：${d.message}`]));
    body.append(db);
  }

  /* 已发布事实 */
  body.append(el('div', { class: 'rp-sub' }, [`已发布事实（${review.published_facts.length} 项）`]));
  if (review.published_facts.length === 0) {
    body.append(el('div', { class: 'rp-calc rp-bad-text' }, ['没有通过复核的事实，本次不发布任何数字。']));
  } else {
    body.append(table(
      ['事实', 'fact_id', '展示值', '公式编号', '状态'],
      review.published_facts.map((f) => [
        factName(f.fact_id), f.fact_id, publishedDisplay(f, provById.get(f.fact_id)), f.formula_id, statusTag('已发布', 'ok'),
      ]),
    ));
  }

  /* 未发布事实 */
  body.append(el('div', { class: 'rp-sub' }, [`未发布事实（${review.blocked_facts.length} 项）`]));
  if (review.blocked_facts.length === 0 && review.blocked_symbols.length === 0) {
    body.append(el('div', { class: 'rp-calc unchanged' }, ['无未发布事实。']));
  }
  if (review.blocked_facts.length > 0) {
    body.append(table(
      ['事实', 'fact_id', '状态', '原因代码', '说明'],
      review.blocked_facts.map((f) => [
        factName(f.fact_id),
        f.fact_id,
        statusTag(`未发布 · ${FINAL_STATUS_TEXT[f.final_status] ?? f.final_status}`, 'bad'),
        f.reason_codes.join('、'),
        f.reason_summary ?? f.reason_codes.map((c) => REASON_TEXT[c] ?? c).join('；'),
      ]),
    ));
  }
  for (const s of review.blocked_symbols) {
    body.append(el('div', { class: 'rp-calc rp-bad-text' }, [
      `「${s.symbol}」未进入计算（${reasonText(s.code)}）：该标的没有任何事实条目，也不展示替代数字。`,
    ]));
  }

  /* 复核检查 */
  body.append(el('div', { class: 'rp-sub' }, ['复核检查']));
  const v = review.verify;
  if (!v) {
    body.append(el('div', { class: 'rp-calc rp-bad-text' }, [
      `复核检查未运行：${review.degraded.length ? review.degraded.map((d) => d.message).join('；') : '未进入计算'}。没有任何数字经过复核。`,
    ]));
  } else {
    const idTotal = v.identity_checks.length;
    const checks = el('div', { class: 'rp-overview' });
    checks.append(overviewItem('事实独立重算', `${v.summary.pass}/${v.summary.n_facts} 通过${v.summary.fail ? ` · ${v.summary.fail} 项未通过` : ''}`, v.summary.fail ? 'bad' : 'ok'));
    checks.append(overviewItem('恒等式校验', `${idTotal - v.summary.identities_fail}/${idTotal} 通过`, v.summary.identities_fail ? 'bad' : 'ok'));
    checks.append(overviewItem('计算路径完整性', v.provenance_complete ? '完整' : '不完整', v.provenance_complete ? 'ok' : 'bad'));
    checks.append(overviewItem('悬空来源引用', v.dangling_refs.length ? `${v.dangling_refs.length} 处` : '无', v.dangling_refs.length ? 'bad' : 'ok'));
    body.append(checks);
    if (v.dangling_refs.length > 0) {
      const db = el('div', { class: 'banner warn-banner' });
      db.append(el('strong', {}, ['悬空来源引用（相关事实不发布）']));
      for (const d of v.dangling_refs) db.append(el('div', {}, [`「${scopeLabel(d.fact_scope)}」引用的成交 ${d.ref.key} 无法定位到账单源文件的行`]));
      body.append(db);
    }
    // 只展示通过/未通过，不展示左右两侧数值：被扣发的组合恒等式两侧值同样不得外露
    body.append(table(
      ['编号', '恒等式', '范围', '结果'],
      v.identity_checks.map((i) => [
        i.identity_id, i.name, scopeLabel(i.scope),
        i.verdict === 'pass' ? statusTag('通过', 'ok') : statusTag(`未通过 · ${i.code}`, 'bad'),
      ]),
    ));
  }

  /* 重算记录 */
  body.append(el('div', { class: 'rp-sub' }, ['重算记录']));
  const attempts = review.meta.recompute_attempts;
  if (review.recompute_log.length === 0) {
    body.append(el('div', { class: 'rp-calc unchanged' }, [
      `重算尝试 ${attempts} 次 · 未提供重算来源${v && v.summary.fail === 0 && v.summary.identities_fail === 0 ? '（本次复核已通过，无需重算）' : ''}。`,
    ]));
  } else {
    body.append(el('div', { class: 'rp-calc unchanged' }, [
      `重算尝试 ${attempts} 次 · 本轮用户账单链路未提供重算来源，复核未通过的事实保持不发布。`,
    ]));
    body.append(table(
      ['记录编号', '第几次', '使用来源', '结果', '处理', '代码'],
      review.recompute_log.map((r) => [
        r.recompute_id,
        String(r.attempt),
        r.path_used === 'none' ? '无' : r.path_used,
        RECOMPUTE_RESULT_TEXT[r.result] ?? r.result,
        RECOMPUTE_FINAL_TEXT[r.final_status] ?? r.final_status,
        r.code ?? '',
      ]),
    ));
  }

  det.append(body);
  return det;
}

function evidenceSection(b, review, scope) {
  const evd = el('details', { class: 'rp-evidence' });
  evd.append(el('summary', {}, ['查看证据与计算路径']));
  const body = el('div', { class: 'rp-evidence-body' });
  const factScope = scope === 'pool' ? 'portfolio' : scope;
  const prov = b.provenance;

  if (!prov) {
    body.append(el('div', { class: 'rp-calc rp-bad-text' }, [
      `计算路径不可用：本次没有产出计算路径（${review.degraded.length ? review.degraded.map((d) => reasonText(d.code)).join('；') : '原因未知'}）。没有可追溯的数字，因此不发布、不标记为已验证。`,
    ]));
  } else {
    const items = prov.items.filter((it) => it.scope === factScope);
    const pubById = new Map(review.published_facts.map((f) => [f.fact_id, f]));
    const blkById = new Map(review.blocked_facts.map((f) => [f.fact_id, f]));
    body.append(el('div', { class: 'rp-sub' }, [
      `当前范围「${scopeLabel(scope)}」· 计算路径 ${items.length} 项 · 已发布 ${items.filter((it) => pubById.has(it.fact_id)).length} 项`,
    ]));
    if (prov.blocked || prov.dangling_refs.length > 0) {
      const pb = el('div', { class: 'banner warn-banner' });
      pb.append(el('strong', {}, ['计算路径存在阻断或悬空引用：相关事实不发布、不标记为已验证']));
      for (const d of prov.dangling_refs) pb.append(el('div', {}, [`${factName(d.fact_id)} · ${d.message}`]));
      body.append(pb);
    }
    if (items.length === 0) {
      body.append(el('div', { class: 'rp-calc rp-bad-text' }, [
        `「${scopeLabel(scope)}」没有计算路径：${b.blockedSymbols.includes(scope) ? '该标的缺价或超出行情支持范围，未进入计算' : '引擎未输出该范围的事实'}，不展示替代数字。`,
      ]));
    }
    for (const it of items) body.append(factEvidence(it, pubById.get(it.fact_id), blkById.get(it.fact_id), review.meta.verify_id));
  }

  body.append(el('div', { class: 'rp-dev' }, [
    '口径与来源：数字由本地确定性引擎计算，并经复核（runReview）筛选后才发布；行情为 m0 合成夹具（占位代码、合成价格；非真实行情，清单未签收·草案口径）。原始 CSV 仅在本机读取与校验，未上传。',
  ]));
  evd.append(body);
  return evd;
}

function factEvidence(it, pub, blk, verifyId) {
  const published = !!pub && !it.blocked;
  const det = el('details', { class: `rp-fact ${published ? 'ok' : 'bad'}` });
  const sum = el('summary', {});
  sum.append(el('span', { class: 'rp-fact-name' }, [factName(it.fact_id)]));
  sum.append(el('span', { class: 'rp-fact-val' }, [published ? publishedDisplay(pub, it) : '未发布']));
  sum.append(published
    ? statusTag('已发布', 'ok')
    : statusTag(blk ? `未发布 · ${FINAL_STATUS_TEXT[blk.final_status] ?? blk.final_status}` : '未发布', 'bad'));
  det.append(sum);

  const body = el('div', { class: 'rp-fact-body' });
  if (published) {
    body.append(el('div', { class: 'rp-calc unchanged' }, [`复核通过并发布（${verifyId}）。`]));
  } else {
    const reasons = blk ? blk.reason_codes : [];
    const warn = el('div', { class: 'banner warn-banner' });
    warn.append(el('strong', {}, ['该事实未发布，不能作为有效结果引用']));
    for (const c of reasons) warn.append(el('div', {}, [reasonText(c)]));
    if (blk && blk.reason_summary) warn.append(el('div', {}, [blk.reason_summary]));
    for (const e of it.errors) warn.append(el('div', {}, [`${e.code} · ${e.message}`]));
    if (!blk && it.errors.length === 0) warn.append(el('div', {}, ['复核结果中没有该事实的发布记录。']));
    body.append(warn);
  }

  appendFactDetails(body, it, published, '未发布：不展示该步骤的中间数值。');
  det.append(body);
  return det;
}

function appendFactDetails(body, it, showValues, hiddenStepText) {
  body.append(el('div', { class: 'rp-kv' }, [el('b', {}, ['公式编号']), it.formula_id ?? '缺少公式编号（不发布）']));
  body.append(el('div', { class: 'rp-kv' }, [el('b', {}, ['公式']), it.formula_text ?? '公式注册表中没有该公式']));
  const inputs = it.inputs || {};
  body.append(el('div', { class: 'rp-kv' }, [
    el('b', {}, ['输入']),
    `成交 ${Array.isArray(inputs.trade_ids) ? inputs.trade_ids.join('、') : '无'}；${inputs.close_basis ?? `估值日收盘价（合成行情）${inputs.close}`}`,
  ]));

  const refs = el('div', { class: 'rp-kv' }, [el('b', {}, ['来源引用'])]);
  const refList = el('div', { class: 'rp-refs' });
  for (const r of it.source_refs) refList.append(el('span', { class: 'rp-ref' }, [`${r.key} · ${r.file} 第 ${r.line} 行`]));
  for (const e of it.errors) {
    if (e.code === 'E_PROV_DANGLING_REF') refList.append(el('span', { class: 'rp-ref bad' }, [`悬空引用：${e.message}`]));
  }
  if (it.source_refs.length === 0 && !it.errors.length) refList.append(el('span', { class: 'rp-ref bad' }, ['无可定位来源（不发布）']));
  refs.append(refList);
  body.append(refs);

  body.append(el('div', { class: 'rp-sub2' }, ['计算步骤']));
  const ol = el('ol', { class: 'rp-steps' });
  for (const s of it.steps ?? []) {
    const li = el('li', {});
    li.append(el('b', {}, [`${s.step_id} ${s.label}`]));
    if (!showValues && s.kind !== 'sort') {
      li.append(el('div', { class: 'rp-calc unchanged' }, [hiddenStepText]));
    } else if (s.kind === 'lines' && Array.isArray(s.lines)) {
      li.append(el('div', { class: 'rp-calc unchanged' }, [s.detail]));
      li.append(table(
        ['序号', '成交', '日期', '方向', '价格', '数量', '来源行'],
        s.lines.map((l) => [String(l.seq), l.trade_id, l.trade_date, SIDE_TEXT[l.side] ?? l.side, String(l.price), String(l.quantity),
          l.ref && l.ref.file ? `${l.ref.file} 第 ${l.ref.line} 行` : '无法定位']),
      ));
    } else if (s.kind === 'sort') {
      li.append(el('div', { class: 'rp-calc unchanged' }, [`处理顺序：${(s.order ?? []).join(' → ')}`]));
    } else {
      li.append(el('div', { class: 'rp-calc unchanged' }, [s.detail]));
    }
    ol.append(li);
  }
  body.append(ol);
}

/* 演示模式条目：未经 runReview，不使用发布/复核措辞；provenance 自身阻断时不展示数值。 */
function demoFactEvidence(it) {
  const usable = !it.blocked;
  const det = el('details', { class: `rp-fact ${usable ? 'demo' : 'bad'}` });
  const sum = el('summary', {});
  sum.append(el('span', { class: 'rp-fact-name' }, [factName(it.fact_id)]));
  sum.append(el('span', { class: 'rp-fact-val' }, [usable ? (it.display ?? '（引擎未提供展示值）') : '演示计算路径不可用']));
  sum.append(el('span', { class: 'rp-fact-fid' }, [it.formula_id ?? '缺少公式编号']));
  if (!usable) sum.append(statusTag('存在阻断项', 'bad'));
  det.append(sum);

  const body = el('div', { class: 'rp-fact-body' });
  if (!usable) {
    const warn = el('div', { class: 'banner warn-banner' });
    warn.append(el('strong', {}, ['该条演示计算路径存在阻断项，不能作为有效结果引用']));
    for (const e of it.errors) warn.append(el('div', {}, [`${e.code} · ${e.message}`]));
    body.append(warn);
  }
  appendFactDetails(body, it, usable, '存在阻断项：不展示该步骤的中间数值。');
  det.append(body);
  return det;
}