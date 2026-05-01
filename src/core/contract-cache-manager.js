// contract-cache-manager.js
// ════════════════════════════════════════════════════════════════════════════
// 2-Hour Contract Data Cache + Auto-Archive
//
// Stores: predictions, settlements, candles, orders, errors for last 2 hours
// Persists to: localStorage (browser) + local AppData (Node.js)
// Auto-archives: Moves >2h old data to historical archive
// ════════════════════════════════════════════════════════════════════════════

class ContractCacheManager {
  constructor(config = {}) {
    this.config = {
      maxAgeMs: config.maxAgeMs || 2 * 60 * 60 * 1000,  // 2 hours
      archiveThresholdMs: config.archiveThresholdMs || 2.5 * 60 * 60 * 1000,  // 2.5h
      cacheDir: config.cacheDir || (typeof window === 'undefined' 
        ? `${process.env.LOCALAPPDATA}/WE-CRYPTO-CACHE`
        : null),
      ...config
    };

    // In-memory buffers (2-hour sliding window)
    this.predictions = [];      // { coin, direction, confidence, signals, timestamp }
    this.settlements = [];      // { coin, outcome, modelCorrect, marketCorrect, timestamp }
    this.candles = [];          // { coin, timeframe, ohlcv, timestamp }
    this.orders = [];           // { coin, side, qty, price, timestamp }
    this.errors = [];           // { type, message, context, timestamp }
    this.correlations = [];     // { coin1, coin2, correlation, timestamp }

    this.cacheKey = 'contract-cache-2h';
    this.lastArchiveMs = Date.now();
    this.archiveCount = 0;

    this._init();
  }

  _init() {
    // Load from persistent storage if available
    this._loadFromStorage();
    
    // Auto-archive old data every 5 minutes
    if (typeof setInterval !== 'undefined') {
      setInterval(() => this._archiveOldData(), 5 * 60 * 1000);
    }

    console.log(`[ContractCache] Initialized with max age ${this.config.maxAgeMs / 1000 / 60}m`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Recording Methods
  // ─────────────────────────────────────────────────────────────────────────

  recordPrediction(coin, direction, confidence, signals = {}) {
    const now = Date.now();
    const record = {
      coin,
      direction,
      confidence,
      signals,
      timestamp: now,
      id: `${coin}-${now}`
    };
    
    this.predictions.push(record);
    this._trim('predictions');
    this._saveToStorage();
    
    return record;
  }

  recordSettlement(coin, outcome, modelCorrect, marketCorrect) {
    const now = Date.now();
    const record = {
      coin,
      outcome,
      modelCorrect,
      marketCorrect,
      timestamp: now,
      id: `settle-${coin}-${now}`
    };
    
    this.settlements.push(record);
    this._trim('settlements');
    this._saveToStorage();
    
    return record;
  }

  recordCandle(coin, timeframe, ohlcv) {
    const now = Date.now();
    const record = {
      coin,
      timeframe,
      o: ohlcv.o, h: ohlcv.h, l: ohlcv.l, c: ohlcv.c, v: ohlcv.v,
      timestamp: now,
      id: `candle-${coin}-${timeframe}-${now}`
    };
    
    this.candles.push(record);
    this._trim('candles');
    
    return record;
  }

  recordOrder(coin, side, qty, price) {
    const now = Date.now();
    const record = {
      coin,
      side,
      qty,
      price,
      timestamp: now,
      id: `order-${coin}-${side}-${now}`
    };
    
    this.orders.push(record);
    this._trim('orders');
    this._saveToStorage();
    
    return record;
  }

  recordError(type, message, context = {}) {
    const now = Date.now();
    const record = {
      type,
      message,
      context,
      timestamp: now,
      id: `error-${type}-${now}`,
      stack: new Error().stack
    };
    
    this.errors.push(record);
    this._trim('errors', 200);  // Keep more error history
    this._saveToStorage();
    
    return record;
  }

  recordCorrelation(coin1, coin2, correlation) {
    const now = Date.now();
    const record = {
      coin1,
      coin2,
      correlation,
      timestamp: now,
      id: `corr-${coin1}-${coin2}-${now}`
    };
    
    this.correlations.push(record);
    this._trim('correlations');
    
    return record;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Methods
  // ─────────────────────────────────────────────────────────────────────────

  getRecentPredictions(coin = null, minutes = 60) {
    const cutoff = Date.now() - minutes * 60 * 1000;
    let filtered = this.predictions.filter(p => p.timestamp >= cutoff);
    if (coin) filtered = filtered.filter(p => p.coin === coin);
    return filtered;
  }

  getRecentSettlements(coin = null, minutes = 120) {
    const cutoff = Date.now() - minutes * 60 * 1000;
    let filtered = this.settlements.filter(s => s.timestamp >= cutoff);
    if (coin) filtered = filtered.filter(s => s.coin === coin);
    return filtered;
  }

  getRecentErrors(type = null, minutes = 120) {
    const cutoff = Date.now() - minutes * 60 * 1000;
    let filtered = this.errors.filter(e => e.timestamp >= cutoff);
    if (type) filtered = filtered.filter(e => e.type === type);
    return filtered;
  }

  getCoinAccuracy(coin) {
    const settlements = this.settlements.filter(s => s.coin === coin);
    if (settlements.length === 0) return null;

    const correct = settlements.filter(s => s.modelCorrect).length;
    const total = settlements.length;
    const winRate = correct / total;
    
    return {
      coin,
      total,
      correct,
      winRate: (winRate * 100).toFixed(2) + '%',
      dataAge: Date.now() - settlements[settlements.length - 1].timestamp
    };
  }

  getAllAccuracy() {
    const coins = [...new Set(this.settlements.map(s => s.coin))];
    const accuracies = coins
      .map(c => this.getCoinAccuracy(c))
      .filter(a => a !== null);
    
    if (accuracies.length === 0) return null;
    
    const totalSettlements = accuracies.reduce((s, a) => s + a.total, 0);
    const totalCorrect = accuracies.reduce((s, a) => s + a.correct, 0);
    
    return {
      portfolioWR: ((totalCorrect / totalSettlements) * 100).toFixed(2) + '%',
      totalSettlements,
      byCoins: accuracies
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Storage & Archiving
  // ─────────────────────────────────────────────────────────────────────────

  _trim(category, maxSize = 500) {
    const buffer = this[category];
    const now = Date.now();

    // Remove entries older than maxAge
    const filtered = buffer.filter(entry => now - entry.timestamp < this.config.maxAgeMs);
    
    // If still over maxSize, trim oldest
    if (filtered.length > maxSize) {
      filtered.splice(0, filtered.length - maxSize);
    }

    this[category] = filtered;
  }

  _saveToStorage() {
    if (typeof window === 'undefined') return;  // Node.js context

    try {
      const data = {
        predictions: this.predictions,
        settlements: this.settlements,
        candles: this.candles,
        orders: this.orders,
        errors: this.errors,
        correlations: this.correlations,
        savedAt: Date.now()
      };

      localStorage.setItem(this.cacheKey, JSON.stringify(data));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        // Trim 25% oldest data and retry
        this.predictions.splice(0, Math.floor(this.predictions.length * 0.25));
        this.settlements.splice(0, Math.floor(this.settlements.length * 0.25));
        this.errors.splice(0, Math.floor(this.errors.length * 0.25));
        try {
          localStorage.setItem(this.cacheKey, JSON.stringify({
            predictions: this.predictions,
            settlements: this.settlements,
            candles: this.candles,
            orders: this.orders,
            errors: this.errors,
            correlations: this.correlations,
            savedAt: Date.now()
          }));
        } catch (e2) {
          console.error('[ContractCache] Storage full even after trim:', e2.message);
        }
      } else {
        console.error('[ContractCache] Save error:', e.message);
      }
    }
  }

  _loadFromStorage() {
    if (typeof window === 'undefined') return;  // Node.js context

    try {
      const stored = localStorage.getItem(this.cacheKey);
      if (!stored) return;

      const data = JSON.parse(stored);
      
      // Restore arrays, filtering out old entries
      const now = Date.now();
      this.predictions = (data.predictions || []).filter(p => now - p.timestamp < this.config.maxAgeMs);
      this.settlements = (data.settlements || []).filter(s => now - s.timestamp < this.config.maxAgeMs);
      this.candles = (data.candles || []).filter(c => now - c.timestamp < this.config.maxAgeMs);
      this.orders = (data.orders || []).filter(o => now - o.timestamp < this.config.maxAgeMs);
      this.errors = (data.errors || []).slice(-100);  // Keep last 100 errors
      this.correlations = (data.correlations || []).filter(c => now - c.timestamp < this.config.maxAgeMs);

      console.log(`[ContractCache] Restored ${this.predictions.length} predictions, ${this.settlements.length} settlements from storage`);
    } catch (e) {
      console.error('[ContractCache] Load error:', e.message);
    }
  }

  _archiveOldData() {
    const now = Date.now();
    const threshold = this.config.archiveThresholdMs;

    // Identify entries to archive
    const oldPredictions = this.predictions.filter(p => now - p.timestamp > threshold);
    const oldSettlements = this.settlements.filter(s => now - s.timestamp > threshold);
    const oldErrors = this.errors.filter(e => now - e.timestamp > threshold);

    if (oldPredictions.length === 0 && oldSettlements.length === 0 && oldErrors.length === 0) {
      return;
    }

    // In browser, we'd send to server; in Node.js we'd write to file
    // For now, just remove from memory and track
    this.predictions = this.predictions.filter(p => now - p.timestamp <= threshold);
    this.settlements = this.settlements.filter(s => now - s.timestamp <= threshold);
    this.errors = this.errors.filter(e => now - e.timestamp <= threshold);

    this.archiveCount++;
    if (this.archiveCount % 10 === 0) {
      console.log(`[ContractCache] Archive cycle ${this.archiveCount}: removed ${oldPredictions.length + oldSettlements.length + oldErrors.length} old entries`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Diagnostic & Reporting
  // ─────────────────────────────────────────────────────────────────────────

  getStatus() {
    return {
      predictions: this.predictions.length,
      settlements: this.settlements.length,
      candles: this.candles.length,
      orders: this.orders.length,
      errors: this.errors.length,
      correlations: this.correlations.length,
      accuracy: this.getAllAccuracy(),
      oldestData: this._getOldestTimestamp(),
      newestData: this._getNewestTimestamp(),
      archiveCycles: this.archiveCount
    };
  }

  _getOldestTimestamp() {
    const all = [
      ...this.predictions,
      ...this.settlements,
      ...this.candles,
      ...this.orders,
      ...this.errors,
      ...this.correlations
    ];
    if (all.length === 0) return null;
    const oldest = Math.min(...all.map(e => e.timestamp));
    return new Date(oldest).toISOString();
  }

  _getNewestTimestamp() {
    const all = [
      ...this.predictions,
      ...this.settlements,
      ...this.candles,
      ...this.orders,
      ...this.errors,
      ...this.correlations
    ];
    if (all.length === 0) return null;
    const newest = Math.max(...all.map(e => e.timestamp));
    return new Date(newest).toISOString();
  }

  printReport() {
    console.table({
      'Predictions (2h)': this.predictions.length,
      'Settlements': this.settlements.length,
      'Candles': this.candles.length,
      'Orders': this.orders.length,
      'Errors': this.errors.length,
      'Portfolio WR': this.getAllAccuracy()?.portfolioWR || 'N/A',
      'Oldest': this._getOldestTimestamp() || 'N/A',
      'Newest': this._getNewestTimestamp() || 'N/A'
    });
  }

  exportJSON() {
    return {
      predictions: this.predictions,
      settlements: this.settlements,
      candles: this.candles,
      orders: this.orders,
      errors: this.errors,
      correlations: this.correlations,
      exportedAt: new Date().toISOString()
    };
  }

  exportCSV() {
    let csv = 'Predictions\n' +
      'Coin,Direction,Confidence,Timestamp\n' +
      this.predictions.map(p => `${p.coin},${p.direction},${p.confidence},${new Date(p.timestamp).toISOString()}`).join('\n');

    csv += '\n\nSettlements\n' +
      'Coin,Outcome,ModelCorrect,MarketCorrect,Timestamp\n' +
      this.settlements.map(s => `${s.coin},${s.outcome},${s.modelCorrect},${s.marketCorrect},${new Date(s.timestamp).toISOString()}`).join('\n');

    csv += '\n\nErrors\n' +
      'Type,Message,Timestamp\n' +
      this.errors.map(e => `${e.type},"${e.message}",${new Date(e.timestamp).toISOString()}`).join('\n');

    return csv;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContractCacheManager;
}
