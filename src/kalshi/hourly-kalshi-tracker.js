// hourly-kalshi-tracker.js v1.0
// ════════════════════════════════════════════════════════════════════════════════
// Kalshi Hourly Resolution Tracker
// 
// Tracks hourly UP/DOWN contract outcomes to compute edge statistics:
//   - Hourly win rates per coin
//   - Average odds vs outcomes (calibration)
//   - Edge realized (4% bets that paid out $10.45)
//   - Smart money drift (Kalshi movement ahead of settlement)
//
// Exposes window.HourlyKalshiTracker:
//   .recordOutcome(sym, closeTimeMs, kalshiYesPrice, outcome)
//   .getStats(sym)  — { totalBets, wonBets, wr%, avgOdds, edgeRealized, ... }
//   .getSeries(sym) — last 24 hourly outcomes
// ════════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────────
  // _outcomes[sym] = { 
  //   total: N, 
  //   outcomes: [ { ts, closeTimeMs, kalshiYes, outcome, edgeRealized, payout } ]
  // }
  const _outcomes = {};
  const MAX_HISTORY = 24; // keep last 24 hourly outcomes per coin

  // ── Calibration data ─────────────────────────────────────────────────────────
  // Maps Kalshi YES odds to actual win rates from recent outcomes
  // Used to detect miscalibration (Kalshi systematically over/under-pricing)
  const _calibration = {};
  const CALIB_BUCKETS = [0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50]; // YES% ranges

  // Initialize calibration buckets for a coin
  function initCoinCalib(sym) {
    if (!_calibration[sym]) {
      _calibration[sym] = {};
      for (let i = 0; i < CALIB_BUCKETS.length; i++) {
        const lo = i === 0 ? 0 : CALIB_BUCKETS[i-1];
        const hi = CALIB_BUCKETS[i];
        const key = `${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}`;
        _calibration[sym][key] = { samples: 0, wins: 0, payouts: [], edges: [] };
      }
    }
  }

  // Find which bucket a Kalshi odds falls into
  function calibBucket(kalshiYes, sym) {
    initCoinCalib(sym);
    for (let i = 0; i < CALIB_BUCKETS.length; i++) {
      const hi = CALIB_BUCKETS[i];
      if (kalshiYes <= hi) {
        const lo = i === 0 ? 0 : CALIB_BUCKETS[i-1];
        const key = `${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}`;
        return key;
      }
    }
    return '50-100';
  }

  // Record a resolved hourly outcome
  function recordOutcome(sym, closeTimeMs, kalshiYesPrice, outcome) {
    if (!sym || closeTimeMs == null || kalshiYesPrice == null || outcome == null) return;

    if (!_outcomes[sym]) _outcomes[sym] = { total: 0, outcomes: [] };
    const entry = _outcomes[sym];

    // Compute edge realized
    // outcome: true = price went UP (YES won), false = price went DOWN (NO won)
    const betSide = outcome ? 'YES' : 'NO';
    const entryPrice = outcome ? kalshiYesPrice : (1 - kalshiYesPrice);
    const edgeRealized = outcome
      ? (kalshiYesPrice > 0.5 ? kalshiYesPrice - 0.5 : 0.5 - kalshiYesPrice)
      : ((1 - kalshiYesPrice) > 0.5 ? (1 - kalshiYesPrice) - 0.5 : 0.5 - (1 - kalshiYesPrice));
    const payout = entryPrice > 0 ? 1 / entryPrice : 0;

    const record = {
      ts: Date.now(),
      closeTimeMs,
      kalshiYes: parseFloat(kalshiYesPrice.toFixed(4)),
      outcome: betSide,
      edgeRealized: parseFloat(edgeRealized.toFixed(4)),
      payout: parseFloat(payout.toFixed(2)),
      entryPrice: parseFloat(entryPrice.toFixed(4)),
    };

    entry.outcomes.push(record);
    entry.total++;
    if (entry.outcomes.length > MAX_HISTORY) entry.outcomes.shift();

    // Update calibration bucket
    const bucket = calibBucket(kalshiYesPrice, sym);
    const calib = _calibration[sym][bucket];
    if (calib) {
      calib.samples++;
      if (outcome) calib.wins++;
      calib.payouts.push(record.payout);
      calib.edges.push(record.edgeRealized);
      if (calib.payouts.length > 50) calib.payouts.shift();
      if (calib.edges.length > 50) calib.edges.shift();
    }

    // Log to data logger if available
    if (typeof window.DataLogger !== 'undefined' && window.DataLogger.logOutcome) {
      window.DataLogger.logOutcome(sym, record);
    }
  }

  // Get statistics for a coin
  function getStats(sym) {
    if (!_outcomes[sym] || !_outcomes[sym].outcomes.length) {
      return {
        totalBets: 0,
        wonBets: 0,
        winRate: null,
        avgOdds: null,
        avgEdgeRealized: null,
        totalPayout: null,
        calibration: {},
      };
    }

    initCoinCalib(sym);
    const outcomes = _outcomes[sym].outcomes;
    const wonBets = outcomes.filter(o => o.outcome === 'YES').length;
    const totalBets = outcomes.length;
    const winRate = (wonBets / totalBets * 100).toFixed(1);
    const avgOdds = (outcomes.reduce((sum, o) => sum + o.kalshiYes, 0) / totalBets).toFixed(4);
    const avgEdgeRealized = (outcomes.reduce((sum, o) => sum + o.edgeRealized, 0) / totalBets).toFixed(4);
    const totalPayout = outcomes.reduce((sum, o) => sum + o.payout, 0).toFixed(2);

    // Calibration summary
    const calibSum = {};
    for (const [bucket, data] of Object.entries(_calibration[sym] || {})) {
      if (data.samples === 0) continue;
      const wr = (data.wins / data.samples * 100).toFixed(1);
      const avgPayout = (data.payouts.reduce((a, b) => a + b, 0) / data.payouts.length).toFixed(2);
      const avgEdge = (data.edges.reduce((a, b) => a + b, 0) / data.edges.length).toFixed(4);
      calibSum[bucket] = { samples: data.samples, wr, avgPayout, avgEdge };
    }

    return {
      totalBets,
      wonBets,
      winRate: parseFloat(winRate),
      avgOdds: parseFloat(avgOdds),
      avgEdgeRealized: parseFloat(avgEdgeRealized),
      totalPayout: parseFloat(totalPayout),
      calibration: calibSum,
      series: outcomes.slice(-12), // last 12
    };
  }

  // Get recent outcomes (last N)
  function getSeries(sym, limit = 24) {
    if (!_outcomes[sym]) return [];
    return _outcomes[sym].outcomes.slice(-limit);
  }

  // Example: record the user's 4% BTC bet that paid $10.45
  // This would be called after the hourly contract settles
  function example() {
    recordOutcome('BTC', Date.now(), 0.04, true);
    console.log('BTC Stats:', getStats('BTC'));
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.HourlyKalshiTracker = {
    recordOutcome,
    getStats,
    getSeries,
    _outcomes,     // debug only
    _calibration,  // debug only
  };

  console.log('[HourlyKalshiTracker] Initialized — call recordOutcome(sym, ts, odds, won)');
})();
