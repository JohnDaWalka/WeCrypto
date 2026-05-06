/**
 * coinmarketcap-pro-feed.js — CoinMarketCap Pro API Integration
 *
 * Provides real-time market data via CoinMarketCap Pro API:
 * - Latest quotes (price, market cap, volume, change %)
 * - Fear & Greed Index (macro sentiment)
 * - Global market metrics
 *
 * ★ TRIAL MODE (DEFAULT): Works WITHOUT API key — no user setup required!
 * ★ PRO MODE: Auto-upgrades when API key is provided for higher quota
 *
 * Trial Docs: https://pro-api.coinmarketcap.com/trial-pro-api
 * Pro Docs: https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest
 */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────
  const CMC_TRIAL_BASE_URL = 'https://pro-api.coinmarketcap.com/trial-pro-api';  // ★ No API key!
  const CMC_PRO_BASE_URL    = 'https://pro-api.coinmarketcap.com/v1';  // Requires API key
  const CMC_QUOTES_PATH     = '/cryptocurrency/quotes/latest';
  const CMC_GLOBAL_PATH     = '/global-metrics/quotes/latest';
  const CMC_FEAR_INDEX_PATH = '/fear-and-greed/latest';
  const CACHE_TTL_MS        = 5 * 60 * 1000;  // 5-min cache for live quotes
  const POLL_MS             = 60_000;  // 60-sec poll (anti-throttle)
  const cache               = {};   // sym → { price, marketCap, volume24h, change24h, ts }
  const globalMetrics       = {}; // { dominance, totalMarketCap, totalVolume24h, ts }
  const fearGreed           = {}; // { value, label, ts }

  // ── Credential helpers ──────────────────────────────────────────────────────
  function getApiKey()       { return localStorage.getItem('cmc_pro_api_key') || '8e6b728e402b4fdab69fa87aed758ab1'; }  // ★ Fallback to user-provided key
  function setApiKey(key)    { localStorage.setItem('cmc_pro_api_key', key); }
  function hasApiKey()       { return !!getApiKey(); }
  function getBaseUrl()      { return hasApiKey() ? CMC_PRO_BASE_URL : CMC_TRIAL_BASE_URL; }

  // ── Rate limiter (CMC Trial: ~30 req/min; Pro: 10K/month = ~14 req/min) ──────────────────
  let _lastRequestTime = 0;
  const REQUEST_MIN_GAP_MS = 2000; // ~30 req/min; safe for both modes

  async function _rateLimitedFetch(url, options) {
    const now = Date.now();
    const gap = now - _lastRequestTime;
    if (gap < REQUEST_MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, REQUEST_MIN_GAP_MS - gap));
    }
    _lastRequestTime = Date.now();
    return fetch(url, options);
  }

  // ── Latest quotes (multi-symbol) ────────────────────────────────────────────
  async function getLatestQuotes(symbols) {
    const apiKey = getApiKey();
    const symbolStr = Array.isArray(symbols) ? symbols.join(',') : symbols;
    const baseUrl = getBaseUrl();
    const isProMode = hasApiKey();

    try {
      // Trial uses /trial-pro-api/v1/... vs Pro uses /v1/... (both same path)
      const url = `${baseUrl}${CMC_QUOTES_PATH}?symbol=${encodeURIComponent(symbolStr)}&convert=USD`;
      
      // Try ProxyOrchestrator if available for deduplication and caching
      if (typeof window.ProxyOrchestrator !== 'undefined' && window._proxyOrchestrator) {
        try {
          const result = await window._proxyOrchestrator.fetch(url, {
            endpoint: 'cmc',
            cacheType: 'price-quotes',
            retries: 2,
            fallbackChain: ['cmc', 'pyth', 'cache'],
          });
          
          // Cache result in local cache for backwards compatibility
          if (result && result.data) {
            Object.entries(result.data).forEach(([sym, data]) => {
              const usd = data.quote?.USD || {};
              cache[sym] = {
                price: usd.price || 0,
                marketCap: usd.market_cap || 0,
                volume24h: usd.volume_24h || 0,
                change24h: usd.percent_change_24h || 0,
                ts: Date.now()
              };
            });
          }
          
          console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes via proxy: ${Object.keys(result?.data || {}).length} coins ✓`);
          return result?.data || {};
        } catch (err) {
          console.warn(`[CMC] ProxyOrchestrator failed, falling back:`, err.message);
        }
      }

      // Fallback: direct fetch with rate limiting
      const headers = { 'Accept': 'application/json' };
      if (isProMode) headers['X-CMC_PRO_API_KEY'] = apiKey;

      const resp = await _rateLimitedFetch(url, { method: 'GET', headers });

      if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes (${resp.status}):`, err.slice(0, 100));
        return {};
      }

      const json = await resp.json();
      if (!json.data) return {};

      const result = {};
      Object.entries(json.data).forEach(([sym, data]) => {
        const usd = data.quote?.USD || {};
        result[sym] = {
          price: usd.price || 0,
          marketCap: usd.market_cap || 0,
          volume24h: usd.volume_24h || 0,
          change24h: usd.percent_change_24h || 0,
          ts: Date.now()
        };
        cache[sym] = result[sym];
      });

      console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes: ${Object.keys(result).length} coins ✓`);
      return result;
    } catch (e) {
      console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes error:`, e.message);
      return {};
    }
  }

  // ── Global market metrics ────────────────────────────────────────────────────
  async function getGlobalMetrics() {
    const baseUrl = getBaseUrl();
    const isProMode = hasApiKey();
    const apiKey = getApiKey();

    try {
      const url = `${baseUrl}${CMC_GLOBAL_PATH}?convert=USD`;
      const headers = { 'Accept': 'application/json' };
      if (isProMode) headers['X-CMC_PRO_API_KEY'] = apiKey;

      const resp = await _rateLimitedFetch(url, { method: 'GET', headers });

      if (!resp.ok) {
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics (${resp.status})`);
        return globalMetrics;
      }

      const json = await resp.json();
      if (!json.data) return globalMetrics;

      const data = json.data;
      globalMetrics.totalMarketCap = data.quote?.USD?.total_market_cap || 0;
      globalMetrics.totalVolume24h = data.quote?.USD?.total_volume_24h || 0;
      globalMetrics.btcDominance = data.btc_dominance || 0;
      globalMetrics.cryptoCount = data.active_cryptocurrencies || 0;
      globalMetrics.ts = Date.now();

      console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics (BTC dom: ${globalMetrics.btcDominance.toFixed(1)}%) ✓`);
      return globalMetrics;
    } catch (e) {
      console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics error:`, e.message);
      return globalMetrics;
    }
  }

  // ── Fear & Greed Index ────────────────────────────────────────────────────
  async function getFearGreedIndex() {
    const baseUrl = getBaseUrl();
    const isProMode = hasApiKey();
    const apiKey = getApiKey();

    try {
      // Both trial and pro use /fear-and-greed/latest
      const url = `${baseUrl}${CMC_FEAR_INDEX_PATH}`;
      const headers = { 'Accept': 'application/json' };
      if (isProMode) headers['X-CMC_PRO_API_KEY'] = apiKey;

      const resp = await _rateLimitedFetch(url, { method: 'GET', headers });

      if (!resp.ok) {
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] F&G (${resp.status})`);
        return fearGreed;
      }

      const json = await resp.json();
      if (!json.data) return fearGreed;

      const data = Array.isArray(json.data) ? json.data[0] : json.data;
      fearGreed.value = data.value || null;
      fearGreed.label = data.value_classification || 'N/A';
      fearGreed.ts = Date.now();

      console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] F&G: ${fearGreed.value} (${fearGreed.label}) ✓`);
      return fearGreed;
    } catch (e) {
      console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] F&G error:`, e.message);
      return fearGreed;
    }
  }

  // ── Cached quote accessor ──────────────────────────────────────────────────────
  function getCachedQuote(symbol) {
    const cached = cache[symbol];
    if (!cached) return null;
    const age = Date.now() - cached.ts;
    if (age > CACHE_TTL_MS) return null;
    return cached;
  }

  // ── Poll handler (auto-refresh on interval) ──────────────────────────────────
  let _pollTimer = null;

  function startPolling(symbols, interval = POLL_MS) {
    if (_pollTimer) return;
    const pollFn = async () => {
      const mode = hasApiKey() ? 'Pro' : 'Trial';
      console.debug(`[CMC ${mode}] Poll (${symbols.length} coins)…`);
      await getLatestQuotes(symbols);
      await getGlobalMetrics();
      await getFearGreedIndex();
    };
    pollFn().catch(e => console.warn('[CMC] Poll init failed:', e.message));
    _pollTimer = setInterval(pollFn, interval);
    console.info(`[CMC ${hasApiKey() ? 'Pro' : 'Trial'}] Polling: ${interval}ms (${symbols.length} coins)`);
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      console.info('[CMC] Polling stopped');
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window._cmcProFeed = {
    setApiKey,
    getApiKey,
    hasApiKey,
    getLatestQuotes,
    getGlobalMetrics,
    getFearGreedIndex,
    getCachedQuote,
    startPolling,
    stopPolling,
    cache: () => cache,
    globalMetrics: () => globalMetrics,
    fearGreed: () => fearGreed
  };

  console.info(`[CMC] Stack initialized: ${hasApiKey() ? '✓ Pro mode' : '✓ Trial mode (keyless)'}`);
})();
