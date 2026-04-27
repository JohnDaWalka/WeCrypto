/**
 * Kalshi 15-Min Sustenance Filter
 * 
 * Filters out pump-and-dumps by detecting early reversals.
 * Only flags 15-min contracts where CFM divergence is SUSTAINED.
 * 
 * Logic:
 * 1. CFM shows price is X, Kalshi market is pricing Y (divergence)
 * 2. Monitor price movement for 5-7 minutes
 * 3. If price moves TOWARD CFM consistently = SUSTAINED signal
 * 4. If price REVERSES toward Kalshi = FALSE SIGNAL (pump-dump trap)
 * 5. Only execute if sustenance confirmed by min 7-8
 */

(function() {
  'use strict';

  window.KalshiSustenance = window.KalshiSustenance || {};

  /**
   * Sustenance State Machine
   * Tracks directional commitment over time
   */
  const SUSTENANCE_STATE = {
    INITIALIZING: 'init',        // Just started tracking
    SUSTAINED: 'sustained',      // Moving in predicted direction
    WEAKENING: 'weakening',      // Started reversing
    REVERSED: 'reversed',        // Confirmed reversal (REJECT)
    EXHAUSTED: 'exhausted'       // Move played out (CONFIRM)
  };

  /**
   * Per-contract sustenance tracker
   * key: marketId
   */
  const trackers = {};

  /**
   * Initialize sustenance watch for a contract
   * 
   * @param {string} marketId - Kalshi market ID
   * @param {number} cfmPrice - True price from CFM
   * @param {number} kalshiPrice - Market price (0-100)
   * @param {string} direction - 'YES' or 'NO' based on divergence
   * @param {number} edge - Divergence magnitude in cents
   * @returns {object} tracker state
   */
  function initTracker(marketId, cfmPrice, kalshiPrice, direction, edge) {
    const now = Date.now();
    
    trackers[marketId] = {
      marketId,
      cfmPrice,
      kalshiPrice,
      direction,
      edge,
      createdAt: now,
      
      // Price samples over time
      samples: [
        { t: now, price: kalshiPrice, state: SUSTENANCE_STATE.INITIALIZING }
      ],
      
      // Sustenance tracking
      state: SUSTENANCE_STATE.INITIALIZING,
      lastUpdate: now,
      directionConfirmedAt: null,
      reversalStartedAt: null,
      
      // Metrics
      maxPrice: kalshiPrice,
      minPrice: kalshiPrice,
      directionMoveCount: 0,  // samples moving toward CFM
      reversalMoveCount: 0,   // samples moving against CFM
      
      // Decision
      shouldExecute: null,
      rejectionReason: null
    };

    return trackers[marketId];
  }

  /**
   * Update tracker with new price sample
   * Called every 15-30 seconds
   * 
   * @param {string} marketId
   * @param {number} newPrice - Current market price
   * @param {number} elapsedSeconds - Seconds since contract opened
   * @returns {object} updated tracker
   */
  function updateSample(marketId, newPrice, elapsedSeconds) {
    const tracker = trackers[marketId];
    if (!tracker) return null;

    const now = Date.now();
    const prevSample = tracker.samples[tracker.samples.length - 1];
    const prevPrice = prevSample.price;

    // Determine if this sample moves toward or away from CFM
    const divergence = Math.abs(tracker.cfmPrice - tracker.kalshiPrice);
    const moveTowardCFM = 
      (tracker.direction === 'YES' && newPrice > prevPrice) ||
      (tracker.direction === 'NO' && newPrice < prevPrice);

    if (moveTowardCFM) {
      tracker.directionMoveCount++;
    } else {
      tracker.reversalMoveCount++;
    }

    // Update min/max
    tracker.maxPrice = Math.max(tracker.maxPrice, newPrice);
    tracker.minPrice = Math.min(tracker.minPrice, newPrice);

    // State machine
    let newState = tracker.state;

    if (tracker.state === SUSTENANCE_STATE.INITIALIZING) {
      // Need 2-3 samples moving in same direction to confirm
      const totalSamples = tracker.samples.length;
      if (totalSamples >= 3) {
        const recentMoves = tracker.directionMoveCount / totalSamples;
        if (recentMoves >= 0.66) {
          // 66%+ samples confirming direction
          newState = SUSTENANCE_STATE.SUSTAINED;
          tracker.directionConfirmedAt = now;
        } else if (recentMoves <= 0.33) {
          // 33%- samples confirming direction = early reversal
          newState = SUSTENANCE_STATE.REVERSED;
          tracker.rejectionReason = 'early_reversal';
          tracker.reversalStartedAt = now;
        }
      }
    } 
    else if (tracker.state === SUSTENANCE_STATE.SUSTAINED) {
      // Watch for reversal
      const recentMoves = tracker.directionMoveCount / (tracker.directionMoveCount + tracker.reversalMoveCount);
      
      if (recentMoves < 0.50) {
        // Lost majority support = reversal started
        newState = SUSTENANCE_STATE.WEAKENING;
        tracker.reversalStartedAt = now;
      }
      
      // Check if move has exhausted (reversal back to original price)
      const priceReturnRatio = Math.abs(newPrice - tracker.kalshiPrice) / divergence;
      if (priceReturnRatio < 0.10 && elapsedSeconds > 6) {
        // Price moved less than 10% of original divergence = exhausted
        newState = SUSTENANCE_STATE.EXHAUSTED;
      }
    }
    else if (tracker.state === SUSTENANCE_STATE.WEAKENING) {
      // Confirm reversal or recovery
      const timeSinceWeaken = (now - tracker.reversalStartedAt) / 1000;
      
      if (timeSinceWeaken > 60) {
        // Reversal sustained for 60+ seconds = confirmed
        newState = SUSTENANCE_STATE.REVERSED;
        tracker.rejectionReason = 'sustained_reversal';
      }
    }

    tracker.state = newState;
    tracker.lastUpdate = now;

    // Add sample
    tracker.samples.push({
      t: now,
      price: newPrice,
      state: newState,
      directionMoveCount: tracker.directionMoveCount,
      reversalMoveCount: tracker.reversalMoveCount
    });

    // Decision time (at min 7-8)
    if (elapsedSeconds >= 7 && tracker.shouldExecute === null) {
      if (newState === SUSTENANCE_STATE.SUSTAINED || newState === SUSTENANCE_STATE.EXHAUSTED) {
        tracker.shouldExecute = true;
      } else if (newState === SUSTENANCE_STATE.REVERSED || newState === SUSTENANCE_STATE.WEAKENING) {
        tracker.shouldExecute = false;
      }
    }

    return tracker;
  }

  /**
   * Get execution recommendation
   * 
   * @param {string} marketId
   * @param {number} elapsedSeconds
   * @returns {object} { shouldTrade: bool, confidence: 0-100, reason: string }
   */
  function getRecommendation(marketId, elapsedSeconds) {
    const tracker = trackers[marketId];
    if (!tracker) {
      return {
        shouldTrade: false,
        confidence: 0,
        reason: 'no_tracker'
      };
    }

    // Not enough data yet
    if (elapsedSeconds < 3) {
      return {
        shouldTrade: null,  // PENDING
        confidence: 0,
        reason: 'collecting_samples',
        elapsedSeconds,
        state: tracker.state
      };
    }

    // Decision made
    if (tracker.shouldExecute !== null) {
      if (tracker.shouldExecute) {
        const confidence = Math.round(
          (tracker.directionMoveCount / (tracker.directionMoveCount + tracker.reversalMoveCount + 0.1)) * 100
        );
        return {
          shouldTrade: true,
          confidence,
          reason: 'sustenance_confirmed',
          state: tracker.state,
          edge: tracker.edge,
          directionMoveCount: tracker.directionMoveCount,
          reversalMoveCount: tracker.reversalMoveCount
        };
      } else {
        return {
          shouldTrade: false,
          confidence: 0,
          reason: tracker.rejectionReason || 'no_sustenance',
          state: tracker.state,
          reversalMoveCount: tracker.reversalMoveCount
        };
      }
    }

    // Still collecting data
    return {
      shouldTrade: null,
      confidence: 0,
      reason: 'awaiting_confirmation',
      elapsedSeconds,
      state: tracker.state,
      directionMoveCount: tracker.directionMoveCount,
      reversalMoveCount: tracker.reversalMoveCount
    };
  }

  /**
   * Clean up expired trackers (contract expired or rejected)
   */
  function cleanup(marketId) {
    if (trackers[marketId]) {
      delete trackers[marketId];
    }
  }

  /**
   * Get all active trackers (for UI diagnostics)
   */
  function getAllTrackers() {
    return trackers;
  }

  // Export API
  window.KalshiSustenance = {
    initTracker,
    updateSample,
    getRecommendation,
    cleanup,
    getAllTrackers,
    SUSTENANCE_STATE
  };

  console.log('[KalshiSustenance] Loaded — reversal detection active');
})();
