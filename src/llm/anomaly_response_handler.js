/**
 * Anomaly Response Handler
 * 
 * Converts anomaly detector output into engine adjustments
 * Implements recovery strategies based on severity
 */

class AnomalyResponseHandler {
  constructor() {
    this.recoveryHistory = [];
    this.recoveryWindow = 3; // cycles of recovery
    this.inRecovery = false;
    this.recoveryCounter = 0;
  }

  /**
   * Handle anomaly and return recommended actions
   */
  handle(anomaly, currentWeights, currentGates) {
    if (!anomaly || !anomaly.anomaly) {
      return { adjusted: false, actions: [] };
    }

    const actions = [];
    const adjustedWeights = { ...currentWeights };
    const adjustedGates = { ...currentGates };

    console.log(`[AnomalyResponseHandler] Severity=${anomaly.severity}, Reason="${anomaly.reason}"`);

    // HIGH SEVERITY: Emergency reset
    if (anomaly.severity === "high") {
      console.warn("[AnomalyResponseHandler] ⚠️  HIGH SEVERITY - Initiating emergency recovery");
      
      actions.push({
        type: "emergency_reset",
        target: "all_weights",
        factor: 0.85,
        duration: 3,
        reason: anomaly.reason,
      });

      // Reduce all weights by 15% (conservative)
      Object.keys(adjustedWeights).forEach(k => {
        adjustedWeights[k] *= 0.85;
      });

      // Tighten all gates by 10%
      Object.keys(adjustedGates).forEach(coin => {
        if (adjustedGates[coin] && typeof adjustedGates[coin] === 'object') {
          adjustedGates[coin].minAbsScore *= 1.1; // higher threshold = stricter
        }
      });

      this.inRecovery = true;
      this.recoveryCounter = this.recoveryWindow;
    }
    // MEDIUM SEVERITY: Controlled reduction
    else if (anomaly.severity === "medium") {
      console.warn("[AnomalyResponseHandler] ⚠️  MEDIUM SEVERITY - Controlled reduction");
      
      actions.push({
        type: "controlled_reduction",
        target: anomaly.target || "all_weights",
        factor: 0.90,
        duration: 2,
        reason: anomaly.reason,
      });

      // Reduce all weights by 10%
      Object.keys(adjustedWeights).forEach(k => {
        adjustedWeights[k] *= 0.90;
      });

      // Slightly tighten gates
      Object.keys(adjustedGates).forEach(coin => {
        if (adjustedGates[coin] && typeof adjustedGates[coin] === 'object') {
          adjustedGates[coin].minAbsScore *= 1.05;
        }
      });

      this.inRecovery = true;
      this.recoveryCounter = 2;
    }
    // LOW SEVERITY: Monitor only
    else if (anomaly.severity === "low") {
      console.log("[AnomalyResponseHandler] ℹ️  LOW SEVERITY - Monitoring");
      
      actions.push({
        type: "monitor",
        target: anomaly.target || "specific_indicator",
        reason: anomaly.reason,
      });
    }

    // Normalize weights to sum to 1.0
    const weightSum = Object.values(adjustedWeights).reduce((a, b) => a + b, 0);
    if (weightSum > 0) {
      Object.keys(adjustedWeights).forEach(k => {
        adjustedWeights[k] = (adjustedWeights[k] / weightSum);
      });
    }

    // Log recovery event
    this.recoveryHistory.push({
      timestamp: Date.now(),
      severity: anomaly.severity,
      reason: anomaly.reason,
      actions,
      weightsAfter: adjustedWeights,
    });

    return {
      adjusted: actions.length > 0,
      actions,
      weightsAfter: adjustedWeights,
      gatesAfter: adjustedGates,
      inRecovery: this.inRecovery,
      recoveryTimeRemaining: this.recoveryCounter,
    };
  }

  /**
   * Tick recovery counter
   */
  tickRecovery() {
    if (this.inRecovery && this.recoveryCounter > 0) {
      this.recoveryCounter--;
      if (this.recoveryCounter === 0) {
        this.inRecovery = false;
        console.log("[AnomalyResponseHandler] Recovery complete, resuming normal operation");
      }
    }
  }

  /**
   * Get recovery status
   */
  getStatus() {
    return {
      inRecovery: this.inRecovery,
      recoveryTimeRemaining: this.recoveryCounter,
      totalAnomaliesHandled: this.recoveryHistory.length,
      lastAnomaly:
        this.recoveryHistory.length > 0
          ? this.recoveryHistory[this.recoveryHistory.length - 1]
          : null,
    };
  }

  /**
   * Get recovery history
   */
  getHistory(limit = 20) {
    return this.recoveryHistory.slice(-limit);
  }

  /**
   * Reset recovery state
   */
  reset() {
    this.inRecovery = false;
    this.recoveryCounter = 0;
  }
}

// ══════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════

module.exports = new AnomalyResponseHandler();

console.log("[AnomalyResponseHandler] Module loaded");
