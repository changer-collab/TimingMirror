// F-2 展示格式 —— 确定性展示层（候选；与 m0 两个校验脚本、src/ui/views/reportView.js 现行实现一致）。
// 口径：内部计算全精度，仅展示层舍入；收益率/pp 1 位小数、金额 2 位小数＋千分位；
//       LLM 只可原样引用 display 字符串，不得重算或改写数字（F-2）。
// 说明：UI 侧可后续改为引用本模块（同一实现单一来源），切换由 UI 负责人决定，本卡不改 UI。

export const fmtMoney = (v) => '¥' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
export const fmtPP = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;
