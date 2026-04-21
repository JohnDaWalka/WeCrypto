// tauri-bridge.js — Discrete Bouncer for WE|||CRYPTO
// Uses window.__TAURI__ (withGlobalTauri: true) — no bundler needed

(function () {
  function getInvoke() {
    return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  }

  window.bouncerFetch = async (category, url, options = {}) => {
    const invoke = getInvoke();
    if (!invoke) {
      // Fallback: plain fetch (Electron / browser)
      const r = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      return r.text();
    }
    try {
      return await invoke('discrete_bouncer', {
        category,
        url,
        method: options.method || 'GET',
        body: options.body ? JSON.parse(JSON.stringify(options.body)) : null,
        extraHeaders: options.headers || {}
      });
    } catch (e) {
      console.error('[BOUNCER ERROR]', e);
      throw e;
    }
  };

  window.priceFetch  = (url, opts) => window.bouncerFetch('price',  url, opts);
  window.binaryFetch = (url, opts) => window.bouncerFetch('binary', url, opts);
  window.suppFetch   = (url, opts) => window.bouncerFetch('supp',   url, opts);

  console.log('[TAURI] Discrete Bouncer bridge loaded —',
    getInvoke() ? 'Tauri/invoke' : 'fetch/fallback');
})();
