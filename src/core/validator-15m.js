/**
 * 15-Minute Prediction Validator
 * 
 * Validates model accuracy using Pyth LAZER real-time prices
 * - Captures prediction + confidence at t=0
 * - Polls every 15s for early exit detection
 * - Scores at t=15m
 * - Calibrates confidence metrics
 */

(function () {
  'use strict';

  const VALIDATION_INTERVAL_MS = 15 * 60 * 1000;  // 15 minutes
  const POLL_INTERVAL_MS = 15 * 1000;              // Check every 15 seconds
  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  
  // Track active validations: sym → { prediction, confidence, entryPrice, startTime, outcome, timeToHit, logs[] }
  const VALIDATIONS = {};
  let validationId = 0;

  // ── Expose validation API ──────────────────────────────────────────
  window.Validator15m = {
    /**
     * Start a new 15m validation for a symbol
     * @param {string} sym - BTC, ETH, SOL, etc
     * @param {string} direction - 'UP' or 'DOWN'
     * @param {number} confidence - 0-100
     * @param {number} entryPrice - Entry price from Pyth
     */
    start(sym, direction, confidence, entryPrice) {
      if (!COINS.includes(sym)) {
        console.warn(`[Validator15m] Unknown coin: ${sym}`);
        return null;
      }

      const id = ++validationId;
      const key = `${sym}_${id}`;
      
      VALIDATIONS[key] = {
        id,
        sym,
        direction,
        confidence,
        entryPrice,
        startTime: Date.now(),
        outcome: null,      // 'HIT' | 'MISS' | 'CANCELLED'
        timeToHit: null,    // seconds
        highPrice: entryPrice,
        lowPrice: entryPrice,
        logs: [
          `[t=0] ${sym} ${direction} @ ${entryPrice.toFixed(2)} | confidence=${confidence}%`
        ]
      };

      console.info(`[Validator15m] Started #${id} ${sym} ${direction}`);
      
      // Emit event for UI
      window.dispatchEvent(new CustomEvent('validator-start', { 
        detail: VALIDATIONS[key] 
      }));

      return id;
    },

    /**
     * Get current state of validation
     */
    get(sym, id) {
      const key = `${sym}_${id}`;
      return VALIDATIONS[key] || null;
    },

    /**
     * Get all active validations
     */
    getAll() {
      return Object.values(VALIDATIONS);
    },

    /**
     * Get statistics: hit rate, confidence calibration
     */
    getStats() {
      const all = Object.values(VALIDATIONS).filter(v => v.outcome !== null);
      if (all.length === 0) return { total: 0, hitRate: 0, calibration: [] };

      const hitCount = all.filter(v => v.outcome === 'HIT').length;
      
      // Calibration: group by confidence bands and check actual hit rate
      const bands = {};
      for (const v of all) {
        const band = Math.floor(v.confidence / 10) * 10;  // 0-10, 10-20, ..., 90-100
        if (!bands[band]) bands[band] = { pred: 0, hits: 0 };
        bands[band].pred++;
        if (v.outcome === 'HIT') bands[band].hits++;
      }

      const calibration = Object.entries(bands).map(([band, data]) => ({
        confidenceBand: `${band}-${parseInt(band) + 10}%`,
        predictions: data.pred,
        hitRate: ((data.hits / data.pred) * 100).toFixed(1)
      }));

      return {
        total: all.length,
        hitRate: ((hitCount / all.length) * 100).toFixed(1),
        calibration
      };
    }
  };

  // ── Internal: price update handler ────────────────────────────────
  function handlePriceUpdate(sym, price) {
    const now = Date.now();
    
    // Check all active validations for this symbol
    for (const [key, v] of Object.entries(VALIDATIONS)) {
      if (v.sym !== sym || v.outcome !== null) continue;

      const elapsed = now - v.startTime;
      
      // Update high/low
      v.highPrice = Math.max(v.highPrice, price);
      v.lowPrice = Math.min(v.lowPrice, price);

      // Check for target hit
      const targetReached = (v.direction === 'UP' && price > v.entryPrice) || 
                           (v.direction === 'DOWN' && price < v.entryPrice);

      if (targetReached && v.outcome === null) {
        v.outcome = 'HIT';
        v.timeToHit = Math.round(elapsed / 1000);  // seconds
        v.logs.push(`[t=${v.timeToHit}s] TARGET HIT @ ${price.toFixed(2)}`);
        
        console.info(`[Validator15m] #${v.id} ${sym} HIT in ${v.timeToHit}s`);
        window.dispatchEvent(new CustomEvent('validator-hit', { detail: v }));
      }

      // Check if 15m elapsed
      if (elapsed >= VALIDATION_INTERVAL_MS && v.outcome === null) {
        v.outcome = v.outcome === null ? 'MISS' : v.outcome;
        v.logs.push(`[t=900s] TIMEOUT (15m) | Final: ${v.outcome}`);
        
        if (v.outcome === 'MISS') {
          console.warn(`[Validator15m] #${v.id} ${sym} MISS (15m timeout)`);
          window.dispatchEvent(new CustomEvent('validator-miss', { detail: v }));
        }
      }
    }
  }

  // ── Hook into Pyth price updates ───────────────────────────────
  if (window.PythLazer) {
    // Subscribe to Pyth price updates
    const origUpdate = window.PythLazer.onUpdate || function() {};
    window.PythLazer.onUpdate = function(prices) {
      origUpdate.call(this, prices);
      
      // Extract prices and pass to validator
      if (prices && typeof prices === 'object') {
        for (const [sym, data] of Object.entries(prices)) {
          if (data && data.price) {
            handlePriceUpdate(sym, data.price);
          }
        }
      }
    };
  }

  // ── Periodic calibration logging ───────────────────────────────
  let calibrationLogTimer = null;

  window.Validator15m.startLogging = function(intervalMs = 30000) {
    if (calibrationLogTimer) clearInterval(calibrationLogTimer);
    
    calibrationLogTimer = setInterval(() => {
      const stats = window.Validator15m.getStats();
      if (stats.total === 0) return;

      console.group('[Validator15m] Calibration Report');
      console.table({
        'Total Validations': stats.total,
        'Hit Rate': `${stats.hitRate}%`,
        'Timestamp': new Date().toLocaleTimeString()
      });
      
      if (stats.calibration.length > 0) {
        console.log('Confidence Band Calibration:');
        console.table(stats.calibration);
      }
      console.groupEnd();

      // Emit event for UI display
      window.dispatchEvent(new CustomEvent('validator-calibration', { detail: stats }));
    }, intervalMs);

    console.info(`[Validator15m] Calibration logging enabled every ${intervalMs}ms`);
  };

  window.Validator15m.stopLogging = function() {
    if (calibrationLogTimer) {
      clearInterval(calibrationLogTimer);
      calibrationLogTimer = null;
    }
  };
})();
