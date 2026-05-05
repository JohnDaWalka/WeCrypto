/**
 * Historical Settlement Fetcher
 * 
 * Pulls SETTLED contracts from Kalshi, Polymarket, and Coinbase Prediction Markets
 * to build historical accuracy scorecard showing model performance over time.
 * 
 * NOT waiting for new contracts to close — fetching what already settled.
 */

class HistoricalSettlementFetcher {
  constructor() {
    this.kalshiBase = 'https://api.elections.kalshi.com/trade-api/v2';
    this.polyBase = 'https://gamma-api.polymarket.com';
    this.coinbaseBase = 'https://api.exchange.coinbase.com';
    
    // Cache for settled contracts (avoid redundant API calls)
    this.settledCache = {
      kalshi: [],
      polymarket: [],
      coinbase: [],
    };
    
    this.lastFetch = {
      kalshi: 0,
      polymarket: 0,
      coinbase: 0,
    };
    
    this.cacheTTL = 300_000; // 5 minutes
    
    console.log('[HistoricalSettlementFetcher] Initialized');
  }

  /**
   * Fetch settled Kalshi markets from last N hours
   * Returns array of { ticker, symbol, outcome, settlePrice, settleTime }
   */
  async fetchKalshiSettled(hoursBack = 24, limit = 100) {
    const now = Date.now();
    
    // Check cache
    if (this.settledCache.kalshi.length > 0 && now - this.lastFetch.kalshi < this.cacheTTL) {
      console.log(`[HistoricalFetcher] Using Kalshi cache (${this.settledCache.kalshi.length} settled contracts)`);
      return this.settledCache.kalshi;
    }
    
    try {
      // Kalshi markets endpoint filters by status
      const url = `${this.kalshiBase}/markets?status=settled&limit=${limit}`;
      const response = await fetch(url, { timeout: 8000 });
      
      if (!response.ok) {
        console.error(`[HistoricalFetcher] Kalshi API error: ${response.status}`);
        return [];
      }
      
      const data = await response.json();
      const markets = data.markets || [];
      
      const settled = markets
        .filter(m => {
          // Only 15M crypto markets
          if (!m.ticker) return false;
          if (!m.ticker.includes('15M')) return false;
          if (!['BTC', 'ETH', 'SOL', 'XRP'].some(sym => m.ticker.includes(sym))) return false;  // 4-coin focus
          if (m.status !== 'settled') return false;
          return true;
        })
        .map(m => {
          // Extract coin symbol from ticker (e.g., "KXBTC15M220430" → "BTC")
          const symMatch = m.ticker.match(/KX(\w+)15M/);
          const symbol = symMatch ? symMatch[1] : null;
          
          return {
            source: 'kalshi',
            ticker: m.ticker,
            symbol,
            status: m.status,
            result: m.result, // 'YES' or 'NO'
            floorPrice: m.floor_price,
            strikeType: m.strike_type,
            settleTime: m.close_time ? new Date(m.close_time).getTime() : null,
            createdAt: m.created_at ? new Date(m.created_at).getTime() : null,
            expiresAt: m.expires_at ? new Date(m.expires_at).getTime() : null,
            // Raw market object for debugging
            raw: m,
          };
        })
        .slice(0, 50); // Keep most recent 50
      
      this.settledCache.kalshi = settled;
      this.lastFetch.kalshi = now;
      
      console.log(`[HistoricalFetcher] Fetched ${settled.length} settled Kalshi 15M markets`);
      return settled;
    } catch (err) {
      console.error('[HistoricalFetcher] Kalshi fetch error:', err.message);
      return this.settledCache.kalshi; // Return cache on error
    }
  }

  /**
   * Fetch resolved Polymarket markets for crypto predictions
   * Returns array of { marketId, symbol, outcome, resolvedTime }
   */
  async fetchPolymarketSettled(hoursBack = 24, limit = 100) {
    const now = Date.now();
    
    // Check cache
    if (this.settledCache.polymarket.length > 0 && now - this.lastFetch.polymarket < this.cacheTTL) {
      console.log(`[HistoricalFetcher] Using Polymarket cache (${this.settledCache.polymarket.length} resolved markets)`);
      return this.settledCache.polymarket;
    }
    
    try {
      // Polymarket markets endpoint
      const url = `${this.polyBase}/markets?status=resolved&limit=${limit}`;
      const response = await fetch(url, { timeout: 8000 });
      
      if (!response.ok) {
        console.error(`[HistoricalFetcher] Polymarket API error: ${response.status}`);
        return [];
      }
      
      const markets = await response.json();
      
      const resolved = markets
        .filter(m => {
          // Only crypto prediction markets
          if (!m.title) return false;
          if (m.closed_time == null) return false;
          if (m.resolved_by_source !== 'AMM' && !m.resolutionSources) return false;
          return ['BTC', 'ETH', 'SOL', 'XRP'].some(sym =>  // 4-coin focus
            m.title.toUpperCase().includes(sym)
          );
        })
        .map(m => {
          // Extract symbol from title
          const symMatch = m.title.match(/(BTC|ETH|SOL|XRP|DOGE|BNB)/i);
          const symbol = symMatch ? symMatch[1].toUpperCase() : null;
          
          // Determine outcome from outcome prices
          const outcomeYes = m.outcomePrices?.[0] ?? 0;
          const outcomeNo = m.outcomePrices?.[1] ?? 0;
          const outcome = outcomeYes > outcomeNo ? 'YES' : 'NO';
          
          return {
            source: 'polymarket',
            marketId: m.id,
            symbol,
            title: m.title,
            outcome,
            outcomePrices: m.outcomePrices,
            resolvedTime: m.closed_time ? new Date(m.closed_time).getTime() : null,
            createdAt: m.created_at ? new Date(m.created_at).getTime() : null,
            // Raw market object for debugging
            raw: m,
          };
        })
        .slice(0, 50); // Keep most recent 50
      
      this.settledCache.polymarket = resolved;
      this.lastFetch.polymarket = now;
      
      console.log(`[HistoricalFetcher] Fetched ${resolved.length} resolved Polymarket crypto markets`);
      return resolved;
    } catch (err) {
      console.error('[HistoricalFetcher] Polymarket fetch error:', err.message);
      return this.settledCache.polymarket; // Return cache on error
    }
  }

  /**
   * Fetch settled Coinbase Prediction Markets
   */
  async fetchCoinbasePredictionsSettled(hoursBack = 24, limit = 50) {
    const now = Date.now();
    
    // Check cache
    if (this.settledCache.coinbase.length > 0 && now - this.lastFetch.coinbase < this.cacheTTL) {
      console.log(`[HistoricalFetcher] Using Coinbase cache (${this.settledCache.coinbase.length} settled predictions)`);
      return this.settledCache.coinbase;
    }
    
    try {
      // Coinbase prediction markets endpoint
      const url = `${this.coinbaseBase}/predictions?status=settled&limit=${limit}`;
      const response = await fetch(url, { timeout: 8000 });
      
      if (!response.ok) {
        console.error(`[HistoricalFetcher] Coinbase API error: ${response.status}`);
        return [];
      }
      
      const data = await response.json();
      const markets = data.predictions || [];
      
      const settled = markets
        .filter(m => {
          if (!m.title) return false;
          return ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'].some(sym =>
            m.title.toUpperCase().includes(sym)
          );
        })
        .map(m => {
          const symMatch = m.title.match(/(BTC|ETH|SOL|XRP|DOGE|BNB)/i);
          const symbol = symMatch ? symMatch[1].toUpperCase() : null;
          
          return {
            source: 'coinbase',
            marketId: m.id,
            symbol,
            title: m.title,
            outcome: m.winning_outcome, // 'YES' or 'NO'
            settleTime: m.settled_at ? new Date(m.settled_at).getTime() : null,
            createdAt: m.created_at ? new Date(m.created_at).getTime() : null,
            raw: m,
          };
        })
        .slice(0, 50);
      
      this.settledCache.coinbase = settled;
      this.lastFetch.coinbase = now;
      
      console.log(`[HistoricalFetcher] Fetched ${settled.length} settled Coinbase predictions`);
      return settled;
    } catch (err) {
      console.error('[HistoricalFetcher] Coinbase fetch error:', err.message);
      return this.settledCache.coinbase;
    }
  }

  /**
   * Fetch all settled markets from all sources
   */
  async fetchAllSettled(hoursBack = 24) {
    const [kalshi, polymarket, coinbase] = await Promise.all([
      this.fetchKalshiSettled(hoursBack),
      this.fetchPolymarketSettled(hoursBack),
      this.fetchCoinbasePredictionsSettled(hoursBack),
    ]);
    
    return {
      kalshi,
      polymarket,
      coinbase,
      total: kalshi.length + polymarket.length + coinbase.length,
      timestamp: Date.now(),
    };
  }

  /**
   * Calculate accuracy against model predictions
   * Compares settled outcomes to window._lastPrediction for each coin
   */
  calculateAccuracy(settledMarkets) {
    const predictions = window._lastPrediction || {};
    const accuracy = {};
    
    // Group by coin symbol
    const byCoin = {};
    for (const market of settledMarkets) {
      const sym = market.symbol;
      if (!sym) continue;
      if (!byCoin[sym]) byCoin[sym] = [];
      byCoin[sym].push(market);
    }
    
    // Calculate per-coin accuracy
    for (const [sym, markets] of Object.entries(byCoin)) {
      const pred = predictions[sym];
      if (!pred) {
        accuracy[sym] = {
          symbol: sym,
          total: markets.length,
          correct: 0,
          accuracy: 0,
          prediction: null,
        };
        continue;
      }
      
      const modelDir = pred.direction; // 'UP' or 'DOWN'
      let correct = 0;
      
      for (const m of markets) {
        // Kalshi: result is 'YES' or 'NO'
        let marketDir = null;
        if (m.source === 'kalshi') {
          const strike = String(m.strikeType ?? m.raw?.strike_type ?? 'above').toLowerCase();
          const yesDir = strike === 'below' ? 'DOWN' : 'UP';
          const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
          marketDir = String(m.result).toUpperCase() === 'YES' ? yesDir : noDir;
        } else {
          // Polymarket and Coinbase: outcome is already 'YES' or 'NO' (price up/down)
          marketDir = m.outcome === 'YES' ? 'UP' : 'DOWN';
        }
        
        if (marketDir === modelDir) {
          correct++;
        }
      }
      
      accuracy[sym] = {
        symbol: sym,
        total: markets.length,
        correct,
        accuracy: Math.round((correct / markets.length) * 1000) / 10, // percentage with 1 decimal
        prediction: modelDir,
      };
    }
    
    return accuracy;
  }

  /**
   * Get scorecard-ready data
   */
  async getScorecard() {
    const settled = await this.fetchAllSettled();
    
    // Flatten to single array
    const allSettled = [
      ...settled.kalshi,
      ...settled.polymarket,
      ...settled.coinbase,
    ];
    
    // Group by coin
    const byCoin = {};
    for (const market of allSettled) {
      const sym = market.symbol;
      if (!sym) continue;
      if (!byCoin[sym]) {
        byCoin[sym] = {
          symbol: sym,
          settled: [],
          accuracy: null,
        };
      }
      byCoin[sym].settled.push(market);
    }
    
    // Calculate accuracy per coin
    const scorecard = {};
    for (const [sym, data] of Object.entries(byCoin)) {
      const pred = window._lastPrediction?.[sym];
      const modelDir = pred?.direction;
      
      let correct = 0;
      for (const m of data.settled) {
        let marketDir;
        if (m.source === 'kalshi') {
          const strike = String(m.strikeType ?? m.raw?.strike_type ?? 'above').toLowerCase();
          const yesDir = strike === 'below' ? 'DOWN' : 'UP';
          const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
          marketDir = String(m.result).toUpperCase() === 'YES' ? yesDir : noDir;
        } else {
          marketDir = m.outcome === 'YES' ? 'UP' : 'DOWN';
        }
        if (marketDir === modelDir) correct++;
      }
      
      scorecard[sym] = {
        symbol: sym,
        total: data.settled.length,
        correct,
        accuracy: data.settled.length > 0 ? Math.round((correct / data.settled.length) * 1000) / 10 : 0,
        prediction: modelDir,
        recentMarkets: data.settled.slice(0, 5), // Last 5 for detail
      };
    }
    
    // Feed accuracy data into adaptive learning engine
    if (typeof window !== 'undefined' && window.AdaptiveLearner) {
      for (const [sym, scoreData] of Object.entries(scorecard)) {
        const pred = window._lastPrediction?.[sym];
        if (pred && scoreData.total > 0) {
          // Record this batch of contracts to adaptive engine
          const wasCorrect = scoreData.correct === scoreData.total; // Simplified: all correct or not
          const signals = pred.signals || {};
          window.AdaptiveLearner.recordSignalContribution(sym, signals, wasCorrect);
        }
      }
      
      // Trigger auto-tuning if it's time
      const tuneEvent = window.AdaptiveLearner.autoTuneWeights();
      if (tuneEvent && Object.keys(tuneEvent.adjustments).length > 0) {
        window._lastTuneEvent = tuneEvent;
      }
    }
    
    return {
      timestamp: Date.now(),
      scorecard,
      totalSettled: allSettled.length,
      sources: {
        kalshi: settled.kalshi.length,
        polymarket: settled.polymarket.length,
        coinbase: settled.coinbase.length,
      },
    };
  }

  /**
   * Get diagnostics
   */
  getDiagnostics() {
    return {
      cache: {
        kalshi: this.settledCache.kalshi.length,
        polymarket: this.settledCache.polymarket.length,
        coinbase: this.settledCache.coinbase.length,
      },
      lastFetch: this.lastFetch,
      cacheTTL: this.cacheTTL,
    };
  }

  /**
   * Unified fetch for all settled contracts with error handling
   * Used by adaptive learning polling cycle
   */
  async fetchSettledContracts() {
    try {
      const all = await this.fetchAllSettled();
      const settled = [
        ...all.kalshi,
        ...all.polymarket,
        ...all.coinbase,
      ];
      
      return {
        settled: settled.map(s => ({
          symbol: s.symbol,
          source: s.source,
          result: s.result || s.outcome, // Kalshi: result, Polymarket/Coinbase: outcome
          openTime: s.createdAt || s.created_at,
          closeTime: s.resolvedTime || s.settleTime || s.closed_time,
          raw: s,
        })),
        errors: [],
      };
    } catch (err) {
      console.error('[HistoricalSettlementFetcher] fetchSettledContracts error:', err);
      return {
        settled: [],
        errors: [{ source: 'multi', error: err.message }],
      };
    }
  }
}

// Export globally
if (typeof window !== 'undefined') {
  window.HistoricalSettlementFetcher = HistoricalSettlementFetcher;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HistoricalSettlementFetcher;
}

console.log('[HistoricalSettlementFetcher] Module loaded');
