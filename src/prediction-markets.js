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

  // ── Kalshi probability velocity tracking ──────────────────────────────────
  // Tracks the last 12 probability readings per coin to detect smart-money
  // drift BEFORE the model catches up. velocity > 0 = Kalshi odds rising (bullish).
  const _probHistory = {};
  const PROB_HIST_MAX = 12;

  // ---- Route through Tauri suppFetch to bypass WebView2 CORS / geo-blocks ----
  async function apiFetch(url, opts = {}) {
    if (typeof window.suppFetch === 'function') {
      try {
        const txt = await window.suppFetch(url, opts);
        return typeof txt === 'string' ? JSON.parse(txt) : txt;
      } catch {}
    }
    const res = await fetch(url, { headers: { Accept: 'application/json' }, ...opts });
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }

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

  // ---- Polymarket — paginated, all crypto markets, suppFetch-routed ----
  // Fetches up to 3 pages (1500 markets) from Gamma API sorted by 24h volume.
  // Falls back to CLOB API if Gamma is unreachable.

  async function fetchPolymarket() {
    // ---- Tier 1: Gamma API (paginated, sort by volume) ----
    try {
      const pages = await Promise.all([0, 500, 1000].map(offset =>
        apiFetch(`${POLY_GAMMA}/markets?active=true&closed=false&limit=500&offset=${offset}&order=volume24hr&ascending=false`)
          .catch(() => null)
      ));
      const all = [];
      for (const d of pages) {
        if (!d) continue;
        const batch = Array.isArray(d) ? d : Array.isArray(d.results) ? d.results : [];
        all.push(...batch);
      }
      if (all.length) return all;
    } catch {}

    // ---- Tier 2: CLOB API fallback ----
    try {
      const d2 = await apiFetch(`${POLY_CLOB}/markets?active=true&limit=500`);
      return Array.isArray(d2) ? d2 : Array.isArray(d2.data) ? d2.data : null;
    } catch { return null; }
  }

  // Keywords that indicate non-crypto political/social markets to exclude
  const POLY_BAD_KW = ['weinstein', 'biden', 'trump', 'ukraine', 'russia', 'election',
    'senate', 'house', 'president', 'gta', 'elon', 'musk', 'harvey', 'ceasefire',
    'tariff', 'nato', 'congress', 'supreme court'];

  // Parse YES probability from a single Gamma API market object
  function _parseYesProb(m) {
    let prices = m.outcomePrices;
    if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { return null; } }
    if (!Array.isArray(prices) || !prices[0]) return null;
    const yes = parseFloat(prices[0]);
    return Number.isFinite(yes) && yes >= 0.01 && yes <= 0.99 ? yes : null;
  }

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
      const yes = _parseYesProb(m);
      if (yes === null) return;
      const vol = parseFloat(m.volume24hr || m.volume || 0) || 1;
      weighted += yes * vol;
      totalVol  += vol;
    });
    if (totalVol === 0) return null;

    // Top 5 by 24h volume with individual YES prices — shown in the 5M view
    const topMarkets = [...hits]
      .map(m => ({ question: m.question, yes: _parseYesProb(m), vol24h: parseFloat(m.volume24hr || m.volume || 0), endDate: m.end_date_iso || m.end_date || m.endDate || null, slug: m.market_slug || m.slug || null }))
      .filter(m => m.yes !== null)
      .sort((a, b) => b.vol24h - a.vol24h)
      .slice(0, 5);

    return {
      probability: Math.min(1, Math.max(0, weighted / totalVol)),
      volume:      totalVol,
      title:       topMarkets[0]?.question,
      count:       hits.length,
      markets:     topMarkets,
    };
  }

  function polymarket5mSentiment(markets, sym) {
    const kw  = COIN_KEYWORDS[sym] || [sym.toLowerCase()];
    const now = Date.now();

    // First try: markets genuinely closing within 6 hours or tagged 5M
    let hits = markets.filter(m => {
      const q = ((m.question || '') + ' ' + (m.description || '')).toLowerCase();
      if (POLY_BAD_KW.some(b => q.includes(b))) return false;
      if (!kw.some(k => q.includes(k))) return false;
      const endRaw = m.end_date_iso || m.end_date || m.endDate || null;
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
      const yes = _parseYesProb(m);
      if (yes === null) return;
      const vol = parseFloat(m.volume24hr || m.volume || 0) || 1;
      weighted += yes * vol;
      totalVol  += vol;
    });
    if (totalVol === 0) return null;

    const topMarkets = [...hits]
      .map(m => ({ question: m.question, yes: _parseYesProb(m), vol24h: parseFloat(m.volume24hr || m.volume || 0), endDate: m.end_date_iso || m.end_date || m.endDate || null, slug: m.market_slug || m.slug || null }))
      .filter(m => m.yes !== null)
      .sort((a, b) => b.vol24h - a.vol24h)
      .slice(0, 5);

    return {
      probability: Math.min(1, Math.max(0, weighted / totalVol)),
      volume:      totalVol,
      title:       topMarkets[0]?.question,
      count:       hits.length,
      markets:     topMarkets,
      _noShortTerm,
    };
  }

  // ---- Snipe detection: contracts closing within 5 min with strong bias ----
  const SNIPE_WINDOW_MS = 5 * 60_000;
  const SNIPE_THRESHOLD = 0.65;

  function detectSnipes(c) {
    const snipes = [];
    const now    = Date.now();
    for (const [sym, data] of Object.entries(c)) {
      for (const [label, market] of [['Kalshi 15M', data?.kalshi15m], ['Kalshi 5M', data?.kalshi5m]]) {
        if (!market?.closeTime || market.probability == null) continue;
        const ms = new Date(market.closeTime).getTime() - now;
        if (ms <= 0 || ms > SNIPE_WINDOW_MS) continue;
        const p   = market.probability;
        const dir = p >= SNIPE_THRESHOLD ? 'UP' : p <= (1 - SNIPE_THRESHOLD) ? 'DOWN' : null;
        if (!dir) continue;
        snipes.push({ sym, dir, prob: p, ms, label: market._proxy15m ? 'Kalshi Nearest' : label, ticker: market.ticker, targetPrice: market.targetPrice });
      }
    }
    return snipes.sort((a, b) => a.ms - b.ms);
  }

  // ---- Probability velocity tracker -----------------------------------
  // Records each new Kalshi YES probability reading (deduped by change + time).
  // Linear regression over the rolling window gives ¢/min velocity — i.e. how
  // fast Kalshi's implied probability is drifting. Positive = bullish pressure.
  function trackProbability(sym, prob) {
    if (prob == null) return;
    if (!_probHistory[sym]) _probHistory[sym] = [];
    const hist = _probHistory[sym];
    const last = hist[hist.length - 1];
    // Require >0.3¢ change OR >15s elapsed since last reading
    if (last && Math.abs(last.prob - prob) < 0.003 && Date.now() - last.ts < 15_000) return;
    hist.push({ prob, ts: Date.now() });
    if (hist.length > PROB_HIST_MAX) hist.shift();
  }

  function getProbVelocity(sym) {
    const hist = _probHistory[sym];
    const latestProb = hist?.[hist.length - 1]?.prob ?? null;
    if (!hist || hist.length < 3) {
      return { velocity: 0, velCentsPerMin: 0, acceleration: 0, trend: 'flat', samples: hist?.length || 0, latestProb };
    }
    const n  = hist.length;
    // Linear regression: x = seconds elapsed since first sample, y = prob
    const t0 = hist[0].ts;
    const xs = hist.map(h => (h.ts - t0) / 1000);
    const ys = hist.map(h => h.prob);
    const xMean = xs.reduce((a, b) => a + b) / n;
    const yMean = ys.reduce((a, b) => a + b) / n;
    const num   = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0);
    const den   = xs.reduce((s, x) => s + (x - xMean) ** 2, 0);
    const slope = den > 0 ? num / den : 0; // prob per second
    const velCentsPerMin = slope * 60 * 100; // → ¢/min

    // Acceleration: velocity of 2nd half vs 1st half
    const compHalfVel = (half) => {
      if (half.length < 2) return 0;
      const dProb = half[half.length - 1].prob - half[0].prob;
      const dSec  = (half[half.length - 1].ts  - half[0].ts) / 1000;
      return dSec > 0 ? dProb / dSec * 60 * 100 : 0;
    };
    const mid          = Math.floor(n / 2);
    const acceleration = compHalfVel(hist.slice(mid)) - compHalfVel(hist.slice(0, mid));

    const trend = velCentsPerMin >= 1.5 ? 'rising' : velCentsPerMin <= -1.5 ? 'falling' : 'flat';
    return {
      velocity:       slope,
      velCentsPerMin: +velCentsPerMin.toFixed(2),
      acceleration:   +acceleration.toFixed(2),
      trend,
      samples:        n,
      latestProb,
    };
  }

  // ---- Aggregation --------------------------------------------------
  // Polymarket: poll every cycle — it's now the primary source
  // Kalshi 5M:  every 2nd cycle (~60s)
  let _polyCycleCount = 0;
  let _polyCache      = null;
  let _k5mCache       = {};

  async function _doFetch() {
    _polyCycleCount++;
    const fetch5M = _polyCycleCount === 1 || _polyCycleCount % 2 === 0;

    // Polymarket + Kalshi 15M in parallel every cycle
    const [kalshi15m, polyMarkets] = await Promise.all([
      fetchKalshi15M(),
      fetchPolymarket(),
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
      const p    = _polyCache ? polymarketSentiment(_polyCache, sym)    : null;
      const p5m  = _polyCache ? polymarket5mSentiment(_polyCache, sym)  : null;

      const sources = [];
      if (k15?.probability != null) sources.push({ name: 'Kalshi15M',  prob: k15.probability, vol: k15.volume || 1 });
      if (p)                        sources.push({ name: 'Polymarket', prob: p.probability,   vol: p.volume   || 1 });

      let combinedProb = null;
      if (sources.length) {
        // 50/50 when both present; solo source gets full weight
        const weights = { 'Kalshi15M': 0.50, 'Polymarket': 0.50 };
        const tw = sources.reduce((s, x) => s + (weights[x.name] || 0.5), 0);
        combinedProb = sources.reduce((s, x) => s + x.prob * (weights[x.name] || 0.5), 0) / tw;
        combinedProb = Math.min(0.99, Math.max(0.01, combinedProb));
      }

      next[sym] = {
        kalshi:       k15?.probability != null ? parseFloat(k15.probability.toFixed(4)) : null,
        poly:         p   ? parseFloat(p.probability.toFixed(4))  : null,
        combinedProb: combinedProb !== null ? parseFloat(combinedProb.toFixed(4)) : null,
        sources,
        kalshi15m:    k15,
        kalshi5m:     k5,
        poly5m:       p5m,
        polyMarkets:  p?.markets   ?? [],   // top-5 individual Poly markets for this coin
        poly5mMkts:   p5m?.markets ?? [],   // top-5 short-term Poly markets
        kalshiTitle:  k15?.title   ?? null,
        polyTitle:    p?.title     ?? null,
        polyCount:    p?.count     ?? 0,
        poly5mTitle:  p5m?.title   ?? null,
        poly5mCount:  p5m?.count   ?? 0,
        probVelocity: getProbVelocity(sym),  // Kalshi YES-price drift (¢/min)
      };
      // Update velocity history AFTER building next[sym] so this cycle feeds next read
      if (k15?.probability != null) trackProbability(sym, k15.probability);
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
    getSnipes()  { return detectSnipes(cache); },
    getVelocity(sym)  { return getProbVelocity(sym); },
    getAllVelocities() { return Object.fromEntries(Object.keys(COIN_KEYWORDS).map(s => [s, getProbVelocity(s)])); },
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
