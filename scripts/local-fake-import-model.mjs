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
  });
}
