// throttled-fetch.js — Global API rate limiter for WE|||CRYPTO
// Prevents exchange APIs from throttling/banning and stops the proxy from
// being overwhelmed by 30+ simultaneous requests during prediction engine runs.
//
// Two modes exposed on window:
//   throttledFetch(url, options)  — concurrent cap, hard timeout per request
//   queuedFetch(url)              — strict serial queue with 65ms breathing room between calls
//
// Load order: AFTER proxy-fetch.js (so throttle wraps the already-proxied fetch).
//
// WHY Promise.race instead of AbortController:
//   proxy-fetch.js routes CF-protected domains through a local XHR proxy that
//   does not forward AbortController signals — so requests through the proxy
//   can hang forever.  Promise.race gives us a hard wall-clock deadline that
//   fires regardless, properly releasing the slot via finally.

(function () {
  'use strict';

  // ── 1. CONCURRENT THROTTLE ────────────────────────────────────────────────
  const MAX_CONCURRENT  = 5;      // lowered: fewer simultaneous proxy hits
  const FETCH_TIMEOUT_MS = 4500;  // hard deadline per request (4.5 s)
  const SLOT_GAP_MS      = 30;    // breathing room between slot releases

  let activeFetches = 0;
  const waitQueue = [];

  async function throttledFetch(url, options = {}) {
    if (activeFetches >= MAX_CONCURRENT) {
      await new Promise(resolve => waitQueue.push(resolve));
    }
    activeFetches++;

    // Promise.race provides a hard deadline even when the proxy ignores
    // the AbortController signal.  The underlying fetch may keep running
    // in the background but it won't hold a throttle slot.
    const hardTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('[throttle] timeout')), FETCH_TIMEOUT_MS)
    );

    try {
      const res = await Promise.race([fetch(url, options), hardTimeout]);
      return res;   // ← return raw Response; callers use .ok / .json() themselves
    } catch (err) {
      console.warn('[ThrottledFetch] timeout/error:', url.slice(0, 100));
      throw err;    // ← re-throw so caller's .catch(() => []) handles it gracefully
    } finally {
      activeFetches--;
      // Small gap before waking the next queued request — reduces proxy burst
      if (waitQueue.length > 0) {
        setTimeout(() => { if (waitQueue.length) waitQueue.shift()(); }, SLOT_GAP_MS);
      }
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

  console.info(`[ThrottledFetch] v1.1 ready — concurrent: ${MAX_CONCURRENT} | timeout: ${FETCH_TIMEOUT_MS}ms | gap: ${SLOT_GAP_MS}ms`);
})();
