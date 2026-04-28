// ================================================================
// Adaptive Walk-Forward Tuning Module
// Recalibrates signal gates every 15-minute candle close
// Uses: recent trade performance + volatility regime + Pyth validation
// ================================================================

class AdaptiveTuner {
  constructor() {
    // Recent trade history (last 100 per coin for tuning decisions)
    this.tradeHistory = {};

    // Tuning log for audit trail
    this.tuningLog = [];

    // Baseline thresholds — synced to SIGNAL_GATE_OVERRIDES (30-day walk-forward 2026-04-27).
    // Must be defined BEFORE currentGates so numeric init below works correctly.
    this.baselineGates = {
      BTC:  { minAbsScore: 0.36, label: 'calibrated' },
      ETH:  { minAbsScore: 0.40, label: 'calibrated' },
      XRP:  { minAbsScore: 0.36, label: 'calibrated' },
      SOL:  { minAbsScore: 0.44, label: 'calibrated' },
      BNB:  { minAbsScore: 0.55, label: 'near-blocked' },
      DOGE: { minAbsScore: 0.28, label: 'balanced' },
      HYPE: { minAbsScore: 0.20, label: 'moderate' },
    };

    // Bounds for adaptive adjustments — min/max now bracket the calibrated baseline,
    // not cap below it. All tuneBounds.max must be >= baselineGates.minAbsScore.
    this.tuneBounds = {
      BTC:  { min: 0.30, max: 0.44 },
      ETH:  { min: 0.34, max: 0.50 },
      XRP:  { min: 0.30, max: 0.44 },
      SOL:  { min: 0.38, max: 0.54 },
      BNB:  { min: 0.48, max: 0.65 },
      DOGE: { min: 0.24, max: 0.36 },
      HYPE: { min: 0.16, max: 0.28 },
    };

    // Current tuning parameters (per coin) — initialized as plain numeric thresholds
    // from baselineGates. Never copy SIGNAL_GATE_OVERRIDES directly here: those are
    // gate *objects* ({minAbsScore, minAgreement, ...}), not numbers, and would break
    // any numeric comparisons in evaluateSignalGate before the first tuning cycle runs.
    this.currentGates = {};
    const INIT_COINS = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
    for (const sym of INIT_COINS) {
      this.currentGates[sym] = this.baselineGates[sym].minAbsScore;
    }

    // Market regime tracking
    this.volatilityRegime = {};
    this.lastTuneTime = Date.now();

    console.log('[AdaptiveTuner] Initialized with baseline gates');
  }

  // ──────────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────────

  /**
   * Record a trade outcome for tuning analysis
   * @param {string} sym - Coin symbol (BTC, ETH, etc.)
   * @param {object} tradeData - { score, prediction, actual, correct, fprFlag }
   */
  recordTrade(sym, tradeData) {
    if (!this.tradeHistory[sym]) {
      this.tradeHistory[sym] = [];
    }
    
    this.tradeHistory[sym].push({
      timestamp: Date.now(),
      ...tradeData,
    });
    
    // Keep only last 100 trades per coin
    if (this.tradeHistory[sym].length > 100) {
      this.tradeHistory[sym] = this.tradeHistory[sym].slice(-100);
    }
  }

  /**
   * Compute current win rate for a coin
   * @param {string} sym - Coin symbol
   * @returns {object} { winRate, trades, correctCount, fprRate }
   */
  getPerformanceMetrics(sym) {
    const trades = this.tradeHistory[sym] || [];
    if (trades.length === 0) {
      return { winRate: 50, trades: 0, correctCount: 0, fprRate: 0 };
    }

    const correctCount = trades.filter(t => t.correct === true).length;
    const fprCount = trades.filter(t => t.fprFlag === true).length;
    const winRate = Math.round((correctCount / trades.length) * 100);
    const fprRate = Math.round((fprCount / Math.max(1, trades.length - correctCount)) * 100);

    return {
      winRate,
      trades: trades.length,
      correctCount,
      fprRate,
    };
  }

  /**
   * Get current volatility regime for a coin
   * @param {string} sym - Coin symbol
   * @returns {object} { regime, volatility, confidence }
   */
  getVolatilityRegime(sym) {
    // Placeholder: would integrate with real volatility calculation
    // For now, return cached or compute from recent prices
    if (this.volatilityRegime[sym]) {
      return this.volatilityRegime[sym];
    }

    // Default: assume moderate volatility
    return {
      regime: 'moderate',
      volatility: 0.5,
      confidence: 'low',
    };
  }

  /**
   * Recommend tuning adjustment for a coin
   * Based on: recent performance + volatility + false positive rate
   * @param {string} sym - Coin symbol
   * @returns {object} { action, newThreshold, reason, reason_codes }
   */
  recommendTuning(sym) {
    const perf = this.getPerformanceMetrics(sym);
    const vol = this.getVolatilityRegime(sym);
    const baseline = this.baselineGates[sym];
    const bounds = this.tuneBounds[sym];

    if (!baseline) {
      return { action: 'none', reason: 'Coin not in tuning list' };
    }

    let newThreshold = this.currentGates[sym] || baseline.minAbsScore;
    let action = 'none';
    const reasons = [];
    const reason_codes = [];

    // ── Rule 1: Low accuracy (< 40%) → Tighten (increase minAbsScore)
    if (perf.winRate < 40 && perf.trades >= 10) {
      const tighten = Math.min(newThreshold + 0.03, bounds.max);
      if (tighten > newThreshold) {
        newThreshold = tighten;
        action = 'tighten';
        reasons.push(`Low accuracy (${perf.winRate}% on ${perf.trades} trades)`);
        reason_codes.push('LOW_ACCURACY');
      }
    }

    // ── Rule 2: High accuracy (> 55%) → Relax (decrease minAbsScore)
    if (perf.winRate > 55 && perf.trades >= 15) {
      const relax = Math.max(newThreshold - 0.02, bounds.min);
      if (relax < newThreshold) {
        newThreshold = relax;
        action = 'relax';
        reasons.push(`High accuracy (${perf.winRate}% on ${perf.trades} trades)`);
        reason_codes.push('HIGH_ACCURACY');
      }
    }

    // ── Rule 3: High false positive rate (> 50%) → Tighten
    if (perf.fprRate > 50 && perf.trades >= 20) {
      const tighten = Math.min(newThreshold + 0.02, bounds.max);
      if (tighten > newThreshold) {
        newThreshold = tighten;
        action = action === 'relax' ? 'conflict' : 'tighten';
        reasons.push(`High FPR (${perf.fprRate}% false positives)`);
        reason_codes.push('HIGH_FPR');
      }
    }

    // ── Rule 4: High volatility → Tighten (be conservative)
    if (vol.volatility > 0.7 && vol.confidence !== 'low') {
      const tighten = Math.min(newThreshold + 0.02, bounds.max);
      if (tighten > newThreshold && !reasons.includes('High volatility')) {
        newThreshold = tighten;
        if (action === 'none') action = 'tighten';
        reasons.push(`High volatility regime (${(vol.volatility * 100).toFixed(1)}%)`);
        reason_codes.push('HIGH_VOLATILITY');
      }
    }

    return {
      action,
      currentThreshold: this.currentGates[sym] || baseline.minAbsScore,
      newThreshold: Math.round(newThreshold * 100) / 100,
      delta: Math.round((newThreshold - (this.currentGates[sym] || baseline.minAbsScore)) * 100) / 100,
      reason: reasons.join('; '),
      reason_codes,
      metrics: perf,
      volatilityRegime: vol,
    };
  }

  /**
   * Apply tuning adjustment to a coin (if recommendation approved)
   * @param {string} sym - Coin symbol
   * @param {object} recommendation - Output from recommendTuning()
   * @param {boolean} force - Force apply even if no recommendation
   */
  applyTuning(sym, recommendation, force = false) {
    if (!recommendation && !force) return;

    const newThreshold = recommendation.newThreshold || this.currentGates[sym];
    const oldThreshold = this.currentGates[sym] || this.baselineGates[sym]?.minAbsScore;

    if (newThreshold === oldThreshold && !force) {
      return;
    }

    this.currentGates[sym] = newThreshold;

    const event = {
      timestamp: Date.now(),
      coin: sym,
      action: recommendation?.action || 'force',
      oldThreshold: Math.round((oldThreshold || 0) * 100) / 100,
      newThreshold: Math.round(newThreshold * 100) / 100,
      reason: recommendation?.reason || 'Manual override',
      reason_codes: recommendation?.reason_codes || [],
    };

    this.tuningLog.push(event);
    console.log(
      `[AdaptiveTuner] ${sym}: ${event.oldThreshold} -> ${event.newThreshold} ` +
      `(${event.action}) — ${recommendation?.reason || 'forced'}`
    );

    return event;
  }

  /**
   * Get recommended entry delay based on volatility
   * High volatility = wait for confirmation before entering
   * @param {string} sym - Coin symbol
   * @returns {object} { delayCandles: 0-2, reason, volatilityReason }
   */
  getEntryDelay(sym) {
    const vol = this.getVolatilityRegime(sym);
    
    // No volatility data yet
    if (!vol || vol.confidence === 'low') {
      return { delayCandles: 0, reason: 'No volatility data yet', volatilityReason: null };
    }

    // High volatility → wait 2 candles for confirmation
    if (vol.volatility > 0.8) {
      return {
        delayCandles: 2,
        reason: 'High volatility: wait 2 candles for confirmation',
        volatilityReason: `vol=${(vol.volatility * 100).toFixed(1)}% (extreme)`,
      };
    }

    // Moderate-high volatility → wait 1 candle
    if (vol.volatility > 0.5) {
      return {
        delayCandles: 1,
        reason: 'Moderate volatility: wait 1 candle for confirmation',
        volatilityReason: `vol=${(vol.volatility * 100).toFixed(1)}% (high)`,
      };
    }

    // Low volatility → no delay needed
    return {
      delayCandles: 0,
      reason: 'Low volatility: enter immediately',
      volatilityReason: `vol=${(vol.volatility * 100).toFixed(1)}% (low)`,
    };
  }

  /**
   * Execute full tuning cycle (called every 15-minute candle close)
   * Analyzes all coins, recommends tunings, applies if confident
   * @param {object} options - { validatePyth: true, dryRun: false }
   * @returns {object} Tuning cycle results
   */
  async runTuningCycle(options = {}) {
    const { validatePyth = true, dryRun = false } = options;

    const cycleStartTime = Date.now();
    const results = {
      timestamp: cycleStartTime,
      cycleId: Math.random().toString(36).substr(2, 9),
      coins: [],
      totalAdjustments: 0,
      dryRun,
      validation: { pythChecked: false, valid: true },
    };

    // ── Validate Pyth feeds if enabled ──
    if (validatePyth) {
      try {
        results.validation.pythChecked = true;
        results.validation.valid = await this.validatePythFeeds();
        if (!results.validation.valid) {
          console.warn('[AdaptiveTuner] Pyth validation failed, skipping tuning cycle');
          return results;
        }
      } catch (err) {
        console.warn('[AdaptiveTuner] Pyth validation error:', err.message);
        results.validation.valid = false;
        return results;
      }
    }

    // ── Run recommendations for each coin ──
    const TUNING_COINS = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
    for (const sym of TUNING_COINS) {
      const rec = this.recommendTuning(sym);

      if (rec.action !== 'none') {
        const coinResult = {
          coin: sym,
          recommendation: rec,
          applied: false,
        };

        // Apply only if confident: action in ['tighten', 'relax'] and meets criteria
        if (!dryRun && (rec.action === 'tighten' || rec.action === 'relax')) {
          const event = this.applyTuning(sym, rec);
          coinResult.applied = true;
          results.totalAdjustments++;
        }

        results.coins.push(coinResult);
      }
    }

    this.lastTuneTime = Date.now();
    results.cycleTime = results.cycleTime = Date.now() - cycleStartTime;

    // Expose to window for debugging
    if (typeof window !== 'undefined') {
      window._tuningLog = window._tuningLog || [];
      window._tuningLog.push(results);
      window._currentGates = { ...this.currentGates };
    }

    console.log(
      `[AdaptiveTuner] Cycle complete: ${results.totalAdjustments} adjustments, ` +
      `${results.cycleTime}ms (dryRun=${dryRun})`
    );

    return results;
  }

  /**
   * Get current signal gates (for use in predictions.js)
   * Always returns a plain { SYM: number } map — never gate objects.
   * Defensive: if a value somehow ended up as an object (e.g. stale SIGNAL_GATE_OVERRIDES
   * entry), extracts minAbsScore so numeric comparisons never silently break.
   * @returns {object} { BTC: 0.36, ETH: 0.40, ... }
   */
  getCurrentGates() {
    const gates = {};
    for (const [sym, val] of Object.entries(this.currentGates)) {
      gates[sym] = typeof val === 'number'
        ? val
        : (val?.minAbsScore ?? this.baselineGates[sym]?.minAbsScore ?? 0.22);
    }
    return gates;
  }

  /**
   * Validate Pyth price feeds are fresh and reliable
   * @returns {boolean} True if all Pyth feeds are valid
   */
  async validatePythFeeds() {
    // Placeholder: would call Pyth Hermes API
    // For now, return true (assume valid if no errors)
    try {
      // Check if window.PYTH_HERMES_LAST_UPDATE is recent (< 60 seconds)
      if (typeof window !== 'undefined' && window.PYTH_HERMES_LAST_UPDATE) {
        const age = Date.now() - window.PYTH_HERMES_LAST_UPDATE;
        if (age > 60000) {
          console.warn('[AdaptiveTuner] Pyth feed is stale:', age, 'ms');
          return false;
        }
      }
      return true;
    } catch (err) {
      console.error('[AdaptiveTuner] Pyth validation error:', err);
      return false;
    }
  }

  /**
   * Reset tuning to baseline (for testing or recovery)
   * Covers all 7 tuning coins — DOGE and HYPE were previously missing.
   */
  resetToBaseline() {
    const TUNING_COINS = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
    for (const sym of TUNING_COINS) {
      this.currentGates[sym] = this.baselineGates[sym].minAbsScore;
    }
    console.log('[AdaptiveTuner] Reset to baseline thresholds');
  }

  /**
   * Get diagnostic info for debugging
   */
  getDiagnostics() {
    const TUNING_COINS = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
    const diagnostics = {
      currentGates: this.getCurrentGates(),
      baselineGates: this.baselineGates,
      tuneBounds: this.tuneBounds,
      metrics: {},
      entryDelays: {},
      lastTuneTime: new Date(this.lastTuneTime).toISOString(),
      tuningLogLength: this.tuningLog.length,
      recentTuningEvents: this.tuningLog.slice(-10),
    };

    for (const sym of TUNING_COINS) {
      diagnostics.metrics[sym] = {
        performance: this.getPerformanceMetrics(sym),
        volatility: this.getVolatilityRegime(sym),
        recommendation: this.recommendTuning(sym),
      };
      diagnostics.entryDelays[sym] = this.getEntryDelay(sym);
    }

    return diagnostics;
  }
}

// ══════════════════════════════════════════════════════════════
// Export for use in predictions.js and app.js
// ══════════════════════════════════════════════════════════════

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AdaptiveTuner;
}
