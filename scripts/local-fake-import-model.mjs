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
