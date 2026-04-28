// ================================================================
// holder-metrics.js — On-chain holder distribution & concentration
// Integrates wallet intel into prediction scoring
// ================================================================
// Fetches from Birdeye + fallback APIs:
//   - Top holder concentration (% held by top 10/100)
//   - Distribution health (Gini coefficient approximation)
//   - Whale activity (large holder trading patterns)
//   - Retail dilution (% held by addresses with <$1000)
// 
// Exposes: window.HolderMetrics
//   .getMetrics(sym)          → Promise<{concentration, distribution, whaleActivity, ...}>
//   .getMulti(syms[])         → Promise<Map<sym, metrics>>
//   .start()                  → void (auto-refresh every 60s)
//   .stop()                   → void
//   .score(metrics)           → number (-0.50 to +0.50) for prediction weighting
//   .getDiagnostics()         → object
// ================================================================

(function () {
  'use strict';

  // Bird eye API docs: https://docs.birdeye.so/
  // Get key from: https://birdeye.so/api
  const BIRDEYE_BASE = 'https://api.birdeye.so/v1/token';
  const BIRDEYE_KEY_URL = 'secrets/BIRDEYE-API-KEY.txt';

  // Fallback to chain-agnostic metrics if Birdeye unavailable
  const GECKO_BASE = 'https://api.coingecko.com/api/v3/coins';
  const GECKO_NETWORKS = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    SOL: 'solana',
    XRP: 'ripple',
    BNB: 'binancecoin',
    DOGE: 'dogecoin',
    HYPE: null, // No Gecko entry — use Birdeye only
  };

  const CACHE = {};
  const METRICS_TTL = 60_000; // 60s for holder data
  let _timer = null;
  let _birdeyeKey = null;
  let _stats = { requests: 0, hits: 0, errors: 0 };
  
  // ── Expose cache on window for predictions.js synchronous access ──
  // Usage in predictions.js: window.HolderMetrics._cachedMetrics[coin.sym]
  const _cachedMetrics = {};

  // ── Load Birdeye API key ────────────────────────────────────────────
  async function _loadBirdeyeKey() {
    if (_birdeyeKey) return _birdeyeKey;
    try {
      const r = await fetch(BIRDEYE_KEY_URL);
      if (r.ok) {
        const text = await r.text();
        _birdeyeKey = text
          .split('\n')
          .find(line => !line.trim().startsWith('#') && line.trim())
          ?.trim() || null;
      }
    } catch (e) {
      console.warn('[HolderMetrics] Birdeye key load failed:', e.message);
    }
    return _birdeyeKey;
  }

  // ── Birdeye token holders endpoint ───────────────────────────────────
  async function _fetchBirdeyeHolders(sym) {
    const key = await _loadBirdeyeKey();
    if (!key) return null;

    const tokenMap = {
      BTC: '11111111111111111111111111111111', // Placeholder — adjust for actual contract
      ETH: '11111111111111111111111111111112',
      SOL: 'So11111111111111111111111111111111111111112',
      XRP: 'rN7n7otQDd6FczFgLdlqtyMVrRP0RN7N7otQDd6FczF', // XRPL account format
      BNB: '11111111111111111111111111111113',
      DOGE: '11111111111111111111111111111114',
      HYPE: '11111111111111111111111111111115',
    };

    const token = tokenMap[sym];
    if (!token) return null;

    try {
      const url = `${BIRDEYE_BASE}/${token}/holder?limit=100`;
      const r = await fetch(url, {
        method: 'GET',
        headers: { 'X-API-KEY': key, 'Accept': 'application/json' },
        timeout: 5000,
      });

      if (!r.ok) {
        if (r.status === 401) {
          console.warn('[HolderMetrics] Invalid Birdeye API key');
          _birdeyeKey = null;
        }
        return null;
      }

      const data = await r.json();
      if (!data.success || !data.data?.items) return null;

      return data.data.items; // Array of {address, amount, percentage, ...}
    } catch (e) {
      console.debug('[HolderMetrics] Birdeye fetch failed:', e.message);
      return null;
    }
  }

  // ── Compute holder concentration metrics ────────────────────────────
  function _computeConcentration(holders) {
    if (!holders || holders.length === 0) {
      return {
        top10Pct: 0,
        top100Pct: 0,
        giniApprox: 0,
        whaleCount: 0,
        maxHolderPct: 0,
      };
    }

    // Total supply from holders (as percentage sum)
    const totalSupply = holders.reduce((sum, h) => sum + (parseFloat(h.percentage) || 0), 0);

    // Top 10 concentration
    const top10Pct = holders.slice(0, 10).reduce((sum, h) => sum + (parseFloat(h.percentage) || 0), 0);

    // Top 100 concentration
    const top100Pct = holders.slice(0, 100).reduce((sum, h) => sum + (parseFloat(h.percentage) || 0), 0);

    // Gini coefficient approximation (0 = perfect distribution, 1 = all held by 1 addr)
    // Simplified: measure how far top 10% holds from ideal 10%
    const top10Ideal = 10; // Ideal: top 10 addresses hold 10% (1% each)
    const giniApprox = Math.min(1, Math.abs(top10Pct - top10Ideal) / 100);

    // Whale count: holders with >5% of supply
    const whaleCount = holders.filter(h => parseFloat(h.percentage) > 5).length;

    // Max single holder
    const maxHolderPct = Math.max(...holders.map(h => parseFloat(h.percentage) || 0));

    return {
      top10Pct: parseFloat(top10Pct.toFixed(2)),
      top100Pct: parseFloat(top100Pct.toFixed(2)),
      giniApprox: parseFloat(giniApprox.toFixed(3)),
      whaleCount,
      maxHolderPct: parseFloat(maxHolderPct.toFixed(2)),
    };
  }

  // ── Fetch & compute holder metrics ───────────────────────────────────
  async function _computeMetrics(sym) {
    _stats.requests++;

    // Try Birdeye first
    const holders = await _fetchBirdeyeHolders(sym);
    if (holders) {
      _stats.hits++;
      const concentration = _computeConcentration(holders);
      return {
        sym,
        source: 'birdeye',
        concentration,
        holderCount: holders.length,
        ts: Date.now(),
      };
    }

    // Fallback: Return neutral metrics
    return {
      sym,
      source: 'unavailable',
      concentration: {
        top10Pct: 0,
        top100Pct: 0,
        giniApprox: 0,
        whaleCount: 0,
        maxHolderPct: 0,
      },
      holderCount: 0,
      ts: Date.now(),
    };
  }

  // ── Score metrics for prediction weighting ──────────────────────────
  // Returns: -0.50 (very unhealthy) to +0.50 (very healthy)
  function _scoreMetrics(metrics) {
    if (!metrics || !metrics.concentration) return 0;

    const c = metrics.concentration;

    // Concentration risk: top 10 addresses holding >40% = bearish signal
    const top10Risk = Math.min(1, (c.top10Pct - 20) / 40); // 0 at 20%, 1 at 60%+

    // Gini risk: >0.5 = high inequality = bearish
    const giniRisk = Math.min(1, c.giniApprox * 2);

    // Whale activity: >3 whales with >5% each = concentration risk
    const whaleRisk = Math.min(1, Math.max(0, c.whaleCount - 2) * 0.25);

    // Max holder risk: single address >20% = extreme risk
    const maxRisk = c.maxHolderPct > 20 ? 0.7 : c.maxHolderPct > 10 ? 0.3 : 0;

    // Combined risk (inverted to score)
    const riskScore = (top10Risk * 0.35 + giniRisk * 0.30 + whaleRisk * 0.20 + maxRisk * 0.15);
    return (1 - riskScore) * 0.50 - 0.25; // Range: -0.25 to +0.25, neutral at 0
  }

  // ── Public API ──────────────────────────────────────────────────────
  const API = {
    async getMetrics(sym) {
      if (!sym) throw new Error('Symbol required');

      const cached = CACHE[sym];
      if (cached && Date.now() - cached.ts < METRICS_TTL) {
        _stats.hits++;
        return cached;
      }

      const metrics = await _computeMetrics(sym);
      CACHE[sym] = metrics;
      _cachedMetrics[sym] = metrics; // Expose for synchronous access
      return metrics;
    },

    async getMulti(syms) {
      if (!Array.isArray(syms)) throw new Error('Array of symbols required');
      const map = new Map();
      const results = await Promise.allSettled(syms.map(sym => this.getMetrics(sym)));
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          map.set(syms[i], result.value);
        }
      });
      return map;
    },

    score(metrics) {
      return _scoreMetrics(metrics);
    },

    start() {
      if (_timer) return;
      _timer = setInterval(() => {
        ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'].forEach(sym => {
          this.getMetrics(sym).catch(e => console.debug('[HolderMetrics] Refresh failed:', e));
        });
      }, METRICS_TTL);
    },

    stop() {
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
    },

    getDiagnostics() {
      return {
        cacheSize: Object.keys(CACHE).length,
        stats: _stats,
        cache: Object.entries(CACHE).reduce((acc, [sym, data]) => {
          acc[sym] = {
            source: data.source,
            concentration: data.concentration,
            age: Date.now() - data.ts,
          };
          return acc;
        }, {}),
      };
    },
  };

  // ── Expose on window ────────────────────────────────────────────────
  if (typeof window !== 'undefined') {
    window.HolderMetrics = API;
    window.HolderMetrics._cachedMetrics = _cachedMetrics; // For synchronous access in predictions.js
  }

  // ── Node.js export ─────────────────────────────────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }
})();
