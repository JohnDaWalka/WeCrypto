# 🔧 Troubleshooting

Common issues and their fixes for WE-CRYPTO.

---

## Startup Issues

### App Fails to Open

| Check | Command / Fix |
|---|---|
| Node.js installed | `node --version` → must be ≥18 |
| Dependencies installed | Run `npm install` |
| Port 3010 in use | Kill the process using port 3010 |
| Electron version | `npx electron --version` |

### "KALSHI-API-KEY.txt not found"

The app runs in preview mode without credentials. To enable Kalshi:
1. Create `KALSHI-API-KEY.txt` in the project root
2. Format: UUID on line 1, RSA key starting on line 5
3. Restart the app

### Blank Prediction Cards

- **Wait 30–60 s** — the first polling cycle takes one full interval
- Check DevTools console for fetch errors
- Verify the Rust proxy is running: look for `[Proxy] listening on 3010` in startup logs

---

## Prediction Issues

### "No settled data" / Win Rate Always 0 %

The accuracy engine needs settled Kalshi contracts to score predictions.

```javascript
// Check if contract cache is populated
await window.electron.invoke('storage:readContractCache')
// Should return an array of settled contracts

// Force a cache refresh
window.KalshiAccuracyDebug.refresh()
```

If the cache is empty, ensure the app has been running for at least one settlement cycle (Kalshi settles 15-minute contracts continuously).

### Weights Not Updating

```javascript
// Confirm adaptive engine is running
window.AdaptiveLearningEngine.status()

// Manually trigger a tuning cycle
window.AdaptiveLearningEngine.runCycle()

// Check localStorage
JSON.parse(localStorage.getItem('beta1_adaptive_weights'))
```

If `beta1_adaptive_weights` is `null`, the engine will use baseline defaults and will write new weights after the first cycle.

### Low Accuracy (< 45 %)

1. Check for signal inversion: `window.KalshiAccuracyDebug.findInversions()`
2. Review current regime: check ATR % in prediction cards
3. Allow at least 50 settled contracts before evaluating accuracy
4. Consider resetting weights: `localStorage.removeItem('beta1_adaptive_weights')` then restart

---

## Kalshi Integration Issues

### Balance Shows 0 or Fails

```javascript
await window.Kalshi.getBalance()
// If error: check KALSHI-API-KEY.txt format
```

Key format checklist:
- Line 1: UUID (no spaces, no newlines)
- Lines 2–4: empty
- Line 5+: `-----BEGIN RSA PRIVATE KEY-----` block

### "401 Unauthorized"

- Verify API key ID and RSA private key are from the **same** Kalshi key pair
- Check that the environment matches (`--env production` vs `--env demo`)

### "Connection Refused" to Port 3050

The Kalshi worker is not running:
```bash
# Start it manually to see the error
node electron/kalshi-worker.js
```

Common causes: credentials file missing, port already in use, Node.js not installed.

### Orders Not Placing

```javascript
// Test with a minimal order
await window.Kalshi.placeOrder({
  market_ticker: 'KXBTC-25MAY1423-T103499',
  side: 'yes',
  action: 'buy',
  quantity: 1,
  yes_price: 50
})
```

Check: sufficient balance, market is open, order price within spread.

---

## Network Issues

### Proxy Fetch Errors

The Rust proxy retries with backoff. If errors persist:
1. Check internet connectivity
2. Verify Coinbase / Kalshi APIs are not down
3. Restart the app (proxy restarts automatically)

### Stale Pyth Prices

```javascript
// Check price freshness
window.PythSettlement.isFresh('BTC', 30_000) // ms
// → false = price is stale

// Force refresh
await window.PythSettlement.getCurrentPrice('BTC')
```

---

## Performance Issues

### High Memory Usage

- The app caches 100 error entries and market data; memory stabilises at ~100–200 MB
- If above 500 MB, restart the app

### Slow Dashboard Updates

- Frame rate should be ~59 fps; if lower, open DevTools → Performance → record
- The known fix (v2.13.3+) removed the hourly-ranges panel that caused jank

### Build Takes > 10 Minutes

- Close all Electron instances before building
- Delete `dist/` folder and retry
- Check disk space

---

## Further Reading

- [GETTING-STARTED.md](./GETTING-STARTED.md) — setup guide
- [CONFIGURATION.md](./CONFIGURATION.md) — all tuneable parameters
- [API.md](./API.md) — diagnostic console commands
- [CRITICAL_CHECKPOINTS.md](./CRITICAL_CHECKPOINTS.md) — 8-level verification checklist
