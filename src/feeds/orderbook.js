(function () {
  'use strict';

  // Binance stream names (fallback)
  const BN_MAP = {
    BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt',
    XRP: 'xrpusdt', HYPE: 'hypeusdt', DOGE: 'dogeusdt', BNB: 'bnbusdt'
  };

  // Hyperliquid coin names → our sym (primary — decentralised, no geo-block, all 7 coins)
  const HL_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';

  const WALL_MIN_QTY = {
    BTC: 3, ETH: 50, SOL: 2000, XRP: 100000, HYPE: 5000, DOGE: 1000000, BNB: 200
  };
  const WALL_MULTI = 3.5;
  const WALL_MIN_AGE = 400;  // ms
  const LIQSNAP_INTERVAL = 2000;
  const LIQSNAP_MAX = 450;
  const WALL_BEEPS_PERMANENTLY_DISABLED = true;

  const books = {};   // sym → { bids, asks, mid }
  const wallTracker = {};   // sym → { bids: Map<priceStr,{qty,firstTs,lastQty}>, asks: Map }
  const liquiditySnaps = {}; // sym → [{ts, mid, bids, asks}]
  const balanceMetrics = {}; // sym → depth balance snapshot
  const wallAlerts = [];   // global, newest first
  const wallEventLog = {};   // sym → [{ts, price, side, type}] for canvas markers
  const WS_MAP = {};   // sym → Binance WebSocket (fallback only)
  const listeners = new Map();
  const alertListeners = [];
  let lastSnapTs = {};
  let soundEnabled = false;  // muted — no sound alerts
  let audioCtx = null;
  let _audioUnlockBound = false;

  // Timestamp of last HL message per sym — used to suppress Binance data when HL is live
  const _hlLastMsg = {};
  let _hlWs = null;
  let _hlReconnTimer = null;

  function ensureAudioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    return audioCtx;
  }

  function bindAudioUnlock() {
    if (_audioUnlockBound) return;
    _audioUnlockBound = true;

    const unlock = () => {
      const ctx = ensureAudioCtx();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => { });
      if (ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
        window.removeEventListener('touchstart', unlock, true);
      }
    };

    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
  }

  function _initBookState(sym) {
    if (books[sym]) return;
    books[sym] = { bids: [], asks: [], mid: 0, spread: 0, spreadPct: 0 };
    wallTracker[sym] = { bids: new Map(), asks: new Map() };
    liquiditySnaps[sym] = [];
    balanceMetrics[sym] = null;
    wallEventLog[sym] = [];
    lastSnapTs[sym] = 0;
  }

  function computeBalanceMetrics(sym, bids, asks, mid, spreadPct) {
    const TOP_N = 20;
    const topBids = bids.slice(0, TOP_N);
    const topAsks = asks.slice(0, TOP_N);
    const bidNotional = topBids.reduce((s, [p, q]) => s + (p * q), 0);
    const askNotional = topAsks.reduce((s, [p, q]) => s + (p * q), 0);
    const totalNotional = bidNotional + askNotional;
    const imbalanceValue = totalNotional > 0 ? (bidNotional - askNotional) / totalNotional : 0;

    const allTopQty = [...topBids, ...topAsks].map(([, q]) => q);
    const avgQty = allTopQty.length ? allTopQty.reduce((a, b) => a + b, 0) / allTopQty.length : 0;
    const minQty = WALL_MIN_QTY[sym] || 0;
    const wallThresh = Math.max(minQty, avgQty * WALL_MULTI);

    const bidWallNotional = topBids.reduce((s, [p, q]) => s + (q >= wallThresh ? p * q : 0), 0);
    const askWallNotional = topAsks.reduce((s, [p, q]) => s + (q >= wallThresh ? p * q : 0), 0);
    const bidWallConcentration = bidNotional > 0 ? bidWallNotional / bidNotional : 0;
    const askWallConcentration = askNotional > 0 ? askWallNotional / askNotional : 0;

    const absImb = Math.abs(imbalanceValue);
    let band = 'balanced';
    if (absImb >= 0.45) band = imbalanceValue > 0 ? 'extreme_bid' : 'extreme_ask';
    else if (absImb >= 0.25) band = imbalanceValue > 0 ? 'strong_bid' : 'strong_ask';
    else if (absImb >= 0.10) band = imbalanceValue > 0 ? 'lean_bid' : 'lean_ask';

    let dominantWallSide = 'none';
    if (bidWallConcentration > askWallConcentration + 0.05) dominantWallSide = 'bid';
    else if (askWallConcentration > bidWallConcentration + 0.05) dominantWallSide = 'ask';

    return {
      ts: Date.now(),
      mid,
      spreadPct,
      bidNotional,
      askNotional,
      imbalance: {
        value: imbalanceValue,
        band,
      },
      walls: {
        bidWallNotional,
        askWallNotional,
        bidWallConcentration,
        askWallConcentration,
        dominantWallSide,
      },
    };
  }

  // ── Primary: Hyperliquid WebSocket (single conn, all 7 coins) ─────────────
  function connectHL() {
    if (_hlWs?.readyState === WebSocket.OPEN || _hlWs?.readyState === WebSocket.CONNECTING) return;

    _hlWs = new WebSocket(HL_WS_URL);

    _hlWs.onopen = () => {
      console.log('[OB] HL WebSocket connected — subscribing all coins');
      HL_COINS.forEach(coin => {
        _hlWs.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'l2Book', coin, nSigFigs: 5 }
        }));
      });
    };

    _hlWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.channel !== 'l2Book' || !msg.data?.levels) return;
        const sym = msg.data.coin;  // HL coin name === our sym for all 7
        if (!BN_MAP[sym]) return;   // unknown coin
        _hlLastMsg[sym] = Date.now();
        // HL levels[0] = asks (ascending price), levels[1] = bids (descending)
        const asks = (msg.data.levels[0] || []).map(l => [+l.px, +l.sz]);
        const bids = (msg.data.levels[1] || []).map(l => [+l.px, +l.sz]);
        if (bids.length || asks.length) processBook(sym, bids, asks);
      } catch (_) { }
    };

    _hlWs.onclose = () => {
      _hlWs = null;
      clearTimeout(_hlReconnTimer);
      _hlReconnTimer = setTimeout(connectHL, 3000);
      console.warn('[OB] HL WebSocket closed — reconnecting in 3s, Binance fallback active');
      // Activate Binance fallback while HL is down
      Object.keys(BN_MAP).forEach(connectBinance);
    };

    _hlWs.onerror = () => { _hlWs?.close(); };
  }

  // ── Fallback: Binance per-coin WebSocket ──────────────────────────────────
  function connectBinance(sym) {
    const bnSym = BN_MAP[sym];
    if (!bnSym) return;
    if (WS_MAP[sym]?.readyState === WebSocket.OPEN) return;
    _initBookState(sym);

    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${bnSym}@depth20@100ms`);
    WS_MAP[sym] = ws;

    ws.onmessage = (e) => {
      try {
        // Suppress if HL delivered data for this sym in the last 3s
        if (Date.now() - (_hlLastMsg[sym] || 0) < 3000) return;
        const d = JSON.parse(e.data);
        processBook(sym, d.bids, d.asks);
      } catch (_) { }
    };
    ws.onclose = () => {
      delete WS_MAP[sym];
      // Only reconnect Binance if HL is also down
      if (!_hlWs || _hlWs.readyState !== WebSocket.OPEN) {
        setTimeout(() => connectBinance(sym), 3000);
      }
    };
    ws.onerror = () => { ws.close(); };
  }

  // ── Public connect (called per-sym from depth panel) ─────────────────────
  function connect(sym) {
    _initBookState(sym);
    if (!_hlWs || _hlWs.readyState !== WebSocket.OPEN) connectBinance(sym);
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

    balanceMetrics[sym] = computeBalanceMetrics(sym, bids, asks, mid, spreadPct);

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

    if (!WALL_BEEPS_PERMANENTLY_DISABLED && soundEnabled) playBeep(bias);
    alertListeners.forEach(fn => fn(alert));

    console.log(`[OB] ${sym} ${side}-WALL ${type} @ ${price} | qty=${qty.toFixed(2)} age=${ageMs}ms [${bias}]`);
  }

  // ── Audio ─────────────────────────────────────────────────────────────────
  function playBeep(bias) {
    try {
      const ctx = ensureAudioCtx();
      if (!ctx) return;
      const play = () => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = ctx.currentTime + 0.01;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(bias === 'BULL' ? 880 : 440, start);
        gain.gain.setValueAtTime(0.15, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
        osc.start(start);
        osc.stop(start + 0.4);
      };

      if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => { });
      else play();
    } catch (_) { }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.OB = {
    books, wallAlerts, wallTracker, liquiditySnaps, wallEventLog, balanceMetrics,
    WALL_MIN_QTY, WALL_MULTI,
    isSoundOn: () => soundEnabled,
    setSoundOn: (next) => {
      soundEnabled = !!next;
      if (soundEnabled) bindAudioUnlock();
      return soundEnabled;
    },
    toggleSound: () => {
      soundEnabled = !soundEnabled;
      if (soundEnabled) bindAudioUnlock();
      return soundEnabled;
    },
    connect,
    connectAll: () => {
      // Init all book state upfront
      Object.keys(BN_MAP).forEach(_initBookState);
      // Primary: HL single WebSocket covers all 7 coins including BNB
      connectHL();
      // Binance fallback: starts after 4s — only fires if HL hasn't connected
      setTimeout(() => {
        if (!_hlWs || _hlWs.readyState !== WebSocket.OPEN) {
          console.warn('[OB] HL not ready after 4s — activating Binance fallback');
          Object.keys(BN_MAP).forEach(connectBinance);
        }
      }, 4000);
    },
    onAlert: (fn) => alertListeners.push(fn),
    onBook: (sym, fn) => {
      if (!listeners.has(sym)) listeners.set(sym, []);
      listeners.get(sym).push(fn);
    },
    getBalanceMetrics: (sym) => balanceMetrics[sym] || null,
    offBook: (sym, fn) => {
      const arr = listeners.get(sym);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    // Returns connected sym list — HL counts as all 7 when live
    getConnected: () => {
      if (_hlWs?.readyState === WebSocket.OPEN) return [...HL_COINS];
      return Object.keys(WS_MAP).filter(s => WS_MAP[s]?.readyState === WebSocket.OPEN);
    },
    formatQty: (sym, qty) => {
      if (qty >= 1000000) return (qty / 1000000).toFixed(2) + 'M';
      if (qty >= 1000) return (qty / 1000).toFixed(1) + 'K';
      return qty.toFixed(2);
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    bindAudioUnlock();
    window.OB.connectAll();
  });
})();
