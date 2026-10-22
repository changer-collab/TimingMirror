#!/usr/bin/env node
// ROLLBACK_ADAPTER 可指向改动前的 adapter.js 副本，以验证旧版读写新记录。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fetchCalls = [];
let mutateDynamic = null;
const cacheFixture = JSON.parse(readFileSync(join(ROOT, 'data/market-cache.json'), 'utf8'));
globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push(String(url));
  if (String(url) === '/functions/v1/app/api/market/snapshot') {
    const req = JSON.parse(options.body);
    const end = '2025-12-31';
    const start = req.start;
    const time = '2026-10-21T00:00:00Z';
    const pick = (bars) => (bars ?? []).filter((b) => b.date >= start && b.date <= end).map((b) => ({ date: b.date, close: b.close }));
    const market = {
      artifact: 'market-cache-dynamic', manifest_version: 'dynamic-v1', fetched_at: time,
      checksum: '0123456789abcdef'.repeat(4), asOfDate: end,
      source: { provider: 'tushare', freshness: 'latest_closed_daily' },
      manifest: { symbols: req.symbols, date_range: { start, end }, asOfDate: end },
      calendar: { trading_days: cacheFixture.calendar.trading_days.filter((d) => d >= start && d <= end) },
      symbols: Object.fromEntries(req.symbols.map((s) => [s, { bars: pick(cacheFixture.symbols[s]?.bars), bars_fwdadj: pick(cacheFixture.symbols[s]?.bars_fwdadj) }])),
      snapshot: { snapshot_id: 'offline-dynamic-test', fetch_time: time, latest_trade_date: end, range: { start, end }, symbols: req.symbols, provider: 'tushare' },
    };
    if (mutateDynamic) mutateDynamic(market);
    return { ok: true, status: 200, json: async () => ({ ok: true, market }) };
  }
  const rel = String(url).replace(/^\//, '');
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(raw), text: async () => raw };
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

const A = await import('../src/demo/adapter.js');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const sym = (s) => ({ kind: 'symbol', symbol: s });
const surge = (pct, scope) => A.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: String(pct) }, scope });
const buyback = (days, scope) => A.previewContract({ template_id: 'no_buy_back_within', fields: { days: String(days) }, scope });
const save = (versions, parsed, opts = {}) => [...versions, ...A.contractSaveRecords(versions, { parsed, note: null, ...opts })];
const stripAt = (recs) => recs.map(({ at, ...rest }) => rest);
const ruleOf = (versions, hash) => A.contractRuleSet(versions).rules.find((r) => r.hash === hash);
const syntheticBill = null;

/* ==== 1. v1：保存记录格式与读取结果不变 ==== */
const s5 = surge(5);
const b3 = buyback(3);
let v = save([], s5);
v = save(v, b3);
check('v1 保存：全部股票的规则仍写 contract-v1 记录，无 scope 字段，哈希与 parseContract 一致', v.length === 2 && v.every((r) => r.schema === 'contract-v1' && !('scope' in r))
  && v[0].hash === s5.hash && v[0].text === '当天涨幅超过 5% 的票，我绝不买入。', JSON.stringify(v));
{
  const rs = A.contractRuleSet(v);
  check('v1 读取：两条当前规则，范围为全部股票、格式 contract-v1、完整性通过', rs.current.length === 2 && rs.current.every((r) => r.scope.kind === 'all' && r.scope_text === '全部股票'
    && r.schema === 'contract-v1' && r.integrity.ok) && rs.legacy.length === 0 && rs.next_version === 3);
}

/* ==== 2. 替代：全部股票 → 单个代码（缩小）须确认 ==== */
const sc3 = surge(3, sym('000000'));
{
  const d = A.contractEditorState(v, sc3, { targetHash: s5.hash });
  check('编辑已有规则：新范围属于原规则的新版本', d.action === 'edit' && d.canSave && d.current.hash === s5.hash);
  const recs = A.contractSaveRecords(v, { parsed: sc3, targetHash: s5.hash, confirmScopeChange: true });
  const [retire, nv] = recs;
  check('替代已确认：追加 v2 记录（scope、版本 v3、已改写、from_v=1）+ 原 v1 规则追加 v1 格式“已拒绝 · 经替代”记录（指向 v2 哈希）',
    recs.length === 2 && nv.schema === 'contract-v2' && nv.scope.symbol === '000000' && nv.v === 3 && nv.status === '已确认' && nv.hash === sc3.hash
    && nv.text === '仅限 000000：当天涨幅超过 3% 的票，我绝不买入。'
    && retire.schema === 'contract-v1' && !('scope' in retire) && retire.hash === s5.hash && retire.via === '替代' && retire.replaced_by_hash === sc3.hash && retire.replaced_by_v === 3, JSON.stringify(recs));
  v = [...v, ...recs];
}
{
  const rs = A.contractRuleSet(v);
  const slot = rs.slots.find((s) => s.template_id === 'no_buy_on_surge');
  check('替代后：同类型仍只有一条当前规则（v2 仅 000000），原 v1 5% 进入历史（replaced），不追回规则不受影响', rs.slots.length === 3 && slot.current.hash === sc3.hash
    && slot.current.schema === 'contract-v2' && slot.current.scope_text === '仅 000000' && rs.current.length === 2
    && ruleOf(v, s5.hash).state === 'replaced' && ruleOf(v, b3.hash).state === 'current');
}

/* ==== 3. 同范围替代不需确认；切换代码须确认 ==== */
{
  const sc4 = surge(4, sym('000000'));
  const d = A.contractEditorState(v, sc4, { targetHash: sc3.hash });
  check('同范围（仅 000000）改参数：编辑原规则', d.action === 'edit' && A.contractSaveRecords(v, { parsed: sc4, targetHash: sc3.hash }).length === 2);
  const other = surge(3, sym('888888'));
  const d2 = A.contractEditorState(v, other);
  check('新增不同代码：可与当前规则共存', d2.action === 'new' && A.contractSaveRecords(v, { parsed: other }).length === 1);
}

/* ==== 4. 情境测试：不适用 / 汇总 / 只用当前规则 ==== */
{
  const hit = await A.simulateContracts({ versions: v, symbol: '000000', date: '2024-10-10', bill: syntheticBill, marketSource: 'synthetic-fixture' });
  const na = await A.simulateContracts({ versions: v, symbol: '888888', date: '2024-10-10', bill: syntheticBill, marketSource: 'synthetic-fixture' });
  const rHit = hit.results.find((r) => r.rule.hash === sc3.hash);
  const rNa = na.results.find((r) => r.rule.hash === sc3.hash);
  check('测试：范围匹配（000000）→ 正常判定（命中 / 未命中），结果带范围与时间口径', rHit.ok && ['triggered', 'not_triggered'].includes(rHit.verdict) && rHit.rule.scope_text === '仅 000000'
    && rHit.rule.timing.includes('收盘后历史复盘') && hit.summary.not_applicable === 0, JSON.stringify(rHit).slice(0, 300));
  check('测试：范围不匹配（888888）→ 不适用（ok、不计命中 / 未命中 / 数据不足），未读取行情（无 change / match），汇总 not_applicable=1',
    rNa.ok && rNa.verdict === 'not_applicable' && rNa.code === 'I_RULE_SCOPE_NOT_APPLICABLE' && !rNa.change && !rNa.match && rNa.message.includes('仅限 000000')
    && na.summary.not_applicable === 1 && na.summary.triggered + na.summary.not_triggered + na.summary.missing_data + na.summary.error === 1, JSON.stringify(na.summary));
  check('测试：历史规则（v1 5%）不参与；rules_used 带范围文本', hit.rules_n === 2 && !hit.results.some((r) => r.rule.hash === s5.hash)
    && hit.rules_used.find((r) => r.hash === sc3.hash).scope_text === '仅 000000');
}

/* ==== 5. 恢复：单代码 → 全部股票（扩大）须确认；停用 / 无当前时恢复 ==== */
{
  const st = A.contractRestoreState(v, { hash: s5.hash });
  check('恢复预览：可恢复，将替代当前 v2 规则，范围变化须确认', st.restorable && st.current.hash === sc3.hash && st.scope_change.requires_ack);
  check('恢复未确认：不写入记录', A.contractRestoreRecords(v, { hash: s5.hash }).length === 0);
  const recs = A.contractRestoreRecords(v, { hash: s5.hash, confirmScopeChange: true });
  check('恢复已确认：v1 规则追加 v1“经恢复”记录（版本号不变）+ v2 规则追加 v2 格式“经替代”记录（保留 scope）', recs.length === 2
    && recs[0].schema === 'contract-v1' && !('scope' in recs[0]) && recs[0].via === '恢复' && recs[0].v === 1
    && recs[1].schema === 'contract-v2' && recs[1].scope.symbol === '000000' && recs[1].via === '替代' && recs[1].replaced_by_hash === s5.hash, JSON.stringify(recs));
  v = [...v, ...recs];
  check('恢复后：全部股票 5% 为当前，v2 规则进入历史（replaced，可再恢复）', ruleOf(v, s5.hash).state === 'current' && ruleOf(v, sc3.hash).state === 'replaced' && ruleOf(v, sc3.hash).restorable);
  const stop = A.contractStopRecords(v, { hash: s5.hash });
  v = [...v, ...stop];
  const st2 = A.contractRestoreState(v, { hash: sc3.hash });
  check('停用后该类型无当前规则：恢复 v2 规则无需范围确认，直接写入 v2 格式“经恢复”记录', st2.restorable && !st2.current && st2.scope_change === null
    && (() => { const r = A.contractRestoreRecords(v, { hash: sc3.hash }); v = [...v, ...r]; return r.length === 1 && r[0].schema === 'contract-v2' && r[0].via === '恢复'; })());
  check('记录只追加：所有历史记录仍在，v 不重复分配', v.filter((r) => r.hash === s5.hash).length === 4 && A.contractRuleSet(v).next_version === 4);
}

/* ==== 6. 完整性：篡改 / 格式不符 → 待重新确认，不参与判定；未知格式原样保留 ==== */
{
  const base = save([], sc3);
  const one = (mut) => { const rec = { ...base[0], ...mut }; return A.contractRuleSet([rec]); };
  const tampered = one({ fields: { threshold_pct: 9 } });
  const allInV2 = one({ scope: { kind: 'all' } });
  const noScope = (() => { const { scope, ...rest } = base[0]; return A.contractRuleSet([rest]); })();
  const numScope = one({ scope: { kind: 'symbol', symbol: 0 } });
  const wrongSym = one({ scope: sym('888888') });
  check('完整性：v2 参数被篡改 → 哈希不一致，待重新确认、不进入 executable', tampered.needsReconfirm.length === 1 && tampered.executable.length === 0
    && tampered.needsReconfirm[0].integrity.code === 'E_CONTRACT_RULE_HASH_MISMATCH');
  check('完整性：v2 代码被改成另一代码 → 哈希不一致；未知或原型属性模板不能执行且读取不崩溃', wrongSym.needsReconfirm[0]?.integrity.code === 'E_CONTRACT_RULE_HASH_MISMATCH'
    && one({ template_id: '__proto__' }).executable.length === 0 && one({ template_id: 'unknown' }).executable.length === 0);
  check('完整性：v2 记录范围为全部股票 / 缺 scope → 格式与范围不一致（不当成全部股票规则启用）', allInV2.needsReconfirm[0]?.integrity.code === 'E_CONTRACT_RULE_SCHEMA_MISMATCH'
    && noScope.needsReconfirm[0]?.integrity.code === 'E_CONTRACT_RULE_SCHEMA_MISMATCH' && allInV2.executable.length === 0 && noScope.executable.length === 0);
  check('完整性：v2 代码为数字 → 范围无效（E_RULE_SCOPE_INVALID），不判定', numScope.needsReconfirm[0]?.integrity.code === 'E_RULE_SCOPE_INVALID' && numScope.needsReconfirm[0].scope_text === '适用范围无效');
  const v1WithScope = A.contractRuleSet([{ ...v[0], scope: sym('000000') }]);
  check('完整性：v1 记录被加上 scope → 格式异常，不判定（避免回退时范围被静默放大）', v1WithScope.needsReconfirm[0]?.integrity.code === 'E_CONTRACT_RULE_SCHEMA_MISMATCH');
  const mixed = A.contractRuleSet([v[0], { ...v[0], schema: 'contract-v2', scope: sym('000000'), status: '已拒绝' }]);
  check('完整性：同一哈希下 v1 / v2 记录混杂 → 格式不一致，不判定', mixed.rules[0].integrity.code === 'E_CONTRACT_RULE_SCHEMA_MISMATCH');
  const unknown = { schema: 'contract-v9', hash: 'abc', text: '未来格式', v: 7 };
  const withUnknown = A.contractRuleSet([...v, unknown]);
  check('未知格式记录：归入 legacy 原样保留、不参与判定；版本号继续避开其 v', withUnknown.legacy.includes(unknown) && withUnknown.next_version === 8
    && !withUnknown.executable.some((r) => r.hash === 'abc'));
  for (const mut of [{ fields: { threshold_pct: 9 } }, { scope: sym('888888') }, { text: '仅限 888888：涨幅超过99%' }, { hash_algorithm: 'unexpected' }]) {
    const stopped = [...base, ...A.contractStopRecords(base, { hash: sc3.hash })];
    const last = { ...base[0], ...mut, status: '已确认', via: '恢复' };
    const rs = A.contractRuleSet([...stopped, last]);
    check(`完整性：后续启用记录被修改 ${JSON.stringify(mut)} → 待重新确认，不复活旧规则`, rs.executable.length === 0 && rs.needsReconfirm.length === 1 && !rs.rules[0].integrity.ok);
  }
  check('完整性：首条显示文本被篡改也不能判定，避免显示规则与执行规则不同', one({ text: '另一条规则' }).executable.length === 0);
  const wrongActivation = { ...A.contractSaveRecords([], { parsed: surge(4, sym('000000')) })[0], hash: sc3.hash };
  check('完整性：另一条规则的启用记录被换成已停用规则哈希，不能复活旧规则', A.contractRuleSet([...base, ...A.contractStopRecords(base, { hash: sc3.hash }), wrongActivation]).executable.length === 0);
  const sim = await A.simulateContracts({ versions: [{ ...base[0], fields: { threshold_pct: 9 } }], symbol: '000000', date: '2024-10-10', bill: null, marketSource: 'synthetic-fixture' });
  check('完整性：待重新确认的 v2 规则不参与测试，并在结果中如实回传', sim.rules_n === 0 && sim.needs_reconfirm_n === 1 && sim.empty);
}

/* ==== 7. 自然语言保存状态：范围变化须单独确认 ==== */
{
  const fake = { status: 'supported', parsed: surge(3, sym('000000')), confirmations: [] };
  const vv = save([], s5);
  const pending = A.contractNlSaveState(vv, fake, { ack: true });
  check('自然语言新增不同范围：核对后可保存并与现有规则共存', pending.canSave && pending.editor.action === 'new');
}

/* ==== 8. 等价性：范围匹配时 v2 与同参数 v1 逐项一致 ==== */
const pick = (r) => JSON.stringify({ ok: r.ok, verdict: r.verdict, code: r.code, message: r.message, fact: r.match?.fact ?? null, change: r.change ?? null, date_mapping: r.date_mapping ?? null });
async function equivalence({ label, bill, marketSource, symbols, dates }) {
  const v1 = save(save([], surge(3)), buyback(5));
  let mismatch = 0;
  let naWrong = 0;
  let mapped = 0;
  let compared = 0;
  const verdicts = new Set();
  const v1Results = new Map();
  for (const s of symbols) for (const d of dates) {
    const out = await A.simulateContracts({ versions: v1, symbol: s, date: d, bill, marketSource });
    v1Results.set(`${s}|${d}`, out.results);
  }
  for (const scoped of symbols) {
    const v2 = save(save([], surge(3, sym(scoped))), buyback(5, sym(scoped)));
    for (const s of symbols) for (const d of dates) {
      const out = await A.simulateContracts({ versions: v2, symbol: s, date: d, bill, marketSource });
      const base = v1Results.get(`${s}|${d}`);
      for (const [i, r] of out.results.entries()) {
        if (s === scoped) {
          compared += 1;
          verdicts.add(r.ok ? r.verdict : 'error');
          if (pick(r) !== pick(base[i])) { mismatch += 1; if (mismatch <= 2) console.log('mismatch', label, s, d, pick(r), pick(base[i])); }
          if (r.date_mapping) mapped += 1;
        } else if (!(r.ok && r.verdict === 'not_applicable' && !r.change && !r.match)) naWrong += 1;
      }
    }
  }
  return { mismatch, naWrong, mapped, compared, verdicts: [...verdicts] };
}
{
  const cache = JSON.parse(readFileSync(join(ROOT, 'data/market-cache.json'), 'utf8'));
  const days = cache.calendar.trading_days;
  const csv = ['日期,标的,方向,价格,数量,费用,税费',
    '2023-02-01,600519,买入,1800,100,5,0', '2023-02-06,600519,卖出,1850,100,5,1',
    '2023-06-01,300750,买入,230,100,5,0', '2023-06-05,300750,卖出,240,100,5,1',
    '2024-01-10,601318,买入,40,100,5,0', '2024-01-12,601318,卖出,41,100,5,1',
    '2024-09-20,600519,买入,1400,100,5,0', '2024-09-27,600519,卖出,1500,100,5,1'].join('\n') + '\n';
  const bill = { ...(await A.loadUserBillFromText(csv, 'equivalence.csv')), status: 'confirmed', contextId: 'eq' };
  const nonTrading = ['2023-01-01', '2023-01-07', '2024-10-01', '2024-10-05', '2025-12-28'];
  const t0 = Date.now();
  const sig = await equivalence({ label: 'signed', bill, marketSource: 'signed-cache', symbols: cache.manifest.symbols, dates: [...days, ...nonTrading] });
  check(`等价性·签收真实缓存（3 标的 × ${days.length} 个交易日 + ${nonTrading.length} 个非交易日 × 2 类规则）：范围匹配时 v2 与 v1 的结论 / 原因码 / 说明 / 事实逐项一致，范围不匹配时全部“不适用”`,
    sig.compared === 3 * (days.length + nonTrading.length) * 2 && sig.mismatch === 0 && sig.naWrong === 0 && sig.mapped === 0, `${JSON.stringify(sig)} ${Date.now() - t0}ms`);
  const fx = JSON.parse(readFileSync(join(ROOT, 'm0/market-cache/fixtures/mock-calendar.json'), 'utf8')).trading_days;
  const allDates = [];
  for (let d = new Date('2024-09-20T00:00:00Z'); d <= new Date('2024-10-14T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) allDates.push(d.toISOString().slice(0, 10));
  const syn = await equivalence({ label: 'synthetic', bill: null, marketSource: 'synthetic-fixture', symbols: ['000000', '888888', '001234'], dates: allDates });
  check(`等价性·合成行情（示例账单 A；${allDates.length} 个自然日含 ${allDates.length - fx.length} 个非交易日）：v2 与 v1 一致，含相同的 B3 日期映射`,
    syn.mismatch === 0 && syn.naWrong === 0 && syn.mapped > 0, JSON.stringify(syn));
  const one = await A.simulateContracts({ versions: save([], surge(3, sym('000000'))), symbol: '000000', date: '2024-10-05', bill: null, marketSource: 'synthetic-fixture' });
  const r = one.results[0];
  check('B3 映射说明：示例路径申报日 2024-10-05（非交易日）→ 实际使用 2024-09-30，结果写明申报日与实际交易日', r.date_mapping && r.date_mapping.requested_date === '2024-10-05'
    && r.date_mapping.effective_date === '2024-09-30' && r.date_mapping.message.includes('不是交易日'), JSON.stringify(r.date_mapping));
  const sb = await A.simulateContracts({ versions: save([], surge(3, sym('600519'))), symbol: '600519', date: '2024-10-05', bill, marketSource: 'signed-cache' });
  check('签收缓存路径非交易日：沿用 v1 口径“数据不足”（不映射、不补价）', sb.results[0].verdict === 'missing_data' && sb.results[0].code === 'E_DATE_NOT_IN_CALENDAR' && !sb.results[0].date_mapping);
}

{
  const dyn = await equivalence({ label: 'dynamic-fixture', bill: null, marketSource: 'dynamic-tushare', symbols: ['600519', '300750', '601318'],
    dates: ['2025-09-26', '2025-09-27', '2025-10-01', '2025-12-26', '2025-12-27', '2025-12-30', '2025-12-31', '2026-01-01'] });
  check('等价性·动态接口离线桩：v2/v1 同源日期行为与结论一致（含 B3 映射日、范围外日），不适用时不判定', dyn.mismatch === 0 && dyn.naWrong === 0 && dyn.mapped > 0, JSON.stringify(dyn));
  const noRead = await import('../src/demo/adapter.js?scope-no-read');
  const unreadBill = { status: 'confirmed', sourceType: 'local', get trades() { throw new Error('范围不匹配不应读取账单'); } };
  const before = fetchCalls.length;
  const na = await noRead.simulateContracts({ versions: save([], surge(3, sym('600519'))), symbol: '300750', date: '2024-10-01', bill: unreadBill });
  check('所有规则均不适用：签收缓存不加载，交易记录不读取，直接返回不适用（不是数据不足）', fetchCalls.length === before && na.results[0].verdict === 'not_applicable'
    && na.summary.not_applicable === 1 && na.results[0].tradesSource === null);
  const bill = { ...(await A.loadUserBillFromText('日期,标的,方向,价格,数量,费用,税费\n2024-09-25,600519,买入,100,100,5,0\n', 'scope-data.csv')), status: 'confirmed' };
  const out = await A.simulateContracts({ versions: save([], surge(3, sym('000001'))), symbol: '000001', date: '2024-10-10', bill });
  check('规则适用但代码不在签收缓存：显示数据不足并保留原始原因码（不是不适用、也不假装有行情）', out.results[0].code === 'E_MARKET_OUT_OF_SUPPORT'
    && out.results[0].display_verdict === 'missing_data' && out.summary.missing_data === 1 && out.summary.not_applicable === 0);
  mutateDynamic = (doc) => { doc.symbols['600519'].bars = doc.symbols['600519'].bars.filter((b) => b.date !== '2025-12-26'); };
  try {
    const fresh = await import('../src/demo/adapter.js?b4-missing-price');
    const versions = save([], surge(3, sym('600519')));
    for (const date of ['2025-12-26', '2025-12-27']) {
      const out = await fresh.simulateContracts({ versions, symbol: '600519', date, bill: null, marketSource: 'dynamic-tushare' });
      const r = out.results[0];
      check(`B4·交易日缺价（申报日 ${date}）：数据不足且无价格，不改用 2025-12-25 的可用价格`, r.verdict === 'missing_data' && r.code === 'E_CHANGE_PCT_MISSING' && !r.match.fact.change_pct
        && r.change.message.includes('2025-12-26') && r.display_verdict === 'missing_data', JSON.stringify(r.change));
      if (date === '2025-12-27') check('B3+B4：非交易日映射为缺价交易日时，仍显示映射日但不宣称使用了缺失的收盘价格', r.date_mapping?.effective_date === '2025-12-26'
        && r.date_mapping.has_price === false && r.date_mapping.message.includes('不改用其他日期的价格'), JSON.stringify(r));
    }
  } finally { mutateDynamic = null; }
}

/* ==== 9. 回退（可选）：旧版 adapter 读取含 v2 的数据 ==== */
if (process.env.ROLLBACK_ADAPTER) {
  const OLD = await import(pathToFileURL(process.env.ROLLBACK_ADAPTER).href);
  let data = save(save([], s5), b3);
  data = [...data, ...A.contractSaveRecords(data, { parsed: sc3, confirmScopeChange: true })];
  const snapshot = JSON.stringify(data);
  let old;
  try { old = OLD.contractRuleSet(JSON.parse(snapshot)); } catch (e) { old = { error: String(e) }; }
  const v2Recs = data.filter((r) => r.schema === 'contract-v2');
  check('回退·读取：旧版不崩溃；v2 记录归入旧演示记录（legacy）原样保留、不参与判定', !old.error && old.legacy.length === v2Recs.length
    && old.legacy.every((r) => r.schema === 'contract-v2') && !old.executable.some((r) => r.hash === sc3.hash), JSON.stringify(old.error ?? old.legacy));
  check('回退·读取：旧版里涨幅类型没有当前规则（v1 5% 已被用户替代，不会复活），不追回规则照常；版本号避开 v2 记录', !old.slots.find((s) => s.template_id === 'no_buy_on_surge').current
    && old.slots.find((s) => s.template_id === 'no_buy_back_within').current.hash === b3.hash && old.next_version === 4 && old.rules.find((r) => r.hash === s5.hash).state === 'replaced');
  let sim;
  try { sim = await OLD.simulateContracts({ versions: JSON.parse(snapshot), symbol: '000000', date: '2024-10-10', bill: null, marketSource: 'synthetic-fixture' }); } catch (e) { sim = { error: String(e) }; }
  check('回退·情境测试：旧版可运行，只判定不追回规则', !sim.error && sim.rules_n === 1 && sim.results[0].rule.hash === b3.hash, JSON.stringify(sim.error ?? sim.rules_used));
  const s4 = OLD.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '4' } });
  const oldRecs = OLD.contractSaveRecords(JSON.parse(snapshot), { parsed: s4, note: null });
  const after = [...JSON.parse(snapshot), ...oldRecs];
  check('回退·写入：旧版新增 v1 规则使用 v4（不与 v2 记录冲突），原有 v2 记录未被改写或删除', oldRecs[0].v === 4 && oldRecs[0].schema === 'contract-v1'
    && JSON.stringify(after.slice(0, data.length)) === snapshot, JSON.stringify(oldRecs));
  const back = A.contractRuleSet(after);
  check('回退后再升级：新版按记录顺序推导——旧版写入的 4% 为当前，v2 规则显示为已被较新规则替代、不参与判定；无记录丢失', back.slots.find((s) => s.template_id === 'no_buy_on_surge').current.hash === s4.hash
    && ruleOf(after, sc3.hash).state === 'superseded' && !back.executable.some((r) => r.hash === sc3.hash) && back.legacy.length === 0 && back.needsReconfirm.length === 0);
  const v1only = save(save([], s5), b3);
  const oldSet = OLD.contractRuleSet(v1only);
  const newSet = A.contractRuleSet(v1only);
  const sameKeys = oldSet.rules.every((o) => {
    const n = newSet.rules.find((x) => x.hash === o.hash);
    return n && Object.keys(o).every((k) => k === 'parsed' && o.parsed
      ? Object.keys(o.parsed).every((p) => JSON.stringify(o.parsed[p]) === JSON.stringify(n.parsed[p]))
      : JSON.stringify(o[k]) === JSON.stringify(n[k]));
  });
  check('仅 v1 数据：新版规则集在旧版已有字段上与旧版逐字段一致（只新增 schema / scope / scope_text / timing）', sameKeys && oldSet.next_version === newSet.next_version
    && JSON.stringify(oldSet.current.map((r) => r.hash)) === JSON.stringify(newSet.current.map((r) => r.hash)));
  const oldSave = stripAt(OLD.contractSaveRecords(v1only, { parsed: OLD.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '6' } }), note: 'x' }));
  const newSave = stripAt(A.contractSaveRecords(v1only, { parsed: surge(6), note: 'x' }));
  check('仅 v1 数据：新版写出的 v1 记录与旧版逐字节一致（除时间戳）', JSON.stringify(oldSave) === JSON.stringify(newSave), JSON.stringify([oldSave, newSave]));
  const oldSim = await OLD.simulateContracts({ versions: v1only, symbol: '000000', date: '2024-10-05', bill: null, marketSource: 'synthetic-fixture' });
  const newSim = await A.simulateContracts({ versions: v1only, symbol: '000000', date: '2024-10-05', bill: null, marketSource: 'synthetic-fixture' });
  check('仅 v1 数据：情境测试结论 / 原因码 / 说明与旧版一致（含 B3 映射日）', JSON.stringify(oldSim.results.map((r) => [r.verdict, r.code, r.message]))
    === JSON.stringify(newSim.results.map((r) => [r.verdict, r.code, r.message])));
} else {
  console.log('SKIP  回退测试：未设置 ROLLBACK_ADAPTER（需指向改动前的 adapter.js 副本）');
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
