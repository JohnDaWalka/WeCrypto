// candle-ws.js — Coinbase Advanced Trade WebSocket
// Real-time 1-min candle feed aggregated into live 15-minute buckets.
// Used as the live price standard for prediction comparison.
// No auth required — candles + ticker are public channels.
// Exposes: window.CandleWS

(function () {
  'use strict';

  const WS_URL = 'wss://advanced-trade-ws.coinbase.com';
  const BUCKET_MS = 15 * 60 * 1000;   // 15-minute window
  const MAX_BUCKETS = 200;               // ~50 hours of history per coin

  // Map Coinbase product_id → internal symbol
  const PRODUCTS = [
    'BTC-USD', 'ETH-USD', 'SOL-USD',
    'XRP-USD', 'DOGE-USD', 'BNB-USD', 'HYPE-USD'
  ];
  const SYM_MAP = {
    'BTC-USD': 'BTC',
    'ETH-USD': 'ETH',
    'SOL-USD': 'SOL',
    'XRP-USD': 'XRP',
    'DOGE-USD': 'DOGE',
    'BNB-USD': 'BNB',
    'HYPE-USD': 'HYPE'
  };

  // Per-coin state
  const store = {};
  for (const sym of Object.values(SYM_MAP)) {
    store[sym] = {
      buckets15m: [],   // [{t, o, h, l, c, v, closed}] newest last
      live1m: null, // latest 1-min candle from WS
      ticker: null  // latest ticker snapshot
    };
  }

  let ws = null;
  let connected = false;
  let reconnectTimer = null;
  let reconnectDelay = 500;    // Start at 500ms
  let reconnectCount = 0;      // Track attempt count

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function bucket15mStart(tsMs) {
    return Math.floor(tsMs / BUCKET_MS) * BUCKET_MS;
  }

  // Merge a 1-min candle into the appropriate 15-min bucket
  function upsertCandle(sym, c) {
    const buckets = store[sym].buckets15m;
    const bStart = bucket15mStart(c.t);

    let bucket = buckets.length ? buckets[buckets.length - 1] : null;

    if (!bucket || bucket.t !== bStart) {
      // Close previous bucket if it exists and is older
      if (bucket && bucket.t < bStart) {
        bucket.closed = true;
        // Dispatch event so app.js can evaluate predictions against this closed candle
        try {
          dispatchEvent(new CustomEvent('candleWS:bucketClosed', {
            detail: { sym, bucket: { ...bucket } }
          }));
        } catch { /* non-critical */ }
      }

      // Open new bucket
      bucket = { t: bStart, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, closed: false };
      buckets.push(bucket);
      if (buckets.length > MAX_BUCKETS) buckets.shift();
    } else {
      // Update live bucket — high-water mark H/L, roll close
      bucket.h = Math.max(bucket.h, c.h);
      bucket.l = Math.min(bucket.l, c.l);
      bucket.c = c.c;
      bucket.v += c.v;
    }

    store[sym].live1m = c;
  }

  // ─── Message handler ────────────────────────────────────────────────────────

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || !msg.events) return;

    if (msg.channel === 'candles') {
      for (const event of msg.events) {
        for (const c of (event.candles || [])) {
          const sym = SYM_MAP[c.product_id];
          if (!sym) continue;
          upsertCandle(sym, {
            t: Number(c.start) * 1000,
            o: Number(c.open),
            h: Number(c.high),
            l: Number(c.low),
            c: Number(c.close),
            v: Number(c.volume)
          });
        }
      }
    }

    if (msg.channel === 'ticker') {
      for (const event of msg.events) {
        for (const t of (event.tickers || [])) {
          const sym = SYM_MAP[t.product_id];
          if (!sym) continue;
          store[sym].ticker = {
            price: Number(t.price),
            bestBid: Number(t.best_bid),
            bestAsk: Number(t.best_ask),
            vol24h: Number(t.volume_24_h),
            ts: Date.now()
          };
        }
      }
    }
  }

  // ─── Subscribe ──────────────────────────────────────────────────────────────

  function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Filter to products that Coinbase actually supports (HYPE may not be listed)
    const sub = (channel) => ws.send(JSON.stringify({
      type: 'subscribe',
      product_ids: PRODUCTS,
      channel
    }));
    sub('candles');
    sub('ticker');
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────────

  function connect() {
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    clearTimeout(reconnectTimer);

    try {
      ws = new WebSocket(WS_URL);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      connected = true;
      reconnectCount = 0;  // Reset on successful connection
      reconnectDelay = 500;
      subscribe();
      dispatchEvent(new CustomEvent('candleWS:connected'));
    };

    ws.onmessage = (e) => handleMessage(e.data);

    ws.onclose = () => {
      connected = false;
      ws = null;
      dispatchEvent(new CustomEvent('candleWS:disconnected'));
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires right after — reconnect handled there
    };
  }

  function scheduleReconnect() {
    // Exponential backoff: 500ms * 2^n, capped at 64 seconds
    reconnectCount++;
    const delayMs = Math.min(500 * Math.pow(2, reconnectCount), 64000);
    console.warn(`[CandleWS] Reconnecting in ${delayMs}ms (attempt ${reconnectCount})`);
    reconnectTimer = setTimeout(() => {
      connect();
    }, delayMs);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  window.CandleWS = {
    /** Start the WebSocket connection */
    start() { connect(); },

    /** Is the WebSocket currently open? */
    isConnected() { return connected; },

    /**
     * All closed 15-minute buckets for a coin (newest last).
     * These are the definitive completed candles to compare predictions against.
     */
    getClosedBuckets15m(sym) {
      return (store[sym]?.buckets15m || []).filter(b => b.closed);
    },

    /**
     * The currently building (open) 15-minute bucket.
     * Live — updates every 1-minute candle tick.
     */
    getLiveBucket15m(sym) {
      const b = (store[sym]?.buckets15m || []);
      const last = b[b.length - 1];
      return (last && !last.closed) ? last : null;
    },

    /**
     * All 15-minute buckets (open + closed).
     * Use for display; use getClosedBuckets15m for backtesting.
     */
    getAllBuckets15m(sym) {
      return store[sym]?.buckets15m || [];
    },

    /** Last N closed 15-minute buckets */
    getLastN15m(sym, n = 20) {
      const closed = (store[sym]?.buckets15m || []).filter(b => b.closed);
      return closed.slice(-n);
    },

    /** Latest 1-minute candle from WS feed */
    getLive1m(sym) { return store[sym]?.live1m || null; },

    /** Latest ticker snapshot (price, bid, ask, vol24h) */
    getTicker(sym) { return store[sym]?.ticker || null; },

    /**
     * Returns a score 0-1 indicating how complete the current 15m bucket is.
     * 1.0 = bucket just closed, 0.0 = just opened.
     */
    getBucketProgress() {
      const now = Date.now();
      const start = bucket15mStart(now);
      return (now - start) / BUCKET_MS;
    },

    /**
     * ms until the current 15-minute bucket closes.
     */
    getMsUntilClose() {
      const now = Date.now();
      const start = bucket15mStart(now);
      return (start + BUCKET_MS) - now;
    },

    /**
     * Compare last prediction against the most recently closed 15m candle.
     * Returns { sym, predDir, actual, correct, pctMove } or null.
     */
    evalLastPrediction(sym, predictedDirection, predictedAtPrice) {
      const closed = (store[sym]?.buckets15m || []).filter(b => b.closed);
      if (closed.length < 1) return null;
      const last = closed[closed.length - 1];
      const actual = last.c > last.o ? 'UP' : last.c < last.o ? 'DOWN' : 'FLAT';
      const pctMove = predictedAtPrice
        ? ((last.c - predictedAtPrice) / predictedAtPrice) * 100
        : ((last.c - last.o) / last.o) * 100;
      return {
        sym,
        predDir: predictedDirection,
        actual,
        correct: predictedDirection === actual,
        pctMove: +pctMove.toFixed(4),
        bucketOpen: last.o,
        bucketClose: last.c,
        bucketT: last.t
      };
    }
  };

})();
