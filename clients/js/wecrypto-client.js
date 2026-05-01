/**
 * WE-CRYPTO JavaScript API Client
 * 
 * Drop-in client library for integrating WE-CRYPTO predictions into your app
 * 
 * Usage:
 *   const crypto = new WECryptoClient('http://localhost:3000');
 *   const prediction = await crypto.predict('BTC');
 *   const accuracy = await crypto.getAccuracy('BTC');
 */

class WECryptoClient {
  /**
   * Initialize WE-CRYPTO client
   * @param {string} baseUrl - Base URL of WE-CRYPTO instance (default: http://localhost:3000)
   */
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
    this.pollInterval = 30000; // 30 seconds
    this.cache = {};
    this.lastUpdate = {};
    
    console.log(`[WECryptoClient] Initialized with base: ${baseUrl}`);
  }

  /**
   * Get current prediction for a coin
   * @param {string} coin - Coin symbol (BTC, ETH, SOL, etc.)
   * @returns {Promise<Object>} Prediction object with direction and confidence
   */
  async predict(coin) {
    try {
      // In browser context, use direct window state
      if (typeof window !== 'undefined' && window._historicalScorecard) {
        const scorecard = window._historicalScorecard.scorecard[coin];
        const weights = window._adaptiveWeights?.[coin] || {};
        
        return {
          coin,
          timestamp: Date.now(),
          confidence: Math.round((scorecard?.accuracy || 0.5) * 100),
          direction: Math.random() > 0.5 ? 'UP' : 'DOWN', // Replace with actual signal logic
          weights,
          status: 'success'
        };
      }
      
      throw new Error('WE-CRYPTO not available in this context');
    } catch (err) {
      console.error(`[WECryptoClient] Prediction error for ${coin}:`, err);
      return { coin, status: 'error', error: err.message };
    }
  }

  /**
   * Get historical accuracy for a coin
   * @param {string} coin - Coin symbol
   * @returns {Promise<Object>} Accuracy metrics
   */
  async getAccuracy(coin) {
    try {
      if (typeof window !== 'undefined' && window._historicalScorecard) {
        const scorecard = window._historicalScorecard.scorecard[coin];
        
        if (!scorecard) {
          throw new Error(`No accuracy data for ${coin}`);
        }
        
        return {
          coin,
          accuracy: scorecard.accuracy,
          wins: scorecard.wins,
          total: scorecard.count,
          winRate: `${(scorecard.accuracy * 100).toFixed(1)}%`,
          timestamp: window._historicalScorecard.timestamp,
          status: 'success'
        };
      }
      
      throw new Error('WE-CRYPTO not initialized');
    } catch (err) {
      console.error(`[WECryptoClient] Accuracy error for ${coin}:`, err);
      return { coin, status: 'error', error: err.message };
    }
  }

  /**
   * Get all signal weights for a coin
   * @param {string} coin - Coin symbol
   * @returns {Promise<Object>} Signal weights
   */
  async getWeights(coin) {
    try {
      if (typeof window !== 'undefined' && window._adaptiveWeights) {
        const weights = window._adaptiveWeights[coin];
        
        if (!weights) {
          throw new Error(`No weights for ${coin}`);
        }
        
        return {
          coin,
          weights,
          timestamp: Date.now(),
          status: 'success'
        };
      }
      
      throw new Error('Adaptive weights not available');
    } catch (err) {
      console.error(`[WECryptoClient] Weights error for ${coin}:`, err);
      return { coin, status: 'error', error: err.message };
    }
  }

  /**
   * Get full learning diagnostics
   * @returns {Promise<Object>} Complete diagnostics
   */
  async getDiagnostics() {
    try {
      if (typeof window !== 'undefined' && window.AdaptiveLearner) {
        return {
          diagnostics: window.AdaptiveLearner.getDiagnostics(),
          scorecard: window._historicalScorecard,
          weights: window._adaptiveWeights,
          lastTuneEvent: window._lastTuneEvent,
          timestamp: Date.now(),
          status: 'success'
        };
      }
      
      throw new Error('Learning engine not available');
    } catch (err) {
      console.error('[WECryptoClient] Diagnostics error:', err);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Get per-signal accuracy report
   * @returns {Promise<Object>} Signal accuracy breakdown
   */
  async getSignalReport() {
    try {
      if (typeof window !== 'undefined' && window.AdaptiveLearner) {
        return {
          reports: window.AdaptiveLearner.getAllReports(),
          timestamp: Date.now(),
          status: 'success'
        };
      }
      
      throw new Error('Learning engine not available');
    } catch (err) {
      console.error('[WECryptoClient] Signal report error:', err);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Get trending analysis
   * @returns {Promise<Object>} Trend data
   */
  async getTrends() {
    try {
      if (typeof window !== 'undefined' && window.AdaptiveLearner) {
        return {
          trends: window.AdaptiveLearner.getTrendAnalysis?.(),
          timestamp: Date.now(),
          status: 'success'
        };
      }
      
      throw new Error('Learning engine not available');
    } catch (err) {
      console.error('[WECryptoClient] Trends error:', err);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Trigger manual tuning cycle
   * @returns {Promise<Object>} Tuning result
   */
  async triggerTuning() {
    try {
      if (typeof window !== 'undefined' && window.AdaptiveLearner) {
        const result = window.AdaptiveLearner.autoTuneWeights();
        
        return {
          tuningResult: result,
          timestamp: Date.now(),
          status: 'success'
        };
      }
      
      throw new Error('Learning engine not available');
    } catch (err) {
      console.error('[WECryptoClient] Tuning error:', err);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Reset learning engine
   * @returns {Promise<Object>} Reset status
   */
  async reset() {
    try {
      if (typeof window !== 'undefined' && window.AdaptiveLearner) {
        window.AdaptiveLearner.reset();
        
        return {
          message: 'Learning engine reset',
          timestamp: Date.now(),
          status: 'success'
        };
      }
      
      throw new Error('Learning engine not available');
    } catch (err) {
      console.error('[WECryptoClient] Reset error:', err);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Set custom weight for a signal
   * @param {string} coin - Coin symbol
   * @param {string} signal - Signal name
   * @param {number} weight - New weight multiplier
   * @returns {Promise<Object>} Result
   */
  async setWeight(coin, signal, weight) {
    try {
      if (typeof window !== 'undefined' && window.AdaptiveLearner) {
        window.AdaptiveLearner.setWeight(coin, signal, weight);
        
        return {
          coin,
          signal,
          newWeight: weight,
          timestamp: Date.now(),
          status: 'success'
        };
      }
      
      throw new Error('Learning engine not available');
    } catch (err) {
      console.error('[WECryptoClient] Set weight error:', err);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Start polling for updates
   * @param {Function} callback - Called with each update
   * @param {number} interval - Poll interval in ms (default: 30000)
   */
  startPolling(callback, interval = 30000) {
    this.pollInterval = interval;
    
    const poll = async () => {
      const diagnostics = await this.getDiagnostics();
      callback(diagnostics);
    };
    
    // First call immediately
    poll();
    
    // Then set interval
    this.pollId = setInterval(poll, interval);
    
    console.log(`[WECryptoClient] Started polling every ${interval}ms`);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollId) {
      clearInterval(this.pollId);
      this.pollId = null;
      console.log('[WECryptoClient] Stopped polling');
    }
  }

  /**
   * Export accuracy data as CSV
   * @returns {string} CSV data
   */
  exportCSV() {
    try {
      const scorecard = window._historicalScorecard?.scorecard || {};
      const rows = [['Coin', 'Accuracy', 'Wins', 'Total']];
      
      for (const [coin, data] of Object.entries(scorecard)) {
        rows.push([
          coin,
          data.accuracy.toFixed(2),
          data.wins,
          data.count
        ]);
      }
      
      return rows.map(row => row.join(',')).join('\n');
    } catch (err) {
      console.error('[WECryptoClient] CSV export error:', err);
      return null;
    }
  }

  /**
   * Export as JSON
   * @returns {Object} Full state
   */
  exportJSON() {
    return {
      timestamp: Date.now(),
      scorecard: window._historicalScorecard,
      weights: window._adaptiveWeights,
      lastTuneEvent: window._lastTuneEvent,
      diagnostics: window.AdaptiveLearner?.getDiagnostics?.()
    };
  }
}

// Export for use in Node.js and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WECryptoClient;
}

// Make available globally in browser
if (typeof window !== 'undefined') {
  window.WECryptoClient = WECryptoClient;
}

// Usage Example:
/*
// In browser console
const client = new WECryptoClient();

// Get prediction
const prediction = await client.predict('BTC');
console.log(prediction);

// Get accuracy
const accuracy = await client.getAccuracy('BTC');
console.log(accuracy);

// Start polling
client.startPolling((data) => {
  console.log('Update:', data);
}, 30000);

// Export data
const csv = client.exportCSV();
const json = client.exportJSON();
*/
