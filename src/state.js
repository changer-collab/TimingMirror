// 应用状态（内存；契约演示记录本地持久化）。仅存页面实际消费的最少字段。
const CONTRACT_STORE_KEY = 'tm.contracts.demo';

const listeners = new Set();

let billContextSeq = 0;

// 每次重新导入/加载演示账单都生成新上下文；同名文件重导入也视为新上下文。
export function createBillContextId() {
  billContextSeq += 1;
  return `bill-${billContextSeq}`;
}

export function defaultBill() {
  return {
    status: 'none', scenario: 'R', trades: [], warnings: [], errors: [],
    sourceNote: '', resultLabelling: null, error: '',
    sourceType: null, fileName: '', fileSize: 0, blocked: false, dataMode: null,
    contextId: null, importMethod: null, cloudRestored: false, cloudBillId: null,
  };
}

export function defaultImportRecovery() {
  return {
    status: 'idle',
    sourceId: null,
    sourceKind: null,
    fileName: '',
    fileSize: 0,
    content: '',
    contentEdited: false,
    localDraft: null,
    localNote: '',
    draft: null,
    unresolved: [],
    pending: false,
    error: null,
    notice: null,
    validationErrors: [],
    validationFeedback: null,
    draftDirty: false,
    reimportConfirm: false,
    unsupported: null,
    modelCalls: 0,
    budgetMax: 2,
    budgetExhausted: false,
    flowId: null,
    requestId: null,
    trace: null,
    vision: {
      kind: null,
      fileName: '',
      pageCount: 0,
      startPage: 1,
      endPage: 1,
      images: [],
      totalBytes: 0,
      totalBase64Chars: 0,
      payloadBytes: 0,
      status: 'idle',
      error: null,
      notice: '',
    },
  };
}

export function defaultChat(contextId = null) {
  return { messages: [], draft: '', pending: false, contextId, requestId: null };
}

export function defaultContracts() {
  return {
    versions: [],
    draft: null,
    marketSource: 'dynamic-tushare',
    sim: { symbol: '', date: '', action: 'buy', result: null, running: false, runId: null, fallback: null },
    simContext: null,
    saveState: { status: 'idle', message: '', versions: null, at: null },
    modal: null,
    nl: null,
  };
}

export function defaultAssistant() {
  return {
    open: true,
    mobileView: false,
    input: '',
    pending: false,
    flowId: null,
    requestId: null,
    stage: 'idle',
    messages: [],
    draft: null,
    plan: null,
    trace: null,
    explanation: '',
    error: null,
    staleNotice: null,
    contextKey: null,
    semanticConfirmation: null,
    currentRule: null,
    ruleDrift: null,
    simulation: null,
    simulationAttempt: null,
    currentSimulationResultId: null,
    currentSimulationStatus: null,
    resultExplanation: null,
    resultExplanationAttempt: null,
    resultExplanationPending: false,
    resultExplanationRequestId: null,
    resultExplanationKey: null,
    resultExplanationNotice: null,
    consistency: null,
    consistencyAttempt: null,
    lastAttempt: null,
    modelCalls: 0,
    budgetMax: 2,
    outbound: false,
    draftId: null,
    pendingDraftId: null,
    savedNotice: null,
    pendingConfirmationFlowId: null,
    versionsBaselineCount: null,
    versionsBaselineHashes: [],
    dataContextKey: null,
    ruleStateKey: null,
    simulationKey: null,
    marketNotice: null,
    qaMessages: [],
    qaInput: '',
    view: 'explain',
    qaAiPending: false,
    qaPending: false,
    qaRequestId: null,
    qaContextId: null,
    qaNotice: null,
  };
}

export const state = {
  route: 'import',
  contractPage: null,
  bill: defaultBill(),
  report: { scenario: 'R', symbol: 'pool' },
  chat: defaultChat(),
  contracts: defaultContracts(),
  assistant: defaultAssistant(),
  importRecovery: defaultImportRecovery(),
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
