#!/usr/bin/env node
/**
 * backtest-runner-1m-rti.js
 * 
 * 1m RTI Polling Backtest Engine
 * - Fetches 1m candles (not 5m atomic)
 * - Aggregates into 5m/10m/15m using RTI (Real-Time Index) weighting
 * - Validates whether 1m RTI improves accuracy vs 5m candles
 * 
 * Problem: 5m candle close price doesn't represent market direction during intra-candle action
 * Solution: 1m polls with RTI weighting captures true market tendency
 * 
 * Expected improvement: HYPE/DOGE/BNB +20-25%, BTC/ETH/SOL more accurate
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  coins: ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'],
  horizons: [5, 10, 15],  // minutes
  lookbackDays: 7,  // Start with 7 days, then 120 days
  backtest15mOnly: true,  // Only test h15m horizon for speed
};

const COINS_DETAILS = {
  BTC: { pair: 'BTCUSDT', precision: 2 },
  ETH: { pair: 'ETHUSDT', precision: 2 },
  SOL: { pair: 'SOLUSDT', precision: 2 },
  XRP: { pair: 'XRPUSDT', precision: 4 },
  HYPE: { pair: 'HYPEUSDT', precision: 4 },
  DOGE: { pair: 'DOGEUSDT', precision: 6 },
  BNB: { pair: 'BNBUSDT', precision: 2 },
};

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Fetch 1m candles from Binance
 */
async function fetch1mCandles(pair, lookbackMs) {
  const baseUrl = 'https://api.binance.com/api/v3/klines';
  const limit = 1000;  // Binance max per request
  let allCandles = [];
  let endTime = Date.now();

  while (true) {
    try {
      const params = new URLSearchParams({
        symbol: pair,
        interval: '1m',
        endTime,
        limit,
      });

      const url = `${baseUrl}?${params.toString()}`;
      const response = await fetch(url, { timeout: 5000 });
      
      if (!response.ok) {
        console.error(`  ❌ Fetch failed for ${pair}: ${response.status}`);
        return null;
      }

      const candles = await response.json();
      if (!candles || candles.length === 0) break;

      allCandles.unshift(...candles);  // Prepend for chronological order
      endTime = candles[0][0] - 60000;  // Move back 1m

      if (candles[0][0] < Date.now() - lookbackMs) break;  // Got enough data
    } catch (e) {
      console.error(`  ❌ Error fetching ${pair}: ${e.message}`);
      return null;
    }
  }

  // Convert to standard format
  return allCandles.map(c => ({
    t: c[0],
    o: parseFloat(c[1]),
    h: parseFloat(c[2]),
    l: parseFloat(c[3]),
    c: parseFloat(c[4]),
    v: parseFloat(c[7]),
  }));
}

/**
 * RTI Aggregation: Weight recent bars higher
 * Formula: sum(close * weight) / sum(weights)
 * where weight = (i+1) / barsNeeded for bar i
 */
function aggregateRTI(candles1m) {
  const rtiBars = [];
  const barSize = 5;  // Aggregate to 5m

  for (let i = 0; i < candles1m.length; i += barSize) {
    const slice = candles1m.slice(i, i + barSize);
    if (slice.length === 0) continue;

    const barsNeeded = slice.length;
    const rtiClose = slice.reduce((s, c, j) => {
      const weight = (j + 1) / barsNeeded;
      return s + c.c * weight;
    }, 0) / (barsNeeded * (barsNeeded + 1) / 2);

    const rtiHigh = Math.max(...slice.map(c => c.h));
    const rtiLow = Math.min(...slice.map(c => c.l));

    rtiBars.push({
      t: slice[0].t,
      o: slice[0].o,
      h: rtiHigh,
      l: rtiLow,
      c: rtiClose,
      v: slice.reduce((s, c) => s + c.v, 0),
      rtiClose,  // Store for diagnostics
    });
  }

  return rtiBars;
}

/**
 * Simple prediction: UP if close > EMA(20), DOWN otherwise
 */
function predictDirection(candles, horizonMin) {
  if (!candles || candles.length < 25) return null;

  // EMA(20)
  let ema = candles[0].c;
  const alpha = 2 / 21;
  for (let i = 1; i < Math.min(20, candles.length); i++) {
    ema = candles[i].c * alpha + ema * (1 - alpha);
  }

  // Current close vs EMA
  const currentClose = candles[candles.length - 1].c;
  return currentClose > ema ? 1 : -1;  // 1=UP, -1=DOWN
}

/**
 * Simulate prediction at point in time
 */
function getHistoricalPrediction(candles, testIndex, lookbackBars = 50) {
  if (testIndex < lookbackBars) return null;
  const slice = candles.slice(testIndex - lookbackBars, testIndex);
  return predictDirection(slice, 15);
}

/**
 * Check if price reached/didn't reach contract level within horizon
 */
function checkContractResult(candles, testIndex, prediction, horizonBars) {
  if (testIndex + horizonBars >= candles.length) return null;

  const entryPrice = candles[testIndex].c;
  const futureCandles = candles.slice(testIndex + 1, testIndex + 1 + horizonBars);
  
  const high = Math.max(...futureCandles.map(c => c.h));
  const low = Math.min(...futureCandles.map(c => c.l));

  // Contracts: Does price reach 0.5% move in contract direction?
  const threshold = entryPrice * 0.005;
  const upHit = high >= entryPrice + threshold;
  const downHit = low <= entryPrice - threshold;

  if (prediction === 1) {
    // Predicted UP: success if upHit without downHit first
    return upHit && !downHit ? 1 : -1;
  } else {
    // Predicted DOWN: success if downHit without upHit first
    return downHit && !upHit ? 1 : -1;
  }
}

/**
 * Run backtest on candles
 */
function runBacktest(candles, horizonMin) {
  let correct = 0;
  let total = 0;

  const horizonBars = horizonMin;  // 1 bar = 5m in RTI aggregate
  const testStart = 100;  // Skip first 100 bars for data

  for (let i = testStart; i < candles.length - horizonBars; i += horizonMin) {
    const pred = getHistoricalPrediction(candles, i, 50);
    const result = checkContractResult(candles, i, pred, horizonBars);

    if (pred !== null && result !== null) {
      if (result === 1) correct++;
      total++;
    }
  }

  return total > 0 ? (correct / total * 100).toFixed(1) : null;
}

/**
 * Calculate profit factor (sum of winning trades / sum of losing trades)
 */
function calculateProfitFactor(candles, horizonMin) {
  let winSum = 0;
  let lossSum = 0;

  const horizonBars = horizonMin;
  const testStart = 100;

  for (let i = testStart; i < candles.length - horizonBars; i += horizonMin) {
    const pred = getHistoricalPrediction(candles, i, 50);
    const entryPrice = candles[i].c;
    const futureCandles = candles.slice(i + 1, i + 1 + horizonBars);
    
    const high = Math.max(...futureCandles.map(c => c.h));
    const low = Math.min(...futureCandles.map(c => c.l));

    if (pred === 1) {
      const gain = high - entryPrice;
      if (gain > entryPrice * 0.005) winSum += gain;
      else lossSum += Math.abs(low - entryPrice);
    } else {
      const gain = entryPrice - low;
      if (gain > entryPrice * 0.005) winSum += gain;
      else lossSum += Math.abs(high - entryPrice);
    }
  }

  return lossSum > 0 ? (winSum / lossSum).toFixed(2) : 'N/A';
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('🚀 1m RTI Polling Backtest Engine');
  console.log('================================\n');

  const lookbackMs = CONFIG.lookbackDays * 24 * 60 * 60 * 1000;
  const results = {};

  for (const coin of CONFIG.coins) {
    console.log(`📊 ${coin}...`);
    const { pair } = COINS_DETAILS[coin];

    // Fetch 1m candles
    const candles1m = await fetch1mCandles(pair, lookbackMs);
    if (!candles1m) {
      console.log(`  ❌ Failed to fetch 1m candles for ${coin}`);
      continue;
    }

    console.log(`  ✓ Fetched ${candles1m.length} 1m candles`);

    // Aggregate with RTI
    const candlesRTI = aggregateRTI(candles1m);
    console.log(`  ✓ Aggregated to ${candlesRTI.length} 5m RTI bars`);

    // Backtest each horizon
    results[coin] = {};
    for (const horizon of CONFIG.horizons) {
      if (CONFIG.backtest15mOnly && horizon !== 15) continue;
      
      const accuracy = runBacktest(candlesRTI, horizon);
      const pf = calculateProfitFactor(candlesRTI, horizon);
      
      results[coin][`h${horizon}m`] = {
        accuracy: accuracy ? parseFloat(accuracy) : null,
        profitFactor: pf,
      };
      
      console.log(`    h${horizon}m: ${accuracy || 'N/A'}% | PF=${pf}`);
    }
  }

  // Save results
  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, `backtest-1m-rti-${CONFIG.lookbackDays}d.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\n✅ Results saved to ${outFile}`);

  // Summary table
  console.log('\n📈 SUMMARY (1m RTI vs Expected)');
  console.log('================================');
  for (const coin of CONFIG.coins) {
    const acc = results[coin]?.h15m?.accuracy;
    console.log(`${coin.padEnd(6)} h15m: ${acc?.toFixed(1) || 'N/A'}%`);
  }
}

main().catch(console.error);
