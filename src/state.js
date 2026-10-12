// 应用状态（内存；契约演示记录本地持久化）。仅存页面实际消费的最少字段。
const CONTRACT_STORE_KEY = 'tm.contracts.demo';

const listeners = new Set();

export const state = {
  route: 'import',
  bill: { status: 'none', scenario: 'A', trades: [], warnings: [], sourceNote: '', resultLabelling: null, error: '' },
  report: { scenario: 'A', symbol: 'pool' },
  chat: { messages: [], draft: '' },
  contracts: { versions: [] },
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify() { for (const fn of listeners) fn(); }

export function saveContractsDemo() {
  try { localStorage.setItem(CONTRACT_STORE_KEY, JSON.stringify({ versions: state.contracts.versions })); } catch { /* 演示级持久化，失败可忽略 */ }
}

export function loadContractsDemo() {
  try {
    const raw = localStorage.getItem(CONTRACT_STORE_KEY);
    if (raw) return JSON.parse(raw).versions ?? [];
  } catch { /* 忽略解析失败 */ }
  return [];
}
