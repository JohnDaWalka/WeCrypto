// resilient-fetch.js — Network resilience layer with retry + fallback
// Wraps throttledFetch to add:
// - Automatic retry (3 attempts) with exponential backoff
// - Fallback URLs for known APIs
// - Error logging to COPILOT_DEBUG
// - Graceful degradation (doesn't break on network failures)
//
// Loaded AFTER throttled-fetch.js so it wraps both throttled and direct fetch calls.

(function () {
  'use strict';

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 500;

  // Fallback URLs for APIs that fail frequently
  const FALLBACK_URLS = {
    // Bybit → fallback to Binance for spot trades
    'api.bybit.com/v5/market/recent-trade': [
      // Original
      url => url,
      // Fallback 1: Try Binance spot
      url => url.replace(/api\.bybit\.com\/v5\/market\/recent-trade\?category=spot&symbol=(.+?)USDT/, 
                        'api.binance.us/api/v3/trades?symbol=$1USDT'),
    ],
    // Blockscout gas → fallback to etherscan
    'eth.blockscout.com/api/v2/gas-price-oracle': [
      url => url,
      () => 'https://api.etherscan.io/api?module=gastracker&action=gasPriceOracle',
    ],
    // Mempool → fallback to blockchain.info
    'mempool.space/api/fees/recommended': [
      url => url,
      () => 'https://api.blockchain.info/mempool/fees',
    ],
  };

  function getFallbackUrls(url) {
    for (const [pattern, fallbacks] of Object.entries(FALLBACK_URLS)) {
      if (url.includes(pattern)) {
        return fallbacks;
      }
    }
    return [url]; // No fallback — just return original
  }

  async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // Try a single URL with one retry loop
  async function tryUrl(url, attemptNum = 0) {
    try {
      const res = await window.throttledFetch(url);
      if (res.ok || res.status < 500) return res; // Accept 2xx, 3xx, 4xx; retry on 5xx

      // 5xx → retry
      if (attemptNum < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attemptNum);
        await sleep(delay);
        return tryUrl(url, attemptNum + 1);
      }
      return res; // Return error response after all retries exhausted
    } catch (err) {
      if (attemptNum < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attemptNum);
        console.warn(`[ResilientFetch] Retry attempt ${attemptNum + 1} for ${url.slice(0, 60)}`);
        await sleep(delay);
        return tryUrl(url, attemptNum + 1);
      }
      throw err; // Throw after all retries
    }
  }

  // Try all fallback URLs in sequence until one works
  async function tryFallbacks(fallbackUrls) {
    let lastError = null;

    for (let i = 0; i < fallbackUrls.length; i++) {
      const getUrl = fallbackUrls[i];
      const url = typeof getUrl === 'function' ? getUrl() : getUrl;

      try {
        const res = await tryUrl(url);
        if (res.ok) {
          if (i > 0) {
            console.info(`[ResilientFetch] Fallback #${i} succeeded: ${url.slice(0, 60)}`);
          }
          return res;
        }
        // Non-ok response — remember and try next fallback
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err.message;
        // Continue to next fallback
      }
    }

    // All fallbacks failed — throw last error
    throw new Error(`All fallback URLs failed. Last error: ${lastError}`);
  }

  // Main resilient fetch
  async function resilientFetch(url, options = {}) {
    const fallbackUrls = getFallbackUrls(url);

    try {
      return await tryFallbacks(fallbackUrls);
    } catch (err) {
      console.error(
        `[ResilientFetch] FAILED: ${url.slice(0, 80)} → ${err.message}`
      );

      // Log to COPILOT_DEBUG via IPC if available
      if (window.desktopApp?.networkError) {
        try {
          await window.desktopApp.networkError(
            'NETWORK_ERROR',
            `${url.slice(0, 100)} | ${err.message}`
          );
        } catch (_) {
          // IPC not available or failed — continue anyway
        }
      }

      throw err;
    }
  }

  // Export as window.resilientFetch; callers can choose between throttled and resilient
  window.resilientFetch = resilientFetch;

  console.info(
    `[ResilientFetch] v1.0 ready — ${MAX_RETRIES} retries, ${Object.keys(FALLBACK_URLS).length} known fallbacks`
  );
})();
