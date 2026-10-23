// 在线意图 L2 的固定评测集（合成问题；不含账单、成交或任何凭证）。
// 约束：每条都必须绕过 L1（routeQuestion 不命中规则/芯片），才会真正请求分类模型。
// expected 为主判定；acceptable 用于语义上同样合理的近义类别（仍要求包含 expected）。
export const INTENT_EVAL_CASES = Object.freeze([
  Object.freeze({ id: 'worst-01', question: '这一堆操作里哪一次最让我后悔', expected: 'worst_trade' }),
  Object.freeze({ id: 'worst-02', question: '哪一回操作事后看最拖后腿', expected: 'worst_trade' }),

  Object.freeze({ id: 'best-01', question: '哪一次卖出事后看最加分', expected: 'best_trade' }),
  Object.freeze({ id: 'best-02', question: '盘一下哪次操作卖得最漂亮', expected: 'best_trade' }),

  Object.freeze({ id: 'loss-01', question: '这段时间我的账户到底做得怎么样', expected: 'loss_overview' }),
  Object.freeze({ id: 'loss-02', question: '帮我概括一下这份账单的结果', expected: 'loss_overview' }),

  Object.freeze({ id: 'pattern-01', question: '为什么我会反复犯同一个错误', expected: 'pattern_explain', acceptable: ['pattern_explain', 'profile'] }),
  Object.freeze({ id: 'pattern-02', question: '为什么一买进去我就想马上卖掉', expected: 'pattern_explain' }),

  Object.freeze({ id: 'profile-01', question: '给我总结一下我的操作特点', expected: 'profile', acceptable: ['profile', 'pattern_explain'] }),
  Object.freeze({ id: 'profile-02', question: '我属于哪种交易者', expected: 'profile' }),

  Object.freeze({ id: 'whatif-01', question: '假设那天我没有卖出，结果会差多少', expected: 'what_if' }),
  Object.freeze({ id: 'whatif-02', question: '平行推演一下当时不卖的结果', expected: 'what_if' }),
  Object.freeze({
    id: 'whatif-03',
    question: '回顾 2024 年 9 月 30 日 000001 那笔不卖会差多少',
    expected: 'what_if',
    slots: Object.freeze({ trade_date: '2024-09-30', symbol: '000001' }),
  }),

  Object.freeze({ id: 'similar-01', question: '我以前也遇到过这种行情吗', expected: 'similar_context' }),
  Object.freeze({ id: 'similar-02', question: '翻翻更早的记录，有没有跟这次一样的局面', expected: 'similar_context' }),

  Object.freeze({ id: 'change-01', question: '我不想再这样手痒了，有什么办法', expected: 'how_to_change' }),
  Object.freeze({ id: 'change-02', question: '以后遇到同样的情况我该怎么做', expected: 'how_to_change' }),

  Object.freeze({ id: 'setup-01', question: '给我加一条买入前的提醒规则', expected: 'contract_setup' }),
  Object.freeze({ id: 'setup-02', question: '我想限制自己一天最多交易两次', expected: 'contract_setup' }),

  Object.freeze({ id: 'status-01', question: '我之前立的规矩现在还有效吗', expected: 'contract_status' }),
  Object.freeze({ id: 'status-02', question: '我的提醒最近触发过几次', expected: 'contract_status' }),

  Object.freeze({ id: 'calc-01', question: '这些百分比是怎么得出来的', expected: 'meta_calc' }),
  Object.freeze({ id: 'calc-02', question: '择时损耗这个数从哪来的', expected: 'meta_calc' }),

  Object.freeze({ id: 'trust-01', question: '我能不能放心相信这些结果', expected: 'meta_trust' }),
  Object.freeze({ id: 'trust-02', question: '行情数据万一有缺失，结论还稳吗', expected: 'meta_trust' }),

  Object.freeze({ id: 'scope-01', question: '帮我挑两只下周能赚钱的票', expected: 'out_of_scope' }),
  Object.freeze({ id: 'scope-02', question: '大盘下周会往上还是往下', expected: 'out_of_scope' }),
]);
