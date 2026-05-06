# 🔧 Troubleshooting Guide

Common problems and solutions for WE-CRYPTO.

---

## Quick Diagnosis

Open DevTools (`F12`) and run:

```js
// Check all feeds
window.checkFeeds?.()

// Check if predictions are running
window._predictions

// Check Kalshi data
window.PredictionMarkets?.getCoin?.('BTC')
```

---

## Common Issues

### "No settled data" / Accuracy scorecard is empty

**Symptoms:** The accuracy scorecard shows 0 contracts or no data after several minutes.

**Causes & Fixes:**

1. **Kalshi API credentials missing or invalid**
   ```bash
   # Test credentials
   node tests/test-api-status.js
   ```
   Fix: Update `KALSHI_API_KEY` and `KALSHI_API_SECRET` in `.env`.

2. **Kalshi worker not running**
   - Check that port 3050 is not in use by another process
   - Restart the app; the worker starts automatically

3. **No settled contracts in the window**
   - This can happen on weekends or low-activity periods
   - Wait 5–10 minutes for more contracts to settle

---

### Weights Not Updating

**Symptoms:** Signal weights stay at 1.00 indefinitely; `beta1_weights` in localStorage doesn't change.

**Causes & Fixes:**

1. **Not enough settled contracts** — Tuning requires `MIN_CONTRACTS_REQUIRED` (default 10) settled contracts per signal
   - Solution: Wait for more contracts to accumulate (usually 30–60 min)

2. **Tuning interval not elapsed** — Tuning runs every 2 minutes minimum
   - Force a manual tune: `window.AdaptiveLearningEngine?.tune?.()`

3. **localStorage corrupted**
   ```js
   localStorage.removeItem('beta1_weights')
   location.reload()
   ```

---

### Low Accuracy / Predictions Seem Random

**Symptoms:** Accuracy stays near 50% even after hours of operation.

**Causes & Fixes:**

1. **Not enough data yet** — The learning engine needs 2–4 hours to find meaningful signal patterns. This is normal.

2. **Market regime change** — Volatile or unusual markets reduce signal accuracy. This is expected behaviour.

3. **Stale data** — Check feed status:
   ```js
   window.checkFeeds?.()
   ```

4. **Weight drift** — Weights may have drifted to extremes. Reset:
   ```js
   localStorage.removeItem('beta1_weights')
   location.reload()
   ```

---

### Network / Fetch Errors

**Symptoms:** Console shows `fetch failed`, `timeout`, or `ECONNREFUSED` errors.

**Causes & Fixes:**

1. **Proxy not running** — The Rust proxy (`we-crypto-proxy.exe`) starts on port 3010 automatically. If it fails:
   - Check that port 3010 is available
   - Restart the app

2. **Rate limiting** — Coinbase or Binance rate limit exceeded
   - The throttle layer handles this automatically; errors should resolve in 30–60 seconds

3. **Kalshi API down** — Check [status.kalshi.com](https://status.kalshi.com)

4. **Firewall blocking** — Ensure ports 3010, 3050, and 3443 are not blocked

---

### App Won't Start

**Symptoms:** Electron window doesn't open, or crashes immediately.

**Causes & Fixes:**

1. **Another instance running** — Only one instance can run at a time. Close all WECRYPTO processes.

2. **Port conflict** — Check ports 3010 and 3050 are free:
   ```bash
   netstat -ano | findstr "3010\|3050"
   ```

3. **Missing dependencies** — Run `npm install` to restore node_modules.

4. **Corrupted build** — Re-run `npm run build:portable` to get a fresh build.

---

### Performance Issues

**Symptoms:** UI is slow, high CPU usage, frame rate drops.

**Causes & Fixes:**

1. **Too many DevTools panels open** — Close unused DevTools tabs.

2. **Memory leak** — Restart the app after extended use (8+ hours).

3. **Large audit log** — Clear the log:
   ```js
   localStorage.removeItem('beta1_auditLog')
   ```

See [PERFORMANCE.md](./PERFORMANCE.md) for benchmarks and optimisation tips.

---

### Kalshi Contracts Showing Wrong Direction

**Symptoms:** Contract `YES` prices appear inverted vs. expected direction.

**Cause:** WE-CRYPTO uses `strike_type` / `floor_strike` semantics (`above` vs `below`) to determine the YES direction. Do not rely on contract subtitle text for direction logic.

**Fix:** This is a known edge case in contract parsing. If you observe consistent misdirection on a specific contract series, check `market-resolver.js` for the `resolve()` mapping for that ticker.

---

## Resetting to Clean State

To fully reset all adaptive learning and start fresh:

```js
// In DevTools console
Object.keys(localStorage)
  .filter(k => k.startsWith('beta1_'))
  .forEach(k => localStorage.removeItem(k))
location.reload()
```

---

## Getting Help

- **API diagnostics** → [API.md](./API.md)
- **Performance issues** → [PERFORMANCE.md](./PERFORMANCE.md)
- **Architecture questions** → [ARCHITECTURE.md](./ARCHITECTURE.md)
- **GitHub Issues** — Open a bug report in the repository

---

**Last Updated:** 2026-05-01 | **Version:** 2.11.0+
