// 契约：规则候选确认/改写/拒绝、版本记录（演示级）、历史情境模拟入口（禁用占位）
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';
import { saveContractsDemo } from '../../state.js';

export function renderContract(root, ctx) {
  const { state, set } = ctx;
  const wrap = el('div', { class: 'stack' });

  wrap.append(el('div', { class: 'banner' }, [
    el('strong', {}, ['契约组件（演示级）']),
    '候选为合成演示数据；阈值解析、匹配判定、哈希存证与相似情境提醒均未接入。',
  ]));

  const versions = state.contracts.versions;
  const candidateStatus = (cid) => {
    const rec = [...versions].reverse().find((v) => v.candidateId === cid);
    if (!rec) return { text: '候选（未处理）', kind: 'mode' };
    const kind = rec.status === '已确认' ? 'ok' : rec.status === '已改写' ? 'mode' : 'warn';
    return { text: `${rec.status} v${rec.v}`, kind };
  };

  function addVersion(candidateId, status, text) {
    const v = (versions.at(-1)?.v ?? 0) + 1;
    const rec = { v, candidateId, status, text, at: new Date().toLocaleString('zh-CN'), hash: '未接入' };
    set({ contracts: { versions: [...versions, rec] } });
    saveContractsDemo();
  }

  function toggleRewrite(card, c) {
    const box = card.querySelector('.rewrite');
    if (box) { box.remove(); return; }
    const newBox = el('div', { class: 'rewrite' });
    const ta = el('textarea', { class: 'input', rows: '2' });
    ta.value = c.text;
    newBox.append(ta);
    newBox.append(el('button', {
      class: 'btn primary',
      onclick: () => {
        const text = ta.value.trim();
        if (!text) return;
        addVersion(c.id, '已改写', text);
      },
    }, ['保存改写']));
    card.append(newBox);
  }

  wrap.append(el('div', { class: 'section-title' }, ['规则候选（演示）']));
  for (const c of demo.demoRuleCandidates()) {
    const card = el('div', { class: 'card' });
    const st = candidateStatus(c.id);
    card.append(el('div', { class: 'row' }, [
      el('strong', {}, [c.id]),
      el('span', { class: `chip ${st.kind}`.trim() }, [st.text]),
    ]));
    card.append(el('div', { class: 'rule-text' }, [c.text]));
    card.append(el('div', { class: 'muted small' }, [`触发条件：${c.trigger}`]));
    card.append(el('div', { class: 'muted small' }, [`回看提示：${c.backread}`]));
    card.append(el('div', { class: 'muted small' }, [c.note]));
    card.append(el('div', { class: 'row' }, [
      el('button', { class: 'btn primary', onclick: () => addVersion(c.id, '已确认', c.text) }, ['确认']),
      el('button', { class: 'btn', onclick: () => toggleRewrite(card, c) }, ['改写']),
      el('button', { class: 'btn danger', onclick: () => addVersion(c.id, '已拒绝', c.text) }, ['拒绝']),
    ]));
    wrap.append(card);
  }

  wrap.append(el('div', { class: 'section-title' }, ['契约版本记录（本地持久化 · 演示级）']));
  if (!versions.length) {
    wrap.append(el('div', { class: 'muted' }, ['暂无记录。确认 / 改写 / 拒绝后会在此生成版本记录（哈希存证未接入）。']));
  } else {
    for (const rec of versions) {
      wrap.append(el('div', { class: 'calc-line' }, [`v${rec.v} · ${rec.status} · ${rec.candidateId} · ${rec.at} · 哈希：${rec.hash} —— ${rec.text}`]));
    }
  }

  const sim = el('div', { class: 'card disabled-card' });
  sim.append(el('div', { class: 'section-title' }, ['历史情境模拟（未接入）']));
  sim.append(el('div', { class: 'muted small' }, ['接入契约匹配引擎与行情缓存后启用：选择缓存支持的标的与历史日期 → 读取该日涨跌幅 → 确定性命中判定（触发 / 不触发双情境，与用户操作共用同一判定链路）。']));
  sim.append(el('button', { class: 'btn', disabled: 'disabled' }, ['模拟申报买入（未启用）']));
  wrap.append(sim);

  root.append(wrap);
}
