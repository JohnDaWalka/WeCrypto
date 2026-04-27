// tauri-bridge.js — WE|||CRYPTO Proxy Bridge v3
// Routes all API calls through we-crypto-proxy (CORS + header spoofing)
// Works in both Tauri (sidecar proxy) and Electron (main.js spawns proxy) modes

(function () {
  'use strict';

  // ── Port discovery ───────────────────────────────────────────────────────────
  let _proxyPort = 3010;
  let _initPromise = null;

  async function _init() {
    // 1. Try Tauri invoke to get the port the sidecar is on
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
      try {
        const port = await invoke('get_proxy_port');
        if (port && port > 0) {
          _proxyPort = port;
          console.log(`[BRIDGE] Tauri sidecar proxy on :${port}`);
          return;
        }
      } catch (_) { /* fall through */ }
    }

    // 2. Poll /health on the default cascade
    for (const tryPort of [3010, 3011, 3012, 3013, 3014, 3015]) {
      try {
        const r = await fetch(`http://127.0.0.1:${tryPort}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok) {
          const d = await fetch(`http://127.0.0.1:${tryPort}/port`).then(r => r.json()).catch(() => ({ port: tryPort }));
          _proxyPort = d.port || tryPort;
          console.log(`[BRIDGE] proxy discovered on :${_proxyPort}`);
          return;
        }
      } catch (_) { /* try next */ }
    }
    console.warn(`[BRIDGE] proxy not found, using default :${_proxyPort}`);
  }

  function initOnce() {
    if (!_initPromise) _initPromise = _init();
    return _initPromise;
  }

  // ── Host → exchange slug map ─────────────────────────────────────────────────
  const HOST_MAP = {
    'api.binance.us':                  'binance',
    'fapi.binance.com':                'binance-f',
    'api.bybit.com':                   'bybit',
    'www.okx.com':                     'okx',
    'api.kraken.com':                  'kraken',
    'api.coinbase.com':                'coinbase',
    'api.exchange.coinbase.com':       'coinbase-ex',
    'api.mexc.com':                    'mexc',
    'api.kucoin.com':                  'kucoin',
    'api-pub.bitfinex.com':            'bitfinex',
    'api.crypto.com':                  'crypto-com',
    'api.coingecko.com':               'coingecko',
    'api.dexscreener.com':             'dexscreener',
    'api.elections.kalshi.com':        'kalshi',
    'gamma-api.polymarket.com':        'polymarket',
    'clob.polymarket.com':             'polymarket-clob',
    'api.etherscan.io':                'etherscan',
    'api.bscscan.com':                 'bscscan',
    'eth.blockscout.com':              'blockscout-eth',
    'bsc.blockscout.com':              'blockscout-bsc',
    'api.blockchair.com':              'blockchair',
    'api.blockcypher.com':             'blockcypher',
    'mempool.space':                   'mempool',
    'api.hyperliquid.xyz':             'hyperliquid',
    'hypurrscan.io':                   'hypurrscan',
    'api.mainnet-beta.solana.com':     'solana',
    's2.ripple.com':                   'ripple',
    'xrplcluster.com':                 'xrpl',
  };

  function _buildProxyUrl(originalUrl) {
    try {
      const u = new URL(originalUrl);
      const slug = HOST_MAP[u.hostname];
      if (slug) {
        return `http://127.0.0.1:${_proxyPort}/${slug}${u.pathname}${u.search}`;
      }
      // Unknown host — use direct ?url= proxy
      if (u.protocol === 'https:') {
        return `http://127.0.0.1:${_proxyPort}/proxy?url=${encodeURIComponent(originalUrl)}`;
      }
    } catch (_) {}
    return originalUrl; // not a valid URL or already local
  }

  // ── Core fetch ───────────────────────────────────────────────────────────────
  window.proxyFetch = async function (url, options = {}) {
    await initOnce();
    const proxied = _buildProxyUrl(url);
    return fetch(proxied, {
      method:  options.method  || 'GET',
      headers: options.headers || {},
      body:    options.body
        ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
        : undefined,
    });
  };

  // ── Legacy compat ────────────────────────────────────────────────────────────
  window.bouncerFetch = async function (category, url, options = {}) {
    const r = await window.proxyFetch(url, options);
    return r.text();
  };

  window.priceFetch  = (url, opts) => window.proxyFetch(url, opts);
  window.binaryFetch = (url, opts) => window.proxyFetch(url, opts);
  window.suppFetch   = (url, opts) => window.proxyFetch(url, opts);

  // Auto-init on load
  initOnce();
  console.log('[BRIDGE] WE|||CRYPTO proxy bridge v3 loaded');
})();
