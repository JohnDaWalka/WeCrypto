#!/usr/bin/env node
// backtest-runner.js
// ════════════════════════════════════════════════════════════════════════════
// Direct backtest runner - analyzes current cache vs Kalshi historical data
// Run: node backtest-runner.js
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

class SimpleBacktestRunner {
  constructor() {
    this.cacheFile = path.join(process.env.LOCALAPPDATA || process.env.HOME, 'WE-CRYPTO-CACHE', 'contract-cache-2h.json');
    this.results = {
      status: 'initializing',
      timestamp: new Date().toISOString(),
      cacheLoaded: false,
      predictions: [],
      settlements: [],
      correlations: [],
      accuracy: {
        overall: 0,
        byCoins: {},
        bySignals: {}
      },
      insights: []
    };
  }

  run() {
    console.log('\n' + '═'.repeat(80));
    console.log('🔄 2-DAY BACKTEST ANALYSIS (Node.js)');
    console.log('═'.repeat(80) + '\n');

    try {
      // Step 1: Load cache
      console.log('Step 1: Loading contract cache...');
      const cache = this.loadCache();
      if (!cache) {
        console.log('⚠️  Cache not found at:', this.cacheFile);
        console.log('    Run the app first to populate cache.\n');
        return;
      }
      console.log(`✓ Loaded ${cache.predictions?.length || 0} predictions\n`);

      // Step 2: Analyze predictions
      console.log('Step 2: Analyzing predictions...');
      const predictions = cache.predictions || [];
      console.log(`✓ Found ${predictions.length} predictions\n`);

      // Step 3: Analyze settlements
      console.log('Step 3: Analyzing settlements...');
      const settlements = cache.settlements || [];
      console.log(`✓ Found ${settlements.length} settlements\n`);

      // Step 4: Calculate accuracy
      console.log('Step 4: Calculating accuracy...');
      this.calculateAccuracy(predictions, settlements);
      console.log(`✓ Portfolio WR: ${(this.results.accuracy.overall * 100).toFixed(2)}%\n`);

      // Step 5: Generate insights
      console.log('Step 5: Generating insights...');
      this.generateInsights();
      console.log(`✓ Generated ${this.results.insights.length} insights\n`);

      // Step 6: Print report
      console.log('Step 6: Printing detailed report...\n');
      this.printReport();

      this.results.status = 'complete';
    } catch (e) {
      console.error('❌ Error:', e.message);
      this.results.status = 'error';
      this.results.error = e.message;
    }

    return this.results;
  }

  loadCache() {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return null;
      }
      const data = fs.readFileSync(this.cacheFile, 'utf8');
      const cache = JSON.parse(data);
      this.results.cacheLoaded = true;
      return cache;
    } catch (e) {
      console.error('Error loading cache:', e.message);
      return null;
    }
  }

  calculateAccuracy(predictions, settlements) {
    const byCoins = {};
    const bySignals = {};
    let totalCorrect = 0;
    let totalPredictions = 0;

    // Match predictions to settlements
    for (const pred of predictions) {
      const coin = pred.coin;
      if (!coin) continue;

      // Find matching settlement (same coin, within 1 hour)
      const settlement = settlements.find(s => 
        s.coin === coin && 
        Math.abs(s.timestamp - pred.timestamp) < 60 * 60 * 1000
      );

      if (settlement) {
        const correct = pred.direction === settlement.outcome;
        totalCorrect += correct ? 1 : 0;
        totalPredictions++;

        // Track by coin
        if (!byCoins[coin]) {
          byCoins[coin] = { correct: 0, total: 0, confidence: [] };
        }
        byCoins[coin].total++;
        if (correct) byCoins[coin].correct++;
        byCoins[coin].confidence.push(pred.confidence || 50);

        // Track by signal
        const signals = pred.signals || {};
        for (const [sig, val] of Object.entries(signals)) {
          if (!bySignals[sig]) {
            bySignals[sig] = { correct: 0, total: 0 };
          }
          bySignals[sig].total++;
          if (correct) bySignals[sig].correct++;
        }
      }
    }

    // Calculate percentages
    this.results.accuracy.overall = totalPredictions > 0 
      ? totalCorrect / totalPredictions 
      : 0;

    for (const coin in byCoins) {
      const stats = byCoins[coin];
      const accuracy = stats.total > 0 ? stats.correct / stats.total : 0;
      const avgConf = stats.confidence.length > 0 
        ? stats.confidence.reduce((a, b) => a + b) / stats.confidence.length 
        : 0;

      byCoins[coin].accuracy = accuracy;
      byCoins[coin].avgConfidence = avgConf;
    }

    for (const sig in bySignals) {
      const stats = bySignals[sig];
      bySignals[sig].accuracy = stats.total > 0 
        ? stats.correct / stats.total 
        : 0;
    }

    this.results.accuracy.byCoins = byCoins;
    this.results.accuracy.bySignals = bySignals;
    this.results.correlations = { matched: totalPredictions, total: predictions.length };
  }

  generateInsights() {
    const { byCoins, bySignals } = this.results.accuracy;
    const insights = [];

    // Analyze coin performance
    const coinEntries = Object.entries(byCoins);
    if (coinEntries.length > 0) {
      // Best performers
      const bestCoins = coinEntries
        .sort((a, b) => b[1].accuracy - a[1].accuracy)
        .slice(0, 2);
      
      for (const [coin, stats] of bestCoins) {
        if (stats.accuracy > 0.60) {
          insights.push({
            type: 'STRENGTH',
            coin,
            accuracy: (stats.accuracy * 100).toFixed(1),
            recommendation: `✅ ${coin} performing well at ${(stats.accuracy * 100).toFixed(1)}% - increase position size`
          });
        }
      }

      // Worst performers
      const worstCoins = coinEntries
        .sort((a, b) => a[1].accuracy - b[1].accuracy)
        .slice(0, 2);
      
      for (const [coin, stats] of worstCoins) {
        if (stats.accuracy < 0.50) {
          insights.push({
            type: 'WEAKNESS',
            coin,
            accuracy: (stats.accuracy * 100).toFixed(1),
            recommendation: `⚠️  ${coin} underperforming at ${(stats.accuracy * 100).toFixed(1)}% - reduce or disable`
          });
        }
      }
    }

    // Analyze signal performance
    const signalEntries = Object.entries(bySignals)
      .filter(([sig, stats]) => stats.total >= 3) // Only signals used 3+ times
      .sort((a, b) => b[1].accuracy - a[1].accuracy);

    // Top signals
    for (const [sig, stats] of signalEntries.slice(0, 3)) {
      if (stats.accuracy > 0.65) {
        insights.push({
          type: 'STRONG_SIGNAL',
          signal: sig,
          accuracy: (stats.accuracy * 100).toFixed(1),
          uses: stats.total,
          recommendation: `✅ ${sig} is a strong signal - increase weight`
        });
      }
    }

    // Weak signals
    for (const [sig, stats] of signalEntries.slice(-3)) {
      if (stats.accuracy < 0.45) {
        insights.push({
          type: 'WEAK_SIGNAL',
          signal: sig,
          accuracy: (stats.accuracy * 100).toFixed(1),
          uses: stats.total,
          recommendation: `⚠️  ${sig} is weak - reduce weight or disable`
        });
      }
    }

    this.results.insights = insights;
  }

  printReport() {
    const { overall, byCoins, bySignals } = this.results.accuracy;
    const { correlations, insights } = this.results;

    console.log('═'.repeat(80));
    console.log('📊 BACKTEST RESULTS');
    console.log('═'.repeat(80) + '\n');

    // Overall
    console.log('OVERALL PERFORMANCE');
    console.log('───────────────────');
    console.log(`Portfolio Win Rate:   ${(overall * 100).toFixed(2)}%`);
    console.log(`Matched Predictions:  ${correlations.matched}`);
    console.log(`Total in Cache:       ${correlations.total}`);
    console.log('');

    // By Coin
    if (Object.keys(byCoins).length > 0) {
      console.log('PER-COIN ACCURACY');
      console.log('─────────────────\n');
      
      Object.entries(byCoins)
        .sort((a, b) => b[1].accuracy - a[1].accuracy)
        .forEach(([coin, stats]) => {
          const acc = (stats.accuracy * 100).toFixed(1);
          const icon = stats.accuracy >= 0.55 ? '✅' : stats.accuracy >= 0.50 ? '➖' : '⚠️ ';
          console.log(`${icon} ${coin.padEnd(6)} ${acc}% (${stats.correct}/${stats.total}) avg conf: ${stats.avgConfidence.toFixed(0)}%`);
        });
      console.log('');
    }

    // By Signal
    if (Object.keys(bySignals).length > 0) {
      console.log('SIGNAL PERFORMANCE (TOP 5)');
      console.log('──────────────────────────\n');
      
      Object.entries(bySignals)
        .sort((a, b) => b[1].accuracy - a[1].accuracy)
        .slice(0, 5)
        .forEach(([sig, stats]) => {
          const acc = (stats.accuracy * 100).toFixed(1);
          const icon = stats.accuracy >= 0.60 ? '✅' : stats.accuracy >= 0.50 ? '➖' : '❌';
          console.log(`${icon} ${sig.padEnd(20)} ${acc}% (${stats.correct}/${stats.total})`);
        });
      console.log('');
    }

    // Insights
    if (insights.length > 0) {
      console.log('═'.repeat(80));
      console.log('💡 TUNING RECOMMENDATIONS');
      console.log('═'.repeat(80) + '\n');
      
      for (const insight of insights) {
        console.log(insight.recommendation);
      }
      console.log('');
    }

    console.log('═'.repeat(80));
    console.log(`Analysis Complete: ${new Date().toISOString()}`);
    console.log('═'.repeat(80) + '\n');
  }
}

// Run if executed directly
const runner = new SimpleBacktestRunner();
const results = runner.run();

// Output JSON for parsing
console.log('📁 Results saved to: backtest-results.json');
fs.writeFileSync('backtest-results.json', JSON.stringify(results, null, 2));

module.exports = SimpleBacktestRunner;
