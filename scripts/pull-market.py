#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
M0-C2 · akshare 行情拉数（离线预拉缓存草案 + 拉数成功证据）

定位：离线数据准备（非产品运行时）。按 PRD:156,162 预拉目标 3 只 A 股 2023–2025 日线
      （不复权 + 前复权快照）与 A 股交易日历，输出缓存草案与可签收的运行记录。
边界：仅公开行情数据；不采集任何账户/成交数据；不读不写凭证；
      本脚本不改变产品口径（口径依据 m0/market-cache/schema.candidate.json B1–B7）。
运行：python scripts/pull-market.py
输出：
  data/market-cache.json              缓存草案（manifest + snapshot + calendar + symbols）
  data/market-cache.pull-record.json  拉数运行记录（成功证据：行数/起止/缺失日/前复权锚点核验观测）
停止条件（任务计划 P0-1）：akshare 安装失败或接口变更 → 记录失败原因并退出，不重试、不换源。
"""
import json
import sys
import traceback
import warnings
from datetime import datetime
from pathlib import Path

warnings.filterwarnings("ignore", category=FutureWarning)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO = Path(__file__).resolve().parent.parent
OUT_CACHE = REPO / "data" / "market-cache.json"
OUT_RECORD = REPO / "data" / "market-cache.pull-record.json"

SYMBOLS = ["600519", "300750", "601318"]  # 【建议】待负责人签收
SYMBOL_NAMES = {"600519": "贵州茅台", "300750": "宁德时代", "601318": "中国平安"}
RANGE_START, RANGE_END = "2023-01-01", "2025-12-31"
RECENT_START = "2026-01-01"  # 前复权锚点核验窗口（覆盖 2026 年度分红除权，以观测 qfq 收敛日）
EPS = 1e-9


def ymd(d):
    return d.strftime("%Y-%m-%d")


def fetch_hist(ak, symbol, adjust, start, end):
    df = ak.stock_zh_a_hist(symbol=symbol, period="daily",
                            start_date=start.replace("-", ""), end_date=end.replace("-", ""),
                            adjust=adjust)
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "date": ymd(r["日期"]),
            "open": float(r["开盘"]),
            "high": float(r["最高"]),
            "low": float(r["最低"]),
            "close": float(r["收盘"]),
            "volume": int(r["成交量"]) * 100,  # akshare 成交量单位为手 → 股
        })
    rows.sort(key=lambda x: x["date"])
    return rows


def ohlc_ok(b):
    return (b["high"] + EPS >= max(b["open"], b["close"])) and (b["low"] - EPS <= min(b["open"], b["close"]))


def eqv(a, b):
    return abs(a - b) < 1e-9


def main():
    import akshare as ak
    import pandas as pd

    fails = []

    def hard(cond, msg):
        if not cond:
            fails.append(msg)
            print(f"FAIL  {msg}")

    now = datetime.now().astimezone()
    fetch_time = now.isoformat(timespec="seconds")
    snapshot_id = f"pull-{now:%Y%m%d-%H%M%S}"
    today = ymd(now.date())

    # ---- 交易日历 ----
    cal_df = ak.tool_trade_date_hist_sina()
    days_all = [ymd(d) for d in cal_df["trade_date"]]
    cal_days = [d for d in days_all if RANGE_START <= d <= RANGE_END]
    hard(len(cal_days) > 600, f"交易日历区间行数异常：{len(cal_days)}")
    hard(cal_days == sorted(set(cal_days)), "交易日历非严格升序或含重复")
    hard(all(RANGE_START <= d <= RANGE_END for d in cal_days), "交易日历存在区间外日期")
    cal_set = set(cal_days)

    requests = []
    symbols_out = {}
    per_symbol = {}
    recent_obs = {}

    for sym in SYMBOLS:
        bars = fetch_hist(ak, sym, "", RANGE_START, RANGE_END)
        fwd = fetch_hist(ak, sym, "qfq", RANGE_START, RANGE_END)
        requests.append({"symbol": sym, "adjust": "none", "start": RANGE_START, "end": RANGE_END,
                         "rows": len(bars), "first": bars[0]["date"] if bars else None,
                         "last": bars[-1]["date"] if bars else None})
        requests.append({"symbol": sym, "adjust": "qfq", "start": RANGE_START, "end": RANGE_END,
                         "rows": len(fwd), "first": fwd[0]["date"] if fwd else None,
                         "last": fwd[-1]["date"] if fwd else None})

        hard(len(bars) > 0 and len(fwd) > 0, f"{sym} 拉取为空")
        d1 = [b["date"] for b in bars]
        d2 = [b["date"] for b in fwd]
        hard(d1 == sorted(set(d1)) and d2 == sorted(set(d2)), f"{sym} 行未升序或含重复日期")
        hard(all(RANGE_START <= d <= RANGE_END for d in d1), f"{sym} 存在区间外日期")
        hard(d1 == d2, f"{sym} 不复权/前复权日期集合不一致")
        hard(all(d in cal_set for d in d1), f"{sym} 存在日历外交易日期")
        bad_ohlc = [b["date"] for b in bars + fwd if not ohlc_ok(b)]
        hard(not bad_ohlc, f"{sym} OHLC 完整性失败（high≥max(o,c), low≤min(o,c)）：{bad_ohlc[:5]}")

        missing = [d for d in cal_days if d not in set(d1)]
        diff_days = [a["date"] for a, b in zip(bars, fwd) if not eqv(a["close"], b["close"])]
        end_equal = bool(bars and fwd and eqv(bars[-1]["close"], fwd[-1]["close"]))

        # 送转量级复权跳变扫描：qfq/不复权 比值日环比 ≥ 0.05（现金分红步长通常 <0.03，不触发）
        ratio = [f["close"] / b["close"] for b, f in zip(bars, fwd)]
        jumps = []
        for i in range(1, len(ratio)):
            if abs(ratio[i] - ratio[i - 1]) >= 0.05:
                jumps.append({"date": d1[i], "ratio_before": round(ratio[i - 1], 4),
                              "ratio_after": round(ratio[i], 4),
                              "ratio_factor": round(ratio[i] / ratio[i - 1], 4)})

        # 前复权锚点核验：拉取近期窗口，观察 qfq 与不复权的收敛（一致）日
        r_un = fetch_hist(ak, sym, "", RECENT_START, today)
        r_fw = fetch_hist(ak, sym, "qfq", RECENT_START, today)
        requests.append({"symbol": sym, "adjust": "none", "start": RECENT_START, "end": today,
                         "rows": len(r_un), "first": r_un[0]["date"] if r_un else None,
                         "last": r_un[-1]["date"] if r_un else None})
        requests.append({"symbol": sym, "adjust": "qfq", "start": RECENT_START, "end": today,
                         "rows": len(r_fw), "first": r_fw[0]["date"] if r_fw else None,
                         "last": r_fw[-1]["date"] if r_fw else None})
        rd1 = [b["date"] for b in r_un]
        rd2 = [b["date"] for b in r_fw]
        hard(rd1 == sorted(set(rd1)) and rd1 == rd2, f"{sym} 近期窗口两序列日期不一致或未升序")
        r_diff = [a["date"] for a, b in zip(r_un, r_fw) if not eqv(a["close"], b["close"])]
        r_equal = [a["date"] for a, b in zip(r_un, r_fw) if eqv(a["close"], b["close"])]
        first_equal = r_equal[0] if r_equal else None
        last_diff = r_diff[-1] if r_diff else None
        recent_obs[sym] = {
            "start": RECENT_START, "end": today, "rows": len(r_un),
            "first": rd1[0] if rd1 else None, "last": rd1[-1] if rd1 else None,
            "diff_days": len(r_diff),
            "last_diff_date": last_diff,
            "first_equal_date": first_equal,
            "diff_prefix_contiguous": (last_diff is None) or (first_equal is None) or (last_diff < first_equal),
            "last_equal_date": r_equal[-1] if r_equal else None,
            "last_date_equal": bool(r_un and r_fw and eqv(r_un[-1]["close"], r_fw[-1]["close"])),
        }

        per_symbol[sym] = {
            "bars_rows": len(bars), "fwdadj_rows": len(fwd),
            "first": d1[0] if d1 else None, "last": d1[-1] if d1 else None,
            "missing_vs_calendar": {"count": len(missing), "dates": missing[:40],
                                    "truncated": len(missing) > 40},
            "ohlc_ok": not bad_ohlc,
            "qfq_obs": {
                "full_range_diff_days": len(diff_days),
                "full_range_first_diff": diff_days[0] if diff_days else None,
                "full_range_end_equal": end_equal,
                "ratio_jumps_large": jumps,
                "recent": recent_obs[sym],
            },
        }
        symbols_out[sym] = {"bars": bars, "bars_fwdadj": fwd}

    # ---- 前复权基准（adjustment_basis）观测推导（事实措辞，详细观测见 pull-record） ----
    full_diff_desc = "、".join(
        f"{s}({SYMBOL_NAMES[s]})={per_symbol[s]['qfq_obs']['full_range_diff_days']}/{len(cal_days)}"
        for s in SYMBOLS)
    clean = (all(recent_obs[s]["diff_days"] > 0 for s in SYMBOLS)
             and all(recent_obs[s]["diff_prefix_contiguous"] for s in SYMBOLS)
             and all(recent_obs[s]["first_equal_date"] for s in SYMBOLS))
    if clean:
        starts_desc = "、".join(f"{s}→{recent_obs[s]['first_equal_date']}" for s in SYMBOLS)
        obs2 = f"近窗差异形态为“各标的最后一次除权除息之前不同、其后与不复权逐日一致”（一致段起点：{starts_desc}）"
    else:
        obs2 = "近窗差异形态未满足预期（存在无差异或非连续观测，需人工复核）"
    jump_syms = [s for s in SYMBOLS if per_symbol[s]["qfq_obs"]["ratio_jumps_large"]]
    if jump_syms:
        jdesc = "；".join(
            f"{s}({SYMBOL_NAMES[s]})：" + "、".join(
                f"{j['date']}（比值 {j['ratio_before']}→{j['ratio_after']}，≈×{j['ratio_factor']}）"
                for j in per_symbol[s]["qfq_obs"]["ratio_jumps_large"])
            for s in jump_syms)
        obs3 = (f"③ 送转量级复权跳变：{jdesc}——远超现金分红步长可解释范围，疑似送转类股数事件，"
                f"事件性质与识别依据属 M3 未决项；持有区间跨越该事件将命中 B5 处置口径")
    else:
        obs3 = "③ 未观察到送转量级复权跳变（区间内 ≥0.05 日环比）"
    basis = (f"前复权序列为抓取时点口径（qfq）快照；观测："
             f"① 2023–2025 区间两序列差异日数：{full_diff_desc}；"
             f"② {obs2}；"
             f"{obs3}。"
             f"前复权值随抓取时点变化，早期展示须标注快照口径（B6）；详见 data/market-cache.pull-record.json")

    akshare_ver = getattr(ak, "__version__", "unknown")
    record = {
        "artifact": "market-cache-pull-record",
        "note": "拉数运行记录（成功证据）：由 scripts/pull-market.py 生成；供 M0-C2 签收与 M1-C1 引用。数据为公开行情，不含账户数据。",
        "fetch_time": fetch_time,
        "snapshot_id": snapshot_id,
        "command": "python scripts/pull-market.py",
        "environment": {"python": sys.version.split()[0], "akshare": akshare_ver, "pandas": pd.__version__},
        "params": {"symbols": SYMBOLS, "symbol_names": SYMBOL_NAMES,
                   "date_range": {"start": RANGE_START, "end": RANGE_END},
                   "recent_window": [RECENT_START, today],
                   "volume_unit_conversion": "成交量为股（akshare 原始为手，×100）",
                   "recent_window_note": "近窗末行可能为抓取时点当日盘中行情（未收盘数据）；仅用于前复权基准核验，不进入 2023–2025 缓存",
                   "jump_scan_threshold": "|qfq/不复权 比值日环比| ≥ 0.05（送转量级；现金分红步长通常 <0.03 不触发）"},
        "requests": requests,
        "calendar": {"source": "akshare tool_trade_date_hist_sina",
                     "rows_total": len(days_all), "rows_in_range": len(cal_days),
                     "first": cal_days[0] if cal_days else None,
                     "last": cal_days[-1] if cal_days else None},
        "per_symbol": per_symbol,
        "adjustment_basis_obs": basis,
        "hard_checks": {"passed": not fails, "failures": fails},
        "verdict": "PASS" if not fails else "FAIL",
    }

    OUT_RECORD.parent.mkdir(parents=True, exist_ok=True)
    with OUT_RECORD.open("w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    if not fails:
        cache = {
            "artifact": "market-cache-pull-draft",
            "frozen": False,
            "status": "草案：待负责人签收（M0-C2，尹辰 2026-10-13 提出）",
            "note": "真实公开行情（akshare 预拉，2023–2025，不复权 + 前复权快照）；不含账户数据；清单签收前产品不得声称真实支持范围（R2）。",
            "manifest": {
                "symbols": SYMBOLS,
                "symbol_names": SYMBOL_NAMES,
                "date_range": {"start": RANGE_START, "end": RANGE_END},
                "data_source": f"akshare {akshare_ver} · stock_zh_a_hist（东方财富行情口径）",
                "calendar_source": f"akshare {akshare_ver} · tool_trade_date_hist_sina（新浪交易日历口径）",
                "adjustment_basis": basis,
                "pull_evidence": "data/market-cache.pull-record.json（脚本 scripts/pull-market.py）",
                "asOfDate": RANGE_END,
                "status_note": "symbols 与 asOfDate 为提出方【建议】，待 changer 签收后生效",
            },
            "snapshot": {
                "snapshot_id": snapshot_id,
                "fetch_time": fetch_time,
                "range": {"start": RANGE_START, "end": RANGE_END},
                "adjustment_basis": basis,
                "adjustment_basis_note": "核验观测见 pull-record；抓取时间与缓存结束日期不作为复权基准（B6）",
            },
            "calendar": {"market": "CN-A（沪/深；来源口径见 manifest.calendar_source）",
                         "trading_days": cal_days},
            "symbols": symbols_out,
        }
        with OUT_CACHE.open("w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, separators=(",", ":"))

    # ---- 输出摘要 ----
    print(f"fetch_time = {fetch_time}  snapshot_id = {snapshot_id}")
    print(f"交易日历 2023–2025：{len(cal_days)} 日（{cal_days[0]}..{cal_days[-1]}）")
    for sym in SYMBOLS:
        p = per_symbol[sym]
        print(f"{sym} {SYMBOL_NAMES[sym]}  不复权 {p['bars_rows']} 行 {p['first']}..{p['last']} | "
              f"前复权 {p['fwdadj_rows']} 行 | 日历内缺失 {p['missing_vs_calendar']['count']} 日 | "
              f"区间内两序列差异 {p['qfq_obs']['full_range_diff_days']} 日 | "
              f"近期窗口差异 {p['qfq_obs']['recent']['diff_days']} 日，一致段起点 {p['qfq_obs']['recent']['first_equal_date']} | "
              f"送转级跳变 {len(p['qfq_obs']['ratio_jumps_large'])} 处")
    print(f"adjustment_basis 观测：{basis}")
    print(f"\n== 硬校验 {len(fails)} 项失败 ==\n已写出：{OUT_RECORD.name}" + (f" / {OUT_CACHE.name}" if not fails else "（缓存未写出）"))
    return 1 if fails else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        print("\n[STOP] 拉数失败（触发停止条件：不重试、不换源）——请将上述失败原因报负责人定夺。", file=sys.stderr)
        sys.exit(1)
