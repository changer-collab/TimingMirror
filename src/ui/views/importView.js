// 导入 · 确认：演示账单加载、交易列表、确认动作（上传解析未接入）
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';

export function renderImport(root, ctx) {
  const { state, set, go } = ctx;
  const wrap = el('div', { class: 'stack' });

  wrap.append(el('div', { class: 'banner' }, [
    el('strong', {}, ['演示数据模式']),
    '上传与解析（Papa Parse）未接入；可加载合成演示账单推进演示。原始 CSV 未来将仅在本机处理（不上传）。',
  ]));

  const bar = el('div', { class: 'row' });
  const loadBtn = el('button', {
    class: 'btn primary',
    onclick: async () => {
      loadBtn.disabled = true;
      loadBtn.textContent = '加载中…';
      try {
        const bill = await demo.loadDemoBill(state.bill.scenario);
        set({ bill: { status: 'loaded', trades: bill.trades, warnings: bill.warnings, sourceNote: bill.sourceNote, resultLabelling: bill.resultLabelling, error: '' } });
      } catch (e) {
        set({ bill: { status: 'error', error: e.message } });
      }
    },
  }, ['加载演示账单']);
  bar.append(loadBtn);
  bar.append(el('span', { class: 'muted' }, ['上传成交 CSV：（未接入）']));
  wrap.append(bar);

  if (state.bill.status === 'error') wrap.append(el('div', { class: 'error' }, ['加载失败：' + state.bill.error]));

  if (state.bill.status === 'loaded' || state.bill.status === 'confirmed') {
    const t = state.bill.trades;
    wrap.append(el('div', { class: 'row' }, [
      el('div', { class: 'section-title' }, [`交易列表（${t.length} 条）· ${state.bill.sourceNote}`]),
      state.bill.status === 'loaded' ? el('span', { class: 'chip mode' }, ['待确认']) : el('span', { class: 'chip ok' }, ['已确认']),
    ]));

    const table = el('table', { class: 'tbl' });
    const head = el('tr');
    for (const h of ['行', '交易日', '标的', '方向', '价格', '数量', '费用', '税费']) head.append(el('th', {}, [h]));
    table.append(el('thead', {}, [head]));
    const body = el('tbody');
    for (const tr of t) {
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
    wrap.append(el('div', { class: 'table-wrap' }, [table]));

    if (state.bill.warnings && state.bill.warnings.length) {
      const wl = el('div', { class: 'banner warn-banner' });
      for (const w of state.bill.warnings) wl.append(el('div', {}, [`第 ${w.line} 行 · ${w.message}`]));
      wrap.append(wl);
    }

    const lab = state.bill.resultLabelling;
    if (lab) wrap.append(el('div', { class: 'muted small' }, [`结果口径：${lab.fees_taxes}；${lab.dividend}。`]));

    if (state.bill.status === 'loaded') {
      wrap.append(el('button', {
        class: 'btn primary',
        onclick: () => { set({ bill: { status: 'confirmed' } }); go('report'); },
      }, ['确认交易列表 → 进入报告']));
    } else {
      wrap.append(el('div', { class: 'ok-line' }, ['已确认 ✓（演示级：确认动作仅切换应用状态；计算引擎未接入）']));
      wrap.append(el('button', { class: 'btn', onclick: () => go('report') }, ['前往报告 · 证据']));
    }
  }

  root.append(wrap);
}
