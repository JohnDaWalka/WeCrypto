// throttled-fetch.js — Global API rate limiter for WE|||CRYPTO
// Prevents exchange APIs from throttling/banning and stops the proxy from
// being overwhelmed by 30+ simultaneous requests during prediction engine runs.
//
// Two modes exposed on window:
//   throttledFetch(url, options)  — concurrent cap (MAX_CONCURRENT=6), drops-in for fetch()
//   queuedFetch(url)              — strict serial queue with 65ms breathing room between calls
//
// Load order: AFTER proxy-fetch.js (so throttle wraps the already-proxied fetch).

(function () {
  'use strict';

  // ── 1. CONCURRENT THROTTLE ────────────────────────────────────────────────
  // Caps simultaneous outbound requests.  fetchWithTimeout in predictions.js
  // uses this instead of raw fetch — prevents 30+ simultaneous proxy hits.
  const MAX_CONCURRENT = 6;
  let activeFetches = 0;
  const waitQueue = [];

  async function throttledFetch(url, options = {}) {
    if (activeFetches >= MAX_CONCURRENT) {
      await new Promise(resolve => waitQueue.push(resolve));
    }
    activeFetches++;
    try {
      return await fetch(url, options);   // fetch here = proxy-patched fetch
    } finally {
      activeFetches--;
      if (waitQueue.length > 0) waitQueue.shift()();
    }
  }

  // ── 2. SERIAL QUEUE (65 ms gap) ───────────────────────────────────────────
  // For Kalshi/market polling where strict ordering matters.
  const serialQueue = [];
  let queueBusy = false;

  async function queuedFetch(url) {
    return new Promise(resolve => {
      serialQueue.push({ url, resolve });
      runSerialQueue();
    });
  }

  async function runSerialQueue() {
    if (queueBusy || serialQueue.length === 0) return;
    queueBusy = true;
    const { url, resolve } = serialQueue.shift();
    try {
      const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      resolve(await res.json());
    } catch (err) {
      console.error('[ThrottledFetch] serial queue error:', url, err);
      resolve(null);
    }
    queueBusy = false;
    setTimeout(runSerialQueue, 65);   // 65 ms breathing room between calls
  }

  window.throttledFetch = throttledFetch;
  window.queuedFetch    = queuedFetch;

  console.info(`[ThrottledFetch] v1.0 ready — concurrent cap: ${MAX_CONCURRENT} | serial gap: 65ms`);
})();
