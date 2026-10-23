// 仅本地开发使用的假模型：不联网、不读取凭据，返回固定草案或受控错误。
// 只在 scripts/serve.mjs 中注入；不进入站点 Function，也不参与线上部署。
import { BEHAVIOR_CANDIDATE } from '../server/site-functions/behaviorAnalysis.mjs';

function behaviorFakeObservation(facts) {
  const events = Array.isArray(facts?.events) ? facts.events : [];
  const observations = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].side !== 'sell') continue;
    for (let j = i + 1; j < events.length; j += 1) {
      const gap = events[j].day_offset - events[i].day_offset;
      if (events[j].side === 'buy' && events[j].asset_key === events[i].asset_key && gap > 0 && gap <= 2) {
        observations.push({ observation_id: 'sell_rebuy_within_2d', text: '卖出后两个交易日内又买回同一标的。', evidence_event_indexes: [i, j] });
        i = events.length;
        break;
      }
    }
  }
  if ((facts?.trading?.sell_after_buy_count ?? 0) >= 4) {
    observations.push({
      observation_id: 'overtrading',
      text: '往返次数较多，但暂无可执行模板。',
      evidence_event_indexes: events.map((_, index) => index).slice(0, 8),
    });
  }
  return observations;
}
// 本地意图映射：只用于走查 L2 与澄清分支，不代表模型准确率；也覆盖固定评测集，便于离线回归。
const FAKE_INTENT_RULES = Object.freeze([
  { intent: 'out_of_scope', test: /(荐股|推荐.*(股票|标的|基金)|买什么|卖不卖|该买|该卖|能不能买|可以买吗|能买吗|抄底|逃顶|会涨|会跌|会不会涨|会不会跌|涨不涨|跌不跌|预测|目标价|明天买|明天卖|后市|涨停|翻倍|挑.*(?:票|股)|赚钱的票|大盘.*(?:涨|跌|往上|往下)|会往上|会往下)/u },
  { intent: 'worst_trade', test: /(最错|最伤|最亏|最差|后悔|代价最高|亏损最大|亏最多|哪笔亏)/u },
  { intent: 'what_if', test: /(如果|要是|假如|假设|倘若|平行推演).*(没卖|没买|不卖|不买|没有卖|没有买|没发生|会差|结果)|(?:没卖|没买|不卖|不买|没有卖|没有买).*(?:会怎样|会差|结果|多少)/u },
  { intent: 'contract_status', test: /(?:规则|止损|止盈|提醒|规矩).*(?:守得住|守住|生效|有效|被触发|触发过|触发了|触发几次|触发了几次|违反|状态|表现)|守约/u },
  { intent: 'contract_setup', test: /(帮我定|定个|立规矩|设提醒|设个规则|定规则|加一条|限制自己|提醒规则|仓位建议|帮我设|设置.*规则)/u },
  { intent: 'meta_calc', test: /(怎么算|如何算|怎么计算|如何计算|口径|公式|怎么得出来|从哪来|来源)/u },
  { intent: 'meta_trust', test: /(可信|靠谱|准确|复核|验证|对不对|有没有错|算错|放心|稳吗|可靠)/u },
  { intent: 'how_to_change', test: /(怎么改|如何改|怎么避免|如何避免|下次.*(?:不|怎么|如何)|改进|怎么才能|如何能|有什么办法|不想再|我该怎么做|该怎么办)/u },
  { intent: 'pattern_explain', test: /(追高|追涨|买在高点|高点买入|栽跟头|同一个错误|反复|手痒|拿不住|刚买就卖|频繁|为什么一|为什么会)/u },
  { intent: 'profile', test: /(我是谁|我的风格|交易风格|画像|我的习惯|性格|我是什么样|操作特点|哪种交易者|属于哪种)/u },
  { intent: 'similar_context', test: /(类似|相似|历史上|以前.*(?:遇到|情况|时候)|过往|更早.*记录|一样的局面|跨账单)/u },
  { intent: 'loss_overview', test: /(整体|组合|账户|持仓|总体|收益|盈亏|亏损|赚|表现|概括|结果)/u },
]);

function fakeIntentSlots(text) {
  const slots = {};
  const symbol = text.match(/(?:^|[^\d])(\d{6})(?!\d)/u);
  if (symbol) slots.symbol = symbol[1];
  const date = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/u);
  if (date) {
    const month = String(Number(date[2])).padStart(2, '0');
    const day = String(Number(date[3])).padStart(2, '0');
    slots.trade_date = `${date[1]}-${month}-${day}`;
  }
  return slots;
}

const FIXED_TRADES = [
  {
    date: '2024-09-24', symbol: '600519', side: '买入', price: '100.00', quantity: '100',
    fee: '5.00', tax: '0.00', confidence: 0.9, issues: [],
  },
  {
    date: '2024-09-25', symbol: '600519', side: '卖出', price: '110.00', quantity: '100',
    fee: '5.00', tax: '1.00', confidence: 0.9, issues: [],
  },
];

export function createLocalFakeImportModel() {
  let visionCalls = 0;
  let explanationCalls = 0;
  const failVisionOnce = process.env.TM_FAKE_VISION_FAIL_ONCE === '1';
  const failExplanationOnce = process.env.TM_FAKE_EXPLAIN_FAIL_ONCE === '1';
  const delayMs = Math.max(0, Number(process.env.TM_FAKE_DELAY_MS) || 0);
  const wait = () => (delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve());
  return Object.freeze({
    async importRecover({ content, flow_id, request_id }) {
      await wait();
      const text = String(content ?? '');
      console.log(`[dev-fake] text request flow=${flow_id ?? '—'} request=${request_id ?? '—'} chars=${text.length}`);
      if (text.includes('[FAKE_UPSTREAM_ERROR]')) throw new Error('local fake upstream error');
      if (text.includes('[FAKE_INVALID_RESPONSE]')) return { rawText: 'not-json' };
      if (text.includes('[FAKE_EMPTY]')) return { rawText: JSON.stringify({ trades: [], unresolved: [] }) };
      if (text.includes('[FAKE_UNRESOLVED]')) {
        return { rawText: JSON.stringify({ trades: [], unresolved: [{ row: 2, reason: '日期无法确定（本地 fake）' }] }) };
      }
      return { rawText: JSON.stringify({ trades: FIXED_TRADES, unresolved: [] }) };
    },
    // 问答意图（/api/llm/intent）：确定性映射，便于本地走查 L2、低置信度与非法回包分支。
    // [FAKE_INTENT_INVALID] → 非 JSON；[FAKE_INTENT_LOW] → 置信度 0.2。
    async intent({ question }) {
      await wait();
      const text = String(question ?? '');
      console.log(`[dev-fake] intent request chars=${text.length}`);
      if (text.includes('[FAKE_INTENT_INVALID]')) return { rawText: 'not-json' };
      if (text.includes('[FAKE_INTENT_LOW]')) {
        return { rawText: JSON.stringify({ intent: 'loss_overview', slots: fakeIntentSlots(text), confidence: 0.2 }) };
      }
      const rule = FAKE_INTENT_RULES.find((item) => item.test.test(text));
      return {
        rawText: JSON.stringify({
          intent: rule?.intent ?? 'loss_overview',
          slots: fakeIntentSlots(text),
          confidence: rule ? 0.9 : 0.35,
        }),
      };
    },
    async vision({ images, source_kind, flow_id, request_id }) {
      await wait();
      visionCalls += 1;
      console.log(`[dev-fake] vision request flow=${flow_id ?? '—'} request=${request_id ?? '—'} images=${images.length} source=${source_kind}`);
      if (failVisionOnce && visionCalls === 1) return { rawText: 'not-json' };
      const trades = images.map((_, index) => ({
        date: `2024-09-${String(24 + index).padStart(2, '0')}`,
        symbol: '600519', side: '买入', price: '100.00', quantity: '100',
        fee: '5.00', tax: '0.00', confidence: 0.9, issues: [],
      }));
      return { rawText: JSON.stringify({ trades, unresolved: [] }) };
    },
    async behaviorAnalysis({ facts }) {
      await wait();
      const pattern = facts?.pattern ?? {};
      const observations = behaviorFakeObservation(facts);
      const comment = pattern.status === '成立'
        ? `发现 ${pattern.sample_n} 笔在短期上涨后买入。`
        : pattern.status === '证据不足'
          ? '可评估样本不足，暂不下结论。'
          : '未发现达到最小重复数的追高模式。';
      return {
        rawText: JSON.stringify({
          patterns: [{
            pattern_id: pattern.pattern_id,
            status: pattern.status,
            sample_n: pattern.sample_n,
            evaluated_n: pattern.evaluated_n,
            evidence_event_indexes: [...(pattern.evidence_event_indexes ?? [])],
            comment,
          }],
          observations,
          rule_candidates: pattern.status === '成立'
            ? [{ candidate_id: BEHAVIOR_CANDIDATE.candidate_id, template_id: BEHAVIOR_CANDIDATE.template_id }]
            : [],
        }),
      };
    },
    async ruleIntent({ allowed_templates }) {
      await wait();
      const ids = (Array.isArray(allowed_templates) ? allowed_templates : [])
        .map((t) => (typeof t === 'string' ? t : t && t.template_id)).filter(Boolean);
      const templateId = ids.includes('no_buy_on_surge') ? 'no_buy_on_surge' : ids[0];
      if (!templateId) {
        return { rawText: JSON.stringify({ intent: 'contract_setup', confidence: 0.2, clarify: '请说明要设置的规则模板', unsupported: null }) };
      }
      const fields = templateId === 'no_buy_back_within' ? { days: 3 } : { threshold_pct: 5 };
      return { rawText: JSON.stringify({ intent: 'contract_setup', confidence: 0.9, template_id: templateId, fields, clarify: null, unsupported: null }) };
    },
    // 规则页自然语言识别（/api/llm/rule）：确定性草案，便于本地走查自定义规则全链路。
    // 含「提醒/核对/检查」→ 自定义规则（动作/范围按文本推导）；文本含 [FAKE_INVALID_RESPONSE] → 无效回包。
    async rule({ text }) {
      await wait();
      const t = String(text ?? '');
      console.log(`[dev-fake] rule request chars=${t.length}`);
      if (t.includes('[FAKE_INVALID_RESPONSE]')) return { rawText: 'not-json' };
      if (/(提醒|核对|检查)/.test(t)) {
        const action = t.includes('卖出') ? 'sell' : t.includes('买入') ? 'buy' : 'both';
        const symbol = (t.match(/\d{6}/) ?? [null])[0];
        return {
          rawText: JSON.stringify({
            status: 'custom', kind: 'custom', template_id: null, params: {},
            scope: symbol ? { kind: 'symbol', symbol } : { kind: 'all', symbol: null },
            action, needs: [], missing: [], understanding: '本地 fake：自定义提醒规则草案',
          }),
        };
      }
      return {
        rawText: JSON.stringify({
          status: 'template', kind: 'template', template_id: 'no_buy_on_surge',
          params: { threshold_pct: 5 }, scope: { kind: 'all', symbol: null }, action: 'buy',
          needs: [], missing: [], understanding: '本地 fake：模板规则草案',
        }),
      };
    },
    async resultExplanation({ flow_id, request_id, rule, simulation }) {
      await wait();
      explanationCalls += 1;
      console.log(`[dev-fake] result-explanation flow=${flow_id ?? '—'} request=${request_id ?? '—'} rule=${rule?.template_id ?? '—'}`);
      if (failExplanationOnce && explanationCalls === 1) return { rawText: 'not-json' };
      const summary = simulation?.summary ?? {};
      const triggered = simulation?.results?.every?.((r) => r.display_verdict === 'triggered') === true;
      const outcome = triggered ? '命中' : '未命中';
      const effective = simulation?.effective_date && simulation.effective_date !== simulation.requested_date
        ? `（实际使用交易日 ${simulation.effective_date}）`
        : '';
      return {
        rawText: JSON.stringify({
          answer_text: `本次模拟执行完成：${simulation?.symbol ?? '—'} 在 ${simulation?.requested_date ?? '—'}${effective}${outcome}；`
            + `触发 ${summary.triggered ?? 0} 条、未触发 ${summary.not_triggered ?? 0} 条、`
            + `不适用 ${summary.not_applicable ?? 0} 条、数据不足 ${summary.missing_data ?? 0} 条、错误 ${summary.error ?? 0} 条。`,
        }),
      };
    },
    async scenarioJudgment({ scenario }) {
      await wait();
      const rules = Array.isArray(scenario?.rules) ? scenario.rules : [];
      const symbol = scenario?.symbol ?? '—';
      const date = scenario?.requested_date ?? '—';
      const ineffective = rules.filter((r) => r.verdict === 'not_applicable' || r.verdict === 'missing_data').length;
      return {
        rawText: JSON.stringify({
          judgment: 'no_match',
          answer_text: rules.length
            ? `本次情景 ${symbol} 在 ${date} 没有匹配任何已锁定规则；已检查 ${rules.length} 条规则，其中 ${ineffective} 条不适用或数据不足。AI 只补充未命中理由，规则结果仍以本地判定为准。`
            : `本次情景 ${symbol} 在 ${date} 没有可匹配的已锁定规则；AI 只补充这一判断的理由，不会创建或保存规则。`,
        }),
      };
    },
    // 自定义规则情境判定（/api/llm/custom-rule-judgment）：服务端已校验请求并会附加 binding，这里只回判定 JSON。
    // 规则文本含「核对」→ triggered，否则 not_triggered；[FAKE_UNABLE] → unable；[FAKE_JUDGE_INVALID] → 无效回包。
    async customRuleJudgment({ rule, scenario, data }) {
      await wait();
      const hash = String(rule?.hash ?? '—').slice(0, 12);
      console.log(`[dev-fake] custom-rule-judgment rule=${hash} symbol=${scenario?.symbol ?? '—'} date=${scenario?.requested_date ?? '—'}`);
      const text = String(rule?.text ?? '');
      if (text.includes('[FAKE_JUDGE_INVALID]')) return { rawText: 'not-json' };
      if (text.includes('[FAKE_UNABLE]')) {
        return { rawText: JSON.stringify({ verdict: 'unable', reason: '本地 fake：给定数据不足以确认这条规则的条件是否满足。', used_data: [] }) };
      }
      const used = [];
      if (typeof scenario?.change_pct === 'number') used.push('change_pct');
      if (Array.isArray(data?.buys) && data.buys.length) used.push('buys');
      if (Array.isArray(data?.sells) && data.sells.length) used.push('sells');
      if (Array.isArray(data?.trading_days) && data.trading_days.length) used.push('calendar');
      const triggered = text.includes('核对');
      const actWord = scenario?.action === 'sell' ? '卖出' : '买入';
      return {
        rawText: JSON.stringify({
          verdict: triggered ? 'triggered' : 'not_triggered',
          reason: triggered
            ? `按规则「${text}」，${scenario?.symbol ?? '—'} 在 ${scenario?.requested_date ?? '—'} 的${actWord}情境需要先核对再操作；判定只用于提醒。`
            : `按规则「${text}」，${scenario?.symbol ?? '—'} 在 ${scenario?.requested_date ?? '—'} 的给定数据下未满足提醒条件；判定只用于提醒。`,
          used_data: used,
        }),
      };
    },
    async restate({ facts }) {
      await wait();
      const displays = (Array.isArray(facts) ? facts : []).map((f) => f && f.display).filter(Boolean);
      const answer = displays.length
        ? `已核对事实：${displays.join('、')}。这是对已发生交易的事后复述，不预测、不推荐。`
        : '当前没有可复述的已核对事实。';
      return { rawText: JSON.stringify({ answer_text: answer }) };
    },
    // 画像解读（/api/llm/profile-summary）：只用摘要中已有的数字，便于本地验证缓存与展示。
    async profileSummary({ digest }) {
      await wait();
      const metrics = digest?.metrics ?? {};
      const count = digest?.bills?.count ?? 0;
      const pct = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
      const headline = metrics.drag_pp === null || metrics.drag_pp === undefined
        ? '先积累更多样本'
        : metrics.drag_pp > 0.005 ? '择时拖累了收益' : '择时影响有限';
      const parts = [`已记录 ${count} 份账单、${metrics.trade_count ?? 0} 笔交易。`];
      if (metrics.actual_return !== null && metrics.actual_return !== undefined) {
        parts.push(`实际收益 ${pct(metrics.actual_return)}。`);
      }
      if (metrics.drag_pp !== null && metrics.drag_pp !== undefined) {
        parts.push(`择时差异 ${pct(metrics.drag_pp)}。`);
      }
      if (Array.isArray(digest?.behavior?.tags) && digest.behavior.tags.length) {
        parts.push(`行为标签：${digest.behavior.tags.join('、')}。`);
      }
      return {
        rawText: JSON.stringify({
          schema_version: 1,
          headline,
          summary: parts.join(''),
          strengths: (digest?.behavior?.tags ?? []).slice(0, 2),
          blind_spots: count < 3 ? ['样本仍然有限，结论可能随账单增加而变化。'] : [],
          next_actions: ['下次交易前先写下理由，并在复盘时核对。'],
          confidence: count >= 3 ? 'high' : count >= 1 ? 'medium' : 'low',
          data_limits: count < 3 ? [`当前只有 ${count} 份账单，不足以形成稳定结论。`] : [],
        }),
      };
    },
    // 对话画像事实（/api/llm/profile-fact）：本地按句子做保守抽取，证据保留原句。
    async profileFact({ message }) {
      await wait();
      const text = String(message ?? '');
      console.log(`[dev-fake] profile-fact request chars=${text.length}`);
      if (text.includes('[FAKE_FACT_INVALID]')) return { rawText: 'not-json' };
      if (text.includes('[FAKE_NO_FACTS]')) return { rawText: JSON.stringify({ facts: [] }) };
      const sentences = text.split(/[。！？!?\n]/u).map((s) => s.trim()).filter(Boolean);
      const facts = [];
      for (const sentence of sentences) {
        if (!/投资|交易|股票|基金|仓位|回撤|风险|收益|亏损|止损|止盈|持有|买入|卖出|理财|资金|纪律|目标|计划/u.test(sentence)) continue;
        if (/[？?]$/u.test(sentence)) continue;
        let kind = null;
        let key = null;
        if (/回撤|亏损|风险/u.test(sentence) && /\d/u.test(sentence)) {
          kind = 'risk_tolerance';
          key = 'drawdown_limit';
        } else if (/目标|希望|计划|长期/u.test(sentence)) {
          kind = 'goal';
          key = 'investment_goal';
        } else if (/不能|不碰|限制|只用|只做/u.test(sentence)) {
          kind = 'constraint';
          key = 'trading_constraint';
        } else if (/喜欢|偏好|倾向/u.test(sentence)) {
          kind = 'preference';
          key = 'investment_preference';
        } else if (/我一般|我通常|总是|习惯|经常/u.test(sentence)) {
          kind = 'habit';
          key = 'trading_habit';
        }
        if (!kind || [...sentence].length > 120) continue;
        facts.push({ kind, key, value: sentence, evidence: sentence });
        if (facts.length >= 3) break;
      }
      return { rawText: JSON.stringify({ facts }) };
    },
  });
}
