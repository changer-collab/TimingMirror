// 导入 · 确认：本地 CSV（FileReader 本机读取 → adapter 校验）与演示账单加载、校验结果展示、确认动作。
// 用户账单链路：选择文件 → readAsText → adapter.loadUserBillFromText（引擎 csvNormalize，页面不自行实现校验）→ invalid/loaded → 确认。
// 确认后：state.bill 标记 confirmed 并进入报告页；报告页按 sourceType 选择用户账单链路（adapter.loadUserBillReport）。
import { el } from '../components.js';
import { defaultBill, defaultChat, createBillContextId } from '../../state.js';
import * as demo from '../../demo/adapter.js';

const LOCAL_NOTICE = '原始 CSV 仅在本机读取和校验，不上传。';
const MARKET_NOTICE = '当前用户账单使用已签收真实历史行情缓存（历史快照，非实时）；标的或日期超出缓存清单时，报告会明确阻断，不回退合成行情。';
const CONFIRM_NOTE = '确认后进入分析报告；不会上传账单、不会执行交易。';
const FEE_TAX_NOTE = '部分费用或税费缺失，当前结果按现有口径计算，可能与实际对账结果不同。';

// 人话说明与 csvNormalize 的错误码一一对应（规则以引擎为准，此处只做解释）
const ERROR_HELP = Object.freeze({
  E_EMPTY: '文件是空的，或只有表头没有交易行。请导出包含交易记录的 CSV。',
  E_HEADER_MISSING: '缺少必需列。第一行表头需要包含：日期、标的、方向、价格、数量。',
  E_DATE_FORMAT: '日期格式不对，请写成 2024-09-25 这样的“年-月-日”。',
  E_SYMBOL_FORMAT: '标的需为 6 位数字代码（例如 000001），请保留前导零。',
  E_SIDE_VALUE: '方向只能填“买入”或“卖出”。',
  E_PRICE_VALUE: '价格需为大于 0 的数字。',
  E_PRICE_PRECISION: '价格最多 2 位小数；系统不会自动四舍五入，请修正后重新导入。',
  E_QTY_INTEGER: '数量需为正整数。',
  E_MONEY_VALUE: '费用、税费需为不小于 0 的数字（留空表示缺失，按 0 计并标注）。',
  E_MONEY_PRECISION: '费用、税费最多 2 位小数；系统不会自动四舍五入，请修正后重新导入。',
  E_QTY_EXCEEDS: '某只标的在某个时点的累计卖出超过了此前累计买入。当前不支持缺少期初持仓的账单，请从首笔买入开始导出。',
});

function prepGuide() {
  return el('div', { class: 'card im-prep' }, [
    el('div', { class: 'section-title' }, ['准备账单']),
    el('ul', { class: 'im-list' }, [
      el('li', {}, ['仅支持 CSV 文件（UTF-8 编码、逗号分隔、第一行为表头）。']),
      el('li', {}, [LOCAL_NOTICE + '文件只在浏览器本机读取。']),
      el('li', {}, ['确认只用于生成本地分析，不会下单、不会执行交易。']),
      el('li', {}, ['必填列：日期（YYYY-MM-DD）、标的（6 位数字代码）、方向（买入 / 卖出）、价格（大于 0，最多 2 位小数）、数量（正整数）。']),
      el('li', {}, ['可选列：费用、税费（不小于 0，最多 2 位小数；缺失按 0 计并标注）。其他列会被忽略。']),
      el('li', {}, ['账单需从首笔买入开始：任一时点的累计卖出不能超过累计买入（暂不支持期初持仓）。']),
    ]),
    el('div', { class: 'muted small' }, ['表头示例：', el('code', { class: 'im-code' }, ['日期,标的,方向,价格,数量,费用,税费'])]),
    el('div', { class: 'muted small' }, [MARKET_NOTICE]),
  ]);
}

function feeTaxSummary(trades) {
  const fee = trades.filter((t) => t.fee_missing).map((t) => t.source.line);
  const tax = trades.filter((t) => t.tax_missing).map((t) => t.source.line);
  if (!fee.length && !tax.length) return null;
  return el('div', { class: 'banner warn-banner im-feetax' }, [
    el('strong', {}, ['费用 / 税费有缺失']),
    FEE_TAX_NOTE,
    fee.length ? el('div', {}, [`费用缺失：第 ${fee.join('、')} 行（按 0 计）`]) : null,
    tax.length ? el('div', {}, [`税费缺失：第 ${tax.join('、')} 行（按 0 计）`]) : null,
  ]);
}

function invalidBlock(errors) {
  const groups = new Map();
  for (const e of errors) {
    const g = groups.get(e.code) ?? { lines: [], message: e.message };
    if (e.line) g.lines.push(e.line);
    groups.set(e.code, g);
  }
  const eb = el('div', { class: 'banner warn-banner' }, [
    el('strong', {}, ['不能分析：账单里有需要修改的地方（校验未通过 · 整批阻断）']),
    el('div', { class: 'muted small' }, ['为保证结果可以核对，只要有一处错误就不生成任何部分结果。请按下面的提示修改 CSV 后重新选择文件。']),
  ]);
  for (const [code, g] of groups) {
    eb.append(el('div', { class: 'im-fix' }, [`· ${ERROR_HELP[code] ?? g.message}${g.lines.length ? `（第 ${g.lines.join('、')} 行）` : ''}`]));
  }
  eb.append(el('details', { class: 'im-tech' }, [
    el('summary', {}, ['技术详情（错误码）']),
    ...errors.map((e) => el('div', { class: 'muted small' }, [errText(e)])),
  ]));
  return eb;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取文件内容：${file.name}`));
    reader.readAsText(file);
  });
}

function isCsvFile(file) {
  return /\.csv$/i.test(file.name) || String(file.type || '').includes('csv');
}

// 每次状态迁移都基于 defaultBill() 全量重建，避免上一份账单的 trades/warnings/dataMode 等残留到下一状态
function freshBill(scenario, fields = {}) {
  return { ...defaultBill(), scenario: scenario || 'R', ...fields };
}

function errText(e) {
  return `${e.code}${e.line ? `（第 ${e.line} 行）` : ''} · ${e.message}`;
}

function warningsBlock(warnings) {
  const wl = el('div', { class: 'banner warn-banner' }, [el('strong', {}, ['警告（照实展示）'])]);
  for (const w of warnings) {
    wl.append(el('div', {}, [`${w.code}（第 ${w.line} 行）${w.column ? ` · ${w.column}` : ''} · ${w.message}`]));
  }
  return wl;
}

function dataModeLine(dataMode) {
  return el('div', { class: 'muted small' }, [`数据模式：${dataMode.label} —— ${dataMode.note}`]);
}

function marketLine(marketSource, supportScope) {
  if (!marketSource) return null;
  const scope = supportScope
    ? ` · 支持范围 ${supportScope.range.start} → ${supportScope.range.end}（${supportScope.symbols.join(' / ')}，估值日 ${supportScope.asOfDate}）`
    : '';
  return el('div', { class: 'muted small' }, [`行情：${marketSource.label}${scope}`]);
}

function tradesTable(trades) {
  const table = el('table', { class: 'tbl' });
  const head = el('tr');
  for (const h of ['行', '交易日', '标的', '方向', '价格', '数量', '费用', '税费']) head.append(el('th', {}, [h]));
  table.append(el('thead', {}, [head]));
  const body = el('tbody');
  for (const tr of trades) {
    const row = el('tr');
    row.append(el('td', {}, [String(tr.source.line)]));
    row.append(el('td', {}, [tr.trade_date]));
    row.append(el('td', {}, [tr.symbol]));
    row.append(el('td', {}, [tr.side === 'buy' ? '买入' : '卖出']));
    row.append(el('td', {}, [tr.price.toFixed(2)]));
    row.append(el('td', {}, [String(tr.quantity)]));
    row.append(el('td', { class: tr.fee_missing ? 'warn' : '' }, [tr.fee_missing ? '缺失（按 0）' : tr.fee.toFixed(2)]));
    row.append(el('td', { class: tr.tax_missing ? 'warn' : '' }, [tr.tax_missing ? '缺失（按 0）' : tr.tax.toFixed(2)]));
    body.append(row);
  }
  table.append(body);
  return el('div', { class: 'table-wrap' }, [table]);
}

async function onFilePicked(ev, ctx) {
  const { state, set } = ctx;
  const file = ev && ev.target && ev.target.files && ev.target.files[0];
  if (!file || state.bill.status === 'loading') return;
  const scenario = state.bill.scenario;
  const contextId = createBillContextId();
  if (!isCsvFile(file)) {
    set({
      bill: freshBill(scenario, { contextId, status: 'none', error: `文件类型不符合预期：${file.name}（请选择 .csv 账单文件；未读取该文件）` }),
      chat: defaultChat(contextId),
    });
    return;
  }
  set({
    bill: freshBill(scenario, { contextId, status: 'loading', sourceType: 'local', fileName: file.name, fileSize: file.size }),
    chat: defaultChat(contextId),
  });
  try {
    const text = await readAsText(file);
    const bill = await demo.loadUserBillFromText(text, file.name);
    set({
      bill: freshBill(scenario, {
        contextId,
        status: bill.blocked ? 'invalid' : 'loaded',
        sourceType: bill.sourceType,
        fileName: bill.fileName,
        fileSize: file.size,
        blocked: bill.blocked,
        trades: bill.trades,
        warnings: bill.warnings,
        errors: bill.errors,
        dataMode: bill.dataMode,
        sourceNote: bill.sourceNote,
        resultLabelling: bill.resultLabelling,
      }),
    });
  } catch (e) {
    set({
      bill: freshBill(scenario, {
        contextId,
        status: 'error',
        sourceType: 'local',
        fileName: file.name,
        fileSize: file.size,
        error: e && e.message ? e.message : String(e),
      }),
    });
  }
}

export function renderImport(root, ctx) {
  const { state, set, go } = ctx;
  const bill = state.bill;
  const wrap = el('div', { class: 'stack' });

  wrap.append(prepGuide());

  const bar = el('div', { class: 'row' });
  bar.append(el('input', {
    type: 'file',
    accept: '.csv,text/csv',
    class: 'input',
    disabled: bill.status === 'loading' ? '' : null,
    onchange: (ev) => onFilePicked(ev, ctx),
  }));
  const loadBtn = el('button', {
    class: 'btn primary',
    disabled: bill.status === 'loading' ? '' : null,
    onclick: async () => {
      if (state.bill.status === 'loading') return;
      const scenario = state.bill.scenario;
      const contextId = createBillContextId();
      set({
        bill: freshBill(scenario, { contextId, status: 'loading' }),
        chat: defaultChat(contextId),
      });
      try {
        const b = await demo.loadDemoBill(scenario);
        set({
          bill: freshBill(scenario, {
            contextId,
            status: 'loaded',
            trades: b.trades,
            warnings: b.warnings,
            dataMode: b.dataMode,
            marketSource: b.marketSource,
            supportScope: b.supportScope,
            sourceNote: b.sourceNote,
            resultLabelling: b.resultLabelling,
          }),
        });
      } catch (e) {
        set({ bill: freshBill(scenario, { contextId, status: 'error', error: e.message }) });
      }
    },
  }, [bill.status === 'loading' ? '加载中…' : '加载演示账单']);
  bar.append(loadBtn);
  wrap.append(bar);

  if (bill.status === 'loading') {
    wrap.append(el('div', { class: 'banner' }, [
      bill.fileName
        ? `正在本机读取：${bill.fileName}（${fmtSize(bill.fileSize)}）… 读取与校验完成后展示结果。`
        : '正在加载演示账单…',
    ]));
  } else if (bill.status === 'error') {
    wrap.append(el('div', { class: 'error' }, ['读取失败：' + bill.error]));
  } else if (bill.status === 'none' && bill.error) {
    wrap.append(el('div', { class: 'error' }, [bill.error]));
  } else if (bill.status === 'none') {
    wrap.append(el('div', { class: 'muted' }, ['尚未选择账单：选择 .csv 文件后在本机完成校验，或加载演示账单走查流程。']));
  }

  if (bill.fileName && (bill.status === 'invalid' || bill.status === 'loaded' || bill.status === 'confirmed')) {
    wrap.append(el('div', { class: 'muted small' }, [
      `已选择：${bill.fileName}（${fmtSize(bill.fileSize)}）· ${LOCAL_NOTICE}`,
    ]));
  }

  if (bill.status === 'invalid') {
    wrap.append(invalidBlock(bill.errors));
    if (bill.warnings.length) wrap.append(warningsBlock(bill.warnings));
    if (bill.dataMode) wrap.append(dataModeLine(bill.dataMode));
    wrap.append(el('button', { class: 'btn primary', disabled: '' }, ['确认交易列表并生成报告']));
    wrap.append(el('div', { class: 'muted small' }, ['校验未通过，确认不可用。']));
  }

  if (bill.status === 'loaded' || bill.status === 'confirmed') {
    const t = bill.trades;
    const signed = !!(bill.marketSource && bill.marketSource.signed);
    wrap.append(el('div', { class: `im-status ${bill.status}` }, [
      bill.status === 'loaded'
        ? '待确认：请核对交易数、日期、标的和费用税费'
        : `已确认：已用于本地分析${bill.sourceType === 'local' ? '' : signed ? '（示例交易）' : '（演示账单）'}`,
    ]));
    wrap.append(el('div', { class: 'row' }, [
      el('div', { class: 'section-title' }, [`交易列表（${t.length} 条）· ${bill.sourceNote}`]),
      bill.status === 'loaded' ? el('span', { class: 'chip mode' }, ['待确认']) : el('span', { class: 'chip ok' }, ['已确认']),
    ]));

    const feeTax = feeTaxSummary(t);
    if (feeTax) wrap.append(feeTax);
    wrap.append(tradesTable(t));

    if (bill.warnings && bill.warnings.length) wrap.append(warningsBlock(bill.warnings));
    if (bill.dataMode) wrap.append(dataModeLine(bill.dataMode));
    const mktLine = marketLine(bill.marketSource, bill.supportScope);
    if (mktLine) wrap.append(mktLine);

    const lab = bill.resultLabelling;
    if (lab) wrap.append(el('div', { class: 'muted small' }, [`结果口径：${lab.fees_taxes}；${lab.dividend}。`]));

    if (bill.status === 'loaded') {
      const canConfirm = bill.status === 'loaded' && !bill.blocked && bill.errors.length === 0 && t.length > 0;
      wrap.append(el('button', {
        class: 'btn primary',
        disabled: canConfirm ? null : '',
        onclick: () => { set({ bill: { status: 'confirmed' } }); go('report'); },
      }, ['确认交易列表并生成报告']));
      wrap.append(el('div', { class: 'muted small im-confirm-note' }, [CONFIRM_NOTE]));
      if (!canConfirm) wrap.append(el('div', { class: 'muted small' }, ['当前状态不可确认（有错误或无交易）。']));
    } else if (bill.sourceType === 'local') {
      wrap.append(el('div', { class: 'ok-line' }, ['已确认 ✓（报告页展示你的账单结果；行情为已签收真实历史快照，非实时）']));
      wrap.append(el('button', { class: 'btn', onclick: () => go('report') }, ['前往报告 · 证据']));
    } else {
      wrap.append(el('div', { class: 'ok-line' }, [signed
        ? '已确认 ✓（示例交易 + 已签收真实历史行情：确认动作仅切换应用状态）'
        : '已确认 ✓（演示账单：确认动作仅切换应用状态）']));
      wrap.append(el('button', { class: 'btn', onclick: () => go('report') }, ['前往报告 · 证据']));
    }
  }

  root.append(wrap);
}
