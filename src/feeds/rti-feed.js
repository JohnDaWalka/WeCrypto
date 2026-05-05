// ================================================================
// WE|||CRYPTO — CME CF Real-Time Index (RTI) Approximation Feed
//
// Kalshi settles 15m contracts on CME CF benchmark indices:
//   BTC  → BRTI          (CF Bitcoin Real-Time Index)
//   ETH  → ETHUSD_RTI    (CF Ether Real-Time Index)
//   SOL  → SOLUSD_RTI
//   XRP  → XRPUSD_RTI
//
// RTI methodology: per-second VWAP across Coinbase, Kraken, Bitstamp,
// Gemini ONLY. Binance is NOT a constituent exchange.
//
// Settlement formula:
//   Open avg  = mean(RTI values in last 60s before open_time)
//   Close avg = mean(RTI values in last 60s before close_time)
//   YES if close_avg > open_avg (for 'above' contracts)
//
// This module approximates RTI by polling all 4 constituent exchanges
// every RTI_POLL_MS (10s default), maintaining a 90s rolling buffer,
// and computing an equal-weighted average of mid-prices.
//
// Exposes:
//   window.RTIFeed                  — controller object
//   window._rtiPrices = {
//     BTC: {
//       price,          // current RTI approximation
//       openAvg,        // avg RTI over last 60s of the 15m open window (or null)
//       closeAvg,       // avg RTI over last 60s before expected close (or null)
//       delta,          // closeAvg - openAvg (signed) — or null
//       deltaDir,       // 'UP'|'DOWN'|'FLAT'|null
//       deltaPct,       // percentage move vs openAvg
//       exchanges,      // { coinbase, kraken, bitstamp, gemini } latest prices
//       stale,          // true if no update in > 30s
//       ts,             // ms timestamp of last update
//     }, ...
//   }
//
// Load order: after proxy-fetch.js, throttled-fetch.js, before predictions.js
// ================================================================

(function () {
  'use strict';

  const RTI_POLL_MS   = 10_000;   // poll every 10 seconds
  const BUFFER_SECS   = 90;       // keep 90s of RTI samples
  const STALE_MS      = 30_000;   // mark stale if no update in 30s
  const SETTLE_WINDOW = 60_000;   // last 60s before open/close = settlement window

  // CME CF RTI constituent symbols per exchange
  const EXCHANGE_CONFIG = {
    coinbase: {
      url:    (pair) => `https://api.exchange.coinbase.com/products/${pair}/ticker`,
      pairs:  { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD' },
      parse:  (d) => parseFloat(d.price),
    },
    kraken: {
      url:    (pair) => `https://api.kraken.com/0/public/Ticker?pair=${pair}`,
      pairs:  { BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD' },
      parse:  (d, pair) => {
        const key = Object.keys(d.result || {})[0];
        return key ? parseFloat(d.result[key].c[0]) : NaN;
      },
    },
    bitstamp: {
      url:    (pair) => `https://www.bitstamp.net/api/v2/ticker/${pair}/`,
      pairs:  { BTC: 'btcusd', ETH: 'ethusd', SOL: 'solusd', XRP: 'xrpusd' },
      parse:  (d) => parseFloat(d.last),
    },
    gemini: {
      url:    (pair) => `https://api.gemini.com/v1/pubticker/${pair}`,
      pairs:  { BTC: 'btcusd', ETH: 'ethusd', SOL: 'solusd', XRP: 'xrpusd' },
      parse:  (d) => parseFloat(d.last),
    },
  };

  const SUPPORTED_SYMS = ['BTC', 'ETH', 'SOL', 'XRP'];

  // Rolling buffer: _buffer[sym] = [{ ts, prices: { coinbase, kraken, bitstamp, gemini }, rti }]
  const _buffer = {};
  for (const sym of SUPPORTED_SYMS) _buffer[sym] = [];

  // Latest per-exchange prices
  const _latest = {};
  for (const sym of SUPPORTED_SYMS) {
    _latest[sym] = { coinbase: null, kraken: null, bitstamp: null, gemini: null };
  }

  // Global output
  window._rtiPrices = window._rtiPrices || {};

  // ── Helpers ────────────────────────────────────────────────────────

  function computeRTI(prices) {
    // Equal-weight VWAP approximation: average of available exchange prices
    const vals = Object.values(prices).filter(v => v != null && isFinite(v) && v > 0);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  function bufferAvg(sym, fromMs, toMs) {
    const entries = _buffer[sym].filter(e => e.ts >= fromMs && e.ts <= toMs);
    if (entries.length === 0) return null;
    const sum = entries.reduce((s, e) => s + e.rti, 0);
    return sum / entries.length;
  }

  function pruneBuffer(sym) {
    const cutoff = Date.now() - BUFFER_SECS * 1000;
    const buf = _buffer[sym];
    let i = 0;
    while (i < buf.length && buf[i].ts < cutoff) i++;
    if (i > 0) _buffer[sym] = buf.slice(i);
  }

  // Get the open_time and close_time of the current active 15m Kalshi window for sym.
  // Falls back to floor-of-15m bucket if PredictionMarkets unavailable.
  function getContractWindow(sym) {
    try {
      const k15m = window.PredictionMarkets?.getCoin(sym)?.kalshi15m;
      if (k15m?.openTime && k15m?.closeTime) {
        return {
          openMs:  new Date(k15m.openTime).getTime(),
          closeMs: new Date(k15m.closeTime).getTime(),
        };
      }
    } catch (_) {}
    // Fallback: snap to 15m floor
    const now = Date.now();
    const bucket = Math.floor(now / 900_000) * 900_000;
    return { openMs: bucket, closeMs: bucket + 900_000 };
  }

  // ── Fetch from a single exchange ───────────────────────────────────

  async function fetchExchange(exName, sym) {
    const cfg = EXCHANGE_CONFIG[exName];
    const pair = cfg.pairs[sym];
    if (!pair) return null;

    const fetchFn = window.throttledFetch ?? window.proxyFetch ?? fetch;
    try {
      const resp = await fetchFn(cfg.url(pair), {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const price = cfg.parse(data, pair);
      return isFinite(price) && price > 0 ? price : null;
    } catch (e) {
      // Silently skip — network errors on individual exchanges are expected
      return null;
    }
  }

  // ── Poll all exchanges for one symbol ─────────────────────────────

  async function pollSym(sym) {
    const exNames = Object.keys(EXCHANGE_CONFIG);

    // Fetch all 4 exchanges in parallel
    const results = await Promise.allSettled(
      exNames.map(ex => fetchExchange(ex, sym))
    );

    let anyUpdate = false;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value != null) {
        _latest[sym][exNames[i]] = r.value;
        anyUpdate = true;
      }
    });

    if (!anyUpdate) return;

    const rti = computeRTI(_latest[sym]);
    if (rti == null) return;

    const now = Date.now();
    _buffer[sym].push({ ts: now, prices: { ..._latest[sym] }, rti });
    pruneBuffer(sym);

    // Compute settlement window averages
    const win = getContractWindow(sym);
    const openWindowStart  = win.openMs - SETTLE_WINDOW;
    const openWindowEnd    = win.openMs;
    const closeWindowStart = win.closeMs - SETTLE_WINDOW;
    const closeWindowEnd   = win.closeMs;

    const openAvg  = bufferAvg(sym, openWindowStart, openWindowEnd);
    const closeAvg = bufferAvg(sym, closeWindowStart, Math.min(closeWindowEnd, now));

    let delta    = null;
    let deltaDir = null;
    let deltaPct = null;
    if (openAvg != null && closeAvg != null) {
      delta    = closeAvg - openAvg;
      deltaPct = (delta / openAvg) * 100;
      deltaDir = Math.abs(deltaPct) < 0.005 ? 'FLAT' : delta > 0 ? 'UP' : 'DOWN';
    }

    window._rtiPrices[sym] = {
      price:     rti,
      openAvg,
      closeAvg,
      delta,
      deltaDir,
      deltaPct,
      exchanges: { ..._latest[sym] },
      stale:     false,
      ts:        now,
    };
  }

  // ── Mark stale entries ─────────────────────────────────────────────

  function markStale() {
    const cutoff = Date.now() - STALE_MS;
    for (const sym of SUPPORTED_SYMS) {
      const r = window._rtiPrices[sym];
      if (r && r.ts < cutoff) r.stale = true;
    }
  }

  // ── Poll cycle ─────────────────────────────────────────────────────

  let _pollTimer = null;

  async function runPollCycle() {
    // Stagger polls across symbols to avoid thundering-herd on exchanges
    for (let i = 0; i < SUPPORTED_SYMS.length; i++) {
      const sym = SUPPORTED_SYMS[i];
      // Small stagger: 0ms, 800ms, 1600ms, 2400ms
      setTimeout(() => pollSym(sym), i * 800);
    }
    markStale();
  }

  function start() {
    if (_pollTimer) return;
    runPollCycle(); // immediate first poll
    _pollTimer = setInterval(runPollCycle, RTI_POLL_MS);
    console.log('[RTIFeed] Started — CME CF RTI approximation (Coinbase+Kraken+Bitstamp+Gemini)');
  }

  function stop() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Get the current RTI price for a symbol.
   * Returns null if no data or stale.
   */
  function getPrice(sym) {
    const r = window._rtiPrices[sym?.toUpperCase()];
    return r && !r.stale ? r.price : null;
  }

  /**
   * Get RTI data object for a symbol.
   */
  function getData(sym) {
    return window._rtiPrices[sym?.toUpperCase()] ?? null;
  }

  /**
   * Get the basis (RTI price - Coinbase price) in pct.
   * Positive = RTI is above Coinbase. Negative = RTI below Coinbase.
   */
  function getBasis(sym) {
    const r = window._rtiPrices[sym?.toUpperCase()];
    if (!r || r.stale || r.exchanges.coinbase == null) return null;
    return ((r.price - r.exchanges.coinbase) / r.exchanges.coinbase) * 100;
  }

  window.RTIFeed = { start, stop, getPrice, getData, getBasis };

  // Auto-start after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

})();
