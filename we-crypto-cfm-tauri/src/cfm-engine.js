// ================================================================
// WE|||CRYPTO — CFM Benchmark Orchestrator v2
//
// CF Benchmarks methodology applied to public multi-venue spot sources:
//   CDC  = Crypto.com Exchange (ticker, book, trades)
//   CB   = Coinbase (spot/buy/sell prices)
//   GKO  = CoinGecko (price, volume, 24h change)
//   DEX  = DexScreener (on-chain DEX aggregated pairs)
//   BIN  = Binance spot
//   OKX  = OKX spot
//
// Rolling 15-minute window partitioned into 5 × 3-min buckets.
// Volume-Weighted Median (VWM) per partition.
// Final CFM rate = equally-weighted average of partition VWMs.
// Polls every 15 seconds with staggered, rate-limit-aware calls.
// ================================================================

(function () {
  'use strict';

  // ── Fetch with AbortController timeout ──────────────────────────────────
  function fetchWithTimeout(url, ms = 8000) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal })
      .then(r => { clearTimeout(tid); return r; })
      .catch(e => { clearTimeout(tid); throw e; });
  }

  const POLL_MS = 15000;
  const WINDOW_MIN = 15;    // 15-minute rolling window — full quarter-hour of CFM data
  const PARTITIONS = 5;     // 5 × 3-minute VWM buckets per window
  const MAX_BUF = 120;

  // Source configs with rate budgets (calls per 60s)
  const SRC = {
    CDC:  { budget: 80, used: 0, resetAt: 0, label: 'Crypto.com',   color: '#1a2c5a' },
    CB:   { budget: 60, used: 0, resetAt: 0, label: 'Coinbase',     color: '#0052ff' },
    GKO:  { budget: 25, used: 0, resetAt: 0, label: 'CoinGecko',    color: '#8dc63f' },
    DEX:  { budget: 20, used: 0, resetAt: 0, label: 'DexScreener',  color: '#a259ff' },
    BIN:  { budget: 120, used: 0, resetAt: 0, label: 'Binance',     color: '#f3ba2f' },
    OKX:  { budget: 60, used: 0, resetAt: 0, label: 'OKX',          color: '#ffffff' },
    KRK:  { budget: 30, used: 0, resetAt: 0, label: 'Kraken',       color: '#5741d9' },
  };

  // DexScreener search queries per coin
  const DEX_QUERIES = {
    BTC:  'WBTC USDC',   ETH:  'WETH USDC',   SOL:  'SOL USDC',
    XRP:  'XRP USDT',    HYPE: 'HYPE USDC',   DOGE: 'DOGE USDT',   BNB:  'WBNB',
  };
  const DEX_BASE_SYMS = {
    BTC: ['BTC', 'WBTC'],
    ETH: ['ETH', 'WETH'],
    SOL: ['SOL', 'WSOL'],
    XRP: ['XRP', 'WXRP'],
    HYPE: ['HYPE', 'WHYPE'],
    DOGE: ['DOGE', 'WDOGE'],
    BNB: ['BNB', 'WBNB'],
  };
  const DEX_STABLE_QUOTES = new Set(['USD', 'USDC', 'USDT', 'BUSD', 'DAI', 'FDUSD', 'USDE', 'USDL', 'USDS', 'USDBC']);

  // Coinbase symbols
  // BNB removed — Coinbase does not list BNB; calling spot/buy/sell for it burns 3 CB credits for 404s.
  const CB_SYMS  = { BTC:'BTC', ETH:'ETH', SOL:'SOL', XRP:'XRP', HYPE:'HYPE', DOGE:'DOGE' };
  const BIN_SYMS = { BTC:'BTCUSDT', ETH:'ETHUSDT', SOL:'SOLUSDT', XRP:'XRPUSDT', HYPE:'HYPEUSDT', DOGE:'DOGEUSDT', BNB:'BNBUSDT' };
  const OKX_SYMS = { BTC:'BTC-USDT', ETH:'ETH-USDT', SOL:'SOL-USDT', XRP:'XRP-USDT', HYPE:'HYPE-USDT', DOGE:'DOGE-USDT', BNB:'BNB-USDT' };
  const KRK_SYMS = { BTC:'XBTUSD', ETH:'ETHUSD', SOL:'SOLUSD', XRP:'XRPUSD', DOGE:'XDGUSD', BNB:'BNBUSD' }; // HYPE not listed on Kraken

  const CDC_BASE = 'https://api.crypto.com/exchange/v1/public';
  const CB_BASE  = 'https://api.coinbase.com/v2/prices';
  const GKO_BASE = 'https://api.coingecko.com/api/v3';
  const DEX_BASE = 'https://api.dexscreener.com/latest/dex';
  const BIN_BASE = 'https://api.binance.com/api/v3';
  const OKX_BASE = 'https://www.okx.com/api/v5/market';
  const KRK_BASE = 'https://api.kraken.com/0/public';

  // State
  const sampleBuf = {};  // sym → [ { t, sources:{CDC,CB,GKO,DEX}, vol, bid, ask } ]
  window._cfm = {};
  let timer = null;
  let cycle = 0;
  let lastMs = 0;
  let cdcTickerCache = null; // shared ticker response (single call for all coins)
  let cdcTickerAge = 0;

  // ---- Rate limiter ----
  function can(src) {
    const s = SRC[src]; if (!s) return true;
    const now = Date.now();
    if (now > s.resetAt) { s.used = 0; s.resetAt = now + 60000; }
    return s.used < s.budget;
  }
  function hit(src) { if (SRC[src]) SRC[src].used++; }

  // ---- Fetchers ----

  // CDC: single tickers call — uses shared cache from app.js if fresh
  async function fetchCDCTickers() {
    // Check shared cache from app.js (avoids duplicate HTTP call)
    const shared = window._sharedTickerCache;
    if (shared && shared.raw && Date.now() - shared.age < 10000) {
      cdcTickerCache = shared.raw;
      cdcTickerAge = shared.age;
      return cdcTickerCache;
    }
    if (!can('CDC')) return null;
    if (cdcTickerCache && Date.now() - cdcTickerAge < 10000) return cdcTickerCache;
    try {
      hit('CDC');
      const r = await fetchWithTimeout(`${CDC_BASE}/get-tickers`);
      if (!r.ok) return null;
      const j = await r.json();
      if (j.code !== 0) return null;
      cdcTickerCache = j.result.data;
      cdcTickerAge = Date.now();
      // Populate shared cache for app.js
      window._sharedTickerCache = { raw: cdcTickerCache, age: cdcTickerAge };
      return cdcTickerCache;
    } catch { return null; }
  }

  function parseCDCTicker(allTickers, instrument) {
    if (!allTickers) return null;
    const t = allTickers.find(x => {
      const n = (x.i || x.instrument_name || '').replace(/_/g, '');
      return n === instrument;
    });
    if (!t) return null;
    return {
      price: parseFloat(t.a ?? t.last),
      vol: parseFloat(t.vv ?? t.volume_value ?? 0),
      bid: parseFloat(t.b ?? t.best_bid ?? 0),
      ask: parseFloat(t.k ?? t.best_ask ?? 0),
    };
  }

  // Coinbase: spot + buy + sell
  // hit() is now staged: 1 credit for spot first, 2 more only after spot succeeds.
  // This prevents wasting 3 credits on coins that return 404 (e.g. symbols not listed on CB).
  async function fetchCB(sym) {
    if (!can('CB')) return null;
    try {
      const handleResp = async (r) => {
        if (r.status === 429) { console.warn('CB rate limited'); return null; }
        if (!r.ok) return null;
        return r.json();
      };
      // Fetch spot first — if it fails, skip buy/sell and don't burn the extra 2 credits.
      hit('CB');
      const spot = await fetchWithTimeout(`${CB_BASE}/${sym}-USD/spot`).then(handleResp).catch(() => null);
      const sp = parseFloat(spot?.data?.amount || 0);
      if (!sp) return null;
      hit('CB'); hit('CB');
      const [buy, sell] = await Promise.all([
        fetchWithTimeout(`${CB_BASE}/${sym}-USD/buy`).then(handleResp).catch(() => null),
        fetchWithTimeout(`${CB_BASE}/${sym}-USD/sell`).then(handleResp).catch(() => null),
      ]);
      const bp = parseFloat(buy?.data?.amount || 0);
      const slp = parseFloat(sell?.data?.amount || 0);
      return { price: sp, buy: bp, sell: slp, spread: bp > 0 && slp > 0 ? (Math.abs(bp - slp) / sp) * 100 : 0 };
    } catch { return null; }
  }

  // CoinGecko
  async function fetchGKO(geckoId) {
    if (!can('GKO')) return null;
    try {
      hit('GKO');
      const r = await fetchWithTimeout(`${GKO_BASE}/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`);
      if (!r.ok) return null;
      const j = await r.json();
      const d = j[geckoId];
      return d ? { price: d.usd, vol: d.usd_24h_vol || 0, change: d.usd_24h_change || 0 } : null;
    } catch { return null; }
  }

  async function fetchBIN(sym) {
    const binSym = BIN_SYMS[sym];
    if (!binSym || !can('BIN')) return null;
    try {
      hit('BIN'); hit('BIN');
      const [ticker, book] = await Promise.all([
        fetchWithTimeout(`${BIN_BASE}/ticker/24hr?symbol=${binSym}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetchWithTimeout(`${BIN_BASE}/ticker/bookTicker?symbol=${binSym}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      const price = parseFloat(ticker?.lastPrice || 0);
      if (!price) return null;
      return {
        price,
        vol: parseFloat(ticker?.quoteVolume || 0),
        bid: parseFloat(book?.bidPrice || 0),
        ask: parseFloat(book?.askPrice || 0),
      };
    } catch { return null; }
  }

  async function fetchOKX(sym) {
    const okxSym = OKX_SYMS[sym];
    if (!okxSym || !can('OKX')) return null;
    try {
      hit('OKX');
      const r = await fetchWithTimeout(`${OKX_BASE}/ticker?instId=${okxSym}`);
      if (!r.ok) return null;
      const j = await r.json();
      const row = j?.data?.[0];
      const price = parseFloat(row?.last || 0);
      if (!price) return null;
      return {
        price,
        vol: parseFloat(row?.volCcy24h || 0),
        bid: parseFloat(row?.bidPx || 0),
        ask: parseFloat(row?.askPx || 0),
      };
    } catch { return null; }
  }

  async function fetchKRK(sym) {
    const krkSym = KRK_SYMS[sym];
    if (!krkSym || !can('KRK')) return null;
    try {
      hit('KRK');
      const r = await fetchWithTimeout(`${KRK_BASE}/Ticker?pair=${krkSym}`);
      if (!r.ok) return null;
      const j = await r.json();
      if (j.error?.length) return null;
      const row = Object.values(j.result || {})[0];
      if (!row) return null;
      const price = parseFloat(row.c?.[0] || 0);
      if (!price) return null;
      return {
        price,
        vol: parseFloat(row.v?.[1] || 0),    // 24h rolling volume
        bid: parseFloat(row.b?.[0] || 0),
        ask: parseFloat(row.a?.[0] || 0),
      };
    } catch { return null; }
  }

  // DexScreener
  async function fetchDEX(sym) {if (!can('DEX')) return null;
    const q = DEX_QUERIES[sym];
    if (!q) return null;
    try {
      hit('DEX');
      const r = await fetchWithTimeout(`${DEX_BASE}/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) return null;
      const j = await r.json();
      const targetBases = new Set((DEX_BASE_SYMS[sym] || [sym]).map(v => String(v).toUpperCase()));
      const quoteScore = quote => {
        const qSym = String(quote || '').toUpperCase().replace(/\./g, '');
        return DEX_STABLE_QUOTES.has(qSym) ? 2 : (qSym.includes('USD') ? 1 : 0);
      };
      const pairs = (j.pairs || []).filter(p => {
        const baseSym = String(p.baseToken?.symbol || '').toUpperCase();
        const quoteSym = String(p.quoteToken?.symbol || '').toUpperCase();
        const price = parseFloat(p.priceUsd || 0);
        return targetBases.has(baseSym) && price > 0 && quoteScore(quoteSym) > 0;
      }).sort((a, b) => {
        const quoteDelta = quoteScore(b.quoteToken?.symbol) - quoteScore(a.quoteToken?.symbol);
        if (quoteDelta !== 0) return quoteDelta;
        const liqDelta = parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0);
        if (liqDelta !== 0) return liqDelta;
        return parseFloat(b.volume?.h24 || 0) - parseFloat(a.volume?.h24 || 0);
      });
      if (pairs.length === 0) return null;
      const top = pairs[0];
      return {
        price: parseFloat(top.priceUsd || 0),
        vol: parseFloat(top.volume?.h24 || 0),
        liq: parseFloat(top.liquidity?.usd || 0),
        dex: top.dexId,
        chain: top.chainId,
        pair: `${top.baseToken.symbol}/${top.quoteToken.symbol}`,
        txns: top.txns?.h24 || {},
      };
    } catch { return null; }
  }

  // ---- Sampling orchestrator (staggered) ----
  async function sampleAll() {
    const now = Date.now();

    // Phase 1: CDC (single call for all coins)
    const cdcAll = await fetchCDCTickers();

    // Phase 2: Coinbase (2 coins per cycle, rotating through all 7)
    // 2 coins * 3 calls each = 6 calls/cycle * 4 cycles/min = 24 calls/min (safe under 60)
    const cbIdx = cycle % PREDICTION_COINS.length;
    const cbBatch = [
      PREDICTION_COINS[cbIdx],
      PREDICTION_COINS[(cbIdx + 1) % PREDICTION_COINS.length],
    ];

    const cbResults = {};
    await Promise.allSettled(cbBatch.map(async c => {
      if (!CB_SYMS[c.sym]) return;  // coin not listed on Coinbase — skip entirely
      const r = await fetchCB(CB_SYMS[c.sym]);
      if (r) cbResults[c.sym] = r;
    }));

    const binResults = {};
    await Promise.allSettled(PREDICTION_COINS.map(async c => {
      const r = await fetchBIN(c.sym);
      if (r) binResults[c.sym] = r;
    }));

    // Phase 3: CoinGecko (every 4th cycle = every 60s)
    const gkoResults = {};
    if (cycle % 4 === 0) {
      // Batch all gecko IDs in one call
      const ids = PREDICTION_COINS.map(c => c.geckoId).join(',');
      if (can('GKO')) {
        try {
          hit('GKO');
          const r = await fetchWithTimeout(`${GKO_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`);
          if (r.ok) {
            const j = await r.json();
            PREDICTION_COINS.forEach(c => {
              if (j[c.geckoId]) gkoResults[c.sym] = { price: j[c.geckoId].usd, vol: j[c.geckoId].usd_24h_vol || 0 };
            });
          }
        } catch {}
      }
    }

    const okxResults = {};
    if (cycle % 2 === 0) {
      await Promise.allSettled(PREDICTION_COINS.map(async c => {
        const r = await fetchOKX(c.sym);
        if (r) okxResults[c.sym] = r;
      }));
    }

    // Kraken: every 3rd cycle (~45s interval, well under 30/min budget)
    const krkResults = {};
    if (cycle % 3 === 0) {
      await Promise.allSettled(PREDICTION_COINS.map(async c => {
        const r = await fetchKRK(c.sym);
        if (r) krkResults[c.sym] = r;
      }));
    }

    // Phase 4: DexScreener (every 5th cycle = every 75s, 2 coins at a time)
    const dexResults = {};
    if (cycle % 5 === 0 || cycle % 5 === 1) {
      const dexBatch = PREDICTION_COINS.filter((_, i) => i % 4 === (cycle % 5 === 0 ? 0 : 2)).slice(0, 2);
      for (const c of dexBatch) {
        const r = await fetchDEX(c.sym);
        if (r) dexResults[c.sym] = r;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    // Assemble samples
    PREDICTION_COINS.forEach(coin => {
      const s = { t: now, sources: {}, vol: 0, bid: 0, ask: 0, meta: {} };

      // CDC
      const cdc = parseCDCTicker(cdcAll, coin.instrument);
      if (cdc) { s.sources.CDC = cdc.price; s.vol = cdc.vol; s.bid = cdc.bid; s.ask = cdc.ask; }

      // Coinbase
      if (cbResults[coin.sym]) { s.sources.CB = cbResults[coin.sym].price; s.meta.cbSpread = cbResults[coin.sym].spread; }

      // CoinGecko
      if (gkoResults[coin.sym]) { s.sources.GKO = gkoResults[coin.sym].price; if (!s.vol) s.vol = gkoResults[coin.sym].vol; }
      // Carry forward last GKO value if not polled this cycle (max 60s staleness to avoid injecting stale price as live)
      else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        if (last.sources.GKO && (now - last.t) < 60000) s.sources.GKO = last.sources.GKO;
      }

      // Binance
      if (binResults[coin.sym]) {
        s.sources.BIN = binResults[coin.sym].price;
        if (!s.bid && binResults[coin.sym].bid) s.bid = binResults[coin.sym].bid;
        if (!s.ask && binResults[coin.sym].ask) s.ask = binResults[coin.sym].ask;
        if (!s.vol) s.vol = binResults[coin.sym].vol;
      } else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        if (last.sources.BIN) s.sources.BIN = last.sources.BIN;
      }

      // OKX
      if (okxResults[coin.sym]) {
        s.sources.OKX = okxResults[coin.sym].price;
        if (!s.bid && okxResults[coin.sym].bid) s.bid = okxResults[coin.sym].bid;
        if (!s.ask && okxResults[coin.sym].ask) s.ask = okxResults[coin.sym].ask;
        if (!s.vol) s.vol = okxResults[coin.sym].vol;
      } else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        if (last.sources.OKX) s.sources.OKX = last.sources.OKX;
      }

      // Kraken
      if (krkResults[coin.sym]) {
        s.sources.KRK = krkResults[coin.sym].price;
        if (!s.bid && krkResults[coin.sym].bid) s.bid = krkResults[coin.sym].bid;
        if (!s.ask && krkResults[coin.sym].ask) s.ask = krkResults[coin.sym].ask;
        if (!s.vol) s.vol = krkResults[coin.sym].vol;
      } else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        if (last.sources.KRK) s.sources.KRK = last.sources.KRK;
      }

      // DexScreener
      if (dexResults[coin.sym]) {
        s.sources.DEX = dexResults[coin.sym].price;
        s.meta.dex = dexResults[coin.sym];
      } else if (sampleBuf[coin.sym]?.length > 0) {
        const last = sampleBuf[coin.sym][sampleBuf[coin.sym].length - 1];
        if (last.sources.DEX) { s.sources.DEX = last.sources.DEX; s.meta.dex = last.meta?.dex; }
      }

      // Drop venue outliers so one bad quote cannot fabricate a fake arb window.
      const entries = Object.entries(s.sources).filter(([, value]) => Number.isFinite(value) && value > 0);
      if (entries.length >= 3) {
        const sorted = entries.map(([, value]) => value).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const rejected = entries.filter(([, value]) => Math.abs(value - median) / median > 0.08).map(([src]) => src);
        rejected.forEach(src => delete s.sources[src]);
        if (rejected.length) s.meta.rejectedSources = rejected;
      }

      // Buffer
      if (!sampleBuf[coin.sym]) sampleBuf[coin.sym] = [];
      sampleBuf[coin.sym].push(s);
      if (sampleBuf[coin.sym].length > MAX_BUF) sampleBuf[coin.sym] = sampleBuf[coin.sym].slice(-MAX_BUF);
    });
  }

  // ---- CFM Calculation ----
  function volumeWeightedMedian(trades) {
    if (!trades.length) return null;
    if (trades.length === 1) return trades[0].price;
    const sorted = [...trades].sort((a, b) => a.price - b.price);
    const total = sorted.reduce((s, t) => s + t.vol, 0);
    const half = total / 2;
    let cum = 0;
    for (const t of sorted) { cum += t.vol; if (cum >= half) return t.price; }
    return sorted[sorted.length - 1].price;
  }

  function computeCFM(sym) {
    const buf = sampleBuf[sym];
    if (!buf || buf.length < 3) return { cfmRate: 0, error: 'Warming up', sampleCount: buf?.length || 0 };

    const now = Date.now();
    const winMs = WINDOW_MIN * 60000;
    const winStart = now - winMs;
    const winSamples = buf.filter(s => s.t >= winStart);
    const useSamples = winSamples.length >= 2 ? winSamples : buf.slice(-10);

    // Partition → VWM
    const partMs = winMs / PARTITIONS;
    const parts = [];
    for (let i = 0; i < PARTITIONS; i++) {
      const ps = winStart + i * partMs, pe = ps + partMs;
      const pSamples = useSamples.filter(s => s.t >= ps && s.t < pe);
      if (!pSamples.length) { parts.push({ vwm: null, n: 0, i: i + 1 }); continue; }

      const trades = pSamples.map(s => {
        const prices = Object.values(s.sources);
        if (!prices.length) return null;
        return { price: prices.reduce((a, b) => a + b, 0) / prices.length, vol: s.vol || 1 };
      }).filter(Boolean);

      parts.push({ vwm: volumeWeightedMedian(trades), n: trades.length, i: i + 1 });
    }

    const valid = parts.filter(p => p.vwm !== null);
    const cfmRate = valid.length > 0 ? valid.reduce((s, p) => s + p.vwm, 0) / valid.length : 0;

    // VWAP
    let vN = 0, vD = 0;
    useSamples.forEach(s => {
      const pp = Object.values(s.sources);
      if (!pp.length) return;
      const avg = pp.reduce((a, b) => a + b, 0) / pp.length;
      const v = s.vol || 1;
      vN += avg * v; vD += v;
    });
    const vwap15 = vD > 0 ? vN / vD : cfmRate;

    // TWAP
    const allP = useSamples.map(s => {
      const pp = Object.values(s.sources);
      return pp.length > 0 ? pp.reduce((a, b) => a + b, 0) / pp.length : null;
    }).filter(Boolean);
    const twap15 = allP.length > 0 ? allP.reduce((a, b) => a + b, 0) / allP.length : cfmRate;

    // Cross-exchange spread + convergence
    const latest = buf[buf.length - 1];
    const srcPrices = Object.entries(latest.sources);
    const prices = srcPrices.map(([, v]) => v);
    const spread = prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100 : 0;
    let convergence = 0;
    if (prices.length > 1) {
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      convergence = mean > 0 ? (Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length) / mean) * 100 : 0;
    }

    // Bid-ask
    const bidAsk = latest.bid > 0 && latest.ask > 0 ? ((latest.ask - latest.bid) / latest.bid) * 100 : 0;

    // Momentum (rate of cfmRate change over last 5 cycles)
    let momentum = 0;
    if (buf.length > 5) {
      const older = buf[buf.length - 6];
      const op = Object.values(older.sources);
      if (op.length) { const oa = op.reduce((a, b) => a + b, 0) / op.length; if (oa > 0) momentum = ((cfmRate - oa) / oa) * 100; }
    }

    // Trend
    let trend = 'flat';
    if (allP.length > 2) {
      const h1 = allP.slice(0, Math.floor(allP.length / 2));
      const h2 = allP.slice(Math.floor(allP.length / 2));
      const a1 = h1.reduce((a, b) => a + b, 0) / h1.length;
      const a2 = h2.reduce((a, b) => a + b, 0) / h2.length;
      const d = ((a2 - a1) / a1) * 100;
      trend = d > 0.03 ? 'rising' : d < -0.03 ? 'falling' : 'flat';
    }

    // Source breakdown
    const sourceDetail = {};
    srcPrices.forEach(([k, v]) => { sourceDetail[k] = v; });

    // DEX metadata
    const dexMeta = latest.meta?.dex || null;

    return {
      cfmRate, vwap15, twap15, spread, convergence, bidAsk, momentum, trend,
      partitions: parts,
      sources: sourceDetail,
      sourceCount: Object.keys(sourceDetail).length,
      sampleCount: buf.length,
      windowSamples: useSamples.length,
      dexMeta,
      cbSpread: latest.meta?.cbSpread || 0,
      lastPrice: prices.length > 0 ? prices[prices.length - 1] : 0,
      updatedAt: new Date().toLocaleTimeString(),
    };
  }

  // ---- Orchestrator ----
  async function runCycle() {
    const t0 = Date.now();
    cycle++;
    await sampleAll();
    PREDICTION_COINS.forEach(c => { window._cfm[c.sym] = computeCFM(c.sym); });
    lastMs = Date.now() - t0;
  }

  // ---- Public API ----
  window.CFMEngine = {
    async start() { await runCycle(); timer = setInterval(runCycle, POLL_MS); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    get(sym) { return window._cfm[sym] || null; },
    getAll() { return window._cfm; },
    getStatus() {
      return {
        running: !!timer, cycle, lastMs, pollMs: POLL_MS,
        sources: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, { label: v.label, color: v.color, used: v.used, budget: v.budget, pct: Math.round((v.used / v.budget) * 100) }])),
        buffers: Object.fromEntries(PREDICTION_COINS.map(c => [c.sym, sampleBuf[c.sym]?.length || 0])),
      };
    },
  };

})();
