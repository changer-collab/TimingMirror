#!/usr/bin/env node
/**
 * 导入页 AI 识别入口 —— 离线单测（fake importRecovery client；不联网、不调用真实模型）
 *
 * 覆盖：截图/扫描 PDF 与提取文字主动触发、成功只进入可编辑草稿、失败不伪造、
 *       不自动确认账单、不写入问答账本。
 * 运行：node tests/agent/import-ai-action.test.mjs
 */
import { defaultBill, defaultChat, defaultImportRecovery } from '../../src/state.js';
import { runImportAi } from '../../prototype/user-frontend/realImport.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const TRADE = {
  date: '2024-09-24', symbol: '600519', side: '买入', price: '100.00', quantity: '100',
  fee: '5.00', tax: '0.00', confidence: 0.9, issues: [],
};

function makeCtx({ rec, client }) {
  const state = {
    bill: { ...defaultBill(), status: 'none', sourceType: 'local', fileName: 'shot.png' },
    chat: defaultChat('bill-ai-1'),
    importRecovery: rec,
  };
  return {
    state,
    set(patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)
          && state[key] && typeof state[key] === 'object' && !Array.isArray(state[key])) {
          state[key] = { ...state[key], ...value };
        } else {
          state[key] = value;
        }
      }
    },
    importRecovery: client,
  };
}

function visionRec(extra = {}) {
  return {
    ...defaultImportRecovery(),
    sourceId: 'source-image-1',
    sourceKind: 'image',
    status: 'vision_ready',
    pending: false,
    budgetExhausted: false,
    vision: {
      ...defaultImportRecovery().vision,
      kind: 'image',
      status: 'ready',
      images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }],
    },
    ...extra,
  };
}

function textRec(extra = {}) {
  return {
    ...defaultImportRecovery(),
    sourceId: 'source-text-1',
    sourceKind: 'text',
    status: 'needs_ai',
    content: '2024-09-24 600519 买入 100.00 100',
    pending: false,
    budgetExhausted: false,
    ...extra,
  };
}

function clientOf({ visionResult = null, textResult = null, failWith = null } = {}) {
  const calls = { vision: 0, text: 0, payloads: [] };
  return {
    calls,
    async requestVision(payload) {
      calls.vision += 1;
      calls.payloads.push(payload);
      if (failWith) return failWith;
      return visionResult;
    },
    async requestRecovery(payload) {
      calls.text += 1;
      calls.payloads.push(payload);
      if (failWith) return failWith;
      return textResult;
    },
    getSession() {
      return { flow_id: 'flow-ai-1', model_calls: 1, budget_max: 2, request_ids: ['req-ai-1'] };
    },
  };
}

/* ==== 截图 / 扫描 PDF：主动触发，成功只进入草稿 ==== */
{
  const client = clientOf({ visionResult: { ok: true, draft: { trades: [TRADE], unresolved: [] }, trace: {} } });
  const ctx = makeCtx({ rec: visionRec(), client });
  const result = await runImportAi(ctx);
  check('视觉识别：成功返回草稿数量', result.ok === true && result.kind === 'vision' && result.draftCount === 1,
    JSON.stringify(result));
  check('视觉识别：只请求所选图片，不发送文件名或其他文件',
    client.calls.vision === 1 && client.calls.text === 0
    && client.calls.payloads[0]?.sourceKind === 'image'
    && JSON.stringify(client.calls.payloads[0]).includes('data_base64')
    && !JSON.stringify(client.calls.payloads[0]).includes('shot.png'),
    JSON.stringify(client.calls.payloads));
  check('视觉识别：结果进入可编辑草稿，不自动确认账单、不写问答账本',
    ctx.state.importRecovery.status === 'draft'
    && ctx.state.importRecovery.draft?.rows?.length === 1
    && ctx.state.bill.status === 'none'
    && ctx.state.chat.messages.length === 0,
    JSON.stringify({ status: ctx.state.importRecovery.status, bill: ctx.state.bill.status, chat: ctx.state.chat.messages.length }));
}

/* ==== 自然语言账单片段：主动触发，只发送提取文字 ==== */
{
  const client = clientOf({ textResult: { ok: true, draft: { trades: [TRADE], unresolved: [] }, trace: {} } });
  const ctx = makeCtx({ rec: textRec(), client });
  const result = await runImportAi(ctx);
  check('文字识别：成功返回草稿数量并只发送提取文字',
    result.ok === true && result.kind === 'text' && result.draftCount === 1
    && client.calls.text === 1 && client.calls.vision === 0
    && client.calls.payloads[0]?.content === '2024-09-24 600519 买入 100.00 100'
    && !JSON.stringify(client.calls.payloads[0]).includes('shot.png'),
    JSON.stringify({ result, payloads: client.calls.payloads }));
  check('文字识别：结果进入可编辑草稿，不自动确认账单',
    ctx.state.importRecovery.status === 'draft'
    && ctx.state.importRecovery.draft?.rows?.length === 1
    && ctx.state.bill.status === 'none',
    JSON.stringify({ status: ctx.state.importRecovery.status, bill: ctx.state.bill.status }));
}

/* ==== 失败：明确返回失败，不生成草稿 ==== */
{
  const client = clientOf({ failWith: { ok: false, code: 'E_MODEL_NOT_CONFIGURED', message: '模型未配置' } });
  const ctx = makeCtx({ rec: visionRec(), client });
  const result = await runImportAi(ctx);
  check('视觉模型不可用：返回失败码，不伪造成功、不生成草稿',
    result.ok === false && result.code === 'E_MODEL_NOT_CONFIGURED'
    && !ctx.state.importRecovery.draft
    && ctx.state.bill.status === 'none',
    JSON.stringify({ result, bill: ctx.state.bill.status, draft: ctx.state.importRecovery.draft }));
}

/* ==== 未主动触发所需条件缺失 / 预算耗尽：不发起请求 ==== */
{
  const noSource = clientOf({});
  const ctx = makeCtx({ rec: { ...defaultImportRecovery(), status: 'local_ready' }, client: noSource });
  const result = await runImportAi(ctx);
  check('没有截图/文字：不发起识别请求',
    result.ok === false && result.code === 'E_IMPORT_AI_NO_SOURCE'
    && noSource.calls.vision === 0 && noSource.calls.text === 0,
    JSON.stringify({ result, calls: noSource.calls }));

  const exhausted = clientOf({});
  const exhaustedCtx = makeCtx({ rec: visionRec({ budgetExhausted: true }), client: exhausted });
  const exhaustedResult = await runImportAi(exhaustedCtx);
  check('识别次数用完：不发起识别请求',
    exhaustedResult.ok === false && exhaustedResult.code === 'E_IMPORT_AI_BUDGET'
    && exhausted.calls.vision === 0,
    JSON.stringify({ result: exhaustedResult, calls: exhausted.calls }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
