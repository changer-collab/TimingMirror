#!/usr/bin/env node
/**
 * M1-C10 在线接入准备 · 代理边界与 fake transport 定向测试（本地离线；零依赖）
 *
 * 覆盖：意图成功/非法 JSON/schema 错误/超时/网络失败；
 *       复述成功/空文本/格式错误/schema 错误/超时/网络失败/本地数字检查失败；
 *       出站请求白名单（intent 仅 question；restate 仅 question + F-6 facts 字段）；
 *       不含 review/prepared/plan/provenance/成交行/文件名/账户信息/API Key；
 *       fake transport 调用计数、网络 fetch 调用数为 0；可替换 question policy。
 * 边界：不调用百炼、不发起网络请求、不读取凭证；通过不代表在线链路或 M0-C3/C4 连通验证。
 * 运行：node tests/agent/online-boundary.test.mjs（或 npm run check）
 */
import {
  createOnlineBoundary,
  buildIntentRequest,
  buildRestateRequest,
  projectOnlineFacts,
  applyQuestionPolicy,
  TransportError,
  CONFIRMED_FACT_FIELDS,
  SUPPORTED_FACT_UNITS,
  ONLINE_BOUNDARY_CODES,
} from '../../src/agent/onlineBoundary.js';
import { runReview } from '../../src/agent/reviewPipeline.js';
import { exportFacts } from '../../src/agent/factExport.js';
import {
  createFakeTransport,
  jsonResponse,
  rawResponse,
  networkFailure,
  hangingResponse,
} from './fake-online-transport.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '组合整体表现如何？';
const ANSWER = '组合实际收益 +7.5%，对照收益 +15.0%，择时损耗 +7.5pp，损耗金额 ¥150.00。';
const FACTS = [
  {
    fact_ref: 'F-aaaa1111', scope: 'portfolio', key: 'actualRet',
    value: 0.075, unit: '%', display: '+7.5%', formula_ref: 'CALC_RET_V1', source_ref: 'src-aaaa1111',
    trade_id: 'T001', symbol: '000000', fileName: 'secret.csv',
    source: { file: 'secret.csv', line: 2 },
    review: 'review-marker', prepared: 'prepared-marker', plan: 'plan-marker', provenance: 'provenance-marker',
    account: 'account-marker', api_key: 'forbidden-key-value',
  },
  {
    fact_ref: 'F-bbbb2222', scope: 'portfolio', key: 'ghostRet',
    value: 0.15, unit: '%', display: '+15.0%', formula_ref: 'CALC_RET_V1', source_ref: 'src-bbbb2222',
  },
  {
    fact_ref: 'F-cccc3333', scope: 'portfolio', key: 'drag',
    value: 0.075, unit: 'pp', display: '+7.5pp', formula_ref: 'CALC_DRAG_PP_V1', source_ref: 'src-cccc3333',
  },
  {
    fact_ref: 'F-dddd4444', scope: 'portfolio', key: 'dragMoney',
    value: 150, unit: '元', display: '¥150.00', formula_ref: 'CALC_DRAG_MONEY_V1', source_ref: 'src-dddd4444',
  },
];
const cloneFacts = () => FACTS.map((fact) => ({ ...fact }));

const mkTrade = (id, date, side, price, line) => ({
  trade_id: id, trade_date: date, symbol: '000000', side, price, quantity: 100,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  source: { file: 'synthetic.csv', line },
});
const realReview = runReview({
  trades: [mkTrade('T1', '2024-09-24', 'buy', 10, 2), mkTrade('T2', '2024-09-27', 'sell', 11, 3)],
  closes: { '000000': 12 },
  valuation: { requested_date: '2024-10-11', effective_date: '2024-10-11' },
});
const REAL_FOUR = exportFacts({ review: realReview, intent: 'loss_overview', scope: 'portfolio' }).facts
  .filter((f) => ['actualRet', 'ghostRet', 'drag', 'dragMoney'].includes(f.key));

const previousFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  throw new Error('测试期间禁止网络请求');
};

try {
  /* ==== 边界：事实字段白名单 ==== */
  check('F-6 事实字段：仅 value/unit/display/formula_ref/source_ref', CONFIRMED_FACT_FIELDS.join(',') === 'value,unit,display,formula_ref,source_ref');
  {
    const built = buildIntentRequest({ question: QUESTION, review: { marker: 'review-marker' } });
    check('intent 请求体仅 question（忽略额外入参）', built.ok && Object.keys(built.request).join(',') === 'question' && built.request.question === QUESTION, JSON.stringify(built));
  }
  {
    const built = buildRestateRequest({
      question: QUESTION,
      facts: FACTS,
      review: { marker: 'review-marker' },
      prepared: { marker: 'prepared-marker' },
      plan: { marker: 'plan-marker' },
      provenance: { marker: 'provenance-marker' },
    });
    const req = built.request;
    const keys = new Set(Object.keys(req));
    const factKeys = new Set(req.facts.flatMap((f) => Object.keys(f)));
    const serialized = JSON.stringify(req);
    check('restate 请求体仅 question + facts', built.ok && keys.has('question') && keys.has('facts') && keys.size === 2, JSON.stringify([...keys]));
    check('restate facts 仅 F-6 字段', [...factKeys].every((k) => CONFIRMED_FACT_FIELDS.includes(k)), JSON.stringify([...factKeys]));
    check('restate 丢弃 key/fact_ref/scope', !factKeys.has('key') && !factKeys.has('fact_ref') && !factKeys.has('scope'));
    check('restate 丢弃原始 source 对象（仅保留匿名 source_ref）', !factKeys.has('source') && factKeys.has('source_ref'));
    const banned = ['review-marker', 'prepared-marker', 'plan-marker', 'provenance-marker', 'T001', 'secret.csv', '000000', 'account-marker', 'forbidden-key-value', 'trade_id', 'fileName', 'api_key'];
    check('restate 请求体不含内部容器/成交/文件名/账户/Key 标记', banned.every((x) => !serialized.includes(x)), banned.filter((x) => serialized.includes(x)).join(','));
  }

  /* ==== 事实字段值类型：拒绝嵌套/非有限值，transport 不得被调用 ==== */
  {
    const facts = cloneFacts();
    facts[0].display = { nested: '+99.9%' };
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('display 嵌套对象：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
  }
  {
    const facts = cloneFacts();
    facts[0].source_ref = { nested: 'src-aaaa1111' };
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('source_ref 嵌套对象：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
  }
  {
    const facts = cloneFacts();
    facts[0].source_ref = 'src-not-a-handle';
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('source_ref 非法格式：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
  }
  {
    const facts = cloneFacts();
    facts[0].value = '0.075';
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('value 非数值：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
  }
  {
    const facts = cloneFacts();
    facts[0].unit = [];
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('unit 嵌套数组：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
  }
  {
    const built = buildRestateRequest({
      question: QUESTION,
      facts: [{ value: 0.075, unit: null, display: null, formula_ref: null, source_ref: null }],
    });
    check('字符串/null 契约：unit/display/formula_ref/source_ref 可为 null', built.ok && built.request.facts.length === 1, JSON.stringify(built));
  }
  {
    const facts = cloneFacts();
    facts[0].unit = 'account-123456';
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('unit 账户字符串：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
    check('unit 账户字符串：错误结果不回显原始值', !JSON.stringify(r).includes('account-123456'));
  }
  {
    const facts = cloneFacts();
    facts[0].display = 'secret-account.csv';
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('display 文件名字符串：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
    check('display 文件名字符串：错误结果不回显原始值', !JSON.stringify(r).includes('secret-account.csv'));
  }
  {
    const facts = cloneFacts();
    facts[0].formula_ref = 'account-secret-001';
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('formula_ref 账户字符串：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
    check('formula_ref 账户字符串：错误结果不回显原始值', !JSON.stringify(r).includes('account-secret-001'));
  }
  {
    const built = buildRestateRequest({ question: QUESTION, facts: FACTS });
    check('现有四事实合法 unit/display/formula_ref 仍通过', built.ok && built.request.facts.length === 4, JSON.stringify(built));
  }
  {
    const displays = ['+7.5%', '+7.5pp', '¥150.00', '¥-400.00'];
    const built = buildRestateRequest({
      question: QUESTION,
      facts: displays.map((display) => ({ value: 1, display })),
    });
    check('合法 display 格式仍通过（%、pp、人民币金额）', built.ok && built.request.facts.length === 4, JSON.stringify(built));
  }

  /* ==== 真实 factExport 描述性 unit 的显式在线投影 ==== */
  {
    const beforeUnits = REAL_FOUR.map((f) => f.unit);
    const beforeJson = JSON.stringify(REAL_FOUR);
    const projected = projectOnlineFacts(REAL_FOUR);
    check('真实 factExport 四事实投影成功', projected.ok && projected.facts.length === 4, JSON.stringify(projected));
    check('真实 factExport 描述性 unit 映射为短单位', projected.ok && projected.facts.every((f) => {
      if (f.formula_ref === 'CALC_RET_V1') return f.unit === '%';
      if (f.formula_ref === 'CALC_DRAG_PP_V1') return f.unit === 'pp';
      if (f.formula_ref === 'CALC_DRAG_MONEY_V1') return f.unit === '元';
      return false;
    }), JSON.stringify(projected.facts));
    check('投影结果不含描述性 unit', projected.ok && projected.facts.every((f) => !String(f.unit).includes('展示')));
    check('投影结果只含 F-6 字段且无 key/fact_ref/scope', projected.ok && projected.facts.every((f) => Object.keys(f).every((k) => CONFIRMED_FACT_FIELDS.includes(k))));
    check('原始 factExport facts 的 unit 未被修改', REAL_FOUR.map((f) => f.unit).join('|') === beforeUnits.join('|'));
    check('投影不修改输入 facts（逐字节一致）', JSON.stringify(REAL_FOUR) === beforeJson);
  }

  /* ==== 在线投影失败路径：transport 必须为 0 ==== */
  {
    const facts = cloneFacts();
    facts[0].unit = '未知单位';
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('未知描述性 unit：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
    check('未知描述性 unit：错误结果不回显原始值', !JSON.stringify(r).includes('未知单位'));
  }
  {
    const facts = cloneFacts();
    facts[0].formula_ref = 'CALC_UNKNOWN_V1';
    facts[0].unit = '%';
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('未知 formula_ref：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
    check('未知 formula_ref：错误结果不回显原始值', !JSON.stringify(r).includes('CALC_UNKNOWN_V1'));
  }
  {
    const facts = REAL_FOUR.slice(0, 1).map((f) => ({ ...f }));
    facts[0].formula_ref = null;
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('缺失 formula_ref/映射：E_FACT_FIELD_INVALID 且 transport 调用数为 0', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID && transport.calls.length === 0, JSON.stringify(r));
  }
  {
    const projected = projectOnlineFacts(cloneFacts());
    check('已是短单位的 fixture 继续通过', projected.ok && projected.facts.every((f) => SUPPORTED_FACT_UNITS.includes(f.unit)), JSON.stringify(projected));
  }

  /* ==== 意图：成功 ==== */
  {
    const transport = createFakeTransport({
      intent: () => jsonResponse({ intent: 'loss_overview', slots: {}, confidence: 0.9 }),
    });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.classifyIntent({ question: QUESTION });
    const req = transport.calls[0].request;
    check('意图成功：ok + intentJson', r.ok && r.stage === 'intent' && r.data.intentJson.intent === 'loss_overview' && r.code === null, JSON.stringify(r));
    check('意图成功：仅 fake transport 被调用 1 次', transport.calls.length === 1 && transport.calls[0].stage === 'intent');
    check('意图成功：transport 请求仅 question', Object.keys(req).join(',') === 'question' && req.question === QUESTION, JSON.stringify(req));
    check('意图成功：结果无硬编码 llm_mode/source', !('llm_mode' in r) && !('source' in r));
    check('意图成功：可配置 timeout_ms 与真实 latency', r.meta.timeout_ms === 50 && typeof r.meta.latency_ms === 'number', JSON.stringify(r.meta));
  }

  /* ==== 意图：非法 JSON ==== */
  {
    const transport = createFakeTransport({ intent: () => rawResponse('{not-json') });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.classifyIntent({ question: QUESTION });
    check('意图非法 JSON：E_INTENT_JSON 且不回显原文', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.INTENT_JSON && !JSON.stringify(r).includes('not-json'), JSON.stringify(r));
  }

  /* ==== 意图：schema 错误 ==== */
  {
    const transport = createFakeTransport({
      intent: () => jsonResponse({ intent: 'not_a_real_intent', slots: {}, confidence: 1 }),
    });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.classifyIntent({ question: QUESTION });
    check('意图 schema 错误：E_INTENT_SCHEMA', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.INTENT_SCHEMA && r.errors.length > 0, JSON.stringify(r));
  }

  /* ==== 意图：超时 ==== */
  {
    const transport = createFakeTransport({ intent: hangingResponse });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 10 });
    const r = await boundary.classifyIntent({ question: QUESTION });
    check('意图超时：E_TRANSPORT_TIMEOUT', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.TRANSPORT_TIMEOUT, JSON.stringify(r));
    check('意图超时：AbortController 已中止', transport.calls.length === 1 && transport.calls[0].signal.aborted === true);
  }

  /* ==== 意图：网络失败 ==== */
  {
    const transport = createFakeTransport({ intent: networkFailure });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.classifyIntent({ question: QUESTION });
    check('意图网络失败：E_TRANSPORT_NETWORK', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.TRANSPORT_NETWORK, JSON.stringify(r));
  }

  /* ==== 复述：成功 + 本地数字检查 ==== */
  {
    const transport = createFakeTransport({ restate: () => jsonResponse({ answer_text: ANSWER }) });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts: FACTS });
    const req = transport.calls[0].request;
    const serialized = JSON.stringify(req);
    check('复述成功：ok + draft + 数字检查 4/4', r.ok && r.stage === 'restate' && r.data.draft === ANSWER && r.data.number_check.ok === true && r.data.number_check.checked === 4 && r.data.number_check.matched_count === 4, JSON.stringify(r));
    check('复述成功：仅 fake transport 被调用 1 次', transport.calls.length === 1 && transport.calls[0].stage === 'restate');
    check('复述成功：请求体仅 question + facts', Object.keys(req).join(',') === 'question,facts', JSON.stringify(Object.keys(req)));
    check('复述成功：facts 仅 F-6 字段且丢弃 key/fact_ref/scope', req.facts.every((f) => Object.keys(f).every((k) => CONFIRMED_FACT_FIELDS.includes(k))));
    const banned = ['review-marker', 'prepared-marker', 'plan-marker', 'provenance-marker', 'T001', 'secret.csv', '000000', 'account-marker', 'forbidden-key-value', 'trade_id', 'fileName', 'api_key'];
    check('复述成功：请求体不含内部容器/成交/文件名/账户/Key 标记', banned.every((x) => !serialized.includes(x)), banned.filter((x) => serialized.includes(x)).join(','));
    check('复述成功：结果无硬编码 llm_mode/source', !('llm_mode' in r) && !('source' in r));
  }

  /* ==== 复述：transport 改写出站事实，不能影响本地数字校验快照 ==== */
  {
    const facts = cloneFacts();
    const transport = createFakeTransport({
      restate: ({ facts: outboundFacts }) => {
        outboundFacts[0].display = '+99.9%';
        outboundFacts[0].value = 0.999;
        return jsonResponse({ answer_text: '组合实际收益 +99.9%。' });
      },
    });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts });
    check('transport 改写事实后：本地快照不变，数字检查失败且无 draft', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.NUMBERS_FAILED && r.data && !('draft' in r.data) && r.data.number_check.failed_count === 1, JSON.stringify(r));
    check('transport 改写事实后：不回显 +99.9% 草稿', !JSON.stringify(r).includes('99.9'));
    check('transport 改写事实后：原始入参 facts 未被修改', facts[0].display === '+7.5%' && facts[0].value === 0.075);
    check('transport 改写事实后：transport 自身收到的是独立出站副本', transport.calls.length === 1 && transport.calls[0].request.facts[0].display === '+99.9%');
  }

  /* ==== 复述：空文本 ==== */
  {
    const transport = createFakeTransport({ restate: () => jsonResponse({ answer_text: '   ' }) });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('复述空文本：E_RESTATE_EMPTY 且无 draft', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.RESTATE_EMPTY && r.data === null, JSON.stringify(r));
  }

  /* ==== 复述：格式错误（非 JSON） ==== */
  {
    const transport = createFakeTransport({ restate: () => rawResponse('not-json') });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('复述格式错误：E_RESTATE_JSON 且不回显原文', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.RESTATE_JSON && !JSON.stringify(r).includes('not-json'), JSON.stringify(r));
  }

  /* ==== 复述：schema 错误 ==== */
  {
    const transport = createFakeTransport({ restate: () => jsonResponse({ foo: 'bar' }) });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('复述 schema 错误：E_RESTATE_SCHEMA 且无 draft', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.RESTATE_SCHEMA && r.data === null, JSON.stringify(r));
  }

  /* ==== 复述：transport 响应形状非法 ==== */
  {
    const transport = createFakeTransport({ restate: () => ({ body: 'not-raw-text' }) });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('复述响应形状非法：E_TRANSPORT_RESPONSE 且无 draft', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.TRANSPORT_RESPONSE && r.data === null, JSON.stringify(r));
  }

  /* ==== 复述：超时 ==== */
  {
    const transport = createFakeTransport({ restate: hangingResponse });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 10 });
    const r = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('复述超时：E_TRANSPORT_TIMEOUT', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.TRANSPORT_TIMEOUT, JSON.stringify(r));
    check('复述超时：AbortController 已中止', transport.calls.length === 1 && transport.calls[0].signal.aborted === true);
  }

  /* ==== 复述：网络失败 ==== */
  {
    const transport = createFakeTransport({ restate: networkFailure });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('复述网络失败：E_TRANSPORT_NETWORK', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.TRANSPORT_NETWORK, JSON.stringify(r));
  }

  /* ==== 复述：本地数字检查失败 ==== */
  {
    const transport = createFakeTransport({ restate: () => jsonResponse({ answer_text: '实际收益 +99.9%。' }) });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 50 });
    const r = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('数字检查失败：W_ANSWER_NUMBERS_FAILED 且不返回 draft', r.ok === false && r.code === ONLINE_BOUNDARY_CODES.NUMBERS_FAILED && r.data && !('draft' in r.data) && r.data.number_check.failed_count === 1, JSON.stringify(r));
    check('数字检查失败：不泄出失败数字原文', !JSON.stringify(r).includes('99.9'));
  }

  /* ==== 可替换 question policy：阻断 / 改写 ==== */
  {
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({
      transport,
      timeoutMs: 50,
      questionPolicy: (q) => (q.includes('MARKER') ? { allow: false, code: 'E_TEST_BLOCKED' } : { allow: true }),
    });
    const r = await boundary.classifyIntent({ question: '请处理 MARKER 账户' });
    check('question policy：阻断时不调用 transport', r.ok === false && r.code === 'E_TEST_BLOCKED' && transport.calls.length === 0, JSON.stringify(r));
  }
  {
    const transport = createFakeTransport();
    const boundary = createOnlineBoundary({
      transport,
      timeoutMs: 50,
      questionPolicy: (q) => ({ allow: true, question: q.replace('MARKER', '[已隐藏]') }),
    });
    const r = await boundary.classifyIntent({ question: '账户 MARKER 表现如何？' });
    check('question policy：改写文本进入请求', r.ok === true && transport.calls[0].request.question === '账户 [已隐藏] 表现如何？');
  }
  {
    const gate = applyQuestionPolicy('正常问题', null);
    check('question policy：默认放行，不内置正则规则', gate.allow === true && gate.question === '正常问题');
  }
} finally {
  globalThis.fetch = previousFetch;
}

/* ==== 网络与 transport 计数 ==== */
check('网络：测试期间 fetch 调用数为 0', fetchCalls === 0, `fetchCalls=${fetchCalls}`);
check('transport：TransportError 可被 fake 复用', new TransportError('E_TEST').code === 'E_TEST');

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
