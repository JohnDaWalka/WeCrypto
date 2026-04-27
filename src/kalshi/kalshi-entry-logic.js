/**
 * CFM Divergence + Sustenance Entry Logic
 * 
 * NEW FRAMEWORK (replaces ionization shells for 15-min contracts):
 * 
 * 1. CFM vs Kalshi comparison → detect mispricing (edge)
 * 2. Monitor for 7 minutes → confirm sustenance (not a pump-dump)
 * 3. Only execute 15-min contracts with SUSTAINED directional moves
 * 4. Exit early if reversal detected
 */

(function() {
  'use strict';

  window.KalshiEntryLogic = window.KalshiEntryLogic || {};

  /**
   * Entry Thresholds (based on edge magnitude, not volatility)
   * 
   * Edge = |CFM price - Kalshi odds|
   * Larger edge = more mispricing = higher confidence
   */
  const EDGE_THRESHOLDS = {
    MIN_EDGE_TO_WATCH: 0.02,      // 2¢ divergence needed to start tracking
    MIN_EDGE_TO_EXECUTE: 0.05,    // 5¢ divergence needed to trade
    
    // Confidence boosts based on edge size
    CONFIDENCE_TIERS: [
      { edge: 0.15, confidence: 0.90 },  // 15¢ edge = 90% confidence
      { edge: 0.10, confidence: 0.80 },  // 10¢ edge = 80% confidence
      { edge: 0.07, confidence: 0.70 },  // 7¢ edge = 70% confidence
      { edge: 0.05, confidence: 0.60 },  // 5¢ edge = 60% confidence
    ]
  };

  /**
   * Calculate directional signal from CFM vs Kalshi divergence
   * 
   * @param {object} cfmData - { price: number (0-100) }
   * @param {object} kalshiData - { odds: number (0-100) }
   * @returns {object} signal
   */
  function analyzeDivergence(cfmData, kalshiData) {
    const cfm = cfmData.price;      // 0-100 probability
    const kalshi = kalshiData.odds; // 0-100 probability
    
    const edge = Math.abs(cfm - kalshi) / 100; // Edge in cents (0-1.0)
    
    let direction = null;
    if (cfm > kalshi + 0.02) {
      // CFM thinks UP, market underpricing YES
      direction = 'YES';
    } else if (cfm < kalshi - 0.02) {
      // CFM thinks DOWN, market overpricing YES
      direction = 'NO';
    }
    
    return {
      cfm,
      kalshi,
      edge,
      direction,
      divergence: cfm - kalshi,
      shouldWatch: edge >= EDGE_THRESHOLDS.MIN_EDGE_TO_WATCH,
      shouldExecute: edge >= EDGE_THRESHOLDS.MIN_EDGE_TO_EXECUTE && direction !== null
    };
  }

  /**
   * Calculate confidence based on edge size
   */
  function getConfidenceFromEdge(edge) {
    for (const tier of EDGE_THRESHOLDS.CONFIDENCE_TIERS) {
      if (edge >= tier.edge) {
        return tier.confidence;
      }
    }
    return 0.50; // Minimum baseline
  }

  /**
   * Main entry decision: CFM + Sustenance filter
   * 
   * @param {object} signal - from analyzeDivergence()
   * @param {object} recommendation - from KalshiSustenance.getRecommendation()
   * @returns {object} decision
   */
  function makeEntryDecision(signal, recommendation) {
    // Reject if no divergence
    if (!signal.shouldExecute) {
      return {
        trade: false,
        reason: 'insufficient_edge',
        edge: signal.edge,
        required: EDGE_THRESHOLDS.MIN_EDGE_TO_EXECUTE
      };
    }

    // Reject if sustenance not confirmed
    if (recommendation.shouldTrade === false) {
      return {
        trade: false,
        reason: `reversal_detected: ${recommendation.reason}`,
        state: recommendation.state
      };
    }

    // PENDING — wait for sustenance confirmation (7+ min)
    if (recommendation.shouldTrade === null) {
      return {
        trade: null,  // PENDING
        reason: 'awaiting_sustenance_confirmation',
        elapsedSeconds: recommendation.elapsedSeconds,
        state: recommendation.state,
        directionMoveCount: recommendation.directionMoveCount,
        reversalMoveCount: recommendation.reversalMoveCount
      };
    }

    // EXECUTE — CFM edge + sustenance confirmed
    const confidence = getConfidenceFromEdge(signal.edge);
    return {
      trade: true,
      reason: 'cfm_divergence_sustained',
      direction: signal.direction,
      edge: signal.edge,
      baseConfidence: confidence,
      sustenanceConfidence: recommendation.confidence,
      finalConfidence: Math.round((confidence + recommendation.confidence) / 2),
      action: {
        direction: signal.direction,
        quantity: calculateQuantity(signal.edge),
        stopLoss: calculateStopLoss(signal),
        takeProfit: undefined // Let it ride to expiry
      }
    };
  }

  /**
   * Position sizing based on edge (not volatility)
   * 
   * Larger edge = higher confidence = larger position
   */
  function calculateQuantity(edge) {
    // Scale from 1-5 contracts based on edge
    // 5¢ edge = 1 contract
    // 15¢ edge = 5 contracts
    const contracts = Math.min(5, Math.max(1, Math.round(edge * 33)));
    return contracts;
  }

  /**
   * Stop-loss: exit if reversal confirmed
   */
  function calculateStopLoss(signal) {
    // Exit if Kalshi odds move more than 10¢ AGAINST us
    const reverseThreshold = signal.kalshi + (signal.direction === 'YES' ? -0.10 : 0.10);
    return {
      type: 'reversal',
      threshold: reverseThreshold,
      reason: 'if_price_reverses_10c'
    };
  }

  /**
   * Risk management: circuit breakers
   */
  const riskState = {
    reversalCount: 0,
    lastReversal: null,
    shouldPause: false,
    pauseUntil: null
  };

  function onReversalDetected() {
    riskState.reversalCount++;
    riskState.lastReversal = Date.now();

    // 3 reversals in 30 min = pause for 15 min
    const reversalsSince30min = (Date.now() - 30 * 60 * 1000);
    if (riskState.lastReversal > reversalsSince30min && riskState.reversalCount >= 3) {
      riskState.shouldPause = true;
      riskState.pauseUntil = Date.now() + 15 * 60 * 1000;
      console.warn('[KalshiEntry] 3 reversals detected — pausing for 15 min');
    }
  }

  function canTrade() {
    if (riskState.shouldPause && Date.now() < riskState.pauseUntil) {
      return false;
    }
    riskState.shouldPause = false;
    return true;
  }

  // Export API
  window.KalshiEntryLogic = {
    analyzeDivergence,
    getConfidenceFromEdge,
    makeEntryDecision,
    calculateQuantity,
    calculateStopLoss,
    onReversalDetected,
    canTrade,
    EDGE_THRESHOLDS,
    riskState
  };

  console.log('[KalshiEntryLogic] Loaded — CFM + Sustenance entry framework active');
})();
