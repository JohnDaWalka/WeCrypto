/**
 * Weight Applier — Smooth Stepping & Safe Application
 * 
 * Applies LLM target weights to current weights with:
 * - Smooth stepping (max 5% per cycle)
 * - Safety gates (never exceed min 0.5x, max 2.0x)
 * - Change tracking and logging
 * - Conflict detection and averaging
 */

const fs = require("fs");
const path = require("path");

class WeightApplier {
  constructor(logsDir = "logs/llm") {
    this.logsDir = logsDir;
    this.MAX_STEP_PER_CYCLE = 0.05; // 5%
    this.MIN_WEIGHT = 0.5; // 0.5x minimum
    this.MAX_WEIGHT = 2.0; // 2.0x maximum
    this.adjustmentHistory = {}; // coin -> array of adjustments

    // Ensure logs directory exists
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    console.log(
      `[WeightApplier] Initialized (max step: ${(this.MAX_STEP_PER_CYCLE * 100).toFixed(0)}%, min: ${this.MIN_WEIGHT}x, max: ${this.MAX_WEIGHT}x)`
    );
  }

  /**
   * Apply LLM target weights to current weights with smooth stepping
   * 
   * @param {Object} currentWeights - Current weights { indicator: value, ... }
   * @param {Object} targetWeights - LLM target weights { indicator: value, ... }
   * @param {Object} constraints - Optional { maxStep, minWeight, maxWeight }
   * @returns {Object} { updated, changed, deltas, metrics }
   */
  apply(currentWeights, targetWeights, constraints = {}) {
    const maxStep = constraints.maxStep || this.MAX_STEP_PER_CYCLE;
    const minWeight = constraints.minWeight || this.MIN_WEIGHT;
    const maxWeight = constraints.maxWeight || this.MAX_WEIGHT;

    // Input validation
    if (!currentWeights || typeof currentWeights !== "object") {
      return {
        updated: { ...currentWeights },
        changed: false,
        deltas: {},
        metrics: { error: "Invalid currentWeights" },
      };
    }

    if (!targetWeights || typeof targetWeights !== "object") {
      return {
        updated: { ...currentWeights },
        changed: false,
        deltas: {},
        metrics: { error: "Invalid targetWeights" },
      };
    }

    const updated = {};
    const deltas = {};
    let changed = false;

    // Process each indicator
    for (const indicator in currentWeights) {
      const current = currentWeights[indicator];
      const target = targetWeights[indicator] !== undefined ? targetWeights[indicator] : current;

      // Calculate step size (smooth approach)
      let step = Math.min(maxStep, Math.abs(target - current));
      const direction = target > current ? 1 : target < current ? -1 : 0;
      const stepped = current + step * direction;

      // Apply bounds
      const bounded = Math.max(minWeight, Math.min(maxWeight, stepped));

      updated[indicator] = bounded;
      deltas[indicator] = {
        current,
        target,
        stepped,
        bounded,
        applied: bounded,
        changePercent: ((bounded - current) / current) * 100,
      };

      if (bounded !== current) {
        changed = true;
      }
    }

    // Calculate metrics
    const metrics = this.calculateMetrics(currentWeights, updated);

    return {
      updated,
      changed,
      deltas,
      metrics,
    };
  }

  /**
   * Apply weights with conflict resolution (average multiple suggestions)
   * 
   * @param {Object} currentWeights - Current weights
   * @param {Array} targetWeightsList - Array of { weights, confidence } objects
   * @param {Object} constraints - Optional constraints
   * @returns {Object} { updated, changed, deltas, metrics, conflicts }
   */
  applyWithConflictResolution(currentWeights, targetWeightsList, constraints = {}) {
    if (!Array.isArray(targetWeightsList) || targetWeightsList.length === 0) {
      return this.apply(currentWeights, currentWeights, constraints);
    }

    // Average the target weights (weighted by confidence if available)
    const averaged = this.averageTargets(targetWeightsList);
    const result = this.apply(currentWeights, averaged.weights, constraints);

    return {
      ...result,
      conflicts: averaged.conflictCount,
      confidenceWeighted: averaged.weightedConfidence,
    };
  }

  /**
   * Record an adjustment to the log file
   * 
   * @param {string} coin - Coin symbol (BTC, ETH, etc)
   * @param {Object} before - Before weights
   * @param {Object} after - After weights
   * @param {string} reason - Reason for adjustment
   */
  recordAdjustment(coin, before, after, reason = "llm-adjustment") {
    const timestamp = new Date().toISOString();
    const adjustment = {
      timestamp,
      coin,
      reason,
      before,
      after,
      deltas: this.calculateDeltas(before, after),
    };

    // Initialize history for this coin if needed
    if (!this.adjustmentHistory[coin]) {
      this.adjustmentHistory[coin] = [];
    }
    this.adjustmentHistory[coin].push(adjustment);

    // Write to file
    const logPath = path.join(this.logsDir, `${coin}-adjustments.json`);
    let adjustments = [];

    try {
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf8");
        adjustments = JSON.parse(content);
      }
    } catch (err) {
      // Start fresh if file is corrupted
      adjustments = [];
    }

    adjustments.push(adjustment);
    fs.writeFileSync(logPath, JSON.stringify(adjustments, null, 2));

    console.log(
      `[WeightApplier] Recorded adjustment for ${coin}: ${reason}`
    );

    return adjustment;
  }

  /**
   * Get adjustment history for a coin
   * 
   * @param {string} coin - Coin symbol
   * @param {number} limit - Max records to return (default 100)
   * @returns {Array} Last N adjustments
   */
  getAdjustmentHistory(coin, limit = 100) {
    // Try memory first
    if (this.adjustmentHistory[coin]) {
      return this.adjustmentHistory[coin].slice(-limit);
    }

    // Try file
    const logPath = path.join(this.logsDir, `${coin}-adjustments.json`);
    if (fs.existsSync(logPath)) {
      try {
        const content = fs.readFileSync(logPath, "utf8");
        const adjustments = JSON.parse(content);
        this.adjustmentHistory[coin] = adjustments;
        return adjustments.slice(-limit);
      } catch (err) {
        console.error(`[WeightApplier] Failed to read history for ${coin}:`, err.message);
        return [];
      }
    }

    return [];
  }

  /**
   * Clear adjustment history for a coin (or all coins)
   * 
   * @param {string} coin - Coin symbol (or undefined for all)
   */
  clearHistory(coin) {
    if (coin) {
      delete this.adjustmentHistory[coin];
      const logPath = path.join(this.logsDir, `${coin}-adjustments.json`);
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
      console.log(`[WeightApplier] Cleared history for ${coin}`);
    } else {
      this.adjustmentHistory = {};
      // Clear all adjustment files
      if (fs.existsSync(this.logsDir)) {
        const files = fs.readdirSync(this.logsDir);
        files.forEach((file) => {
          if (file.endsWith("-adjustments.json")) {
            fs.unlinkSync(path.join(this.logsDir, file));
          }
        });
      }
      console.log(`[WeightApplier] Cleared all history`);
    }
  }

  /**
   * Get statistics about adjustments
   * 
   * @param {string} coin - Coin symbol (optional)
   * @returns {Object} Statistics
   */
  getStatistics(coin) {
    const history = coin
      ? this.getAdjustmentHistory(coin, 1000)
      : this.getAllAdjustments(1000);

    if (history.length === 0) {
      return {
        totalAdjustments: 0,
        avgChangePercent: 0,
        maxChangePercent: 0,
        minChangePercent: 0,
      };
    }

    const changePercents = [];
    for (const adj of history) {
      if (adj.deltas) {
        for (const indicator in adj.deltas) {
          changePercents.push(Math.abs(adj.deltas[indicator]));
        }
      }
    }

    return {
      totalAdjustments: history.length,
      indicatorAdjustments: changePercents.length,
      avgChangePercent: changePercents.length > 0
        ? (changePercents.reduce((a, b) => a + b, 0) / changePercents.length).toFixed(4)
        : 0,
      maxChangePercent: changePercents.length > 0
        ? Math.max(...changePercents).toFixed(4)
        : 0,
      minChangePercent: changePercents.length > 0
        ? Math.min(...changePercents).toFixed(4)
        : 0,
    };
  }

  /**
   * Helper: Calculate deltas between before and after
   */
  calculateDeltas(before, after) {
    const deltas = {};
    for (const key in before) {
      deltas[key] = ((after[key] - before[key]) / before[key]) * 100;
    }
    return deltas;
  }

  /**
   * Helper: Calculate metrics for the applied weights
   */
  calculateMetrics(before, after) {
    const totalChange = {};
    let totalChangePercent = 0;
    let changedCount = 0;

    for (const indicator in before) {
      const changePercent = ((after[indicator] - before[indicator]) / before[indicator]) * 100;
      totalChange[indicator] = changePercent;
      if (changePercent !== 0) {
        changedCount++;
        totalChangePercent += Math.abs(changePercent);
      }
    }

    return {
      indicatorsChanged: changedCount,
      totalIndicators: Object.keys(before).length,
      avgChangePercent: changedCount > 0
        ? (totalChangePercent / changedCount).toFixed(4)
        : 0,
      changes: totalChange,
    };
  }

  /**
   * Helper: Average multiple target weight suggestions
   */
  averageTargets(targetWeightsList) {
    const merged = {};
    let totalConfidence = 0;
    let conflictCount = 0;

    for (const item of targetWeightsList) {
      const weights = item.weights || item;
      const confidence = item.confidence || 1.0;

      for (const indicator in weights) {
        if (!merged[indicator]) {
          merged[indicator] = { sum: 0, count: 0, values: [] };
        }
        merged[indicator].sum += weights[indicator] * confidence;
        merged[indicator].count += confidence;
        merged[indicator].values.push(weights[indicator]);
        totalConfidence += confidence;
      }
    }

    // Detect conflicts (high variance in suggested weights)
    for (const indicator in merged) {
      const data = merged[indicator];
      if (data.values.length > 1) {
        const variance = this.calculateVariance(data.values);
        if (variance > 0.05) { // 5% variance threshold
          conflictCount++;
        }
      }
    }

    // Average the weights
    const averaged = {};
    for (const indicator in merged) {
      averaged[indicator] = merged[indicator].sum / merged[indicator].count;
    }

    return {
      weights: averaged,
      weightedConfidence: (totalConfidence / targetWeightsList.length).toFixed(4),
      conflictCount,
    };
  }

  /**
   * Helper: Calculate variance of values
   */
  calculateVariance(values) {
    if (values.length <= 1) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance) / mean; // normalized standard deviation
  }

  /**
   * Helper: Get all adjustments across all coins
   */
  getAllAdjustments(limit) {
    const all = [];
    for (const coin in this.adjustmentHistory) {
      all.push(...this.adjustmentHistory[coin]);
    }
    return all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
  }
}

// Export as CommonJS and ES6
const instance = new WeightApplier();

module.exports = instance;
module.exports.WeightApplier = WeightApplier;

// ES6 export fallback
if (typeof module.exports.default === "undefined") {
  module.exports.default = instance;
}
