// M1-C2 CSV 导入与校验（格式纯函数）—— 对齐 m0/csv-input/schema.candidate.json v3（candidate-3，frozen:false）。
// 边界：纯函数、零依赖、本地解析不上传（R5）；UI 接入由吴涵晶负责（Papa Parse 原始行 → normalizeRows）。
// 口径：O1 错误汇总+整批阻断（不首错即停、无部分结果）；O2 UTF-8(BOM)/LF/CRLF/逗号/中文表头；
//       Q4 超精度报错、不自动舍入；Q5 未知列忽略+警告（含列名）；Q6 费用/税费整列缺失→全 0+逐条标记+全局警告；
//       Q7 交易按原始文件顺序保存（计算排序由引擎 sortTrades 负责，不改写 trade_id/source）；
//       Q8 标的仅 6 位数字、按字符串保留前导零；O3 逐标的累计超卖 E_QTY_EXCEEDS。
// 较 m0 离线校验脚本补齐：E_EMPTY（空文件/仅表头；schema v3 whole_file_policies 已列，m0 脚本未实现）。

const EXPECTED_HEADER = ['日期', '标的', '方向', '价格', '数量', '费用', '税费'];
const REQUIRED_COLUMNS = ['日期', '标的', '方向', '价格', '数量'];
const KNOWN_COLUMNS = new Set(EXPECTED_HEADER);

export const CSV_HEADER = Object.freeze([...EXPECTED_HEADER]);

const isNumeric = (s) => /^-?\d+(\.\d+)?$/.test(s);
const overPrecision = (s) => /\.\d{3,}$/.test(s);

const emptyResult = (sourceFile) => ({
  schema_version: 'candidate-3',
  source_file: sourceFile,
  blocked: true,
  trades: [],
  warnings: [],
  errors: [{ line: 1, code: 'E_EMPTY', message: '空文件或仅表头（无数据行）' }],
});

/** 文本 → {header, rows[{line, cells}]}；BOM 剥离、LF/CRLF、整行空白跳过（O2） */
export function parseCsvText(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { header: [], rows: [] };
  return {
    header: lines[0].split(',').map((s) => s.trim()),
    rows: lines.slice(1).map((raw, i) => ({ line: i + 2, cells: raw.split(',').map((s) => s.trim()) })),
  };
}

/** 解析结果 → 标准化交易 + warnings + errors + blocked（O1 整批阻断；blocked 时 trades 为空）
 *  options.skipQuantityCheck 仅供逐行草稿校验使用；最终账单仍走默认的整表数量校验。 */
export function normalizeRows({ header, rows }, sourceFile = '', { skipQuantityCheck = false } = {}) {
  const warnings = []; const errors = [];
  if (!Array.isArray(header) || !Array.isArray(rows) || header.length === 0 || rows.length === 0) {
    return emptyResult(sourceFile);
  }
  const idx = {};
  header.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });

  const missingRequired = REQUIRED_COLUMNS.filter((h) => !(h in idx));
  if (missingRequired.length) {
    errors.push({ line: 1, code: 'E_HEADER_MISSING', message: `缺少必需列：${missingRequired.join('、')}` });
    return { schema_version: 'candidate-3', source_file: sourceFile, blocked: true, trades: [], warnings, errors };
  }
  const feeColAbsent = !('费用' in idx);
  const taxColAbsent = !('税费' in idx);
  if (feeColAbsent) warnings.push({ line: 1, column: '费用', code: 'W_FEE_COLUMN_MISSING', message: '费用列缺失：全部记录按 0 计（产品层需标注，F-4；Q6）' });
  if (taxColAbsent) warnings.push({ line: 1, column: '税费', code: 'W_TAX_COLUMN_MISSING', message: '税费列缺失：全部记录按 0 计（产品层需标注，F-4；Q6）' });
  header.forEach((h) => {
    if (!KNOWN_COLUMNS.has(h)) warnings.push({ line: 1, column: h, code: 'W_UNKNOWN_COLUMN', message: `未知列已忽略：${h}（Q5）` });
  });

  const validTrades = [];
  rows.forEach(({ line, cells }, rowIdx) => {
    const get = (h) => (h in idx ? (cells[idx[h]] ?? '') : '');
    const d = get('日期'); const s = get('标的'); const sideRaw = get('方向');
    const pRaw = get('价格'); const qRaw = get('数量');
    const feeRaw = feeColAbsent ? '' : get('费用');
    const taxRaw = taxColAbsent ? '' : get('税费');
    const errs = [];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errs.push(['E_DATE_FORMAT', `日期：${d}`]);
    if (!/^\d{6}$/.test(s)) errs.push(['E_SYMBOL_FORMAT', `标的（须 6 位数字代码）：${s}`]);
    const side = sideRaw === '买入' ? 'buy' : sideRaw === '卖出' ? 'sell' : null;
    if (!side) errs.push(['E_SIDE_VALUE', `方向：${sideRaw}`]);
    if (!isNumeric(pRaw) || Number(pRaw) <= 0) errs.push(['E_PRICE_VALUE', `价格：${pRaw}`]);
    else if (overPrecision(pRaw)) errs.push(['E_PRICE_PRECISION', `价格超 2 位小数（不自动舍入，需修正后重新导入）：${pRaw}`]);
    if (!/^\d+$/.test(qRaw) || Number(qRaw) <= 0) errs.push(['E_QTY_INTEGER', `数量：${qRaw}`]);
    for (const [field, raw] of [['费用', feeRaw], ['税费', taxRaw]]) {
      if (raw === '') continue;
      if (!isNumeric(raw) || Number(raw) < 0) errs.push(['E_MONEY_VALUE', `${field}：${raw}`]);
      else if (overPrecision(raw)) errs.push(['E_MONEY_PRECISION', `${field}超 2 位小数（不自动舍入，需修正后重新导入）：${raw}`]);
    }

    if (errs.length) { errs.forEach(([code, message]) => errors.push({ line, code, message })); return; }

    const feeMissing = feeColAbsent || feeRaw === '';
    const taxMissing = taxColAbsent || taxRaw === '';
    if (!feeColAbsent && feeRaw === '') warnings.push({ line, code: 'W_FEE_MISSING_AS_ZERO', message: '费用缺失，按 0 计（产品层需标注，F-4）' });
    if (!taxColAbsent && taxRaw === '') warnings.push({ line, code: 'W_TAX_MISSING_AS_ZERO', message: '税费缺失，按 0 计（产品层需标注，F-4）' });

    validTrades.push({
      trade_id: `T${String(rowIdx + 1).padStart(3, '0')}`,
      trade_date: d, symbol: s, side,
      price: Number(pRaw), quantity: Number(qRaw),
      fee: feeMissing ? 0 : Number(feeRaw),
      tax: taxMissing ? 0 : Number(taxRaw),
      fee_missing: feeMissing, tax_missing: taxMissing,
      source: { file: sourceFile, line },
    });
  });

  if (!skipQuantityCheck) {
    quantityCheck(validTrades).forEach((e) => errors.push(e)); // O3：与格式错误汇总（O1 不首错即停）
  }
  const blocked = errors.length > 0;
  return { schema_version: 'candidate-3', source_file: sourceFile, blocked, trades: blocked ? [] : validTrades, warnings, errors }; // O1：整批阻断，无部分结果
}

/* O3：按日期升序、同日原始行号稳定排序后，逐标的累计校验（跨标的隔离；允许期末持仓） */
function quantityCheck(trades) {
  const errs = [];
  const sorted = [...trades].sort((a, b) =>
    a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.source.line - b.source.line);
  const acc = {};
  for (const t of sorted) {
    const a = (acc[t.symbol] ??= { buy: 0, sell: 0 });
    if (t.side === 'buy') a.buy += t.quantity; else a.sell += t.quantity;
    if (a.sell > a.buy) errs.push({ line: t.source.line, code: 'E_QTY_EXCEEDS', message: `任一时点累计卖出超过累计买入（标的 ${t.symbol}；v1 不支持缺少期初持仓的截断账单）` });
  }
  return errs;
}
