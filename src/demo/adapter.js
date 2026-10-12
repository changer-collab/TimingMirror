// 演示数据适配层 —— 页面唯一数据出口。
// 当前实现：读取 m0 合成夹具（未经计算引擎/百炼/行情缓存）。
// 后续接入真实计算、复核、百炼及可选真实行情时，替换本文件内部实现即可，页面无需改动。
const FIXTURE = {
  A: '/m0/csv-input/fixtures/demo-bill.expected.json',
  Aprime: '/m0/csv-input/fixtures/demo-bill-aprime.expected.json',
};

// 能力状态（供页面准确显示“未接入”）
export const CAPABILITY = {
  engine: { ready: false, label: '计算引擎·未接入' },
  bailian: { ready: false, label: '百炼·未接入（离线）' },
  marketCache: { ready: false, label: '行情缓存·未接入' },
  contractEngine: { ready: false, label: '契约引擎·未接入' },
};

const cache = new Map();

async function loadFixture(scenario) {
  const key = scenario === 'Aprime' ? 'Aprime' : 'A';
  if (!cache.has(key)) {
    const res = await fetch(FIXTURE[key]);
    if (!res.ok) throw new Error(`演示夹具加载失败：${FIXTURE[key]}（HTTP ${res.status}）`);
    cache.set(key, await res.json());
  }
  return cache.get(key);
}

export const DEMO_SOURCE_NOTE = '演示数据 · 合成夹具（m0/csv-input/fixtures）；非真实账户交易结果；计算引擎未接入';

export async function loadDemoBill(scenario = 'A') {
  const fx = await loadFixture(scenario);
  return {
    scenario: fx.fixture === 'demo-bill.csv' ? 'A' : 'Aprime',
    trades: fx.standardized.trades,
    warnings: fx.standardized.warnings,
    blocked: fx.standardized.blocked ?? false,
    sourceNote: `来源：${fx.fixture}（合成夹具；占位代码非真实证券）`,
    resultLabelling: fx.result_labelling,
  };
}

export async function loadIndicators(scenario = 'A') {
  const fx = await loadFixture(scenario);
  return {
    perStock: fx.expected_indicators.per_stock,
    pool: fx.expected_indicators.portfolio,
    handCalc: fx.hand_calc,
    assumptions: fx.assumptions,
    delta: fx.delta_vs_demo_bill ?? null,
    resultLabelling: fx.result_labelling,
    sourceFile: fx.fixture,
    sourceNote: fx.note,
  };
}

// 契约规则候选（演示数据；契约引擎未接入，阈值解析与匹配未实现）
export function demoRuleCandidates() {
  return [
    {
      id: 'RC-1',
      text: '当天涨幅超过 5% 的票，我绝不买入。',
      trigger: '申报买入时：该标的当日涨幅 > 5%',
      backread: '回看：过去 N 次追涨买入的持有期表现（历史统计）',
      note: '演示候选（合成）——契约引擎未接入，阈值解析与匹配判定未实现',
    },
    {
      id: 'RC-2',
      text: '卖出后 3 个交易日内不追回同一只票。',
      trigger: '卖出后 3 个交易日内出现同标的买入申报',
      backread: '回看：过去相似“卖出即买回”的记录',
      note: '演示候选（合成）',
    },
  ];
}

// 对话离线降级占位（百炼未接入；不引用事实 JSON）
export function offlineChatReply(question) {
  const q = String(question || '').trim();
  const base = q ? `已记录你的问题：「${q}」` : '（空问题）';
  return {
    text: `${base}\n\n百炼未接入：当前为离线降级模式，无法执行意图分类与事实复述。接入后，回答将基于事实 JSON 复述（数字不离开事实 JSON、不外推）。可先在「报告 · 证据」页查看演示数据。`,
    mode: 'offline',
  };
}
