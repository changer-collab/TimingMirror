// 仅本地开发使用的假模型：不联网、不读取凭据，返回固定草案或受控错误。
// 只在 scripts/serve.mjs 中注入；不进入站点 Function，也不参与线上部署。
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
  const failVisionOnce = process.env.TM_FAKE_VISION_FAIL_ONCE === '1';
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
