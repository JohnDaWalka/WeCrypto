# 🧪 Testing Guide

How to run and write tests for WE-CRYPTO.

---

## Running Tests

All test scripts live in the repo root and `tests/` directory. Run them with Node.js directly — no test runner required.

### Available Test Scripts

```bash
# Integration test — full prediction + tuning cycle
node test-integration.js

# Real-time tuner test — validates adaptive weight updates
node test-realtime-tuner.js

# Snapshot tuner test — validates snapshot-based tuning
node test-snapshot-tuner.js

# Signal logic audit — checks signal correctness
node test-signal-logic-audit.js

# Signal inversion test — checks sign conventions
node test-signal-inversion.js

# Live feed tests (requires proxy on http://127.0.0.1:3010)
node tests/test-live-feeds.js

# API status test — validates Kalshi credentials
node tests/test-api-status.js
```

### Prerequisites for Live Tests

`test-live-feeds.js` and `test-api-status.js` require a running proxy:

```bash
# Start the app first (or just the proxy server)
npm start
# Then in another terminal:
node tests/test-live-feeds.js
```

---

## Test Structure

### Integration Test (`test-integration.js`)

Tests the full cycle:
1. Fetches OHLCV candles
2. Runs prediction model
3. Runs adaptive tuning
4. Validates output shape

Expected output:
```
✅ Candle fetch: OK
✅ Prediction model: OK (BTC: UP 58%)
✅ Tuning cycle: OK (weights updated)
✅ All tests passed
```

### Realtime Tuner Test (`test-realtime-tuner.js`)

Validates that the real-time tuner:
- Correctly reads historical scorecard
- Applies boost/reduce logic at the right thresholds
- Does not exceed max/min weight bounds

### Signal Logic Audit (`test-signal-logic-audit.js`)

Validates each signal's output direction matches expected market behaviour. Tests sign conventions for RSI, MACD, CCI, Fisher, ADX, ATR, order book imbalance, and Kalshi probability extraction.

---

## Backtest Validation

```bash
# Run backtest simulator
node backtest-simulator.js
```

Backtest results are written to `backtest-simulation-results.json`. Check:
- Accuracy > 50%
- Profit factor > 1.0
- Sharpe ratio > 0.5

---

## Writing New Tests

### Convention

Test files use simple `assert`-style checks with `console.log` output:

```js
const assert = require('assert')

// Test a function
const result = someFunction(input)
assert.strictEqual(result.direction, 'UP', 'Direction should be UP')
console.log('✅ Direction test passed')
```

### What to Test

- **Signal functions** — Given known OHLCV data, assert correct signal value and direction
- **Weight update logic** — Given accuracy above/below threshold, assert correct weight adjustment
- **Contract parsing** — Given a raw Kalshi API response, assert correct `floor_strike` and direction extraction
- **EV calculation** — Given model probability and Kalshi price, assert correct EV and Kelly fraction

### Fixture Data

Place test fixtures (mock API responses, candle data) in `tests/fixtures/`.

---

## Debugging Failing Tests

1. **Run with verbose logging:**
   ```bash
   DEBUG=true node test-integration.js
   ```

2. **Check proxy is running** for live feed tests:
   ```bash
   curl http://127.0.0.1:3010/health
   ```

3. **Check API credentials** for Kalshi tests:
   ```bash
   node tests/test-api-status.js
   ```

4. **Inspect signal output:**
   ```js
   // In test file, add:
   console.log(JSON.stringify(result, null, 2))
   ```

---

## Continuous Validation

After making changes to the prediction engine or tuning logic, run:

```bash
node test-signal-logic-audit.js && node test-integration.js && echo "All clear"
```

---

**Last Updated:** 2026-05-01 | **Version:** 2.11.0+
