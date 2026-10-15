// 报告 · 证据（引擎接线版，浅色样板）
// 数据链路：页面只调 src/demo/adapter.js；adapter 内部走引擎（CSV → 行情缓存 → indicators → provenance）。
// 标注：当前为合成演示数据（占位代码、合成价格、m0 合成行情夹具）——非真实账户、非真实行情。
// 展示规则：数字一律使用引擎 display 字段（F-2），页面不重新格式化；阻断时不发布对应结论；不可计算项显示原因，不用 "—" 掩盖。
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';

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

export function renderReport(root, ctx) {
  const page = el('div', { class: 'report-page' });
  root.append(page);
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