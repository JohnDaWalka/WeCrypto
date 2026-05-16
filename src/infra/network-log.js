// network-log.js
// Early renderer-side network diagnostics for fetch/XHR failures.
(function () {
  'use strict';

  if (window.NetworkLog && window.NetworkLog.installed) return;

  const MAX_ENTRIES = 500;
  const entries = [];
  let seq = 0;

  function now() {
    return Date.now();
  }

  function toUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input || '');
    } catch (_) {
      return 'unknown';
    }
  }

  function sanitizeUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (/key|token|secret|auth|password|signature|credential/i.test(key)) {
          url.searchParams.set(key, 'redacted');
        }
      }
      return url.toString();
    } catch (_) {
      return String(raw || 'unknown').replace(/([?&](?:key|token|secret|auth|password|signature|credential)=)[^&]+/ig, '$1redacted');
    }
  }

  function hostname(raw) {
    try {
      return new URL(raw, location.href).hostname || 'local';
    } catch (_) {
      return 'unknown';
    }
  }

  function providerFor(raw) {
    const host = hostname(raw).toLowerCase();
    if (host.includes('kalshi')) return 'Kalshi';
    if (host.includes('polymarket')) return 'Polymarket';
    if (host.includes('pyth') || host.includes('hermes')) return 'Pyth';
    if (host.includes('coingecko')) return 'CoinGecko';
    if (host.includes('coinbase')) return 'Coinbase';
    if (host.includes('crypto.com')) return 'Crypto.com';
    if (host.includes('binance')) return 'Binance';
    if (host.includes('bybit')) return 'Bybit';
    if (host.includes('127.0.0.1') || host.includes('localhost')) return 'LocalProxy';
    return host || 'Network';
  }

  function record(type, detail) {
    const rawUrl = detail.url || 'unknown';
    const entry = {
      id: ++seq,
      ts: now(),
      type,
      provider: detail.provider || providerFor(rawUrl),
      url: sanitizeUrl(rawUrl),
      method: detail.method || 'GET',
      status: Number.isFinite(detail.status) ? detail.status : null,
      statusText: detail.statusText || '',
      durationMs: Number.isFinite(detail.durationMs) ? Math.round(detail.durationMs) : null,
      error: detail.error || '',
    };

    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();

    try {
      window.dispatchEvent(new CustomEvent('network-log:update', { detail: entry }));
    } catch (_) {}

    try {
      if (window.NetworkHealth?.update) {
        window.NetworkHealth.update(entry.provider, {
          status: entry.status && entry.status < 500 ? 'degraded' : 'down',
          lastFetch: entry.ts,
          fallback: false,
          reason: entry.error || `${entry.status || 'network'} ${entry.statusText}`.trim(),
        });
      }
    } catch (_) {}

    try {
      const line = `${entry.provider} ${entry.method} ${entry.status || type} ${entry.url} ${entry.error}`.slice(0, 1800);
      window.desktopApp?.networkError?.(type, line).catch(() => {});
    } catch (_) {}

    return entry;
  }

  function methodFor(input, init) {
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch && !originalFetch.__wecryptoNetworkLogWrapped) {
    const wrappedFetch = function (input, init) {
      const started = now();
      const url = toUrl(input);
      const method = methodFor(input, init);
      return originalFetch(input, init)
        .then(response => {
          if (!response || !response.ok) {
            record('HTTP_ERROR', {
              url,
              method,
              status: response ? response.status : null,
              statusText: response ? response.statusText : 'No response',
              durationMs: now() - started,
            });
          }
          return response;
        })
        .catch(error => {
          record('NETWORK_ERROR', {
            url,
            method,
            durationMs: now() - started,
            error: error?.message || String(error),
          });
          throw error;
        });
    };
    wrappedFetch.__wecryptoNetworkLogWrapped = true;
    window.fetch = wrappedFetch;
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && !OriginalXHR.__wecryptoNetworkLogWrapped) {
    function LoggedXHR() {
      const xhr = new OriginalXHR();
      let started = 0;
      let method = 'GET';
      let url = 'unknown';
      const originalOpen = xhr.open;
      xhr.open = function (m, u) {
        method = String(m || 'GET').toUpperCase();
        url = toUrl(u);
        return originalOpen.apply(xhr, arguments);
      };
      const originalSend = xhr.send;
      xhr.send = function () {
        started = now();
        xhr.addEventListener('loadend', () => {
          if (xhr.status === 0 || xhr.status >= 400) {
            record(xhr.status === 0 ? 'NETWORK_ERROR' : 'HTTP_ERROR', {
              url,
              method,
              status: xhr.status || null,
              statusText: xhr.statusText || '',
              durationMs: now() - started,
              error: xhr.status === 0 ? 'XHR network failure' : '',
            });
          }
        });
        return originalSend.apply(xhr, arguments);
      };
      return xhr;
    }
    LoggedXHR.__wecryptoNetworkLogWrapped = true;
    window.XMLHttpRequest = LoggedXHR;
  }

  window.NetworkLog = {
    installed: true,
    record,
    getAll: () => entries.slice(),
    getRecent: (n = 25) => entries.slice(-n),
    clear: () => { entries.length = 0; },
    summary() {
      const byProvider = {};
      for (const e of entries) {
        if (!byProvider[e.provider]) byProvider[e.provider] = { total: 0, http: 0, network: 0, lastTs: 0 };
        const row = byProvider[e.provider];
        row.total += 1;
        if (e.type === 'HTTP_ERROR') row.http += 1;
        if (e.type === 'NETWORK_ERROR') row.network += 1;
        row.lastTs = Math.max(row.lastTs, e.ts);
      }
      return {
        total: entries.length,
        lastTs: entries.length ? entries[entries.length - 1].ts : null,
        byProvider,
      };
    },
    report() {
      const data = this.summary();
      console.table(entries.slice(-50));
      return data;
    },
    export: () => JSON.stringify(entries, null, 2),
  };

  console.log('[NetworkLog] Installed fetch/XHR diagnostics');
})();
