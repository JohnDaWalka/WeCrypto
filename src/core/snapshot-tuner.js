/**
 * ================================================================
 * Snapshot Tuner — Real-Time Market Regime Adaptation
 * 
 * Analyzes last 24 hours of trading logs to:
 * 1. Calculate per-coin win rates
 * 2. Identify underperforming indicators
 * 3. Detect market regime changes (volatility, trend bias)
 * 4. Dynamically adjust COMPOSITE_WEIGHTS and PER_COIN_INDICATOR_BIAS
 * 
 * Prevents stagnant weights — responds to live market conditions
 * ================================================================
 */

class SnapshotTuner {
  constructor() {
    this.lastSnapshotTime = Date.now();
    this.snapshotHistory = []; // Rolling 7-day history for trend analysis
    this.currentSnapshot = null;
    this.tuningRecommendations = {};
    this.marketRegime = 'normal'; // normal, high-volatility, low-volatility, trending, mean-reversion
    
    // Baseline weights (synced with predictions.js)
    this.baselineCompositeWeights = {
      supertrend:  0.10, hma:         0.07, vwma:        0.06, ema:         0.05,
      sma:         0.03, macd:        0.07, persistence: 0.07, bands:       0.08,
      keltner:     0.05, williamsR:   0.07, rsi:         0.06, cci:         0.05,
      stochrsi:    0.04, volume:      0.10, obv:         0.07, cmf:         0.07,
      mfi:         0.07, structure:   0.10, ichimoku:    0.05, adx:         0.04,
      fisher:      0.04, book:        0.13, flow:        0.12, mktSentiment: 0.11,
    };

    // Per-coin baseline biases (from baseline predictions.js)
    this.baselinePerCoinBias = {
      BTC: {}, ETH: {}, XRP: {}, SOL: {}, BNB: {}, DOGE: {}, HYPE: {}
    };

    // Current adjusted weights
    this.currentCompositeWeights = JSON.parse(JSON.stringify(this.baselineCompositeWeights));
    this.currentPerCoinBias = JSON.parse(JSON.stringify(this.baselinePerCoinBias));

    console.log('[SnapshotTuner] Initialized with baseline weights');
  }

  /**
   * Parse prediction logs from the past 24 hours
   * Expected log format in window._predictions:
   *   { timestamp, coin, horizon, score, prediction, actual, indicators: {...} }
   */
  parseLastDay() {
    try {
      const now = Date.now();
      const dayAgo = now - (24 * 60 * 60 * 1000);
      
      const trades = [];
      const coins = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
      
      // Collect trades from window._predictions (populated by predictions.js)
      for (const coin of coins) {
        if (!window._predictions[coin]) continue;
        
        const coinTrades = Array.isArray(window._predictions[coin])
          ? window._predictions[coin]
          : Object.values(window._predictions[coin] || {});
        
        coinTrades.forEach(trade => {
          if (trade.timestamp && trade.timestamp >= dayAgo && trade.timestamp <= now) {
            trades.push({
              timestamp: trade.timestamp,
              coin,
              horizon: trade.horizon || 'h15',
              score: trade.score || 0,
              prediction: trade.prediction, // 'UP' or 'DOWN'
              actual: trade.actual,         // 'UP' or 'DOWN'
              correct: trade.prediction === trade.actual,
              indicators: trade.indicators || {},
            });
          }
        });
      }

      // Sort by timestamp (oldest first)
      trades.sort((a, b) => a.timestamp - b.timestamp);

      console.log(`[SnapshotTuner] Parsed ${trades.length} trades from last 24 hours`);
      return trades;
    } catch (err) {
      console.error('[SnapshotTuner] Error parsing logs:', err.message);
      return [];
    }
  }

  /**
   * Analyze per-coin and per-indicator performance
   */
  analyzePerformance(trades) {
    const analysis = {
      totalTrades: trades.length,
      coins: {},
      indicators: {},
      horizons: {},
      timestamp: Date.now(),
    };

    // Initialize coin stats
    const coins = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'HYPE'];
    coins.forEach(coin => {
      analysis.coins[coin] = {
        trades: 0,
        wins: 0,
        winRate: 0,
        avgScore: 0,
        volatility: 0,
        trend: 'neutral', // up, down, neutral
      };
    });

    // Initialize indicator stats
    const allIndicators = Object.keys(this.baselineCompositeWeights);
    allIndicators.forEach(ind => {
      analysis.indicators[ind] = {
        total: 0,
        wins: 0,
        winRate: 0,
        avgWeight: 0,
      };
    });

    // Initialize horizon stats
    ['h1', 'h5', 'h10', 'h15'].forEach(h => {
      analysis.horizons[h] = {
        trades: 0,
        wins: 0,
        winRate: 0,
      };
    });

    // Accumulate stats
    let totalScore = 0;
    let totalScores = [];
    const coinScores = {};

    trades.forEach(trade => {
      const coin = trade.coin;
      const horizon = trade.horizon || 'h15';

      // Coin-level stats
      analysis.coins[coin].trades++;
      if (trade.correct) analysis.coins[coin].wins++;
      analysis.coins[coin].avgScore += trade.score;
      totalScore += trade.score;
      totalScores.push(trade.score);
      
      if (!coinScores[coin]) coinScores[coin] = [];
      coinScores[coin].push(trade.score);

      // Horizon stats
      if (analysis.horizons[horizon]) {
        analysis.horizons[horizon].trades++;
        if (trade.correct) analysis.horizons[horizon].wins++;
      }

      // Indicator-level stats (extract from trade.indicators)
      if (trade.indicators && typeof trade.indicators === 'object') {
        Object.entries(trade.indicators).forEach(([indName, indData]) => {
          if (analysis.indicators[indName]) {
            analysis.indicators[indName].total++;
            if (trade.correct) analysis.indicators[indName].wins++;
          }
        });
      }
    });

    // Calculate win rates
    coins.forEach(coin => {
      if (analysis.coins[coin].trades > 0) {
        analysis.coins[coin].winRate = 
          (analysis.coins[coin].wins / analysis.coins[coin].trades) * 100;
        analysis.coins[coin].avgScore = 
          analysis.coins[coin].avgScore / analysis.coins[coin].trades;
      }
    });

    allIndicators.forEach(ind => {
      if (analysis.indicators[ind].total > 0) {
        analysis.indicators[ind].winRate = 
          (analysis.indicators[ind].wins / analysis.indicators[ind].total) * 100;
      }
    });

    ['h1', 'h5', 'h10', 'h15'].forEach(h => {
      if (analysis.horizons[h].trades > 0) {
        analysis.horizons[h].winRate = 
          (analysis.horizons[h].wins / analysis.horizons[h].trades) * 100;
      }
    });

    // Detect market regime
    const volatility = this.calculateVolatility(totalScores);
    const trend = this.detectTrend(trades);
    analysis.marketVolatility = volatility;
    analysis.marketTrend = trend;

    // Determine regime
    if (volatility > 0.15) {
      this.marketRegime = 'high-volatility';
    } else if (volatility < 0.05) {
      this.marketRegime = 'low-volatility';
    } else if (Math.abs(trend) > 0.10) {
      this.marketRegime = trend > 0 ? 'uptrend' : 'downtrend';
    } else {
      this.marketRegime = 'normal';
    }

    this.currentSnapshot = analysis;
    return analysis;
  }

  /**
   * Calculate volatility from scores
   */
  calculateVolatility(scores) {
    if (scores.length < 2) return 0;
    
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, s) => a + Math.pow(s - mean, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev; // Normalized stdev as volatility metric
  }

  /**
   * Detect directional trend from trade predictions
   */
  detectTrend(trades) {
    if (trades.length < 10) return 0;
    
    const recent = trades.slice(-100);
    let upCount = 0;
    let downCount = 0;
    
    recent.forEach(t => {
      if (t.prediction === 'UP') upCount++;
      else if (t.prediction === 'DOWN') downCount++;
    });
    
    return (upCount - downCount) / recent.length; // Bias toward UP/DOWN
  }

  /**
   * Generate tuning recommendations based on performance
   */
  generateRecommendations(analysis) {
    const recs = {
      timestamp: Date.now(),
      regime: this.marketRegime,
      compositeAdjustments: {},
      perCoinAdjustments: {},
      rationale: [],
    };

    // Threshold: indicators with <40% win rate are suspects (downweight)
    // Threshold: indicators with >55% win rate are winners (upweight)
    
    const suspectThreshold = 40;
    const winnerThreshold = 55;
    const adjustmentFactor = 0.08; // Max ±8% per snapshot cycle

    // Analyze indicators
    Object.entries(analysis.indicators).forEach(([indName, stats]) => {
      if (stats.total < 10) return; // Ignore low-sample indicators
      
      const baseline = this.baselineCompositeWeights[indName] || 0;
      
      if (stats.winRate < suspectThreshold) {
        // Downweight underperforming indicators
        const adjustment = baseline * adjustmentFactor;
        this.currentCompositeWeights[indName] = Math.max(baseline * 0.7, baseline - adjustment);
        recs.compositeAdjustments[indName] = {
          from: baseline,
          to: this.currentCompositeWeights[indName],
          reason: `Low WR: ${stats.winRate.toFixed(1)}%`,
        };
        recs.rationale.push(`⬇️ ${indName}: ${stats.winRate.toFixed(1)}% WR`);
      } else if (stats.winRate > winnerThreshold) {
        // Upweight performing indicators
        const adjustment = baseline * adjustmentFactor;
        this.currentCompositeWeights[indName] = Math.min(baseline * 1.3, baseline + adjustment);
        recs.compositeAdjustments[indName] = {
          from: baseline,
          to: this.currentCompositeWeights[indName],
          reason: `High WR: ${stats.winRate.toFixed(1)}%`,
        };
        recs.rationale.push(`⬆️ ${indName}: ${stats.winRate.toFixed(1)}% WR`);
      }
    });

    // Analyze per-coin performance
    Object.entries(analysis.coins).forEach(([coin, stats]) => {
      if (stats.trades < 10) return; // Ignore low-sample coins
      
      const isUnderperforming = stats.winRate < 48;
      const isOutperforming = stats.winRate > 52;
      
      if (isUnderperforming || isOutperforming) {
        recs.perCoinAdjustments[coin] = {
          winRate: stats.winRate,
          trades: stats.trades,
          avgScore: stats.avgScore,
          action: isUnderperforming ? 'tighten-gates' : 'relax-gates',
        };
        
        if (isUnderperforming) {
          recs.rationale.push(`⚠️ ${coin}: ${stats.winRate.toFixed(1)}% WR (tighten entry)`);
        } else {
          recs.rationale.push(`✨ ${coin}: ${stats.winRate.toFixed(1)}% WR (potential)`);
        }
      }
    });

    // Market regime-specific adjustments
    if (this.marketRegime === 'high-volatility') {
      recs.rationale.push(`📊 High volatility detected: Consider tighter gates`);
      recs.volatilityAdjustment = 'tight';
    } else if (this.marketRegime === 'low-volatility') {
      recs.rationale.push(`📊 Low volatility detected: Can relax gates slightly`);
      recs.volatilityAdjustment = 'relax';
    } else if (this.marketRegime.includes('trend')) {
      recs.rationale.push(`📈 Strong ${this.marketRegime}: Trend indicators should perform well`);
      recs.volatilityAdjustment = 'follow-trend';
    }

    this.tuningRecommendations = recs;
    return recs;
  }

  /**
   * Apply recommendations to current weights
   */
  applyRecommendations() {
    // Normalize weights to sum to 1
    const total = Object.values(this.currentCompositeWeights).reduce((a, b) => a + b, 0);
    if (total > 0) {
      Object.keys(this.currentCompositeWeights).forEach(ind => {
        this.currentCompositeWeights[ind] = (this.currentCompositeWeights[ind] / total) * 1.0;
      });
    }

    console.log('[SnapshotTuner] Weights adjusted for market regime:', this.marketRegime);
    return {
      compositeWeights: this.currentCompositeWeights,
      perCoinBias: this.currentPerCoinBias,
      regime: this.marketRegime,
    };
  }

  /**
   * Run full snapshot tuning cycle
   */
  runSnapshot() {
    console.log('[SnapshotTuner] Running snapshot tuning cycle...');
    const startTime = Date.now();

    try {
      // Step 1: Parse logs
      const trades = this.parseLastDay();
      if (trades.length === 0) {
        console.warn('[SnapshotTuner] No trades found in last 24 hours');
        return null;
      }

      // Step 2: Analyze performance
      const analysis = this.analyzePerformance(trades);

      // Step 3: Generate recommendations
      const recs = this.generateRecommendations(analysis);

      // Step 4: Apply recommendations
      const result = this.applyRecommendations();

      // Record snapshot
      this.snapshotHistory.push({
        timestamp: Date.now(),
        analysis,
        recommendations: recs,
        appliedWeights: result,
      });

      // Keep last 7 snapshots
      if (this.snapshotHistory.length > 7) {
        this.snapshotHistory = this.snapshotHistory.slice(-7);
      }

      const elapsed = Date.now() - startTime;
      console.log(`[SnapshotTuner] Snapshot complete in ${elapsed}ms`);
      console.log(`[SnapshotTuner] Market regime: ${this.marketRegime}`);
      console.log(`[SnapshotTuner] Adjustments: ${Object.keys(recs.compositeAdjustments).length} indicators, ${Object.keys(recs.perCoinAdjustments).length} coins`);

      return result;
    } catch (err) {
      console.error('[SnapshotTuner] Error running snapshot:', err.message);
      return null;
    }
  }

  /**
   * Get current tuning status
   */
  getStatus() {
    return {
      lastSnapshot: this.lastSnapshotTime,
      currentSnapshot: this.currentSnapshot,
      marketRegime: this.marketRegime,
      recommendations: this.tuningRecommendations,
      snapshotCount: this.snapshotHistory.length,
    };
  }

  /**
   * Get diagnostic info
   */
  getDiagnostics() {
    return {
      status: this.getStatus(),
      currentWeights: this.currentCompositeWeights,
      history: this.snapshotHistory.slice(-3), // Last 3 snapshots
      baselineWeights: this.baselineCompositeWeights,
    };
  }

  /**
   * Reset to baseline weights
   */
  resetToBaseline() {
    this.currentCompositeWeights = JSON.parse(JSON.stringify(this.baselineCompositeWeights));
    this.currentPerCoinBias = JSON.parse(JSON.stringify(this.baselinePerCoinBias));
    this.marketRegime = 'normal';
    console.log('[SnapshotTuner] Reset to baseline weights');
  }
}

// Export for Node.js (testing) and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SnapshotTuner;
}
