// 报告 · 证据（引擎接线版，浅色样板）
// 数据链路：页面只调 src/demo/adapter.js；adapter 内部走引擎。
//   演示模式：夹具 CSV → csvNormalize → marketCache(合成夹具) → indicators → provenance（A/A′ 对比）。
//   用户账单模式（bill.confirmed 且 sourceType=local）：确认后的标准化账单 → 真实缓存签收门 → runReview 发布门槛 → published_facts。
// 标注：行情来源与支持范围取自 adapter；演示使用合成夹具，用户模式额外标注文件名与数据模式。
// 展示规则：数字一律使用引擎 display 字段（F-2），页面不重新格式化；用户模式只发布 runReview.published_facts 中的事实，
//   组合结论只在 review.portfolio_published 时展示（B4）；阻断时不发布对应结论，不回退演示数据。
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';
import { renderGhostChart } from '../components/ghostChart.js';

const WIRING_NOTE = '契约页已接入候选模板与历史情境模拟（候选口径），契约不会自动改变本报告结论。尚未接入：对话页事实回跳；在线问答仅接站点同源复述边界，尚未完成真实服务验证。';
const NO_TRADE_ADVICE = '不要据此作交易判断。';

/* —— 本次分析摘要：只取 bundle / review 已有字段，不计算数字 —— */
function sumItem(label, value, kind = '') {
  return el('div', { class: `rp-sum-item ${kind}`.trim() }, [el('div', { class: 'k' }, [label]), el('div', { class: 'v' }, [value])]);
}

function valuationText(v) {
  if (!v) return '不可用';
  if (v.blocked) return `${v.requested_date} 无法解析（不改用其他日期）`;
  return v.requested_date === v.effective_date ? v.effective_date : `${v.requested_date} → 有效交易日 ${v.effective_date}`;
}

function marketSourceLabel(b) {
  const source = b.marketSource;
  if (source?.id === 'real-cache' && (source.signed !== true || source.gate?.signed !== true || source.gate?.usable !== true)) {
    return '真实行情缓存（不可用）';
  }
  return source?.label || (b.sourceType === 'local' ? '行情来源不可用' : '合成演示行情（非真实行情）');
}

function marketText(b) {
  const range = b.supportScope?.range ?? b.marketRange;
  return `${marketSourceLabel(b)} · ${range ? `${range.start} → ${range.end}` : '支持日期不可用'}`;
}

function metadataText(value) {
  return value === null || value === undefined || value === '' ? '不可用' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function marketSourceSection(b) {
  const source = b.marketSource ?? {};
  const support = b.supportScope ?? {};
  const snapshot = support.snapshot ?? b.snapshot ?? {};
  const gate = source.gate;
  const signedText = (value) => value === true ? 'true' : value === false ? 'false' : '未知';
  return el('div', { class: 'rp-market-source' }, [
    sectionHead('行情来源与支持范围', marketText(b)),
    el('div', {}, [`支持日期范围：${support.range ? `${support.range.start} 至 ${support.range.end}` : '不可用'}`]),
    el('div', {}, [`支持标的：${support.symbols?.join('、') || '不可用'}；固定行情截止日（asOfDate）：${metadataText(b.asOfDate)}`]),
    el('div', {}, [`签收状态 signed：${signedText(source.signed)}；支持范围 signed：${signedText(support.signed)}；签收门 gate：usable=${signedText(gate?.usable)}，signed=${signedText(gate?.signed)}`]),
    el('div', {}, [`签收门原因：${gate ? metadataText(gate.reason ?? '无') : '不可用'}；详情：${gate ? metadataText(gate.detail ?? '无') : '不可用'}`]),
    el('div', {}, [`来源标识：${metadataText(source.id)}；artifact：${metadataText(source.artifact)}；manifestVersion：${metadataText(source.manifestVersion)}`]),
    el('div', {}, [`快照 snapshot：${metadataText(source.snapshotId ?? snapshot.snapshot_id)}；抓取时间 fetchTime：${metadataText(source.fetchTime ?? snapshot.fetch_time)}`]),
    el('div', {}, [`行情数据来源 dataSource：${metadataText(source.dataSource)}；交易日历来源 calendarSource：${metadataText(source.calendarSource)}`]),
    el('div', {}, ['计算口径：金额估值使用不复权价格；前复权仅用于走势展示；费用、税费仅记录，不计入收益公式。']),
    el('div', {}, ['公司行为边界：v1 不检测、不校正送转/拆合股；300750 任一 2023-04-26 事件前交易都会保守阻断（即使实际持仓在事件前已清仓，买入后持有的对照路径仍可能跨越该事件，无法断言放行是安全的），不用不复权价格跳变推断交易损耗；这是针对已知事件的额外限制，不是通用公司行为检测。']),
  ]);
}

function summaryCard(headline, ok, items) {
  return el('div', { class: `rp-summary ${ok ? 'ok' : 'bad'}` }, [
    el('div', { class: 'rp-sec' }, ['本次分析摘要']),
    el('div', { class: 'rp-sum-head' }, [headline]),
    el('div', { class: 'rp-sum-grid' }, items),
  ]);
}

// 演示链路未经 runReview：不使用“发布 / 复核”措辞
function demoSummary(b) {
  const ok = b.status === 'ok';
  const conclusion = ok
    ? '组合结果：已由本地引擎算出（演示数据，未经复核发布流程）'
    : b.status === 'partial' ? '组合结果：不可用（存在缺价标的，组合整体不出结论）' : '结果不可用：数据被阻断';
  const reasons = b.errors.slice(0, 2).map((e) => e.message).join('；');
  return summaryCard(
    ok ? '演示结论：以下数字来自合成账单与合成行情，只用于熟悉流程，不代表你的真实交易。' : `存在阻断：${reasons || '数据不完整'}。${NO_TRADE_ADVICE}`,
    ok,
    [
      sumItem('数据来源', `演示账单 · ${b.scenarioMeta.label}（合成）`),
      sumItem('行情状态', marketText(b)),
      sumItem('估值日', valuationText(b.valuation)),
      sumItem('结论状态', conclusion, ok ? 'ok' : 'bad'),
    ],
  );
}

function userSummary(b, review) {
  const published = !!review && review.portfolio_published === true;
  let headline;
  if (published) {
    headline = `本次结论：组合结果已通过复核并发布；数字基于${marketSourceLabel(b)}与本次已确认账单，不构成投资建议。`;
  } else {
    const reasons = review ? collectBlockReasons(b, review, 'pool') : b.errors.map((e) => ({ code: e.code, message: e.message }));
    const text = reasons.slice(0, 3).map((i) => visibleReason(i.message, i.code)).join('；') || '复核输出中没有具体阻断记录';
    const partial = review && review.published_facts.length > 0 ? '部分标的结果已通过复核，可切换标的查看。' : '';
    headline = `存在阻断：${text}。${NO_TRADE_ADVICE}${partial}`;
  }
  return summaryCard(headline, published, [
    sumItem('数据来源', `已确认本地账单 · ${b.fileName || '（未知文件）'}`),
    sumItem('行情状态', marketText(b)),
    sumItem('支持标的', b.supportScope?.symbols?.join('、') || '不可用'),
    sumItem('行情截止日（asOfDate）', metadataText(b.asOfDate)),
    sumItem('估值日', valuationText(b.valuation)),
    sumItem('结论状态', !review ? '组合结果未发布（复核未运行）' : published ? '组合结果已发布（已通过复核）' : '组合结果未发布', published ? 'ok' : 'bad'),
  ]);
}

function sectionHead(title, note) {
  return el('div', { class: 'rp-sec-wrap' }, [el('div', { class: 'rp-sec' }, [title]), note ? el('div', { class: 'muted small' }, [note]) : null]);
}

const FACT_HELP = Object.freeze({
  buyCost: '账单内全部买入成交金额之和（成交价 × 数量），用作收益率的分母。',
  sellProceeds: '账单内全部卖出成交金额之和（成交价 × 数量）。',
  heldShares: '买入总股数减去卖出总股数，即估值日仍持有的股数。',
  actualValue: '你的实际结果：卖出所得加上剩余持仓按估值日收盘价折算的价值。',
  ghostValue: '对照结果：假设每次买入后一直持有不动，按估值日收盘价折算的价值。',
  actualRet: '实际期末价值相对买入成本的收益率。',
  ghostRet: '对照期末价值相对买入成本的收益率。',
  dragMoney: '对照期末价值减去实际期末价值；正值表示买卖时机让结果比持有不动少了这么多。',
  drag: '对照收益减去实际收益（百分点）；正值＝相对损耗，负值＝实际操作优于对照。',
});

function factPlain(it, reviewLine) {
  const i = String(it.fact_id).indexOf('.');
  const key = i > 0 ? it.fact_id.slice(i + 1) : it.fact_id;
  const ids = it.inputs && Array.isArray(it.inputs.trade_ids) ? it.inputs.trade_ids : [];
  return el('div', { class: 'rp-plain' }, [
    el('div', { class: 'rp-kv' }, [el('b', {}, ['这项结果代表什么']), FACT_HELP[key] ?? '引擎输出的一项计算结果。']),
    el('div', { class: 'rp-kv' }, [el('b', {}, ['来源于哪些交易']), ids.length ? `成交 ${ids.join('、')}` : '没有可定位的成交']),
    el('div', { class: 'rp-kv' }, [el('b', {}, [reviewLine[0]]), reviewLine[1]]),
  ]);
}

function billStatusText(bill) {
  if (bill.status === 'confirmed') return `已确认（${bill.trades.length} 条）`;
  if (bill.status === 'loaded') return `已加载（${bill.trades.length} 条，未确认）`;
  return '未加载（演示数据可直接查看）';
}

function metric(label, value, note, kind, sub, tech = null) {
  const card = el('div', { class: `rp-metric ${kind}`.trim() });
  card.append(el('div', { class: 'label' }, [label]));
  card.append(el('div', { class: 'value' }, [value]));
  if (sub) card.append(el('div', { class: 'value-sub' }, [sub]));
  if (note) card.append(el('div', { class: 'note' }, [note]));
  if (tech) card.append(tech);
  return card;
}

function stripErrorCodes(text) {
  return String(text ?? '')
    .replace(/（[^）]*\b(?:[BFRQS]-\d+|[BFRQS]\d+)\b[^）]*）/g, '')
    .replace(/\b(?:[BFRQS]-\d+|[BFRQS]\d+)\b/g, '')
    .replace(/\b[EW]_[A-Z0-9_]+\b\s*·?\s*/g, '')
    .trim();
}

function visibleReason(text, code) {
  return stripErrorCodes(text) || REASON_TEXT[code] || '未提供具体原因';
}

function displayLabel(text) {
  return String(text ?? '').replace(/（Q\d+）/g, '');
}

function labelsTechNote(labels) {
  return el('details', { class: 'rp-tech' }, [
    el('summary', {}, ['技术说明（口径编号）']),
    el('div', { class: 'muted small' }, [`费用税费口径：${labels.fees_taxes}；分红口径：${labels.dividend}`]),
  ]);
}

function stockTechNote() {
  return el('details', { class: 'rp-tech rp-metric-tech' }, [
    el('summary', {}, ['技术说明']),
    el('div', { class: 'muted small' }, ['口径编号 Q9：股票本身涨幅的公式尚未定义，暂不计算，也不使用替代值。']),
  ]);
}

// 报告错误/警告：中文说明与行号保持可见，原始错误码收进技术详情
function reportIssues(title, items, warn = true) {
  const box = el('div', { class: `banner ${warn ? 'warn-banner' : ''}`.trim() });
  box.append(el('strong', {}, [title]));
  for (const e of items) {
    const meta = [e.symbol ? `标的：${e.symbol}` : '', e.line ? `第 ${e.line} 行` : '', e.column ? `列：${e.column}` : ''].filter(Boolean).join(' · ');
    box.append(el('div', {}, [`${meta ? `${meta} · ` : ''}${visibleReason(e.message, e.code)}`]));
  }
  box.append(el('details', { class: 'rp-tech' }, [
    el('summary', {}, ['技术详情（错误码）']),
    ...items.map((e) => el('div', { class: 'muted small' }, [
      `${e.code}${e.kind ? ` · kind：${e.kind}` : ''}${e.symbol ? ` · symbol：${e.symbol}` : ''}${e.line ? `（第 ${e.line} 行）` : ''}${e.column ? ` · ${e.column}` : ''}${e.message ? ` · ${e.message}` : ''}`,
    ])),
  ]));
  return box;
}

function blockedReasonDetails(items, label = '技术详情（错误码）') {
  return el('details', { class: 'rp-tech' }, [
    el('summary', {}, [label]),
    ...items.map((i) => el('div', { class: 'muted small' }, [i.code])),
  ]);
}

/* —— 单笔反事实区（S1 幽灵线；演示与用户账单共用）——
   数据一律来自 adapter.loadSellCounterfactual（内部唯一调用 replaceSell）；
   页面不计算 actual/ghost/cf/gap/收盘价，引擎 display 原样展示。 */
function cfSection({ trades, symbol, selectedId, set, bill }) {
  const box = el('div', { class: 'rp-cf' });
  box.append(el('div', { class: 'rp-sub' }, ['如果当时没有卖出这一笔，结果会怎样？']));
  box.append(el('div', { class: 'muted small' }, ['单笔反事实：只假设选中的这一笔卖出没有发生，其余交易不变；不是对未来的预测。']));
  const body = el('div', {});
  box.append(body);
  // 跨标的/跨场景残留防护：selectedId 不属于当前标的的卖出笔时传 null（adapter 默认该标的按时间第一笔）
  const applicable = typeof selectedId === 'string'
    && trades.some((t) => t && t.symbol === symbol && t.side === 'sell' && t.trade_id === selectedId);
  demo.loadSellCounterfactual({ trades, symbol, tradeId: applicable ? selectedId : null, bill })
    .then((cf) => {
      if (!cf.ok) {
        body.replaceChildren(el('div', { class: 'rp-error' }, [
          el('div', {}, [`该反事实结论不发布：${visibleReason(cf.message, cf.code)}`]),
          el('details', { class: 'rp-tech' }, [
            el('summary', {}, ['技术详情（错误码）']),
            el('div', { class: 'muted small' }, [cf.code]),
          ]),
        ]));
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
      const r = cf.replace;
      const gap = !!cf.series && (cf.series.complete === false || cf.series.missing_dates.length > 0);
      body.append(el('div', { class: 'rp-cf-lead' }, [
        `当前选中：${r.replaced.trade_id}（${r.replaced.trade_date} 卖出 ${r.replaced.price} × ${r.replaced.quantity}）。`,
        `结论：${gap ? `可发布，但价格序列不完整（缺 ${cf.series.missing_dates.join('、')}），图中对应日期断线` : '可发布'}；`,
        `相对改善 ${r.display.recoveredPP}（正值表示不卖这笔会更好，负值表示这笔卖出更好）。`,
      ]));
      const chartBox = el('div', {});
      body.append(chartBox);
      renderGhostChart(chartBox, cf);
      if (bill) {
        chartBox.querySelector('.gc-caption')?.replaceChildren(el('span', {}, [
          `${cf.marketSource?.label || '行情来源不可用'}：仅替换所选卖出笔，其余成交不变；不构成投资建议`,
        ]));
      }
      body.append(el('div', { class: 'rp-calc' }, [
        `本次模拟：不发生 ${r.replaced.trade_id} 这笔卖出（${r.replaced.trade_date} · ${r.replaced.price} × ${r.replaced.quantity}）｜假设结果价值 ${r.display.cfValue} ｜ 假设收益 ${r.display.cfRet} ｜ 相对改善 ${r.display.recoveredPP} ｜ 剩余损耗金额 ${r.display.remainingDragMoney}`,
      ]));
      body.append(el('details', { class: 'rp-cf-tech' }, [
        el('summary', {}, ['技术口径与公式标识']),
        el('div', { class: 'rp-calc unchanged' }, [
          `说明：正的“相对改善”表示不卖这笔会更好；负值表示这笔卖出反而优于持有，不是错误。方法：S1 单笔卖出替换。公式标识：${[...new Set(Object.values(r.formula_ids))].join(' / ')}（可在「查看证据与计算路径」中复核）。`,
        ]),
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
  return el('div', { class: 'rp-cf rp-cf-hint muted' }, ['请选择一个标的查看单笔卖出反事实（组合范围不绘制单笔反事实图）。']);
}

export function renderReport(root, ctx) {
  const bill = ctx.state.bill;
  const report = { ...ctx.state.report };
  ctx = { ...ctx, state: { ...ctx.state, bill, report } };
  const page = el('div', { class: 'report-page' });
  root.replaceChildren(page);
  if (bill.status === 'confirmed' && bill.sourceType === 'local') {
    page.append(el('div', { class: 'rp-loading' }, ['加载用户账单报告…（校验真实行情缓存签收门）']));
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
        `报告数据加载失败：${String(e && e.message ? e.message : e)}（请确认本地服务已启动后刷新页面）`,
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
  titleBox.append(el('div', { class: 'rp-kicker' }, ['演示报告']));
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
  page.append(demoSummary(b));

  /* —— 状态条：数据模式 / 行情 / 估值日 / 口径（常显，不折叠）—— */
  const status = el('div', { class: 'rp-status' });
  status.append(el('span', { class: 'rp-chip demo' }, [b.dataMode.label]));
  status.append(el('span', { class: 'rp-chip' }, [
    b.valuation
      ? (b.valuation.blocked ? `估值日：${b.valuation.requested_date} 无法解析` : `估值日：${b.valuation.requested_date} → ${b.valuation.effective_date}`)
      : '估值日：不可用',
  ]));
  status.append(el('span', { class: 'rp-chip' }, [`口径：${displayLabel(b.labels.fees_taxes)}；${displayLabel(b.labels.dividend)}`]));
  page.append(status);
  page.append(labelsTechNote(b.labels));

  /* —— 诊断：错误（阻断）与警告（照实展示，不静默隐藏；错误码折叠）—— */
  if (b.errors.length > 0) page.append(reportIssues('阻断/错误（对应结论不发布）', b.errors));
  if (b.warnings.length > 0) page.append(reportIssues('警告（照实展示）', b.warnings, false));

  /* —— 当前范围：组合 / 标的 —— */
  const entry = scope === 'pool' ? b.pool : b.perStock[scope];
  const scopeBlocked = scope === 'pool' ? (!b.pool && b.poolBlocked) : (!entry && b.blockedSymbols.includes(scope));
  page.append(sectionHead(`核心指标 · ${scopeLabel(scope)}`, '实际收益 vs 买入后持有不动（对照）；择时损耗＝对照 − 实际。'));

  if (scopeBlocked) {
    const blockedBox = el('div', { class: 'rp-error' });
    blockedBox.append(el('div', {}, [`「${scope === 'pool' ? '组合' : scope}」结果不发布：`]));
    const reasons = scope === 'pool'
      ? b.errors.filter((e) => e.code && (e.code.indexOf('E_PRICE') === 0 || e.code.indexOf('E_VALUATION') === 0))
      : b.errors.filter((e) => e.message && e.message.includes(scope));
    const items = reasons.length ? reasons : b.errors;
    for (const r of items) blockedBox.append(el('div', {}, [`· ${visibleReason(r.message, r.code)}`]));
    blockedBox.append(el('div', { class: 'muted small' }, ['不使用替代值、其他估值日或“剩余标的组合”冒充完整结果。']));
    blockedBox.append(blockedReasonDetails(items));
    page.append(blockedBox);
  } else if (!entry) {
    page.append(el('div', { class: 'rp-error' }, [`未找到「${scope}」的结果（引擎输出不含该范围，照实提示，不猜测）。`]));
  } else {
    const metrics = el('div', { class: 'rp-metrics' });
    metrics.append(metric('实际收益', entry.display.actualRet, '你的实际操作结果（合成样例）', 'actual'));
    metrics.append(metric('对照收益', entry.display.ghostRet, '买入不动口径：买入后持有不动的对照路径', 'ghost'));
    metrics.append(metric('择时损耗', entry.display.drag, '对照 − 实际；正值＝相对损耗，负值＝实际操作优于对照', 'drag', entry.display.dragMoney));
    metrics.append(metric('股票本身涨幅', '口径未定义', '暂不计算，也不使用替代值。', 'stock', null, stockTechNote()));
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
      `记录值（仅记录与标注，不计入收益公式）：费用合计 ${entry.recorded.fee_recorded_sum} 元；税费合计 ${entry.recorded.tax_recorded_sum} 元；` +
      `费用缺失行 ${entry.recorded.fee_missing_lines.length ? entry.recorded.fee_missing_lines.join('、') : '无'}；税费缺失行 ${entry.recorded.tax_missing_lines.length ? entry.recorded.tax_missing_lines.join('、') : '无'}`,
    ]);
    page.append(rec);
    page.append(el('details', { class: 'rp-tech' }, [
      el('summary', {}, ['技术说明']),
      el('div', { class: 'muted small' }, ['口径编号 Q1：费用与税费未计入收益公式；缺失行按 0 计并标注，仅用于对账记录。']),
    ]));
  }

  if (scope === 'pool') {
    page.append(cfPoolHint());
  } else if (!scopeBlocked && entry) {
    page.append(cfSection({ trades: b.trades, symbol: scope, selectedId: state.report.cfTradeId, set: ctx.set }));
  }

  /* —— 证据：演示计算路径（provenance；未经 runReview，不使用复核发布措辞）—— */
  page.append(sectionHead('证据与计算路径', '每项先说明代表什么、来自哪些成交；公式编号、原始行号与计算步骤在展开后查看。演示模式未经过复核发布流程。'));
  const det = el('details', { class: 'rp-evidence' });
  det.append(el('summary', {}, [
    '查看证据与计算路径',
    el('span', { class: 'rp-summary-note' }, ['以下为演示计算路径，未经过复核发布流程，不代表复核结果。']),
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
    `口径与来源：数字由本地确定性引擎计算（账单校验 → 行情取价 → 指标计算 → 计算路径）；行情来源：${marketText(b)}（占位代码、合成价格；非真实行情）。本页为演示账单，未运行复核流程（runReview）；本地 CSV 请在导入页选择（仅本机处理，不上传）。${WIRING_NOTE}`,
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
          el('span', { class: 'p' }, [FACT_LABELS[c.field] ?? c.field]),
          el('span', { class: 'from' }, [c.from]),
          el('span', { class: 'arrow' }, ['→']),
          el('span', { class: 'to' }, [c.to]),
        ]));
      }
      if (delta.changed.length === 0) grid.append(el('div', { class: 'rp-delta-row' }, [el('span', { class: 'p' }, ['无字段变化'])]));
      d.append(grid);
      d.append(el('div', { class: 'rp-sub2' }, ['保持不变']));
      d.append(el('div', { class: 'rp-calc unchanged' }, [delta.unchanged.map((f) => FACT_LABELS[f] ?? f).join('、') || '（无）']));
    }
    page.append(d);
  }
}

function buildUserBillPage(page, b, ctx) {
  const { state } = ctx;
  const review = b.review;

  const top = el('div', { class: 'rp-top' });
  const titleBox = el('div', { class: 'rp-title' });
  titleBox.append(el('div', { class: 'rp-kicker' }, ['用户账单报告']));
  titleBox.append(el('h1', {}, ['报告 · 证据（本地账单）']));
  titleBox.append(el('div', { class: 'sub' }, [`本地账单 · 本地确定性引擎计算 · ${marketSourceLabel(b)}（原始 CSV 未上传）`]));
  top.append(titleBox);
  page.append(top);
  page.append(userSummary(b, review));

  const status = el('div', { class: 'rp-status' });
  status.append(el('span', { class: 'rp-chip' }, [`已确认本地账单（${b.fileName || '未知文件'}）· 文件名：${b.fileName || '未知文件'}（本机，未上传）`]));
  status.append(el('span', { class: 'rp-chip' }, [b.dataMode ? b.dataMode.label : '数据模式未知']));
  status.append(el('span', { class: `rp-chip ${b.marketSource?.signed === true && b.marketSource?.gate?.usable === true && b.marketSource?.gate?.signed === true ? 'ok' : 'cap'}` }, [marketSourceLabel(b)]));
  status.append(el('span', { class: 'rp-chip' }, [`固定 asOfDate：${metadataText(b.asOfDate)}`]));
  status.append(el('span', { class: 'rp-chip' }, [
    b.valuation
      ? (b.valuation.blocked ? `估值日：${b.valuation.requested_date} 无法解析` : `估值日：${b.valuation.requested_date} → ${b.valuation.effective_date}`)
      : '估值日：不可用',
  ]));
  status.append(el('span', { class: 'rp-chip' }, [`口径：${displayLabel(b.labels.fees_taxes)}；${displayLabel(b.labels.dividend)}`]));
  status.append(el('span', { class: `rp-chip ${review ? (review.status === 'published' ? 'ok' : review.status === 'degraded' ? 'demo' : 'cap') : 'cap'}` }, [
    review ? `复核：${reviewStatusText(review.status)}` : '复核未运行',
  ]));
  page.append(status);
  page.append(marketSourceSection(b));
  page.append(labelsTechNote(b.labels));

  if (b.errors.length > 0) page.append(reportIssues('阻断/错误（对应结论不发布）', b.errors));
  if (b.warnings.length > 0) page.append(reportIssues('警告（照实展示）', b.warnings, false));

  if (!review) {
    page.append(el('div', { class: 'rp-error' }, ['复核未运行：行情层阻断，无已发布事实（不回退演示数据）。']));
    return;
  }

  const stockScopes = Object.keys(b.factsByScope).filter((s) => s !== 'portfolio');
  const blockedFactScopes = (review.blocked_facts ?? []).map((f) => f.scope).filter((s) => s !== 'portfolio');
  const symbolKeys = ['pool', ...new Set([...stockScopes, ...b.blockedSymbols, ...blockedFactScopes])];
  const scope = symbolKeys.includes(state.report.symbol) ? state.report.symbol : 'pool';
  page.append(sectionHead(`核心指标 · ${scopeLabel(scope)}`, '实际收益 vs 买入后持有不动（对照）；择时损耗＝对照 − 实际。只展示已通过复核的数字。'));
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
    metrics.append(metric('实际收益', entry.actualRet.display, `你的实际操作结果（本机账单 · ${marketSourceLabel(b)}估值）`, 'actual'));
    metrics.append(metric('对照收益', entry.ghostRet.display, '买入不动口径：买入后持有不动的对照路径', 'ghost'));
    metrics.append(metric('择时损耗', entry.drag.display, '对照 − 实际；正值＝相对损耗，负值＝实际操作优于对照', 'drag', entry.dragMoney.display));
    metrics.append(metric('股票本身涨幅', '口径未定义', '暂不计算，也不使用替代值。', 'stock', null, stockTechNote()));
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
    page.append(cfSection({ trades: state.bill.trades, symbol: scope, selectedId: state.report.cfTradeId, set: ctx.set, bill: state.bill }));
  }

  page.append(sectionHead('证据与计算路径', '每项先说明代表什么、来自哪些成交、是否通过复核；公式编号、原始行号与计算步骤在展开后查看。未发布的结果不显示任何数值。'));
  page.append(reviewSection(review, b));
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
  published: '全部事实已发布',
  degraded: '部分事实已发布',
  blocked: '无可发布事实',
});

function reviewStatusText(status) {
  return REVIEW_STATUS_TEXT[status] ?? '状态未知';
}

const FINAL_STATUS_TEXT = Object.freeze({ blocked: '阻断', insufficient_evidence: '证据不足' });

const REASON_TEXT = Object.freeze({
  E_MARKET_CACHE_LOAD: '真实行情缓存加载失败，不回退演示行情',
  E_MARKET_CACHE_GATE: '真实行情缓存未通过签收门，不运行复核',
  E_MARKET_OUT_OF_SUPPORT: '标的不在已签收行情缓存支持清单（范围外，非当日缺价）',
  E_MARKET_TRADE_OUT_OF_RANGE: '成交日期超出行情缓存支持日期范围',
  E_MARKET_CORPORATE_ACTION_BOUNDARY: '账单跨越公司行为边界，当前口径无法处理',
  E_MARKET_ASOF_NOT_TRADING_DAY: '固定 asOfDate 不在缓存交易日历中，不改用其他日期',
  E_VALUATION_OUT_OF_RANGE: '估值日超出行情缓存支持日期范围',
  E_NO_EFFECTIVE_TRADING_DAY: '支持范围内没有不晚于请求估值日的交易日',
  E_VALUATION_BEFORE_LAST_TRADE: '有效估值日早于账单末笔成交日期',
  E_PRICE_MISSING: '估值日缺少不复权收盘价，不回退其他日期',
  E_REVIEW_PORTFOLIO_WITHHELD: '存在被阻断标的，组合结论整体扣发（不按剩余标的重算）',
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

const MARKET_BLOCK_CODES = new Set([
  'E_MARKET_CACHE_LOAD', 'E_MARKET_CACHE_GATE', 'E_MARKET_OUT_OF_SUPPORT',
  'E_MARKET_TRADE_OUT_OF_RANGE', 'E_MARKET_CORPORATE_ACTION_BOUNDARY', 'E_MARKET_ASOF_NOT_TRADING_DAY',
  'E_VALUATION_OUT_OF_RANGE', 'E_NO_EFFECTIVE_TRADING_DAY', 'E_VALUATION_BEFORE_LAST_TRADE',
  'E_PRICE_MISSING', 'E_REVIEW_PORTFOLIO_WITHHELD',
]);

// 范围外（准入阻断）标的集合：这类标的的复核对 null close 的记录会误称“缺价”，页面一律用 adapter 的准入原因。
function admissionBlockedSymbols(b) {
  return new Set((b.errors ?? []).filter((e) => e.code === 'E_MARKET_OUT_OF_SUPPORT' && e.symbol).map((e) => e.symbol));
}

function collectBlockReasons(b, review, scope) {
  const isPool = scope === 'pool';
  const factScope = isPool ? 'portfolio' : scope;
  const admission = admissionBlockedSymbols(b);
  const items = [];
  const add = (code, message) => {
    if (!code) return;
    const same = items.find((i) => i.code === code);
    if (same && (!message || same.message === message)) return;
    if (same && !same.message) { same.message = message; return; }
    items.push({ code, message: message || null });
  };
  for (const s of review.blocked_symbols ?? []) if ((isPool || s.symbol === scope) && !admission.has(s.symbol)) add(s.code, s.message);
  for (const e of b.errors) {
    if (isPool ? MARKET_BLOCK_CODES.has(e.code) : e.symbol === scope || (!e.symbol && e.message?.includes(scope))) add(e.code, e.message);
  }
  for (const d of review.degraded ?? []) {
    if (admission.has(d.scope)) continue;
    const related = !d.scope || d.scope === factScope || (isPool && MARKET_BLOCK_CODES.has(d.code));
    if (related) add(d.code, d.message);
  }
  for (const f of review.blocked_facts ?? []) if (f.scope === factScope) for (const c of f.reason_codes) add(c, null);
  return items;
}

function userBlockedBox(b, review, scope) {
  const name = scope === 'pool' ? '组合' : scope;
  const items = collectBlockReasons(b, review, scope);
  const marketRelated = items.some((i) => MARKET_BLOCK_CODES.has(i.code));
  const evidenceRelated = items.some((i) => !MARKET_BLOCK_CODES.has(i.code));
  const box = el('div', { class: 'rp-error' });
  box.append(el('div', {}, [`「${name}」结果不发布：`]));
  if (items.length === 0) {
    box.append(el('div', {}, ['· 复核输出中没有该范围的具体阻断记录（照实提示，不猜测原因）。']));
  }
  for (const i of items) box.append(el('div', {}, [`· ${visibleReason(i.message, i.code)}`]));
  if (items.length) box.append(blockedReasonDetails(items));
  if (marketRelated) {
    box.append(el('div', { class: 'muted small' }, [
      scope === 'pool'
        ? '存在行情侧阻断时不按剩余标的重新计算组合，也不回退其他日期；部分标的可显示不代表完整组合结论。'
        : '不使用替代值或其他估值日冒充该标的结果。',
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

function reviewSection(review, b = null) {
  const det = el('details', { class: 'rp-evidence' });
  det.append(el('summary', {}, ['复核与发布记录']));
  const body = el('div', { class: 'rp-evidence-body' });
  const provById = new Map((review.provenance ? review.provenance.items : []).map((i) => [i.fact_id, i]));

  /* 复核概览 */
  body.append(el('div', { class: 'rp-sub' }, ['复核概览']));
  const ov = el('div', { class: 'rp-overview' });
  ov.append(overviewItem('复核状态', reviewStatusText(review.status), review.status === 'published' ? 'ok' : 'bad'));
  ov.append(overviewItem('复核编号', review.meta.verify_id ?? '未产出（复核未运行）', review.meta.verify_id ? '' : 'bad'));
  ov.append(overviewItem('已发布事实', `已发布事实 ${review.published_facts.length} 项`));
  ov.append(overviewItem('阻断事实', `阻断事实 ${review.blocked_facts.length} 项`, review.blocked_facts.length ? 'bad' : ''));
  ov.append(overviewItem('组合结论', review.portfolio_published ? '组合已发布' : '组合不发布', review.portfolio_published ? 'ok' : 'bad'));
  body.append(ov);
  body.append(el('div', { class: 'muted small' }, [`内部状态标识：${review.status}；组合结论以 portfolio_published 为准。`]));
  if (review.degraded.length > 0) {
    // 范围外标的的复核降级记录（null close → 缺价措辞）会误称缺价：只显示非准入标的的降级记录，准入原因见上方阻断/错误。
    const admission = b ? admissionBlockedSymbols(b) : new Set();
    const shown = review.degraded.filter((d) => !admission.has(d.scope));
    if (shown.length > 0) {
      const db = el('div', { class: 'banner warn-banner' });
      db.append(el('strong', {}, ['降级说明']));
      for (const d of shown) db.append(el('div', {}, [`${d.scope ? `「${scopeLabel(d.scope)}」` : ''}${reasonText(d.code)}：${d.message}`]));
      body.append(db);
    }
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
  const admission = b ? admissionBlockedSymbols(b) : new Set();
  for (const s of review.blocked_symbols) {
    // 范围外标的的复核 null close 记录会误称缺价；这里照实改为准入原因（不在支持清单）。
    const code = admission.has(s.symbol) ? 'E_MARKET_OUT_OF_SUPPORT' : s.code;
    body.append(el('div', { class: 'rp-calc rp-bad-text' }, [
      `「${s.symbol}」未进入计算（${reasonText(code)}）：该标的没有任何事实条目，也不展示替代数字。`,
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
        `「${scopeLabel(scope)}」没有计算路径：${b.blockedSymbols.includes(scope) ? '该标的被阻断，未进入计算（具体原因见阻断/错误与复核记录）' : '引擎未输出该范围的事实'}，不展示替代数字。`,
      ]));
    }
    for (const it of items) body.append(factEvidence(it, pubById.get(it.fact_id), blkById.get(it.fact_id), review.meta.verify_id));
  }

  body.append(el('div', { class: 'rp-dev' }, [
    `口径与来源：数字由本地确定性引擎计算，并经本地复核流程筛选后才发布；行情来源：${marketText(b)}；固定 asOfDate：${metadataText(b.asOfDate)}。金额估值使用不复权价格，前复权仅用于走势；费用、税费仅记录，不计入收益公式。原始 CSV 仅在本机读取与校验，未上传。${WIRING_NOTE}`,
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
  body.append(factPlain(it, ['是否已通过复核', published ? `已通过复核并发布（${verifyId}）` : '未发布：不能作为有效结果引用，原因见下']));
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

  body.append(techDetails(it, published, '未发布：不展示该步骤的中间数值。'));
  det.append(body);
  return det;
}

function techDetails(it, showValues, hiddenStepText) {
  const tech = el('details', { class: 'rp-tech' }, [el('summary', {}, ['技术细节：公式编号、原始行号与计算步骤（S1–S4）'])]);
  appendFactDetails(tech, it, showValues, hiddenStepText);
  return tech;
}

function appendFactDetails(body, it, showValues, hiddenStepText) {
  body.append(el('div', { class: 'rp-kv' }, [el('b', {}, ['公式编号']), it.formula_id ?? '缺少公式编号（不发布）']));
  body.append(el('div', { class: 'rp-kv' }, [el('b', {}, ['公式']), it.formula_text ?? '公式注册表中没有该公式']));
  const inputs = it.inputs || {};
  body.append(el('div', { class: 'rp-kv' }, [
    el('b', {}, ['输入']),
    `成交 ${Array.isArray(inputs.trade_ids) ? inputs.trade_ids.join('、') : '无'}；${showValues ? (inputs.close_basis ?? `估值日不复权收盘价 ${inputs.close ?? '不可用'}`) : '未发布：不展示收盘价输入数值'}`,
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
  if (!usable) sum.append(statusTag('存在阻断项', 'bad'));
  det.append(sum);

  const body = el('div', { class: 'rp-fact-body' });
  body.append(factPlain(it, ['是否经过复核', '演示计算路径，未经过复核发布流程']));
  if (!usable) {
    const warn = el('div', { class: 'banner warn-banner' });
    warn.append(el('strong', {}, ['该条演示计算路径存在阻断项，不能作为有效结果引用']));
    for (const e of it.errors) warn.append(el('div', {}, [`${e.code} · ${e.message}`]));
    body.append(warn);
  }
  body.append(techDetails(it, usable, '存在阻断项：不展示该步骤的中间数值。'));
  det.append(body);
  return det;
}