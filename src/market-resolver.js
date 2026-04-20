// ================================================================
// WE|||CRYPTO — 15M Market Resolver v1
//
// Watches active Kalshi 15M market snapshots before expiry.
// After close_time passes, polls Kalshi for the settled result.
// Polymarket: resolved state detected via outcomePrices reaching 0/1.
//
// Writes:
//   window._15mResolutionLog — array of settled market outcomes
//   window._resolutionMap    — sym → latest resolution (quick lookup)
//
// Dispatches:
//   CustomEvent 'market15m:resolved' — { sym, outcome, modelCorrect, prob, pctMove }
//
// Used by:
//   signal-router-cfm.js → buildOutcomeCalibration()
//     Kalshi settlement data is 1.5× weighted vs candle log —
//     it is a clean external binary oracle, not intra-bar noise.
//
// Load order: after prediction-markets.js, before app.js
// ================================================================

(function () {
  'use strict';

  const KALSHI_BASE    = 'https://api.elections.kalshi.com/trade-api/v2';
  const POLY_GAMMA     = 'https://gamma-api.polymarket.com';
  const CB_BASE        = 'https://api.exchange.coinbase.com';

  // Coinbase product IDs — CF Benchmarks uses Coinbase prices for Kalshi settlement
  const CB_PRODUCTS = {
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
    XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD',
  };

  const LOG_MAX        = 300;   // max entries in _15mResolutionLog
  const SETTLE_GRACE   = 120_000; // 2 min after close_time before we poll
  const POLL_INTERVAL  = 60_000;  // poll for settlements every 60s
  const MAX_PENDING    = 50;      // max pending snapshots queued at once
  const PERSIST_KEY    = 'beta1_15m_resolution_log';

  // ── State ────────────────────────────────────────────────────────
  // Pending: markets we've snapshotted and are waiting to settle
  // Structure: { sym, ticker, type, snapshotTs, closeTimeMs, entryProb, modelDir }
  const _pending   = new Map();   // ticker → pending entry
  let   _pollTimer = null;

  // Initialise global stores
  window._15mResolutionLog = window._15mResolutionLog || [];
  window._resolutionMap    = window._resolutionMap    || {};

  // Restore persisted log
  try {
    const saved = localStorage.getItem(PERSIST_KEY);
    if (saved) window._15mResolutionLog = JSON.parse(saved);
  } catch (_) {}

  function saveLog() {
    try {
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify(window._15mResolutionLog.slice(-LOG_MAX))
      );
    } catch (_) {}
  }

  // ── Fetch helpers ────────────────────────────────────────────────
  function fetchWithTimeout(url, ms = 7000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal })
      .then(r => { clearTimeout(tid); return r; })
      .catch(e => { clearTimeout(tid); throw e; });
  }

  async function kalshiFetch(url) {
    try {
      const r = await fetchWithTimeout(url);
      if (!r.ok) return null;
      return r.json();
    } catch { return null; }
  }

  // ── Coinbase settlement price ────────────────────────────────────
  // Fetches the 1-min candle that covers the Kalshi close_time.
  // CF Benchmarks = 60-second avg at T+15 → we want the close of the
  // candle whose open is at closeTimeMs-60s.
  async function fetchCoinbaseSettlement(sym, closeTimeMs) {
    const product = CB_PRODUCTS[sym];
    if (!product) return null;
    // Fetch a 2-candle window centred on close_time
    const endSec   = Math.ceil(closeTimeMs / 1000) + 5;
    const startSec = endSec - 180;
    try {
      const url = `${CB_BASE}/products/${product}/candles?start=${startSec}&end=${endSec}&granularity=60`;
      const r   = await fetchWithTimeout(url, 8000);
      if (!r.ok) return null;
      const candles = await r.json();
      if (!Array.isArray(candles) || !candles.length) return null;
      // candles: [[time, low, high, open, close, volume], ...] descending
      // Find candle whose close_time (time+60s) is at or just after closeTimeMs
      const target = candles
        .map(c => ({ timeMs: c[0] * 1000, close: parseFloat(c[4]) }))
        .filter(c => c.timeMs <= closeTimeMs + 5_000)
        .sort((a, b) => b.timeMs - a.timeMs)[0];
      return target ? target.close : null;
    } catch { return null; }
  }

  // ── 1. SNAPSHOT CAPTURE ─────────────────────────────────────────
  // Called on 'predictionmarketsready'. Captures active 15M markets
  // as pending resolutions — we need to know what was predicted NOW
  // so we can evaluate correctness when the market settles.

  function captureSnapshot(pmData) {
    const now = Date.now();

    for (const [sym, coin] of Object.entries(pmData || {})) {
      const k15 = coin?.kalshi15m;
      if (!k15?.ticker || !k15?.closeTime) continue;

      const closeMs = new Date(k15.closeTime).getTime();
      // Skip markets already closed or closing within 90s (too late to track)
      if (closeMs < now + 90_000) continue;
      // Skip if already in pending
      if (_pending.has(k15.ticker)) continue;
      // Trim if too many pending
      if (_pending.size >= MAX_PENDING) {
        const oldest = [..._pending.entries()]
          .sort((a, b) => a[1].snapshotTs - b[1].snapshotTs)[0];
        if (oldest) _pending.delete(oldest[0]);
      }

      // Capture what the model currently predicts for this coin
      const pred      = window._lastPrediction?.[sym];
      const modelDir  = pred?.direction ?? null;
      const entryProb = k15.probability ?? null;

      _pending.set(k15.ticker, {
        sym,
        ticker:      k15.ticker,
        type:        '15m',
        snapshotTs:  now,
        closeTimeMs: closeMs,
        entryProb,
        modelDir,
        title:       k15.title ?? null,
        targetPrice: k15.targetPriceNum ?? null,
        // Snapshot EV data from orchestrator at the moment of prediction
        edgeCents:            window.KalshiOrchestrator?.getIntent?.(sym)?.edgeCents   ?? null,
        entryPrice:           window.KalshiOrchestrator?.getIntent?.(sym)?.entryPrice  ?? null,
        side:                 window.KalshiOrchestrator?.getIntent?.(sym)?.side        ?? null,
        modelProbUp:          window.KalshiOrchestrator?.getIntent?.(sym)?.modelProbUp ?? null,
        // Capture action+alignment so we can detect missed opportunities at settlement
        orchestratorAction:   window.KalshiOrchestrator?.getIntent?.(sym)?.action      ?? null,
        orchestratorAlign:    window.KalshiOrchestrator?.getIntent?.(sym)?.alignment   ?? null,
      });
    }
  }

  // ── 2. RESOLUTION POLLER ─────────────────────────────────────────
  // Checks pending markets. For those past close_time + grace, fetches
  // the Kalshi market to check settlement.

  async function checkPending() {
    const now = Date.now();
    const expired = [..._pending.values()]
      .filter(e => now >= e.closeTimeMs + SETTLE_GRACE);

    for (const entry of expired) {
      const settled = await resolveKalshiMarket(entry);
      if (settled) {
        _pending.delete(entry.ticker);
        recordResolution(settled);
      } else {
        // If the market isn't settled yet, wait one more cycle.
        // After 10 min past close_time, drop from pending (stale).
        if (now - entry.closeTimeMs > 10 * 60_000) {
          _pending.delete(entry.ticker);
        }
      }
    }
  }

  // ── 3. KALSHI SETTLEMENT FETCH ───────────────────────────────────
  // Returns a resolution record or null if not yet settled.

  async function resolveKalshiMarket(entry) {
    const d = await kalshiFetch(`${KALSHI_BASE}/markets/${entry.ticker}`);
    const m = d?.market;
    if (!m) return null;

    // Only process settled markets with a definitive result
    if (m.status !== 'settled' || !m.result) return null;

    // result: 'yes' → price closed ABOVE reference → UP
    // result: 'no'  → price closed BELOW reference → DOWN
    const actualOutcome = m.result === 'yes' ? 'UP' : 'DOWN';
    const entryProb     = entry.entryProb ?? 0.5;
    const marketDir     = entryProb >= 0.50 ? 'UP' : 'DOWN';
    const modelDir      = entry.modelDir;

    const modelCorrect  = modelDir && modelDir !== 'FLAT'
      ? modelDir === actualOutcome
      : null;
    const marketCorrect = marketDir === actualOutcome;

    // Fetch actual Coinbase settlement price (CF Benchmarks source)
    const cbSettlePrice = await fetchCoinbaseSettlement(entry.sym, entry.closeTimeMs);

    return {
      sym:           entry.sym,
      ticker:        entry.ticker,
      type:          '15m',
      snapshotTs:    entry.snapshotTs,
      closeTimeMs:   entry.closeTimeMs,
      settledTs:     Date.now(),
      entryProb,
      marketDir,
      actualOutcome,
      refPrice:        entry.targetPrice ?? null,
      cbSettlePrice,                          // actual Coinbase price at settlement
      modelDir:        modelDir ?? null,
      modelCorrect,
      marketCorrect,
      correct:         modelCorrect,
      // EV data captured at snapshot time — used by equity curve
      edgeCents:       entry.edgeCents          ?? null,
      entryPrice:      entry.entryPrice         ?? null,
      side:            entry.side               ?? null,
      modelProbUp:     entry.modelProbUp        ?? null,
      // Orchestrator decision at prediction time
      orchestratorAction: entry.orchestratorAction ?? null,
      orchestratorAlign:  entry.orchestratorAlign  ?? null,
      // Missed opportunity: model was correct but orchestrator passed
      missedOpportunity: (
        modelCorrect === true &&
        (entry.orchestratorAction === 'skip' || entry.orchestratorAction === 'watch')
      ) ? {
        action:    entry.orchestratorAction,
        alignment: entry.orchestratorAlign ?? null,
        edgeCents: entry.edgeCents ?? null,
      } : null,
    };
  }

  // ── 4. RECORD + DISPATCH ─────────────────────────────────────────

  function recordResolution(res) {
    window._15mResolutionLog.push(res);
    if (window._15mResolutionLog.length > LOG_MAX) {
      window._15mResolutionLog.shift();
    }
    // Quick lookup by coin
    window._resolutionMap[res.sym] = res;
    saveLog();

    // Notify the app (UI can show toast, update accuracy badge)
    try {
      window.dispatchEvent(new CustomEvent('market15m:resolved', {
        detail: {
          sym:           res.sym,
          outcome:       res.actualOutcome,
          modelCorrect:  res.modelCorrect,
          marketCorrect: res.marketCorrect,
          prob:          res.entryProb,
          ticker:        res.ticker,
        },
      }));
    } catch (_) {}

    const icon = res.modelCorrect === true  ? '\u2705'
               : res.modelCorrect === false ? '\u274c'
               : '\u2753';
    console.log(
      `[Resolver] ${res.sym} 15M settled ${res.actualOutcome} ` +
      `| model:${res.modelDir ?? 'N/A'} ${icon} ` +
      `| mktProb:${(res.entryProb * 100).toFixed(0)}% ` +
      `| mkCorrect:${res.marketCorrect}`
    );
  }

  // ── 5. ACCURACY SUMMARY ──────────────────────────────────────────
  // Returns a per-coin summary from the resolution log.
  // Used by signal-router-cfm.js and optionally the UI.

  function getResolutionAccuracy(sym, n = 30) {
    const log = (window._15mResolutionLog || [])
      .filter(e => e.sym === sym && e.modelCorrect !== null);
    const recent = log.slice(-n);
    if (recent.length < 2) return null;

    const correct = recent.filter(e => e.modelCorrect).length;
    const accuracy = correct / recent.length;

    // Trend: last 8 vs prior 8
    const last8  = recent.slice(-8);
    const prior8 = recent.slice(-16, -8);
    const l8acc  = last8.length  ? last8.filter(e => e.modelCorrect).length  / last8.length  : accuracy;
    const p8acc  = prior8.length ? prior8.filter(e => e.modelCorrect).length / prior8.length : accuracy;

    // Streak
    let streak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const ok = recent[i].modelCorrect;
      if (streak === 0) { streak = ok ? 1 : -1; continue; }
      if ((streak > 0) === ok) streak += ok ? 1 : -1;
      else break;
    }

    return {
      accuracy,
      correct,
      total: recent.length,
      streak,
      trend: (l8acc - p8acc) > 0.10 ? 'improving' : (l8acc - p8acc) < -0.10 ? 'declining' : 'stable',
      // Calibration multiplier for CFM: market-settled data is clean
      // accuracy 35% → 0.78x  |  50% → 1.0x  |  70% → 1.18x
      calibMultiplier: Math.max(0.76, Math.min(1.22, 0.76 + accuracy * 0.92)),
    };
  }

  // ── 6. START ─────────────────────────────────────────────────────

  function start() {
    // Listen for new market data — capture snapshots
    window.addEventListener('predictionmarketsready', e => {
      captureSnapshot(e.detail || {});
    });

    // Poll every 60s for settlements
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      if (!document.hidden) checkPending();
    }, POLL_INTERVAL);

    // Also do an immediate pass in case of app restart with stale pending
    setTimeout(checkPending, 5000);

    console.log('[Resolver] 15M market resolver started');
  }

  // ── PUBLIC API ───────────────────────────────────────────────────
  window.MarketResolver = {
    start,
    getPending:           () => [..._pending.values()],
    getLog:               () => window._15mResolutionLog,
    getResolutionAccuracy,
    getLatest:            sym => window._resolutionMap[sym] ?? null,
    // Called by signal-router-cfm.js for CFM calibration
    buildCalibration(sym, n = 30) {
      return getResolutionAccuracy(sym, n);
    },
    // Returns entries where model was correct but orchestrator said skip/watch
    getMissedOpps(n = 50) {
      return (window._15mResolutionLog || [])
        .filter(e => e.missedOpportunity != null)
        .slice(-n);
    },
    // Win rate analysis by edge bucket — reveals the safe buffer zone threshold
    getBufferZones(n = 100) {
      const log = (window._15mResolutionLog || [])
        .filter(e => e.edgeCents != null && e.modelCorrect !== null)
        .slice(-n);
      const buckets = [
        { label: 'Neg edge',  min: -Infinity, max: 0  },
        { label: '0–5¢',      min: 0,         max: 5  },
        { label: '5–10¢',     min: 5,         max: 10 },
        { label: '10–20¢',    min: 10,        max: 20 },
        { label: '20–30¢',    min: 20,        max: 30 },
        { label: '30¢+',      min: 30,        max: Infinity },
      ];
      return buckets.map(b => {
        const entries = log.filter(e => e.edgeCents >= b.min && e.edgeCents < b.max);
        const wins    = entries.filter(e => e.modelCorrect);
        return {
          label:   b.label,
          trades:  entries.length,
          wins:    wins.length,
          winRate: entries.length ? +(wins.length / entries.length * 100).toFixed(1) : null,
          avgEdge: entries.length ? +(entries.reduce((s, e) => s + e.edgeCents, 0) / entries.length).toFixed(1) : null,
        };
      });
    },
  };

})();
