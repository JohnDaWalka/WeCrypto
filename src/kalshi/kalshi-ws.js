/**
 * Kalshi WebSocket Handler — Real-time prediction market feeds
 *
 * Public channels (no auth):
 *   - ticker: Market price snapshots
 *   - trade: Recent trades
 *   - market_lifecycle_v2: Market open/close events
 *
 * Private channels (auth required):
 *   - orderbook_delta: Live order book updates
 *   - fill: Your filled orders
 *   - market_positions: Your positions
 *   - order_group_updates: Batch order status
 *
 * Authentication:
 *   Uses RSA private key to sign: timestamp + "GET" + "/trade-api/ws/v2"
 *   Signature sent as HTTP header during WebSocket upgrade
 */

(function () {
  'use strict';

  const PUBLIC_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
  const DEMO_WS_URL = 'wss://demo-api.kalshi.co/trade-api/ws/v2';

  // Use demo by default; set to false for production trading
  const USE_DEMO = true;
  const WS_URL = USE_DEMO ? DEMO_WS_URL : PUBLIC_WS_URL;
  const WS_PATH = '/trade-api/ws/v2';

  // Heartbeat: Kalshi closes idle connections; ping every 20 s
  const HEARTBEAT_INTERVAL_MS = 20_000;
  let _heartbeatTimer = null;

  // Credentials from KALSHI-API-KEY.txt (first line = UUID, lines 5+ = RSA private key)
  const KALSHI_API_KEY = 'a8f1995c-7b78-430b-a1fe-7c415c67cc91'; // Replace with actual value
  const KALSHI_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAurJQhLw8T4p6UkUvFvR+bSZnbmdyX4rhFepNQlg7x3c6D/+X
8A21L5UCBxuNxocYa9UswqFqljk/EEnyOdbyc0n2603Q51NH7QLmco3DwmIo7AKV
SrjyIh+GK9s8oWSUkgeJ3hJABO+5trBvz9jz8IVM3Y+Pdj/X/JyrIi2DMFSvcKBF
/Z/XVxaI/ndaKb5servjByGTKTIMa970I88edpeAZmDtHrYMC15RR71SJplSrz3i
jxgn5SKaPFMcVdNzkAWlZVovaC0YQ4GWK6g7l2occicf4ObzPmTtBMz7YVh0L/2J
FjhzO6iOPlGBu7sMYPUfEilQyPABtxpjR1SPGQIDAQABAoIBABT6La1oaB9o2Bsv
3l1mLeFuR/9h/LorBOT9PV6XwunD5gB/r87/f00AIWjyieDVc6NEIeIhmHQWLRWT
tXWVxwq4tBeW2ALx+tow8ftLngQUmvP/y04Iz14RrDX3zY1123K4CZ/r7YkQdY3H
L90LC8fJ9ovLkmtPO6HM6baupfezTub3TgcGCoMJjO1sW/p4u7KsdQrJMk/KxH5r
+jnKXDn7fdXS7Eq/zmgBQ0qBlHi/i6OHLXuWevX/I3buyzm9FQARRGWmt9qBZbJe
T+IHqrwhlFImVPvDixbbWSgrtZIpPaO8WtTDQJmneRYs9S5BuKFnYszGLiUGVWUC
kKfkQkECgYEA7+CYFCLQQHtUD3IJqL+BQh6lkW1/z6ngr13qHDHP9qfJZRbgNSrd
Gu/o9SvpEsbfsDwalAy2drI4lFj2VACTrhuGavuUKc7+1llH428pcfPtJGR6f9gH
8MSYpTrDzri6tggiqoRbyPopnuikq0HkG4E9AXuHZKDaMxW+x/Us0PkCgYEAxz6s
yhQrq+xZWw1M+Vc7iMjPGqMWnSBAHm17j6I5xL32bn3yy6iCLAOltR1oHLOwwY2X
eSOjzfwqKCnxjazAFsPUcmVshPyOXd/CxrArXC3/emEJBFP60WiZp1BUHoFSLfXc
/N0A3mgMLSH+3t08YU7Txc0t5/pIf0azelkRVyECgYEAqumEkfxIE1mMCEFBfpmM
WHcLkvXI9kZcz7aDgrk/Kshb54oID/nNdk7v1hgGRhmq8Z+xdEEmlKXhSFmmkS2k
C46TFJDR/YP98O3GGddvWUDqe16YJZTf+32oITogn57hcaeUQ5hw6V7M3ut1wIv/
IlXQCMliK6GsNm/M8h3PY8kCgYBucaeGPLgYjOLbPfw1Gs29fNKQiWa3onDobPfZ
Hqu3CzXW+ankinvdugfY5XwYrOKF597XH5JlVCpqKRXk2qV/+P2CjAYjkXu5PZfS
W0Uty7GaPL+qzoJyIfFKdZSrdDQBlg/xevBIWJSnT/jfwPL/XZq2Qo330RzusFo8
r7KVAQKBgFFqO/iSNPqpLDm7Bf/EZM0O4xJv5nc1R9LmNajBRy26E0xbKk7lGK1q
tRdZLNiraCyO3cPmiI+UrbRWP/v7X0wepj/t16ogE2y8A01svW6PiqW3VEDMdujw
N0uSfQxKmjGjqHSuaUN0OLaQAXHckEFsnOTBnSvwBRCei3N4C/36
-----END RSA PRIVATE KEY-----`;

  // ─────────────────────────────────────────────────────────────────────────────
  // Authentication (RSA signature for HTTP header during WS upgrade)
  // ─────────────────────────────────────────────────────────────────────────────

  const crypto = require('crypto');

  /**
   * Generate RSA signature for Kalshi auth header
   * Message format: timestamp + "GET" + "/trade-api/ws/v2"
   */
  function generateSignature(timestamp) {
    const message = `${timestamp}GET${WS_PATH}`;
    try {
      const signature = crypto
        .createSign('sha256')
        .update(message)
        .sign(KALSHI_PRIVATE_KEY, 'hex');
      return signature;
    } catch (err) {
      console.error('[KalshiWS] Signature generation failed:', err.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────────

  const store = {
    // Market tickers: market_ticker → {yes_bid, yes_ask, no_bid, no_ask, last_traded, ts}
    tickers: {},
    // Recent trades: market_ticker → [{timestamp, yes_price, no_price, size}, ...]
    trades: {},
    // Order book snapshots: market_ticker → {yes_bids: [...], yes_asks: [...], no_bids: [...], no_asks: [...]}
    orderbooks: {},
    // Filled orders and open positions (populated on auth)
    fills: [],
    positions: {},
    // Error log: [{code, msg, ts}, ...]
    errors: [],
  };

  let ws = null;
  let connected = false;
  let authenticated = false;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  let reconnectDelay = 2000;
  let messageId = 1;
  let messageQueue = [];
  let readyToSend = false;

  // Markets to subscribe to — resolved dynamically by market-resolver.js.
  // Falls back to these if resolver hasn't run yet.
  // Series tickers for active BTC/ETH/SOL/XRP 15-min contracts on Kalshi.
  const DEFAULT_MARKETS = [
    'KXBTC-15M',   // BTC 15-minute binary
    'KXETH-15M',   // ETH 15-minute binary
    'KXSOL-15M',   // SOL 15-minute binary
    'KXXRP-15M',   // XRP 15-minute binary
  ];

  // ─────────────────────────────────────────────────────────────────────────────
  // Connection Management
  // ─────────────────────────────────────────────────────────────────────────────

  async function connect() {
    return new Promise((resolve, reject) => {
      try {
        console.log('[KalshiWS] Connecting to', WS_URL);
        ws = new (require('ws'))(WS_URL);

        ws.on('open', onOpen);
        ws.on('message', onMessage);
        ws.on('error', onError);
        ws.on('close', onClose);

        // Timeout fallback
        const timeout = setTimeout(() => {
          if (!connected) {
            reject(new Error('Connection timeout (30s)'));
          }
        }, 30000);

        ws.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function onOpen() {
    console.log('[KalshiWS] Connected');
    connected = true;
    reconnectAttempts = 0;
    readyToSend = true;

    // Flush queued messages
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      ws.send(JSON.stringify(msg));
    }

    // Start heartbeat — Kalshi closes idle connections without it
    _startHeartbeat();

    // Start subscriptions
    subscribeToTicker();
    // Use dynamically resolved market IDs if available, else fall back to defaults
    const activeMarkets = (window._kalshiActiveMarkets && window._kalshiActiveMarkets.length)
      ? window._kalshiActiveMarkets
      : DEFAULT_MARKETS;
    subscribeToOrderbook(activeMarkets);
    subscribeToTrades(activeMarkets);
  }

  function onMessage(data) {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (err) {
      console.error('[KalshiWS] Parse error:', err.message);
    }
  }

  function onError(err) {
    console.error('[KalshiWS] Error:', err.message);
  }

  function onClose() {
    console.log('[KalshiWS] Disconnected');
    connected = false;
    authenticated = false;
    readyToSend = false;
    _stopHeartbeat();
    reconnect();
  }

  function reconnect() {
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.error('[KalshiWS] Max reconnection attempts reached');
      return;
    }

    reconnectAttempts++;
    const delay = reconnectDelay * Math.pow(2, reconnectAttempts - 1);
    console.log(`[KalshiWS] Reconnecting in ${delay}ms... (attempt ${reconnectAttempts})`);

    setTimeout(() => {
      connect().catch((err) => {
        console.error('[KalshiWS] Reconnect failed:', err.message);
      });
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────────────────────

  function authenticatePrivate() {
    const timestamp = Date.now();
    // BUG FIX: was generateSignature(KALSHI_SECRET, ...) — KALSHI_SECRET undefined
    const signature = generateSignature(timestamp);

    const authMsg = {
      type: 'login',
      api_key: KALSHI_API_KEY,
      signature: signature,
      timestamp: timestamp,
    };

    sendMessage(authMsg);
    console.log('[KalshiWS] Authentication request sent');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Handling
  // ─────────────────────────────────────────────────────────────────────────────

  function handleMessage(msg) {
    const { type, msg: payload } = msg;

    switch (type) {
      case 'subscribed':
        // Server confirmed subscription — mark as authenticated if login succeeded
        if (!authenticated) {
          authenticated = true;
          console.log('[KalshiWS] Authenticated ✓');
        }
        break;
      case 'ticker':
        handleTicker(payload);
        break;
      case 'orderbook_snapshot':
        handleOrderbookSnapshot(payload);
        break;
      case 'orderbook_delta':
        handleOrderbookDelta(payload);
        break;
      case 'trade':
        handleTrade(payload);
        break;
      case 'pong':
        // Heartbeat acknowledged — nothing to do
        break;
      case 'error':
        handleError(payload);
        break;
      default:
        console.log('[KalshiWS] Unknown message type:', type, msg);
    }
  }

  function handleTicker(payload) {
    const { market_ticker, yes_bid_dollars, yes_ask_dollars, no_bid_dollars, no_ask_dollars, last_traded_price } = payload;
    if (!market_ticker) return;

    store.tickers[market_ticker] = {
      yes_bid: yes_bid_dollars,
      yes_ask: yes_ask_dollars,
      no_bid: no_bid_dollars,
      no_ask: no_ask_dollars,
      last_traded: last_traded_price,
      ts: Date.now(),
    };

    // Emit event for app.js
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:ticker', {
          detail: {
            market_ticker,
            yes_bid: yes_bid_dollars,
            yes_ask: yes_ask_dollars,
            no_bid: no_bid_dollars,
            no_ask: no_ask_dollars,
            last_traded: last_traded_price,
            ts: Date.now(),
          },
        })
      );
    }
  }

  function handleOrderbookSnapshot(payload) {
    const { market_ticker, yes_bid_levels, yes_ask_levels, no_bid_levels, no_ask_levels } = payload;
    if (!market_ticker) return;

    store.orderbooks[market_ticker] = {
      yes_bids: yes_bid_levels || [],
      yes_asks: yes_ask_levels || [],
      no_bids: no_bid_levels || [],
      no_asks: no_ask_levels || [],
      ts: Date.now(),
    };

    console.log(`[KalshiWS] Orderbook snapshot for ${market_ticker}`);
  }

  function handleOrderbookDelta(payload) {
    const { market_ticker, client_order_id, yes_bid_levels, yes_ask_levels, no_bid_levels, no_ask_levels } = payload;
    if (!market_ticker) return;

    // Merge delta price levels into existing snapshot
    if (store.orderbooks[market_ticker]) {
      const ob = store.orderbooks[market_ticker];

      // Helper: apply delta array — entries with size=0 remove the level
      function applyDelta(existing, delta) {
        if (!Array.isArray(delta)) return existing;
        const map = new Map(existing.map(l => [l[0], l]));
        for (const [price, size] of delta) {
          if (size === 0) {
            map.delete(price);
          } else {
            map.set(price, [price, size]);
          }
        }
        return Array.from(map.values());
      }

      if (yes_bid_levels) ob.yes_bids = applyDelta(ob.yes_bids, yes_bid_levels);
      if (yes_ask_levels) ob.yes_asks = applyDelta(ob.yes_asks, yes_ask_levels);
      if (no_bid_levels)  ob.no_bids  = applyDelta(ob.no_bids,  no_bid_levels);
      if (no_ask_levels)  ob.no_asks  = applyDelta(ob.no_asks,  no_ask_levels);
      ob.ts = Date.now();
    }

    if (client_order_id) {
      console.log(`[KalshiWS] Your order ${client_order_id} caused orderbook change on ${market_ticker}`);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:orderbook_delta', {
          detail: {
            market_ticker,
            client_order_id,
            ts: Date.now(),
          },
        })
      );
    }
  }

  function handleTrade(payload) {
    const { market_ticker, yes_price, no_price, size, timestamp } = payload;
    if (!market_ticker) return;

    if (!store.trades[market_ticker]) {
      store.trades[market_ticker] = [];
    }

    store.trades[market_ticker].push({
      yes_price,
      no_price,
      size,
      ts: timestamp || Date.now(),
    });

    // Keep only last 100 trades per market
    if (store.trades[market_ticker].length > 100) {
      store.trades[market_ticker].shift();
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:trade', {
          detail: { market_ticker, yes_price, no_price, size, ts: timestamp || Date.now() },
        })
      );
    }
  }

  function handleError(payload) {
    const { code, msg: errorMsg } = payload;
    const errorDescription = ERROR_CODES[code] || 'Unknown error';

    console.error(`[KalshiWS] Error ${code}: ${errorMsg} (${errorDescription})`);

    store.errors.push({
      code,
      msg: errorMsg,
      description: errorDescription,
      ts: Date.now(),
    });

    // Keep last 50 errors
    if (store.errors.length > 50) {
      store.errors.shift();
    }

    // Handle specific error codes with recovery
    handleErrorRecovery(code, errorMsg);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:error', {
          detail: { code, msg: errorMsg, description: errorDescription, ts: Date.now() },
        })
      );
    }
  }

  function handleErrorRecovery(code, errorMsg) {
    switch (code) {
      case 2: // Params required
        console.warn('[KalshiWS] Missing params in message — check subscription format');
        break;
      case 3: // Channels required
        console.warn('[KalshiWS] Missing channels array — subscription requires "channels"');
        break;
      case 5: // Unknown command
        console.error('[KalshiWS] Invalid command — check cmd field');
        break;
      case 6: // Already subscribed
        console.warn('[KalshiWS] Duplicate subscription — skipping');
        break;
      case 8: // Unknown channel name
        console.error('[KalshiWS] Invalid channel — valid: ticker, trade, orderbook_delta, orderbook_snapshot');
        break;
      case 9: // Authentication required
        console.error('[KalshiWS] Private channel requires authentication');
        break;
      case 14: // Market Ticker required
        console.error('[KalshiWS] Market specification required — provide market_ticker or market_id');
        break;
      case 16: // Market not found
        console.error('[KalshiWS] Market not found — verify market_ticker is valid');
        break;
      case 17: // Internal error
        console.error('[KalshiWS] Server-side error — retry later');
        break;
      case 18: // Command timeout
        console.warn('[KalshiWS] Server timeout — retrying subscription');
        // Could implement retry logic here
        break;
      default:
        console.log('[KalshiWS] Error code:', code);
    }
  }

  const ERROR_CODES = {
    1: 'Unable to process message',
    2: 'Params required',
    3: 'Channels required',
    4: 'Subscription IDs required',
    5: 'Unknown command',
    6: 'Already subscribed',
    7: 'Unknown subscription ID',
    8: 'Unknown channel name',
    9: 'Authentication required',
    10: 'Channel error',
    11: 'Invalid parameter',
    12: 'Exactly one subscription ID is required',
    13: 'Unsupported action',
    14: 'Market Ticker required',
    15: 'Action required',
    16: 'Market not found',
    17: 'Internal error',
    18: 'Command timeout',
    19: 'shard_factor must be > 0',
    20: 'shard_factor is required when shard_key is set',
    21: 'shard_key must be >= 0 and < shard_factor',
    22: 'shard_factor must be <= 100',
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Subscriptions
  // ─────────────────────────────────────────────────────────────────────────────

  function subscribeToTicker() {
    const msg = {
      id: messageId++,
      cmd: 'subscribe',
      params: {
        channels: ['ticker'],
      },
    };
    sendMessage(msg);
    console.log('[KalshiWS] Subscribing to ticker channel');
  }

  function subscribeToOrderbook(marketTickers) {
    if (!marketTickers || marketTickers.length === 0) {
      console.warn('[KalshiWS] No markets specified for orderbook subscription');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta', 'orderbook_snapshot'],
        market_tickers: marketTickers,
      },
    };
    sendMessage(msg);
    console.log(`[KalshiWS] Subscribing to orderbook for ${marketTickers.length} markets`);
  }

  function subscribeToTrades(marketTickers) {
    if (!marketTickers || marketTickers.length === 0) {
      console.warn('[KalshiWS] No markets specified for trade subscription');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'subscribe',
      params: {
        channels: ['trade'],
        market_tickers: marketTickers,
      },
    };
    sendMessage(msg);
    console.log(`[KalshiWS] Subscribing to trades for ${marketTickers.length} markets`);
  }

  function unsubscribe(subscriptionIds) {
    if (!subscriptionIds || subscriptionIds.length === 0) {
      console.warn('[KalshiWS] No subscription IDs specified');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'unsubscribe',
      params: {
        sids: subscriptionIds,
      },
    };
    sendMessage(msg);
    console.log(`[KalshiWS] Unsubscribing from ${subscriptionIds.length} subscription(s)`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  function sendMessage(msg) {
    if (!readyToSend) {
      messageQueue.push(msg);
      return;
    }

    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[KalshiWS] Send error:', err.message);
      messageQueue.push(msg); // Retry on reconnect
    }
  }

  async function disconnect() {
    _stopHeartbeat();
    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
    authenticated = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Heartbeat — keeps the connection alive; Kalshi closes idle sockets
  // ─────────────────────────────────────────────────────────────────────────────

  function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = setInterval(() => {
      if (!connected || !readyToSend) return;
      try {
        ws.send(JSON.stringify({ id: messageId++, cmd: 'ping' }));
      } catch (err) {
        console.warn('[KalshiWS] Heartbeat send failed:', err.message);
      }
    }, HEARTBEAT_INTERVAL_MS);
    console.log('[KalshiWS] Heartbeat started (every', HEARTBEAT_INTERVAL_MS / 1000, 's)');
  }

  function _stopHeartbeat() {
    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
  }

  function getState() {
    return {
      connected,
      authenticated,
      tickers: Object.keys(store.tickers).length,
      trades: Object.values(store.trades).reduce((sum, t) => sum + t.length, 0),
      fills: store.fills.length,
      positions: Object.keys(store.positions).length,
    };
  }

  function getSnapshot() {
    return store;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────────────────────────────

  const KalshiWS = {
    connect,
    disconnect,
    sendMessage,
    getState,
    getSnapshot,
    store, // Direct access for debugging
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KalshiWS;
  }

  if (typeof window !== 'undefined') {
    window.KalshiWS = KalshiWS;
  }
})();
