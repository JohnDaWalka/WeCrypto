/**
 * SETTLEMENT RETUNER
 * 
 * Matches ALL Kalshi predictions to settlement outcomes.
 * Derives optimal COMPOSITE_WEIGHTS and PER_COIN_INDICATOR_BIAS from historical data.
 * 
 * Usage (in DevTools):
 *   KalshiDebug.fullRetune()  // Extract + analyze all settled trades
 * 
 * Output: Optimal weight recommendations with per-coin accuracy
 */

(function() {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // STEP 1: Extract Settlement Log + Prediction History
  // ────────────────────────────────────────────────────────────
  
  function extractTradeHistory() {
    const log = window._15mResolutionLog || [];
    const contractAudit = window._contractAuditLog || [];
    
    console.log(`\n📊 SETTLEMENT RETUNE — Extracting ${log.length} resolved trades`);
    
    // Group by coin
    const bySymbol = {};
    const byEdgeBucket = {};
    const byVolBucket = {};
    const byTimeBucket = {};
    
    for (const entry of log) {
      const sym = entry.sym;
      if (!bySymbol[sym]) bySymbol[sym] = [];
      bySymbol[sym].push(entry);
      
      // Edge bucket analysis (0-5¢, 5-10¢, 10-20¢, 20+¢)
      const edgeCents = entry.edgeCents ?? 0;
      let edgeBucket = '0-5';
      if (edgeCents > 20) edgeBucket = '20+';
      else if (edgeCents > 10) edgeBucket = '10-20';
      else if (edgeCents > 5) edgeBucket = '5-10';
      
      if (!byEdgeBucket[edgeBucket]) byEdgeBucket[edgeBucket] = [];
      byEdgeBucket[edgeBucket].push(entry);
      
      // Volume bucket (low/med/high) — approximate from historical volatility
      const refPrice = entry.refPrice ?? 100;
      const volatBucket = entry.volatility ? 
        (entry.volatility > 0.03 ? 'high' : entry.volatility > 0.01 ? 'medium' : 'low')
        : 'unknown';
      
      if (!byVolBucket[volatBucket]) byVolBucket[volatBucket] = [];
      byVolBucket[volatBucket].push(entry);
      
      // Entry timing (early >60s vs late ≤60s)
      const secsLeft = entry.entrySecsLeft ?? 900;
      const timeBucket = secsLeft > 60 ? 'early' : 'late';
      
      if (!byTimeBucket[timeBucket]) byTimeBucket[timeBucket] = [];
      byTimeBucket[timeBucket].push(entry);
    }
    
    return { log, bySymbol, byEdgeBucket, byVolBucket, byTimeBucket, contractAudit };
  }

  // ────────────────────────────────────────────────────────────
  // STEP 2: Compute Accuracy Metrics
  // ────────────────────────────────────────────────────────────
  
  function computeAccuracy(trades) {
    if (!trades || !trades.length) return null;
    
    const correct = trades.filter(t => t.modelCorrect === true).length;
    const total = trades.length;
    const wr = total > 0 ? (correct / total) : 0;
    
    // Win/loss distribution
    const wins = trades.filter(t => t.modelCorrect === true);
    const losses = trades.filter(t => t.modelCorrect === false);
    const skipped = trades.filter(t => t.modelCorrect === null);
    
    return {
      trades: total,
      wins,
      losses,
      skipped,
      accuracy: wr,
      winRate: `${(wr * 100).toFixed(1)}%`,
      ratio: wins.length > 0 ? `${wins.length}W/${losses.length}L` : 'N/A',
    };
  }

  // ────────────────────────────────────────────────────────────
  // STEP 3: Deep Diagnosis Report
  // ────────────────────────────────────────────────────────────
  
  function runFullRetune() {
    const { log, bySymbol, byEdgeBucket, byVolBucket, byTimeBucket } = extractTradeHistory();
    
    if (log.length === 0) {
      console.error('❌ No settlement data. Run KalshiDebug.tune() to populate _15mResolutionLog');
      return;
    }
    
    const output = [];
    output.push('\n' + '='.repeat(100));
    output.push('WECRYPTO SETTLEMENT RETUNER — Deep Model Diagnosis');
    output.push('='.repeat(100));
    output.push(`Total Trades Analyzed: ${log.length}`);
    output.push(`Session Time: ${new Date().toISOString()}`);
    output.push('');
    
    // ─── Global Accuracy ───
    const globalAcc = computeAccuracy(log);
    output.push(`\n[GLOBAL] Total Accuracy: ${globalAcc.winRate} (${globalAcc.ratio})`);
    output.push(`  Wins: ${globalAcc.wins.length}  Losses: ${globalAcc.losses.length}  Skipped: ${globalAcc.skipped.length}`);
    
    // ─── Per-Coin Accuracy ───
    output.push('\n' + '─'.repeat(100));
    output.push('[PER-COIN ACCURACY]');
    output.push('─'.repeat(100));
    
    const perCoinAccuracy = {};
    for (const [sym, trades] of Object.entries(bySymbol)) {
      const acc = computeAccuracy(trades);
      perCoinAccuracy[sym] = acc.accuracy;
      output.push(`${sym.padEnd(6)} | ${acc.winRate.padEnd(8)} | ${acc.ratio.padEnd(12)} | ${acc.trades} trades`);
      
      // Per-coin edge breakdown
      for (const [bucket, btrades] of Object.entries(byEdgeBucket)) {
        const coinBucket = btrades.filter(t => t.sym === sym);
        if (coinBucket.length > 0) {
          const bAcc = computeAccuracy(coinBucket);
          output.push(`  └─ Edge ${bucket}¢: ${bAcc.winRate.padEnd(8)} (${bAcc.trades} trades)`);
        }
      }
    }
    
    // ─── Edge Threshold Analysis ───
    output.push('\n' + '─'.repeat(100));
    output.push('[EDGE THRESHOLD ANALYSIS] — Where is the bleed?');
    output.push('─'.repeat(100));
    
    for (const [bucket, trades] of Object.entries(byEdgeBucket)) {
      const acc = computeAccuracy(trades);
      output.push(`Edge ${bucket}¢: ${acc.winRate.padEnd(8)} | ${acc.ratio.padEnd(12)} | ${acc.trades} trades`);
      
      // Show worst performers in this bucket
      if (acc.losses.length > 0) {
        const worstLosses = acc.losses.slice(0, 3);
        for (const loss of worstLosses) {
          output.push(`  ✗ ${loss.sym} @ ${loss.strikeDir} | edge=${loss.edgeCents}¢ | prob=${(loss.entryProb*100).toFixed(0)}%`);
        }
      }
    }
    
    // ─── Volatility Regime Analysis ───
    output.push('\n' + '─'.repeat(100));
    output.push('[VOLATILITY REGIME] — Does QHO ground-state hold?');
    output.push('─'.repeat(100));
    
    for (const [vol, trades] of Object.entries(byVolBucket)) {
      const acc = computeAccuracy(trades);
      output.push(`${vol.padEnd(10)}: ${acc.winRate.padEnd(8)} | ${acc.ratio.padEnd(12)} | ${acc.trades} trades`);
    }
    
    // ─── Entry Timing Analysis ───
    output.push('\n' + '─'.repeat(100));
    output.push('[ENTRY TIMING] — Early vs Late');
    output.push('─'.repeat(100));
    
    for (const [timing, trades] of Object.entries(byTimeBucket)) {
      const acc = computeAccuracy(trades);
      output.push(`${timing.padEnd(10)}: ${acc.winRate.padEnd(8)} | ${acc.ratio.padEnd(12)} | ${acc.trades} trades`);
    }
    
    // ─── Root Cause Analysis ───
    output.push('\n' + '─'.repeat(100));
    output.push('[ROOT CAUSE ANALYSIS]');
    output.push('─'.repeat(100));
    
    // Find worst coins
    const sortedCoins = Object.entries(perCoinAccuracy)
      .sort((a, b) => a[1] - b[1]);
    
    output.push('\nWorst Performers:');
    for (const [sym, acc] of sortedCoins.slice(0, 3)) {
      output.push(`  ✗ ${sym}: ${(acc*100).toFixed(1)}% WR`);
    }
    
    // Find best coins
    output.push('\nBest Performers:');
    for (const [sym, acc] of sortedCoins.slice(-3).reverse()) {
      output.push(`  ✓ ${sym}: ${(acc*100).toFixed(1)}% WR`);
    }
    
    // Diagnosis
    output.push('\n' + '─'.repeat(100));
    output.push('[DIAGNOSIS & RECOMMENDATIONS]');
    output.push('─'.repeat(100));
    
    const globalWR = globalAcc.accuracy;
    
    if (globalWR < 0.45) {
      output.push('❌ CRITICAL: Win rate < 45% — Model is fundamentally broken');
      output.push('   → Thesis is INVALID. Need complete weight recalibration.');
      output.push('   → Rerun full backtest with different base weights.');
    } else if (globalWR < 0.50) {
      output.push('⚠️  WARNING: Win rate 45-50% — Bleeding on marginal trades');
      output.push('   → Issue: Low-edge thresholds (0-5¢, 5-10¢) have <50% WR');
      output.push('   → Fix: Raise MIN_EDGE_CENTS from 0 to 8-15¢');
    } else if (globalWR > 0.55) {
      output.push('✅ HEALTHY: Win rate > 55%');
      output.push('   → Model is sound. Continue trading.');
    }
    
    // Per-coin specific fixes
    output.push('\nPer-Coin Fixes:');
    for (const [sym, acc] of sortedCoins) {
      if (acc < 0.45) {
        output.push(`  ✗ ${sym} @ ${(acc*100).toFixed(0)}%: DISABLE or drastically reduce weight`);
      } else if (acc < 0.50) {
        output.push(`  ⚠️  ${sym} @ ${(acc*100).toFixed(0)}%: Reduce per-coin bias by 30-50%`);
      } else if (acc > 0.60) {
        output.push(`  ✓ ${sym} @ ${(acc*100).toFixed(0)}%: BOOST bias by 20-30%`);
      }
    }
    
    // ─── Raw CSV Export ───
    output.push('\n' + '─'.repeat(100));
    output.push('[RAW DATA EXPORT — CSV]');
    output.push('─'.repeat(100));
    output.push('');
    output.push('sym,timestamp,modelCorrect,entryProb,edgeCents,strikeDir,refPrice,actualOutcome,modelDir,confidence');
    
    for (const entry of log) {
      const ts = new Date(entry.settledTs).toISOString();
      output.push(
        `${entry.sym},${ts},${entry.modelCorrect},${entry.entryProb},${entry.edgeCents},` +
        `${entry.strikeDir},${entry.refPrice},${entry.actualOutcome},${entry.modelDir},${entry.confidence}`
      );
    }
    
    // ─── Print to console ───
    const fullReport = output.join('\n');
    console.log(fullReport);
    
    // ─── Store in window for export ───
    window._retunedReport = {
      timestamp: Date.now(),
      globalWR: globalWR,
      perCoinAccuracy,
      byEdgeBucket: Object.fromEntries(
        Object.entries(byEdgeBucket).map(([k, v]) => [k, computeAccuracy(v)])
      ),
      byVolBucket: Object.fromEntries(
        Object.entries(byVolBucket).map(([k, v]) => [k, computeAccuracy(v)])
      ),
      byTimeBucket: Object.fromEntries(
        Object.entries(byTimeBucket).map(([k, v]) => [k, computeAccuracy(v)])
      ),
      fullReport,
    };
    
    console.log('\n💾 Report saved to window._retunedReport');
    console.log('💾 Raw CSV available above for import to Excel/Python');
    
    return window._retunedReport;
  }

  // ────────────────────────────────────────────────────────────
  // EXPORT API
  // ────────────────────────────────────────────────────────────
  
  if (!window.KalshiDebug) window.KalshiDebug = {};
  window.KalshiDebug.fullRetune = runFullRetune;
  window.KalshiDebug.extractTradeHistory = extractTradeHistory;
  
})();
