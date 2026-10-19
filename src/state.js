// 应用状态（内存；契约演示记录本地持久化）。仅存页面实际消费的最少字段。
const CONTRACT_STORE_KEY = 'tm.contracts.demo';

const listeners = new Set();

export function defaultBill() {
  return {
    status: 'none', scenario: 'A', trades: [], warnings: [], errors: [],
    sourceNote: '', resultLabelling: null, error: '',
    sourceType: null, fileName: '', fileSize: 0, blocked: false, dataMode: null,
  };
}

export function defaultContracts() {
  return { versions: [], draft: null, sim: { symbol: '', date: '', result: null, running: false }, simContext: null };
}

export const state = {
  route: 'import',
  bill: defaultBill(),
  report: { scenario: 'A', symbol: 'pool' },
  chat: { messages: [], draft: '' },
  contracts: defaultContracts(),
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify() { for (const fn of listeners) fn(); }

export function saveContractsDemo() {
  try { localStorage.setItem(CONTRACT_STORE_KEY, JSON.stringify({ versions: state.contracts.versions })); } catch { /* 演示级持久化，失败可忽略 */ }
}

// 旧演示记录（无 schema 字段）原样保留，由页面标注为“旧演示记录”；非对象条目丢弃
export function loadContractsDemo() {
  try {
    const raw = localStorage.getItem(CONTRACT_STORE_KEY);
    if (raw) {
      const versions = JSON.parse(raw)?.versions;
      if (Array.isArray(versions)) return versions.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
    }
  } catch { /* 忽略解析失败 */ }
  return [];
}
