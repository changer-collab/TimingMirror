// 导入 · 确认：本地 CSV（FileReader 本机读取 → adapter 校验）与演示账单加载、校验结果展示、确认动作。
// 用户账单链路：选择文件 → readAsText → adapter.loadUserBillFromText（引擎 csvNormalize，页面不自行实现校验）→ invalid/loaded → 确认。
// 确认后：state.bill 标记 confirmed 并进入报告页；报告页按 sourceType 选择用户账单链路（adapter.loadUserBillReport）。
import { el } from '../components.js';
import { defaultBill } from '../../state.js';
import * as demo from '../../demo/adapter.js';

const LOCAL_NOTICE = '原始 CSV 仅在本机读取和校验，不上传。';
const MARKET_NOTICE = '当前用户账单仅使用合成演示行情；不在支持范围内时，下一阶段报告将明确阻断。';

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
  return { ...defaultBill(), scenario: scenario || 'A', ...fields };
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
  if (!isCsvFile(file)) {
    set({ bill: freshBill(scenario, { status: 'none', error: `文件类型不符合预期：${file.name}（请选择 .csv 账单文件；未读取该文件）` }) });
    return;
  }
  set({ bill: freshBill(scenario, { status: 'loading', sourceType: 'local', fileName: file.name, fileSize: file.size }) });
  try {
    const text = await readAsText(file);
    const bill = await demo.loadUserBillFromText(text, file.name);
    set({
      bill: freshBill(scenario, {
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

  wrap.append(el('div', { class: 'banner' }, [
    el('strong', {}, ['本机处理']),
    LOCAL_NOTICE + MARKET_NOTICE,
  ]));

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
      set({ bill: freshBill(state.bill.scenario, { status: 'loading' }) });
      try {
        const b = await demo.loadDemoBill(state.bill.scenario);
        set({ bill: freshBill(state.bill.scenario, { status: 'loaded', trades: b.trades, warnings: b.warnings, sourceNote: b.sourceNote, resultLabelling: b.resultLabelling }) });
      } catch (e) {
        set({ bill: freshBill(state.bill.scenario, { status: 'error', error: e.message }) });
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
    const eb = el('div', { class: 'banner warn-banner' }, [el('strong', {}, ['校验未通过 · 整批阻断'])]);
    eb.append(el('div', { class: 'muted small' }, ['存在错误时无部分结果；请修正 CSV 后重新选择文件。']));
    for (const e of bill.errors) eb.append(el('div', {}, [errText(e)]));
    wrap.append(eb);
    if (bill.warnings.length) wrap.append(warningsBlock(bill.warnings));
    if (bill.dataMode) wrap.append(dataModeLine(bill.dataMode));
    wrap.append(el('button', { class: 'btn primary', disabled: '' }, ['确认交易列表并生成报告']));
    wrap.append(el('div', { class: 'muted small' }, ['校验未通过，确认不可用。']));
  }

  if (bill.status === 'loaded' || bill.status === 'confirmed') {
    const t = bill.trades;
    wrap.append(el('div', { class: 'row' }, [
      el('div', { class: 'section-title' }, [`交易列表（${t.length} 条）· ${bill.sourceNote}`]),
      bill.status === 'loaded' ? el('span', { class: 'chip mode' }, ['待确认']) : el('span', { class: 'chip ok' }, ['已确认']),
    ]));

    wrap.append(tradesTable(t));

    if (bill.warnings && bill.warnings.length) wrap.append(warningsBlock(bill.warnings));
    if (bill.dataMode) wrap.append(dataModeLine(bill.dataMode));

    const lab = bill.resultLabelling;
    if (lab) wrap.append(el('div', { class: 'muted small' }, [`结果口径：${lab.fees_taxes}；${lab.dividend}。`]));

    if (bill.status === 'loaded') {
      const canConfirm = bill.status === 'loaded' && !bill.blocked && bill.errors.length === 0 && t.length > 0;
      wrap.append(el('button', {
        class: 'btn primary',
        disabled: canConfirm ? null : '',
        onclick: () => { set({ bill: { status: 'confirmed' } }); go('report'); },
      }, ['确认交易列表并生成报告']));
      if (!canConfirm) wrap.append(el('div', { class: 'muted small' }, ['当前状态不可确认（有错误或无交易）。']));
    } else if (bill.sourceType === 'local') {
      wrap.append(el('div', { class: 'ok-line' }, ['已确认 ✓（报告页展示你的账单结果；行情为合成演示口径，非真实行情）']));
      wrap.append(el('button', { class: 'btn', onclick: () => go('report') }, ['前往报告 · 证据']));
    } else {
      wrap.append(el('div', { class: 'ok-line' }, ['已确认 ✓（演示账单：确认动作仅切换应用状态）']));
      wrap.append(el('button', { class: 'btn', onclick: () => go('report') }, ['前往报告 · 证据']));
    }
  }

  root.append(wrap);
}
