// ================================================================
// WE|||CRYPTO — Prediction Markets Intelligence Layer v2.1
// Aggregates Kalshi 15M + Kalshi 5M + Polymarket sentiment for crypto markets
//
// Sources (no auth required for market data):
//   Kalshi 15M  — Direct 15-min UP/DOWN direction markets (KXBTC15M etc.)
//                 YES price = market-implied probability price rises in 15 min
//                 Perfectly aligned with our h15 prediction horizon
//   Kalshi 5M   — Direct 5-min UP/DOWN direction markets (KXBTC5M etc.)
//                 Polled on every 2nd cycle to avoid rate limits
//   Polymarket  — Decentralised prediction market on Polygon
//                 Gamma API primary; CLOB API fallback on failure
//
// Exposes window.PredictionMarkets:
//   .start()      — begin 30-second polling
//   .getAll()     — per-coin sentiment map
//   .getCoin(sym) — { kalshi, poly, combinedProb, kalshi15m, kalshi5m, poly5m, sources, ... }
//   .getStatus()  — last fetch metadata
// ================================================================

(function () {
  'use strict';

  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const POLY_GAMMA  = 'https://gamma-api.polymarket.com';
  const POLY_CLOB   = 'https://clob.polymarket.com';
  // 30-second refresh — Kalshi 15M windows are 15 min; 30s is granular enough
  // while halving request rate to stay well under rate limits.
  const POLL_MS = 30_000;

  // Direct 15-minute UP/DOWN series: YES = price higher in 15 min
  const KALSHI_15M_SERIES = {
    BTC:  'KXBTC15M',
    ETH:  'KXETH15M',
    SOL:  'KXSOL15M',
    XRP:  'KXXRP15M',
    DOGE: 'KXDOGE15M',
    BNB:  'KXBNB15M',
    HYPE: 'KXHYPE15M',
  };

  // Direct 5-minute UP/DOWN series — BNB/HYPE gracefully null if not live on Kalshi
  const KALSHI_5M_SERIES = {
    BTC:  'KXBTC5M',
    ETH:  'KXETH5M',
    SOL:  'KXSOL5M',
    XRP:  'KXXRP5M',
    DOGE: 'KXDOGE5M',
  };

  // Polymarket keyword fallback for coins not covered by series
  const COIN_KEYWORDS = {
    BTC:  ['bitcoin', 'btc'],
    ETH:  ['ethereum', 'eth'],
    SOL:  ['solana', 'sol'],
    XRP:  ['xrp', 'ripple'],
    DOGE: ['dogecoin', 'doge'],
    BNB:  ['binance', 'bnb'],
    HYPE: ['hyperliquid', 'hype'],
  };

  // Keywords that identify short-duration (≤5 min) Polymarket markets
  const POLY_5M_KEYWORDS = ['5 min', '5min', '5-min', 'next 5', 'five min', '5m ', '5 m '];
  // Max end_date offset for "short-term" Polymarket proxy (60 minutes)
  const POLY_SHORT_WINDOW_MS = 60 * 60_000;

  let cache      = {};
  let lastFetch  = 0;
  let inFlight   = null;
  let timer      = null;
  // Rate-limit state: if non-zero, skip fetching until this timestamp
  let _rateLimitUntil = 0;
  let _consecutive429 = 0;

  // ---- Rate-limit-aware Kalshi fetch helper --------------------------
  // Retries up to 3 times with exponential backoff on 429/503.
  // After 3 consecutive 429s across any coin, backs off the whole module for 60s.

  async function kalshiFetch(url, attempt = 0) {
    if (_rateLimitUntil > Date.now()) return null; // global back-off active
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 429 || res.status === 503) {
        _consecutive429++;
        const wait = _consecutive429 >= 3
          ? 60_000                                   // hard back-off after 3 in a row
          : Math.min(30_000, 3_000 * (2 ** attempt)); // 3s, 6s, 12s, 24s…
        console.warn(`[PredictionMarkets] HTTP ${res.status} — backoff ${wait}ms (consec=${_consecutive429})`);
        _rateLimitUntil = Date.now() + wait;
        await new Promise(r => setTimeout(r, wait));
        _rateLimitUntil = 0;
        return attempt < 2 ? kalshiFetch(url, attempt + 1) : null;
      }
      _consecutive429 = 0; // reset on success
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  // ---- Generic Kalshi series fetch ------------------------------------
  // Used for both 15M and 5M series — pass a windowMin for the fallback search.

  async function fetchKalshiSeriesForSym(series) {
    // Fetch up to 5 open markets, pick the one closing soonest (nearest-expiry signal)
    let d = await kalshiFetch(`${KALSHI_BASE}/markets?series_ticker=${series}&status=open&limit=5`);
    const now = Date.now();
    let m = (d?.markets || [])
      .filter(mk => { const t = new Date(mk.close_time).getTime(); return Number.isFinite(t) && t > now + 30_000; })
      .sort((a, b) => new Date(a.close_time) - new Date(b.close_time))[0] || null;
    if (!m) return null;

    const yesAsk = parseFloat(m.yes_ask_dollars  || 0);
    const yesBid = parseFloat(m.yes_bid_dollars  || 0);
    const noAsk  = parseFloat(m.no_ask_dollars   || 0);
    const noBid  = parseFloat(m.no_bid_dollars   || 0);
    const last   = parseFloat(m.last_price_dollars || 0);

    let probability = null;
    if (yesAsk > 0 && yesBid > 0)      probability = (yesAsk + yesBid) / 2;
    else if (yesAsk > 0)               probability = yesAsk;
    else if (yesBid > 0)               probability = yesBid;
    else if (noAsk > 0 && noBid > 0)   probability = 1 - (noAsk + noBid) / 2;
    else if (last > 0)                 probability = last;
    if (probability !== null)
      probability = Math.min(0.99, Math.max(0.01, probability));

    const subtitle      = (m.yes_sub_title || m.subtitle || '');
    const tMatch        = subtitle.match(/\$[\d,]+\.?\d*/);
    const targetPrice    = tMatch ? tMatch[0] : null;
    const targetPriceNum = targetPrice ? parseFloat(targetPrice.replace(/[$,]/g, '')) : null;

    return {
      probability, yesAsk, yesBid, last,
      status:        m.status,
      closeTime:     m.close_time,
      openTime:      m.open_time,
      ticker:        m.ticker,
      title:         m.title,
      targetPrice, targetPriceNum,
      volume:       parseFloat(m.volume_fp        || 0),
      liquidity:    parseFloat(m.liquidity_dollars || 0),
      openInterest: parseFloat(m.open_interest_fp  || 0),
    };
  }

  // ---- Kalshi 15M (sequential with 200ms stagger to avoid burst rate limits) ---

  async function fetchKalshi15M() {
    const result = {};
    const coins  = Object.keys(KALSHI_15M_SERIES);
    for (let i = 0; i < coins.length; i++) {
      const sym    = coins[i];
      const series = KALSHI_15M_SERIES[sym];
      if (i > 0) await new Promise(r => setTimeout(r, 50)); // stagger — was 200ms
      result[sym] = await fetchKalshiSeriesForSym(series);
    }
    return result;
  }

  // ---- Kalshi 5M — covers all 7 coins; dedicated 5M series tried first,
  // falls back to nearest-expiry 15M market as real-time proxy ----

  async function fetchKalshi5M() {
    // Cover all 7 coins — use 5M series if available, else nearest-expiry 15M as proxy
    const result = {};
    const coins  = Object.keys(KALSHI_15M_SERIES); // BTC ETH SOL XRP DOGE BNB HYPE
    for (let i = 0; i < coins.length; i++) {
      const sym       = coins[i];
      const series5m  = KALSHI_5M_SERIES[sym] || null;
      if (i > 0) await new Promise(r => setTimeout(r, 50)); // stagger — was 200ms

      // 1. Try dedicated 5M series (e.g. KXBTC5M) — may not exist on Kalshi
      let data = series5m ? await fetchKalshiSeriesForSym(series5m) : null;

      // 2. Fallback: use nearest-expiry 15M market as 5M proxy
      if (!data) {
        const baseSeries = KALSHI_15M_SERIES[sym];
        const d = await kalshiFetch(`${KALSHI_BASE}/markets?series_ticker=${baseSeries}&status=open&limit=5`);
        const now = Date.now();
        const m = (d?.markets || [])
          .filter(mk => { const t = new Date(mk.close_time).getTime(); return Number.isFinite(t) && t > now + 30_000; })
          .sort((a, b) => new Date(a.close_time) - new Date(b.close_time))[0] || null;
        if (m) {
          const yesAsk = parseFloat(m.yes_ask_dollars  || 0);
          const yesBid = parseFloat(m.yes_bid_dollars  || 0);
          const noAsk  = parseFloat(m.no_ask_dollars   || 0);
          const noBid  = parseFloat(m.no_bid_dollars   || 0);
          const last   = parseFloat(m.last_price_dollars || 0);
          let probability = null;
          if (yesAsk > 0 && yesBid > 0)      probability = (yesAsk + yesBid) / 2;
          else if (yesAsk > 0)               probability = yesAsk;
          else if (yesBid > 0)               probability = yesBid;
          else if (noAsk > 0 && noBid > 0)   probability = 1 - (noAsk + noBid) / 2;
          else if (last > 0)                 probability = last;
          if (probability !== null)
            probability = Math.min(0.99, Math.max(0.01, probability));
          const subtitle    = (m.yes_sub_title || m.subtitle || '');
          const tMatch      = subtitle.match(/\$[\d,]+\.?\d*/);
          const targetPrice = tMatch ? tMatch[0] : null;
          data = {
            probability, yesAsk, yesBid, last,
            status: m.status, closeTime: m.close_time, openTime: m.open_time,
            ticker: m.ticker, title: m.title, targetPrice,
            targetPriceNum: targetPrice ? parseFloat(targetPrice.replace(/[$,]/g, '')) : null,
            volume:       parseFloat(m.volume_fp        || 0),
            liquidity:    parseFloat(m.liquidity_dollars || 0),
            openInterest: parseFloat(m.open_interest_fp  || 0),
            _proxy15m: true, // using nearest-expiry 15M market as 5M proxy
          };
        }
      }
      result[sym] = data;
    }
    return result;
  }

  // ---- Polymarket ---------------------------------------------------

  async function fetchPolymarket() {
    try {
      const res = await fetch(
        `${POLY_GAMMA}/markets?active=true&closed=false&limit=500`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) throw new Error(res.status);
      const d = await res.json();
      return Array.isArray(d) ? d : (Array.isArray(d.results) ? d.results : null);
    } catch {
      // Fallback to Polymarket CLOB API
      try {
        const res2 = await fetch(
          `${POLY_CLOB}/markets?active=true&limit=200`,
          { headers: { Accept: 'application/json' } }
        );
        if (!res2.ok) return null;
        const d2 = await res2.json();
        return Array.isArray(d2) ? d2 : (Array.isArray(d2.data) ? d2.data : null);
      } catch { return null; }
    }
  }

  // Keywords that indicate non-crypto political/social markets to exclude
  const POLY_BAD_KW = ['weinstein', 'biden', 'trump', 'ukraine', 'russia', 'election',
    'senate', 'house', 'president', 'gta', 'elon', 'musk', 'harvey', 'ceasefire',
    'tariff', 'nato', 'congress', 'supreme court'];

  function polymarketSentiment(markets, sym) {
    const kw = COIN_KEYWORDS[sym] || [sym.toLowerCase()];
    const hits = markets.filter(m => {
      const q = ((m.question || '') + ' ' + (m.description || '')).toLowerCase();
      if (POLY_BAD_KW.some(b => q.includes(b))) return false;
      return kw.some(k => q.includes(k));
    });
    if (!hits.length) return null;

    let totalVol = 0, weighted = 0;
    hits.forEach(m => {
      // Polymarket Gamma API returns outcomePrices as a JSON-encoded string — parse it
      let prices = m.outcomePrices;
      if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { return; } }
      if (!Array.isArray(prices) || !prices[0]) return;
      const yes = parseFloat(prices[0]);
      if (!Number.isFinite(yes) || yes < 0.01 || yes > 0.99) return; // skip resolved
      const vol = parseFloat(m.volume24hr || m.volume || 0) || 1;
      weighted += yes * vol;
      totalVol  += vol;
    });
    if (totalVol === 0) return null;

    const top = [...hits].sort((a, b) =>
      parseFloat(b.volume24hr || b.volume || 0) - parseFloat(a.volume24hr || a.volume || 0)
    )[0];
    return {
      probability: Math.min(1, Math.max(0, weighted / totalVol)),
      volume: totalVol,
      title:  top?.question,
      count:  hits.length,
    };
  }

  // Filter markets by shortest expiry for this coin (short-term proxy when 5M series absent).
  // Primary filter: markets ending within POLY_SHORT_WINDOW_MS from now.
  // Fallback: keyword matching for markets without an end_date field.
  function polymarket5mSentiment(markets, sym) {
    const kw  = COIN_KEYWORDS[sym] || [sym.toLowerCase()];
    const now = Date.now();

    // First try: markets genuinely closing within 6 hours or tagged 5M
    let hits = markets.filter(m => {
      const q = ((m.question || '') + ' ' + (m.description || '')).toLowerCase();
      if (POLY_BAD_KW.some(b => q.includes(b))) return false;
      if (!kw.some(k => q.includes(k))) return false;
      const endRaw = m.end_date || m.endDate || m.end_date_iso || null;
      if (endRaw) {
        const endMs = new Date(endRaw).getTime();
        if (endMs > now && endMs <= now + 6 * 60 * 60_000) return true;
      }
      return POLY_5M_KEYWORDS.some(k => q.includes(k));
    });

    // Fallback: any active coin market as long-term sentiment context
    const _noShortTerm = hits.length === 0;
    if (_noShortTerm) {
      hits = markets.filter(m => {
        const q = ((m.question || '') + ' ' + (m.description || '')).toLowerCase();
        if (POLY_BAD_KW.some(b => q.includes(b))) return false;
        return kw.some(k => q.includes(k));
      });
    }
    if (!hits.length) return null;

    let totalVol = 0, weighted = 0;
    hits.forEach(m => {
      // Parse outcomePrices which may be a JSON string in Polymarket Gamma API
      let prices = m.outcomePrices;
      if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { return; } }
      if (!Array.isArray(prices) || !prices[0]) return;
      const yes = parseFloat(prices[0]);
      if (!Number.isFinite(yes) || yes < 0.01 || yes > 0.99) return;
      const vol = parseFloat(m.volume24hr || m.volume || 0) || 1;
      weighted += yes * vol;
      totalVol  += vol;
    });
    if (totalVol === 0) return null;

    const top = [...hits].sort((a, b) =>
      parseFloat(b.volume24hr || b.volume || 0) - parseFloat(a.volume24hr || a.volume || 0)
    )[0];
    return {
      probability: Math.min(1, Math.max(0, weighted / totalVol)),
      volume:      totalVol,
      title:       top?.question,
      count:       hits.length,
      _noShortTerm, // true = no short-term Poly market found; using long-term sentiment
    };
  }

  // ---- Aggregation --------------------------------------------------
  // Polymarket: throttle to every 4 min (every 8th 30s cycle)
  // Kalshi 5M:  throttle to every 2nd cycle (~60s) — window is 5 min so 60s is adequate
  let _polyCycleCount = 0;
  let _polyCache      = null;
  let _k5mCache       = {};

  async function _doFetch() {
    _polyCycleCount++;
    const fetchPoly = _polyCycleCount === 1 || _polyCycleCount % 8 === 0;
    const fetch5M   = _polyCycleCount === 1 || _polyCycleCount % 2 === 0;

    // Run 15M + poly in parallel; run 5M separately after to avoid burst
    const [kalshi15m, polyMarkets] = await Promise.all([
      fetchKalshi15M(),
      fetchPoly ? fetchPolymarket() : Promise.resolve(null),
    ]);
    if (polyMarkets !== null) _polyCache = polyMarkets;

    if (fetch5M) {
      const k5m = await fetchKalshi5M();
      if (Object.keys(k5m).length > 0) _k5mCache = k5m;
    }

    const next = {};
    for (const sym of Object.keys(COIN_KEYWORDS)) {
      const k15  = kalshi15m[sym] ?? null;
      const k5   = _k5mCache[sym] ?? null;
      const p    = _polyCache ? polymarketSentiment(_polyCache, sym) : null;
      const p5m  = _polyCache ? polymarket5mSentiment(_polyCache, sym) : null;

      const sources = [];
      if (k15?.probability != null) sources.push({ name: 'Kalshi15M', prob: k15.probability, vol: k15.volume || 1 });
      if (p)                        sources.push({ name: 'Polymarket', prob: p.probability,  vol: p.volume   || 1 });

      let combinedProb = null;
      if (sources.length) {
        const weights = { 'Kalshi15M': 0.70, 'Polymarket': 0.30 };
        const tw = sources.reduce((s, x) => s + weights[x.name], 0);
        combinedProb = sources.reduce((s, x) => s + x.prob * weights[x.name], 0) / tw;
        combinedProb = Math.min(0.99, Math.max(0.01, combinedProb));
      }

      next[sym] = {
        kalshi:        k15?.probability != null ? parseFloat(k15.probability.toFixed(4)) : null,
        poly:          p  ? parseFloat(p.probability.toFixed(4)) : null,
        combinedProb:  combinedProb !== null ? parseFloat(combinedProb.toFixed(4)) : null,
        sources,
        kalshi15m:     k15,
        kalshi5m:      k5,
        poly5m:        p5m,
        kalshiTitle:   k15?.title ?? null,
        polyTitle:     p?.title   ?? null,
        polyCount:     p?.count   ?? 0,
        poly5mTitle:   p5m?.title ?? null,
        poly5mCount:   p5m?.count ?? 0,
      };
    }

    cache     = next;
    lastFetch = Date.now();
    window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: next }));
  }

  async function fetchAll() {
    if (inFlight) return inFlight;
    inFlight = _doFetch().finally(() => { inFlight = null; });
    return inFlight;
  }

  // ---- Public API ---------------------------------------------------

  window.PredictionMarkets = {
    start() {
      if (PredictionMarkets._started) return;
      PredictionMarkets._started = true;
      if (timer) return;
      fetchAll();
      timer = setInterval(() => { if (!document.hidden) fetchAll(); }, POLL_MS);
      // Fast-poll: when any 15M contract is < 2 min from close, re-fetch Kalshi every 10s.
      // Ensures price is at most 10s stale for last-call trades.
      setInterval(() => {
        if (document.hidden || inFlight) return;
        const now = Date.now();
        const nearClose = Object.values(cache).some(c => {
          const ct = c && c.kalshi15m && c.kalshi15m.closeTime;
          if (!ct) return false;
          const ms = new Date(ct).getTime() - now;
          return ms > 0 && ms < 120_000;
        });
        if (nearClose) fetchAll();
      }, 10_000);
    },
    getAll()     { return cache; },
    getCoin(sym) { return cache[sym] ?? null; },
    getStatus()  {
      return {
        lastFetch,
        age:       lastFetch ? Date.now() - lastFetch : null,
        hasData:   Object.keys(cache).length > 0,
        coinCount: Object.values(cache).filter(c => c.combinedProb !== null).length,
      };
    },
    fetchAll,
  };

})();
