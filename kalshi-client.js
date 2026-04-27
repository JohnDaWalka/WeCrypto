/**
 * Kalshi Unified Client
 * 
 * Combines REST (portfolio management) and WebSocket (real-time data) into single facade.
 * 
 * Usage:
 *   window.KalshiClient = new KalshiClient(apiKeyId, privateKeyPem);
 *   await window.KalshiClient.connect();
 *   window.KalshiClient.subscribe('ticker', ['INXUSD', 'FED-23DEC-T3.00']);
 *   window.addEventListener('kalshi:balance', e => console.log(e.detail.balance));
 */

class KalshiClient {
  constructor(apiKeyId, privateKeyPem, environment = 'production') {
    this.apiKeyId = apiKeyId;
    this.privateKeyPem = privateKeyPem;
    this.environment = environment;
    
    // State
    this.isConnected = false;
    this.state = {
      balance: null,
      positions: {},
      orders: [],
      subscriptions: [],
      tickers: {},
      orderbooks: {},
      trades: [],
      fills: [],
      errors: []
    };
    
    // Initialize modules
    this.rest = null;
    this.ws = null;
    
    // Event tracking
    this.eventCounts = {
      'kalshi:balance': 0,
      'kalshi:position': 0,
      'kalshi:order': 0,
      'kalshi:ticker': 0,
      'kalshi:trade': 0,
      'kalshi:orderbook': 0,
      'kalshi:error': 0
    };
  }

  /**
   * Initialize and connect both REST and WebSocket
   */
  async connect() {
    try {
      console.log('[KalshiClient] Connecting to Kalshi...');
      
      // Initialize REST client
      const KalshiRestClient = require('./kalshi-rest.js');
      this.rest = new KalshiRestClient(
        this.apiKeyId,
        this.privateKeyPem,
        this.environment
      );
      
      // Initialize WebSocket client
      if (!window.KalshiWS) {
        throw new Error('KalshiWS not found in window. Load kalshi-ws.js first.');
      }
      this.ws = window.KalshiWS;
      
      // Health check
      const healthCheck = await this.rest.healthCheck();
      if (healthCheck.status !== 'healthy') {
        throw new Error(`REST connection unhealthy: ${healthCheck.error}`);
      }
      
      // Fetch initial data
      const balanceRes = await this.rest.getBalance();
      if (balanceRes.success) {
        this.state.balance = balanceRes.data;
        this.dispatchEvent('kalshi:balance', { balance: this.state.balance });
      }
      
      // Connect WebSocket
      await this.ws.connect();
      
      // Listen to WS events
      this.setupEventListeners();
      
      this.isConnected = true;
      console.log('[KalshiClient] Connected successfully');
      
      this.dispatchEvent('kalshi:connected', {
        timestamp: Date.now(),
        environment: this.environment
      });
      
      return true;
    } catch (error) {
      console.error('[KalshiClient] Connection failed:', error.message);
      this.dispatchEvent('kalshi:error', {
        type: 'connection',
        message: error.message
      });
      return false;
    }
  }

  /**
   * Setup event listeners for WebSocket
   */
  setupEventListeners() {
    // Ticker updates
    window.addEventListener('kalshi:ticker', (e) => {
      const ticker = e.detail;
      this.state.tickers[ticker.market_ticker] = ticker;
      this.eventCounts['kalshi:ticker']++;
    });

    // Trade updates
    window.addEventListener('kalshi:trade', (e) => {
      const trade = e.detail;
      this.state.trades.push(trade);
      if (this.state.trades.length > 1000) {
        this.state.trades = this.state.trades.slice(-1000);
      }
      this.eventCounts['kalshi:trade']++;
    });

    // Orderbook updates
    window.addEventListener('kalshi:orderbook', (e) => {
      const orderbook = e.detail;
      this.state.orderbooks[orderbook.market_ticker] = orderbook;
      this.eventCounts['kalshi:orderbook']++;
    });

    // Error handling
    window.addEventListener('kalshi:error', (e) => {
      const error = e.detail;
      this.state.errors.push({
        ...error,
        timestamp: Date.now()
      });
      if (this.state.errors.length > 100) {
        this.state.errors = this.state.errors.slice(-100);
      }
      this.eventCounts['kalshi:error']++;
    });
  }

  /**
   * Subscribe to market data channel
   */
  subscribe(channel, marketTickers = []) {
    if (!this.ws) {
      console.error('[KalshiClient] WebSocket not initialized');
      return false;
    }
    
    try {
      const sid = this.ws.subscribe(channel, { market_tickers: marketTickers });
      this.state.subscriptions.push({
        sid,
        channel,
        markets: marketTickers,
        subscribedAt: Date.now()
      });
      
      console.log(`[KalshiClient] Subscribed to ${channel} (sid=${sid})`);
      this.dispatchEvent('kalshi:subscribed', {
        channel,
        sid,
        marketCount: marketTickers.length
      });
      
      return sid;
    } catch (error) {
      console.error(`[KalshiClient] Subscribe failed for ${channel}:`, error.message);
      this.dispatchEvent('kalshi:error', {
        type: 'subscription',
        channel,
        message: error.message
      });
      return null;
    }
  }

  /**
   * Unsubscribe from market data
   */
  unsubscribe(sid) {
    if (!this.ws) return false;
    
    try {
      this.ws.unsubscribe([sid]);
      this.state.subscriptions = this.state.subscriptions.filter(s => s.sid !== sid);
      console.log(`[KalshiClient] Unsubscribed from sid=${sid}`);
      return true;
    } catch (error) {
      console.error('[KalshiClient] Unsubscribe failed:', error.message);
      return false;
    }
  }

  /**
   * Get current balance (refreshes from REST)
   */
  async getBalance() {
    if (!this.rest) return null;
    
    const res = await this.rest.getBalance();
    if (res.success) {
      this.state.balance = res.data;
      this.dispatchEvent('kalshi:balance', { balance: this.state.balance });
      return res.data;
    }
    return null;
  }

  /**
   * Get positions
   */
  async getPositions() {
    if (!this.rest) return [];
    
    const res = await this.rest.getPositions();
    if (res.success) {
      const positions = res.data?.positions || [];
      this.state.positions = positions.reduce((acc, pos) => {
        acc[pos.market_ticker] = pos;
        return acc;
      }, {});
      return positions;
    }
    return [];
  }

  /**
   * Place order
   */
  async placeOrder(orderRequest) {
    if (!this.rest) return null;
    
    try {
      const res = await this.rest.placeOrder(orderRequest);
      if (res.success) {
        this.dispatchEvent('kalshi:order', {
          type: 'created',
          orderId: res.orderId,
          ...orderRequest
        });
        return res.data;
      }
      return null;
    } catch (error) {
      this.dispatchEvent('kalshi:error', {
        type: 'order',
        message: error.message
      });
      return null;
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    if (!this.rest) return null;
    
    try {
      const res = await this.rest.cancelOrder(orderId);
      if (res.success) {
        this.dispatchEvent('kalshi:order', {
          type: 'cancelled',
          orderId
        });
        return true;
      }
      return false;
    } catch (error) {
      this.dispatchEvent('kalshi:error', {
        type: 'cancel',
        message: error.message
      });
      return false;
    }
  }

  /**
   * Get latest ticker for market
   */
  getTicker(marketTicker) {
    return this.state.tickers[marketTicker] || null;
  }

  /**
   * Get orderbook for market
   */
  getOrderbook(marketTicker) {
    return this.state.orderbooks[marketTicker] || null;
  }

  /**
   * Get recent trades
   */
  getTrades(limit = 50) {
    return this.state.trades.slice(-limit);
  }

  /**
   * Dispatch custom event
   */
  dispatchEvent(eventName, detail) {
    const event = new CustomEvent(eventName, { detail });
    window.dispatchEvent(event);
  }

  /**
   * Get client state
   */
  getState() {
    return {
      isConnected: this.isConnected,
      environment: this.environment,
      balance: this.state.balance,
      positions: Object.keys(this.state.positions).length,
      subscriptions: this.state.subscriptions.length,
      latestTickers: Object.keys(this.state.tickers).length,
      recentTrades: this.state.trades.length,
      errors: this.state.errors.length,
      eventCounts: this.eventCounts,
      restMetrics: this.rest?.getHealthMetrics() || null
    };
  }

  /**
   * Disconnect cleanly
   */
  async disconnect() {
    try {
      if (this.ws) {
        await this.ws.disconnect();
      }
      this.isConnected = false;
      console.log('[KalshiClient] Disconnected');
      return true;
    } catch (error) {
      console.error('[KalshiClient] Disconnect error:', error.message);
      return false;
    }
  }
}

// Export to window
if (typeof window !== 'undefined') {
  window.KalshiClient = KalshiClient;
}

// Also export for Node.js/Electron
if (typeof module !== 'undefined' && module.exports) {
  module.exports = KalshiClient;
}
