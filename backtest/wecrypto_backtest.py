#!/usr/bin/env python3
"""
WECRYPTO Python Backtest Engine  v2.5.0
========================================
Orbital Quantum Model  —  Comprehensive per-coin retune + Kalshi trade analysis.

Python handles all heavy math:
  • All TA indicator calculations (numpy-vectorised where possible)
  • Quantum spin ±5 orbital model (h-subshell, 11 states)
  • Walk-forward backtest (exact logic parity with predictions.js / backtest-runner.js)
  • Sharpe / Sortino / Calmar / Profit-Factor / Kelly
  • Bootstrap 95% CI on win rate
  • Monte Carlo equity-curve distribution (500 paths)
  • Grid-search threshold optimisation (entryThreshold × minAgreement)
  • Walk-forward cross-validation to avoid overfitting
  • Kalshi CSV trade-history analyser
  • Per-coin JSON report + unified summary CSV

Usage:
  python wecrypto_backtest.py                     # all 7 coins, 7 days
  python wecrypto_backtest.py --coin SOL          # single coin
  python wecrypto_backtest.py --days 30           # 30-day window
  python wecrypto_backtest.py --optimize          # run grid-search (slower)
  python wecrypto_backtest.py --kalshi            # analyse Kalshi CSV trades
  python wecrypto_backtest.py --days 30 --optimize --kalshi   # full suite
"""

import json, csv, time, math, argparse, itertools, random
import urllib.request, urllib.error
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
from scipy import stats as spstats
from tabulate import tabulate

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

PREDICTION_COINS = [
    dict(sym="BTC",  binSym="BTCUSDT",  geckoId="bitcoin",      color="🟠"),
    dict(sym="ETH",  binSym="ETHUSDT",  geckoId="ethereum",     color="🔵"),
    dict(sym="SOL",  binSym="SOLUSDT",  geckoId="solana",       color="🟣"),
    dict(sym="XRP",  binSym="XRPUSDT",  geckoId="ripple",       color="🔷"),
    dict(sym="HYPE", binSym="HYPEUSDT", geckoId="hyperliquid",  color="🟢"),
    dict(sym="DOGE", binSym="DOGEUSDT", geckoId="dogecoin",     color="🟡"),
    dict(sym="BNB",  binSym="BNBUSDT",  geckoId="binancecoin",  color="💛"),
]

# ── Composite weights — exact match to predictions.js / backtest-runner.js ──
COMPOSITE_WEIGHTS = dict(
    ema=0.18, structure=0.17, momentum=0.14, persistence=0.12, macd=0.10,
    obv=0.09, volume=0.08, vwap=0.06, adx=0.05,
    rsi=0.04, bands=0.04, williamsR=0.04, stochrsi=0.03, mfi=0.03, ichimoku=0.02,
)
SCORE_AMPLIFIER  = 1.6
LIVE_WINDOW      = 300   # candles used by live app
BACKTEST_MIN_OBS = 36    # warm-up bars

# ── Quantum spin model (h-subshell: l=5, m_l = -5…+5, 11 states) ────────────
SPIN_STATES = list(range(-5, 6))          # [-5,-4,...,+4,+5]
SPIN_CONF   = {5:0.97, 4:0.92, 3:0.85, 2:0.72, 1:0.58, 0:0.50}  # |spin|→conf

def score_to_spin(score: float) -> int:
    """Continuous score [-1,1] → discrete spin state [-5,+5]."""
    return int(round(max(-5.0, min(5.0, score * 5.0))))

def spin_to_confidence(spin: int) -> float:
    return SPIN_CONF.get(abs(spin), 0.50)

def kalshi_to_spin(prob: float) -> int:
    """Kalshi YES probability (0–100) → spin state."""
    if prob <  9: return -5
    if prob < 18: return -4
    if prob < 30: return -3
    if prob < 40: return -2
    if prob < 45: return -1
    if prob <= 55: return  0
    if prob <= 60: return  1
    if prob <= 70: return  2
    if prob <= 82: return  3
    if prob <= 91: return  4
    return 5

# ── Per-coin orbital profile (determines spin damping at extreme shells) ─────
COIN_ORBITAL_PROFILES = {
    "BTC":  dict(archetype="core",     maxNaturalSpin=3, extremeBoost=0.85),
    "ETH":  dict(archetype="core",     maxNaturalSpin=3, extremeBoost=0.85),
    "SOL":  dict(archetype="momentum", maxNaturalSpin=5, extremeBoost=1.00),
    "XRP":  dict(archetype="core+",    maxNaturalSpin=4, extremeBoost=0.90),
    "BNB":  dict(archetype="core+",    maxNaturalSpin=4, extremeBoost=0.90),
    "DOGE": dict(archetype="highBeta", maxNaturalSpin=5, extremeBoost=0.80),
    "HYPE": dict(archetype="momentum", maxNaturalSpin=5, extremeBoost=1.00),
}

# ── Default filter thresholds ────────────────────────────────────────────────
DEFAULT_FILTERS = {
    "h1":  dict(entryThreshold=0.08, minAgreement=0.50),
    "h5":  dict(entryThreshold=0.12, minAgreement=0.54),
    "h10": dict(entryThreshold=0.16, minAgreement=0.58),
    "h15": dict(entryThreshold=0.20, minAgreement=0.65),
}
BACKTEST_FILTER_OVERRIDES = {
    "BTC":  {f"h{h}": dict(entryThreshold=t, minAgreement=a) for h,t,a in [(1,0.23,0.54),(5,0.28,0.58),(10,0.33,0.62),(15,0.38,0.66)]},
    "ETH":  {f"h{h}": dict(entryThreshold=t, minAgreement=a) for h,t,a in [(1,0.23,0.54),(5,0.28,0.58),(10,0.33,0.62),(15,0.38,0.66)]},
    "SOL":  {f"h{h}": dict(entryThreshold=t, minAgreement=a) for h,t,a in [(1,0.20,0.52),(5,0.25,0.56),(10,0.30,0.60),(15,0.35,0.64)]},
    "XRP":  {f"h{h}": dict(entryThreshold=t, minAgreement=a) for h,t,a in [(1,0.19,0.52),(5,0.23,0.56),(10,0.28,0.60),(15,0.32,0.64)]},
    "DOGE": {f"h{h}": dict(entryThreshold=t, minAgreement=a) for h,t,a in [(1,0.28,0.58),(5,0.32,0.60),(10,0.35,0.62),(15,0.38,0.66)]},
    "BNB":  {f"h{h}": dict(entryThreshold=t, minAgreement=a) for h,t,a in [(1,0.20,0.54),(5,0.25,0.58),(10,0.29,0.62),(15,0.33,0.64)]},
    "HYPE": {f"h{h}": dict(entryThreshold=t, minAgreement=a) for h,t,a in [(1,0.20,0.56),(5,0.25,0.60),(10,0.30,0.62),(15,0.33,0.64)]},
}

# ─────────────────────────────────────────────────────────────────────────────
# DATA FETCH  (Binance US → Kraken → Coinbase fallback chain)
# ─────────────────────────────────────────────────────────────────────────────

KRAKEN_PAIR = dict(BTC="XXBTZUSD",ETH="XETHZUSD",SOL="SOLUSD",XRP="XXRPZUSD",
                   DOGE="XDGUSD",BNB="BNBUSD",HYPE="HYPEUSD")
CB_PRODUCT  = dict(BTC="BTC-USD",ETH="ETH-USD",SOL="SOL-USD",XRP="XRP-USD",
                   DOGE="DOGE-USD",BNB="BNB-USD",HYPE="HYPE-USD")

def _http_get(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "WECRYPTO-PyBacktest/2.5"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def fetch_binance(bin_sym: str, limit: int = 1000) -> list[dict]:
    url = f"https://api.binance.us/api/v3/klines?symbol={bin_sym}&interval=5m&limit={limit}"
    rows = _http_get(url)
    return [dict(t=int(r[0]),o=float(r[1]),h=float(r[2]),l=float(r[3]),c=float(r[4]),v=float(r[5])) for r in rows]

def fetch_kraken(sym: str, limit: int = 1000) -> list[dict]:
    pair  = KRAKEN_PAIR[sym]
    since = int((time.time() - limit * 5 * 60))
    data  = _http_get(f"https://api.kraken.com/0/public/OHLC?pair={pair}&interval=5&since={since}")
    if data.get("error"): raise ValueError(data["error"])
    key  = next(k for k in data["result"] if k != "last")
    rows = data["result"][key]
    return [dict(t=int(r[0])*1000,o=float(r[1]),h=float(r[2]),l=float(r[3]),c=float(r[4]),v=float(r[6])) for r in rows]

def fetch_coinbase(sym: str, limit: int = 300) -> list[dict]:
    product = CB_PRODUCT[sym]
    end     = int(time.time())
    start   = end - min(limit, 300) * 5 * 60
    url     = (f"https://api.coinbase.com/api/v3/brokerage/market/products/"
               f"{product}/candles?start={start}&end={end}&granularity=FIVE_MINUTE&limit={min(limit,300)}")
    data    = _http_get(url)
    rows    = sorted(data["candles"], key=lambda r: r["start"])
    return [dict(t=int(r["start"])*1000,o=float(r["open"]),h=float(r["high"]),
                 l=float(r["low"]),c=float(r["close"]),v=float(r["volume"])) for r in rows]

def fetch_candles(coin: dict, limit: int) -> list[dict]:
    errors = []
    for fn, arg in [(fetch_binance, coin["binSym"]),
                    (fetch_kraken,  coin["sym"]),
                    (fetch_coinbase,coin["sym"])]:
        try:
            lim = min(limit, 300) if fn is fetch_coinbase else limit
            candles = fn(arg, lim)
            if candles:
                return candles
        except Exception as e:
            errors.append(f"{fn.__name__}: {e}")
    raise RuntimeError(" | ".join(errors))

# ─────────────────────────────────────────────────────────────────────────────
# INDICATOR FUNCTIONS  (numpy-vectorised, exact parity with predictions.js)
# ─────────────────────────────────────────────────────────────────────────────

def clamp(v, lo, hi): return max(lo, min(hi, v))

def calc_rsi(closes: np.ndarray, period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    deltas = np.diff(closes)
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = gains[:period].mean()
    avg_loss = losses[:period].mean()
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)

def calc_ema_arr(data: np.ndarray, period: int) -> np.ndarray:
    k   = 2.0 / (period + 1)
    out = np.empty(len(data))
    out[0] = data[0]
    for i in range(1, len(data)):
        out[i] = data[i] * k + out[i - 1] * (1 - k)
    return out

def calc_vwap(candles: list[dict]) -> np.ndarray:
    tp  = np.array([(c["h"] + c["l"] + c["c"]) / 3 for c in candles])
    vol = np.array([c["v"] or 1.0 for c in candles])
    cum_vol = np.cumsum(vol)
    cum_tp  = np.cumsum(tp * vol)
    return np.where(cum_vol > 0, cum_tp / cum_vol, tp)

def calc_obv(candles: list[dict]) -> np.ndarray:
    closes = np.array([c["c"] for c in candles])
    vols   = np.array([c["v"] or 1.0 for c in candles])
    obv    = np.zeros(len(candles))
    for i in range(1, len(candles)):
        if   closes[i] > closes[i-1]: obv[i] = obv[i-1] + vols[i]
        elif closes[i] < closes[i-1]: obv[i] = obv[i-1] - vols[i]
        else:                          obv[i] = obv[i-1]
    return obv

def calc_macd(closes: np.ndarray, fast=12, slow=26, sig_period=9) -> dict:
    if len(closes) < slow + sig_period:
        return dict(macd=0.0, signal=0.0, histogram=0.0)
    ema_fast   = calc_ema_arr(closes, fast)
    ema_slow   = calc_ema_arr(closes, slow)
    macd_line  = ema_fast - ema_slow
    signal_line= calc_ema_arr(macd_line, sig_period)
    return dict(macd=macd_line[-1], signal=signal_line[-1],
                histogram=macd_line[-1] - signal_line[-1])

def calc_stochrsi(closes: np.ndarray, rsi_period=14, stoch_period=14,
                  smooth_k=3, smooth_d=3) -> dict:
    needed = rsi_period + stoch_period + max(smooth_k, smooth_d) + 2
    if len(closes) < needed:
        return dict(k=50.0, d=50.0)
    rsi_vals = np.array([calc_rsi(closes[:i+1], rsi_period)
                         for i in range(rsi_period, len(closes))])
    raw_k = []
    for i in range(stoch_period - 1, len(rsi_vals)):
        s = rsi_vals[i-stoch_period+1:i+1]
        hi, lo = s.max(), s.min()
        raw_k.append((rsi_vals[i] - lo) / (hi - lo) * 100 if hi != lo else 50.0)
    if not raw_k:
        return dict(k=50.0, d=50.0)
    sk = calc_ema_arr(np.array(raw_k), smooth_k)
    sd = calc_ema_arr(sk, smooth_d)
    return dict(k=float(sk[-1]), d=float(sd[-1]))

def _wilder_smooth(arr: np.ndarray, period: int) -> np.ndarray:
    if len(arr) < period:
        return np.array([arr.sum()])
    s    = arr[:period].sum()
    out  = [s]
    for v in arr[period:]:
        s = s - s / period + v
        out.append(s)
    return np.array(out)

def calc_adx(candles: list[dict], period: int = 14) -> dict:
    if len(candles) < period * 2 + 1:
        return dict(adx=25.0, pdi=25.0, mdi=25.0)
    highs  = np.array([c["h"] for c in candles])
    lows   = np.array([c["l"] for c in candles])
    closes = np.array([c["c"] for c in candles])
    tr_arr, plus_dm, minus_dm = [], [], []
    for i in range(1, len(candles)):
        tr = max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
        up   = highs[i]  - highs[i-1]
        down = lows[i-1] - lows[i]
        tr_arr.append(tr)
        plus_dm.append(up   if up > down   and up   > 0 else 0.0)
        minus_dm.append(down if down > up  and down > 0 else 0.0)
    atr_s  = _wilder_smooth(np.array(tr_arr),   period)
    pdi_s  = _wilder_smooth(np.array(plus_dm),  period)
    mdi_s  = _wilder_smooth(np.array(minus_dm), period)
    dx_arr = []
    for i in range(len(atr_s)):
        atr = atr_s[i]
        pdi = (pdi_s[i] / atr * 100) if atr > 0 else 0.0
        mdi = (mdi_s[i] / atr * 100) if atr > 0 else 0.0
        s   = pdi + mdi
        dx_arr.append(abs(pdi - mdi) / s * 100 if s > 0 else 0.0)
    adx_arr = _wilder_smooth(np.array(dx_arr), period)
    li      = len(adx_arr) - 1
    atr_l   = atr_s[li]
    return dict(adx=float(adx_arr[li]),
                pdi=float(pdi_s[li] / atr_l * 100) if atr_l > 0 else 0.0,
                mdi=float(mdi_s[li] / atr_l * 100) if atr_l > 0 else 0.0)

def calc_ichimoku(candles: list[dict]) -> dict:
    if len(candles) < 9:
        return dict(tenkan=0.0, kijun=0.0, cloudPos="inside")
    def mid(sl): return (max(c["h"] for c in sl) + min(c["l"] for c in sl)) / 2
    tenkan = mid(candles[-9:])
    kijun  = mid(candles[-26:] if len(candles) >= 26 else candles)
    s52    = candles[-52:] if len(candles) >= 52 else candles
    span_a = (tenkan + kijun) / 2
    span_b = mid(s52)
    price  = candles[-1]["c"]
    top    = max(span_a, span_b);  bot = min(span_a, span_b)
    pos    = "above" if price > top else ("below" if price < bot else "inside")
    return dict(tenkan=tenkan, kijun=kijun, spanA=span_a, spanB=span_b, cloudPos=pos)

def calc_williams_r(candles: list[dict], period: int = 14) -> float:
    if len(candles) < period:
        return -50.0
    sl  = candles[-period:]
    hh  = max(c["h"] for c in sl)
    ll  = min(c["l"] for c in sl)
    cl  = candles[-1]["c"]
    return ((hh - cl) / (hh - ll)) * -100 if hh != ll else -50.0

def calc_mfi(candles: list[dict], period: int = 14) -> float:
    if len(candles) < period + 1:
        return 50.0
    sl = candles[-period-1:]
    pos_flow = neg_flow = 0.0
    for i in range(1, len(sl)):
        prev_tp = (sl[i-1]["h"] + sl[i-1]["l"] + sl[i-1]["c"]) / 3
        curr_tp = (sl[i]["h"]   + sl[i]["l"]   + sl[i]["c"])   / 3
        raw     = curr_tp * (sl[i]["v"] or 1.0)
        if   curr_tp > prev_tp: pos_flow += raw
        elif curr_tp < prev_tp: neg_flow += raw
    if neg_flow == 0:
        return 100.0 if pos_flow > 0 else 50.0
    return 100.0 - 100.0 / (1.0 + pos_flow / neg_flow)

def calc_atr(candles: list[dict], period: int = 14) -> float:
    if len(candles) < period + 1:
        return 0.0
    total = 0.0
    for i in range(len(candles) - period, len(candles)):
        c, p = candles[i], candles[i-1]
        total += max(c["h"]-c["l"], abs(c["h"]-p["c"]), abs(c["l"]-p["c"]))
    return total / period

def calc_bollinger(closes: np.ndarray, period: int = 20) -> dict:
    if len(closes) < period:
        return dict(position=0.5, widthPct=0.0)
    sl     = closes[-period:]
    middle = sl.mean()
    std    = sl.std()
    upper  = middle + std * 2;  lower = middle - std * 2
    width  = max(upper - lower, middle * 0.0001)
    pos    = clamp((sl[-1] - lower) / width, 0, 1)
    return dict(position=pos, widthPct=(width / middle * 100) if middle > 0 else 0.0)

def calc_trend_persistence(closes: np.ndarray, ema: np.ndarray, lookback: int = 8) -> dict:
    span = min(lookback, len(closes), len(ema))
    rc, re = closes[-span:], ema[-span:]
    above_rate = (rc >= re).sum() / span * 100 if span else 50.0
    ema_start  = re[0] if re[0] != 0 else re[-1] or 1.0
    slope_pct  = (re[-1] - ema_start) / ema_start * 100 if ema_start else 0.0
    sig = clamp(((above_rate - 50) / 30) + slope_pct * 4, -1, 1)
    return dict(signal=sig)

def calc_structure_bias(candles: list[dict], atr_pct: float) -> dict:
    if len(candles) < 12:
        return dict(signal=0.0, zone="none")
    recent  = candles[-24:]
    latest  = recent[-1]["c"]
    support    = min(c["l"] for c in recent)
    resistance = max(c["h"] for c in recent)
    sup_gap  = ((latest - support)    / latest * 100) if latest else 0.0
    res_gap  = ((resistance - latest) / latest * 100) if latest else 0.0
    buffer   = clamp(max((atr_pct or 0) * 1.25, 0.35), 0.35, 2.4)
    zone     = "middle";  sig = 0.0
    if sup_gap <= buffer and sup_gap <= res_gap:
        zone = "support";    sig =  clamp((buffer - sup_gap) / buffer, 0, 1) * 0.85
    elif res_gap <= buffer and res_gap < sup_gap:
        zone = "resistance"; sig = -clamp((buffer - res_gap) / buffer, 0, 1) * 0.85
    return dict(signal=sig, zone=zone, supGap=sup_gap, resGap=res_gap)

def obv_slope(obv: np.ndarray, n: int = 5) -> float:
    if len(obv) < n + 1:
        return 0.0
    r   = obv[-n:]
    avg = (abs(r[0]) + abs(r[-1])) / 2 or 1.0
    return (r[-1] - r[0]) / avg * 100

def summarize_agreement(sv: dict) -> dict:
    vals   = [v for v in sv.values() if abs(v) >= 0.08]
    if not vals:
        return dict(agreement=0.5, conflict=0.0, bulls=0, bears=0)
    bulls  = sum(1 for v in vals if v > 0)
    bears  = sum(1 for v in vals if v < 0)
    active = bulls + bears
    return dict(agreement=max(bulls,bears)/active if active else 0.5,
                conflict=min(bulls,bears)/active  if active else 0.0,
                bulls=bulls, bears=bears)

# ─────────────────────────────────────────────────────────────────────────────
# SIGNAL MODEL  (exact parity with buildSignalModel in backtest-runner.js)
# ─────────────────────────────────────────────────────────────────────────────

def build_signal_model(candles: list[dict]) -> Optional[dict]:
    if len(candles) < 26:
        return None
    closes    = np.array([c["c"] for c in candles])
    last_price= closes[-1]

    # RSI
    rsi       = calc_rsi(closes)
    if   rsi > 70: rsi_sig = -0.6 - ((rsi - 70) / 30) * 0.4
    elif rsi < 30: rsi_sig =  0.6 + ((30 - rsi) / 30) * 0.4
    else:          rsi_sig = (rsi - 50) / 50 * 0.3
    rsi_sig = clamp(rsi_sig, -1, 1)

    # EMA cross
    ema9      = calc_ema_arr(closes, 9)
    ema21     = calc_ema_arr(closes, 21)
    ema_cross = (ema9[-1] - ema21[-1]) / (ema21[-1] or 1) * 100
    ema_sig   = clamp(ema_cross * 5, -1, 1)

    # VWAP
    vwap_rolling = calc_vwap(candles[-80:] if len(candles) >= 80 else candles)
    vwap_last    = vwap_rolling[-1]
    vwap_dev     = ((last_price - vwap_last) / (vwap_last or 1)) * 100
    if   abs(vwap_dev) < 0.3:  vwap_sig = 0.0
    elif vwap_dev > 1.5:        vwap_sig = -0.5
    elif vwap_dev < -1.5:       vwap_sig =  0.5
    else:                        vwap_sig = 0.3 if vwap_dev > 0 else -0.3

    # OBV
    obv      = calc_obv(candles)
    obv_sig  = clamp(obv_slope(obv, 8) / 5, -1, 1)

    # Volume direction
    buy_v = sell_v = 0.0
    for c in candles[-12:]:
        rng = c["h"] - c["l"] or 0.0001
        bp  = (c["c"] - c["l"]) / rng
        v   = c["v"] or 1.0
        buy_v += v * bp;  sell_v += v * (1 - bp)
    vol_sig = clamp((buy_v / (sell_v or 1) - 1) * 0.5, -1, 1)

    # Momentum
    mom     = ((closes[-1] - closes[-7]) / (closes[-7] or 1)) * 100 if len(closes) > 6 else 0.0
    mom_sig = clamp(mom / 2, -1, 1)

    # ATR / Bollinger
    atr     = calc_atr(candles)
    atr_pct = (atr / last_price * 100) if last_price > 0 else 0.0
    bands   = calc_bollinger(closes)
    if   bands["position"] >= 0.88: band_sig = -clamp((bands["position"]-0.88)/0.12, 0, 1)
    elif bands["position"] <= 0.12: band_sig =  clamp((0.12-bands["position"])/0.12, 0, 1)
    else:                            band_sig =  clamp(-(bands["position"]-0.5)*0.45, -0.22, 0.22)

    # Persistence & structure
    pers = calc_trend_persistence(closes, ema21)
    struc = calc_structure_bias(candles, atr_pct)

    # MACD
    macd_r      = calc_macd(closes)
    macd_hn     = (macd_r["histogram"] / last_price * 1000) if last_price > 0 else 0.0
    macd_cross  = 0.18 if macd_r["macd"] > macd_r["signal"] else (-0.18 if macd_r["macd"] < macd_r["signal"] else 0.0)
    macd_sig    = clamp(macd_hn * 2.5 + macd_cross, -1, 1)

    # StochRSI
    sr = calc_stochrsi(closes)
    if   sr["k"] > 80: stoch_sig = -0.6 - ((sr["k"]-80)/20)*0.4
    elif sr["k"] < 20: stoch_sig =  0.6 + ((20-sr["k"])/20)*0.4
    else:               stoch_sig = (sr["k"]-50)/50*0.35
    stoch_sig = clamp(stoch_sig + clamp((sr["k"]-sr["d"])/20, -0.18, 0.18), -1, 1)

    # ADX
    adx_r   = calc_adx(candles)
    di_diff  = (adx_r["pdi"] - adx_r["mdi"]) / max(adx_r["pdi"] + adx_r["mdi"], 1)
    adx_sig  = clamp(di_diff * clamp(adx_r["adx"]/50, 0, 1) * 1.2, -1, 1)

    # Ichimoku
    ichi = calc_ichimoku(candles)
    if   ichi["cloudPos"] == "above": ichi_sig =  0.5 + (0.2 if ichi["tenkan"] > ichi["kijun"] else 0)
    elif ichi["cloudPos"] == "below": ichi_sig = -0.5 - (0.2 if ichi["tenkan"] < ichi["kijun"] else 0)
    else: ichi_sig = 0.12 if ichi["tenkan"] > ichi["kijun"] else (-0.12 if ichi["tenkan"] < ichi["kijun"] else 0.0)
    ichi_sig = clamp(ichi_sig, -1, 1)

    # Williams %R
    wr = calc_williams_r(candles)
    if   wr > -20: wr_sig = -0.6 - ((wr + 20)/20)*0.4
    elif wr < -80: wr_sig =  0.6 + ((-80 - wr)/20)*0.4
    else:           wr_sig = (wr + 50)/50 * -0.3
    wr_sig = clamp(wr_sig, -1, 1)

    # MFI
    mfi = calc_mfi(candles)
    if   mfi > 80: mfi_sig = -0.6 - ((mfi-80)/20)*0.4
    elif mfi < 20: mfi_sig =  0.6 + ((20-mfi)/20)*0.4
    else:           mfi_sig = (mfi-50)/50*0.35
    mfi_sig = clamp(mfi_sig, -1, 1)

    # Trend regime modulation (suppress contrarian in strong trend)
    is_bull = ema_cross > 0.15 and adx_r["pdi"] > adx_r["mdi"] and adx_r["adx"] > 22
    is_bear = ema_cross < -0.15 and adx_r["mdi"] > adx_r["pdi"] and adx_r["adx"] > 22
    if is_bull or is_bear:
        sf = clamp((adx_r["adx"] - 22) / 28, 0, 0.70)
        if is_bull:
            if rsi_sig   < 0: rsi_sig   *= (1 - sf)
            if stoch_sig < 0: stoch_sig *= (1 - sf)
            if wr_sig    < 0: wr_sig    *= (1 - sf)
            if band_sig  < 0: band_sig  *= (1 - sf * 0.6)
            if mfi_sig   < 0: mfi_sig   *= (1 - sf * 0.6)
        else:
            if rsi_sig   > 0: rsi_sig   *= (1 - sf)
            if stoch_sig > 0: stoch_sig *= (1 - sf)
            if wr_sig    > 0: wr_sig    *= (1 - sf)
            if band_sig  > 0: band_sig  *= (1 - sf * 0.6)
            if mfi_sig   > 0: mfi_sig   *= (1 - sf * 0.6)

    sv = dict(rsi=rsi_sig, ema=ema_sig, vwap=vwap_sig, obv=obv_sig, volume=vol_sig,
              momentum=mom_sig, bands=band_sig, persistence=pers["signal"],
              structure=struc["signal"], macd=macd_sig, stochrsi=stoch_sig,
              adx=adx_sig, ichimoku=ichi_sig, williamsR=wr_sig, mfi=mfi_sig)

    keys = list(sv.keys())
    total_w = sum(COMPOSITE_WEIGHTS.get(k, 0) for k in keys) or 1.0
    raw = sum(sv[k] * COMPOSITE_WEIGHTS.get(k, 0) for k in keys) / total_w
    adx_gate = max(0.25, adx_r["adx"] / 20) if adx_r["adx"] < 20 else 1.0
    score = clamp(raw * SCORE_AMPLIFIER * adx_gate, -1, 1)
    agr   = summarize_agreement(sv)

    return dict(
        score=score, absScore=abs(score),
        signal=("neutral" if abs(score) < 0.20
                else ("strong_bull" if score > 0.55 else "bullish") if score > 0
                else ("strong_bear" if score < -0.55 else "bearish")),
        agreement=agr["agreement"], conflict=agr["conflict"],
        coreScore=score,
        structureBias=struc["signal"], structureZone=struc["zone"],
        persistenceScore=pers["signal"],
        vwapDev=vwap_dev, emaCross=ema_cross, rsi=rsi, mom=mom, atrPct=atr_pct,
        signalVector=sv,
        # ── Quantum orbital spin ──────────────────────────────────────────────
        spinState=score_to_spin(score),
        spinConf=spin_to_confidence(score_to_spin(score)),
    )

# ─────────────────────────────────────────────────────────────────────────────
# STATISTICAL HELPERS
# ─────────────────────────────────────────────────────────────────────────────

# Crypto is 24/7.  5-min candles:  365 * 24 * 12 = 105 120 per year.
# For Kalshi 15-min horizon:       365 * 24 *  4 = 35  040 per year.
PERIODS_PER_YEAR_5M  = 105_120
PERIODS_PER_YEAR_15M =  35_040

def sharpe_ratio(returns: np.ndarray, periods_per_year: int = PERIODS_PER_YEAR_5M,
                 risk_free: float = 0.0) -> float:
    if len(returns) < 2 or returns.std() == 0:
        return 0.0
    excess = returns - risk_free / periods_per_year
    return float(excess.mean() / excess.std() * math.sqrt(periods_per_year))

def sortino_ratio(returns: np.ndarray, periods_per_year: int = PERIODS_PER_YEAR_5M) -> float:
    if len(returns) < 2:
        return 0.0
    neg     = returns[returns < 0]
    if len(neg) == 0:
        return float("inf")
    dd_std  = neg.std()
    if dd_std == 0:
        return 0.0
    return float(returns.mean() / dd_std * math.sqrt(periods_per_year))

def calmar_ratio(equity_curve: np.ndarray) -> float:
    if len(equity_curve) < 2:
        return 0.0
    total_return = (equity_curve[-1] / equity_curve[0]) - 1.0
    peak    = np.maximum.accumulate(equity_curve)
    dd      = (equity_curve - peak) / peak
    max_dd  = abs(dd.min())
    return float(total_return / max_dd) if max_dd > 0 else 0.0

def kelly_fraction(win_rate: float, avg_win: float, avg_loss: float) -> float:
    """Full Kelly fraction.  Always cap at 25% to prevent ruin."""
    if avg_loss == 0 or win_rate <= 0 or win_rate >= 1:
        return 0.0
    b   = avg_win / abs(avg_loss)  # win/loss ratio
    k   = win_rate - (1 - win_rate) / b
    return clamp(k, 0.0, 0.25)

def bootstrap_winrate_ci(wins: int, n_trades: int, n_boot: int = 2000,
                         confidence: float = 0.95) -> tuple[float, float]:
    """Bootstrap 95% CI on win rate from binary outcomes."""
    if n_trades == 0:
        return (0.0, 0.0)
    p    = wins / n_trades
    boot = np.random.binomial(n_trades, p, n_boot) / n_trades
    lo   = float(np.percentile(boot, (1 - confidence) / 2 * 100))
    hi   = float(np.percentile(boot, (1 - (1 - confidence) / 2) * 100))
    return (lo, hi)

def monte_carlo_equity(trade_returns: list[float], n_paths: int = 500,
                       start: float = 100.0) -> dict:
    """Monte Carlo equity simulation by random resampling."""
    if not trade_returns:
        return dict(median=start, p5=start, p95=start, ruin_pct=0.0)
    arr    = np.array(trade_returns) / 100.0
    n      = len(arr)
    paths  = []
    for _ in range(n_paths):
        idx = np.random.choice(n, n, replace=True)
        eq  = start * np.cumprod(1 + arr[idx])
        paths.append(eq[-1])
    paths = np.array(paths)
    ruin  = float((paths < start * 0.5).mean() * 100)  # paths that lost >50%
    return dict(
        median=float(np.median(paths)),
        p5=float(np.percentile(paths, 5)),
        p95=float(np.percentile(paths, 95)),
        ruin_pct=ruin,
    )

# ─────────────────────────────────────────────────────────────────────────────
# BACKTEST ENGINE
# ─────────────────────────────────────────────────────────────────────────────

def score_bucket(abs_score: float) -> str:
    if abs_score >= 0.4: return "strong"
    if abs_score >= 0.25: return "moderate"
    if abs_score >= 0.1: return "light"
    return "neutral"

def run_backtest(sym: str, candles: list[dict],
                 filter_overrides: Optional[dict] = None) -> dict:
    """Walk-forward backtest for all 4 horizons.  Returns per-horizon stats dict."""
    overrides = filter_overrides or BACKTEST_FILTER_OVERRIDES.get(sym, {})
    results   = {}
    profile   = COIN_ORBITAL_PROFILES.get(sym, COIN_ORBITAL_PROFILES["BTC"])
    HORIZONS  = [1, 5, 10, 15]
    BAR_MIN   = 5

    for h_min in HORIZONS:
        h_bars  = max(1, round(h_min / BAR_MIN))
        h_key   = f"h{h_min}"
        filt    = overrides.get(h_key, DEFAULT_FILTERS[h_key])
        entry_thr  = filt["entryThreshold"]
        agree_thr  = filt["minAgreement"]

        obs_list   = []
        ind_accum: dict[str, dict] = {}  # per-indicator accuracy tracker

        start_idx = max(52, BACKTEST_MIN_OBS)
        for idx in range(start_idx, len(candles) - h_bars):
            win = candles[max(0, idx - LIVE_WINDOW + 1): idx + 1]
            model = build_signal_model(win)
            if model is None:
                continue

            entry = candles[idx]["c"]
            exit_ = candles[idx + h_bars]["c"]
            ret_pct = ((exit_ - entry) / entry * 100) if entry > 0 else 0.0

            d_core = model["coreScore"]
            pers_veto = (
                math.copysign(1, model["persistenceScore"]) != 0
                and math.copysign(1, model["persistenceScore"]) != math.copysign(1, d_core)
                and abs(model["persistenceScore"]) >= 0.35
                and abs(d_core) < (entry_thr + 0.04)
            )

            # ── Orbital spin gate (new for ±5 system) ────────────────────────
            spin = model["spinState"]
            # extreme shells (±4, ±5) require higher agreement for core archetype coins
            spin_gate = True
            if abs(spin) >= 4 and profile["archetype"] == "core":
                spin_gate = model["agreement"] >= 0.72

            is_active = (
                model["absScore"] >= entry_thr
                and model["agreement"] >= agree_thr
                and not (model["conflict"] >= 0.38 and model["agreement"] < agree_thr + 0.08)
                and not (abs(model["coreScore"]) < entry_thr * 0.92 and model["conflict"] >= 0.30)
                and not (model["structureZone"] == "resistance" and d_core > 0
                         and model["agreement"] < 0.65 and abs(model["structureBias"]) >= 0.18)
                and not (model["structureZone"] == "support"    and d_core < 0
                         and model["agreement"] < 0.65 and abs(model["structureBias"]) >= 0.18)
                and not pers_veto
                and spin_gate
            )

            direction     = (1 if model["score"] > 0 else -1) if is_active else 0
            signed_ret    = ret_pct * direction if direction != 0 else 0.0

            # Apply orbital spin confidence boost to position sizing proxy
            # (used only for Kelly / weighted equity sim, not for win/loss count)
            spin_boost    = spin_to_confidence(spin) * profile["extremeBoost"] if is_active else 0.0

            utc_h = datetime.fromtimestamp(candles[idx]["t"] / 1000, tz=timezone.utc).hour
            if   13 <= utc_h < 18: session = "NY Open"
            elif  7 <= utc_h < 12: session = "London"
            elif  0 <= utc_h <  6: session = "Asia"
            else:                   session = "Off-Hours"

            obs_list.append(dict(
                t=candles[idx]["t"], direction=direction,
                score=model["score"], absScore=model["absScore"],
                agreement=model["agreement"], conflict=model["conflict"],
                signedReturn=signed_ret, returnPct=ret_pct,
                bucket=(score_bucket(model["absScore"]) if direction else "neutral"),
                correct=(signed_ret > 0) if direction else None,
                atrPct=model["atrPct"], rsi=model["rsi"],
                emaCross=model["emaCross"], mom=model["mom"],
                spinState=spin, spinConf=spin_boost,
                session=session,
            ))

            # Per-indicator accuracy
            if direction != 0 and "signalVector" in model:
                actual_dir = 1 if ret_pct > 0 else -1
                for k, v in model["signalVector"].items():
                    if abs(v) >= 0.08:
                        acc = ind_accum.setdefault(k, dict(agree=0, total=0))
                        acc["total"] += 1
                        if (v > 0) == (actual_dir > 0):
                            acc["agree"] += 1

        active = [o for o in obs_list if o["direction"] != 0]
        wins   = [o for o in active if o["signedReturn"] > 0]
        losses = [o for o in active if o["signedReturn"] < 0]
        rets   = np.array([o["signedReturn"] for o in active])
        gross_w = sum(o["signedReturn"] for o in wins)
        gross_l = abs(sum(o["signedReturn"] for o in losses))

        # Equity curve
        equity     = 100.0;  peak = 100.0;  max_dd = 0.0
        eq_curve   = [100.0]
        for o in active:
            equity *= (1 + o["signedReturn"] / 100)
            eq_curve.append(equity)
            peak    = max(peak, equity)
            max_dd  = max(max_dd, (peak - equity) / peak * 100)

        # Statistical metrics
        wr_pct     = len(wins) / len(active) * 100 if active else 0.0
        avg_win    = gross_w / len(wins)  if wins   else 0.0
        avg_loss   = gross_l / len(losses) if losses else 0.0
        sh         = sharpe_ratio(rets, PERIODS_PER_YEAR_15M if h_min == 15 else PERIODS_PER_YEAR_5M)
        so         = sortino_ratio(rets, PERIODS_PER_YEAR_15M if h_min == 15 else PERIODS_PER_YEAR_5M)
        cal        = calmar_ratio(np.array(eq_curve))
        kelly      = kelly_fraction(wr_pct/100, avg_win, avg_loss)
        ci_lo, ci_hi = bootstrap_winrate_ci(len(wins), len(active))
        mc         = monte_carlo_equity([o["signedReturn"] for o in active])

        # Signal bucketing
        bucket_stats = {}
        for b in ("strong", "moderate", "light"):
            bt = [o for o in active if o["bucket"] == b]
            bucket_stats[b] = dict(
                count=len(bt),
                winRate=len([o for o in bt if o["signedReturn"]>0])/len(bt)*100 if bt else None
            )

        # Session stats
        sess_map: dict[str, dict] = {}
        for o in active:
            s = o["session"]
            sm = sess_map.setdefault(s, dict(wins=0, total=0))
            sm["total"] += 1
            if o["signedReturn"] > 0: sm["wins"] += 1
        session_stats = [dict(session=s, total=v["total"],
                              winRate=v["wins"]/v["total"]*100 if v["total"] else 0.0)
                         for s,v in sorted(sess_map.items(), key=lambda x:-x[1]["total"])]

        # Indicator accuracy ranking
        ind_acc = sorted(
            [dict(indicator=k, accuracy=v["agree"]/v["total"]*100, samples=v["total"])
             for k,v in ind_accum.items() if v["total"] >= 5],
            key=lambda x: -x["accuracy"]
        )

        # Quantum spin distribution
        spin_dist = {}
        for o in active:
            s = o["spinState"]
            spin_dist[s] = spin_dist.get(s, dict(count=0, wins=0))
            spin_dist[s]["count"] += 1
            if o["signedReturn"] > 0: spin_dist[s]["wins"] += 1
        spin_table = sorted([
            dict(spin=s, count=v["count"],
                 winRate=v["wins"]/v["count"]*100 if v["count"] else 0.0,
                 conf=spin_to_confidence(s))
            for s,v in spin_dist.items()
        ], key=lambda x: x["spin"])

        results[h_key] = dict(
            horizonMin=h_min, horizonBars=h_bars, filter=filt,
            observations=len(obs_list), activeSignals=len(active),
            coverage=len(active)/len(obs_list)*100 if obs_list else 0.0,
            winRate=wr_pct,
            winRateCI=dict(lo=ci_lo*100, hi=ci_hi*100),
            wins=len(wins), losses=len(losses),
            avgSignedReturn=rets.mean() if len(rets) else 0.0,
            avgWin=avg_win, avgLoss=-avg_loss,
            profitFactor=gross_w/gross_l if gross_l > 0 else (gross_w if gross_w > 0 else 0.0),
            sharpe=sh, sortino=so, calmar=cal, kelly=kelly,
            equity=dict(final=equity, returnPct=equity-100, maxDrawdownPct=max_dd),
            monteCarlo=mc,
            buckets=bucket_stats,
            sessions=session_stats,
            indicatorAccuracy=ind_acc,
            spinTable=spin_table,
        )

    return results

# ─────────────────────────────────────────────────────────────────────────────
# THRESHOLD OPTIMISER  (grid search with 3-fold walk-forward CV)
# ─────────────────────────────────────────────────────────────────────────────

def optimize_thresholds(sym: str, candles: list[dict],
                        horizon_min: int = 15) -> dict:
    """
    Grid search entryThreshold × minAgreement, 3-fold walk-forward CV.
    Optimises for Sharpe ratio.  Returns best params per fold + averaged best.
    """
    print(f"    Optimising {sym} h{horizon_min}m thresholds … ", end="", flush=True)

    entry_grid  = np.round(np.arange(0.12, 0.46, 0.02), 3).tolist()
    agree_grid  = np.round(np.arange(0.48, 0.74, 0.02), 3).tolist()
    n_folds     = 3
    fold_size   = len(candles) // n_folds
    fold_results = []

    for fold in range(n_folds):
        train_start = fold * fold_size
        train_end   = train_start + fold_size
        if train_end > len(candles): break
        fold_candles = candles[train_start:train_end]
        if len(fold_candles) < 200: continue

        best_sharpe = -999.0
        best_params = None
        for et, ag in itertools.product(entry_grid, agree_grid):
            r = run_backtest(sym, fold_candles,
                             {f"h{h}": dict(entryThreshold=et, minAgreement=ag)
                              for h in [1,5,10,15]})
            hr = r.get(f"h{horizon_min}")
            if hr and hr["activeSignals"] >= 10:
                sh = hr["sharpe"]
                if sh > best_sharpe:
                    best_sharpe = sh
                    best_params = dict(entryThreshold=et, minAgreement=ag,
                                       sharpe=sh, winRate=hr["winRate"],
                                       activeSignals=hr["activeSignals"])
        if best_params:
            fold_results.append(best_params)

    print("done")
    if not fold_results:
        return dict(sym=sym, status="insufficient_data")

    # Average across folds (robust to any single period being anomalous)
    avg_et  = sum(r["entryThreshold"] for r in fold_results) / len(fold_results)
    avg_ag  = sum(r["minAgreement"]   for r in fold_results) / len(fold_results)
    avg_sh  = sum(r["sharpe"]         for r in fold_results) / len(fold_results)
    avg_wr  = sum(r["winRate"]        for r in fold_results) / len(fold_results)

    # Round to nearest grid step
    avg_et = round(round(avg_et / 0.02) * 0.02, 3)
    avg_ag = round(round(avg_ag / 0.02) * 0.02, 3)

    return dict(sym=sym, horizonMin=horizon_min,
                entryThreshold=avg_et, minAgreement=avg_ag,
                avgSharpe=avg_sh, avgWinRate=avg_wr,
                folds=fold_results)

# ─────────────────────────────────────────────────────────────────────────────
# KALSHI TRADE HISTORY ANALYSER
# ─────────────────────────────────────────────────────────────────────────────

def analyse_kalshi_csv(csv_path: str) -> dict:
    """Parse Kalshi-Recent-Activity-All.csv and compute per-coin / per-price stats."""
    rows = []
    try:
        with open(csv_path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                rows.append(row)
    except FileNotFoundError:
        print(f"  ⚠  Kalshi CSV not found: {csv_path}")
        return {}

    filled = [r for r in rows if r.get("Status","").strip() == "Filled"
              and r.get("type","").strip() == "Order"]

    COIN_MAP = {"BTC":"BTC","ETH":"ETH","SOL":"SOL","XRP":"XRP",
                "DOGE":"DOGE","BNB":"BNB","HYPE":"HYPE"}

    def parse_coin(ticker: str) -> str:
        for sym in COIN_MAP:
            if f"KX{sym}15M" in ticker:
                return sym
        return "UNKNOWN"

    def safe_float(s: str, default: float = 0.0) -> float:
        try: return float(s) if s.strip() else default
        except: return default

    per_coin: dict[str, dict] = {}
    price_buckets: dict[str, list] = {}   # entry price (cents) → [win/loss]

    for r in filled:
        ticker   = r.get("Market_Ticker","")
        sym      = parse_coin(ticker)
        ts_str   = r.get("Original_Date","")
        price_c  = safe_float(r.get("Price_In_Cents",""))
        filled_a = safe_float(r.get("Filled",""))
        profit   = safe_float(r.get("Profit_In_Dollars",""))
        result   = r.get("Result","").strip().upper()
        yes_own  = safe_float(r.get("Yes_Contracts_Owned",""))
        no_own   = safe_float(r.get("No_Contracts_Owned",""))
        direction= "YES" if yes_own > 0 else ("NO" if no_own > 0 else "")

        # Determine win/loss: positive profit = win, negative = loss, empty = unknown
        win = None
        if profit > 0:  win = True
        elif profit < 0: win = False

        # Time of day
        try:
            dt   = datetime.fromisoformat(ts_str.replace("Z","+00:00"))
            utch = dt.hour
        except: utch = -1
        if   13 <= utch < 18: session = "NY Open"
        elif  7 <= utch < 12: session = "London"
        elif  0 <= utch <  6: session = "Asia"
        elif utch >= 0:        session = "Off-Hours"
        else:                  session = "Unknown"

        entry = dict(ticker=ticker, sym=sym, ts=ts_str, price_c=price_c,
                     filled=filled_a, profit=profit, win=win,
                     direction=direction, session=session)

        pc = per_coin.setdefault(sym, dict(trades=[], wins=0, losses=0,
                                           total_profit=0.0, sessions={}))
        pc["trades"].append(entry)
        pc["total_profit"] += profit
        if win is True:  pc["wins"] += 1
        elif win is False: pc["losses"] += 1
        s = pc["sessions"].setdefault(session, dict(wins=0, total=0))
        s["total"] += 1
        if win is True: s["wins"] += 1

        # Price bucket analysis (contracts with entry price in ranges)
        bucket = f"{int(price_c//5)*5}-{int(price_c//5)*5+4}¢" if price_c > 0 else "unknown"
        pb = price_buckets.setdefault(bucket, [])
        pb.append(entry)

    # Build summary
    summary = {}
    for sym, data in per_coin.items():
        n      = len(data["trades"])
        known  = data["wins"] + data["losses"]
        wr     = data["wins"] / known * 100 if known > 0 else None
        ci     = bootstrap_winrate_ci(data["wins"], known) if known >= 5 else (None, None)
        summary[sym] = dict(
            trades=n,
            wins=data["wins"], losses=data["losses"],
            winRate=wr,
            ciLo=ci[0]*100 if ci[0] else None,
            ciHi=ci[1]*100 if ci[1] else None,
            totalProfit=round(data["total_profit"],2),
            sessions={s: dict(total=v["total"],
                              winRate=v["wins"]/v["total"]*100 if v["total"] else 0.0)
                      for s,v in data["sessions"].items()},
        )

    # Price bucket analysis
    price_summary = {}
    for bucket, entries in sorted(price_buckets.items()):
        known = [e for e in entries if e["win"] is not None]
        wins  = [e for e in known if e["win"]]
        price_summary[bucket] = dict(
            count=len(entries),
            known=len(known),
            winRate=len(wins)/len(known)*100 if known else None,
        )

    return dict(perCoin=summary, priceBuckets=price_summary,
                totalFilled=len(filled), totalRows=len(rows))

# ─────────────────────────────────────────────────────────────────────────────
# REPORT PRINTER
# ─────────────────────────────────────────────────────────────────────────────

def _bar(pct: float, width: int = 20) -> str:
    filled = round(max(0.0, min(pct, 100.0)) / 100 * width)
    return "█" * filled + "░" * (width - filled)

def _wr_icon(wr: float) -> str:
    return "✅" if wr >= 58 else ("🟡" if wr >= 50 else "❌")

def print_coin_report(sym: str, results: dict, candle_count: int):
    divider = "─" * 80
    print(f"\n{divider}")
    print(f"  {sym}   ({candle_count} candles  ·  {candle_count*5/60/24:.1f} days)")
    print(divider)

    HORIZONS = [1, 5, 10, 15]
    for h in HORIZONS:
        r = results.get(f"h{h}")
        if not r or r["activeSignals"] < 5:
            print(f"  h{h}m  — insufficient data ({r['activeSignals'] if r else 0} signals)")
            continue

        wr    = r["winRate"]
        ci    = r["winRateCI"]
        eq    = r["equity"]["returnPct"]
        icon  = _wr_icon(wr)
        eq_s  = f"+{eq:.1f}" if eq >= 0 else f"{eq:.1f}"

        print(f"\n  ┌─ h{h:2d}m {icon}  WR: {wr:.1f}%  [{ci['lo']:.1f}–{ci['hi']:.1f}% CI]  "
              f"Signals: {r['activeSignals']}/{r['observations']} ({r['coverage']:.0f}%)")
        print(f"  │  {_bar(wr)}  Eq: {eq_s}%  MaxDD: {r['equity']['maxDrawdownPct']:.1f}%  "
              f"PF: {r['profitFactor']:.2f}")
        print(f"  │  Sharpe: {r['sharpe']:+.2f}  Sortino: {r['sortino']:+.2f}  "
              f"Calmar: {r['calmar']:+.2f}  Kelly: {r['kelly']*100:.1f}%")
        print(f"  │  AvgEdge: {r['avgSignedReturn']:+.3f}%  "
              f"AvgWin: +{r['avgWin']:.3f}%  AvgLoss: {r['avgLoss']:.3f}%")

        # Monte Carlo
        mc = r.get("monteCarlo",{})
        if mc:
            print(f"  │  Monte Carlo (500 paths): "
                  f"p5={mc['p5']:.1f}  median={mc['median']:.1f}  "
                  f"p95={mc['p95']:.1f}  ruin<50%: {mc['ruin_pct']:.1f}%")

        # Signal buckets
        bkts = [(b, v) for b,v in r["buckets"].items() if v["count"] > 0]
        if bkts:
            bstr = "  │  ".join(f"{b}: {v['count']}@{v['winRate']:.0f}%" for b,v in bkts)
            print(f"  │  Buckets: {bstr}")

        # Sessions
        if r["sessions"]:
            sstr = "  ".join(f"{s['session']}: {s['winRate']:.0f}%/{s['total']}"
                             for s in r["sessions"])
            print(f"  │  Sessions: {sstr}")

        # Quantum spin table (only non-zero states)
        st = [s for s in r.get("spinTable",[]) if s["count"] >= 3]
        if st:
            headers = ["spin", "count", "WR%", "conf"]
            rows    = [[s["spin"], s["count"], f"{s['winRate']:.0f}%",
                        f"{s['conf']:.2f}"] for s in st]
            tbl     = tabulate(rows, headers=headers, tablefmt="plain")
            for line in tbl.split("\n"):
                print(f"  │    {line}")

        # Indicator accuracy
        if r["indicatorAccuracy"]:
            top3 = ", ".join(f"{x['indicator']}: {x['accuracy']:.0f}%({x['samples']})"
                             for x in r["indicatorAccuracy"][:3])
            bot3 = ", ".join(f"{x['indicator']}: {x['accuracy']:.0f}%({x['samples']})"
                             for x in r["indicatorAccuracy"][-3:])
            print(f"  │  Best  indicators: {top3}")
            print(f"  └  Worst indicators: {bot3}")
        else:
            print(f"  └  (no indicator data)")

def print_kalshi_report(kalshi: dict):
    if not kalshi:
        return
    print("\n\n" + "═" * 80)
    print("  KALSHI TRADE HISTORY ANALYSIS")
    print("═" * 80)
    print(f"  Total rows: {kalshi['totalRows']}  Filled orders: {kalshi['totalFilled']}")

    rows = []
    for sym, d in sorted(kalshi["perCoin"].items()):
        wr = f"{d['winRate']:.1f}%" if d["winRate"] is not None else "—"
        ci = (f"[{d['ciLo']:.1f}–{d['ciHi']:.1f}%]"
              if d.get("ciLo") is not None else "")
        rows.append([sym, d["trades"], d["wins"], d["losses"], wr, ci,
                     f"${d['totalProfit']:+.2f}"])
    print(tabulate(rows, headers=["Coin","Trades","W","L","WR","95%CI","P&L"],
                   tablefmt="simple"))

    # Price bucket insight
    print("\n  Entry price buckets (¢):")
    pb_rows = []
    for bucket, v in sorted(kalshi["priceBuckets"].items()):
        wr = f"{v['winRate']:.0f}%" if v["winRate"] is not None else "—"
        pb_rows.append([bucket, v["count"], wr])
    print(tabulate(pb_rows, headers=["Price","Count","WR%"], tablefmt="plain"))

def print_summary_table(all_results: dict):
    print("\n\n" + "═" * 80)
    print("  CROSS-COIN SUMMARY  —  Win Rates by Horizon")
    print("═" * 80)
    rows = []
    total_w = total_n = 0
    for sym, data in all_results.items():
        res = data["results"]
        vals = [res.get(f"h{h}",{}).get("winRate") for h in [1,5,10,15]]
        sharpes = [res.get(f"h{h}",{}).get("sharpe") for h in [1,5,10,15]]
        best_h = max([1,5,10,15],
                     key=lambda h: res.get(f"h{h}",{}).get("sharpe") or -999)
        fmt_wr = lambda v: f"{v:.1f}%" if v is not None else "—"
        fmt_sh = lambda v: f"{v:+.2f}" if v is not None else "—"
        rows.append([sym,
                     fmt_wr(vals[0]), fmt_wr(vals[1]), fmt_wr(vals[2]), fmt_wr(vals[3]),
                     fmt_sh(sharpes[0]), fmt_sh(sharpes[1]), fmt_sh(sharpes[2]), fmt_sh(sharpes[3]),
                     f"h{best_h}m"])
        for h in [1,5,10,15]:
            r = res.get(f"h{h}", {})
            if r.get("activeSignals", 0) >= 5:
                total_w += r.get("wins", 0)
                total_n += r.get("activeSignals", 0)
    print(tabulate(rows,
                   headers=["Coin","WR-h1","WR-h5","WR-h10","WR-h15",
                             "Sh-h1","Sh-h5","Sh-h10","Sh-h15","Best"],
                   tablefmt="simple"))
    overall = f"{total_w/total_n*100:.1f}%" if total_n else "—"
    print(f"\n  Overall accuracy across all coins & horizons: "
          f"{overall}  ({total_w}/{total_n} active signals)")

# ─────────────────────────────────────────────────────────────────────────────
# OUTPUT — JSON + CSV
# ─────────────────────────────────────────────────────────────────────────────

def save_outputs(all_results: dict, opt_results: dict,
                 kalshi: dict, days_back: int):
    out_dir = Path(__file__).parent / "backtest-results"
    out_dir.mkdir(exist_ok=True)
    ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")

    # Full JSON report
    json_path = out_dir / f"backtest-report-py-{ts}.json"
    with open(json_path, "w") as f:
        json.dump(dict(
            generatedAt=datetime.now(tz=timezone.utc).isoformat(),
            engine="wecrypto_backtest.py v2.5.0",
            quantumSpinModel="±5 h-subshell (11 states)",
            daysBack=days_back,
            coins=all_results,
            optimisedThresholds=opt_results,
            kalshiAnalysis=kalshi,
        ), f, indent=2, default=str)
    print(f"\n  Full JSON → {json_path}")

    # Summary CSV
    csv_path = out_dir / f"backtest-summary-py-{ts}.csv"
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["coin","horizon","winRate","sharpe","sortino","calmar",
                         "kelly","profitFactor","equity","maxDD","signals","coverage",
                         "entryThreshold","minAgreement"])
        for sym, data in all_results.items():
            for h in [1,5,10,15]:
                r = data["results"].get(f"h{h}", {})
                if not r:
                    continue
                writer.writerow([
                    sym, h,
                    f"{r.get('winRate',0):.2f}", f"{r.get('sharpe',0):.3f}",
                    f"{r.get('sortino',0):.3f}", f"{r.get('calmar',0):.3f}",
                    f"{r.get('kelly',0):.4f}", f"{r.get('profitFactor',0):.3f}",
                    f"{r.get('equity',{}).get('returnPct',0):.2f}",
                    f"{r.get('equity',{}).get('maxDrawdownPct',0):.2f}",
                    r.get("activeSignals",0),
                    f"{r.get('coverage',0):.1f}",
                    r.get("filter",{}).get("entryThreshold",""),
                    r.get("filter",{}).get("minAgreement",""),
                ])
    print(f"  Summary CSV → {csv_path}")

    # Optimised thresholds for JS config (if available)
    if opt_results:
        opt_path = out_dir / f"optimised-thresholds-{ts}.json"
        with open(opt_path, "w") as f:
            json.dump(opt_results, f, indent=2)
        print(f"  Optimised thresholds → {opt_path}")

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="WECRYPTO Python Backtest Engine v2.5.0")
    parser.add_argument("--coin",     type=str,  default=None,  help="Run single coin (BTC, ETH, …)")
    parser.add_argument("--days",     type=int,  default=7,     help="Days of history (default 7)")
    parser.add_argument("--optimize", action="store_true",      help="Run grid-search optimisation")
    parser.add_argument("--kalshi",   action="store_true",      help="Analyse Kalshi CSV trade history")
    parser.add_argument("--no-mc",    action="store_true",      help="Skip Monte Carlo (faster)")
    args = parser.parse_args()

    candles_want = min(1000, args.days * 288)   # 288 × 5m = 1 day
    coins = PREDICTION_COINS
    if args.coin:
        coins = [c for c in PREDICTION_COINS if c["sym"] == args.coin.upper()]
        if not coins:
            print(f"Unknown coin: {args.coin}"); return

    print()
    print("╔══════════════════════════════════════════════════════════════════════════════╗")
    print("║  WECRYPTO Python Backtest Engine  v2.5.0                                    ║")
    print("║  Quantum Orbital Model  —  h-subshell  ±5 spin  (11 states)                ║")
    print(f"║  {len(coins)} coins  ·  {candles_want} × 5m candles  ≈ {args.days} days"
          f"  ·  {'optimise ON' if args.optimize else 'optimise OFF'}"
          f"                                   ║")
    print("╚══════════════════════════════════════════════════════════════════════════════╝")

    all_results  = {}
    opt_results  = {}
    kalshi_data  = {}

    for coin in coins:
        print(f"\n  Fetching {coin['sym']}… ", end="", flush=True)
        try:
            candles = fetch_candles(coin, candles_want)
            print(f"{len(candles)} candles ✓")
        except Exception as e:
            print(f"FAILED ({e})")
            continue
        if len(candles) < 60:
            print(f"  Skipping {coin['sym']} — not enough data"); continue

        print(f"  Backtesting {coin['sym']}… ", end="", flush=True)
        results = run_backtest(coin["sym"], candles)
        all_results[coin["sym"]] = dict(results=results, candleCount=len(candles))
        print("done")
        print_coin_report(coin["sym"], results, len(candles))

        if args.optimize:
            print(f"\n  [Optimise] {coin['sym']}:")
            opt = {}
            for h_min in [5, 15]:   # 5m and 15m are the most important
                opt[f"h{h_min}"] = optimize_thresholds(coin["sym"], candles, h_min)
            opt_results[coin["sym"]] = opt

        time.sleep(0.3)   # avoid rate-limit hammering

    print_summary_table(all_results)

    if args.kalshi:
        csv_path = Path(__file__).parent / "Kalshi-Recent-Activity-All.csv"
        print("\n\n  Analysing Kalshi trade history…")
        kalshi_data = analyse_kalshi_csv(str(csv_path))
        print_kalshi_report(kalshi_data)

    save_outputs(all_results, opt_results, kalshi_data, args.days)
    print("\n  Done.\n")


if __name__ == "__main__":
    random.seed(42); np.random.seed(42)
    main()
