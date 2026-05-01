/**
 * Dashboard Metrics — Real-Time Metrics Aggregator
 * 
 * Provides comprehensive metrics for real-time dashboard:
 * - LLM influence score
 * - Regime distribution
 * - Suggestion acceptance rate
 * - Weight adjustment velocity
 * - Anomaly frequency
 * - Accuracy vs LLM confidence correlation
 */

const fs = require("fs");
const path = require("path");

class DashboardMetrics {
  constructor(logsDir = "logs/llm") {
    this.logsDir = logsDir;
    this.metrics = {};
    this.snapshots = {}; // Historical snapshots for trends

    // Ensure logs directory exists
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    console.log(
      "[DashboardMetrics] Initialized"
    );
  }

  /**
   * Aggregate all metrics for a given coin
   * 
   * @param {string} coin - Coin symbol (e.g., "BTC")
   * @param {number} windowSize - Number of recent cycles to consider (default 100)
   * @returns {Object} { metrics, trends, diagnostics }
   */
  aggregate(coin, windowSize = 100) {
    if (!coin) {
      return this.aggregateGlobal(windowSize);
    }

    const metrics = {
      coin,
      timestamp: new Date().toISOString(),
    };

    // Collect data from log files
    const adjustments = this.readAdjustmentLog(coin, windowSize);
    const anomalies = this.readAnomalyLog(coin, windowSize);
    const analyses = this.readAnalysisLog(coin, windowSize);

    // Calculate each metric
    metrics.llm_influence = this.calculateLLMInfluence(adjustments);
    metrics.regime_distribution = this.calculateRegimeDistribution(analyses);
    metrics.suggestion_acceptance = this.calculateSuggestionAcceptance(adjustments, analyses);
    metrics.weight_adjustment_velocity = this.calculateAdjustmentVelocity(adjustments);
    metrics.anomaly_frequency = this.calculateAnomalyFrequency(anomalies);
    metrics.accuracy_llm_correlation = this.calculateAccuracyCorrelation(analyses);

    // Generate trends
    const trends = this.calculateTrends(coin, adjustments, analyses, anomalies);

    // Generate diagnostics
    const diagnostics = this.generateDiagnostics(metrics, trends);

    // Store snapshot
    this.snapshots[coin] = { metrics, trends, diagnostics, timestamp: Date.now() };

    return { metrics, trends, diagnostics };
  }

  /**
   * Aggregate metrics across all coins
   */
  aggregateGlobal(windowSize = 100) {
    const coins = this.getActiveCoins();
    const allMetrics = {
      timestamp: new Date().toISOString(),
      coins: {},
    };

    let totalLLMInfluence = 0;
    let totalAnomalies = 0;
    let coinCount = 0;

    for (const coin of coins) {
      const result = this.aggregate(coin, windowSize);
      allMetrics.coins[coin] = result.metrics;
      totalLLMInfluence += result.metrics.llm_influence.influence_score || 0;
      totalAnomalies += result.metrics.anomaly_frequency.anomaly_count || 0;
      coinCount++;
    }

    // Global averages
    allMetrics.global = {
      avg_llm_influence: coinCount > 0
        ? (totalLLMInfluence / coinCount).toFixed(2)
        : 0,
      total_anomalies: totalAnomalies,
      active_coins: coinCount,
    };

    return allMetrics;
  }

  /**
   * Calculate LLM influence score
   * (% of cycles where LLM modified weights)
   */
  calculateLLMInfluence(adjustments) {
    if (adjustments.length === 0) {
      return {
        influence_score: 0,
        adjustments_made: 0,
        total_cycles: 0,
      };
    }

    const adjustmentsMade = adjustments.filter((a) => a.reason === "llm-adjustment").length;

    return {
      influence_score: ((adjustmentsMade / adjustments.length) * 100).toFixed(2),
      adjustments_made: adjustmentsMade,
      total_cycles: adjustments.length,
    };
  }

  /**
   * Calculate regime distribution
   */
  calculateRegimeDistribution(analyses) {
    const distribution = {
      trend_continuation: 0,
      mean_reversion: 0,
      chop_noise: 0,
      breakout_volatility: 0,
      unknown: 0,
    };

    for (const analysis of analyses) {
      if (analysis.output && analysis.output.regime) {
        distribution[analysis.output.regime] = (distribution[analysis.output.regime] || 0) + 1;
      } else {
        distribution.unknown++;
      }
    }

    const total = analyses.length || 1;

    return {
      trend_continuation: ((distribution.trend_continuation / total) * 100).toFixed(1),
      mean_reversion: ((distribution.mean_reversion / total) * 100).toFixed(1),
      chop_noise: ((distribution.chop_noise / total) * 100).toFixed(1),
      breakout_volatility: ((distribution.breakout_volatility / total) * 100).toFixed(1),
      unknown: ((distribution.unknown / total) * 100).toFixed(1),
      raw_counts: distribution,
    };
  }

  /**
   * Calculate suggestion acceptance rate
   */
  calculateSuggestionAcceptance(adjustments, analyses) {
    const applied = adjustments.filter((a) => a.reason === "llm-adjustment").length;
    const total = analyses.length || 1;

    return {
      acceptance_rate: ((applied / total) * 100).toFixed(1),
      suggestions_applied: applied,
      total_suggestions: total,
    };
  }

  /**
   * Calculate weight adjustment velocity
   * (average magnitude of changes per cycle)
   */
  calculateAdjustmentVelocity(adjustments) {
    if (adjustments.length === 0) {
      return {
        avg_velocity: 0,
        max_velocity: 0,
        total_adjustments: 0,
      };
    }

    let totalVelocity = 0;
    let maxVelocity = 0;

    for (const adj of adjustments) {
      if (adj.deltas) {
        const magnitudes = Object.values(adj.deltas).map((d) => Math.abs(d));
        const avgMag = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
        totalVelocity += avgMag;
        maxVelocity = Math.max(maxVelocity, ...magnitudes);
      }
    }

    return {
      avg_velocity: (totalVelocity / adjustments.length).toFixed(4),
      max_velocity: maxVelocity.toFixed(4),
      total_adjustments: adjustments.length,
    };
  }

  /**
   * Calculate anomaly frequency
   */
  calculateAnomalyFrequency(anomalies) {
    if (anomalies.length === 0) {
      return {
        anomaly_count: 0,
        frequency_per_100_cycles: 0,
        anomaly_types: {},
      };
    }

    const types = {};
    let highSeverityCount = 0;

    for (const anomaly of anomalies) {
      if (anomaly.anomalies) {
        for (const a of anomaly.anomalies) {
          types[a.type] = (types[a.type] || 0) + 1;
          if (a.severity === "high") {
            highSeverityCount++;
          }
        }
      }
    }

    return {
      anomaly_count: anomalies.length,
      frequency_per_100_cycles: ((anomalies.length / 100) * 100).toFixed(1),
      high_severity_count: highSeverityCount,
      anomaly_types: types,
    };
  }

  /**
   * Calculate accuracy vs LLM confidence correlation
   */
  calculateAccuracyCorrelation(analyses) {
    if (analyses.length < 2) {
      return {
        correlation: 0,
        avg_confidence: 0,
        avg_accuracy: 0,
      };
    }

    const pairs = [];
    let totalConfidence = 0;
    let totalAccuracy = 0;

    for (const analysis of analyses) {
      if (
        analysis.output &&
        typeof analysis.output.confidence === "number" &&
        analysis.input &&
        typeof analysis.input.recentAccuracy?.winRate === "number"
      ) {
        pairs.push({
          confidence: analysis.output.confidence,
          accuracy: analysis.input.recentAccuracy.winRate,
        });
        totalConfidence += analysis.output.confidence;
        totalAccuracy += analysis.input.recentAccuracy.winRate;
      }
    }

    if (pairs.length < 2) {
      return {
        correlation: 0,
        avg_confidence: (totalConfidence / analyses.length).toFixed(2),
        avg_accuracy: (totalAccuracy / analyses.length).toFixed(2),
      };
    }

    // Calculate Pearson correlation
    const correlation = this.calculatePearson(pairs.map((p) => p.confidence), pairs.map((p) => p.accuracy));

    return {
      correlation: correlation.toFixed(4),
      avg_confidence: (totalConfidence / pairs.length).toFixed(4),
      avg_accuracy: (totalAccuracy / pairs.length).toFixed(4),
      data_points: pairs.length,
    };
  }

  /**
   * Calculate trends compared to previous snapshot
   */
  calculateTrends(coin, adjustments, analyses, anomalies) {
    const current = {
      llm_influence: this.calculateLLMInfluence(adjustments).influence_score,
      anomaly_count: anomalies.length,
      total_adjustments: adjustments.length,
    };

    const previous = this.snapshots[coin]?.metrics || null;

    if (!previous) {
      return {
        llm_influence_trend: "→",
        anomaly_trend: "→",
        adjustment_trend: "→",
      };
    }

    return {
      llm_influence_trend: this.compareTrend(
        parseFloat(current.llm_influence),
        parseFloat(previous.llm_influence.influence_score)
      ),
      llm_influence_change: (
        parseFloat(current.llm_influence) - parseFloat(previous.llm_influence.influence_score)
      ).toFixed(2),
      anomaly_trend: this.compareTrend(current.anomaly_count, previous.anomaly_frequency.anomaly_count),
      anomaly_change: current.anomaly_count - previous.anomaly_frequency.anomaly_count,
      adjustment_trend: this.compareTrend(current.total_adjustments, previous.weight_adjustment_velocity.total_adjustments),
      adjustment_change: current.total_adjustments - previous.weight_adjustment_velocity.total_adjustments,
    };
  }

  /**
   * Generate diagnostics and recommendations
   */
  generateDiagnostics(metrics, trends) {
    const diagnostics = {
      health_score: 0,
      warnings: [],
      recommendations: [],
    };

    // Calculate health score
    let healthScore = 100;

    // Deduct for high anomaly frequency
    if (parseFloat(metrics.anomaly_frequency.frequency_per_100_cycles) > 50) {
      healthScore -= 20;
      diagnostics.warnings.push("High anomaly frequency detected");
    }

    // Deduct for low LLM acceptance
    if (parseFloat(metrics.suggestion_acceptance.acceptance_rate) < 20) {
      healthScore -= 10;
      diagnostics.warnings.push("LLM suggestions rarely accepted");
    }

    // Deduct for regime uncertainty
    if (parseFloat(metrics.regime_distribution.unknown) > 30) {
      healthScore -= 15;
      diagnostics.warnings.push("High regime uncertainty (many 'unknown' classifications)");
    }

    // Poor accuracy-confidence correlation
    if (Math.abs(parseFloat(metrics.accuracy_llm_correlation.correlation)) < 0.3) {
      healthScore -= 10;
      diagnostics.warnings.push("Low correlation between LLM confidence and accuracy");
    }

    diagnostics.health_score = Math.max(0, healthScore);

    // Generate recommendations
    if (diagnostics.health_score < 50) {
      diagnostics.recommendations.push("System health is degraded. Review LLM prompts and weight configuration.");
    }

    if (parseFloat(metrics.anomaly_frequency.frequency_per_100_cycles) > 30) {
      diagnostics.recommendations.push("Consider reducing LLM influence or increasing safety thresholds.");
    }

    if (parseFloat(metrics.regime_distribution.chop_noise) > 60) {
      diagnostics.recommendations.push("Market is choppy. Consider reducing position size or adjusting stop losses.");
    }

    return diagnostics;
  }

  /**
   * Helper: Compare two values and return trend indicator
   */
  compareTrend(current, previous) {
    if (previous === 0) return "→";
    const change = (current - previous) / previous;
    if (change > 0.1) return "↑";
    if (change < -0.1) return "↓";
    return "→";
  }

  /**
   * Helper: Calculate Pearson correlation
   */
  calculatePearson(x, y) {
    if (x.length !== y.length || x.length < 2) {
      return 0;
    }

    const n = x.length;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let sumSqX = 0;
    let sumSqY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      sumSqX += dx * dx;
      sumSqY += dy * dy;
    }

    const denominator = Math.sqrt(sumSqX * sumSqY);
    if (denominator === 0) return 0;

    return numerator / denominator;
  }

  /**
   * Read adjustment log from file
   */
  readAdjustmentLog(coin, limit) {
    const logPath = path.join(this.logsDir, `${coin}-adjustments.json`);
    if (!fs.existsSync(logPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(logPath, "utf8");
      const data = JSON.parse(content);
      return Array.isArray(data) ? data.slice(-limit) : [];
    } catch (err) {
      return [];
    }
  }

  /**
   * Read anomaly log from file
   */
  readAnomalyLog(coin, limit) {
    const logPath = path.join(this.logsDir, `${coin}-anomalies.json`);
    if (!fs.existsSync(logPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(logPath, "utf8");
      const data = JSON.parse(content);
      return Array.isArray(data) ? data.slice(-limit) : [];
    } catch (err) {
      return [];
    }
  }

  /**
   * Read analysis log from file
   */
  readAnalysisLog(coin, limit) {
    const logPath = path.join(this.logsDir, `${coin}-analysis.json`);
    if (!fs.existsSync(logPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(logPath, "utf8");
      const data = JSON.parse(content);
      return Array.isArray(data) ? data.slice(-limit) : [];
    } catch (err) {
      return [];
    }
  }

  /**
   * Get active coins (coins with log files)
   */
  getActiveCoins() {
    if (!fs.existsSync(this.logsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.logsDir);
    const coins = new Set();

    files.forEach((file) => {
      const match = file.match(/^([A-Z]+)-.+\.json$/);
      if (match) {
        coins.add(match[1]);
      }
    });

    return Array.from(coins).sort();
  }

  /**
   * Export metrics to dashboard-friendly JSON
   */
  exportForDashboard(coin) {
    const data = this.aggregate(coin);

    return {
      timestamp: data.metrics.timestamp,
      coin: coin,
      metrics: {
        llm_influence: `${data.metrics.llm_influence.influence_score}%`,
        regime: this.getMostLikelyRegime(data.metrics.regime_distribution),
        suggestion_acceptance: `${data.metrics.suggestion_acceptance.acceptance_rate}%`,
        weight_velocity: data.metrics.weight_adjustment_velocity.avg_velocity,
        anomalies: data.metrics.anomaly_frequency.anomaly_count,
        accuracy_correlation: data.metrics.accuracy_llm_correlation.correlation,
      },
      health: {
        score: data.diagnostics.health_score,
        status: data.diagnostics.health_score >= 80 ? "HEALTHY" : data.diagnostics.health_score >= 50 ? "FAIR" : "POOR",
        warnings: data.diagnostics.warnings,
      },
      trends: data.trends,
    };
  }

  /**
   * Helper: Get most likely regime
   */
  getMostLikelyRegime(distribution) {
    let maxRegime = "unknown";
    let maxValue = parseFloat(distribution.unknown);

    for (const regime in distribution) {
      if (regime !== "raw_counts" && regime !== "unknown") {
        const value = parseFloat(distribution[regime]);
        if (value > maxValue) {
          maxValue = value;
          maxRegime = regime;
        }
      }
    }

    return maxRegime;
  }

  /**
   * Clear all metrics
   */
  reset() {
    this.metrics = {};
    this.snapshots = {};
    console.log("[DashboardMetrics] Reset all metrics");
  }
}

// Export as CommonJS and ES6
const instance = new DashboardMetrics();

module.exports = instance;
module.exports.DashboardMetrics = DashboardMetrics;

// ES6 export fallback
if (typeof module.exports.default === "undefined") {
  module.exports.default = instance;
}
