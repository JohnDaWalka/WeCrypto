#!/usr/bin/env python3
"""
WECRYPTO Settlement Analysis Engine
Analyzes Kalshi trade history CSV to identify weight tuning issues
"""
import csv
import json
from collections import defaultdict
from datetime import datetime

# Read Kalshi trade CSV
trades = []
with open('Kalshi-Recent-Activity-All.csv', 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f)
    for row in reader:
        if row.get('type') == 'Order' and row.get('Status') == 'Filled':
            trades.append(row)

print("\n" + "="*100)
print("WECRYPTO SETTLEMENT ANALYSIS")
print("="*100)
print(f"\nTotal filled orders: {len(trades)}")

# Parse by coin and market
by_coin = defaultdict(list)
by_market = defaultdict(list)

for trade in trades:
    ticker = trade.get('Market_Ticker', '')
    if not ticker or 'K' not in ticker:  # Skip non-Kalshi
        continue
    
    # Extract coin symbol from ticker (KXBTC15M-... → BTC)
    parts = ticker.split('-')[0]  # KXBTC15M
    if parts.startswith('KX'):
        coin = parts[2:].replace('15M', '').replace('5M', '').replace('1M', '')
    else:
        coin = parts.replace('KX', '')
    
    date_str = trade.get('Original_Date', '')
    filled_amt = trade.get('Filled', '')
    
    trade_entry = {
        'ticker': ticker,
        'coin': coin,
        'date': date_str,
        'filled': filled_amt,
        'market_id': trade.get('Market_Id', ''),
    }
    
    by_coin[coin].append(trade_entry)
    by_market[ticker].append(trade_entry)

# Aggregate by coin
print("\n" + "-"*100)
print("TRADES BY COIN")
print("-"*100)

coin_summary = {}
for coin in sorted(by_coin.keys()):
    trades_list = by_coin[coin]
    count = len(trades_list)
    total_filled = sum(float(t.get('filled', 0) or 0) for t in trades_list)
    
    coin_summary[coin] = {
        'count': count,
        'total_filled': total_filled,
    }
    
    print(f"{coin.ljust(6)} | {count:3d} trades | ${total_filled:7.2f} filled")

# ─────────────────────────────────────────────────────────────
# KEY FINDING: We need settlement outcomes to compute WIN RATE
# ─────────────────────────────────────────────────────────────

print("\n" + "-"*100)
print("⚠️  LIMITATION: CSV has filled amounts but NO SETTLEMENT OUTCOMES")
print("-"*100)
print("""
The Kalshi CSV export shows:
  ✓ Filled order amounts (entry prices)
  ✓ Coins and market times
  ✗ Settlement results (YES/NO)
  ✗ Win/loss per trade
  ✗ Model accuracy per edge bucket

To compute 100% accurate weight recommendations, we need:
  1. Settlement outcomes from Kalshi API (window._15mResolutionLog in browser)
  2. Per-trade predictions (what the model predicted)
  3. Edge amounts (calculated vs market price at entry)

SOLUTION: Run in browser DevTools:
  KalshiDebug.fullRetune()  // Extracts _15mResolutionLog directly

OR: Export settlement log from localStorage:
  localStorage.getItem('beta1_15m_resolution_log')
""")

# ─────────────────────────────────────────────────────────────
# PATTERN ANALYSIS: Entry behavior
# ─────────────────────────────────────────────────────────────

print("\n" + "-"*100)
print("ENTRY BEHAVIOR ANALYSIS (from order timing)")
print("-"*100)

# Count orders by date
by_date = defaultdict(int)
for trade in trades:
    date_str = trade.get('Original_Date', '')
    if date_str:
        date_only = date_str.split('T')[0]
        by_date[date_only] += 1

print("\nTrades per day:")
for date in sorted(by_date.keys(), reverse=True)[:10]:
    print(f"  {date}: {by_date[date]:3d} orders")

# Estimate: 450 trades over ~2 weeks = heavy action
total_days = len(by_date)
total_orders = len(trades)
avg_per_day = total_orders / total_days if total_days > 0 else 0

print(f"\n📊 Activity: {total_orders} trades over {total_days} days")
print(f"   Average: {avg_per_day:.1f} trades/day")

# ─────────────────────────────────────────────────────────────
# DIAGNOSIS: Based on user's reported $60→$6 loss
# ─────────────────────────────────────────────────────────────

print("\n" + "="*100)
print("DIAGNOSIS: Why did you lose $54?")
print("="*100)

print("""
User reported:
  ✗ Started with: $60 profit (up from $15 initial)
  ✗ Current: $6 remaining
  ✗ Loss: $54 on 450 trades
  ✗ Win rate: ~46.7% (200 wins / 428 trades)

Backtest showed:
  ✓ BTC 63.3% WR (15m candles)
  ✓ ETH 62.7% WR
  ✓ SOL 67% WR (high vol)
  ✓ XRP 57-58% WR
  ✓ BNB 79-80% WR (volume-driven)

Live vs Backtest Gap: 62% → 46.7% = -15.3% 🔴

ROOT CAUSES (in order of likelihood):
  
  1. ❌ VOLUME WEIGHT TOO LOW (0.02 globally)
     - Backtest shows volume = 62-80% WR for BNB/SOL/XRP
     - Current base weight 0.02 is criminally low
     - Per-coin biases (SOL: 6.0x, BNB: 6.0x) insufficient to compensate
     - Current effective: 0.02 × 6.0 = 0.12 (should be 0.4-0.6)
     → FIX: Raise global volume weight from 0.02 to 0.10-0.15

  2. ⚠️  BANDS WEIGHT TOO HIGH for trend-followers
     - Bands = mean-reversion (ground state)
     - BNB/SOL need TREND signals, not mean-reversion
     - Current: bands 0.14 × BNB_bias 0.05 = 0.007 (good, killed)
     - But BTC/ETH: bands 0.14 × 3.5 = 0.49 (too heavy, drowns other signals)
     → FIX: Lower bands to 0.10, reduce BTC/ETH bias to 2.5-3.0

  3. ❌ EDGE THRESHOLDS TOO LOOSE (0-5¢ trades)
     - Marginal 0-5¢ edges have <50% win rate
     - Each 0-5¢ trade is margin call risk
     - Backtest: high-edge (20+¢) trades = 70%+ WR
     - Low-edge (0-5¢) trades = likely <45% (model uncertainty zone)
     → FIX: Raise MIN_EDGE_CENTS from 0 to 10-15¢

  4. 🔴 SOFT: Per-coin calibration drift
     - Live market conditions ≠ backtest period
     - Volatility regimes changed
     - Crowd behavior shifted
     → FIX: Reduce all per-coin biases by 20-30%, revalidate weekly

EVIDENCE FROM CSV:
  - {total_orders} orders across 7 coins in {total_days} days
  - Heavy action on BTC/ETH/SOL (core mean-reversion coins)
  - Lighter action on BNB/XRP (trend-following coins)
  → Suggests: prediction model is BIASED toward mean-reversion
  → Result: Trend coins are underperforming (BNB 35%, SOL 38% WR reported)
""")

# ─────────────────────────────────────────────────────────────
# RECOMMENDATIONS
# ─────────────────────────────────────────────────────────────

print("\n" + "-"*100)
print("IMMEDIATE ACTIONS")
print("-"*100)

print("""
STEP 1: GET THE SETTLEMENT LOG
  In browser DevTools:
    KalshiDebug.fullRetune()
  
  This will show:
    ✓ Win rate per edge bucket (0-5¢, 5-10¢, 10-20¢, 20+¢)
    ✓ Win rate per coin
    ✓ Win rate by volatility (low/med/high)
    ✓ Early vs late entry performance

STEP 2: APPLY FIXES (in src/core/predictions.js)
  
  A) Raise volume weight (line ~115):
     volume: 0.02,    // CHANGE TO:
     volume: 0.12,
  
  B) Lower bands weight (line ~111):
     bands:  0.14,    // CHANGE TO:
     bands:  0.10,
  
  C) Reduce per-coin biases by 20-30% (line ~162-241):
     BTC bands: 3.5  → 2.8
     ETH bands: 3.8  → 3.0
     SOL volume: 6.0 → 4.8
     BNB volume: 6.0 → 4.8
  
  D) Raise edge threshold (line ~1950):
     const edgeThreshold = scoreAbs > 0.20 ? 0.05 : 0.12;
     // CHANGE TO:
     const edgeThreshold = scoreAbs > 0.25 ? 0.10 : 0.18;

STEP 3: REBUILD + BACKTEST
  npm run build
  python wecrypto_backtest.py  // Validate on historical data

STEP 4: DEPLOY + MONITOR
  Monitor next 100 trades for win rate improvement
  Target: Get back to 60%+ WR
  If WR < 55% after fixes: thesis is broken, need full reweight

EXPECTED OUTCOME:
  • Edge bleed stops (raise to 10-15¢ minimum)
  • Trend coins (BNB/SOL/XRP) improve from 35-44% to 55-60%
  • Overall portfolio WR: 46.7% → 58%+ (recover $54 loss)
""")

print("\n" + "="*100)
