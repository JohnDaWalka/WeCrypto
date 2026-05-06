# 🧪 Testing Guide

How to run and write tests for WE-CRYPTO.

---

## Test Scripts

All test scripts live in the project root or `tests/` directory and are run with Node.js directly.

| Script | What it tests | Prerequisites |
|---|---|---|
| `test-integration.js` | End-to-end prediction + Kalshi flow | None |
| `test-snapshot-tuner.js` | Snapshot-layer adaptive tuning | None |
| `test-realtime-tuner.js` | Real-time gate adjustments | None |
| `test-signal-logic-audit.js` | Signal inversion + logic audit | None |
| `tests/test-live-feeds.js` | Live Pyth/Coinbase feeds | Proxy on `http://127.0.0.1:3010` |
| `tests/test-api-status.js` | API endpoint health | Proxy on `http://127.0.0.1:3010` |

---

## Running Tests

```bash
# Unit / integration (no proxy needed)
node test-integration.js
node test-snapshot-tuner.js
node test-realtime-tuner.js
node test-signal-logic-audit.js

# Live feed tests (start proxy first)
npm start &                     # starts app + proxy
node tests/test-live-feeds.js
node tests/test-api-status.js
```

---

## Pre-Launch Checklist (8 Levels)

The [CRITICAL_CHECKPOINTS.md](./CRITICAL_CHECKPOINTS.md) document defines an 8-level checkpoint framework that should be completed before trading real money:

| Level | What | How to verify |
|---|---|---|
| 1 | System startup | App opens, no console errors |
| 2 | Kalshi connectivity | `window.Kalshi.getBalance()` returns success |
| 3 | Quantum framework | `window.KalshiEnhancements.SPIN_STATES` defined |
| 4 | Orbital engine | Prediction cards populate |
| 5 | Order execution | Test micro order (1 contract) |
| 6 | Live prediction cycle | Accuracy scorecard updates |
| 7 | Risk controls | Stop-loss fires correctly |
| 8 | Accuracy baseline | ≥50 settled contracts, WR ≥52 % |

---

## Backtest Validation

```javascript
// Run in DevTools console after the app is fully loaded

// Get current backtest results
window._backtests

// Run backtest for a specific coin
window.PredictionMarkets.runBacktest('BTC', { days: 7 })

// Export backtest to JSON for analysis
copy(JSON.stringify(window._backtests, null, 2))
```

The backtest runner script can also be used standalone:

```bash
node backtest-runner.js
# Output appears in backtest-runner-output.txt
```

---

## Writing New Tests

Tests are plain Node.js scripts. Follow this template:

```javascript
// tests/test-my-feature.js
'use strict';

const assert = require('assert');

// Import the module under test (if it exports anything)
// const myModule = require('../src/core/my-module');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

// --- Tests ---

test('example: basic assertion', () => {
  assert.strictEqual(1 + 1, 2);
});

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

---

## Signal Audit

The `test-signal-logic-audit.js` script checks for systematic signal inversions — a common source of accuracy degradation:

```bash
node test-signal-logic-audit.js
# Reports any signals where the direction sign is consistently wrong
```

If inversions are found, inspect the relevant signal in `src/core/predictions.js` and verify the `strike_type` logic for that Kalshi market.

---

## Continuous Integration

There are no automated CI test runs configured. Run the test scripts manually before each build and before merging changes to `main`.

---

## Further Reading

- [CRITICAL_CHECKPOINTS.md](./CRITICAL_CHECKPOINTS.md) — full 8-level pre-launch framework
- [DEVELOPMENT.md](./DEVELOPMENT.md) — setting up your dev environment
- [API.md](./API.md) — console commands for manual testing
