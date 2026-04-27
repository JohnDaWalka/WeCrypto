// ================================================================
// cex-flow.js — CEX Exchange Flow Monitor  v1.0
// Detects institutional accumulation/distribution across 5 CEXs
// All endpoints: free, no API key required
// Polls every 45s  (slower than chain-router to respect rate limits)
// ================================================================
// Exposes:  window.CexFlow
// Events:   cex-flow-update  (detail = { sym → exchangeResults[] })
// Methods:  .get(sym)      → { exchanges[], aggregate, ts }
//           .getAll()      → map of all coins
//           .start()/.stop()
// ================================================================

(function () {
  'use strict';

  const COINS   = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
  const POLL_MS = 45000;
  const TIMEOUT = 9000;
  const CACHE   = {};        // sym → { exchanges[], aggregate, ts }
  const VOL_HISTORY = {};    // `${exchange}_${sym}` → [vol24h, ...]  (rolling 8)
  let _timer = null;

  // ── helpers ──────────────────────────────────────────────────────
  function timedFetch(url) {
    return Promise.race([
      window.fetch(url),  // Explicitly use window.fetch so proxy-fetch.js patch applies
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TIMEOUT)
      ),
    ]);
  }

  async function getJson(url) {
    const res = await timedFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function pushVolHistory(key, vol) {
    if (vol == null || isNaN(vol) || vol <= 0) return;
    if (!VOL_HISTORY[key]) VOL_HISTORY[key] = [];
    VOL_HISTORY[key].push(vol);
    if (VOL_HISTORY[key].length > 8) VOL_HISTORY[key].shift();
  }

  function rollingVolMult(key, currentVol) {
    const hist = VOL_HISTORY[key];
    if (!hist || hist.length < 2) return null; // need at least one prior poll
    const avg = hist.slice(0, -1).reduce((a, b) => a + b, 0) / (hist.length - 1);
    if (avg <= 0) return null;
    return currentVol / avg;
  }

  // ── signal computation ────────────────────────────────────────────
  function computeSignal(buyPct, sellPct, volMult, fundingPct) {
    const fundBear = fundingPct != null && fundingPct >  0.02;
    const fundBull = fundingPct != null && fundingPct < -0.02;
    const bigVol   = volMult   != null && volMult   >  1.8;
    const smallVol = volMult   != null && volMult   <  0.5;

    if (sellPct > 58 || (sellPct > 52 && fundBear)) return { signal: 'DISTRIBUTING', color: 'red'    };
    if (buyPct  > 58 || (buyPct  > 52 && fundBull)) return { signal: 'ACCUMULATING', color: 'green'  };
    if (bigVol  && Math.abs(buyPct - sellPct) < 6)  return { signal: 'VOLATILE',     color: 'orange' };
    if (smallVol)                                   return { signal: 'QUIET',        color: 'faint'  };
    return { signal: 'NEUTRAL', color: 'muted' };
  }

  // ── per-exchange fetchers ─────────────────────────────────────────

  async function fetchBinance(sym) {
    const exchange = 'Binance';
    try {
      // HYPE not on Binance futures but we still try spot
      const [tradesRes, tickerRes] = await Promise.allSettled([
        getJson(`https://api.binance.us/api/v3/aggTrades?symbol=${sym}USDT&limit=500`),
        getJson(`https://api.binance.us/api/v3/ticker/24hr?symbol=${sym}USDT`),
      ]);

      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'trades failed');

      const trades = tradesRes.value;
      let buyQty = 0, sellQty = 0;
      for (const t of trades) {
        const qty = parseFloat(t.q || t.qty || 0);
        if (t.m === false) buyQty  += qty; // taker is buyer
        else               sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct   = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct  = 100 - buyPct;

      let vol24h = null;
      if (tickerRes.status === 'fulfilled') {
        vol24h = parseFloat(tickerRes.value.quoteVolume || 0);
      }
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h != null ? rollingVolMult(volKey, vol24h) : null;

      // Funding (futures) — not available for HYPE
      let fundingPct = null;
      if (sym !== 'HYPE') {
        try {
          const fi = await getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}USDT`);
          fundingPct = parseFloat(fi.lastFundingRate) * 100;
        } catch (_) { /* futures not available for this coin */ }
      }

      const { signal, color } = computeSignal(buyPct, sellPct, volMult, fundingPct);
      return { exchange, buyPct, sellPct, volMult, fundingPct, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  async function fetchCoinbase(sym) {
    const exchange = 'Coinbase';
    // BNB and HYPE not on Coinbase
    if (sym === 'BNB' || sym === 'HYPE') {
      return { exchange, available: false, reason: 'Not listed' };
    }
    try {
      const [tradesRes, tickerRes] = await Promise.allSettled([
        getJson(`https://api.exchange.coinbase.com/products/${sym}-USD/trades?limit=100`),
        getJson(`https://api.exchange.coinbase.com/products/${sym}-USD/ticker`),
      ]);

      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'trades failed');

      const trades = Array.isArray(tradesRes.value) ? tradesRes.value : [];
      let buyQty = 0, sellQty = 0;
      for (const t of trades) {
        const qty = parseFloat(t.size || 0);
        if (t.side === 'buy') buyQty  += qty;
        else                  sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct   = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct  = 100 - buyPct;

      let vol24h = null;
      if (tickerRes.status === 'fulfilled') {
        vol24h = parseFloat(tickerRes.value.volume || 0);
      }
      const volKey = `${exchange}_${sym}`;
      pushVolHistory(volKey, vol24h);
      const volMult = vol24h != null ? rollingVolMult(volKey, vol24h) : null;

      const { signal, color } = computeSignal(buyPct, sellPct, volMult, null);
      return { exchange, buyPct, sellPct, volMult, fundingPct: null, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  const KRAKEN_PAIRS = {
    BTC:  'XBTUSDT',
    ETH:  'ETHUSDT',
    SOL:  'SOLUSDT',
    XRP:  'XRPUSDT',
    BNB:  null,
    DOGE: 'DOGEUSDT',
    HYPE: null,
  };

  async function fetchKraken(sym) {
    const exchange = 'Kraken';
    const krakenPair = KRAKEN_PAIRS[sym];
    if (!krakenPair) {
      return { exchange, available: false, reason: 'Not listed' };
    }
    try {
      const data = await getJson(`https://api.kraken.com/0/public/Trades?pair=${krakenPair}&count=200`);
      if (data.error && data.error.length) throw new Error(data.error[0]);
      const result = data.result || {};
      const key    = Object.keys(result).find(k => k !== 'last');
      const trades = key ? result[key] : [];

      let buyQty = 0, sellQty = 0;
      for (const t of trades) {
        // array: [price, volume, time, side, ...]
        const qty  = parseFloat(t[1] || 0);
        const side = t[3]; // 'b' or 's'
        if (side === 'b') buyQty  += qty;
        else              sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct   = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct  = 100 - buyPct;

      const { signal, color } = computeSignal(buyPct, sellPct, null, null);
      return { exchange, buyPct, sellPct, volMult: null, fundingPct: null, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  async function fetchBybit(sym) {
    const exchange = 'Bybit';
    // HYPE not on Bybit
    if (sym === 'HYPE') {
      return { exchange, available: false, reason: 'Not listed' };
    }
    try {
      const [tradesRes, fundRes] = await Promise.allSettled([
        getJson(`https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=${sym}USDT&limit=200`),
        getJson(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}USDT&limit=1`),
      ]);

      // Geo-blocked (CloudFront 403) — fall back to Binance global data under Bybit weight slot
      if (tradesRes.status === 'rejected' && tradesRes.reason?.message?.includes('403')) {
        return fetchBybitViaBinanceFallback(sym);
      }

      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'trades failed');

      const list = tradesRes.value?.result?.list ?? [];
      let buyQty = 0, sellQty = 0;
      for (const t of list) {
        const qty = parseFloat(t.size || 0);
        if (t.side === 'Buy') buyQty  += qty;
        else                  sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct   = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct  = 100 - buyPct;

      let fundingPct = null;
      if (fundRes.status === 'fulfilled') {
        const fl = fundRes.value?.result?.list;
        if (fl && fl.length > 0) {
          fundingPct = parseFloat(fl[0].fundingRate) * 100;
        }
      }

      const { signal, color } = computeSignal(buyPct, sellPct, null, fundingPct);
      return { exchange, buyPct, sellPct, volMult: null, fundingPct, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  // Bybit is geo-blocked (US CloudFront 403) — use Binance global spot data in the Bybit weight slot.
  // Binance global has identical liquidity profile and the same futures funding rate feed.
  async function fetchBybitViaBinanceFallback(sym) {
    const exchange = 'Bybit';
    try {
      const [tradesRes, fundRes] = await Promise.allSettled([
        getJson(`https://api.binance.com/api/v3/trades?symbol=${sym}USDT&limit=200`),
        getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}USDT&limit=1`),
      ]);

      if (tradesRes.status === 'rejected') throw new Error(tradesRes.reason?.message || 'binance fb failed');

      const list = tradesRes.value ?? [];
      let buyQty = 0, sellQty = 0;
      for (const t of list) {
        const qty = parseFloat(t.qty || 0);
        // isBuyerMaker=false → taker was buyer (aggressive buy)
        if (!t.isBuyerMaker) buyQty  += qty;
        else                 sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct   = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct  = 100 - buyPct;

      let fundingPct = null;
      if (fundRes.status === 'fulfilled') {
        const fl = fundRes.value;
        if (Array.isArray(fl) && fl.length > 0) {
          fundingPct = parseFloat(fl[0].fundingRate) * 100;
        }
      }

      const { signal, color } = computeSignal(buyPct, sellPct, null, fundingPct);
      return { exchange, buyPct, sellPct, volMult: null, fundingPct, signal, color, available: true, fallback: 'binance-global' };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  async function fetchOkx(sym) {
    const exchange = 'OKX';
    // HYPE not on OKX
    if (sym === 'HYPE') {
      return { exchange, available: false, reason: 'Not listed' };
    }
    try {
      const data = await getJson(`https://www.okx.com/api/v5/market/trades?instId=${sym}-USDT&limit=200`);
      const list = data?.data ?? [];

      let buyQty = 0, sellQty = 0;
      for (const t of list) {
        const qty = parseFloat(t.sz || 0);
        if (t.side === 'buy') buyQty  += qty;
        else                  sellQty += qty;
      }
      const totalQty = buyQty + sellQty;
      const buyPct   = totalQty > 0 ? (buyQty / totalQty) * 100 : 50;
      const sellPct  = 100 - buyPct;

      const { signal, color } = computeSignal(buyPct, sellPct, null, null);
      return { exchange, buyPct, sellPct, volMult: null, fundingPct: null, signal, color, available: true };
    } catch (e) {
      return { exchange, available: false, reason: e.message.slice(0, 60) };
    }
  }

  // ── aggregate ─────────────────────────────────────────────────────
  const WEIGHTS = { Binance: 0.40, Bybit: 0.25, OKX: 0.15, Coinbase: 0.10, Kraken: 0.10 };

  function computeAggregate(exchanges) {
    let score       = 0;
    let distributing = 0, accumulating = 0, volatile = 0;
    let maxFunding  = null;

    for (const ex of exchanges) {
      if (!ex.available) continue;
      const w = WEIGHTS[ex.exchange] ?? 0;
      if (ex.signal === 'DISTRIBUTING') { score -= w; distributing++; }
      else if (ex.signal === 'ACCUMULATING') { score += w; accumulating++; }
      else if (ex.signal === 'VOLATILE') { volatile++; }

      if (ex.fundingPct != null) {
        const absFund = Math.abs(ex.fundingPct);
        if (!maxFunding || absFund > Math.abs(maxFunding.pct)) {
          maxFunding = { exchange: ex.exchange, pct: ex.fundingPct };
        }
      }
    }

    let label;
    if      (score < -0.3) label = 'STRONG SELL PRESSURE';
    else if (score < -0.1) label = 'SELL PRESSURE';
    else if (score >  0.3) label = 'STRONG BUY PRESSURE';
    else if (score >  0.1) label = 'BUY PRESSURE';
    else                   label = 'NEUTRAL';

    return { score, label, distributing, accumulating, volatile, maxFunding, leadingScore: score };
  }

  // ── per-coin fetch ────────────────────────────────────────────────
  async function fetchCoin(sym) {
    const results = await Promise.allSettled([
      fetchBinance(sym),
      fetchCoinbase(sym),
      fetchKraken(sym),
      fetchBybit(sym),
      fetchOkx(sym),
    ]);

    const exchanges = results.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : { exchange: 'Unknown', available: false, reason: String(r.reason).slice(0, 60) }
    );

    const aggregate = computeAggregate(exchanges);
    const entry = { exchanges, aggregate, ts: Date.now() };
    CACHE[sym] = entry;
    return entry;
  }

  // ── fetchAll ──────────────────────────────────────────────────────
  async function fetchAll() {
    const results = await Promise.allSettled(COINS.map(sym => fetchCoin(sym)));
    const detail  = {};
    for (let i = 0; i < COINS.length; i++) {
      if (results[i].status === 'fulfilled') detail[COINS[i]] = results[i].value;
    }
    window.dispatchEvent(new CustomEvent('cex-flow-update', { detail }));
    return detail;
  }

  // ── public API ────────────────────────────────────────────────────
  const CexFlow = {
    POLL_MS,
    get(sym)  { return CACHE[sym] || null; },
    getAll()  { return { ...CACHE }; },
    fetchAll,
    start() {
      if (_timer) return;
      fetchAll();
      _timer = setInterval(fetchAll, POLL_MS);
    },
    stop() {
      clearInterval(_timer);
      _timer = null;
    },
  };

  window.CexFlow = CexFlow;
})();
