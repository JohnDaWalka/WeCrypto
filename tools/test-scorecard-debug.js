#!/usr/bin/env node

/**
 * ================================================================
 * KALSHI SCORECARD DEBUG HARNESS
 * 
 * Tests and demonstrates:
 * 1. Settlement data fetching (all sources)
 * 2. Prediction correlation
 * 3. Error logging and diagnosis
 * 4. CSV export for Excel analysis
 * ================================================================
 */

const fs = require('fs');
const path = require('path');

// Simulate window and localStorage for Node.js environment
global.window = {
  _kalshiLog: [],
  _15mResolutionLog: [],
  _predictions: {},
  _lastPrediction: {},
  _errorLog: [],
  _backtest_results: {},
  _settledFetcher: null,
  _aggregator: null,
  _accuracyScorecard: null,
};

global.localStorage = {
  data: {},
  getItem(key) {
    return this.data[key] || null;
  },
  setItem(key, value) {
    this.data[key] = value;
  },
  removeItem(key) {
    delete this.data[key];
  },
  clear() {
    this.data = {};
  },
};

// Mock fetch for testing
async function mockFetch(url, options = {}) {
  console.log(`[MockFetch] ${url}`);

  // Simulate Kalshi API response
  if (url.includes('api.elections.kalshi.com')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        markets: [
          {
            ticker: 'KXBTC15M220430',
            status: 'settled',
            result: 'YES',
            strike_type: 'above',
            close_time: new Date(Date.now() - 3600000).toISOString(),
            created_at: new Date(Date.now() - 7200000).toISOString(),
            expires_at: new Date(Date.now() - 1800000).toISOString(),
            floor_price: 45000,
          },
          {
            ticker: 'KXETH15M220430',
            status: 'settled',
            result: 'NO',
            strike_type: 'above',
            close_time: new Date(Date.now() - 3000000).toISOString(),
            created_at: new Date(Date.now() - 6300000).toISOString(),
            expires_at: new Date(Date.now() - 1200000).toISOString(),
            floor_price: 2500,
          },
          {
            ticker: 'KXSOL15M220430',
            status: 'settled',
            result: 'YES',
            strike_type: 'above',
            close_time: new Date(Date.now() - 2700000).toISOString(),
            created_at: new Date(Date.now() - 5400000).toISOString(),
            expires_at: new Date(Date.now() - 900000).toISOString(),
            floor_price: 150,
          },
        ],
      }),
    };
  }

  // Polymarket
  if (url.includes('gamma-api.polymarket.com')) {
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 'pm-btc-1',
          title: 'Will BTC price go above $45000 by April 30?',
          closed_time: new Date(Date.now() - 3300000).toISOString(),
          outcomePrices: [0.65, 0.35],
        },
      ],
    };
  }

  // Default 404
  return {
    ok: false,
    status: 404,
    json: async () => ({}),
  };
}

global.fetch = mockFetch;

// Load modules
const ScorecardDataAggregator = require('../src/kalshi/scorecard-data-aggregator.js');
const ComprehensiveAccuracyScorecard = require('../src/kalshi/accuracy-scorecard-comprehensive.js');

async function runTests() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║        KALSHI SCORECARD DEBUG TEST HARNESS              ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Initialize
  window._aggregator = new ScorecardDataAggregator();
  window._accuracyScorecard = new ComprehensiveAccuracyScorecard();

  // TEST 1: Record predictions
  console.log('TEST 1: Recording predictions');
  console.log('─────────────────────────────────────────────────────────');

  window._aggregator.recordPrediction('BTC', 'UP', 75, { RSI: 62, MACD: 0.001 });
  window._aggregator.recordPrediction('ETH', 'DOWN', 55, { RSI: 48, MACD: -0.002 });
  window._aggregator.recordPrediction('SOL', 'UP', 82, { RSI: 72, MACD: 0.003 });

  console.log(`✅ Recorded ${window._aggregator.predictions.length} predictions\n`);

  // TEST 2: Record settlements
  console.log('TEST 2: Recording settlements');
  console.log('─────────────────────────────────────────────────────────');

  const settleTime1 = Date.now() + 1800000; // 30 min from now
  const settleTime2 = Date.now() + 1900000;
  const settleTime3 = Date.now() + 2000000;

  window._aggregator.recordSettlement('BTC', 'kalshi', 'UP', settleTime1);
  window._aggregator.recordSettlement('ETH', 'kalshi', 'UP', settleTime2);  // Opposite of prediction
  window._aggregator.recordSettlement('SOL', 'kalshi', 'UP', settleTime3);

  console.log(`✅ Recorded ${window._aggregator.settlements.length} settlements\n`);

  // TEST 3: Correlate data
  console.log('TEST 3: Correlating predictions with settlements');
  console.log('─────────────────────────────────────────────────────────');

  window._aggregator.correlateAllData();
  console.log(`✅ Correlated ${window._aggregator.correlations.length} pairs\n`);

  // TEST 4: Check accuracy
  console.log('TEST 4: Calculating accuracy');
  console.log('─────────────────────────────────────────────────────────');

  const accuracy = window._aggregator.getAccuracy();
  console.log(`Overall accuracy: ${accuracy.accuracy}% (${accuracy.correct}/${accuracy.total})`);

  for (const [coin, coinAcc] of Object.entries(accuracy.coins)) {
    console.log(`  ${coin}: ${coinAcc.accuracy}% (${coinAcc.correct}/${coinAcc.total})`);
  }
  console.log('');

  // TEST 5: Record errors
  console.log('TEST 5: Recording errors');
  console.log('─────────────────────────────────────────────────────────');

  window._aggregator.recordError('ETH', 'SIGNAL_INVERSION', 'Predicted DOWN but market went UP', {
    predictionId: window._aggregator.predictions[1].id,
  });
  window._aggregator.recordError('BTC', 'LOW_CONFIDENCE', 'Confidence was only 55%', {
    confidence: 55,
  });

  console.log(`✅ Recorded ${window._aggregator.errors.length} errors\n`);

  // TEST 6: Diagnose issues
  console.log('TEST 6: Diagnosing settlement data issues');
  console.log('─────────────────────────────────────────────────────────');

  const diagnosis = await window._aggregator.diagnoseSettlementData();
  console.log(`Issues: ${diagnosis.issues.length}`);
  diagnosis.issues.forEach(issue => console.log(`  - ${issue}`));
  console.log('');

  // TEST 7: Print comprehensive report
  console.log('TEST 7: Comprehensive status report');
  console.log('─────────────────────────────────────────────────────────');

  window._aggregator.printReport();

  // TEST 8: Fetch historical data
  console.log('TEST 8: Fetching historical settlement data');
  console.log('─────────────────────────────────────────────────────────');

  const historical = await window._accuracyScorecard.fetchAllKalshiSettled(10);
  console.log(`✅ Fetched ${historical.length} historical settled contracts\n`);

  // TEST 9: Build comprehensive scorecard
  console.log('TEST 9: Building comprehensive scorecard');
  console.log('─────────────────────────────────────────────────────────');

  // Set up mock data for scorecard
  window._predictions = {
    BTC: { direction: 'UP', prediction: 'UP', confidence: 75 },
    ETH: { direction: 'DOWN', prediction: 'DOWN', confidence: 55 },
    SOL: { direction: 'UP', prediction: 'UP', confidence: 82 },
  };
  window._lastPrediction = window._predictions;

  const scorecard = await window._accuracyScorecard.buildScorecard();
  console.log(`✅ Scorecard built with ${window._accuracyScorecard.stats.totalSettled} settled contracts\n`);

  // TEST 10: Export data
  console.log('TEST 10: Exporting data for analysis');
  console.log('─────────────────────────────────────────────────────────');

  const jsonExport = window._aggregator.exportJSON();
  const csvExport = window._aggregator.exportCSV();

  console.log(`JSON export size: ${Buffer.byteLength(JSON.stringify(jsonExport))} bytes`);
  console.log(`CSV export size: ${Buffer.byteLength(csvExport)} bytes`);

  // Write CSV to file for analysis
  const csvPath = path.join(__dirname, 'scorecard-export.csv');
  fs.writeFileSync(csvPath, csvExport);
  console.log(`✅ CSV exported to: ${csvPath}\n`);

  // TEST 11: Demonstrate console commands
  console.log('TEST 11: Available console commands (in browser)');
  console.log('─────────────────────────────────────────────────────────');

  console.log(`
Commands for browser console:

  1. View scorecard:
     window._aggregator.printReport()

  2. Get accuracy:
     window._aggregator.getAccuracy()

  3. Get recent errors:
     window._aggregator.getRecentErrors()

  4. Diagnose issues:
     await window._aggregator.diagnoseSettlementData()

  5. Build comprehensive scorecard:
     await window._accuracyScorecard.buildScorecard()

  6. Display scorecard:
     window._accuracyScorecard.displayScorecard('BTC')

  7. Run diagnostics:
     await window._accuracyScorecard.diagnose()

  8. Export to CSV:
     const csv = window._aggregator.exportCSV()
     navigator.clipboard.writeText(csv)

  9. Clear all data (for testing):
     window._aggregator.clear()

  10. Get diagnostics:
      window._accuracyScorecard.exportJSON()
`);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('✅ ALL TESTS COMPLETED SUCCESSFULLY\n');
}

// Run tests
runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
