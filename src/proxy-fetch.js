// ================================================================
// WE CFM ALPHA-1.3 — Smart Proxy Shim
//
// CORS is just a browser bouncer with a clipboard — it only fires
// when the browser asks. Electron (webSecurity:false) already
// dismissed that bouncer. The proxy's REAL job is server-side:
//
//  BUCKET A — CF_PROTECTED   : Cloudflare Bot Mgmt / 403 without
//                               Chrome TLS fingerprint → ALWAYS proxy
//  BUCKET B — RATE_LIMITED   : Public APIs that throttle heavily
//                               → proxy adds caching headroom
//  BUCKET C — OPEN           : No server-side block
//                               → direct in Electron, proxy in browser
//
// In Electron (file://): only bucket A+B go through proxy
// In browser  (http://): everything goes through proxy (CORS is live)
// ================================================================

(function () {
  'use strict';

  const PROXY_ORIGIN = 'http://127.0.0.1:3010';  // force IPv4 — localhost → ::1 on IPv6-only Tailscale
  const IS_ELECTRON  = window.location.protocol === 'file:';

  // ── Bucket A: Cloudflare Bot Mgmt — always needs the proxy ──────────────
  const CF_PROTECTED = new Set([
    'api.bybit.com',
    'api.bytick.com',   // Bybit EU/Asia mirror — automatic geo-fence failover
    'www.okx.com',
    'api-pub.bitfinex.com',
    'api.kucoin.com',
    'api.mexc.com',
    'api.crypto.com',
    'clob.polymarket.com',
    'gamma-api.polymarket.com',
  ]);

  // ── Bucket B: rate-limited public APIs — proxy for headroom ─────────────
  const RATE_LIMITED = new Set([
    'api.coingecko.com',
    'api.dexscreener.com',
    'api.blockchair.com',
    'hypurrscan.io',
    'api.etherscan.io',
    'api.bscscan.com',
  ]);

  // ── Bucket C: open / first-party APIs — direct ok in Electron ───────────
  // (still proxied in browser so the CORS bouncer doesn't fire)
  // api.binance.us, fapi.binance.com, api.coinbase.com,
  // api.exchange.coinbase.com, api.kraken.com, api.elections.kalshi.com,
  // s2.ripple.com, xrplcluster.com, api.mainnet-beta.solana.com,
  // eth.blockscout.com, bsc.blockscout.com, api.blockcypher.com, mempool.space, api.hyperliquid.xyz

  // hostname → proxy exchange prefix (config.toml keys)
  const HOST_MAP = {
    'api.binance.us':               'binance',
    'fapi.binance.com':             'binance-f',
    'api.coingecko.com':            'coingecko',
    'api.coinbase.com':             'coinbase',
    'api.exchange.coinbase.com':    'coinbase-ex',
    'api.kraken.com':               'kraken',
    'api.bybit.com':                'bybit',
    'api.bytick.com':               'bybit',   // EU mirror — same proxy route
    'www.okx.com':                  'okx',
    'api.elections.kalshi.com':     'kalshi',
    'gamma-api.polymarket.com':     'polymarket',
    'clob.polymarket.com':          'polymarket-clob',
    'api-pub.bitfinex.com':         'bitfinex',
    'api.kucoin.com':               'kucoin',
    'api.mexc.com':                 'mexc',
    'hypurrscan.io':                'hypurrscan',
    'api.dexscreener.com':          'dexscreener',
    'mempool.space':                'mempool',
    'api.blockchair.com':           'blockchair',
    'api.etherscan.io':             'etherscan',
    'api.bscscan.com':              'bscscan',
    'eth.blockscout.com':           'blockscout-eth',
    'bsc.blockscout.com':           'blockscout-bsc',
    'api.hyperliquid.xyz':          'hyperliquid',
    'api.blockcypher.com':          'blockcypher',
    's2.ripple.com':                'ripple',
    'xrplcluster.com':              'xrpl',
    'api.mainnet-beta.solana.com':  'solana',
    'api.crypto.com':               'crypto-com',
  };

  const _origFetch = window.fetch.bind(window);
  const EXTERNAL   = /^https?:\/\//;

  function needsProxy(hostname) {
    if (!IS_ELECTRON) return true;           // browser: CORS bouncer is live → proxy everything
    return CF_PROTECTED.has(hostname) || RATE_LIMITED.has(hostname);
  }

  function rewrite(url) {
    if (!EXTERNAL.test(url)) return url;
    try {
      const u = new URL(url);
      if (!needsProxy(u.hostname)) return url; // Bucket C in Electron → go direct

      const prefix = HOST_MAP[u.hostname];
      if (prefix) {
        const p = u.pathname.replace(/^\//, '');
        return `${PROXY_ORIGIN}/${prefix}/${p}${u.search}`;
      }
      // Unknown host → generic escape hatch
      return `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(url)}`;
    } catch (_) {
      return url;
    }
  }

  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      input = rewrite(input);
    } else if (input instanceof Request && EXTERNAL.test(input.url)) {
      const rw = rewrite(input.url);
      if (rw !== input.url) input = new Request(rw, input);
    }
    return _origFetch(input, init);
  };

  const mode = IS_ELECTRON ? 'Electron (A+B→proxy, C→direct)' : 'browser (all→proxy)';
  console.info(`[WE] proxy-fetch v1.3 — ${mode}`);
})();
