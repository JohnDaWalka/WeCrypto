/**
 * Adaptive Learning Engine
 * 
 * Watches accuracy scorecard and automatically tunes signal weights based on:
 * - What's working (high accuracy signals)
 * - What's failing (low accuracy signals)  
 * - Trending accuracy (is model getting smarter or dumber over time?)
 * 
 * Feeds accuracy data back into weight tuning engine for real-time model improvement.
 */

class AdaptiveLearningEngine {
  constructor() {
    // Historical accuracy tracking per signal per coin
    this.signalAccuracy = {}; // { BTC: { RSI: [0.55, 0.62, ...], MACD: [...], ... }, ... }
    this.signalWeights = {};  // Current weight adjustments { BTC: { RSI: 1.2, MACD: 0.8, ... }, ... }
    
    // Trending analysis
    this.accuracyTrend = {};  // { BTC: { trend: 'improving', lastAvg: 0.55, current: 0.58, ... }, ... }
    this.windowSize = 20;     // Last N contracts for trending
    this.minSamples = 5;      // Need at least 5 settled contracts before tuning
    
    // Tuning parameters
    this.baseAdjustment = 0.05;    // 5% per adjustment cycle
    this.maxMultiplier = 2.0;      // Cap weight at 2.0x
    this.minMultiplier = 0.3;      // Floor weight at 0.3x
    this.improvementThreshold = 0.52; // Need >52% accuracy to reward signal
    this.failureThreshold = 0.45;     // Below 45% accuracy = signal is hurting
    
    // Learning cycle
    this.lastTuneTime = 0;
    this.tuneInterval = 120_000;  // Tune every 2 minutes
    
    // Audit trail
    this.tuneLog = [];
    this.maxLogSize = 100;
    
    console.log('[AdaptiveLearningEngine] Initialized');
  }

  /**
   * Record signal contribution to a trade outcome
   * Called when a contract settles with accuracy data
   */
  recordSignalContribution(coin, signals, modelWasCorrect) {
    if (!this.signalAccuracy[coin]) {
      this.signalAccuracy[coin] = {};
    }
    
    // Credit/blame each signal based on outcome
    for (const [signalName, signalData] of Object.entries(signals || {})) {
      if (!this.signalAccuracy[coin][signalName]) {
        this.signalAccuracy[coin][signalName] = [];
      }
      
      // Record 1 (correct) or 0 (incorrect)
      const score = modelWasCorrect ? 1 : 0;
      this.signalAccuracy[coin][signalName].push({
        score,
        timestamp: Date.now(),
        signalValue: signalData.value,
        signalDirection: signalData.direction,
      });
      
      // Keep only last 100 for each signal
      if (this.signalAccuracy[coin][signalName].length > 100) {
        this.signalAccuracy[coin][signalName] = this.signalAccuracy[coin][signalName].slice(-100);
      }
    }
  }

  /**
   * Calculate accuracy rate for a specific signal on a coin
   */
  getSignalAccuracy(coin, signalName) {
    const data = this.signalAccuracy[coin]?.[signalName];
    if (!data || data.length < this.minSamples) return null;
    
    const recent = data.slice(-this.windowSize);
    const correct = recent.filter(s => s.score === 1).length;
    const accuracy = correct / recent.length;
    
    return {
      accuracy: Math.round(accuracy * 1000) / 1000,
      samples: recent.length,
      correct,
      total: recent.length,
    };
  }

  /**
   * Get trending accuracy (is signal getting better or worse over time?)
   */
  getSignalTrend(coin, signalName) {
    const data = this.signalAccuracy[coin]?.[signalName];
    if (!data || data.length < this.minSamples * 2) return null;
    
    const all = data.slice(-this.windowSize * 2);
    const oldHalf = all.slice(0, all.length / 2);
    const newHalf = all.slice(all.length / 2);
    
    const oldAcc = oldHalf.filter(s => s.score === 1).length / oldHalf.length;
    const newAcc = newHalf.filter(s => s.score === 1).length / newHalf.length;
    
    const improvement = newAcc - oldAcc;
    let trend;
    if (improvement > 0.05) trend = '↑ improving';
    else if (improvement < -0.05) trend = '↓ degrading';
    else trend = '→ stable';
    
    return {
      trend,
      improvement: Math.round(improvement * 1000) / 10, // percentage change
      oldAccuracy: Math.round(oldAcc * 1000) / 1000,
      newAccuracy: Math.round(newAcc * 1000) / 1000,
    };
  }

  /**
   * Auto-tune weights based on signal performance
   * Called every 2 minutes to update model weights
   */
  autoTuneWeights() {
    const now = Date.now();
    if (now - this.lastTuneTime < this.tuneInterval) return;
    
    this.lastTuneTime = now;
    const tuneEvent = {
      timestamp: now,
      adjustments: {},
    };
    
    // Iterate each coin
    for (const coin of Object.keys(this.signalAccuracy)) {
      if (!tuneEvent.adjustments[coin]) {
        tuneEvent.adjustments[coin] = [];
      }
      
      if (!this.signalWeights[coin]) {
        this.signalWeights[coin] = {};
      }
      
      // Iterate each signal
      for (const signal of Object.keys(this.signalAccuracy[coin])) {
        const acc = this.getSignalAccuracy(coin, signal);
        if (!acc) continue; // Not enough samples yet
        
        const currentWeight = this.signalWeights[coin][signal] ?? 1.0;
        let newWeight = currentWeight;
        let action = 'hold';
        
        // REWARD: accuracy above threshold
        if (acc.accuracy > this.improvementThreshold) {
          newWeight = Math.min(
            currentWeight * (1 + this.baseAdjustment),
            this.maxMultiplier
          );
          action = 'boost';
        }
        // PENALIZE: accuracy below failure threshold
        else if (acc.accuracy < this.failureThreshold) {
          newWeight = Math.max(
            currentWeight * (1 - this.baseAdjustment),
            this.minMultiplier
          );
          action = 'reduce';
        }
        
        // Check trending to accelerate or decelerate adjustment
        const trend = this.getSignalTrend(coin, signal);
        let trendFactor = 1.0;
        if (trend) {
          if (trend.improvement > 0.08) trendFactor = 1.5; // Accelerate boost
          else if (trend.improvement < -0.08) trendFactor = 1.3; // Accelerate penalty
        }
        
        // Apply trend factor
        if (action === 'boost') {
          newWeight = Math.min(
            currentWeight * (1 + this.baseAdjustment * trendFactor),
            this.maxMultiplier
          );
        } else if (action === 'reduce') {
          newWeight = Math.max(
            currentWeight * (1 - this.baseAdjustment * trendFactor),
            this.minMultiplier
          );
        }
        
        this.signalWeights[coin][signal] = newWeight;
        
        tuneEvent.adjustments[coin].push({
          signal,
          accuracy: acc.accuracy,
          samples: acc.samples,
          previousWeight: currentWeight,
          newWeight: Math.round(newWeight * 1000) / 1000,
          action,
          trend: trend?.trend || 'insufficient_data',
        });
      }
    }
    
    // Log the tuning event
    this.tuneLog.push(tuneEvent);
    if (this.tuneLog.length > this.maxLogSize) {
      this.tuneLog = this.tuneLog.slice(-this.maxLogSize);
    }
    
    // Post summary to console
    this.logTuneEvent(tuneEvent);
    
    // Store globally for use by signal router
    if (typeof window !== 'undefined') {
      window._adaptiveWeights = this.signalWeights;
      window._lastTuneEvent = tuneEvent;
    }
    
    return tuneEvent;
  }

  /**
   * Log tuning event to console with summary
   */
  logTuneEvent(event) {
    console.log(`\n[AdaptiveLearning] 🎓 Tuning cycle at ${new Date(event.timestamp).toISOString()}`);
    
    for (const [coin, adjustments] of Object.entries(event.adjustments)) {
      if (adjustments.length === 0) continue;
      
      const boosts = adjustments.filter(a => a.action === 'boost').length;
      const reduces = adjustments.filter(a => a.action === 'reduce').length;
      
      console.log(`  ${coin}: ${boosts} boosted, ${reduces} reduced`);
      
      adjustments.slice(0, 3).forEach(adj => {
        const dir = adj.action === 'boost' ? '↑' : adj.action === 'reduce' ? '↓' : '→';
        console.log(`    ${dir} ${adj.signal}: ${(adj.accuracy*100).toFixed(1)}% (${adj.samples}/${this.windowSize}) | ${adj.previousWeight.toFixed(2)}→${adj.newWeight.toFixed(2)}`);
      });
    }
  }

  /**
   * Get current weight multipliers for use in signal router
   */
  getWeightMultipliers(coin) {
    return this.signalWeights[coin] || {};
  }

  /**
   * Get per-coin accuracy report
   */
  getAccuracyReport(coin) {
    const signals = this.signalAccuracy[coin];
    if (!signals) return null;
    
    const report = {
      coin,
      signals: {},
      averageAccuracy: 0,
    };
    
    let totalAccuracy = 0;
    let count = 0;
    
    for (const [signalName, data] of Object.entries(signals)) {
      if (data.length < this.minSamples) continue;
      
      const acc = this.getSignalAccuracy(coin, signalName);
      const trend = this.getSignalTrend(coin, signalName);
      const weight = this.signalWeights[coin]?.[signalName] ?? 1.0;
      
      report.signals[signalName] = {
        accuracy: acc.accuracy,
        samples: acc.samples,
        trend: trend?.trend || '?',
        improvement: trend?.improvement,
        weight: Math.round(weight * 1000) / 1000,
      };
      
      totalAccuracy += acc.accuracy;
      count++;
    }
    
    report.averageAccuracy = count > 0 ? Math.round((totalAccuracy / count) * 1000) / 1000 : 0;
    return report;
  }

  /**
   * Get all accuracy reports
   */
  getAllReports() {
    const reports = {};
    for (const coin of Object.keys(this.signalAccuracy)) {
      reports[coin] = this.getAccuracyReport(coin);
    }
    return reports;
  }

  /**
   * Get diagnostics
   */
  getDiagnostics() {
    return {
      signalAccuracy: this.signalAccuracy,
      signalWeights: this.signalWeights,
      tuneLog: this.tuneLog.slice(-10),
      config: {
        baseAdjustment: this.baseAdjustment,
        maxMultiplier: this.maxMultiplier,
        minMultiplier: this.minMultiplier,
        improvementThreshold: this.improvementThreshold,
        failureThreshold: this.failureThreshold,
        tuneInterval: this.tuneInterval,
        windowSize: this.windowSize,
        minSamples: this.minSamples,
      },
    };
  }

  /**
   * Reset learning (for testing/recovery)
   */
  reset() {
    this.signalAccuracy = {};
    this.signalWeights = {};
    this.tuneLog = [];
    this.lastTuneTime = 0;
    console.log('[AdaptiveLearningEngine] Reset');
  }
}

// Export globally
if (typeof window !== 'undefined') {
  window.AdaptiveLearningEngine = AdaptiveLearningEngine;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AdaptiveLearningEngine;
}

console.log('[AdaptiveLearningEngine] Module loaded');
