#!/usr/bin/env python3
"""
WeCrypto Regime Detection Backtest Engine
Vectorized numpy/scipy implementation of Hurst, Variance Ratio, Entropy
with adaptive trend/mean-reversion signal weighting.
"""

import sys
import json
import argparse
from datetime import datetime, timedelta
import numpy as np
from scipy.stats import entropy
import requests

# ── Config ─────────────────────────────────────────────────────
BINANCE_API = "https://api.binance.us/api/v3/klines"
COINS = {
    'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT', 'SOL': 'SOLUSDT',
    'XRP': 'XRPUSDT', 'DOGE': 'DOGEUSDT', 'BNB': 'BNBUSDT', 'HYPE': 'HYPEUSDT'
}

LIVE_WINDOW = 300
COMPOSITE_WEIGHTS = {
    'ema': 0.18, 'structure': 0.17, 'momentum': 0.14, 'persistence': 0.12, 'macd': 0.10,
    'obv': 0.09, 'volume': 0.08, 'vwap': 0.06, 'adx': 0.05,
    'rsi': 0.04, 'bands': 0.04, 'williamsR': 0.04, 'stochrsi': 0.03, 'mfi': 0.03, 'ichimoku': 0.02,
}

BACKTEST_FILTERS = {
    'BTC':  {'h1': {'et': 0.23, 'ma': 0.54}, 'h5': {'et': 0.28, 'ma': 0.58}, 'h10': {'et': 0.33, 'ma': 0.62}, 'h15': {'et': 0.38, 'ma': 0.66}},
    'ETH':  {'h1': {'et': 0.23, 'ma': 0.54}, 'h5': {'et': 0.28, 'ma': 0.58}, 'h10': {'et': 0.33, 'ma': 0.62}, 'h15': {'et': 0.38, 'ma': 0.66}},
    'SOL':  {'h1': {'et': 0.20, 'ma': 0.52}, 'h5': {'et': 0.25, 'ma': 0.56}, 'h10': {'et': 0.30, 'ma': 0.60}, 'h15': {'et': 0.35, 'ma': 0.64}},
    'XRP':  {'h1': {'et': 0.19, 'ma': 0.52}, 'h5': {'et': 0.23, 'ma': 0.56}, 'h10': {'et': 0.28, 'ma': 0.60}, 'h15': {'et': 0.32, 'ma': 0.64}},
    'DOGE': {'h1': {'et': 0.28, 'ma': 0.58}, 'h5': {'et': 0.32, 'ma': 0.60}, 'h10': {'et': 0.35, 'ma': 0.62}, 'h15': {'et': 0.38, 'ma': 0.66}},
    'BNB':  {'h1': {'et': 0.20, 'ma': 0.54}, 'h5': {'et': 0.25, 'ma': 0.58}, 'h10': {'et': 0.29, 'ma': 0.62}, 'h15': {'et': 0.33, 'ma': 0.64}},
    'HYPE': {'h1': {'et': 0.20, 'ma': 0.56}, 'h5': {'et': 0.25, 'ma': 0.60}, 'h10': {'et': 0.30, 'ma': 0.62}, 'h15': {'et': 0.33, 'ma': 0.64}},
}

# ── Utility ────────────────────────────────────────────────────
def clamp(v, lo, hi):
    return max(lo, min(hi, v))

def fetch_candles(sym, days):
    """Fetch paginated candles from Binance."""
    candles = []
    end_time = int(datetime.now().timestamp() * 1000)
    candles_want = min(1000, days * 288)
    
    while len(candles) < candles_want:
        params = {
            'symbol': COINS.get(sym, f'{sym}USDT'),
            'interval': '5m',
            'limit': 1000,
            'endTime': end_time
        }
        try:
            r = requests.get(BINANCE_API, params=params, timeout=5)
            batch = r.json()
            if not batch:
                break
            candles = batch + candles
            end_time = batch[0][0] - 1
        except Exception as e:
            print(f"Fetch error: {e}", file=sys.stderr)
            break
    
    return [{'t': int(c[0]), 'o': float(c[1]), 'h': float(c[2]), 'l': float(c[3]), 'c': float(c[4]), 'v': float(c[7])} for c in candles[:candles_want]]

# ── Regime Detection ───────────────────────────────────────────
def calc_hurst(returns, lag_min=2, lag_max=19):
    """Hurst exponent via log-log regression."""
    if len(returns) < lag_max + 2:
        return 0.5
    
    xs, ys = [], []
    for lag in range(lag_min, lag_max + 1):
        diffs = returns[lag:] - returns[:-lag]
        tau = np.std(diffs)
        if tau > 0:
            xs.append(np.log(lag))
            ys.append(np.log(tau))
    
    if len(xs) < 2:
        return 0.5
    
    xs, ys = np.array(xs), np.array(ys)
    coef = np.polyfit(xs, ys, 1)[0]
    return clamp(coef, 0, 1)

def calc_variance_ratio(returns, lag=5, window=100):
    """Variance ratio: Var(k-lag) / (k * Var(1))."""
    if len(returns) < max(window, lag * 3):
        return 1.0
    
    x = returns[-window:]
    v1 = np.var(x)
    if v1 <= 0:
        return 1.0
    
    k_sums = np.array([np.sum(x[i:i+lag]) for i in range(0, len(x) - lag + 1, lag)])
    if len(k_sums) < 2:
        return 1.0
    
    vk = np.var(k_sums)
    return vk / (lag * v1)

def calc_entropy(returns, window=50, bins=10):
    """Normalized Shannon entropy."""
    if len(returns) < window:
        return 1.0
    
    x = returns[-window:]
    mn, mx = np.min(x), np.max(x)
    if not np.isfinite(mn) or not np.isfinite(mx) or mx <= mn:
        return 0.0
    
    hist, _ = np.histogram(x, bins=bins, range=(mn, mx))
    hist = hist + 1e-9
    p = hist / np.sum(hist)
    ent = -np.sum(p * np.log(p))
    return ent / np.log(bins) if np.log(bins) > 0 else 0.0

def compute_regime(closes):
    """Compute advanced regime score and weighting."""
    if len(closes) < 50:
        return {'regime_score': 0.5, 'trend_weight': 0.5, 'mean_rev_weight': 0.5, 'label': 'mixed', 'hurst': 0.5, 'vr': 1.0, 'entropy': 0.5}
    
    log_returns = np.diff(np.log(closes))
    hurst = calc_hurst(log_returns)
    vr = calc_variance_ratio(log_returns)
    entropy_norm = clamp(calc_entropy(log_returns), 0, 1)
    
    hurst_trend = clamp((hurst - 0.5) * 2, 0, 1)
    vr_trend = clamp((vr - 1) * 1.5, 0, 1)
    entropy_signal = 1 - entropy_norm
    
    regime_score = clamp(0.4 * hurst_trend + 0.4 * vr_trend + 0.2 * entropy_signal, 0, 1)
    label = 'trend' if regime_score >= 0.6 else 'mean_reversion' if regime_score <= 0.3 else 'mixed'
    
    return {
        'regime_score': float(regime_score),
        'trend_weight': float(regime_score),
        'mean_rev_weight': float(1 - regime_score),
        'label': label,
        'hurst': float(hurst),
        'vr': float(vr),
        'entropy': float(entropy_norm)
    }

# ── Signal Model ───────────────────────────────────────────────
def calc_rsi(closes, period=14):
    """Relative Strength Index."""
    if len(closes) < period + 1:
        return 50
    
    delta = np.diff(closes)
    gain = np.where(delta > 0, delta, 0)
    loss = np.where(delta < 0, -delta, 0)
    
    avg_gain = np.mean(gain[:period])
    avg_loss = np.mean(loss[:period])
    
    for i in range(period, len(delta)):
        avg_gain = (avg_gain * (period - 1) + gain[i]) / period
        avg_loss = (avg_loss * (period - 1) + loss[i]) / period
    
    if avg_loss == 0:
        return 100 if avg_gain > 0 else 50
    return 100 - (100 / (1 + avg_gain / avg_loss))

def calc_ema(data, period):
    """Exponential Moving Average."""
    k = 2 / (period + 1)
    ema = np.zeros(len(data))
    ema[0] = data[0]
    for i in range(1, len(data)):
        ema[i] = data[i] * k + ema[i-1] * (1 - k)
    return ema

def backtest_regime(sym, days=30):
    """Run walk-forward backtest with regime weighting."""
    print(f"Fetching {sym} ({days} days)...", file=sys.stderr)
    candles = fetch_candles(sym, days)
    if not candles:
        return {'error': f'Failed to fetch {sym}', 'sym': sym}
    
    print(f"  {len(candles)} candles ✓", file=sys.stderr)
    
    closes = np.array([c['c'] for c in candles])
    results = {'sym': sym, 'days': days, 'candles': len(candles), 'horizons': {}}
    
    for horizon_min in [1, 5, 10, 15]:
        horizon_bars = max(1, horizon_min)
        filter_key = f'h{horizon_min}'
        filt = BACKTEST_FILTERS.get(sym, {}).get(filter_key) or BACKTEST_FILTERS['BTC'][filter_key]
        
        wins, losses, total_return = 0, 0, 0
        trades = 0
        
        for idx in range(LIVE_WINDOW, len(closes) - horizon_bars):
            window = closes[max(0, idx - LIVE_WINDOW + 1):idx + 1]
            regime = compute_regime(window)
            
            # Simplified signal (trend-weighted)
            rsi = calc_rsi(window)
            rsi_sig = clamp((50 - rsi) / 20, -1, 1)
            
            # Apply regime weighting
            signal = rsi_sig * (0.6 + 0.8 * regime['trend_weight'])
            
            if abs(signal) >= filt['et']:
                trades += 1
                entry = closes[idx]
                exit_price = closes[idx + horizon_bars]
                ret = ((exit_price - entry) / entry) * 100
                total_return += ret
                
                if (signal > 0 and ret > 0) or (signal < 0 and ret < 0):
                    wins += 1
                else:
                    losses += 1
        
        wr = (wins / (wins + losses) * 100) if (wins + losses) > 0 else 0
        results['horizons'][filter_key] = {
            'trades': trades,
            'win_rate': round(wr, 1),
            'total_return': round(total_return, 2),
            'wins': wins,
            'losses': losses
        }
        
        print(f"  {filter_key}: {trades} trades, WR {wr:.1f}%, return {total_return:.2f}%", file=sys.stderr)
    
    return results

# ── Main ───────────────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--coin', default='BTC')
    parser.add_argument('--days', type=int, default=30)
    args = parser.parse_args()
    
    result = backtest_regime(args.coin, args.days)
    print(json.dumps(result, indent=2))
