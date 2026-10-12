// 小型 DOM 组件工具（无框架、浏览器原生）
export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export function clear(node) { node.replaceChildren(); }

export function chip(text, kind = '') { return el('span', { class: `chip ${kind}`.trim() }, [text]); }

export function metricCard(label, value, note, kind = '') {
  return el('div', { class: `metric ${kind}`.trim() }, [
    el('div', { class: 'metric-label' }, [label]),
    el('div', { class: 'metric-value' }, [value]),
    note ? el('div', { class: 'metric-note' }, [note]) : null,
  ]);
}
