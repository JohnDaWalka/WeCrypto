(function () {
  'use strict';

  const BN_MAP = {
    BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt',
    XRP: 'xrpusdt', HYPE: 'hypeusdt', DOGE: 'dogeusdt', BNB: 'bnbusdt'
  };

  const WALL_MIN_QTY = {
    BTC: 3, ETH: 50, SOL: 2000, XRP: 100000, HYPE: 5000, DOGE: 1000000, BNB: 200
  };
  const WALL_MULTI = 3.5;
  const WALL_MIN_AGE = 400;  // ms
  const LIQSNAP_INTERVAL = 2000;
  const LIQSNAP_MAX = 450;

  const books = {};   // sym → { bids, asks, mid }
  const wallTracker = {};   // sym → { bids: Map<priceStr,{qty,firstTs,lastQty}>, asks: Map }
  const liquiditySnaps = {}; // sym → [{ts, mid, bids, asks}]
  const wallAlerts = [];   // global, newest first
  const wallEventLog = {};   // sym → [{ts, price, side, type}] for canvas markers
  const WS_MAP = {};
  const WS_RETRY_CNT = {};  // sym → retry attempt count
  const listeners = new Map();
  const alertListeners = [];
  let lastSnapTs = {};
  let soundEnabled = true;
  let audioCtx = null;

  // ── WebSocket connection with exponential backoff reconnect ──────────────────────────────────────────────────
  function connect(sym, retryAttempt = 0) {
    const bnSym = BN_MAP[sym];
    if (!bnSym) return;
    if (WS_MAP[sym]?.readyState === WebSocket.OPEN) return;

    books[sym] = { bids: [], asks: [], mid: 0, spread: 0, spreadPct: 0 };
    wallTracker[sym] = { bids: new Map(), asks: new Map() };
    liquiditySnaps[sym] = [];
    wallEventLog[sym] = [];
    lastSnapTs[sym] = 0;

    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${bnSym}@depth20@100ms`);
    WS_MAP[sym] = ws;
    WS_RETRY_CNT[sym] = retryAttempt;

    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        processBook(sym, d.bids, d.asks);
        // Reset retry count on successful data
        WS_RETRY_CNT[sym] = 0;
      } catch (_) { }
    };
    ws.onclose = () => {
      delete WS_MAP[sym];
      const nextRetry = WS_RETRY_CNT[sym] + 1;
      // Exponential backoff: 500ms * 2^n, capped at 64s
      const delay = Math.min(500 * Math.pow(2, nextRetry), 64000);
      console.warn(`[Orderbook WS] ${sym} closed, reconnecting in ${delay}ms (attempt ${nextRetry})`);
      setTimeout(() => connect(sym, nextRetry), delay);
    };
    ws.onerror = (e) => {
      console.error(`[Orderbook WS] ${sym} error:`, e);
      ws.close();
    };
  }

  // ── Book processing ───────────────────────────────────────────────────────
  function processBook(sym, rawBids, rawAsks) {
    const bids = rawBids.map(([p, q]) => [+p, +q]).sort((a, b) => b[0] - a[0]);
    const asks = rawAsks.map(([p, q]) => [+p, +q]).sort((a, b) => a[0] - b[0]);

    const bestBid = bids[0]?.[0] || 0;
    const bestAsk = asks[0]?.[0] || 0;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const spread = bestAsk - bestBid;
    const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;

    books[sym] = { bids, asks, mid, spread, spreadPct };

    const now = Date.now();
    detectWalls(sym, 'bids', bids, mid, now);
    detectWalls(sym, 'asks', asks, mid, now);

    // Liquidity snapshot
    if (now - lastSnapTs[sym] >= LIQSNAP_INTERVAL) {
      lastSnapTs[sym] = now;
      const arr = liquiditySnaps[sym];
      arr.push({ ts: now, mid, bids: bids.slice(0, 20), asks: asks.slice(0, 20) });
      if (arr.length > LIQSNAP_MAX) arr.shift();
    }

    const fns = listeners.get(sym);
    if (fns) fns.forEach(fn => fn(books[sym]));
  }

  // ── Wall detection ────────────────────────────────────────────────────────
  function detectWalls(sym, side, levels, mid, now) {
    const tracker = wallTracker[sym][side];
    const minQty = WALL_MIN_QTY[sym] || 100;

    const totalQty = levels.reduce((s, [, q]) => s + q, 0);
    const avgQty = levels.length > 0 ? totalQty / levels.length : 0;
    const threshold = Math.max(minQty, avgQty * WALL_MULTI);

    const currentWalls = new Set();
    for (const [price, qty] of levels) {
      if (qty >= threshold) {
        const key = price.toFixed(8);
        currentWalls.add(key);
        if (!tracker.has(key)) {
          tracker.set(key, { qty, firstTs: now, lastQty: qty });
          // ── Fire APPEARED alert immediately when wall shows up ──────────
          fireAlert(sym, side === 'bids' ? 'BID' : 'ASK', 'APPEARED', price, qty, 0, mid, now);
        } else {
          tracker.get(key).lastQty = qty;
        }
      }
    }

    for (const [key, info] of tracker) {
      if (!currentWalls.has(key)) {
        const age = now - info.firstTs;
        if (age >= WALL_MIN_AGE) {
          const price = +key;
          // Eaten = mid price crossed through the wall; Pulled = wall disappeared without price reaching it
          const eaten = side === 'bids' ? mid <= price * 1.0015 : mid >= price * 0.9985;
          fireAlert(sym, side === 'bids' ? 'BID' : 'ASK', eaten ? 'EATEN' : 'PULLED', price, info.lastQty, age, mid, now);
        }
        tracker.delete(key);
      }
    }
  }

  // ── Alert firing ──────────────────────────────────────────────────────────
  function fireAlert(sym, side, type, price, qty, ageMs, mid, ts) {
    // APPEARED:  BID wall = BULL (new support),  ASK wall = BEAR (new resistance)
    // EATEN/PULLED: ASK gone = BULL (resistance cleared), BID gone = BEAR (support lost)
    let bias;
    if (type === 'APPEARED') {
      bias = side === 'BID' ? 'BULL' : 'BEAR';
    } else {
      bias = side === 'ASK' ? 'BULL' : 'BEAR';
    }

    const alert = { sym, side, type, price, qty, mid, ageMs, ts, bias };
    wallAlerts.unshift(alert);
    if (wallAlerts.length > 200) wallAlerts.pop();

    // Record for canvas marker
    const log = wallEventLog[sym];
    log.push({ ts, price, side, type, bias });
    if (log.length > 100) log.shift();

    if (soundEnabled) playBeep(bias);
    alertListeners.forEach(fn => fn(alert));

    console.log(`[OB] ${sym} ${side}-WALL ${type} @ ${price} | qty=${qty.toFixed(2)} age=${ageMs}ms [${bias}]`);
  }

  // ── Audio ─────────────────────────────────────────────────────────────────
  function playBeep(bias) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = bias === 'BULL' ? 880 : 440;
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.4);
    } catch (_) { }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.OB = {
    books, wallAlerts, wallTracker, liquiditySnaps, wallEventLog,
    WALL_MIN_QTY, WALL_MULTI,
    isSoundOn: () => soundEnabled,
    toggleSound: () => { soundEnabled = !soundEnabled; return soundEnabled; },
    connect, connectAll: () => Object.keys(BN_MAP).forEach(connect),
    onAlert: (fn) => alertListeners.push(fn),
    onBook: (sym, fn) => {
      if (!listeners.has(sym)) listeners.set(sym, []);
      listeners.get(sym).push(fn);
    },
    offBook: (sym, fn) => {
      const arr = listeners.get(sym);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    getConnected: () => Object.keys(WS_MAP).filter(s => WS_MAP[s]?.readyState === WebSocket.OPEN),
    formatQty: (sym, qty) => {
      if (qty >= 1000000) return (qty / 1000000).toFixed(2) + 'M';
      if (qty >= 1000) return (qty / 1000).toFixed(1) + 'K';
      return qty.toFixed(2);
    },
  };

  document.addEventListener('DOMContentLoaded', () => window.OB.connectAll());
})();
