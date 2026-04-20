// ================================================================
// WE|||CRYPTO — Prediction Analytics Engine v2
// 1-15 min directional predictions + scalp timing + contrarian bets
//
// Live data from:
//   Crypto.com Exchange — 5m/15m candles, order book, trade flow
//   CoinGecko — OHLC + ticker for HYPE, BNB (no CDC USD pair)
//
// Indicators:
//   RSI(14), EMA(9/21) cross, VWAP deviation, OBV slope,
//   Volume delta (buy/sell aggressor), Momentum,
//   Book imbalance (bid wall vs ask wall), Trade flow ratio
//
// Scalp/Contrarian layer:
//   Session timing (Asia/London/NY open power hours),
//   Exhaustion detection (climax volume + reversal),
//   Book absorption (large wall eaten = breakout),
//   Overextension fade zones (±2σ from VWAP)
// ================================================================

(function () {
  'use strict';

  const CDC_BASE = 'https://api.crypto.com/exchange/v1/public';
  const GECKO_BASE = 'https://api.coingecko.com/api/v3';
  const BIN_BASE = 'https://api.binance.us/api/v3';  // .com → 451 from US
  const MEXC_BASE = 'https://api.mexc.com/api/v3';
  const CB_EXCH_BASE = 'https://api.exchange.coinbase.com';
  const CB_EXCH_SYMS = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD' };
  const GECKO_ONLY = new Set(['HYPE', 'BNB']);
  const BIN_SYMS = { BTC:'BTCUSDT', ETH:'ETHUSDT', SOL:'SOLUSDT', XRP:'XRPUSDT', HYPE:'HYPEUSDT', DOGE:'DOGEUSDT', BNB:'BNBUSDT' };
  const MEXC_SYMS = { BTC:'BTCUSDT', ETH:'ETHUSDT', SOL:'SOLUSDT', XRP:'XRPUSDT', HYPE:'HYPEUSDT', DOGE:'DOGEUSDT', BNB:'BNBUSDT' };
  const BYBIT_BASE = 'https://api.bybit.com/v5';
  const BYBIT_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', HYPE: 'HYPEUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT' };
  const KUCOIN_BASE = 'https://api.kucoin.com/api/v1';
  const KUCOIN_SYMS = { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', HYPE: 'HYPE-USDT', DOGE: 'DOGE-USDT', BNB: 'BNB-USDT' };
  const BFNX_BASE = 'https://api-pub.bitfinex.com/v2';
  // BNB removed — not listed on Bitfinex. SOL corrected (tSOLUST was a typo → tSOLUSD).
  const BFNX_SYMS = { BTC: 'tBTCUSD', ETH: 'tETHUSD', SOL: 'tSOLUSD', XRP: 'tXRPUSD', DOGE: 'tDOGEUSD' };
  const SHORT_HORIZON_MINUTES = [1, 5, 10, 15];
  const DEFAULT_SHORT_HORIZON_MIN = 15;  // Primary target: next 15-min candle session
  const SHORT_HORIZON_WEIGHTS = { 1: 0.60, 5: 0.80, 10: 0.90, 15: 1.40 };
  const SHORT_HORIZON_FILTERS = {
    h1: { entryThreshold: 0.08, minAgreement: 0.50 },
    h5: { entryThreshold: 0.12, minAgreement: 0.54 },
    h10: { entryThreshold: 0.16, minAgreement: 0.58 },
    h15: { entryThreshold: 0.20, minAgreement: 0.65 },
  };

  const candleCache = {};
  window._predictions = {};
  window._backtests = {};
  let predictionTimer = null;
  let predictionRunPromise = null;
  let advancedBacktestWarmPromise = null;

  // ── Backtest localStorage cache (cold-start / refresh acceleration) ───────
  const BT_CACHE_KEY    = 'beta1_bt_cache';
  const BT_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

  function saveBtCache() {
    try {
      const store = {};
      PREDICTION_COINS.forEach(coin => {
        const bt = window._backtests[coin.sym];
        if (bt) store[coin.sym] = { bt, ts: Date.now(), walkKey: candleCache[coin.sym]?._walkBacktestKey || '' };
      });
      localStorage.setItem(BT_CACHE_KEY, JSON.stringify(store));
    } catch(e) {}
  }

  (function loadBtCache() {
    try {
      const raw = localStorage.getItem(BT_CACHE_KEY);
      if (!raw) return;
      const store = JSON.parse(raw);
      PREDICTION_COINS.forEach(coin => {
        const entry = store[coin.sym];
        if (!entry || Date.now() - entry.ts > BT_CACHE_TTL_MS) return;
        window._backtests[coin.sym] = entry.bt;
        // Pre-seed in-memory key so runWalkForwardBacktest skips re-run when candles match
        if (!candleCache[coin.sym]) candleCache[coin.sym] = {};
        candleCache[coin.sym]._walkBacktestKey = entry.walkKey;
        candleCache[coin.sym]._walkBacktest    = entry.bt;
      });
    } catch(e) {}
  })();
  // PATCH-DIAG: ichimoku ↓ (slow, hurts short horizons), momentum ↑ short-term,
  //             structure ↑, williamsR ↓ (single-indicator dominance reduced)
  const ENABLE_MDT_SCORE_MULT = true; // set false to instantly revert to pre-MDT formula
  const COMPOSITE_WEIGHTS = {
    // ── Trend-following (74% of weight) — momentum continuation dominates at 1-15 min ──
    ema:          0.18,  // ↑↑ strongest directional anchor
    structure:    0.17,  // ↑↑ breakout/breakdown confirmation
    momentum:     0.14,  // ↑↑↑ short-term rate of change
    persistence:  0.12,  // recent candle direction continuation
    macd:         0.10,  // trend momentum confirmation
    obv:          0.09,  // volume-confirmed direction
    volume:       0.08,  // volume confirmation
    // ── Neutral / gating ──────────────────────────────────────────────────
    vwap:         0.06,  // ↓↓ mean-reversion bias, reduced
    adx:          0.05,  // ↓↓ ADX gate handles flat suppression separately
    book:         0.13,  // microstructure (live-only)
    flow:         0.12,  // microstructure (live-only)
    mktSentiment: 0.11,  // sentiment (live-only)
    // ── Mean-reversion oscillators (15% total) — reduce harmful anti-momentum votes ──
    rsi:          0.04,  // ↓↓ overbought/oversold misleads at short horizons
    bands:        0.04,  // ↓↓ price at upper band ≠ sell at 5-min
    williamsR:    0.04,  // ↓↓↓ was 0.17 — most harmful mean-reversion signal
    stochrsi:     0.03,  // ↓↓ mean-reversion oscillator
    mfi:          0.03,  // ↓↓ mean-reversion oscillator
    ichimoku:     0.02,  // ↓↓↓ 52-bar cloud is noise at 1–5 min horizons
  };

  // ================================================================
  // PATCH1.10 — SIGNAL QUALITY GATE
  // Minimum thresholds a live prediction must pass before being
  // considered a conclusive directional call in the UI.
  // Signals below threshold are labelled LOW CONVICTION or BLOCKED.
  // ================================================================
  const SIGNAL_GATE = {
    // Hard gate — signal must pass ALL of these to be directional
    minConfidence:    42,    // % confidence
    minAgreement:     0.56,  // indicator agreement ratio (was 0.54)
    maxConflict:      0.38,
    minAbsScore:      0.22,  // was 0.10 — now scaled for post-amplification composite
    minReliability:   0.42,

    // Soft gate — signal is flagged LOW CONVICTION if below either
    medConfidence:    58,
    medAgreement:     0.64,  // was 0.62
    medAbsScore:      0.38,  // was 0.20 — scaled for post-amplification
    medReliability:   0.52,
  };

  /**
   * evaluateSignalGate(pred)
   * Returns quality assessment for a live prediction.
   *
   * quality: 'high'    — passes all soft thresholds, strong conviction signal
   *          'medium'  — passes hard gate but below soft thresholds (low conviction)
   *          'blocked' — fails hard gate (noisy/conflicted, do not show directional)
   *
   * gated: true when quality === 'blocked' (signal should show HOLD in UI)
   */
  function evaluateSignalGate(pred) {
    if (!pred || pred.signal === 'neutral' || !Number.isFinite(pred.score)) {
      return { passed: true, gated: false, quality: 'medium', label: 'NEUTRAL', reasons: [] };
    }

    const conf      = pred.confidence ?? 0;
    const absScore  = Math.abs(pred.score ?? 0);
    const agreement = pred.diagnostics?.agreement ?? 0.5;
    const conflict  = pred.diagnostics?.conflict  ?? 0;
    const reliability = pred.backtest?.summary?.reliability ?? 0;
    const routedAction = pred.diagnostics?.routedAction ?? '';
    const reasons = [];

    // Hard-gate failures
    if (routedAction === 'invalidated') {
      return { passed: false, gated: true, quality: 'blocked', label: '⛔ INVALIDATED', reasons: ['Signal invalidated by router'] };
    }
    if (conf < SIGNAL_GATE.minConfidence) reasons.push('Low confidence (' + conf + '%)');
    if (absScore < SIGNAL_GATE.minAbsScore) reasons.push('Weak score (' + absScore.toFixed(2) + ')');
    if (agreement < SIGNAL_GATE.minAgreement) reasons.push('Low agreement (' + Math.round(agreement * 100) + '%)');
    if (conflict >= SIGNAL_GATE.maxConflict) reasons.push('High conflict (' + Math.round(conflict * 100) + '%)');
    if (reliability > 0 && reliability < SIGNAL_GATE.minReliability) reasons.push('Weak backtest (' + Math.round(reliability * 100) + '%)');

    if (reasons.length > 0) {
      return { passed: false, gated: true, quality: 'blocked', label: '⛔ HOLD', reasons };
    }

    // Soft-gate check (medium conviction)
    const softFails = [];
    if (conf < SIGNAL_GATE.medConfidence) softFails.push('Conf ' + conf + '%');
    if (agreement < SIGNAL_GATE.medAgreement) softFails.push('Agr ' + Math.round(agreement * 100) + '%');
    if (absScore < SIGNAL_GATE.medAbsScore) softFails.push('Score ' + absScore.toFixed(2));
    if (reliability > 0 && reliability < SIGNAL_GATE.medReliability) softFails.push('Rel ' + Math.round(reliability * 100) + '%');

    if (softFails.length >= 2) {
      return { passed: true, gated: false, quality: 'medium', label: '⚡ LOW CONV', reasons: softFails };
    }

    return { passed: true, gated: false, quality: 'high', label: '✅ STRONG', reasons: [] };
  }

  // ================================================================
  // PATCH1.10 — SIGNAL QUALITY GATE
  // Minimum thresholds a live prediction must pass before being
  // considered a conclusive directional call in the UI.
  // Signals below threshold are labelled LOW CONVICTION or BLOCKED.
  // ================================================================
  const CORE_SIGNAL_KEYS = ['rsi', 'ema', 'vwap', 'obv', 'volume', 'momentum', 'bands', 'persistence', 'structure', 'macd', 'stochrsi', 'adx', 'ichimoku', 'williamsR', 'mfi', 'mktSentiment'];
  const MICRO_SIGNAL_KEYS = ['book', 'flow'];
  const SIGNAL_LABELS = {
    rsi: 'RSI',
    ema: 'EMA Cross',
    vwap: 'VWAP',
    obv: 'OBV',
    volume: 'Volume Flow',
    momentum: 'Momentum',
    bands: 'Band Pressure',
    persistence: 'Trend Persistence',
    structure: 'Support/Resistance',
    book: 'Order Book',
    flow: 'Tape Flow',
    macd: 'MACD',
    stochrsi: 'Stoch RSI',
    adx: 'ADX',
    ichimoku: 'Ichimoku',
    williamsR: 'Williams %R',
    mfi: 'MFI',
    mktSentiment: 'Prediction Markets',
  };
  const BACKTEST_THRESHOLD_GRID = [0.08, 0.10, 0.12, 0.16, 0.20];
  const BACKTEST_AGREEMENT_GRID = [0.50, 0.54, 0.58];
  const BACKTEST_FILTER_OVERRIDES = {
    BTC:  { h1: { entryThreshold: 0.23, minAgreement: 0.54 }, h5: { entryThreshold: 0.28, minAgreement: 0.58 }, h10: { entryThreshold: 0.33, minAgreement: 0.62 }, h15: { entryThreshold: 0.38, minAgreement: 0.66 } },
    ETH:  { h1: { entryThreshold: 0.23, minAgreement: 0.54 }, h5: { entryThreshold: 0.28, minAgreement: 0.58 }, h10: { entryThreshold: 0.33, minAgreement: 0.62 }, h15: { entryThreshold: 0.38, minAgreement: 0.66 } },
    SOL:  { h1: { entryThreshold: 0.20, minAgreement: 0.52 }, h5: { entryThreshold: 0.25, minAgreement: 0.56 }, h10: { entryThreshold: 0.30, minAgreement: 0.60 }, h15: { entryThreshold: 0.35, minAgreement: 0.64 } },
    XRP:  { h1: { entryThreshold: 0.19, minAgreement: 0.52 }, h5: { entryThreshold: 0.23, minAgreement: 0.56 }, h10: { entryThreshold: 0.28, minAgreement: 0.60 }, h15: { entryThreshold: 0.32, minAgreement: 0.64 } },
    DOGE: { h1: { entryThreshold: 0.28, minAgreement: 0.58 }, h5: { entryThreshold: 0.32, minAgreement: 0.60 }, h10: { entryThreshold: 0.35, minAgreement: 0.62 }, h15: { entryThreshold: 0.38, minAgreement: 0.66 } },
    BNB:  { h1: { entryThreshold: 0.20, maxScore: 0.58, minAgreement: 0.54 }, h5: { entryThreshold: 0.25, maxScore: 0.58, minAgreement: 0.58 }, h10: { entryThreshold: 0.29, maxScore: 0.58, minAgreement: 0.62 }, h15: { entryThreshold: 0.33, maxScore: 0.58, minAgreement: 0.64 } },
    HYPE: { h1: { entryThreshold: 0.18, maxScore: 0.40, minAgreement: 0.52 }, h5: { entryThreshold: 0.20, maxScore: 0.40, minAgreement: 0.52 }, h10: { entryThreshold: 0.22, maxScore: 0.40, minAgreement: 0.54 }, h15: { entryThreshold: 0.24, maxScore: 0.40, minAgreement: 0.56 } },
  };
  const ORBITAL_ROUTER_PROFILES = {
    core: {
      benchmarkWeight: 1.10,
      trendWeight: 1.08,
      momentumWeight: 0.96,
      structureWeight: 1.04,
      microWeight: 0.86,
      timingWeight: 0.78,
      derivativeWeight: 0.92,
      historyWeight: 1.06,
      riskWeight: 0.92,
      tradeNet: 0.34,
      tradeRisk: 0.92,
      watchNet: 0.15,
      invalidateRisk: 1.64,
    },
    momentum: {
      benchmarkWeight: 0.98,
      trendWeight: 1.02,
      momentumWeight: 1.08,
      structureWeight: 0.96,
      microWeight: 1.04,
      timingWeight: 1.12,
      derivativeWeight: 1.04,
      historyWeight: 0.92,
      riskWeight: 0.94,
      tradeNet: 0.32,
      tradeRisk: 0.88,
      watchNet: 0.14,
      invalidateRisk: 1.56,
    },
    highBeta: {
      benchmarkWeight: 0.98,
      trendWeight: 1.02,
      momentumWeight: 1.10,
      structureWeight: 0.96,
      microWeight: 0.96,
      timingWeight: 1.02,
      derivativeWeight: 0.98,
      historyWeight: 0.98,
      riskWeight: 1.08,
      tradeNet: 0.42,
      tradeRisk: 0.74,
      watchNet: 0.18,
      invalidateRisk: 1.28,
    },
  };
  const BACKTEST_STARTING_EQUITY = 100;
  const BACKTEST_MIN_TRAIN_OBS = 36;
  const BACKTEST_LOOKBACK_OBS = 160;
  const BACKTEST_MIN_REGIME_OBS = 18;
  const LIVE_DATA_TTL_MS = 870000;        // 14.5 min — candle cache stays valid across the full 15-min window
  let geckoRequestQueue = Promise.resolve();
  let lastGeckoRequestAt = 0;
  let lastExchangeRequestAt = 0;

  // ================================================================
  // SESSION TIMING (real-world market dynamics)
  // ================================================================

  function getSessionInfo() {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const t = utcH + utcM / 60;

    // Session windows (UTC)
    const sessions = {
      asia_open:   { start: 0, end: 2,   label: 'Asia Open',     scalp: true,  desc: 'Tokyo/Seoul open — high volatility spike, scalp-friendly' },
      asia_mid:    { start: 2, end: 6,   label: 'Asia Session',  scalp: false, desc: 'Mid-session Asia — liquidity thinning' },
      london_open: { start: 7, end: 9,   label: 'London Open',   scalp: true,  desc: 'London/EU open — biggest volume surge, prime scalp window' },
      london_mid:  { start: 9, end: 12,  label: 'London Session', scalp: false, desc: 'EU active — steady directional flow' },
      ny_open:     { start: 13, end: 15.5, label: 'NY Open',      scalp: true,  desc: 'NYSE open overlap — maximum liquidity, sharpest moves' },
      ny_mid:      { start: 15.5, end: 18, label: 'NY Session',   scalp: false, desc: 'US afternoon — momentum continuation or reversal' },
      ny_close:    { start: 18, end: 21,  label: 'NY Close',      scalp: true,  desc: 'NYSE close — position squaring, mean-reversion scalps' },
      dead_zone:   { start: 21, end: 24,  label: 'Dead Zone',     scalp: false, desc: 'Low liquidity — avoid scalping, wide spreads' },
    };

    let current = sessions.dead_zone;
    for (const [, s] of Object.entries(sessions)) {
      if (t >= s.start && t < s.end) { current = s; break; }
    }

    // Next scalp window
    const scalpWindows = Object.values(sessions).filter(s => s.scalp);
    let nextScalp = null;
    for (const sw of scalpWindows) {
      if (sw.start > t) { nextScalp = sw; break; }
    }
    if (!nextScalp) nextScalp = scalpWindows[0]; // wrap to next day

    const minsToNext = nextScalp.start > t
      ? Math.round((nextScalp.start - t) * 60)
      : Math.round((24 - t + nextScalp.start) * 60);

    return { current, nextScalp, minsToNext, utcHour: utcH, localHour: now.getHours() };
  }

  // Returns info about the next 15-minute candle boundary
  function getNextCandleSession() {
    const now = new Date();
    const utcMin = now.getUTCMinutes();
    const utcSec = now.getUTCSeconds();
    const minsIntoSlot = utcMin % 15;
    const secsIntoSlot = minsIntoSlot * 60 + utcSec;
    const slotDurationSec = 15 * 60;
    const secsRemaining = slotDurationSec - secsIntoSlot;
    const minsRemaining = Math.ceil(secsRemaining / 60);

    // Current slot open time (floor to last 15-min boundary)
    const currentSlotMs = now.getTime() - secsIntoSlot * 1000;
    const nextSlotMs = currentSlotMs + slotDurationSec * 1000;
    const nextSlotClose = nextSlotMs + slotDurationSec * 1000;

    // How mature is the current session (0 = just opened, 1 = about to close)
    const maturity = secsIntoSlot / slotDurationSec;

    return {
      minsRemaining,             // mins until current 15-min candle closes & next opens
      nextOpen: new Date(nextSlotMs).toISOString(),
      nextClose: new Date(nextSlotClose).toISOString(),
      maturity: parseFloat(maturity.toFixed(3)), // 0.0–1.0
      freshEntry: maturity < 0.20,               // first 3 min of slot — best entry
      lateEntry: maturity > 0.80,                // last 3 min — stale, avoid
    };
  }

  // ================================================================
  // DATA FETCHING
  // ================================================================

  function normCandle(c) {
    if (Array.isArray(c)) return { t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] };
    return { t: c.t, o: +(c.o||0), h: +(c.h||0), l: +(c.l||0), c: +(c.c||0), v: +(c.v||0) };
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function fetchWithTimeout(url, timeoutMs = 4000, options = {}) {
    if (typeof AbortController === 'undefined') {
      return (window.throttledFetch ?? fetch)(url, options);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await (window.throttledFetch ?? fetch)(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function randomBetween(min, max) {
    return Math.floor(min + Math.random() * Math.max(1, max - min + 1));
  }

  async function waitExchangeJitter(minGapMs = 90) {
    const jitterMs = randomBetween(40, 180);
    const sinceLast = Date.now() - lastExchangeRequestAt;
    const waitMs = Math.max(jitterMs, minGapMs - sinceLast);
    if (waitMs > 0) await wait(waitMs);
    lastExchangeRequestAt = Date.now();
  }

  async function fetchGeckoJSON(path, options = {}) {
    const { minGapMs = 1800, retries = 1 } = options;  // max 1 retry — 4 retries created 22s+ backlog
    const run = async (attempt = 0) => {
      const now = Date.now();
      const waitMs = Math.max(0, minGapMs - (now - lastGeckoRequestAt));
      if (waitMs > 0) await wait(waitMs);
      lastGeckoRequestAt = Date.now();
      const res = await fetchWithTimeout(`${GECKO_BASE}${path}`, 4500);
      if (res.status === 429 && attempt < retries) {
        await wait(1500);   // flat 1.5s backoff instead of compounding
        return run(attempt + 1);
      }
      if (!res.ok) throw new Error(`Gecko ${res.status}`);
      return res.json();
    };

    const queued = geckoRequestQueue.then(() => run());
    geckoRequestQueue = queued.catch(() => {});
    return queued;
  }

  function geckoBucketMs(tf) {
    switch (tf) {
      case '15m': return 15 * 60 * 1000;
      case '1h': return 60 * 60 * 1000;
      default: return 5 * 60 * 1000;
    }
  }

  function bucketGeckoSeries(prices, volumes, bucketMs) {
    const buckets = new Map();
    prices.forEach((point, idx) => {
      const ts = Number(point[0]);
      const price = Number(point[1]);
      const vol = Number(volumes[idx]?.[1] || 0);
      if (!Number.isFinite(ts) || !Number.isFinite(price)) return;
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      const bucket = buckets.get(bucketStart) || { t: bucketStart, o: price, h: price, l: price, c: price, v: 0 };
      bucket.h = Math.max(bucket.h, price);
      bucket.l = Math.min(bucket.l, price);
      bucket.c = price;
      bucket.v += Number.isFinite(vol) ? vol : 0;
      buckets.set(bucketStart, bucket);
    });
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
  }

  function bucketCandles(candles, bucketMs) {
    const buckets = new Map();
    (candles || []).forEach(candle => {
      const ts = Number(candle?.t);
      if (!Number.isFinite(ts)) return;
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      const bucket = buckets.get(bucketStart) || { t: bucketStart, o: Number(candle.o), h: Number(candle.h), l: Number(candle.l), c: Number(candle.c), v: 0 };
      bucket.h = Math.max(bucket.h, Number(candle.h));
      bucket.l = Math.min(bucket.l, Number(candle.l));
      bucket.c = Number(candle.c);
      bucket.v += Number(candle.v || 0);
      buckets.set(bucketStart, bucket);
    });
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
  }

  function poolMinuteCandles(...seriesList) {
    const buckets = new Map();
    seriesList.filter(Array.isArray).forEach(series => {
      series.forEach(candle => {
        const ts = Number(candle?.t);
        const close = Number(candle?.c);
        // Skip candles with non-finite timestamp or zero/near-zero price
        // (protects against exchanges returning bad candles that pass individual filters)
        if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) return;
        const bucket = buckets.get(ts) || { t: ts, o: [], h: [], l: [], c: [], v: [] };
        bucket.o.push(Number(candle.o || close));
        bucket.h.push(Number(candle.h || close));
        bucket.l.push(Number(candle.l || close));
        bucket.c.push(close);
        bucket.v.push(Number(candle.v || 0));
        buckets.set(ts, bucket);
      });
    });
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t).map(bucket => ({
      t: bucket.t,
      o: median(bucket.o),
      h: Math.max(...bucket.h),
      l: Math.min(...bucket.l),
      c: median(bucket.c),
      v: average(bucket.v),
    }));
  }

  async function fetchCDCCandles(instrument, tf, count = 300) {
    const apiInstr = instrument.replace(/([A-Z]+)(USD[T]?)$/, '$1_$2');
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CDC_BASE}/get-candlestick?instrument_name=${apiInstr}&timeframe=${tf}&count=${count}`, 12000);
    if (!res.ok) throw new Error(`CDC ${res.status}`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(`CDC code ${json.code}`);
    return json.result.data.map(normCandle).sort((a, b) => a.t - b.t);
  }

  async function fetchCDCBook(instrument) {
    const apiInstr = instrument.replace(/([A-Z]+)(USD[T]?)$/, '$1_$2');
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CDC_BASE}/get-book?instrument_name=${apiInstr}&depth=20`, 8000);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0) return null;
    const bookData = json.result?.data?.[0];
    if (!bookData) return null;
    return {
      bids: (bookData.bids || []).map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0),
      asks: (bookData.asks || []).map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0),
      source: 'crypto.com',
      timestamp: Date.now(),
    };
  }

  async function fetchCDCTrades(instrument) {
    const apiInstr = instrument.replace(/([A-Z]+)(USD[T]?)$/, '$1_$2');
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CDC_BASE}/get-trades?instrument_name=${apiInstr}&count=100`, 8000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.code !== 0) return [];
    // CDC payload keys: q=quantity, p=price, s=side(BUY/SELL), m=maker_side(B/S=seller aggressor), d=tradeId, t=timestamp
    return (json.result.data || []).map(t => {
      const qty = parseFloat(t.q || t.qty || 0);
      const makerRaw = (t.m || '').toUpperCase();
      const sideRaw = (t.s || t.side || '').toUpperCase();
      const side = makerRaw
        ? (makerRaw === 'S' ? 'buy' : 'sell')   // seller=maker → buyer is aggressor
        : (sideRaw === 'BUY' || sideRaw === 'B' ? 'buy' : 'sell');
      return { qty, side, px: parseFloat(t.p || t.px || 0), t: Number(t.t || t.d || Date.now()) };
    }).filter(t => t.qty > 0);
  }

  function mexcSymbolForCoin(coin) {
    return MEXC_SYMS[coin.sym] || null;
  }

  function mexcInterval(tf) {
    switch (tf) {
      case '1m': return '1m';
      case '5m': return '5m';
      case '15m': return '15m';
      case '1h': return '1h';
      default: return tf;
    }
  }

  async function fetchMEXCCandles(coin, tf = '5m', limit = 300) {
    const symbol = mexcSymbolForCoin(coin);
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${MEXC_BASE}/klines?symbol=${symbol}&interval=${mexcInterval(tf)}&limit=${limit}`, 10000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c));
  }

  async function fetchMEXCBook(coin) {
    const symbol = mexcSymbolForCoin(coin);
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${MEXC_BASE}/depth?symbol=${symbol}&limit=20`, 7000);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json?.bids) || !Array.isArray(json?.asks)) return null;
    return {
      bids: json.bids.map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(level => Number.isFinite(level.price) && Number.isFinite(level.qty)),
      asks: json.asks.map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(level => Number.isFinite(level.price) && Number.isFinite(level.qty)),
      source: 'mexc',
      timestamp: Date.now(),
    };
  }

  async function fetchMEXCTrades(coin, limit = 100) {
    const symbol = mexcSymbolForCoin(coin);
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${MEXC_BASE}/trades?symbol=${symbol}&limit=${limit}`, 7000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(trade => ({
      px: Number(trade.price),
      qty: Number(trade.qty),
      side: trade.isBuyerMaker ? 'sell' : 'buy',
      t: Number(trade.time || trade.id || Date.now()),
    })).filter(trade => Number.isFinite(trade.qty) && trade.qty > 0);
  }

  // ---------------------------------------------------------------
  // ByBit Exchange (public — no auth required)
  // ---------------------------------------------------------------

  function bybitInterval(tf) {
    switch (tf) {
      case '1m': return '1';
      case '5m': return '5';
      case '15m': return '15';
      case '1h': return '60';
      default: return '5';
    }
  }

  async function fetchBybitCandles(sym, tf = '5m', limit = 200) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BYBIT_BASE}/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval(tf)}&limit=${limit}`, 10000);
    if (!res.ok) return fetchBINCandles(sym, tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m', limit);
    const json = await res.json();
    if (json.retCode !== 0 || !Array.isArray(json.result?.list)) return fetchBINCandles(sym, tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m', limit);
    const candles = json.result.list.map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
    return candles.length ? candles : fetchBINCandles(sym, tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m', limit);
  }

  async function fetchBybitBook(sym) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BYBIT_BASE}/market/orderbook?category=spot&symbol=${symbol}&limit=20`, 7000);
    if (!res.ok) return fetchBINBook(sym);
    const json = await res.json();
    if (json.retCode !== 0 || !json.result) return fetchBINBook(sym);
    const bids = (json.result.b || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    const asks = (json.result.a || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    if (!bids.length && !asks.length) return fetchBINBook(sym);
    return { bids, asks, source: 'bybit', timestamp: Date.now() };
  }

  async function fetchBybitTrades(sym, limit = 100) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BYBIT_BASE}/market/recent-trade?category=spot&symbol=${symbol}&limit=${limit}`, 7000);
    if (!res.ok) return fetchBINTrades(sym, limit);
    const json = await res.json();
    if (json.retCode !== 0 || !Array.isArray(json.result?.list)) return fetchBINTrades(sym, limit);
    const trades = json.result.list.map(t => ({
      px: Number(t.price),
      qty: Number(t.size),
      side: t.side === 'Buy' ? 'buy' : 'sell',
      t: Number(t.time),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
    return trades.length ? trades : fetchBINTrades(sym, limit);
  }

  // ---------------------------------------------------------------
  // KuCoin Exchange (public — no auth required)
  // ---------------------------------------------------------------

  function kucoinType(tf) {
    switch (tf) {
      case '1m': return '1min';
      case '5m': return '5min';
      case '15m': return '15min';
      case '1h': return '1hour';
      default: return '5min';
    }
  }

  async function fetchKucoinCandles(sym, tf = '5m', limit = 200) {
    const symbol = KUCOIN_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const bucketSec = tf === '1m' ? 60 : tf === '5m' ? 300 : tf === '15m' ? 900 : 3600;
    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - limit * bucketSec;
    const res = await fetchWithTimeout(`${KUCOIN_BASE}/market/candles?type=${kucoinType(tf)}&symbol=${symbol}&startAt=${startAt}&endAt=${endAt}`, 10000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.code !== '200000' || !Array.isArray(json.data)) return [];
    return json.data.map(row => ({
      t: Number(row[0]) * 1000,
      o: Number(row[1]),
      c: Number(row[2]),
      h: Number(row[3]),
      l: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
  }

  async function fetchKucoinBook(sym) {
    const symbol = KUCOIN_SYMS[sym];
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KUCOIN_BASE}/market/orderbook/level2_20?symbol=${symbol}`, 7000);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== '200000' || !json.data) return null;
    const bids = (json.data.bids || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    const asks = (json.data.asks || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    if (!bids.length && !asks.length) return null;
    return { bids, asks, source: 'kucoin', timestamp: Date.now() };
  }

  async function fetchKucoinTrades(sym, limit = 100) {
    const symbol = KUCOIN_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KUCOIN_BASE}/market/histories?symbol=${symbol}`, 7000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.code !== '200000' || !Array.isArray(json.data)) return [];
    return json.data.slice(0, limit).map(t => ({
      px: Number(t.price),
      qty: Number(t.size),
      side: t.side === 'buy' ? 'buy' : 'sell',
      t: Math.floor(Number(t.time) / 1e6),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  // ---------------------------------------------------------------
  // Bitfinex (public — no auth required)
  // ---------------------------------------------------------------

  function bfnxTimeframe(tf) {
    switch (tf) {
      case '1m': return '1m';
      case '5m': return '5m';
      case '15m': return '15m';
      case '1h': return '1h';
      default: return '5m';
    }
  }

  async function fetchBitfinexCandles(sym, tf = '5m', limit = 200) {
    const symbol = BFNX_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BFNX_BASE}/candles/trade:${bfnxTimeframe(tf)}:${symbol}/hist?limit=${limit}&sort=1`, 10000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    // Bitfinex: [mts, open, close, high, low, volume]
    return json.map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      c: Number(row[2]),
      h: Number(row[3]),
      l: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c));
  }

  async function fetchBitfinexBook(sym) {
    const symbol = BFNX_SYMS[sym];
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BFNX_BASE}/book/${symbol}/P0?len=25`, 7000);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json)) return null;
    const bids = json.filter(l => Number(l[2]) > 0).map(l => ({ price: Number(l[0]), qty: Number(l[2]) }));
    const asks = json.filter(l => Number(l[2]) < 0).map(l => ({ price: Number(l[0]), qty: Math.abs(Number(l[2])) }));
    if (!bids.length && !asks.length) return null;
    return { bids, asks, source: 'bitfinex', timestamp: Date.now() };
  }

  async function fetchBitfinexTrades(sym, limit = 100) {
    const symbol = BFNX_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BFNX_BASE}/trades/${symbol}/hist?limit=${limit}&sort=-1`, 7000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    // [id, mts, amount, price] — amount>0 = buy, amount<0 = sell
    return json.map(t => ({
      px: Number(t[3]),
      qty: Math.abs(Number(t[2])),
      side: Number(t[2]) > 0 ? 'buy' : 'sell',
      t: Number(t[1]),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  async function fetchGeckoCandles(geckoId, tf = '5m') {
    const days = tf === '1h' ? 7 : 1;
    const bucketMs = geckoBucketMs(tf);
    const json = await fetchGeckoJSON(`/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`);
    const prices = Array.isArray(json.prices) ? json.prices : [];
    const volumes = Array.isArray(json.total_volumes) ? json.total_volumes : [];
    return bucketGeckoSeries(prices, volumes, bucketMs);
  }

  async function fetchGeckoTicker(geckoId) {
    const json = await fetchGeckoJSON(`/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`);
    return json[geckoId];
  }

  async function fetchGeckoMaxHistory(geckoId) {
    const json = await fetchGeckoJSON(`/coins/${geckoId}/market_chart?vs_currency=usd&days=max`, { minGapMs: 1400, retries: 3 });
    const prices = Array.isArray(json.prices) ? json.prices : [];
    const volumes = Array.isArray(json.total_volumes) ? json.total_volumes : [];
    return bucketGeckoSeries(prices, volumes, 24 * 60 * 60 * 1000);
  }

  async function fetchBINCandles(sym, interval = '1m', limit = 180) {
    const binSym = BIN_SYMS[sym];
    if (!binSym) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BIN_BASE}/klines?symbol=${binSym}&interval=${interval}&limit=${limit}`, 10000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c));
  }

  async function fetchBINBook(sym) {
    const binSym = BIN_SYMS[sym];
    if (!binSym) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BIN_BASE}/depth?symbol=${binSym}&limit=20`, 7000);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json?.bids) || !Array.isArray(json?.asks)) return null;
    const bids = json.bids.map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    const asks = json.asks.map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0);
    if (!bids.length && !asks.length) return null;
    return { bids, asks, source: 'binance', timestamp: Date.now() };
  }

  async function fetchBINTrades(sym, limit = 100) {
    const binSym = BIN_SYMS[sym];
    if (!binSym) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${BIN_BASE}/trades?symbol=${binSym}&limit=${limit}`, 7000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(t => ({
      px:   Number(t.price),
      qty:  Number(t.qty),
      // isBuyerMaker=false → taker was buyer (aggressive buy)
      side: t.isBuyerMaker ? 'sell' : 'buy',
      t:    Number(t.time),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  // ---------------------------------------------------------------
  // Coinbase Exchange (public — no auth required)
  // Used as primary anchor for all 1/5/15m predictions
  // ---------------------------------------------------------------

  async function fetchCBExchCandles(sym, granularitySec = 300, limit = 300) {
    const productId = CB_EXCH_SYMS[sym];
    if (!productId) return [];
    await waitExchangeJitter();
    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - limit * granularitySec;
    const res = await fetchWithTimeout(
      `${CB_EXCH_BASE}/products/${productId}/candles?granularity=${granularitySec}&start=${startSec}&end=${endSec}`,
      12000
    );
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    // CB returns [time_sec, low, high, open, close, volume] newest-first
    return json.map(row => ({
      t: Number(row[0]) * 1000,
      l: Number(row[1]),
      h: Number(row[2]),
      o: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
  }

  async function fetchCBExchBook(sym) {
    const productId = CB_EXCH_SYMS[sym];
    if (!productId) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CB_EXCH_BASE}/products/${productId}/book?level=2`, 8000);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json?.bids) || !Array.isArray(json?.asks)) return null;
    return {
      bids: json.bids.slice(0, 20).map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0),
      asks: json.asks.slice(0, 20).map(level => ({ price: Number(level[0]), qty: Number(level[1]) })).filter(l => Number.isFinite(l.price) && l.qty > 0),
      source: 'coinbase',
      timestamp: Date.now(),
    };
  }

  async function fetchCBExchTrades(sym, limit = 100) {
    const productId = CB_EXCH_SYMS[sym];
    if (!productId) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${CB_EXCH_BASE}/products/${productId}/trades?limit=${limit}`, 8000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(trade => ({
      qty: Number(trade.size),
      side: trade.side === 'buy' ? 'buy' : 'sell',
      px: Number(trade.price),
      t: trade.time ? new Date(trade.time).getTime() : Date.now(),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  // ---------------------------------------------------------------
  // Kraken (public REST — no auth required)
  // HYPE not listed on Kraken; all other PREDICTION_COINS supported
  // ---------------------------------------------------------------
  const KRAKEN_BASE = 'https://api.kraken.com/0/public';
  const KRAKEN_SYMS = { BTC:'XBTUSD', ETH:'ETHUSD', SOL:'SOLUSD', XRP:'XRPUSD', DOGE:'XDGUSD', BNB:'BNBUSD' };

  function krakenInterval(tf) {
    return tf === '1m' ? 1 : tf === '5m' ? 5 : tf === '15m' ? 15 : 5;
  }

  async function fetchKrakenCandles(sym, tf = '5m', limit = 300) {
    const pair = KRAKEN_SYMS[sym];
    if (!pair) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KRAKEN_BASE}/OHLC?pair=${pair}&interval=${krakenInterval(tf)}`, 12000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.error?.length) return [];
    const rows = Object.values(json.result || {}).find(v => Array.isArray(v));
    if (!rows) return [];
    // Kraken OHLC: [time_sec, open, high, low, close, vwap, vol, count]
    return rows.slice(-limit).map(row => ({
      t: Number(row[0]) * 1000,
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[6]),
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0);
  }

  async function fetchKrakenBook(sym) {
    const pair = KRAKEN_SYMS[sym];
    if (!pair) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KRAKEN_BASE}/Depth?pair=${pair}&count=25`, 8000);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error?.length) return null;
    const book = Object.values(json.result || {})[0];
    if (!book) return null;
    return {
      bids: (book.bids || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => l.qty > 0),
      asks: (book.asks || []).map(l => ({ price: Number(l[0]), qty: Number(l[1]) })).filter(l => l.qty > 0),
      source: 'kraken',
      timestamp: Date.now(),
    };
  }

  async function fetchKrakenTrades(sym, limit = 100) {
    const pair = KRAKEN_SYMS[sym];
    if (!pair) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(`${KRAKEN_BASE}/Trades?pair=${pair}`, 8000);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.error?.length) return [];
    const rows = Object.values(json.result || {}).find(v => Array.isArray(v));
    if (!rows) return [];
    // Kraken trade: [price, volume, time_float, "b"/"s", ...]
    return rows.slice(-limit).map(t => ({
      px:   Number(t[0]),
      qty:  Number(t[1]),
      side: t[3] === 'b' ? 'buy' : 'sell',
      t:    Math.round(Number(t[2]) * 1000),
    })).filter(t => Number.isFinite(t.qty) && t.qty > 0);
  }

  // Equal-weight pool across all exchanges — no single exchange is anchored
  function anchoredPoolCandles(cbSeries, ...fallbackSeries) {
    return poolMinuteCandles(...[cbSeries, ...fallbackSeries].filter(s => s?.length));
  }

  // ── Phase 1: fast initial load (Coinbase + Binance, ~1-3 s) ─────────────────
  // Populates candleCache so runAll() can score immediately.  Results include
  // raw _cb*/_bin* arrays so Phase 2 enrichment can merge without re-fetching.
  async function loadCoinData(coin) {
    try {
      const existing = candleCache[coin.sym] || {};
      const hasFreshLiveData = Array.isArray(existing.candles)
        && existing.candles.length >= 60
        && (Date.now() - (existing.ts || 0) < LIVE_DATA_TTL_MS);
      if (hasFreshLiveData) return;
      const hasLongHistory = Array.isArray(existing.longHistory) && existing.longHistory.length >= 90 && (Date.now() - (existing.longHistoryTs || 0) < 12 * 60 * 60 * 1000);

      if (GECKO_ONLY.has(coin.sym)) {
        // HYPE / BNB: Gecko market data + Coinbase + Binance
        const [market, bin1m, bin5m, bin15m, cb1m, cb5m, cb15m, cbBook, longHistory] = await Promise.all([
          fetchGeckoJSON(`/coins/${coin.geckoId}/market_chart?vs_currency=usd&days=1`).catch(() => null),
          fetchBINCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBINCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBINCandles(coin.sym, '15m', 300).catch(() => []),
          fetchCBExchCandles(coin.sym, 60, 180).catch(() => []),
          fetchCBExchCandles(coin.sym, 300, 300).catch(() => []),
          fetchCBExchCandles(coin.sym, 900, 300).catch(() => []),
          fetchCBExchBook(coin.sym).catch(() => null),
          hasLongHistory ? Promise.resolve(existing.longHistory) : fetchGeckoMaxHistory(coin.geckoId).catch(() => existing.longHistory || []),
        ]);
        const prices  = Array.isArray(market?.prices)        ? market.prices        : [];
        const volumes = Array.isArray(market?.total_volumes) ? market.total_volumes : [];
        const gecko5m  = bucketGeckoSeries(prices, volumes, geckoBucketMs('5m'));
        const gecko15m = bucketGeckoSeries(prices, volumes, geckoBucketMs('15m'));
        const ws15m = window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : [];
        const ws1m  = window.CandleWS ? window.CandleWS.getClosedBuckets1m(coin.sym)  : [];
        const candles    = anchoredPoolCandles(cb5m, gecko5m, bin5m);
        const candles15m = anchoredPoolCandles(ws15m, cb15m, gecko15m, bin15m);
        const candles1m  = anchoredPoolCandles(ws1m, cb1m, bin1m);
        if (!candles.length && Array.isArray(existing.candles) && existing.candles.length) {
          candleCache[coin.sym] = existing;
          return;
        }
        const latestPrice = cb5m.length ? cb5m[cb5m.length - 1].c
          : prices.length ? Number(prices[prices.length - 1][1]) : (candles[candles.length - 1]?.c || existing.ticker?.usd || 0);
        const firstPrice  = prices.length ? Number(prices[0][1]) : (candles[0]?.o || latestPrice);
        const totalVolume = volumes.length
          ? volumes.reduce((s, p) => s + Number(p?.[1] || 0), 0)
          : candles.reduce((s, c) => s + Number(c.v || 0), 0);
        const ticker = { usd: latestPrice, usd_24h_change: firstPrice > 0 ? ((latestPrice - firstPrice) / firstPrice) * 100 : 0, usd_24h_vol: totalVolume };
        const book = cbBook?.bids?.length ? cbBook : null;
        const sourceParts = ['coingecko'];
        if (cb5m.length || cb1m.length) sourceParts.unshift('coinbase');
        if (bin5m.length || bin1m.length) sourceParts.push('binance');
        candleCache[coin.sym] = {
          candles, candles15m, candles1m, ticker, book, trades: [],
          source: sourceParts.filter(Boolean).join(' + '),
          ts: Date.now(), longHistory,
          longHistoryTs: longHistory?.length ? Date.now() : (existing.longHistoryTs || 0),
          _cb1m: cb1m, _cb5m: cb5m, _cb15m: cb15m,
          _bin1m: bin1m, _bin5m: bin5m, _bin15m: bin15m,
          _gecko5m: gecko5m, _gecko15m: gecko15m,
        };
      } else {
        // BTC / ETH / SOL / XRP / DOGE: Coinbase + Binance only
        const [bin1m, bin5m, bin15m, cb1m, cb5m, cb15m, cbBook, cbTrades] = await Promise.all([
          fetchBINCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBINCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBINCandles(coin.sym, '15m', 300).catch(() => []),
          fetchCBExchCandles(coin.sym, 60, 180).catch(() => []),
          fetchCBExchCandles(coin.sym, 300, 300).catch(() => []),
          fetchCBExchCandles(coin.sym, 900, 300).catch(() => []),
          fetchCBExchBook(coin.sym).catch(() => null),
          fetchCBExchTrades(coin.sym).catch(() => []),
        ]);
        const ws15m_b = window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : [];
        const ws1m    = window.CandleWS ? window.CandleWS.getClosedBuckets1m(coin.sym)  : [];
        const candles5m  = anchoredPoolCandles(cb5m, bin5m);
        const candles15m = anchoredPoolCandles(ws15m_b, cb15m, bin15m);
        const candles1m  = anchoredPoolCandles(ws1m, cb1m, bin1m);
        if (!candles5m.length) throw new Error('No exchange candles available');
        const sourceParts = [];
        if (cb5m.length || cb1m.length) sourceParts.push('coinbase');
        if (bin5m.length || bin1m.length) sourceParts.push('binance');
        candleCache[coin.sym] = {
          candles: candles5m, candles15m, candles1m,
          book: cbBook, trades: cbTrades,
          source: sourceParts.join(' + '),
          ts: Date.now(),
          longHistory: existing.longHistory || [],
          longHistoryTs: existing.longHistoryTs || 0,
          _cb1m: cb1m, _cb5m: cb5m, _cb15m: cb15m,
          _bin1m: bin1m, _bin5m: bin5m, _bin15m: bin15m,
        };
      }
    } catch (err) {
      console.warn(`[loadCoinData] ${coin.sym}:`, err.message);
    }
  }

  // ── Phase 2: background enrichment (slow proxy-routed sources, 30 s later) ──
  // Merges CDC / MEXC / Bybit / KuCoin / Bitfinex / Kraken data with the CB+BIN
  // anchor already in candleCache, then re-scores the coin silently.
  async function enrichCoinDataBackground(coin) {
    try {
      const existing = candleCache[coin.sym] || {};
      const cb1m  = existing._cb1m  || [];
      const cb5m  = existing._cb5m  || [];
      const cb15m = existing._cb15m || [];
      const bin1m  = existing._bin1m  || [];
      const bin5m  = existing._bin5m  || [];
      const bin15m = existing._bin15m || [];

      if (GECKO_ONLY.has(coin.sym)) {
        const [mexc1m, mexc5m, mexc15m, mexcBook, bybit1m, bybit5m, bybit15m, bybitBook, kucoin1m, kucoin5m, kucoin15m, kucoinBook, bfnx1m, bfnx5m, bfnx15m, bfnxBook, krk1m, krk5m, krk15m, krkBook] = await Promise.all([
          fetchMEXCCandles(coin, '1m', 180).catch(() => []),
          fetchMEXCCandles(coin, '5m', 300).catch(() => []),
          fetchMEXCCandles(coin, '15m', 300).catch(() => []),
          fetchMEXCBook(coin).catch(() => null),
          fetchBybitCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBybitCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBybitCandles(coin.sym, '15m', 300).catch(() => []),
          fetchBybitBook(coin.sym).catch(() => null),
          fetchKucoinCandles(coin.sym, '1m', 180).catch(() => []),
          fetchKucoinCandles(coin.sym, '5m', 300).catch(() => []),
          fetchKucoinCandles(coin.sym, '15m', 300).catch(() => []),
          fetchKucoinBook(coin.sym).catch(() => null),
          fetchBitfinexCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBitfinexCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBitfinexCandles(coin.sym, '15m', 300).catch(() => []),
          fetchBitfinexBook(coin.sym).catch(() => null),
          fetchKrakenCandles(coin.sym, '1m', 180).catch(() => []),
          fetchKrakenCandles(coin.sym, '5m', 300).catch(() => []),
          fetchKrakenCandles(coin.sym, '15m', 300).catch(() => []),
          fetchKrakenBook(coin.sym).catch(() => null),
        ]);
        const gecko5m  = existing._gecko5m  || [];
        const gecko15m = existing._gecko15m || [];
        const ws15m = window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : [];
        const ws1m  = window.CandleWS ? window.CandleWS.getClosedBuckets1m(coin.sym)  : [];
        const candles    = anchoredPoolCandles(cb5m, gecko5m, bin5m, mexc5m, bybit5m, kucoin5m, bfnx5m, krk5m);
        const candles15m = anchoredPoolCandles(ws15m, cb15m, gecko15m, bin15m, mexc15m, bybit15m, kucoin15m, bfnx15m, krk15m);
        const candles1m  = anchoredPoolCandles(ws1m, cb1m, bin1m, mexc1m, bybit1m, kucoin1m, bfnx1m, krk1m);
        if (!candles.length) return;
        const book = existing.book?.bids?.length ? existing.book
          : bybitBook?.bids?.length ? bybitBook : kucoinBook?.bids?.length ? kucoinBook
          : bfnxBook?.bids?.length ? bfnxBook : krkBook?.bids?.length ? krkBook : null;
        const srcBase = (existing.source || '').split(' + ');
        if (mexc5m.length || mexc1m.length) srcBase.push('mexc');
        if (bybit5m.length || bybit1m.length) srcBase.push('bybit');
        if (kucoin5m.length || kucoin1m.length) srcBase.push('kucoin');
        if (bfnx5m.length || bfnx1m.length) srcBase.push('bitfinex');
        if (krk5m.length || krk1m.length) srcBase.push('kraken');
        candleCache[coin.sym] = { ...existing, candles, candles15m, candles1m, book,
          source: [...new Set(srcBase)].filter(Boolean).join(' + '), ts: Date.now() };
      } else {
        const hasLongHistory = Array.isArray(existing.longHistory) && existing.longHistory.length >= 90 && (Date.now() - (existing.longHistoryTs || 0) < 12 * 60 * 60 * 1000);
        const [cdc1m, cdc5m, cdc15m, cdcBook, cdcTrades, mexc1m, mexc5m, mexc15m, mexcBook, mexcTrades, bybit1m, bybit5m, bybit15m, bybitBook, bybitTrades, kucoin1m, kucoin5m, kucoin15m, kucoinBook, kucoinTrades, bfnx1m, bfnx5m, bfnx15m, bfnxBook, bfnxTrades, krk1m, krk5m, krk15m, krkBook, krkTrades, longHistory] = await Promise.all([
          fetchCDCCandles(coin.instrument, '1m', 180).catch(() => []),
          fetchCDCCandles(coin.instrument, '5m', 300).catch(() => []),
          fetchCDCCandles(coin.instrument, '15m', 300).catch(() => []),
          fetchCDCBook(coin.instrument).catch(() => null),
          fetchCDCTrades(coin.instrument).catch(() => []),
          fetchMEXCCandles(coin, '1m', 180).catch(() => []),
          fetchMEXCCandles(coin, '5m', 300).catch(() => []),
          fetchMEXCCandles(coin, '15m', 300).catch(() => []),
          fetchMEXCBook(coin).catch(() => null),
          fetchMEXCTrades(coin).catch(() => []),
          fetchBybitCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBybitCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBybitCandles(coin.sym, '15m', 300).catch(() => []),
          fetchBybitBook(coin.sym).catch(() => null),
          fetchBybitTrades(coin.sym).catch(() => []),
          fetchKucoinCandles(coin.sym, '1m', 180).catch(() => []),
          fetchKucoinCandles(coin.sym, '5m', 300).catch(() => []),
          fetchKucoinCandles(coin.sym, '15m', 300).catch(() => []),
          fetchKucoinBook(coin.sym).catch(() => null),
          fetchKucoinTrades(coin.sym).catch(() => []),
          fetchBitfinexCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBitfinexCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBitfinexCandles(coin.sym, '15m', 300).catch(() => []),
          fetchBitfinexBook(coin.sym).catch(() => null),
          fetchBitfinexTrades(coin.sym).catch(() => []),
          fetchKrakenCandles(coin.sym, '1m', 180).catch(() => []),
          fetchKrakenCandles(coin.sym, '5m', 300).catch(() => []),
          fetchKrakenCandles(coin.sym, '15m', 300).catch(() => []),
          fetchKrakenBook(coin.sym).catch(() => null),
          fetchKrakenTrades(coin.sym).catch(() => []),
          hasLongHistory ? Promise.resolve(existing.longHistory) : fetchGeckoMaxHistory(coin.geckoId).catch(() => existing.longHistory || []),
        ]);
        const ws15m_b = window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : [];
        const ws1m    = window.CandleWS ? window.CandleWS.getClosedBuckets1m(coin.sym)  : [];
        const candles5m  = anchoredPoolCandles(cb5m, cdc5m, mexc5m, bin5m, bybit5m, kucoin5m, bfnx5m, krk5m);
        const candles15m = anchoredPoolCandles(ws15m_b, cb15m, cdc15m, mexc15m, bin15m, bybit15m, kucoin15m, bfnx15m, krk15m);
        const candles1m  = anchoredPoolCandles(ws1m, cb1m, cdc1m, mexc1m, bin1m, bybit1m, kucoin1m, bfnx1m, krk1m);
        if (!candles5m.length) return;
        const book = existing.book?.bids?.length ? existing.book
          : cdcBook?.bids?.length ? cdcBook : mexcBook?.bids?.length ? mexcBook
          : bybitBook?.bids?.length ? bybitBook : kucoinBook?.bids?.length ? kucoinBook
          : bfnxBook?.bids?.length ? bfnxBook : krkBook?.bids?.length ? krkBook : null;
        const trades = existing.trades?.length ? existing.trades
          : cdcTrades.length ? cdcTrades : mexcTrades.length ? mexcTrades
          : bybitTrades.length ? bybitTrades : kucoinTrades.length ? kucoinTrades
          : bfnxTrades.length ? bfnxTrades : krkTrades;
        const sourceParts = (existing.source || '').split(' + ');
        if (cdc5m.length || cdc1m.length) sourceParts.push('crypto.com');
        if (mexc5m.length || mexc1m.length) sourceParts.push('mexc');
        if (bybit5m.length || bybit1m.length) sourceParts.push('bybit');
        if (kucoin5m.length || kucoin1m.length) sourceParts.push('kucoin');
        if (bfnx5m.length || bfnx1m.length) sourceParts.push('bitfinex');
        if (krk5m.length || krk1m.length) sourceParts.push('kraken');
        candleCache[coin.sym] = { ...existing,
          candles: candles5m, candles15m, candles1m, book, trades,
          source: [...new Set(sourceParts)].filter(Boolean).join(' + '),
          ts: Date.now(), longHistory,
          longHistoryTs: longHistory?.length ? Date.now() : (existing.longHistoryTs || 0),
        };
      }
      // Re-score this coin with the enriched data
      window._backtests[coin.sym]   = runWalkForwardBacktest(coin);
      window._predictions[coin.sym] = computePrediction(coin, window._backtests[coin.sym]);
    } catch (err) {
      console.warn(`[enrichCoinDataBackground] ${coin.sym}:`, err.message);
    }
  }

  // ================================================================
  // TECHNICAL INDICATORS
  // ================================================================

  // Wilder's smoothed RSI (canonical 14-period).
  // Step 1: seed avgGain/avgLoss as the SMA of the first `period` differences.
  // Step 2: apply Wilder's exponential smoothing (alpha = 1/period) for all
  //         subsequent bars.  This matches TradingView / most charting packages.
  function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    // Seed — SMA of first `period` differences
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= period;
    avgLoss /= period;
    // Wilder's smoothing for all remaining bars
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }

  function calcEMA(data, period) {
    const k = 2 / (period + 1);
    const ema = [data[0]];
    for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
    return ema;
  }

  function calcVWAP(candles) {
    let cumVol = 0, cumTP = 0;
    return candles.map(c => {
      const tp = (c.h + c.l + c.c) / 3;
      const vol = c.v || 1;
      cumVol += vol; cumTP += tp * vol;
      return cumVol > 0 ? cumTP / cumVol : tp;
    });
  }

  function calcStdDev(arr, period) {
    if (arr.length < period) return 0;
    const slice = arr.slice(-period);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  }

  function calcOBV(candles) {
    const obv = [0];
    for (let i = 1; i < candles.length; i++) {
      const vol = candles[i].v || 1;
      if (candles[i].c > candles[i - 1].c) obv.push(obv[i - 1] + vol);
      else if (candles[i].c < candles[i - 1].c) obv.push(obv[i - 1] - vol);
      else obv.push(obv[i - 1]);
    }
    return obv;
  }

  function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
    if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
    const emaFast = calcEMA(closes, fast);
    const emaSlow = calcEMA(closes, slow);
    const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
    const signalLine = calcEMA(macdLine, signalPeriod);
    const lastMACD = macdLine[macdLine.length - 1];
    const lastSignal = signalLine[signalLine.length - 1];
    return { macd: lastMACD, signal: lastSignal, histogram: lastMACD - lastSignal };
  }

  function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
    const needed = rsiPeriod + stochPeriod + Math.max(smoothK, smoothD) + 2;
    if (closes.length < needed) return { k: 50, d: 50 };
    const rsiValues = [];
    for (let i = rsiPeriod; i < closes.length; i++) {
      rsiValues.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
    }
    const rawK = [];
    for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
      const slice = rsiValues.slice(i - stochPeriod + 1, i + 1);
      const hi = Math.max(...slice);
      const lo = Math.min(...slice);
      rawK.push(hi !== lo ? ((rsiValues[i] - lo) / (hi - lo)) * 100 : 50);
    }
    if (!rawK.length) return { k: 50, d: 50 };
    const smoothedK = calcEMA(rawK, smoothK);
    const smoothedD = calcEMA(smoothedK, smoothD);
    return {
      k: smoothedK[smoothedK.length - 1],
      d: smoothedD[smoothedD.length - 1],
    };
  }

  function calcADX(candles, period = 14) {
    if (candles.length < period * 2 + 1) return { adx: 25, pdi: 25, mdi: 25 };
    const trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
      const up = c.h - p.h, down = p.l - c.l;
      plusDMs.push(up > down && up > 0 ? up : 0);
      minusDMs.push(down > up && down > 0 ? down : 0);
    }
    const wilderSmooth = (arr, p) => {
      if (arr.length < p) return [arr.reduce((s, v) => s + v, 0)];
      let s = arr.slice(0, p).reduce((a, v) => a + v, 0);
      const out = [s];
      for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
      return out;
    };
    const atrS = wilderSmooth(trs, period);
    const pdiS = wilderSmooth(plusDMs, period);
    const mdiS = wilderSmooth(minusDMs, period);
    const dxArr = atrS.map((atr, i) => {
      const pdi = atr > 0 ? (pdiS[i] / atr) * 100 : 0;
      const mdi = atr > 0 ? (mdiS[i] / atr) * 100 : 0;
      const sum = pdi + mdi;
      return sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0;
    });
    const adxArr = wilderSmooth(dxArr, period);
    const li = adxArr.length - 1;
    const lastATR = atrS[li];
    return {
      adx: adxArr[li],
      pdi: lastATR > 0 ? (pdiS[li] / lastATR) * 100 : 0,
      mdi: lastATR > 0 ? (mdiS[li] / lastATR) * 100 : 0,
    };
  }

  function calcIchimoku(candles) {
    if (candles.length < 9) return { tenkan: 0, kijun: 0, spanA: 0, spanB: 0, cloudPos: 'inside' };
    const high = arr => Math.max(...arr.map(c => c.h));
    const low = arr => Math.min(...arr.map(c => c.l));
    const tenkan = (high(candles.slice(-9)) + low(candles.slice(-9))) / 2;
    const slice26 = candles.length >= 26 ? candles.slice(-26) : candles;
    const kijun = (high(slice26) + low(slice26)) / 2;
    const slice52 = candles.length >= 52 ? candles.slice(-52) : slice26;
    const spanA = (tenkan + kijun) / 2;
    const spanB = (high(slice52) + low(slice52)) / 2;
    const price = candles[candles.length - 1].c;
    const cloudTop = Math.max(spanA, spanB);
    const cloudBot = Math.min(spanA, spanB);
    const cloudPos = price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside';
    return { tenkan, kijun, spanA, spanB, price, cloudPos, cloudTop, cloudBot };
  }

  function calcWilliamsR(candles, period = 14) {
    if (candles.length < period) return -50;
    const slice = candles.slice(-period);
    const hh = Math.max(...slice.map(c => c.h));
    const ll = Math.min(...slice.map(c => c.l));
    const close = candles[candles.length - 1].c;
    return hh !== ll ? ((hh - close) / (hh - ll)) * -100 : -50;
  }

  function calcMFI(candles, period = 14) {
    if (candles.length < period + 1) return 50;
    const slice = candles.slice(-period - 1);
    let posFlow = 0, negFlow = 0;
    for (let i = 1; i < slice.length; i++) {
      const prevTP = (slice[i - 1].h + slice[i - 1].l + slice[i - 1].c) / 3;
      const currTP = (slice[i].h + slice[i].l + slice[i].c) / 3;
      const rawFlow = currTP * (slice[i].v || 1);
      if (currTP > prevTP) posFlow += rawFlow;
      else if (currTP < prevTP) negFlow += rawFlow;
    }
    if (negFlow === 0) return posFlow > 0 ? 100 : 50;
    return 100 - 100 / (1 + posFlow / negFlow);
  }

  function calcATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    }
    return sum / period;
  }

  function calcBollinger(closes, period = 20, stdMult = 2) {
    if (closes.length < period) {
      const last = closes[closes.length - 1] || 0;
      return { middle: last, upper: last, lower: last, widthPct: 0, position: 0.5 };
    }
    const slice = closes.slice(-period);
    const middle = average(slice);
    const std = calcStdDev(closes, period);
    const upper = middle + std * stdMult;
    const lower = middle - std * stdMult;
    const width = Math.max(upper - lower, middle * 0.0001);
    const position = clamp((slice[slice.length - 1] - lower) / width, 0, 1);
    return {
      middle,
      upper,
      lower,
      widthPct: middle > 0 ? (width / middle) * 100 : 0,
      position,
    };
  }

  function calcTrendPersistence(closes, emaSeries, lookback = 8) {
    if (!closes.length || !emaSeries.length) return { aboveRate: 50, slopePct: 0, signal: 0, label: 'Neutral' };
    const span = Math.min(lookback, closes.length, emaSeries.length);
    const recentCloses = closes.slice(-span);
    const recentEma = emaSeries.slice(-span);
    const above = recentCloses.filter((close, idx) => close >= recentEma[idx]).length;
    const aboveRate = span ? (above / span) * 100 : 50;
    const emaStart = recentEma[0] || recentEma[recentEma.length - 1] || 1;
    const slopePct = emaStart ? ((recentEma[recentEma.length - 1] - emaStart) / emaStart) * 100 : 0;
    const signal = clamp(((aboveRate - 50) / 30) + slopePct * 4, -1, 1);
    const label = aboveRate >= 75 && slopePct > 0.04 ? 'Persistent uptrend'
      : aboveRate <= 25 && slopePct < -0.04 ? 'Persistent downtrend'
      : 'Mixed persistence';
    return { aboveRate, slopePct, signal, label };
  }

  function calcStructureBias(candles, atrPct) {
    if (!candles || candles.length < 12) {
      return { support: 0, resistance: 0, supportGapPct: 0, resistanceGapPct: 0, signal: 0, label: 'No structure', zone: 'none', bufferPct: atrPct || 0 };
    }
    const recent = candles.slice(-24);
    const latest = recent[recent.length - 1].c;
    const support = Math.min(...recent.map(c => c.l));
    const resistance = Math.max(...recent.map(c => c.h));
    const supportGapPct = latest > 0 ? ((latest - support) / latest) * 100 : 0;
    const resistanceGapPct = latest > 0 ? ((resistance - latest) / latest) * 100 : 0;
    const bufferPct = clamp(Math.max((atrPct || 0) * 1.25, 0.35), 0.35, 2.4);
    let zone = 'middle';
    let signal = 0;
    if (supportGapPct <= bufferPct && supportGapPct <= resistanceGapPct) {
      zone = 'support';
      signal = clamp((bufferPct - supportGapPct) / bufferPct, 0, 1) * 0.85;
    } else if (resistanceGapPct <= bufferPct && resistanceGapPct < supportGapPct) {
      zone = 'resistance';
      signal = -clamp((bufferPct - resistanceGapPct) / bufferPct, 0, 1) * 0.85;
    }
    const label = zone === 'support' ? 'Near support buffer'
      : zone === 'resistance' ? 'Near resistance buffer'
      : 'Inside range';
    return { support, resistance, supportGapPct, resistanceGapPct, signal, label, zone, bufferPct };
  }

  function slope(arr, n = 5) {
    if (arr.length < n + 1) return 0;
    const r = arr.slice(-n);
    const avg = (Math.abs(r[0]) + Math.abs(r[r.length - 1])) / 2 || 1;
    return ((r[r.length - 1] - r[0]) / avg) * 100;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function horizonKey(horizonMin) {
    const exact = SHORT_HORIZON_MINUTES.find(min => min === horizonMin);
    if (exact) return `h${exact}`;
    const fallback = SHORT_HORIZON_MINUTES.find(min => horizonMin <= min) || SHORT_HORIZON_MINUTES[SHORT_HORIZON_MINUTES.length - 1];
    return `h${fallback}`;
  }

  function projectionKey(horizonMin) {
    return `p${horizonMin}`;
  }

  function defaultShortFilter(horizonMin) {
    return SHORT_HORIZON_FILTERS[horizonKey(horizonMin)] || SHORT_HORIZON_FILTERS.h15;
  }

  function inferBarMinutes(candles) {
    if (!candles || candles.length < 2) return 5;
    const diffs = [];
    for (let i = 1; i < candles.length; i++) {
      const delta = candles[i].t - candles[i - 1].t;
      if (delta > 0) diffs.push(delta / 60000);
    }
    if (!diffs.length) return 5;
    diffs.sort((a, b) => a - b);
    const mid = Math.floor(diffs.length / 2);
    return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  }

  function confidenceFromScore(absScore) {
    if (absScore < 0.1) return Math.round(absScore * 100);
    return Math.round(Math.min(absScore * 120, 95));
  }

  function signalFromScore(score) {
    const absScore = Math.abs(score);
    if (absScore < 0.20) return 'neutral';               // scaled for post-amplification (1.6×)
    if (score > 0) return absScore > 0.55 ? 'strong_bull' : 'bullish';
    return absScore > 0.55 ? 'strong_bear' : 'bearish';
  }

  function scoreBucket(absScore) {
    if (absScore >= 0.4) return 'strong';
    if (absScore >= 0.25) return 'moderate';
    if (absScore >= 0.1) return 'light';
    return 'neutral';
  }

  function summarizeAgreement(signalMap) {
    const values = Object.values(signalMap).filter(v => Math.abs(v) >= 0.08);
    if (!values.length) return { agreement: 0.5, conflict: 0, bulls: 0, bears: 0, active: 0, label: 'Balanced' };
    const bulls = values.filter(v => v > 0).length;
    const bears = values.filter(v => v < 0).length;
    const active = bulls + bears;
    const majority = Math.max(bulls, bears);
    const minority = Math.min(bulls, bears);
    const agreement = active ? majority / active : 0.5;
    const conflict = active ? minority / active : 0;
    let label = 'Balanced';
    if (conflict >= 0.45) label = 'High conflict';
    else if (agreement >= 0.8) label = bulls > bears ? 'Bull consensus' : bears > bulls ? 'Bear consensus' : 'Balanced';
    else if (agreement >= 0.6) label = bulls > bears ? 'Bull tilt' : bears > bulls ? 'Bear tilt' : 'Balanced';
    return { agreement, conflict, bulls, bears, active, label };
  }

  function defaultBacktestFilter(horizonMin, sym = null) {
    const key = horizonKey(horizonMin);
    const override = sym ? BACKTEST_FILTER_OVERRIDES[sym]?.[key] : null;
    if (override) return override;
    return defaultShortFilter(horizonMin);
  }

  function orbitalProfileKey(sym) {
    if (['BTC', 'ETH', 'BNB', 'XRP'].includes(sym)) return 'core';
    if (['SOL', 'HYPE'].includes(sym)) return 'momentum';
    if (['DOGE'].includes(sym)) return 'highBeta';
    return 'core';
  }

  function getOrbitalRouterProfile(sym) {
    const key = orbitalProfileKey(sym);
    return { key, ...ORBITAL_ROUTER_PROFILES[key] };
  }

  function applyRouterProfile(packet, profile) {
    if (!profile) return packet;
    let weight = 1;
    switch (packet.category) {
      case 'benchmark': weight = profile.benchmarkWeight; break;
      case 'trend': weight = profile.trendWeight; break;
      case 'momentum': weight = profile.momentumWeight; break;
      case 'structure': weight = profile.structureWeight; break;
      case 'microstructure': weight = profile.microWeight; break;
      case 'timing': weight = profile.timingWeight; break;
      case 'derivatives': weight = profile.derivativeWeight; break;
      case 'historical': weight = profile.historyWeight; break;
      default: weight = 1; break;
    }
    if (packet.role === 'risk') weight *= profile.riskWeight;
    return {
      ...packet,
      relevance: clamp((packet.relevance || 0.7) * weight, 0.18, 1),
    };
  }

  function classifyMarketRegime(model) {
    const emaCross = model?.indicators?.ema?.value ?? 0;
    const momentum = model?.indicators?.momentum?.value ?? 0;
    const vwapDev = model?.indicators?.vwap?.value ?? 0;
    const atrPct = model?.volatility?.atrPct ?? 0;

    let trend = 'range';
    if (emaCross > 0.12 && momentum > 0.18) trend = 'bull';
    else if (emaCross < -0.12 && momentum < -0.18) trend = 'bear';
    else if (Math.abs(vwapDev) > 1.4 && Math.sign(vwapDev) !== Math.sign(momentum || 0)) trend = 'meanrev';

    let vol = 'mid';
    if (atrPct >= 1.4) vol = 'high';
    else if (atrPct <= 0.45) vol = 'low';

    return `${trend}_${vol}`;
  }

  function applyBacktestFilter(observation, filter) {
    const conflictVeto = observation.conflict >= 0.38 && observation.agreement < (filter.minAgreement + 0.08);
    const weakCoreVeto = Math.abs(observation.coreScore || 0) < (filter.entryThreshold * 0.92) && observation.conflict >= 0.30;
    const directionalCore = observation.coreScore ?? observation.score ?? 0;
    const structureVeto = (observation.structureZone === 'resistance' && directionalCore > 0 && observation.agreement < 0.65 && Math.abs(observation.structureBias || 0) >= 0.18)
      || (observation.structureZone === 'support' && directionalCore < 0 && observation.agreement < 0.65 && Math.abs(observation.structureBias || 0) >= 0.18);
    const persistenceVeto = Math.sign(observation.persistenceScore || 0) !== 0
      && Math.sign(observation.persistenceScore || 0) !== Math.sign(directionalCore)
      && Math.abs(observation.persistenceScore || 0) >= 0.35
      && Math.abs(directionalCore) < (filter.entryThreshold + 0.04);
    const isActive = observation.absScore >= filter.entryThreshold
      && observation.agreement >= filter.minAgreement
      && !conflictVeto
      && !weakCoreVeto
      && !structureVeto
      && !persistenceVeto;
    const direction = isActive ? (observation.score > 0 ? 1 : -1) : 0;
    return {
      ...observation,
      direction,
      signedReturn: direction === 0 ? 0 : observation.returnPct * direction,
      bucket: direction === 0 ? 'neutral' : scoreBucket(observation.absScore),
      appliedThreshold: filter.entryThreshold,
      appliedAgreement: filter.minAgreement,
      vetoed: !isActive && (conflictVeto || weakCoreVeto || structureVeto || persistenceVeto),
      vetoReason: conflictVeto ? 'conflict veto'
        : weakCoreVeto ? 'weak-core veto'
        : structureVeto ? 'structure veto'
        : persistenceVeto ? 'persistence veto'
        : '',
    };
  }

  function scoreCalibrationCandidate(observations, stats, horizonBars, horizonMin) {
    if (!observations.length || !stats.activeSignals) return -Infinity;

    const effectiveSamples = stats.activeSignals / Math.max(1, horizonBars);
    if (effectiveSamples < 2) return -Infinity;

    const targetCoverage = horizonMin <= 15 ? 0.52 : 0.40;
    const coverage = observations.length ? stats.activeSignals / observations.length : 0;
    const edgeRatio = stats.avgAbsReturn > 0 ? stats.avgSignedReturn / stats.avgAbsReturn : 0;
    const winEdge = (stats.winRate - 50) / 18;
    const pfEdge = stats.profitFactor > 0 ? (stats.profitFactor - 1) / 1.4 : -0.6;
    const sampleScore = clamp(effectiveSamples / 12, 0, 1);
    const strongStats = stats.buckets?.strong || { trades: 0, avgEdge: 0 };
    const strongEdge = strongStats.trades >= Math.max(4, horizonBars)
      ? clamp(strongStats.avgEdge / Math.max(stats.avgAbsReturn || 0.15, 0.15), -1, 1)
      : 0;
    const coveragePenalty = coverage > targetCoverage * 2
      ? (coverage - targetCoverage * 2) * 1.1
      : coverage < targetCoverage * 0.18
        ? (targetCoverage * 0.18 - coverage) * 1.4
        : 0;

    return winEdge * 1.25
      + edgeRatio * 1.10
      + pfEdge * 0.45
      + strongEdge * 0.25
      + sampleScore * 0.45
      - coveragePenalty;
  }

  function calibrateBacktestFilter(history, regime, horizonMin, horizonBars) {
    const fallback = defaultBacktestFilter(horizonMin);
    if (!history.length) return { ...fallback, calibrationSample: 0, regimeAware: false };

    const recent = history.slice(-Math.min(BACKTEST_LOOKBACK_OBS, 120));
    const regimeHistory = recent.filter(obs => obs.regime === regime);
    const pool = regimeHistory.length >= BACKTEST_MIN_REGIME_OBS ? regimeHistory : recent;

    let best = null;
    for (const entryThreshold of BACKTEST_THRESHOLD_GRID) {
      for (const minAgreement of BACKTEST_AGREEMENT_GRID) {
        const filtered = pool.map(obs => applyBacktestFilter(obs, { entryThreshold, minAgreement }));
        const stats = summarizeBacktestObservations(filtered, horizonMin, 0, horizonBars);
        const score = scoreCalibrationCandidate(pool, stats, horizonBars, horizonMin);
        if (!best || score > best.score || (score === best.score && stats.activeSignals > (best.stats?.activeSignals || 0))) {
          best = { score, entryThreshold, minAgreement, stats };
        }
      }
    }

    if (!best || !Number.isFinite(best.score) || (best.stats?.activeSignals || 0) < Math.max(3, horizonBars)) {
      return { ...fallback, calibrationSample: pool.length, regimeAware: pool === regimeHistory };
    }

    return {
      entryThreshold: best.entryThreshold,
      minAgreement: best.minAgreement,
      calibrationSample: pool.length,
      regimeAware: pool === regimeHistory,
      trainingStats: best.stats,
    };
  }

  function scoreHorizonReliability(stats) {
    if (!stats || !stats.observations) return 0.5;
    if (!stats.activeSignals) return clamp(0.46 + Math.min(0.08, stats.observations / 200), 0.46, 0.54);

    const effectiveSamples = stats.effectiveSamples || (stats.activeSignals / Math.max(1, stats.horizonBars));
    const edgeRatio = stats.avgAbsReturn > 0 ? stats.avgSignedReturn / stats.avgAbsReturn : 0;
    const winEdge = (stats.winRate - 50) / 20;
    const sampleFactor = clamp(effectiveSamples / 10, 0, 1);
    const coverageFactor = clamp((stats.coverage || 0) / 100, 0, 1);
    const profitFactor = stats.profitFactor > 0 ? Math.min(stats.profitFactor, 2.2) : 1;
    const pfEdge = (profitFactor - 1) / 1.2;

    let reliability = 0.50
      + winEdge * 0.16
      + edgeRatio * 0.16
      + pfEdge * 0.06
      + sampleFactor * 0.07
      + coverageFactor * 0.05;

    if (stats.avgSignedReturn < 0 && stats.winRate < 50) reliability = Math.min(reliability, 0.48);
    return clamp(reliability, 0.05, 0.95);
  }

  function buildEquityStats(observations, startingEquity = BACKTEST_STARTING_EQUITY) {
    let equity = startingEquity;
    let peak = startingEquity;
    let maxDrawdownPct = 0;
    observations.forEach(obs => {
      // Clamp to ±20% per trade to prevent overflow from bad candle data (single
      // exchange returning near-zero close that slips through pooling median)
      const boundedReturn = clamp(obs.signedReturn, -20, 20);
      equity *= 1 + (boundedReturn / 100);
      peak = Math.max(peak, equity);
      const drawdownPct = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
      maxDrawdownPct = Math.min(maxDrawdownPct, drawdownPct);
    });
    return {
      startingEquity,
      endingEquity: equity,
      returnPct: startingEquity > 0 ? ((equity / startingEquity) - 1) * 100 : 0,
      maxDrawdownPct: Math.abs(maxDrawdownPct),
    };
  }

  function summarizeReliabilityLabel(reliability) {
    return reliability >= 0.72 ? 'Strong'
      : reliability >= 0.56 ? 'Decent'
      : reliability >= 0.40 ? 'Mixed'
      : 'Weak';
  }

  function summarizeTradeFitLabel(tradeFit) {
    return tradeFit >= 0.72 ? 'Dialed in'
      : tradeFit >= 0.58 ? 'Short-term edge'
      : tradeFit >= 0.44 ? 'Watchlist only'
      : 'Needs caution';
  }

  function scoreTradeFitHorizon(stats, horizonMin) {
    if (!stats || !stats.observations) return null;
    if (!stats.activeSignals) {
      return clamp(0.45 + Math.min(0.06, stats.observations / 240), 0.45, 0.51);
    }

    const avgAbsReturn = Math.max(stats.avgAbsReturn || 0.12, 0.12);
    const edgeRatio = clamp(stats.avgSignedReturn / avgAbsReturn, -1, 1);
    const expectancyRatio = clamp((stats.expectancy || 0) / avgAbsReturn, -1, 1);
    const winScore = clamp((stats.winRate - 45) / 20, 0, 1);
    const edgeScore = clamp((edgeRatio + 0.15) / 0.95, 0, 1);
    const expectancyScore = clamp((expectancyRatio + 0.1) / 0.9, 0, 1);
    const sampleTarget = horizonMin <= 15 ? 7 : 5;
    const sampleBase = stats.normalizedEffectiveSamples || stats.effectiveSamples || 0;
    const sampleScore = clamp(sampleBase / sampleTarget, 0, 1);
    const drawdownLimit = horizonMin <= 15 ? 9 : 12;
    const drawdownScore = clamp(1 - ((stats.equity?.maxDrawdownPct || 0) / drawdownLimit), 0, 1);
    const strongBucket = stats.buckets?.strong || { trades: 0, winRate: 0, avgEdge: 0 };
    const strongScore = strongBucket.trades
      ? clamp((((strongBucket.winRate - 50) / 25) * 0.55 + clamp(strongBucket.avgEdge / avgAbsReturn, -1, 1) * 0.45 + 1) / 2, 0, 1)
      : 0.5;
    const coveragePenalty = clamp(((stats.coverage || 0) - (horizonMin <= 15 ? 62 : 46)) / 50, 0, 1);

    const tradeFit = 0.28
      + winScore * 0.20
      + edgeScore * 0.18
      + expectancyScore * 0.14
      + sampleScore * 0.10
      + drawdownScore * 0.08
      + strongScore * 0.10
      - coveragePenalty * 0.08;

    return clamp(tradeFit, 0.05, 0.95);
  }

  function scoreTradeFit(horizonStats = {}) {
    const parts = SHORT_HORIZON_MINUTES
      .map(horizonMin => {
        const score = scoreTradeFitHorizon(horizonStats[horizonKey(horizonMin)], horizonMin);
        return Number.isFinite(score) ? { score, weight: SHORT_HORIZON_WEIGHTS[horizonMin] || 1 } : null;
      })
      .filter(Boolean);
    if (!parts.length) return 0.5;
    const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
    return parts.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;
  }

  function summarizeSignalDrivers(signalVector, indicators) {
    const topDrivers = Object.entries(signalVector)
      .filter(([, value]) => Math.abs(value) >= 0.12)
      .map(([key, value]) => ({
        key,
        label: SIGNAL_LABELS[key] || key,
        direction: value > 0 ? 'up' : 'down',
        impact: Math.abs(value) * (COMPOSITE_WEIGHTS[key] || 0.1),
        detail: indicators[key]?.label || 'Active',
      }))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 3);

    return {
      topDrivers,
      driverSummary: topDrivers.length
        ? topDrivers.map(driver => `${driver.label} ${driver.direction === 'up' ? 'supports UP' : 'leans DOWN'} (${driver.detail})`).join(' · ')
        : 'No dominant driver cluster',
    };
  }

  // ================================================================
  // MICROSTRUCTURE ANALYSIS
  // ================================================================

  function analyzeBook(book) {
    if (!book || !book.bids || !book.asks) return { imbalance: 0, bidWall: 0, askWall: 0, spread: 0, label: 'No data' };
    const bidTotal = book.bids.reduce((s, b) => s + parseFloat(b.qty), 0);
    const askTotal = book.asks.reduce((s, a) => s + parseFloat(a.qty), 0);
    const total = bidTotal + askTotal || 1;
    const imbalance = (bidTotal - askTotal) / total; // -1 to 1
    const bestBid = parseFloat(book.bids[0]?.price || 0);
    const bestAsk = parseFloat(book.asks[0]?.price || 0);
    const spread = bestAsk > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;

    // Detect walls (single level > 30% of total side)
    const bidMax = Math.max(...book.bids.map(b => parseFloat(b.qty)));
    const askMax = Math.max(...book.asks.map(a => parseFloat(a.qty)));
    const bidWall = bidMax / (bidTotal || 1);
    const askWall = askMax / (askTotal || 1);

    let label = 'Balanced';
    if (imbalance > 0.3) label = 'Bid Heavy — Support Below';
    else if (imbalance < -0.3) label = 'Ask Heavy — Resistance Above';
    if (bidWall > 0.4) label += ' (bid wall)';
    if (askWall > 0.4) label += ' (ask wall)';

    return { imbalance, bidTotal, askTotal, bidWall, askWall, spread, label };
  }

  function analyzeTradeFlow(trades) {
    if (!trades || trades.length === 0) return { buyRatio: 50, sellRatio: 50, aggressor: 'neutral', bigTrades: 0, label: 'No data' };
    let buyVol = 0, sellVol = 0, bigTrades = 0;
    const avgQty = trades.reduce((s, t) => s + parseFloat(t.qty || 0), 0) / trades.length;
    trades.forEach(t => {
      const qty = parseFloat(t.qty || 0);
      if (t.side === 'buy') buyVol += qty; else sellVol += qty;
      if (qty > avgQty * 3) bigTrades++;
    });
    const total = buyVol + sellVol || 1;
    const buyRatio = (buyVol / total) * 100;
    const sellRatio = (sellVol / total) * 100;
    const aggressor = buyRatio > 60 ? 'buyers' : sellRatio > 60 ? 'sellers' : 'neutral';
    let label = aggressor === 'buyers' ? 'Buy Aggression' : aggressor === 'sellers' ? 'Sell Aggression' : 'Mixed Flow';
    if (bigTrades > 3) label += ` (${bigTrades} whale trades)`;
    return { buyRatio, sellRatio, aggressor, bigTrades, label };
  }

  // ================================================================
  // SCALP TIMING + CONTRARIAN DETECTION
  // ================================================================

  function detectScalpSetups(candles, indicators, book, tradeFlow, session) {
    const setups = [];
    const last = candles[candles.length - 1];
    const lastPrice = last.c;

    // 1. Session-based scalp windows
    if (session.current.scalp) {
      setups.push({
        type: 'scalp_window',
        label: `${session.current.label} — Prime Scalp Window`,
        desc: session.current.desc,
        strength: 'high',
        direction: null, // session itself is neutral
      });
    }

    // 2. VWAP overextension fade (contrarian)
    if (Math.abs(indicators.vwapDev) > 1.5) {
      const dir = indicators.vwapDev > 0 ? 'down' : 'up';
      setups.push({
        type: 'contrarian_vwap',
        label: `VWAP Fade — ${dir === 'up' ? 'Buy the dip' : 'Sell the rip'}`,
        desc: `Price ${indicators.vwapDev > 0 ? 'above' : 'below'} VWAP by ${Math.abs(indicators.vwapDev).toFixed(2)}%. Mean reversion likely within 15-30min.`,
        strength: Math.abs(indicators.vwapDev) > 2.5 ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 3. RSI exhaustion reversal (contrarian)
    if (indicators.rsi > 75 || indicators.rsi < 25) {
      const dir = indicators.rsi > 75 ? 'down' : 'up';
      setups.push({
        type: 'contrarian_rsi',
        label: `RSI Exhaustion — ${indicators.rsi > 75 ? 'Overbought fade' : 'Oversold bounce'}`,
        desc: `RSI at ${indicators.rsi.toFixed(1)} signals ${indicators.rsi > 75 ? 'buyer exhaustion' : 'seller exhaustion'}. Watch for reversal candle confirmation.`,
        strength: (indicators.rsi > 82 || indicators.rsi < 18) ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 4. Volume climax (contrarian)
    if (candles.length > 12) {
      const recentVols = candles.slice(-12).map(c => c.v);
      const avgVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
      const lastVol = candles[candles.length - 1].v;
      if (lastVol > avgVol * 2.5 && avgVol > 0) {
        const wasUp = last.c > last.o;
        setups.push({
          type: 'contrarian_volume_climax',
          label: `Volume Climax — ${wasUp ? 'Blow-off top' : 'Capitulation'}`,
          desc: `Last candle volume ${(lastVol / avgVol).toFixed(1)}x average. ${wasUp ? 'Buyers exhausted' : 'Sellers exhausted'} — expect reversal within 15min.`,
          strength: 'high',
          direction: wasUp ? 'down' : 'up',
        });
      }
    }

    // 5. Book imbalance scalp
    if (book && Math.abs(book.imbalance) > 0.35) {
      const dir = book.imbalance > 0 ? 'up' : 'down';
      setups.push({
        type: 'scalp_book',
        label: `Book Imbalance Scalp — ${dir === 'up' ? 'Bid wall support' : 'Ask wall resistance'}`,
        desc: `Order book ${book.imbalance > 0 ? 'bid-heavy' : 'ask-heavy'} (${Math.abs(book.imbalance * 100).toFixed(0)}% skew). Scalp ${dir} with tight stop.`,
        strength: Math.abs(book.imbalance) > 0.5 ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 6. Trade flow aggressor scalp
    if (tradeFlow && tradeFlow.aggressor !== 'neutral') {
      const dir = tradeFlow.aggressor === 'buyers' ? 'up' : 'down';
      setups.push({
        type: 'scalp_flow',
        label: `Tape Reading — ${tradeFlow.aggressor === 'buyers' ? 'Aggressive buying' : 'Aggressive selling'}`,
        desc: `Recent trades: ${tradeFlow.buyRatio.toFixed(0)}% buy / ${tradeFlow.sellRatio.toFixed(0)}% sell. ${tradeFlow.bigTrades > 0 ? tradeFlow.bigTrades + ' whale-size trades detected.' : ''}`,
        strength: (tradeFlow.buyRatio > 70 || tradeFlow.sellRatio > 70) ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 7. EMA cross scalp
    if (Math.abs(indicators.emaCross) > 0.15) {
      const dir = indicators.emaCross > 0 ? 'up' : 'down';
      setups.push({
        type: 'scalp_ema',
        label: `EMA Cross Momentum — ${dir === 'up' ? '9 above 21' : '9 below 21'}`,
        desc: `EMA(9) ${indicators.emaCross > 0 ? 'crossed above' : 'dropped below'} EMA(21). Ride the trend for 15-30min.`,
        strength: Math.abs(indicators.emaCross) > 0.4 ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 8. Dead zone warning (avoid scalping)
    if (!session.current.scalp && session.current.label === 'Dead Zone') {
      setups.push({
        type: 'avoid',
        label: 'Dead Zone — Avoid Scalping',
        desc: 'Low liquidity period. Wide spreads, erratic fills. Next scalp window opens in ' + session.minsToNext + ' min.',
        strength: 'warning',
        direction: null,
      });
    }

    return setups;
  }

  // ================================================================
  // PREDICTION COMPUTATION
  // ================================================================

  // Normal CDF approximation (Abramowitz & Stegun 26.2.17, max error 7.5e-8)
  // Used to compute P(price ≥ kalshiRef) — model-implied YES probability.
  // The Kalshi contract resolves YES if close price MEETS OR EXCEEDS the reference.
  function normalCDF(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const pdf  = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const p    = 1 - pdf * poly;
    return z >= 0 ? p : 1 - p;
  }


  // ── PATCH1.11: Wall Absorption Detector ─────────────────────────────────
  // Detects bid/ask wall events on 1m candles: large wick in one direction
  // that recovers, or same price level tested 2+ times with recoveries.
  // These events cause momentum/OBV to fire in the wick direction (wrong).
  // The correct bias is OPPOSITE to the wick (wall absorbed supply/demand).
  function detectWallAbsorption(candles1m) {
    if (!candles1m || candles1m.length < 6) return { detected: false, dir: 0, strength: 0 };
    const c = candles1m.slice(-16);
    let rangeSum = 0;
    for (let i = 0; i < c.length; i++) rangeSum += (c[i].h - c[i].l);
    const avgRange = rangeSum / c.length || 0.0001;

    let wallDetected = false, wallDir = 0, wallStrength = 0;

    // Pass 1: wick-body ratio on last 6 candles
    for (let i = Math.max(1, c.length - 6); i < c.length; i++) {
      const bar = c[i];
      const body = Math.abs(bar.c - bar.o);
      const range = bar.h - bar.l || 0.0001;
      const lowerWick = Math.min(bar.o, bar.c) - bar.l;
      const upperWick = bar.h - Math.max(bar.o, bar.c);
      if (range < avgRange * 1.1) continue;
      // Bid wall (lower wick absorption)
      if (lowerWick >= body * 2 && lowerWick >= avgRange * 1.4 && (lowerWick / range) > 0.38) {
        const strength = Math.min(1, (lowerWick / range) * 1.6);
        if (strength > wallStrength) { wallDetected = true; wallDir = 1; wallStrength = strength; }
      }
      // Ask wall (upper wick absorption)
      if (upperWick >= body * 2 && upperWick >= avgRange * 1.4 && (upperWick / range) > 0.38) {
        const strength = Math.min(1, (upperWick / range) * 1.6);
        if (strength > wallStrength) { wallDetected = true; wallDir = -1; wallStrength = strength; }
      }
    }

    // Pass 2: same-level retest (2+ tests of same support/resistance in last 10 bars)
    if (!wallDetected && c.length >= 8) {
      const last10 = c.slice(-10);
      const lows = last10.map(b => b.l);
      const highs = last10.map(b => b.h);
      const minLow = Math.min(...lows);
      const maxHigh = Math.max(...highs);
      const bidTests = lows.filter(l => Math.abs(l - minLow) / (minLow || 1) < 0.0006).length;
      const askTests = highs.filter(h => Math.abs(h - maxHigh) / (maxHigh || 1) < 0.0006).length;
      const lastBar = c[c.length - 1];
      if (bidTests >= 2 && lastBar.c >= lastBar.o) {
        wallDetected = true; wallDir = 1; wallStrength = Math.min(0.75, bidTests * 0.28);
      } else if (askTests >= 2 && lastBar.c <= lastBar.o) {
        wallDetected = true; wallDir = -1; wallStrength = Math.min(0.75, askTests * 0.28);
      }
    }
    return { detected: wallDetected, dir: wallDir, strength: wallStrength };
  }

  // ── detectReversalFlags: identify price/indicator divergences and exhaustion signals ──
  function detectReversalFlags(candles, rsi, macdResult, adxResult, obvSlope, mom) {
    const n = candles.length;
    if (n < 14) return [];
    const closes = candles.map(c => c.c);
    const flags = [];

    // Helper
    const absVal = v => Math.abs(v);

    // Pre-compute the earlier-window RSI once — reused by both RSI_BEAR_DIV and
    // RSI_BULL_DIV below (eliminates duplicate calcRSI call on the same slice).
    const _rsiOldShared = n >= 24 ? calcRSI(closes.slice(0, -8), 14) : null;

    // 1. RSI_BEAR_DIV
    if (n >= 24) {
      const oldSlice = closes.slice(-16, -8);
      const newSlice = closes.slice(-8);
      const oldHigh = Math.max(...oldSlice);
      const newHigh = Math.max(...newSlice);
      const rsiOld = _rsiOldShared;
      const rsiNew = rsi;
      const rsiDiff = rsiOld - rsiNew; // how much higher old RSI was
      if (newHigh > oldHigh * 1.003 && rsiDiff >= 5 && rsiNew > 50) {
        const severity = rsiNew > 65 ? 'critical' : 'warning';
        const strength = clamp(rsiDiff / 20, 0.3, 0.9);
        flags.push({ id: 'RSI_BEAR_DIV', severity, bias: 'bearish', label: 'RSI Bear Div', desc: `Price made higher high but RSI dropped ${rsiDiff.toFixed(1)} pts — bearish divergence`, strength });
      }
    }

    // 2. RSI_BULL_DIV
    if (n >= 24) {
      const oldSlice = closes.slice(-16, -8);
      const newSlice = closes.slice(-8);
      const oldLow = Math.min(...oldSlice);
      const newLow = Math.min(...newSlice);
      const rsiOld = _rsiOldShared;
      const rsiNew = rsi;
      const rsiDiff = rsiNew - rsiOld; // how much higher new RSI is
      if (newLow < oldLow * 0.997 && rsiDiff >= 5 && rsiNew < 50) {
        const severity = rsiNew < 35 ? 'critical' : 'warning';
        const strength = clamp(rsiDiff / 20, 0.3, 0.9);
        flags.push({ id: 'RSI_BULL_DIV', severity, bias: 'bullish', label: 'RSI Bull Div', desc: `Price made lower low but RSI rose ${rsiDiff.toFixed(1)} pts — bullish divergence`, strength });
      }
    }

    // 3. OBV_BEAR_DIV
    if (mom > 0.3 && obvSlope < -3.0) {
      const strength = clamp(absVal(obvSlope) / 12, 0.3, 0.8);
      flags.push({ id: 'OBV_BEAR_DIV', severity: 'warning', bias: 'bearish', label: 'OBV Bear Div', desc: `Price rising (mom ${mom.toFixed(2)}%) but OBV falling (slope ${obvSlope.toFixed(1)}) — distribution`, strength });
    }

    // 4. OBV_BULL_DIV
    if (mom < -0.3 && obvSlope > 3.0) {
      const strength = clamp(absVal(obvSlope) / 12, 0.3, 0.8);
      flags.push({ id: 'OBV_BULL_DIV', severity: 'warning', bias: 'bullish', label: 'OBV Bull Div', desc: `Price falling (mom ${mom.toFixed(2)}%) but OBV rising (slope ${obvSlope.toFixed(1)}) — accumulation`, strength });
    }

    // 5. MACD_BEAR_CROSS
    if (macdResult && closes.length >= 35) {
      const prevMacd = calcMACD(closes.slice(0, -1));
      const prevHist = prevMacd ? prevMacd.histogram : 0;
      if (prevHist > 0.00001 && macdResult.histogram < 0) {
        const severity = adxResult.adx > 22 ? 'alert' : 'warning';
        const strength = clamp(absVal(macdResult.histogram - prevHist) / 0.005, 0.35, 0.85);
        flags.push({ id: 'MACD_BEAR_CROSS', severity, bias: 'bearish', label: 'MACD Bear X', desc: `MACD histogram flipped negative (${macdResult.histogram.toFixed(5)}) — fresh bearish crossover`, strength });
      }
    }

    // 6. MACD_BULL_CROSS
    if (macdResult && closes.length >= 35) {
      const prevMacd = calcMACD(closes.slice(0, -1));
      const prevHist = prevMacd ? prevMacd.histogram : 0;
      if (prevHist < -0.00001 && macdResult.histogram > 0) {
        const severity = adxResult.adx > 22 ? 'alert' : 'warning';
        const strength = clamp(absVal(macdResult.histogram - prevHist) / 0.005, 0.35, 0.85);
        flags.push({ id: 'MACD_BULL_CROSS', severity, bias: 'bullish', label: 'MACD Bull X', desc: `MACD histogram flipped positive (${macdResult.histogram.toFixed(5)}) — fresh bullish crossover`, strength });
      }
    }

    // 7. ADX_HINGE
    if (n >= 10) {
      const prevAdxResult = calcADX(candles.slice(0, -3));
      const prevAdx = prevAdxResult ? prevAdxResult.adx : 0;
      if (prevAdx > adxResult.adx + 2.5 && prevAdx > 28) {
        const bias = adxResult.pdi > adxResult.mdi ? 'bearish' : 'bullish';
        const strength = clamp((prevAdx - adxResult.adx) / 8, 0.3, 0.75);
        flags.push({ id: 'ADX_HINGE', severity: 'warning', bias, label: 'ADX Hinge', desc: `ADX dropping from ${prevAdx.toFixed(1)} to ${adxResult.adx.toFixed(1)} — trend exhausting, possible reversal`, strength });
      }
    }

    // 8. VOL_CLIMAX_SELL
    if (n >= 22) {
      const avgVol = average(candles.slice(-21, -1).map(c => c.v || 0));
      const lastVol = candles[n - 1].v || 0;
      const volMult = avgVol > 0 ? lastVol / avgVol : 0;
      const lastBar = candles[n - 1];
      const body = absVal(lastBar.c - lastBar.o);
      const range = (lastBar.h - lastBar.l) || 0.00001;
      if (volMult >= 2.5 && lastBar.c < lastBar.o && body / range > 0.45) {
        const severity = volMult > 4 ? 'critical' : 'alert';
        flags.push({ id: 'VOL_CLIMAX_SELL', severity, bias: 'bullish', label: 'Vol Climax Sell', desc: `Volume ${volMult.toFixed(1)}x avg on large bearish bar — potential capitulation bottom`, strength: clamp(volMult / 6, 0.3, 0.9) });
      }
    }

    // 9. VOL_CLIMAX_BUY
    if (n >= 22) {
      const avgVol = average(candles.slice(-21, -1).map(c => c.v || 0));
      const lastVol = candles[n - 1].v || 0;
      const volMult = avgVol > 0 ? lastVol / avgVol : 0;
      const lastBar = candles[n - 1];
      const body = absVal(lastBar.c - lastBar.o);
      const range = (lastBar.h - lastBar.l) || 0.00001;
      if (volMult >= 2.5 && lastBar.c > lastBar.o && body / range > 0.45) {
        const severity = volMult > 4 ? 'critical' : 'alert';
        flags.push({ id: 'VOL_CLIMAX_BUY', severity, bias: 'bearish', label: 'Vol Climax Buy', desc: `Volume ${volMult.toFixed(1)}x avg on large bullish bar — potential euphoria top`, strength: clamp(volMult / 6, 0.3, 0.9) });
      }
    }

    // 10. WICK_REJECT_TOP
    {
      const atr = calcATR(candles, 14);
      const last4 = candles.slice(-4);
      let found = false;
      for (let i = 0; i < last4.length && !found; i++) {
        const bar = last4[i];
        const body = absVal(bar.c - bar.o);
        const range = (bar.h - bar.l) || 0.00001;
        const upperWick = bar.h - Math.max(bar.o, bar.c);
        if (upperWick > atr * 1.3 && upperWick > body * 2.2 && upperWick / range > 0.45) {
          flags.push({ id: 'WICK_REJECT_TOP', severity: 'warning', bias: 'bearish', label: 'Wick Reject Top', desc: `Upper wick ${(upperWick / atr).toFixed(1)}x ATR — strong rejection at highs`, strength: clamp(upperWick / (atr * 3), 0.3, 0.8) });
          found = true;
        }
      }
    }

    // 11. WICK_REJECT_BOT
    {
      const atr = calcATR(candles, 14);
      const last4 = candles.slice(-4);
      let found = false;
      for (let i = 0; i < last4.length && !found; i++) {
        const bar = last4[i];
        const body = absVal(bar.c - bar.o);
        const range = (bar.h - bar.l) || 0.00001;
        const lowerWick = Math.min(bar.o, bar.c) - bar.l;
        if (lowerWick > atr * 1.3 && lowerWick > body * 2.2 && lowerWick / range > 0.45) {
          flags.push({ id: 'WICK_REJECT_BOT', severity: 'warning', bias: 'bullish', label: 'Wick Reject Bot', desc: `Lower wick ${(lowerWick / atr).toFixed(1)}x ATR — strong rejection at lows`, strength: clamp(lowerWick / (atr * 3), 0.3, 0.8) });
          found = true;
        }
      }
    }

    // 12. MOM_FAILURE_BEAR
    if (n >= 13) {
      const oldMom = ((closes[n - 7] - closes[n - 13]) / (closes[n - 13] || 1)) * 100;
      if (mom > 0.2 && oldMom > 0 && mom < oldMom * 0.5 && mom < oldMom - 0.3) {
        const strength = clamp((oldMom - mom) / (oldMom || 1), 0.25, 0.70);
        flags.push({ id: 'MOM_FAILURE_BEAR', severity: 'warning', bias: 'bearish', label: 'Mom Failure Bear', desc: `Momentum fading: was ${oldMom.toFixed(2)}%, now ${mom.toFixed(2)}% — up move losing steam`, strength });
      }
    }

    // 13. MOM_FAILURE_BULL
    if (n >= 13) {
      const oldMom = ((closes[n - 7] - closes[n - 13]) / (closes[n - 13] || 1)) * 100;
      if (mom < -0.2 && oldMom < 0 && mom > oldMom * 0.5 && mom > oldMom + 0.3) {
        const strength = clamp((mom - oldMom) / (Math.abs(oldMom) || 1), 0.25, 0.70);
        flags.push({ id: 'MOM_FAILURE_BULL', severity: 'warning', bias: 'bullish', label: 'Mom Failure Bull', desc: `Selling pressure easing: was ${oldMom.toFixed(2)}%, now ${mom.toFixed(2)}% — down move losing steam`, strength });
      }
    }

    // Deduplicate by base ID (strip _BULL, _BEAR, _BUY, _SELL, _TOP, _BOT suffix)
    const baseMap = new Map();
    for (const flag of flags) {
      const base = flag.id.replace(/_(BULL|BEAR|BUY|SELL|TOP|BOT)$/, '');
      const existing = baseMap.get(base);
      if (!existing || flag.strength > existing.strength) {
        baseMap.set(base, flag);
      }
    }

    return Array.from(baseMap.values());
  }

  // ── runMomentumDecisionTree: multi-layer regime classifier ──────────────
  function runMomentumDecisionTree(candles, { rsi, emaCross, mom, vwapDevRolling, obvSlope, adxResult, macdResult, stochRsiResult, persistence, structure, reversalFlags }) {
    const n = candles.length;
    const closes = candles.map(c => c.c);
    const path = [];
    let regime = 'FLAT';
    let bias = 'neutral';
    let biasScore = 0;
    let biasConf = 20;
    let preemptive = false;
    let layer = 6;

    const sgn = v => v > 0 ? 1 : v < 0 ? -1 : 0;
    const absVal = v => Math.abs(v);

    const REGIME_LABELS = {
      DIV_BEARISH: 'Bearish Divergence', DIV_BULLISH: 'Bullish Divergence',
      OBV_DIV_BEAR: 'OBV Distribution', OBV_DIV_BULL: 'OBV Accumulation',
      SURGE_BULL: 'Bullish Surge', SURGE_BEAR: 'Bearish Surge',
      COIL_BULL: 'Bull Coil', COIL_BEAR: 'Bear Coil',
      TRENDING_UP: 'Uptrend', TRENDING_DOWN: 'Downtrend', TREND_MIXED: 'Mixed Trend',
      RANGE_ACCUMULATION: 'Accumulation', RANGE_DISTRIBUTION: 'Distribution',
      RANGE_TOP: 'Range Top', RANGE_BOT: 'Range Bottom',
      FLAG_CONFLICT: 'Signal Conflict',
      FLAT: 'Flat / Ranging',
    };

    // ── Layer 1: DIVERGENCE GATE (preemptive) ──
    if (n >= 20 && layer === 6) {
      const midIdx = n - 10;
      if (midIdx >= 8) {
        const oldSlice = closes.slice(midIdx - 8, midIdx);
        const newSlice = closes.slice(midIdx, n);
        const oldHigh = Math.max(...oldSlice);
        const newHigh = Math.max(...newSlice);
        const oldLow = Math.min(...oldSlice);
        const newLow = Math.min(...newSlice);
        const priceTrendUp = newHigh > oldHigh * 1.003;
        const priceTrendDown = newLow < oldLow * 0.997;
        const rsiOld = calcRSI(closes.slice(0, midIdx), 14);
        const rsiNew = rsi;
        const rsiDiff = rsiNew - rsiOld;

        if (priceTrendUp && rsiDiff < -4 && rsiNew > 55) {
          regime = 'DIV_BEARISH'; bias = 'bearish';
          biasScore = -clamp(absVal(rsiDiff) / 15, 0.35, 0.85);
          biasConf = Math.min(75, 45 + absVal(rsiDiff) * 1.5);
          preemptive = true; layer = 1;
          path.push({ node: 'RSI_DIV', type: 'divergence', cond: `priceTrendUp && rsiDiff=${rsiDiff.toFixed(1)} < -4 && rsiNew=${rsiNew.toFixed(1)} > 55`, result: 'DIV_BEARISH', pass: true });
        } else if (priceTrendDown && rsiDiff > 4 && rsiNew < 45) {
          regime = 'DIV_BULLISH'; bias = 'bullish';
          biasScore = clamp(absVal(rsiDiff) / 15, 0.35, 0.85);
          biasConf = Math.min(75, 45 + absVal(rsiDiff) * 1.5);
          preemptive = true; layer = 1;
          path.push({ node: 'RSI_DIV', type: 'divergence', cond: `priceTrendDown && rsiDiff=${rsiDiff.toFixed(1)} > 4 && rsiNew=${rsiNew.toFixed(1)} < 45`, result: 'DIV_BULLISH', pass: true });
        } else {
          path.push({ node: 'RSI_DIV', type: 'divergence', cond: `priceTrendUp=${priceTrendUp} rsiDiff=${rsiDiff.toFixed(1)}`, result: 'skip', pass: false });
        }
      }

      // OBV divergence check (only if no RSI div found yet)
      if (layer === 6) {
        if (mom > 0.25 && obvSlope < -2.5) {
          regime = 'OBV_DIV_BEAR'; bias = 'bearish';
          biasScore = -0.55; biasConf = 58; preemptive = true; layer = 1;
          path.push({ node: 'OBV_DIV', type: 'divergence', cond: `mom=${mom.toFixed(2)}>0.25 && obvSlope=${obvSlope.toFixed(1)}<-2.5`, result: 'OBV_DIV_BEAR', pass: true });
        } else if (mom < -0.25 && obvSlope > 2.5) {
          regime = 'OBV_DIV_BULL'; bias = 'bullish';
          biasScore = 0.55; biasConf = 58; preemptive = true; layer = 1;
          path.push({ node: 'OBV_DIV', type: 'divergence', cond: `mom=${mom.toFixed(2)}<-0.25 && obvSlope=${obvSlope.toFixed(1)}>2.5`, result: 'OBV_DIV_BULL', pass: true });
        } else {
          path.push({ node: 'OBV_DIV', type: 'divergence', cond: `mom=${mom.toFixed(2)} obvSlope=${obvSlope.toFixed(1)}`, result: 'skip', pass: false });
        }
      }
    }

    // ── Layer 2: VOLUME SURGE GATE (preemptive) ──
    if (layer === 6 && n >= 25) {
      const avgVol = average(candles.slice(-23, -3).map(c => c.v || 0));
      const recentBars = candles.slice(-3);
      const recentAvgVol = average(recentBars.map(c => c.v || 0));
      const surgeMult = avgVol > 0 ? recentAvgVol / avgVol : 0;

      if (surgeMult >= 1.8) {
        let surgeUp = 0, surgeDn = 0;
        for (const bar of recentBars) {
          const body = absVal(bar.c - bar.o);
          const range = (bar.h - bar.l) || 0.00001;
          const vol = bar.v || 0;
          if (body / range > 0.45) {
            if (bar.c > bar.o) surgeUp += vol;
            else surgeDn += vol;
          }
        }
        const surgeDir = surgeUp > surgeDn * 1.4 ? 1 : surgeDn > surgeUp * 1.4 ? -1 : 0;
        if (surgeDir !== 0) {
          regime = surgeDir > 0 ? 'SURGE_BULL' : 'SURGE_BEAR';
          bias = surgeDir > 0 ? 'bullish' : 'bearish';
          biasScore = surgeDir * clamp(0.40 + (surgeMult - 1.8) * 0.15, 0.40, 0.80);
          biasConf = Math.min(80, 50 + Math.min(surgeMult * 15, 30));
          preemptive = true; layer = 2;
          path.push({ node: 'VOL_SURGE', type: 'surge', cond: `surgeMult=${surgeMult.toFixed(2)} surgeDir=${surgeDir}`, result: regime, pass: true });
        } else {
          path.push({ node: 'VOL_SURGE', type: 'surge', cond: `surgeMult=${surgeMult.toFixed(2)} surgeDir=0`, result: 'skip', pass: false });
        }
      } else {
        path.push({ node: 'VOL_SURGE', type: 'surge', cond: `surgeMult=${surgeMult.toFixed(2)}<1.8`, result: 'skip', pass: false });
      }
    }

    // ── Layer 3: STRUCTURE COIL GATE (preemptive) ──
    if (layer === 6 && n >= 20) {
      const atrRecent = calcATR(candles.slice(-6), 5);
      const atrHist = calcATR(candles.slice(-20, -5), 14);
      const coilRatio = atrHist > 0 ? atrRecent / atrHist : 1;

      if (coilRatio < 0.55) {
        const ema9Last = calcEMA(closes, 9);
        const ema21Last = calcEMA(closes, 21);
        const lastEma9 = ema9Last[ema9Last.length - 1];
        const lastEma21 = ema21Last[ema21Last.length - 1];
        const lastClose = closes[closes.length - 1];
        const priceAboveEma = lastClose > lastEma9 && lastClose > lastEma21;
        const priceBelowEma = lastClose < lastEma9 && lastClose < lastEma21;
        const macdMom = macdResult && macdResult.histogram > 0 ? 1 : -1;

        if (priceAboveEma) {
          regime = 'COIL_BULL'; bias = 'bullish';
          biasScore = 0.30 * (macdMom >= 0 ? 1.2 : 0.8);
          biasConf = Math.min(65, 40 + (0.55 - coilRatio) * 80);
          preemptive = true; layer = 3;
          path.push({ node: 'COIL', type: 'structure', cond: `coilRatio=${coilRatio.toFixed(2)}<0.55 priceAboveEma=true`, result: 'COIL_BULL', pass: true });
        } else if (priceBelowEma) {
          regime = 'COIL_BEAR'; bias = 'bearish';
          biasScore = -0.30 * (macdMom <= 0 ? 1.2 : 0.8);
          biasConf = Math.min(65, 40 + (0.55 - coilRatio) * 80);
          preemptive = true; layer = 3;
          path.push({ node: 'COIL', type: 'structure', cond: `coilRatio=${coilRatio.toFixed(2)}<0.55 priceBelowEma=true`, result: 'COIL_BEAR', pass: true });
        } else {
          path.push({ node: 'COIL', type: 'structure', cond: `coilRatio=${coilRatio.toFixed(2)}<0.55 ema=neutral`, result: 'skip', pass: false });
        }
      } else {
        path.push({ node: 'COIL', type: 'structure', cond: `coilRatio=${coilRatio.toFixed(2)}>=0.55`, result: 'skip', pass: false });
      }
    }

    // ── Layer 4: TREND GATE (confirming) ──
    if (layer === 6 && adxResult.adx >= 22) {
      const adx = adxResult.adx;
      const pdi = adxResult.pdi;
      const mdi = adxResult.mdi;
      const diDiff = (pdi - mdi) / ((pdi + mdi) || 1);
      const trendUp = emaCross > 0 && pdi > mdi && mom > 0;
      const trendDn = emaCross < 0 && mdi > pdi && mom < 0;

      if (trendUp) {
        const str = clamp((adx / 50) * Math.min(absVal(emaCross) / 0.3, 1), 0.25, 1);
        const confirmed = (macdResult && macdResult.histogram > 0) && (stochRsiResult && stochRsiResult.k > 50);
        const caution = (macdResult && macdResult.histogram < 0) || (stochRsiResult && stochRsiResult.k > 82);
        regime = 'TRENDING_UP'; bias = 'bullish'; layer = 4;
        biasScore = str * (confirmed ? 1.15 : caution ? 0.65 : 0.90);
        biasConf = confirmed ? Math.min(88, 68 + (adx - 22) * 0.8)
                 : caution  ? Math.min(55, 42 + (adx - 22) * 0.5)
                             : Math.min(72, 58 + (adx - 22) * 0.6);
        path.push({ node: 'TREND', type: 'trend', cond: `adx=${adx.toFixed(1)} trendUp confirmed=${confirmed} caution=${caution}`, result: 'TRENDING_UP', pass: true });
      } else if (trendDn) {
        const str = clamp((adx / 50) * Math.min(absVal(emaCross) / 0.3, 1), 0.25, 1);
        const confirmed = (macdResult && macdResult.histogram < 0) && (stochRsiResult && stochRsiResult.k < 50);
        const caution = (macdResult && macdResult.histogram > 0) || (stochRsiResult && stochRsiResult.k < 18);
        regime = 'TRENDING_DOWN'; bias = 'bearish'; layer = 4;
        biasScore = -(str * (confirmed ? 1.15 : caution ? 0.65 : 0.90));
        biasConf = confirmed ? Math.min(88, 68 + (adx - 22) * 0.8)
                 : caution  ? Math.min(55, 42 + (adx - 22) * 0.5)
                             : Math.min(72, 58 + (adx - 22) * 0.6);
        path.push({ node: 'TREND', type: 'trend', cond: `adx=${adx.toFixed(1)} trendDn confirmed=${confirmed} caution=${caution}`, result: 'TRENDING_DOWN', pass: true });
      } else {
        const diDiffVal = (pdi - mdi) / ((pdi + mdi) || 1);
        regime = 'TREND_MIXED'; layer = 4;
        biasScore = diDiffVal * 0.35 * sgn(emaCross || mom);
        biasConf = 32;
        bias = biasScore > 0 ? 'bullish' : biasScore < 0 ? 'bearish' : 'neutral';
        path.push({ node: 'TREND', type: 'trend', cond: `adx=${adx.toFixed(1)} mixed diDiff=${diDiffVal.toFixed(2)}`, result: 'TREND_MIXED', pass: true });
      }
    }

    // ── Layer 5: RANGE GATE (confirming) ──
    if (layer === 6 && adxResult.adx < 22) {
      const accumulating = obvSlope > 2.0 && rsi > 50 && absVal(vwapDevRolling) < 0.5;
      const distributing = obvSlope < -2.0 && rsi < 50 && absVal(vwapDevRolling) < 0.5;
      const atRangeTop = vwapDevRolling > 0.8 && stochRsiResult && stochRsiResult.k > 65;
      const atRangeBot = vwapDevRolling < -0.8 && stochRsiResult && stochRsiResult.k < 35;

      if (accumulating) {
        regime = 'RANGE_ACCUMULATION'; bias = 'bullish';
        biasScore = clamp(obvSlope / 6, 0.20, 0.55); biasConf = 45; layer = 5;
        path.push({ node: 'RANGE', type: 'range', cond: 'accumulating', result: 'RANGE_ACCUMULATION', pass: true });
      } else if (distributing) {
        regime = 'RANGE_DISTRIBUTION'; bias = 'bearish';
        biasScore = -clamp(absVal(obvSlope) / 6, 0.20, 0.55); biasConf = 45; layer = 5;
        path.push({ node: 'RANGE', type: 'range', cond: 'distributing', result: 'RANGE_DISTRIBUTION', pass: true });
      } else if (atRangeTop) {
        regime = 'RANGE_TOP'; bias = 'bearish';
        biasScore = -0.35; biasConf = 40; layer = 5;
        path.push({ node: 'RANGE', type: 'range', cond: 'atRangeTop', result: 'RANGE_TOP', pass: true });
      } else if (atRangeBot) {
        regime = 'RANGE_BOT'; bias = 'bullish';
        biasScore = 0.35; biasConf = 40; layer = 5;
        path.push({ node: 'RANGE', type: 'range', cond: 'atRangeBot', result: 'RANGE_BOT', pass: true });
      } else {
        regime = 'FLAT'; layer = 5;
        biasScore = 0; biasConf = 20; bias = 'neutral';
        path.push({ node: 'RANGE', type: 'range', cond: `adx=${adxResult.adx.toFixed(1)}<22 no condition`, result: 'FLAT', pass: false });
      }
    }

    // ── Layer 6: FLAT ──
    if (layer === 6) {
      const macdMom = sgn(macdResult ? macdResult.histogram : 0);
      const persMom0 = persistence && persistence.signal ? persistence.signal : 0;
      biasScore = clamp((macdMom + sgn(persMom0)) / 4, -0.18, 0.18);
      biasConf = 20; layer = 6; regime = 'FLAT';
      bias = biasScore > 0.02 ? 'bullish' : biasScore < -0.02 ? 'bearish' : 'neutral';
      path.push({ node: 'FLAT', type: 'flat', cond: `macdMom=${macdMom} persMom=${persMom0.toFixed(2)}`, result: 'FLAT', pass: false });
    }

    // ── Reversal flag integration ──
    if (Array.isArray(reversalFlags) && reversalFlags.length > 0) {
      for (const flag of reversalFlags) {
        const aligns = flag.bias === bias;
        if (aligns) {
          if (flag.severity === 'critical') { biasConf = Math.min(biasConf + 12, 95); biasScore = clamp(biasScore * 1.10, -1, 1); }
          else if (flag.severity === 'alert') { biasConf = Math.min(biasConf + 6, 95); }
        } else if (flag.bias !== 'neutral') {
          if (flag.severity === 'critical') { biasConf = Math.max(biasConf - 15, 5); biasScore *= 0.80; }
          else if (flag.severity === 'alert') { biasConf = Math.max(biasConf - 8, 5); }
        }
      }
      // Check for conflict flip
      const critAlertContra = reversalFlags.filter(f => f.bias !== bias && f.bias !== 'neutral' && (f.severity === 'critical' || f.severity === 'alert'));
      if (critAlertContra.length > 0 && biasConf < 35) {
        regime = 'FLAG_CONFLICT'; bias = 'neutral'; biasScore *= 0.3; biasConf = 15;
        path.push({ node: 'FLAG_CONFLICT', type: 'reversal', cond: `${critAlertContra.length} critical/alert contra flags && biasConf<35`, result: 'FLAG_CONFLICT', pass: true });
      }
    }

    // ── Persistence modifier (layers 5-6 only) ──
    if (layer >= 5) {
      const persMom = persistence && persistence.signal ? persistence.signal : 0;
      if (absVal(persMom) > 0.15) {
        const agrees = sgn(persMom) === sgn(biasScore);
        if (agrees) {
          biasConf = Math.min(biasConf + 8, 75);
          biasScore = clamp(biasScore * 1.10, -1, 1);
        } else {
          biasConf = Math.max(biasConf - 12, 10);
          biasScore *= 0.82;
        }
      }
    }

    // ── Final verdict ──
    biasScore = clamp(biasScore, -1, 1);
    biasConf = Math.round(clamp(biasConf, 0, 95));

    let verdict;
    if (layer <= 3) {
      verdict = biasScore > 0.20 ? 'UP' : biasScore < -0.20 ? 'DOWN' : 'HOLD';
    } else if (layer <= 5) {
      if (biasConf >= 55 && absVal(biasScore) >= 0.30) verdict = biasScore > 0 ? 'UP' : 'DOWN';
      else if (biasConf < 28 || absVal(biasScore) < 0.12) verdict = 'HOLD';
      else verdict = biasScore > 0.12 ? 'UP' : biasScore < -0.12 ? 'DOWN' : 'HOLD';
    } else {
      verdict = absVal(biasScore) > 0.12 && biasConf > 22 ? (biasScore > 0 ? 'UP' : 'DOWN') : 'HOLD';
    }

    const regimeLabel = REGIME_LABELS[regime] || 'Flat / Ranging';

    return { regime, bias, biasScore, biasConf, verdict, path, preemptive, layer, regimeLabel };
  }

  // ── applyBiasFilter: nudge signalVector components toward MDT bias ───────
  function applyBiasFilter(signalVector, mdt) {
    if (!mdt || Math.abs(mdt.biasScore) < 0.18 || mdt.biasConf < 35) return { ...signalVector };

    const biasDir = Math.sign(mdt.biasScore);
    const strength = Math.abs(mdt.biasScore) * (mdt.biasConf / 95);
    const boostMult = mdt.preemptive ? 0.28 : 0.22;
    const dampMult = mdt.preemptive ? 0.22 : 0.18;

    const trendKeys = ['ema', 'macd', 'momentum', 'obv', 'persistence', 'structure', 'adx'];
    const oscKeys = ['rsi', 'stochrsi', 'williamsR', 'mfi', 'bands'];

    const result = { ...signalVector };

    for (const key of trendKeys) {
      if (result[key] === undefined) continue;
      const val = result[key];
      if (Math.sign(val) === biasDir && Math.abs(val) > 0.05) {
        result[key] = val * (1 + strength * boostMult);
      } else if (Math.sign(val) !== biasDir && Math.sign(val) !== 0 && Math.abs(val) > 0.08) {
        result[key] = val * (1 - strength * dampMult);
      }
    }

    for (const key of oscKeys) {
      if (result[key] === undefined) continue;
      const val = result[key];
      if (Math.sign(val) === biasDir && Math.abs(val) > 0.05) {
        result[key] = val * (1 + strength * 0.12);
      } else if (Math.sign(val) !== biasDir && Math.sign(val) !== 0 && Math.abs(val) > 0.08) {
        result[key] = val * (1 - strength * 0.10);
      }
    }

    return result;
  }

  function buildSignalModel(candles, book, trades, options = {}) {
    if (!candles || candles.length < 20) return null;

    const includeMicrostructure = options.includeMicrostructure !== false;
    const includeSetups = options.includeSetups !== false;
    const closes = candles.map(c => c.c);
    const lastPrice = closes[closes.length - 1];
    const session = options.session || getSessionInfo();

    // --- Indicators ---
    const rsi = calcRSI(closes);
    let rsiSig = 0;
    if (rsi > 70) rsiSig = -0.6 - ((rsi - 70) / 30) * 0.4;
    else if (rsi < 30) rsiSig = 0.6 + ((30 - rsi) / 30) * 0.4;
    else rsiSig = (rsi - 50) / 50 * 0.3;

    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const emaCross = (ema9[ema9.length - 1] - ema21[ema21.length - 1]) / (ema21[ema21.length - 1] || 1) * 100;
    const emaSig = clamp(emaCross * 5, -1, 1);

    const vwap = calcVWAP(candles);
    const vwapLast = vwap[vwap.length - 1];
    const vwapDev = ((lastPrice - vwapLast) / (vwapLast || 1)) * 100;
    const vwapStd = calcStdDev(closes, 20);
    const vwapBands = { upper: vwapLast + vwapStd * 2, lower: vwapLast - vwapStd * 2 };
    let vwapSig = 0;
    // Use a rolling 80-candle VWAP for deviation check so the signal
    // doesn't fire on session-level drift that has nothing to do with
    // short-term over-extension.
    const vwapRolling = calcVWAP(candles.slice(-80));
    const vwapRollingLast = vwapRolling[vwapRolling.length - 1];
    const vwapDevRolling = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
    if (Math.abs(vwapDevRolling) < 0.3) vwapSig = 0;
    else if (vwapDevRolling > 1.5) vwapSig = -0.5;
    else if (vwapDevRolling < -1.5) vwapSig = 0.5;
    else vwapSig = vwapDevRolling > 0 ? 0.3 : -0.3;

    const obv = calcOBV(candles);
    const obvSlope = slope(obv, 8);
    const obvSig = clamp(obvSlope / 5, -1, 1);

    // Volume delta from candle body position
    const recent = candles.slice(-12);
    let buyV = 0, sellV = 0;
    recent.forEach(c => {
      const range = c.h - c.l || 0.0001;
      const bodyPos = (c.c - c.l) / range;
      const vol = c.v || 1;
      buyV += vol * bodyPos;
      sellV += vol * (1 - bodyPos);
    });
    const volRatio = buyV / (sellV || 1);
    const volSig = clamp((volRatio - 1) * 0.5, -1, 1);

    const mom = closes.length > 6 ? ((closes[closes.length - 1] - closes[closes.length - 7]) / (closes[closes.length - 7] || 1)) * 100 : 0;
    const momSig = clamp(mom / 2, -1, 1);

    const atr = calcATR(candles);
    const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
    const bands = calcBollinger(closes);
    const bandDistance = bands.position - 0.5;
    let bandSig = 0;
    if (bands.position >= 0.88) bandSig = -clamp((bands.position - 0.88) / 0.12, 0, 1);
    else if (bands.position <= 0.12) bandSig = clamp((0.12 - bands.position) / 0.12, 0, 1);
    else bandSig = clamp(-bandDistance * 0.45, -0.22, 0.22);
    const persistence = calcTrendPersistence(closes, ema21);
    const structure = calcStructureBias(candles, atrPct);

    // --- Extended Indicators ---
    const macdResult = calcMACD(closes);
    const macdHistNorm = lastPrice > 0 ? (macdResult.histogram / lastPrice) * 1000 : 0;
    const macdCross = macdResult.macd > macdResult.signal ? 0.18 : macdResult.macd < macdResult.signal ? -0.18 : 0;
    const macdSig = clamp(macdHistNorm * 2.5 + macdCross, -1, 1);

    const stochRsiResult = calcStochRSI(closes);
    const kd = stochRsiResult.k - stochRsiResult.d;
    let stochSig = 0;
    if (stochRsiResult.k > 80) stochSig = -0.6 - ((stochRsiResult.k - 80) / 20) * 0.4;
    else if (stochRsiResult.k < 20) stochSig = 0.6 + ((20 - stochRsiResult.k) / 20) * 0.4;
    else stochSig = (stochRsiResult.k - 50) / 50 * 0.35;
    stochSig = clamp(stochSig + clamp(kd / 20, -0.18, 0.18), -1, 1);

    const adxResult = calcADX(candles);
    const diDiff = (adxResult.pdi - adxResult.mdi) / Math.max(adxResult.pdi + adxResult.mdi, 1);
    const adxStrength = clamp(adxResult.adx / 50, 0, 1);
    const adxSig = clamp(diDiff * adxStrength * 1.2, -1, 1);

    const ichimoku = calcIchimoku(candles);
    let ichiSig = 0;
    if (ichimoku.cloudPos === 'above') ichiSig = 0.5 + (ichimoku.tenkan > ichimoku.kijun ? 0.2 : 0);
    else if (ichimoku.cloudPos === 'below') ichiSig = -0.5 - (ichimoku.tenkan < ichimoku.kijun ? 0.2 : 0);
    else ichiSig = ichimoku.tenkan > ichimoku.kijun ? 0.12 : ichimoku.tenkan < ichimoku.kijun ? -0.12 : 0;
    ichiSig = clamp(ichiSig, -1, 1);

    const wR = calcWilliamsR(candles);
    let wRSig = 0;
    if (wR > -20) wRSig = -0.6 - ((wR + 20) / 20) * 0.4;
    else if (wR < -80) wRSig = 0.6 + ((-80 - wR) / 20) * 0.4;
    else wRSig = (wR + 50) / 50 * -0.3;
    wRSig = clamp(wRSig, -1, 1);

    const mfi = calcMFI(candles);
    let mfiSig = 0;
    if (mfi > 80) mfiSig = -0.6 - ((mfi - 80) / 20) * 0.4;
    else if (mfi < 20) mfiSig = 0.6 + ((20 - mfi) / 20) * 0.4;
    else mfiSig = (mfi - 50) / 50 * 0.35;
    mfiSig = clamp(mfiSig, -1, 1);

    // --- Trend Regime Modulation ---
    // In a strong trend, oscillator "overbought/oversold" signals are continuation
    // cues, not reversal cues. Suppress contrarian oscillator signals proportionally
    // to trend strength so they don't cancel out the trend-following signals.
    const isBullTrend = emaCross > 0.15 && adxResult.pdi > adxResult.mdi && adxResult.adx > 22;
    const isBearTrend = emaCross < -0.15 && adxResult.mdi > adxResult.pdi && adxResult.adx > 22;
    if (isBullTrend || isBearTrend) {
      const suppressFactor = clamp((adxResult.adx - 22) / 28, 0, 0.70);
      if (isBullTrend) {
        // Dampen bearish readings from contrarian oscillators during bull trends
        if (rsiSig   < 0) rsiSig   *= (1 - suppressFactor);
        if (stochSig < 0) stochSig *= (1 - suppressFactor);
        if (wRSig    < 0) wRSig    *= (1 - suppressFactor);
        if (bandSig  < 0) bandSig  *= (1 - suppressFactor * 0.6);
        if (mfiSig   < 0) mfiSig   *= (1 - suppressFactor * 0.6);
      } else {
        // Dampen bullish readings from contrarian oscillators during bear trends
        if (rsiSig   > 0) rsiSig   *= (1 - suppressFactor);
        if (stochSig > 0) stochSig *= (1 - suppressFactor);
        if (wRSig    > 0) wRSig    *= (1 - suppressFactor);
        if (bandSig  > 0) bandSig  *= (1 - suppressFactor * 0.6);
        if (mfiSig   > 0) mfiSig   *= (1 - suppressFactor * 0.6);
      }
    }

    // --- Book & Trade Flow ---
    const bookAnalysis = analyzeBook(book);
    const tradeFlow = analyzeTradeFlow(trades);
    const bookSig = clamp((bookAnalysis.imbalance || 0) * 1.5, -1, 1);
    let flowSig = 0;
    if (tradeFlow.aggressor === 'buyers') flowSig = Math.min(1, (tradeFlow.buyRatio - 50) / 30);
    else if (tradeFlow.aggressor === 'sellers') flowSig = Math.max(-1, -(tradeFlow.sellRatio - 50) / 30);

    // --- Prediction Market Sentiment (Kalshi + Polymarket) ---
    const mktData = options.sym ? (window.PredictionMarkets?.getCoin(options.sym) ?? null) : null;
    let mktSig = 0;
    if (mktData && mktData.combinedProb !== null) {
      const p = mktData.combinedProb;
      if (p > 0.62) mktSig = Math.min(1, (p - 0.62) / 0.38);
      else if (p < 0.38) mktSig = -Math.min(1, (0.38 - p) / 0.38);
    }

    const signalVector = {
      rsi: rsiSig,
      ema: emaSig,
      vwap: vwapSig,
      obv: obvSig,
      volume: volSig,
      momentum: momSig,
      bands: bandSig,
      persistence: persistence.signal,
      structure: structure.signal,
      book: includeMicrostructure ? bookSig : 0,
      flow: includeMicrostructure ? flowSig : 0,
      macd: macdSig,
      stochrsi: stochSig,
      adx: adxSig,
      ichimoku: ichiSig,
      williamsR: wRSig,
      mfi: mfiSig,
      mktSentiment: mktSig,
    };

    // ── PATCH1.11: Wall Absorption Signal Suppression ──────────────────────
    // When a bid/ask wall absorption event is detected on 1m candles,
    // noisy indicators (momentum, OBV, stochrsi) fire in the wick direction.
    // Suppress them and inject counter-bias via persistence.
    const wallAbs = detectWallAbsorption(options.candles1m || null);
    if (wallAbs.detected) {
      const sup = wallAbs.strength;
      signalVector.momentum  = signalVector.momentum  * (1 - sup * 0.88); // most noisy
      signalVector.obv       = signalVector.obv       * (1 - sup * 0.68); // wrong-dir accumulation
      signalVector.stochrsi  = signalVector.stochrsi  * (1 - sup * 0.52); // reacts to wick overshoots
      // Inject absorption counter-bias via persistence (highest-quality weight)
      const absorbBias = wallAbs.dir * sup * 0.65;
      signalVector.persistence = clamp(signalVector.persistence * 0.4 + absorbBias, -1, 1);
    }
    // ── MDT: Momentum Decision Tree (preemptive bias engine) ──────────────
    const reversalFlags = detectReversalFlags(candles, rsi, macdResult, adxResult, obvSlope, mom);
    const mdt = runMomentumDecisionTree(candles, {
      rsi, emaCross, mom, vwapDevRolling, obvSlope,
      adxResult, macdResult, stochRsiResult, persistence, structure, reversalFlags,
    });
    // Apply bias filter BEFORE composite is computed
    const biasedVector = applyBiasFilter(signalVector, mdt);
    Object.assign(signalVector, biasedVector);
    const activeKeys = Object.keys(signalVector).filter(key => includeMicrostructure || !MICRO_SIGNAL_KEYS.includes(key));
    const weightedComposite = keys => {
      const totalWeight = keys.reduce((sum, key) => sum + COMPOSITE_WEIGHTS[key], 0) || 1;
      return keys.reduce((sum, key) => sum + signalVector[key] * COMPOSITE_WEIGHTS[key], 0) / totalWeight;
    };
    const coreComposite = weightedComposite(CORE_SIGNAL_KEYS);
    const microComposite = includeMicrostructure ? weightedComposite(MICRO_SIGNAL_KEYS) : 0;
    const rawComposite = weightedComposite(activeKeys);

    // ADX gate: suppress signal in flat/ranging markets (ADX < 20 = noise).
    // Proportional — dead-flat market (ADX=5) dampens composite by 75%.
    const adxGate = adxResult.adx < 20 ? Math.max(0.25, adxResult.adx / 20) : 1.0;

    // Amplify: realistic composite range is 0–0.45 → stretch to 0–0.9 so
    // high-agreement signals reach meaningful confidence levels in the UI.
    const composite = rawComposite; // keep raw for downstream use
    const mdtScoreMult = (() => {
      if (!mdt || Math.abs(mdt.biasScore) < 0.18 || mdt.biasConf < 35) return 1;
      const aligns = Math.sign(rawComposite) === Math.sign(mdt.biasScore) || rawComposite === 0;
      const strength = Math.abs(mdt.biasScore) * (mdt.biasConf / 95);
      const maxEffect = mdt.preemptive ? 0.18 : 0.11;
      return aligns ? (1 + strength * maxEffect) : (1 - strength * maxEffect * 0.65);
    })();
    const score = clamp(rawComposite * 1.6 * adxGate * (ENABLE_MDT_SCORE_MULT ? mdtScoreMult : 1), -1, 1);
    const agreement = summarizeAgreement(Object.fromEntries(activeKeys.map(key => [key, signalVector[key]])));
    const coreAgreement = summarizeAgreement(Object.fromEntries(CORE_SIGNAL_KEYS.map(key => [key, signalVector[key]])));

    const indicatorsPack = { rsi, emaCross, vwapDev: vwapDevRolling, vwapBands };
    const scalpSetups = includeSetups ? detectScalpSetups(candles, indicatorsPack, bookAnalysis, tradeFlow, session) : [];

    const indicatorsSummary = {
      rsi:      { value: rsi, signal: rsiSig, label: rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : rsi > 55 ? 'Bullish' : rsi < 45 ? 'Bearish' : 'Neutral' },
      ema:      { value: emaCross, signal: emaSig, label: emaCross > 0.1 ? 'Bull Cross' : emaCross < -0.1 ? 'Bear Cross' : 'Converging', ema9: ema9[ema9.length - 1], ema21: ema21[ema21.length - 1] },
      vwap:     { value: vwapDevRolling, signal: vwapSig, price: vwapRollingLast, bands: vwapBands, label: Math.abs(vwapDevRolling) < 0.3 ? 'At VWAP' : vwapDevRolling > 0 ? 'Above VWAP' : 'Below VWAP' },
      obv:      { slope: obvSlope, signal: obvSig, label: obvSlope > 2 ? 'Accumulation' : obvSlope < -2 ? 'Distribution' : 'Flat' },
      volume:   { buyPct: buyV / ((buyV + sellV) || 1) * 100, sellPct: sellV / ((buyV + sellV) || 1) * 100, ratio: volRatio, signal: volSig, label: volRatio > 1.2 ? 'Buy Pressure' : volRatio < 0.8 ? 'Sell Pressure' : 'Balanced' },
      momentum: { value: mom, signal: momSig, label: mom > 0.5 ? 'Rising' : mom < -0.5 ? 'Falling' : 'Flat' },
      bands:    { position: bands.position, widthPct: bands.widthPct, signal: bandSig, upper: bands.upper, lower: bands.lower, label: bands.position >= 0.88 ? 'Upper-band stretch' : bands.position <= 0.12 ? 'Lower-band stretch' : 'Inside bands' },
      persistence,
      structure,
      book:     bookAnalysis,
      flow:     tradeFlow,
      macd:     { macd: macdResult.macd, signal: macdResult.signal, histogram: macdResult.histogram, sig: macdSig, label: macdResult.histogram > 0 ? (macdResult.macd > macdResult.signal ? 'Bull MACD' : 'Bullish') : (macdResult.macd < macdResult.signal ? 'Bear MACD' : 'Bearish') },
      stochrsi: { k: stochRsiResult.k, d: stochRsiResult.d, signal: stochSig, label: stochRsiResult.k > 80 ? 'Overbought' : stochRsiResult.k < 20 ? 'Oversold' : stochRsiResult.k > stochRsiResult.d ? 'Bull cross' : 'Bear cross' },
      adx:      { adx: adxResult.adx, pdi: adxResult.pdi, mdi: adxResult.mdi, signal: adxSig, label: adxResult.adx > 25 ? (adxResult.pdi > adxResult.mdi ? 'Strong uptrend' : 'Strong downtrend') : 'Ranging' },
      ichimoku: { ...ichimoku, signal: ichiSig, label: ichimoku.cloudPos === 'above' ? 'Above cloud' : ichimoku.cloudPos === 'below' ? 'Below cloud' : 'In cloud' },
      williamsR: { value: wR, signal: wRSig, label: wR > -20 ? 'Overbought' : wR < -80 ? 'Oversold' : 'Neutral' },
      mfi:      { value: mfi, signal: mfiSig, label: mfi > 80 ? 'Overbought' : mfi < 20 ? 'Oversold' : mfi > 55 ? 'Bullish' : mfi < 45 ? 'Bearish' : 'Neutral' },
      mktSentiment: {
        kalshi: mktData?.kalshi ?? null,
        poly:   mktData?.poly   ?? null,
        combined: mktData?.combinedProb ?? null,
        signal: mktSig,
        label: mktSig > 0.3 ? 'Markets say UP' : mktSig < -0.3 ? 'Markets say DOWN' : 'Markets neutral',
      },
    };
    const driverSummary = summarizeSignalDrivers(signalVector, indicatorsSummary);

    return {
      price: lastPrice,
      score,
      signal: signalFromScore(score),
      confidence: confidenceFromScore(Math.abs(score)),
      indicators: indicatorsSummary,
      projections: SHORT_HORIZON_MINUTES.reduce((acc, horizonMin) => {
        const targetScale = horizonMin / 60;
        const rangeScale = Math.max(0.12, Math.sqrt(horizonMin / 15) * 0.5);
        const target = lastPrice * (1 + mom / 100 * targetScale);
        const entry = projectionKey(horizonMin);
        acc[entry] = { horizonMin, target, high: target + atr * rangeScale, low: target - atr * rangeScale };
        // For the 15-min horizon, align target to the NEXT 15-min candle session
        if (horizonMin === 15) {
          const ns = getNextCandleSession();
          const scaledMom = mom / 100 * (ns.minsRemaining / 60);
          const nsTarget = lastPrice * (1 + scaledMom);
          acc[entry].nextSession = {
            target: nsTarget,
            high: nsTarget + atr * rangeScale,
            low: nsTarget - atr * rangeScale,
            opensIn: ns.minsRemaining,
            open: ns.nextOpen,
            close: ns.nextClose,
            maturity: ns.maturity,
            freshEntry: ns.freshEntry,
            lateEntry: ns.lateEntry,
          };

          // ── Kalshi 15M Contract Alignment ──────────────────────────────────
          // YES resolves if closePrice ≥ targetPriceNum (meet or exceed).
          // Compute model-implied P(closePrice ≥ ref) using normal CDF over
          // our projected price distribution (mean = target, sigma = ATR-range).
          const k15m        = window.PredictionMarkets?.getCoin(options.sym)?.kalshi15m ?? null;
          const kalshiRef   = k15m?.targetPriceNum ?? null;   // null while "TBD"
          const kalshiYes   = k15m?.probability    ?? null;   // market's YES price (0–1)
          const kalshiStDir = k15m?.strikeDir       ?? 'above'; // 'above'|'below'
          const isBelowK    = kalshiStDir === 'below';

          if (kalshiRef !== null && kalshiRef > 0) {
            // sigma: one-sigma price move over 15 min based on ATR
            const sigma = (atr * rangeScale) || (lastPrice * 0.003);
            // z: how far our projected target is above/below the reference threshold
            const z = (target - kalshiRef) / sigma;
            // P(closePrice ≥ kalshiRef) via normal CDF
            // For 'above' contracts: YES = close ≥ ref  → modelYesPct = CDF(z)
            // For 'below' contracts: YES = close <  ref → modelYesPct = 1 - CDF(z)
            const pAbove       = normalCDF(z);
            const modelYesPct  = Math.round((isBelowK ? 1 - pAbove : pAbove) * 100);
            const kalshiYesPct = kalshiYes !== null ? Math.round(kalshiYes * 100) : null;
            const divergence   = kalshiYesPct !== null ? Math.abs(modelYesPct - kalshiYesPct) : null;
            // Distance from current price to reference (+ means we need to rise to meet it)
            const gapPct       = ((kalshiRef - lastPrice) / lastPrice) * 100;

            // Direction consistency check:
            // modelYesPct ≥ 50 means model thinks YES wins.
            // For 'above': YES=UP — so modelYesPct ≥ 50 should agree with dir='UP'
            // For 'below': YES=DOWN — so modelYesPct ≥ 50 should agree with dir='DOWN'
            const modelYesSide   = modelYesPct >= 50 ? 'YES' : 'NO';
            const yesDir         = isBelowK ? 'DOWN' : 'UP';
            const noDir          = isBelowK ? 'UP' : 'DOWN';
            const cdfImpliedDir  = modelYesPct >= 50 ? yesDir : noDir;
            const dirConflict    = dir !== 'FLAT' && cdfImpliedDir !== dir;
            if (dirConflict) {
              console.warn(
                `[KalshiAlign] ⚠️ DIR CONFLICT ${options.sym}: ` +
                `momentum=${dir} but CDF implies ${cdfImpliedDir} ` +
                `(modelYesPct=${modelYesPct}% strike=${kalshiStDir} ref=${kalshiRef} price=${lastPrice.toFixed(2)})`
              );
            }

            acc[entry].kalshiAlign = {
              ref:           kalshiRef,
              gapPct,
              modelYesPct,
              kalshiYesPct,
              divergence,
              strikeDir:     kalshiStDir,  // 'above'|'below' — passed through to snapshot
              floorPrice:    k15m?.floorPrice  ?? kalshiRef,
              capPrice:      k15m?.capPrice    ?? null,
              strikeType:    k15m?.strikeType  ?? null,
              ticker:        k15m?.ticker      ?? null,   // contract ticker for window alignment
              closeTimeMs:   k15m?.closeTime   ? new Date(k15m.closeTime).getTime() : null,
              dirConflict,      // true when momentum direction contradicts CDF direction
              cdfImpliedDir,    // direction implied by model probability
              status: divergence === null ? 'no-market'
                    : divergence <= 12  ? 'aligned'
                    : divergence <= 25  ? 'soft-split'
                    : 'divergent',
            };
          }
        }
        return acc;
      }, {}),
      volatility: { atr, atrPct, label: atrPct > 2 ? 'High' : atrPct > 0.8 ? 'Medium' : 'Low' },
      session,
      nextCandleSession: getNextCandleSession(),
      scalpSetups,
      mdt,
      reversalFlags,
      diagnostics: {
        agreement: agreement.agreement,
        conflict: agreement.conflict,
        activeSignals: agreement.active,
        bullishSignals: agreement.bulls,
        bearishSignals: agreement.bears,
        consensusLabel: agreement.label,
        components: signalVector,
        coreScore: clamp(coreComposite, -1, 1),
        microScore: clamp(microComposite, -1, 1),
        coreAgreement: coreAgreement.agreement,
        persistenceScore: persistence.signal,
        structureBias: structure.signal,
        structureZone: structure.zone,
        topDrivers: driverSummary.topDrivers,
        driverSummary: driverSummary.driverSummary,
        wallAbsorption: wallAbs,
        mdt,
        reversalFlags,
        mdtScoreMult,
      },
    };
  }

  function buildFastTimingModel(candles) {
    if (!candles || candles.length < 20) return null;
    const closes = candles.map(c => c.c);
    const lastPrice = closes[closes.length - 1];
    const rsi = calcRSI(closes, 9);
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const emaCross = ((ema8[ema8.length - 1] - ema21[ema21.length - 1]) / (ema21[ema21.length - 1] || 1)) * 100;
    const momentum = closes.length > 10 ? ((closes[closes.length - 1] - closes[closes.length - 11]) / (closes[closes.length - 11] || 1)) * 100 : 0;
    const recentVol = candles.slice(-20).map(c => c.v || 0);
    const avgVol = average(recentVol.slice(0, -1));
    const volBurst = avgVol > 0 ? (recentVol[recentVol.length - 1] || 0) / avgVol : 1;

    const rsiSig = rsi < 38 ? clamp((45 - rsi) / 12, 0, 1) : rsi > 62 ? -clamp((rsi - 55) / 12, 0, 1) : 0;
    const emaSig = clamp(emaCross * 8, -1, 1);
    const momentumSig = clamp(momentum / 0.45, -1, 1);
    const volumeSig = clamp((volBurst - 1) * 0.5, -0.5, 0.5) * Math.sign(momentumSig || emaSig || 0);
    const score = clamp(rsiSig * 0.20 + emaSig * 0.36 + momentumSig * 0.32 + volumeSig * 0.12, -1, 1);
    const agreement = summarizeAgreement({ rsi: rsiSig, ema: emaSig, momentum: momentumSig, volume: volumeSig });

    return {
      price: lastPrice,
      score,
      signal: signalFromScore(score),
      confidence: confidenceFromScore(Math.abs(score)),
      label: score > 0.12 ? '1m pooled upside pulse' : score < -0.12 ? '1m pooled downside pulse' : '1m pooled balanced',
      diagnostics: {
        agreement: agreement.agreement,
        conflict: agreement.conflict,
        rsi,
        emaCross,
        momentum,
        volBurst,
      },
    };
  }

  function summarizeBacktestObservations(observations, horizonMin, barMinutes, horizonBars) {
    const active = observations.filter(o => o.direction !== 0);
    const wins = active.filter(o => o.signedReturn > 0).length;
    const losses = active.filter(o => o.signedReturn < 0).length;
    const scratches = active.length - wins - losses;
    const totalSignedReturn = active.reduce((sum, o) => sum + o.signedReturn, 0);
    const totalRawReturn = active.reduce((sum, o) => sum + o.returnPct, 0);
    const totalAbsReturn = active.reduce((sum, o) => sum + Math.abs(o.returnPct), 0);
    const grossWins = active.filter(o => o.signedReturn > 0).reduce((sum, o) => sum + o.signedReturn, 0);
    const grossLosses = Math.abs(active.filter(o => o.signedReturn < 0).reduce((sum, o) => sum + o.signedReturn, 0));
    const thresholdSeries = observations.map(o => o.appliedThreshold).filter(Number.isFinite);
    const agreementSeries = observations.map(o => o.appliedAgreement).filter(Number.isFinite);
    const activeThresholdSeries = active.map(o => o.appliedThreshold).filter(Number.isFinite);
    const activeAgreementSeries = active.map(o => o.appliedAgreement).filter(Number.isFinite);
    const regimeAwareRate = observations.length ? observations.filter(o => o.regimeAware).length / observations.length * 100 : 0;
    const expectancy = active.length ? totalSignedReturn / active.length : 0;
    const equity = buildEquityStats(active);
    const byBucket = ['strong', 'moderate', 'light'].reduce((acc, bucket) => {
      const bucketTrades = active.filter(o => o.bucket === bucket);
      acc[bucket] = {
        trades: bucketTrades.length,
        winRate: bucketTrades.length ? bucketTrades.filter(o => o.signedReturn > 0).length / bucketTrades.length * 100 : 0,
        avgEdge: bucketTrades.length ? bucketTrades.reduce((sum, o) => sum + o.signedReturn, 0) / bucketTrades.length : 0,
      };
      return acc;
    }, {});

    return {
      horizonMin,
      horizonBars,
      barMinutes,
      observations: observations.length,
      activeSignals: active.length,
      longCount: active.filter(o => o.direction > 0).length,
      shortCount: active.filter(o => o.direction < 0).length,
      winRate: active.length ? wins / active.length * 100 : 0,
      avgSignedReturn: active.length ? totalSignedReturn / active.length : 0,
      avgRawReturn: active.length ? totalRawReturn / active.length : 0,
      avgAbsReturn: active.length ? totalAbsReturn / active.length : 0,
      neutralityRate: observations.length ? (observations.length - active.length) / observations.length * 100 : 0,
      coverage: observations.length ? active.length / observations.length * 100 : 0,
      wins,
      losses,
      scratches,
      maxWin: active.length ? Math.max(...active.map(o => o.signedReturn)) : 0,
      maxLoss: active.length ? Math.min(...active.map(o => o.signedReturn)) : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? grossWins : 0,
      expectancy,
      equity,
      effectiveSamples: active.length ? active.length / Math.max(1, horizonBars) : 0,
      normalizedEffectiveSamples: active.length ? active.length / Math.max(1, Math.round(horizonMin / 60)) : 0,
      scoreEdgeRatio: totalAbsReturn > 0 ? totalSignedReturn / totalAbsReturn : 0,
      entryThreshold: activeThresholdSeries.length ? median(activeThresholdSeries) : median(thresholdSeries),
      minAgreement: activeAgreementSeries.length ? median(activeAgreementSeries) : median(agreementSeries),
      regimeAwareRate,
      calibrationSamples: observations.length ? average(observations.map(o => o.calibrationSample || 0)) : 0,
      buckets: byBucket,
    };
  }

  function backtestReliability(...statsList) {
    const horizons = statsList.flat().filter(Boolean);
    if (!horizons.length) return 0.5;
    const weighted = horizons.reduce((acc, stats) => {
      const weight = Math.max(1, stats.effectiveSamples || 0);
      acc.score += scoreHorizonReliability(stats) * weight;
      acc.weight += weight;
      return acc;
    }, { score: 0, weight: 0 });
    return weighted.weight ? weighted.score / weighted.weight : 0.5;
  }

  function advancedBacktestKey(cache) {
    const candles = cache?.longHistory || [];
    if (!candles.length || candles.length < 120) return '';
    return `${candles.length}:${candles[candles.length - 1]?.t || 0}`;
  }

  function getCachedAdvancedBacktest(cache) {
    const key = advancedBacktestKey(cache);
    if (!key || cache?._advancedBacktestKey !== key) return null;
    return cache._advancedBacktest || null;
  }

  function emitPredictionEvent(name, detail = {}) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function runAdvancedBacktest(coin) {
    const cache = candleCache[coin.sym];
    const candles = cache?.longHistory || [];
    if (!candles.length || candles.length < 120) return null;
    const longKey = advancedBacktestKey(cache);
    if (cache._advancedBacktestKey === longKey && cache._advancedBacktest) {
      return cache._advancedBacktest;
    }

    const barMinutes = inferBarMinutes(candles);
    const horizons = [
      { key: 'd1', horizonMin: 24 * 60, filter: { entryThreshold: 0.16, minAgreement: 0.58 } },
      { key: 'd7', horizonMin: 7 * 24 * 60, filter: { entryThreshold: 0.18, minAgreement: 0.60 } },
    ];
    const results = {};

    horizons.forEach(({ key, horizonMin, filter }) => {
      const horizonBars = Math.max(1, Math.round(horizonMin / (barMinutes || (24 * 60))));
      const startIndex = Math.max(26, horizonBars + 14);
      const observations = [];

      for (let idx = startIndex; idx < candles.length - horizonBars; idx++) {
        const windowCandles = candles.slice(0, idx + 1);
        const model = buildSignalModel(windowCandles, null, [], {
          includeMicrostructure: false,
          includeSetups: false,
        });
        if (!model) continue;

        const entry = windowCandles[windowCandles.length - 1].c;
        const exit = candles[idx + horizonBars].c;
        const returnPct = entry > 0 ? ((exit - entry) / entry) * 100 : 0;
        observations.push({
          idx,
          ...applyBacktestFilter({
            idx,
            score: model.score,
            absScore: Math.abs(model.score),
            signal: model.signal,
            agreement: model.diagnostics?.agreement ?? 0.5,
            conflict: model.diagnostics?.conflict ?? 0,
            coreScore: model.diagnostics?.coreScore ?? model.score,
            persistenceScore: model.diagnostics?.persistenceScore ?? 0,
            structureBias: model.diagnostics?.structureBias ?? 0,
            structureZone: model.diagnostics?.structureZone ?? 'middle',
            regime: classifyMarketRegime(model),
            returnPct,
            bucket: scoreBucket(Math.abs(model.score)),
          }, filter),
          calibrationSample: 0,
          regimeAware: false,
        });
      }

      results[key] = summarizeBacktestObservations(observations, horizonMin, barMinutes, horizonBars);
    });

    const reliability = backtestReliability(results.d1, results.d7);
    const tradeFit = average([
      scoreTradeFitHorizon(results.d1, 24 * 60),
      scoreTradeFitHorizon(results.d7, 7 * 24 * 60),
    ].filter(Number.isFinite));
    const result = {
      sym: coin.sym,
      source: 'coingecko-max',
      candleCount: candles.length,
      startDate: candles[0]?.t ? new Date(candles[0].t).toISOString().slice(0, 10) : '',
      endDate: candles[candles.length - 1]?.t ? new Date(candles[candles.length - 1].t).toISOString().slice(0, 10) : '',
      d1: results.d1,
      d7: results.d7,
      summary: {
        reliability,
        tradeFit,
        label: summarizeReliabilityLabel(reliability),
        tradeFitLabel: summarizeTradeFitLabel(tradeFit),
      },
    };
    cache._advancedBacktestKey = longKey;
    cache._advancedBacktest = result;
    return result;
  }

  async function warmAdvancedBacktests() {
    if (advancedBacktestWarmPromise) return advancedBacktestWarmPromise;
    advancedBacktestWarmPromise = (async () => {
      let updated = false;
      for (const coin of PREDICTION_COINS) {
        const cache = candleCache[coin.sym];
        if (!advancedBacktestKey(cache) || getCachedAdvancedBacktest(cache)) continue;
        await wait(0);
        const advanced = runAdvancedBacktest(coin);
        if (!advanced || !window._backtests[coin.sym]) continue;
        window._backtests[coin.sym] = {
          ...window._backtests[coin.sym],
          advanced,
        };
        window._predictions[coin.sym] = computePrediction(coin, window._backtests[coin.sym]);
        updated = true;
      }
      if (updated) emitPredictionEvent('predictionadvancedready');
      return updated;
    })();
    try {
      return await advancedBacktestWarmPromise;
    } finally {
      advancedBacktestWarmPromise = null;
    }
  }

  function runWalkForwardBacktest(coin) {
    const cache = candleCache[coin.sym];
    if (!cache || ((!cache.candles || cache.candles.length < 30) && (!cache.candles1m || cache.candles1m.length < 30))) return null;

    const walkKey = SHORT_HORIZON_MINUTES.map(horizonMin => {
      const series = horizonMin <= 10 && cache.candles1m?.length >= 30 ? cache.candles1m : cache.candles;
      const last = series?.[series.length - 1];
      return `${horizonMin}:${series?.length || 0}:${last?.t || 0}:${Math.round((last?.c || 0) * 10000)}`;
    }).join('|');
    if (cache._walkBacktestKey === walkKey && cache._walkBacktest) {
      return cache._walkBacktest;
    }
    const results = {};

    SHORT_HORIZON_MINUTES.forEach(horizonMin => {
      const candles = horizonMin <= 10 && cache.candles1m?.length >= 30 ? cache.candles1m : cache.candles;
      if (!candles || candles.length < 30) return;
      const barMinutes = inferBarMinutes(candles) || (horizonMin <= 10 ? 1 : 5);
      const horizonBars = Math.max(1, Math.round(horizonMin / barMinutes));
      const startIndex = Math.max(26, horizonBars + 10);
      const observations = [];
      const history = [];

      for (let idx = startIndex; idx < candles.length - horizonBars; idx++) {
        const windowCandles = candles.slice(0, idx + 1);
        const model = buildSignalModel(windowCandles, null, [], {
          includeMicrostructure: false,
          includeSetups: false,
        });
        if (!model) continue;

        const entry = windowCandles[windowCandles.length - 1].c;
        const exit = candles[idx + horizonBars].c;
        // Guard against bad-data candles (e.g. near-zero close from one exchange
        // not corrected by pooling median) — cap at ±25% which covers any real move
        const rawReturn = entry > 0 ? ((exit - entry) / entry) * 100 : 0;
        const returnPct = clamp(rawReturn, -25, 25);
        const rawObservation = {
          idx,
          score: model.score,
          absScore: Math.abs(model.score),
          signal: model.signal,
          agreement: model.diagnostics?.agreement ?? 0.5,
          conflict: model.diagnostics?.conflict ?? 0,
          coreScore: model.diagnostics?.coreScore ?? model.score,
          persistenceScore: model.diagnostics?.persistenceScore ?? 0,
          structureBias: model.diagnostics?.structureBias ?? 0,
          structureZone: model.diagnostics?.structureZone ?? 'middle',
          regime: classifyMarketRegime(model),
          returnPct,
          bucket: scoreBucket(Math.abs(model.score)),
        };
        const calibration = history.length >= BACKTEST_MIN_TRAIN_OBS
          ? calibrateBacktestFilter(history, rawObservation.regime, horizonMin, horizonBars)
          : { ...defaultBacktestFilter(horizonMin, coin.sym), calibrationSample: history.length, regimeAware: false };
        observations.push({
          ...applyBacktestFilter(rawObservation, calibration),
          calibrationSample: calibration.calibrationSample || history.length,
          regimeAware: !!calibration.regimeAware,
        });
        history.push(rawObservation);
      }

      const key = horizonKey(horizonMin);
      results[key] = summarizeBacktestObservations(observations, horizonMin, barMinutes, horizonBars);
      results[key].tradeFit = scoreTradeFitHorizon(results[key], horizonMin);
      results[key].tradeFitLabel = summarizeTradeFitLabel(results[key].tradeFit ?? 0.5);
    });

    const reliability = backtestReliability(SHORT_HORIZON_MINUTES.map(horizonMin => results[horizonKey(horizonMin)]));
    const tradeFit = scoreTradeFit(results);
    const preferred = SHORT_HORIZON_MINUTES.reduce((best, horizonMin) => {
      const stats = results[horizonKey(horizonMin)];
      const score = stats?.tradeFit;
      if (!Number.isFinite(score)) return best;
      if (!best || score > best.score) return { horizonMin, score };
      return best;
    }, null);
    const preferredHorizon = preferred?.horizonMin || DEFAULT_SHORT_HORIZON_MIN;
    const preferredStats = results[horizonKey(preferredHorizon)] || null;
    const baseFilter = defaultBacktestFilter(preferredHorizon, coin.sym);
    const result = {
      sym: coin.sym,
      source: cache.source,
      candleCount: Math.max(cache.candles?.length || 0, cache.candles1m?.length || 0),
      ...results,
      advanced: getCachedAdvancedBacktest(cache),
      summary: {
        reliability,
        label: summarizeReliabilityLabel(reliability),
        tradeFit,
        tradeFitLabel: summarizeTradeFitLabel(tradeFit),
        preferredHorizon,
        entryThreshold: preferredStats?.entryThreshold ?? baseFilter.entryThreshold,
        minAgreement: preferredStats?.minAgreement ?? baseFilter.minAgreement,
        horizonOrder: SHORT_HORIZON_MINUTES.slice(),
        startingEquity: BACKTEST_STARTING_EQUITY,
      },
    };
    cache._walkBacktestKey = walkKey;
    cache._walkBacktest = result;
    return result;
  }

  function applyLiveCalibration(model, backtest) {
    const reliability = backtest?.summary?.reliability ?? 0.5;
    const tradeFit = backtest?.summary?.tradeFit ?? reliability;
    const agreement = model.diagnostics?.agreement ?? 0.5;
    const conflict = model.diagnostics?.conflict ?? 0;
    const coreScore = Number.isFinite(model.diagnostics?.coreScore) ? model.diagnostics.coreScore : model.score;
    const microScore = Number.isFinite(model.diagnostics?.microScore) ? model.diagnostics.microScore : 0;
    const preferredHorizon = backtest?.summary?.preferredHorizon ?? DEFAULT_SHORT_HORIZON_MIN;
    const preferredStats = backtest?.[horizonKey(preferredHorizon)] || null;
    const liveFilter = defaultBacktestFilter(preferredHorizon, backtest?.sym || null);
    const entryThreshold = preferredStats?.entryThreshold ?? backtest?.summary?.entryThreshold ?? liveFilter.entryThreshold;
    const minAgreement = preferredStats?.minAgreement ?? backtest?.summary?.minAgreement ?? liveFilter.minAgreement;
    // maxScore cap: prevents momentum-exhaustion signals (conf 60%+ = anti-predictive for high-beta coins)
    const maxScore = liveFilter.maxScore ?? 1.0;
    const decisionFloor = 0.08;
    const calibration = clamp((0.68 + reliability * 0.20 + tradeFit * 0.24 + agreement * 0.10) - conflict * 0.28, 0.35, 1.10);
    const coreAdjusted = coreScore * calibration;
    const microAligns = Math.sign(coreScore) === 0 || Math.sign(microScore) === 0 || Math.sign(microScore) === Math.sign(coreScore);
    const microCap = 0.16;
    const microOverlay = clamp(
      microScore * (microAligns ? 0.12 : 0.04),
      -microCap,
      microCap
    );
    const persistenceScore = model.diagnostics?.persistenceScore ?? 0;
    const structureBias = model.diagnostics?.structureBias ?? 0;
    const structureZone = model.diagnostics?.structureZone ?? 'middle';
    const scoreBuffer = entryThreshold * (conflict > 0.28 ? 0.22 : 0.14);
    const agreementBuffer = conflict > 0.28 ? 0.05 : 0.03;
    const inBufferZone = Math.abs(coreScore) < (entryThreshold + scoreBuffer) || agreement < (minAgreement + agreementBuffer);
    const conflictVeto = conflict >= 0.38 && agreement < (minAgreement + 0.08);
    const weakCoreVeto = Math.abs(coreScore) < (entryThreshold * 0.92) && conflict >= 0.30;
    const structureVeto = (structureZone === 'resistance' && coreScore > 0 && agreement < 0.65 && Math.abs(structureBias) >= 0.18)
      || (structureZone === 'support' && coreScore < 0 && agreement < 0.65 && Math.abs(structureBias) >= 0.18);
    const persistenceVeto = Math.sign(persistenceScore) !== 0
      && Math.sign(persistenceScore) !== Math.sign(coreScore)
      && Math.abs(persistenceScore) >= 0.35
      && Math.abs(coreScore) < (entryThreshold + 0.04);
    const strongBacktest = reliability >= 0.56 || tradeFit >= 0.58;
    const conflictHard = conflictVeto && conflict >= 0.48 && agreement < (minAgreement + 0.03) && (!strongBacktest || Math.abs(coreScore) < (entryThreshold * 0.92));
    const weakCoreHard = weakCoreVeto && Math.abs(coreScore) < (entryThreshold * 0.72) && conflict >= 0.36 && !strongBacktest;
    const structureHard = structureVeto && Math.abs(structureBias) >= 0.28 && agreement < 0.60;
    const persistenceHard = persistenceVeto && Math.abs(persistenceScore) >= 0.48 && Math.abs(coreScore) < entryThreshold && !strongBacktest;
    const hardVeto = conflictHard || weakCoreHard || structureHard || persistenceHard;
    const softVeto = (conflictVeto || weakCoreVeto || structureVeto || persistenceVeto) && !hardVeto;
    let adjustedScore = clamp(coreAdjusted * (0.75 + agreement * 0.25) * (1 - conflict * 0.24) + microOverlay + structureBias * 0.08, -1, 1);
    if (inBufferZone) {
      const belowThreshold = Math.abs(coreScore) < entryThreshold || agreement < minAgreement;
      if (belowThreshold) {
        const thresholdRatio = Math.abs(coreScore) / Math.max(entryThreshold, 0.001);
        adjustedScore *= clamp(0.55 + thresholdRatio * 0.25, 0.55, 0.80);
      } else {
        adjustedScore *= 0.88;
      }
    }
    if (hardVeto) {
      adjustedScore = 0;
    } else if (maxScore < 1.0 && Math.abs(coreScore) > maxScore) {
      // Momentum exhaustion cap: signal fired too late, high-confidence = reversal zone
      adjustedScore = 0;
    } else if (softVeto) {
      const softClamp = Math.max(decisionFloor * 0.9, Math.abs(coreScore) * 0.48);
      adjustedScore = clamp(adjustedScore, -softClamp, softClamp) * 0.82;
    }
    const horizonBiasBoost = preferredHorizon <= 5 ? 1.06 : preferredHorizon <= 10 ? 1.04 : preferredHorizon <= 15 ? 1.02 : 1;
    const adjustedConfidence = Math.round(clamp(
      confidenceFromScore(Math.abs(adjustedScore)) * (0.74 + reliability * 0.22) * (0.80 + tradeFit * 0.24) * (0.78 + agreement * 0.22) * (1 - conflict * 0.30) * horizonBiasBoost * (inBufferZone ? 0.82 : 1) * (softVeto ? 0.74 : 1),
      0,
      95
    ));
    const vetoReason = conflictVeto ? 'Conflict veto'
      : weakCoreVeto ? 'Weak-core veto'
      : structureVeto ? 'Structure veto'
      : persistenceVeto ? 'Persistence veto'
      : '';
    const vetoSeverity = hardVeto ? 'hard' : softVeto ? 'soft' : '';

    return {
      ...model,
      rawScore: model.score,
      score: adjustedScore,
      signal: signalFromScore(adjustedScore),
      confidence: adjustedConfidence,
      diagnostics: {
        ...model.diagnostics,
        reliability,
        tradeFit,
        tradeFitLabel: summarizeTradeFitLabel(tradeFit),
        preferredHorizon,
        qualityLabel: reliability >= 0.72 ? 'Backtest strong' : reliability >= 0.56 ? 'Backtest decent' : reliability >= 0.40 ? 'Backtest mixed' : 'Backtest weak',
        calibration,
        rawConfidence: model.confidence,
        entryThreshold,
        minAgreement,
        decisionFloor,
        scoreBuffer,
        agreementBuffer,
        inBufferZone,
        vetoReason,
        vetoed: !!vetoReason,
        vetoSeverity,
        hardVeto,
        softVeto,
        thresholdFactor: Math.abs(coreScore) >= entryThreshold ? 1 : Math.abs(coreScore) / Math.max(entryThreshold, 0.001),
      },
    };
  }

  function applyFastTimingOverlay(model, fastTiming) {
    if (!fastTiming) return model;
    if (model.diagnostics?.vetoed) return model;
    const aligns = Math.sign(model.score) === 0 || Math.sign(fastTiming.score) === 0 || Math.sign(model.score) === Math.sign(fastTiming.score);
    const overlayWeight = aligns ? 0.14 : 0.07;
    const adjustedScore = clamp(model.score + fastTiming.score * overlayWeight, -1, 1);
    const adjustedConfidence = Math.round(clamp(
      model.confidence + (aligns ? fastTiming.confidence * 0.12 : -fastTiming.confidence * 0.05),
      0,
      95
    ));

    return {
      ...model,
      score: adjustedScore,
      signal: signalFromScore(adjustedScore),
      confidence: adjustedConfidence,
      diagnostics: {
        ...model.diagnostics,
        fastTiming: {
          ...fastTiming,
          aligns,
        },
        driverSummary: fastTiming.score && Math.abs(fastTiming.score) >= 0.12
          ? `${model.diagnostics?.driverSummary || 'No dominant driver cluster'} · Pooled 1m ${fastTiming.label}`
          : (model.diagnostics?.driverSummary || 'No dominant driver cluster'),
      },
    };
  }

  function packetStrength(packet) {
    return (packet.strength || 0) * (packet.trust || 0) * (packet.relevance || 0) * (packet.freshness || 0);
  }

  function classifyBookLiquidity(book) {
    if (!book) return { state: 'unknown', score: 0.5, label: 'Book unavailable' };
    if (book.spread >= 0.18 || (book.bidTotal + book.askTotal) < 1) {
      return { state: 'thin', score: 0.25, label: 'Thin book / wide spread' };
    }
    if (book.spread <= 0.04 && Math.abs(book.imbalance || 0) < 0.2) {
      return { state: 'balanced', score: 0.85, label: 'Tight balanced book' };
    }
    return { state: 'normal', score: 0.65, label: 'Normal book depth' };
  }

  function buildSignalRouterContext(coin, model, fastTiming, backtest, cache) {
    const sourceFreshness = clamp(1 - ((Date.now() - (cache?.ts || Date.now())) / 90000), 0.25, 1);
    const sourceLabel = cache?.source || '';
    const trustBase = sourceLabel.includes('coinbase') ? 0.90
      : sourceLabel.includes('crypto.com') ? 0.86
      : sourceLabel.includes('binance') ? 0.80
      : sourceLabel.includes('bybit') ? 0.80
      : sourceLabel.includes('kucoin') ? 0.78
      : sourceLabel.includes('bitfinex') ? 0.78
      : sourceLabel.includes('mexc') ? 0.76
      : 0.72;
    const microTrust = cache?.book && cache?.trades?.length ? 0.84 : 0.46;
    const timingTrust = cache?.candles1m?.length ? 0.82 : 0.35;
    const derivativeTrust = derivCache[coin.sym] ? 0.70 : 0.30;
    const bookLiquidity = classifyBookLiquidity(model.indicators?.book);
    const session = model.session || getSessionInfo();
    const transitionRisk = (!session.current.scalp && session.current.label === 'Dead Zone') || session.minsToNext <= 30;
    const routerProfile = getOrbitalRouterProfile(coin.sym);
    const innerArmed = Math.abs(model.diagnostics?.coreScore || model.score || 0) >= (routerProfile.key === 'highBeta' ? 0.15 : 0.10);
    return {
      coin,
      model,
      fastTiming,
      backtest,
      cache,
      sourceFreshness,
      trustBase,
      microTrust,
      timingTrust,
      derivativeTrust,
      bookLiquidity,
      session,
      transitionRisk,
      innerArmed,
      routerProfile,
      preferredHorizon: backtest?.summary?.preferredHorizon ?? model.diagnostics?.preferredHorizon ?? DEFAULT_SHORT_HORIZON_MIN,
    };
  }

  function buildSignalPackets(context) {
    const { model, fastTiming, backtest, sourceFreshness, trustBase, microTrust, timingTrust, derivativeTrust, bookLiquidity, session, transitionRisk, preferredHorizon, routerProfile, innerArmed } = context;
    const ultraFast = preferredHorizon <= 5;
    const shortBias = preferredHorizon <= 15;
    const slowerShort = preferredHorizon >= 10;
    const packets = [];
    const scoreDirection = Math.sign(model.score || 0);
    const pushPacket = packet => {
      packets.push(applyRouterProfile({
        role: 'driver',
        freshness: sourceFreshness,
        relevance: 0.7,
        trust: trustBase,
        direction: scoreDirection,
        ...packet,
      }, routerProfile));
    };

    pushPacket({
      family: 'benchmark',
      category: 'benchmark',
      label: 'Core benchmark',
      detail: model.indicators?.vwap?.label || 'Benchmark aligned',
      strength: clamp(Math.abs(model.diagnostics?.coreScore || model.score || 0), 0, 1),
      relevance: ultraFast ? 0.94 : shortBias ? 0.90 : 0.82,
    });
    pushPacket({
      family: 'trend',
      category: 'trend',
      label: 'Trend structure',
      detail: `${model.indicators?.ema?.label || 'EMA'} · ${model.indicators?.persistence?.label || 'persistence'}`,
      direction: Math.sign(model.diagnostics?.persistenceScore || model.diagnostics?.coreScore || 0),
      strength: clamp(Math.max(Math.abs(model.indicators?.ema?.signal || 0), Math.abs(model.diagnostics?.persistenceScore || 0)), 0, 1),
      relevance: ultraFast ? 0.82 : shortBias ? 0.88 : 0.94,
    });
    pushPacket({
      family: 'momentum',
      category: 'momentum',
      label: 'Momentum complex',
      detail: `${model.indicators?.rsi?.label || 'RSI'} · ${model.indicators?.momentum?.label || 'momentum'}`,
      direction: Math.sign((model.indicators?.rsi?.signal || 0) + (model.indicators?.momentum?.signal || 0)),
      strength: clamp(Math.max(Math.abs(model.indicators?.rsi?.signal || 0), Math.abs(model.indicators?.momentum?.signal || 0)), 0, 1),
      relevance: 0.74,
    });
    pushPacket({
      family: 'structure',
      category: 'structure',
      label: 'Range structure',
      detail: model.indicators?.structure?.label || 'Range state',
      direction: Math.sign(model.diagnostics?.structureBias || 0),
      strength: clamp(Math.abs(model.diagnostics?.structureBias || 0), 0, 1),
      relevance: 0.84,
    });

    if (innerArmed && model.indicators?.book) {
      pushPacket({
        family: 'micro-book',
        category: 'microstructure',
        label: 'Order book',
        detail: `${model.indicators.book.label} · ${bookLiquidity.label}`,
        direction: Math.sign(model.indicators.book.imbalance || 0),
        strength: clamp(Math.abs(model.indicators.book.imbalance || 0), 0, 1),
        trust: microTrust * bookLiquidity.score,
        relevance: ultraFast ? 0.96 : slowerShort ? 0.68 : shortBias ? 0.84 : 0.42,
      });
    }

    if (innerArmed && model.indicators?.flow) {
      pushPacket({
        family: 'micro-flow',
        category: 'microstructure',
        label: 'Trade flow',
        detail: model.indicators.flow.label || 'Tape flow',
        direction: model.indicators.flow.aggressor === 'buyers' ? 1 : model.indicators.flow.aggressor === 'sellers' ? -1 : 0,
        strength: clamp(Math.abs(model.indicators?.flow?.signal || 0), 0, 1),
        trust: microTrust,
        relevance: ultraFast ? 0.92 : slowerShort ? 0.62 : shortBias ? 0.82 : 0.36,
      });
    }

    if (innerArmed && fastTiming) {
      pushPacket({
        family: 'timing',
        category: 'timing',
        label: 'Pooled 1m timing',
        detail: fastTiming.label,
        direction: Math.sign(fastTiming.score || 0),
        strength: clamp(Math.abs(fastTiming.score || 0), 0, 1),
        trust: timingTrust,
        relevance: ultraFast ? 0.98 : slowerShort ? 0.44 : shortBias ? 0.88 : 0.28,
      });
    }

    if (derivCache[context.coin.sym]) {
      const deriv = derivCache[context.coin.sym];
      packets.push(applyRouterProfile({
        family: 'derivatives',
        category: 'derivatives',
        role: 'driver',
        label: 'Perp positioning',
        detail: `${deriv.market || deriv.exchange || 'perps'} funding ${deriv.funding?.toFixed?.(3) || deriv.funding}%`,
        direction: deriv.funding < -0.08 ? 1 : deriv.funding > 0.08 ? -1 : 0,
        strength: clamp(Math.abs(deriv.funding || 0) / 0.35, 0, 1),
        freshness: sourceFreshness,
        trust: derivativeTrust,
        relevance: 0.68,
      }, routerProfile));
    }

    if (backtest?.summary) {
      packets.push(applyRouterProfile({
        family: 'history',
        category: 'historical',
        role: 'driver',
        label: 'Historical fit',
        detail: `${Math.round((backtest.summary.tradeFit ?? backtest.summary.reliability ?? 0) * 100)}% trade fit`,
        direction: scoreDirection,
        strength: clamp((backtest.summary.tradeFit ?? backtest.summary.reliability ?? 0.5), 0, 1),
        freshness: 0.92,
        trust: 0.88,
        relevance: 0.78,
      }, routerProfile));
    }

    const riskPackets = [];
    if (transitionRisk) {
        riskPackets.push(applyRouterProfile({
          family: 'session-risk',
        category: 'session',
        role: 'risk',
        label: 'Session transition',
        detail: session.current.label === 'Dead Zone' ? 'Dead zone liquidity risk' : `Next scalp window in ${session.minsToNext} min`,
        direction: 0,
        strength: session.current.label === 'Dead Zone' ? 0.82 : 0.58,
        freshness: 1,
          trust: 0.86,
          relevance: 0.86,
        }, routerProfile));
    }
    if (bookLiquidity.state === 'thin') {
      riskPackets.push(applyRouterProfile({
        family: 'liquidity-risk',
        category: 'liquidity',
        role: 'risk',
        label: 'Thin liquidity',
        detail: bookLiquidity.label,
        direction: 0,
        strength: 0.78,
        freshness: sourceFreshness,
        trust: 0.82,
        relevance: ultraFast ? 0.96 : shortBias ? 0.90 : 0.64,
      }, routerProfile));
    }
    if (model.diagnostics?.conflict >= 0.34) {
      riskPackets.push(applyRouterProfile({
        family: 'conflict-risk',
        category: 'consensus',
        role: 'risk',
        label: 'Signal conflict',
        detail: `${Math.round((model.diagnostics.conflict || 0) * 100)}% conflict`,
        direction: 0,
        strength: clamp((model.diagnostics.conflict - 0.24) / 0.30, 0, 1),
        freshness: 1,
        trust: 0.9,
        relevance: 0.95,
      }, routerProfile));
    }
    if (model.diagnostics?.vetoed) {
      const hardVeto = !!model.diagnostics?.hardVeto;
      riskPackets.push(applyRouterProfile({
        family: 'gate-risk',
        category: 'gating',
        role: 'risk',
        label: hardVeto ? 'Decision gate' : 'Decision caution',
        detail: model.diagnostics.vetoReason || 'Execution veto',
        direction: 0,
        strength: hardVeto ? 0.95 : 0.46,
        freshness: 1,
        trust: hardVeto ? 1 : 0.86,
        relevance: hardVeto ? 1 : 0.72,
        }, routerProfile));
    }
    const slideRisk = routerProfile.key === 'highBeta'
      && preferredHorizon >= 10
      && (model.diagnostics?.persistenceScore || 0) <= -0.24
      && (model.indicators?.ema?.signal || 0) <= -0.12
      && (((model.indicators?.vwap?.signal || 0) <= -0.10) || ((model.diagnostics?.structureBias || 0) <= -0.08));
    if (slideRisk) {
      riskPackets.push(applyRouterProfile({
        family: 'slide-risk',
        category: 'trend-slip',
        role: 'risk',
        label: 'Slide regime',
        detail: 'High-beta coin is slipping on 15m trend structure; fade fast timing',
        direction: 0,
        strength: 0.88,
        freshness: 1,
        trust: 0.94,
        relevance: 0.96,
      }, routerProfile));
    }

    // ── Shell Router: inject cross-shell routed signal ───────────────────────
    // ShellRouter emits photons when a shell ionises (sell threshold crossed).
    // Photons arrive at this coin's shell after the configured propagation delay
    // (s→p: 90s, s→d: 210s) with β amplification.
    // The packet is role:'risk' so it survives filterSignalPackets() for 15M
    // horizon contracts. applyRouterProfile() then scales it by timingWeight:
    //   momentum coins (SOL/HYPE): ×1.12 — shell events hit harder
    //   core coins    (BTC/ETH):   ×0.78 — core absorbs timing pressure quietly
    const _shellPkt = window.ShellRouter?.getRoutedPacket(context.coin?.sym);
    if (_shellPkt && (_shellPkt.freshness || 0) > 0.30) {
      riskPackets.push(applyRouterProfile({ ..._shellPkt }, routerProfile));
    }

    return [...packets, ...riskPackets];
  }

  function filterSignalPackets(packets, context) {
    const filtered = packets.filter(packet => (packet.freshness || 0) >= 0.3 && (packet.trust || 0) >= 0.28);
    const familyBest = new Map();
    filtered.forEach(packet => {
      const existing = familyBest.get(packet.family);
      if (!existing || packetStrength(packet) > packetStrength(existing)) {
        familyBest.set(packet.family, packet);
      }
    });
    let deduped = Array.from(familyBest.values());

    if (context.preferredHorizon >= 10) {
      deduped = deduped.filter(packet => packet.category !== 'timing' || packet.role === 'risk');
    }
    if (context.transitionRisk) {
      deduped = deduped.filter(packet => packet.category !== 'microstructure' || packet.role === 'risk' || packetStrength(packet) >= 0.48);
    }
    if ((context.model.diagnostics?.conflict || 0) >= 0.38) {
      deduped = deduped.filter(packet => packet.role === 'risk' || packet.category !== 'timing' || packetStrength(packet) >= 0.52);
    }

    return deduped.sort((a, b) => packetStrength(b) - packetStrength(a));
  }

  function scoreRoutedRisks(risks) {
    const categorySeen = new Map();
    const familySeen = new Map();
    return risks
      .slice()
      .sort((a, b) => packetStrength(b) - packetStrength(a))
      .reduce((sum, packet, index) => {
        const categoryHits = categorySeen.get(packet.category) || 0;
        const familyHits = familySeen.get(packet.family) || 0;
        const rankWeight = index === 0 ? 1 : index === 1 ? 0.78 : index === 2 ? 0.62 : 0.48;
        const correlationDiscount = Math.max(0.55, 1 - categoryHits * 0.18 - familyHits * 0.10);
        categorySeen.set(packet.category, categoryHits + 1);
        familySeen.set(packet.family, familyHits + 1);
        return sum + packetStrength(packet) * rankWeight * correlationDiscount;
      }, 0);
  }

  function summarizeRoutedSignals(packets, context) {
    const drivers = packets.filter(packet => packet.role !== 'risk' && packet.direction !== 0);
    const risks = packets.filter(packet => packet.role === 'risk');
    const profile = context.routerProfile || getOrbitalRouterProfile(context.coin?.sym || 'BTC');
    const bullish = drivers.filter(packet => packet.direction > 0).reduce((sum, packet) => sum + packetStrength(packet), 0);
    const bearish = drivers.filter(packet => packet.direction < 0).reduce((sum, packet) => sum + packetStrength(packet), 0);
    const riskScore = scoreRoutedRisks(risks);
    const net = bullish - bearish;
    const bias = net > 0.08 ? 'up' : net < -0.08 ? 'down' : 'neutral';
    const modelDirection = Math.sign(context.model.score || 0);
    const biasDirection = bias === 'up' ? 1 : bias === 'down' ? -1 : 0;
    const directionalConflict = modelDirection !== 0 && biasDirection !== 0 && modelDirection !== biasDirection;
    const hardVeto = !!context.model.diagnostics?.hardVeto;
    const softVeto = !!context.model.diagnostics?.softVeto;
    let action = 'watch';
    if (hardVeto || riskScore >= profile.invalidateRisk) action = 'invalidated';
    else if (directionalConflict) action = 'stand-aside';
    else if (Math.abs(net) >= profile.tradeNet && riskScore <= profile.tradeRisk && !softVeto) action = 'trade';
    else if (softVeto || Math.abs(net) < profile.watchNet || riskScore >= (profile.tradeRisk + 0.18)) action = 'stand-aside';
    const confidenceMultiplier = action === 'trade' ? 1.05 : action === 'watch' ? 0.97 : action === 'stand-aside' ? 0.74 : 0.54;
    const topDrivers = drivers.slice(0, 3).map(packet => ({
      label: packet.label,
      detail: packet.detail,
      direction: packet.direction > 0 ? 'up' : 'down',
      strength: packetStrength(packet),
    }));
    const riskFlags = risks.slice(0, 3).map(packet => packet.label);
    if (directionalConflict) riskFlags.unshift('Directional mismatch');
    const summaryText = [
      topDrivers.length ? topDrivers.map(packet => `${packet.label} ${packet.direction === 'up' ? 'supports UP' : 'leans DOWN'} (${packet.detail})`).join(' · ') : 'No dominant routed drivers',
      riskFlags.length ? `Risks: ${riskFlags.join(', ')}` : 'No elevated router risks',
    ].join(' | ');

    return {
      packets,
      topDrivers,
      riskFlags,
      bullish,
      bearish,
      riskScore,
      bias,
      directionalConflict,
      action,
      confidenceMultiplier,
      summaryText,
    };
  }

  function computePrediction(coin, backtest = null) {
    const cache = candleCache[coin.sym];
    if (!cache || !cache.candles || cache.candles.length < 20) {
      return {
        sym: coin.sym, name: coin.name, color: coin.color, icon: coin.icon,
        price: cache?.ticker?.usd || 0,
        signal: 'neutral', confidence: 0, score: 0,
        source: 'loading', candleCount: 0, updatedAt: '–',
        error: 'Insufficient data',
        indicators: {}, diagnostics: {}, volatility: { label: 'Unknown', atrPct: 0 },
        projections: {}, reversalFlags: [], scalpSetups: [],
      };
    }

    const baseModel = buildSignalModel(cache.candles, cache.book, cache.trades, {
      includeMicrostructure: true,
      includeSetups: true,
      sym: coin.sym,
      candles1m: cache.candles1m || null,  // PATCH1.11: wall absorption needs 1m data
    });
    const calibrated = applyLiveCalibration(baseModel, backtest);
    const fastTiming = buildFastTimingModel(cache.candles1m);
    const timed = applyFastTimingOverlay(calibrated, fastTiming);
    const routerContext = buildSignalRouterContext(coin, timed, fastTiming, backtest, cache);
    const routedPackets = filterSignalPackets(buildSignalPackets(routerContext), routerContext);
    const routed = summarizeRoutedSignals(routedPackets, routerContext);

    // ── CFM Floating Router ─────────────────────────────────────────
    // Base score from existing packet router (unchanged path)
    const baseScore = routed.action === 'invalidated'
      ? 0
      : routed.action === 'stand-aside'
        ? timed.score * 0.45
        : clamp(timed.score * routed.confidenceMultiplier, -1, 1);
    const baseConf = Math.round(clamp(timed.confidence * routed.confidenceMultiplier, 0, 95));

    // Enrich with: CFM anchor packets + outcome calibration + singularity resolver
    const cfmEnrich = window.CFMRouter?.enrich(
      coin.sym, routerContext, routedPackets, routed, baseScore, baseConf
    ) || null;

    const normalizedScore      = cfmEnrich?.finalScore     ?? baseScore;
    const normalizedConfidence = cfmEnrich?.finalConf      ?? baseConf;
    const resolvedRouterAction = cfmEnrich?.resolvedAction ?? routed.action;
    const normalizedSignal = resolvedRouterAction === 'invalidated' || resolvedRouterAction === 'stand-aside'
      ? 'neutral'
      : signalFromScore(normalizedScore);

    const result = {
      sym: coin.sym,
      name: coin.name,
      color: coin.color,
      icon: coin.icon,
      price: timed.price,
      signal: normalizedSignal,
      score: normalizedScore,
      rawScore: timed.rawScore,
      confidence: normalizedConfidence,
      indicators: timed.indicators,
      projections: timed.projections,
      volatility: timed.volatility,
      session: timed.session,
      scalpSetups: timed.scalpSetups,
      diagnostics: {
        ...timed.diagnostics,
        routedAction:        resolvedRouterAction,
        routedBias:          routed.bias,
        directionalConflict: routed.directionalConflict,
        routedRiskScore:     routed.riskScore,
        routedRiskFlags:     routed.riskFlags,
        routedPackets,
        routedSummary:       routed.summaryText,
        // CFM floating router diagnostics
        cfmPackets:          cfmEnrich?.cfmPackets       || [],
        cfmCalibration:      cfmEnrich?.calibration      || null,
        cfmAnchor:           cfmEnrich?.anchor           || 0,
        cfmOverride:         cfmEnrich?.cfmOverride      || false,
        cfmOverrideReason:   cfmEnrich?.overrideReason   || null,
        cfmEarlyExit:        cfmEnrich?.earlyExit        || null,
      },
      backtest,
      // --- Derivatives: funding, OI, squeeze ---
      derivatives: derivCache[coin.sym] || null,
      squeeze: detectSqueeze(coin.sym),
      // --- CVD ---
      cvd: calcCVD(cache.trades),
      source: cache.candles1m?.length ? `${cache.source} + pooled 1m` : cache.source,
      updatedAt: new Date().toLocaleTimeString(),
      candleCount: cache.candles.length,
      candleCount1m: cache.candles1m?.length || 0,
    };

    // PATCH1.10: attach signal quality gate
    result.gate = evaluateSignalGate(result);
    return result;
  }

  // ================================================================
  // DERIVATIVES DATA (funding rates, OI, squeeze detection)
  // ================================================================

  let derivCache = {}; // sym → { funding, oi, basis, exchange, timestamp }
  let derivAge = 0;

  async function fetchDerivatives() {
    if (Date.now() - derivAge < 120000) return; // cache 2 min (CoinGecko rate limit)
    try {
      const data = await fetchGeckoJSON('/derivatives?include_tickers=unexpired', { minGapMs: 1800, retries: 4 }).catch(() => null);
      if (!Array.isArray(data)) return;
      const symMap = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', XRPUSDT:'XRP', DOGEUSDT:'DOGE', BNBUSDT:'BNB', HYPEUSDT:'HYPE' };
      const seen = new Set();
      data.forEach(d => {
        const sym = symMap[d.symbol];
        if (sym && !seen.has(sym)) {
          seen.add(sym);
          derivCache[sym] = {
            funding: parseFloat(d.funding_rate || 0) * 100,
            oi: parseFloat(d.open_interest || 0),
            basis: parseFloat(d.basis || 0) * 100,
            spread: parseFloat(d.bid_ask_spread || 0),
            exchange: d.market || '',
            ts: Date.now(),
          };
        }
      });
      derivAge = Date.now();
    } catch (err) {
      console.warn('Derivatives fetch failed:', err.message);
    }
  }

  // CVD: Cumulative Volume Delta from trade data
  function calcCVD(trades) {
    if (!trades || trades.length === 0) return { cvd: 0, divergence: 'none', trend: 0 };
    let cvd = 0;
    const cvdArr = [];
    trades.forEach(t => {
      const qty = parseFloat(t.qty || 0);
      cvd += t.side === 'buy' ? qty : -qty;
      cvdArr.push(cvd);
    });
    // CVD slope (is it rising or falling?)
    const recent = cvdArr.slice(-10);
    const cvdSlope = recent.length > 2 ? (recent[recent.length - 1] - recent[0]) / (Math.abs(recent[0]) || 1) * 100 : 0;
    return { cvd, slope: cvdSlope, arr: cvdArr };
  }

  // Squeeze detector
  function detectSqueeze(sym) {
    const deriv = derivCache[sym];
    if (!deriv) return null;
    const funding = deriv.funding;
    const oi = deriv.oi;

    if (funding < -0.5) {
      return { type: 'short_squeeze', severity: Math.abs(funding) > 1 ? 'high' : 'medium',
        desc: `Funding ${funding.toFixed(3)}% — shorts paying heavy. Squeeze risk if price bounces.`,
        direction: 'up' };
    }
    if (funding > 0.3) {
      return { type: 'long_squeeze', severity: funding > 0.5 ? 'high' : 'medium',
        desc: `Funding +${funding.toFixed(3)}% — longs overcrowded. Liquidation cascade risk on dip.`,
        direction: 'down' };
    }
    return null;
  }

  // ================================================================
  // PUBLIC API
  // ================================================================

  window.PredictionEngine = {
    // Pre-warms the candle cache for all coins without scoring.
    // Call 60s before each boundary so runAll() scores from warm cache instantly.
    async warmCache() {
      try {
        await Promise.allSettled([
          ...PREDICTION_COINS.map(c => loadCoinData(c)),
          fetchDerivatives()
        ]);
      } catch {}
    },
    forceReset() {
      // Unstick a hung predictionRunPromise so the next runAll() starts fresh.
      predictionRunPromise = null;
      geckoRequestQueue  = Promise.resolve();  // abandon backed-up serial gecko chain
      lastGeckoRequestAt = 0;
      window.throttledFetchReset?.();          // drain stale throttle waitQueue
    },
    async runAll() {
      if (predictionRunPromise) return predictionRunPromise;
      // Reset gecko serial queue and throttle waiters so stale calls from prior
      // runs (e.g. after Refresh clicks) don't block this fresh run.
      geckoRequestQueue  = Promise.resolve();
      lastGeckoRequestAt = 0;
      window.throttledFetchReset?.();
      predictionRunPromise = (async () => {
        // Per-coin 12s hard cap — if a coin's exchange batch hangs past this,
        // runAll proceeds with whatever partial data landed rather than freezing.
        const withCoinTimeout = (p) =>
          Promise.race([p, new Promise(r => setTimeout(r, 12000))]);
        await Promise.allSettled([
          ...PREDICTION_COINS.map(c => withCoinTimeout(loadCoinData(c))),
          Promise.race([fetchDerivatives(), new Promise(r => setTimeout(r, 8000))]) // 8s cap
        ]);
        // Yield between each coin's backtest to keep the UI thread responsive
        for (const coin of PREDICTION_COINS) {
          try {
            window._backtests[coin.sym] = runWalkForwardBacktest(coin);
          } catch (btErr) {
            console.error('[runAll] runWalkForwardBacktest crash:', coin.sym, btErr);
            window._backtests[coin.sym] = null;
          }
          await new Promise(r => setTimeout(r, 0));
        }
        saveBtCache();
        PREDICTION_COINS.forEach(coin => {
          try {
            window._predictions[coin.sym] = computePrediction(coin, window._backtests[coin.sym]);
          } catch (cpErr) {
            console.error('[runAll] computePrediction crash:', coin.sym, cpErr);
            window._predictions[coin.sym] = {
              sym: coin.sym, name: coin.name, color: coin.color, icon: coin.icon,
              price: 0, signal: 'neutral', confidence: 0, score: 0,
              source: 'error', candleCount: 0, updatedAt: new Date().toLocaleTimeString(),
              error: cpErr.message || 'Compute error',
              indicators: {}, diagnostics: {}, volatility: { label: 'Unknown', atrPct: 0 },
              projections: {}, reversalFlags: [], scalpSetups: [],
            };
          }
        });
        warmAdvancedBacktests().catch(() => {});
        // Phase 2: enrich with slow proxy-routed sources 30 s after initial score.
        // Fires and forgets — each coin re-scores itself, then dispatches predictionsEnriched.
        setTimeout(() => {
          Promise.allSettled(PREDICTION_COINS.map(c => enrichCoinDataBackground(c).catch(() => {})))
            .then(() => { saveBtCache(); window.dispatchEvent(new CustomEvent('predictionsEnriched')); });
        }, 30000);
        return window._predictions;
      })();
      try {
        return await predictionRunPromise;
      } finally {
        predictionRunPromise = null;
      }
    },
    get(sym) { return window._predictions[sym] || null; },
    getAll() { return window._predictions; },
    getBacktest(sym) { return window._backtests[sym] || null; },
    getBacktests() { return window._backtests; },
    getSession() { return getSessionInfo(); },
    startAutoRefresh() {
      this.stopAutoRefresh();
      this.runAll();
      // Scoring is now driven by app.js quarter-aligned scheduler via scheduleOnQuarterHours.
      // This method kept for compatibility; actual schedule is managed externally.
    },
    stopAutoRefresh() {
      if (predictionTimer) { clearTimeout(predictionTimer); predictionTimer = null; }
    }
  };

})();
