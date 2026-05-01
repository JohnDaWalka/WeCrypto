/**
 * Anomaly Detector — Flag Engine State Anomalies
 * 
 * Detects and flags various anomalies in engine state:
 * - Weight imbalance
 * - Accuracy collapse
 * - Stuck weights
 * - High conflicts
 * - LLM misalignment
 * - Volatility spikes
 */

const fs = require("fs");
const path = require("path");

class AnomalyDetector {
  constructor(logsDir = "logs/llm") {
    this.logsDir = logsDir;
    this.anomalyHistory = {};
    this.thresholds = {
      weightImbalance: 2.0, // one weight > 2x others
      accuracyCollapseFraction: 0.1, // 10% drop in win rate
      stuckWeightsCycles: 10, // no changes in 10 cycles
      highConflictCount: 5, // >5 conflicts = confusion
      llmConfidenceThreshold: 0.7, // LLM confidence
      accuracyThreshold: 0.45, // baseline accuracy
      volatilitySpikeFraction: 0.3, // 30% increase in 1 cycle
    };

    // Ensure logs directory exists
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    console.log(
      "[AnomalyDetector] Initialized with default thresholds"
    );
  }

  /**
   * Main entry point: detect anomalies in engine state
   * 
   * @param {Object} engineState - Current engine state
   * @returns {Object} { anomalies, severity_score, recommendations }
   */
  detect(engineState) {
    if (!engineState || typeof engineState !== "object") {
      return {
        anomalies: [],
        severity_score: 0,
        recommendations: [],
        timestamp: new Date().toISOString(),
      };
    }

    const anomalies = [];
    const detected = {
      weightImbalance: this.checkWeightImbalance(engineState.weights),
      accuracyCollapse: this.checkAccuracyCollapse(engineState.recent_accuracy),
      stuckWeights: this.checkStuckWeights(engineState.weights, engineState.adjustment_history),
      highConflicts: this.checkHighConflicts(engineState.conflicts),
      llmMisalignment: this.checkLLMAlignment(engineState.llm_influence, engineState.recent_accuracy),
      volatilitySpike: this.checkVolatilitySpike(engineState.volatility, engineState.previous_volatility),
    };

    // Compile anomalies
    for (const check in detected) {
      if (detected[check]) {
        anomalies.push(detected[check]);
      }
    }

    // Calculate overall severity score
    const severity_score = this.calculateSeverity(anomalies);

    // Generate recommendations
    const recommendations = this.generateRecommendations(anomalies, engineState);

    const result = {
      anomalies,
      severity_score,
      recommendations,
      timestamp: new Date().toISOString(),
      coin: engineState.coin,
    };

    // Log if severity is high
    if (severity_score >= 70) {
      this.logAnomaly(result);
    }

    return result;
  }

  /**
   * Check for weight imbalance (one weight >> others)
   */
  checkWeightImbalance(weights) {
    if (!weights || typeof weights !== "object" || Object.keys(weights).length === 0) {
      return null;
    }

    const values = Object.values(weights);
    const maxWeight = Math.max(...values);
    const minWeight = Math.min(...values);
    const ratio = maxWeight / minWeight;

    if (ratio > this.thresholds.weightImbalance) {
      return {
        type: "weight_imbalance",
        severity: "medium",
        message: `Weight imbalance detected: max/min ratio = ${ratio.toFixed(2)}x (threshold: ${this.thresholds.weightImbalance}x)`,
        details: {
          max: maxWeight.toFixed(4),
          min: minWeight.toFixed(4),
          ratio: ratio.toFixed(2),
        },
      };
    }

    return null;
  }

  /**
   * Check for accuracy collapse (win rate dropped sharply)
   */
  checkAccuracyCollapse(recent_accuracy) {
    if (!recent_accuracy || typeof recent_accuracy !== "object") {
      return null;
    }

    const { current = 0.5, previous = 0.5, trend = 0 } = recent_accuracy;
    const drop = previous - current;
    const dropPercent = Math.abs(drop) / (previous || 0.5);

    if (dropPercent > this.thresholds.accuracyCollapseFraction && drop > 0) {
      return {
        type: "accuracy_collapse",
        severity: "high",
        message: `Accuracy collapsed: ${(previous * 100).toFixed(1)}% → ${(current * 100).toFixed(1)}% (drop: ${(dropPercent * 100).toFixed(1)}%)`,
        details: {
          previous: (previous * 100).toFixed(1),
          current: (current * 100).toFixed(1),
          dropPercent: (dropPercent * 100).toFixed(1),
          trend: trend.toFixed(4),
        },
      };
    }

    return null;
  }

  /**
   * Check for stuck weights (no changes despite low accuracy)
   */
  checkStuckWeights(weights, adjustment_history) {
    if (!adjustment_history || !Array.isArray(adjustment_history)) {
      return null;
    }

    if (adjustment_history.length === 0) {
      return null;
    }

    // Count how many recent adjustments happened
    const recentWindow = adjustment_history.slice(-this.thresholds.stuckWeightsCycles);
    const changedCycles = recentWindow.filter((adj) => adj && adj.changed).length;

    if (changedCycles === 0 && recentWindow.length >= this.thresholds.stuckWeightsCycles) {
      return {
        type: "stuck_weights",
        severity: "medium",
        message: `Weights stuck for ${recentWindow.length} cycles without adjustment`,
        details: {
          cyclesTookan: recentWindow.length,
          changedCycles,
          threshold: this.thresholds.stuckWeightsCycles,
        },
      };
    }

    return null;
  }

  /**
   * Check for high conflicts (regime confusion)
   */
  checkHighConflicts(conflicts) {
    if (!conflicts || !Array.isArray(conflicts)) {
      return null;
    }

    if (conflicts.length > this.thresholds.highConflictCount) {
      return {
        type: "high_conflicts",
        severity: "medium",
        message: `Too many indicator conflicts: ${conflicts.length} (threshold: ${this.thresholds.highConflictCount})`,
        details: {
          conflictCount: conflicts.length,
          conflicts: conflicts.slice(0, 5), // Show first 5
          threshold: this.thresholds.highConflictCount,
        },
      };
    }

    return null;
  }

  /**
   * Check for LLM misalignment (high confidence but low accuracy)
   */
  checkLLMAlignment(llm_influence, recent_accuracy) {
    if (!llm_influence || typeof llm_influence !== "object") {
      return null;
    }

    if (!recent_accuracy || typeof recent_accuracy !== "object") {
      return null;
    }

    const { confidence = 0, suggestions_applied = 0 } = llm_influence;
    const { current = 0.5 } = recent_accuracy;

    // Flag if LLM is confident but accuracy is low
    if (
      confidence >= this.thresholds.llmConfidenceThreshold &&
      current <= this.thresholds.accuracyThreshold
    ) {
      return {
        type: "llm_misalignment",
        severity: "high",
        message: `LLM confidence ${(confidence * 100).toFixed(0)}% but accuracy only ${(current * 100).toFixed(1)}%`,
        details: {
          llmConfidence: (confidence * 100).toFixed(1),
          accuracy: (current * 100).toFixed(1),
          suggestionsApplied: suggestions_applied,
        },
      };
    }

    return null;
  }

  /**
   * Check for volatility spike
   */
  checkVolatilitySpike(volatility, previous_volatility) {
    if (typeof volatility !== "number" || typeof previous_volatility !== "number") {
      return null;
    }

    if (previous_volatility === 0) {
      return null;
    }

    const increase = (volatility - previous_volatility) / previous_volatility;

    if (increase > this.thresholds.volatilitySpikeFraction) {
      return {
        type: "volatility_spike",
        severity: "low",
        message: `Volatility spike: ${(previous_volatility * 100).toFixed(2)}% → ${(volatility * 100).toFixed(2)}% (+${(increase * 100).toFixed(1)}%)`,
        details: {
          previous: (previous_volatility * 100).toFixed(2),
          current: (volatility * 100).toFixed(2),
          increase: (increase * 100).toFixed(1),
        },
      };
    }

    return null;
  }

  /**
   * Calculate overall severity score (0-100)
   */
  calculateSeverity(anomalies) {
    if (anomalies.length === 0) {
      return 0;
    }

    let score = 0;
    const severityWeights = {
      low: 10,
      medium: 35,
      high: 60,
    };

    for (const anomaly of anomalies) {
      score += severityWeights[anomaly.severity] || 0;
    }

    // Cap at 100
    return Math.min(100, score);
  }

  /**
   * Generate recommendations based on anomalies
   */
  generateRecommendations(anomalies, engineState) {
    const recommendations = [];

    for (const anomaly of anomalies) {
      switch (anomaly.type) {
        case "weight_imbalance":
          recommendations.push(
            "Consider rebalancing weights to be more uniform. High imbalance may indicate over-reliance on one indicator."
          );
          break;
        case "accuracy_collapse":
          recommendations.push(
            "Accuracy has dropped significantly. Review recent market conditions or re-calibrate indicator weights."
          );
          recommendations.push(
            "Check if market regime has changed (trend → chop or vice versa)."
          );
          break;
        case "stuck_weights":
          recommendations.push(
            "Weights haven't changed despite potentially poor performance. Consider manual tuning or increasing LLM influence."
          );
          break;
        case "high_conflicts":
          recommendations.push(
            "Multiple indicator conflicts suggest conflicting market signals. Consider increasing ADX threshold or adjusting LLM regime detection."
          );
          break;
        case "llm_misalignment":
          recommendations.push(
            "LLM is making confident suggestions but accuracy is low. Reduce LLM influence or review prompt quality."
          );
          break;
        case "volatility_spike":
          recommendations.push(
            "Volatility has spiked. Consider tightening stop losses or reducing position size temporarily."
          );
          break;
      }
    }

    return recommendations;
  }

  /**
   * Log anomaly to file
   */
  logAnomaly(result) {
    const coin = result.coin || "UNKNOWN";
    const logPath = path.join(this.logsDir, `${coin}-anomalies.json`);

    let history = [];
    try {
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf8");
        history = JSON.parse(content);
      }
    } catch (err) {
      // Start fresh
      history = [];
    }

    history.push(result);
    fs.writeFileSync(logPath, JSON.stringify(history, null, 2));

    console.log(
      `[AnomalyDetector] Logged anomalies for ${coin} (severity: ${result.severity_score})`
    );
  }

  /**
   * Get anomaly history for a coin
   */
  getAnomalyHistory(coin, limit = 100) {
    const logPath = path.join(this.logsDir, `${coin}-anomalies.json`);
    if (!fs.existsSync(logPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(logPath, "utf8");
      const history = JSON.parse(content);
      return history.slice(-limit);
    } catch (err) {
      console.error(`[AnomalyDetector] Failed to read anomalies for ${coin}:`, err.message);
      return [];
    }
  }

  /**
   * Get anomaly statistics
   */
  getStatistics(coin) {
    const history = this.getAnomalyHistory(coin, 1000);

    if (history.length === 0) {
      return {
        totalAnomalies: 0,
        anomalyTypes: {},
        avgSeverity: 0,
      };
    }

    const types = {};
    let totalSeverity = 0;

    for (const record of history) {
      totalSeverity += record.severity_score;
      for (const anomaly of record.anomalies) {
        types[anomaly.type] = (types[anomaly.type] || 0) + 1;
      }
    }

    return {
      totalRecords: history.length,
      anomalyCount: Object.values(types).reduce((a, b) => a + b, 0),
      anomalyTypes: types,
      avgSeverity: (totalSeverity / history.length).toFixed(2),
      maxSeverity: Math.max(...history.map((h) => h.severity_score)),
    };
  }

  /**
   * Update thresholds
   */
  setThreshold(key, value) {
    if (key in this.thresholds) {
      this.thresholds[key] = value;
      console.log(`[AnomalyDetector] Updated threshold ${key} = ${value}`);
    }
  }

  /**
   * Get current thresholds
   */
  getThresholds() {
    return { ...this.thresholds };
  }

  /**
   * Clear anomaly history
   */
  clearHistory(coin) {
    if (coin) {
      const logPath = path.join(this.logsDir, `${coin}-anomalies.json`);
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
      console.log(`[AnomalyDetector] Cleared anomaly history for ${coin}`);
    } else {
      if (fs.existsSync(this.logsDir)) {
        const files = fs.readdirSync(this.logsDir);
        files.forEach((file) => {
          if (file.endsWith("-anomalies.json")) {
            fs.unlinkSync(path.join(this.logsDir, file));
          }
        });
      }
      console.log(`[AnomalyDetector] Cleared all anomaly history`);
    }
  }
}

// Export as CommonJS and ES6
const instance = new AnomalyDetector();

module.exports = instance;
module.exports.AnomalyDetector = AnomalyDetector;

// ES6 export fallback
if (typeof module.exports.default === "undefined") {
  module.exports.default = instance;
}
