# 🔧 API Reference

Console commands, debug helpers, and programmatic API for WE-CRYPTO.

---

## Overview

All modules expose their APIs on the `window` global object in the renderer process. Open DevTools (`F12`) to access the console.

---

## Prediction Engine API

```js
// Full namespace
window.PredictionEngine

// Get latest prediction for a coin
window._predictions?.BTC        // { direction, confidence, score, horizon }
window._predictions?.ETH
// All coins: BTC, ETH, SOL, XRP, DOGE, BNB, HYPE

// Trigger a manual prediction refresh
window.PredictionEngine?.refresh?.()

// Get raw model score (-1.0 to +1.0)
window._predictions?.BTC?.score
```

---

## Adaptive Learning Engine API

```js
// Full namespace
window.AdaptiveLearningEngine

// Get current signal weights
window.AdaptiveLearningEngine?.getWeights?.()
// Returns: { RSI: 1.05, MACD: 0.95, CCI: 1.00, ... }

// Get accuracy history per coin/signal
window._historicalScorecard
// Structure: { BTC: { RSI: { accuracy, count, trend }, ... }, ... }

// Force an immediate weight update
window.AdaptiveLearningEngine?.tune?.()

// Get tuning audit log
window.AdaptiveLearningEngine?.getAuditLog?.()
```

---

## Kalshi / Prediction Markets API

```js
// Full namespace
window.PredictionMarkets

// Get cached data for a coin
window.PredictionMarkets?.getCoin?.('BTC')
// Returns: { kalshi15m: [...], kalshi5m: [...], polymarket: [...] }

// Get all cached data
window.PredictionMarkets?.getAll?.()

// Force a Kalshi refresh
window.PredictionMarkets?.refresh?.()

// Raw contract cache
window._kalshiContractCache
```

---

## Floating Orchestrator API

```js
// Full namespace
window.KalshiOrchestrator   // or window.FloatingOrchestrator

// Get current trade intents
window.KalshiOrchestrator?.getIntents?.()
// Returns: [{ coin, intent, edge, kelly, reason }, ...]

// Get EV for a specific coin
window.KalshiOrchestrator?.getEV?.('BTC')

// Manual translate (regenerate intents)
window.KalshiOrchestrator?.translate?.()
```

---

## Backtest API

```js
// Full namespace
window.BacktestRunner

// Run a full backtest
window.BacktestRunner?.run?.()

// Get latest backtest results
window._backtests
// Structure: { BTC: { accuracy, profitFactor, sharpe, ... }, ... }

// Advanced backtest (percentile + Kalshi alignment)
window.BacktestRunner?.runAdvanced?.()
```

---

## Market Resolver API

```js
// Full namespace
window.MarketResolver

// Resolve a contract to metadata
window.MarketResolver?.resolve?.('KXBTC15M')

// Get all known contracts for a coin
window.MarketResolver?.getContracts?.('BTC')
```

---

## Order Book API

```js
// Full namespace
window.OrderBook

// Get latest order book snapshot for a coin
window.OrderBook?.getSnapshot?.('BTC')
// Returns: { bids: [...], asks: [...], imbalance: 0.12 }
```

---

## Data Logger API

```js
// Full namespace
window.DataLogger

// Get logged signal decisions
window.DataLogger?.getLog?.()

// Get trade log
window.DataLogger?.getTradeLog?.()

// Export log to clipboard
window.DataLogger?.export?.()
```

---

## Shell Router API

```js
// Full namespace
window.ShellRouter

// Get cross-coin shell propagation state
window.ShellRouter?.getState?.()

// Get shell packet for a coin
window.ShellRouter?.getPacket?.('BTC')
```

---

## Debug Helpers

```js
// Print full system state summary to console
window.debugState?.()

// Check all feed statuses
window.checkFeeds?.()

// Inspect proxy routing
window.suppFetch   // fetch wrapper with proxy support

// Check throttle state
window.throttledFetch?.getStats?.()
```

---

## localStorage Keys

WE-CRYPTO uses `beta1_*` namespace for all persisted state:

| Key | Contents |
|-----|----------|
| `beta1_weights` | Current adaptive signal weights |
| `beta1_scorecard` | Historical accuracy data |
| `beta1_auditLog` | Weight tuning audit trail |
| `beta1_contractCache` | Kalshi contract metadata |
| `beta1_calibration` | Startup calibration data |

```js
// Read weights from storage
JSON.parse(localStorage.getItem('beta1_weights'))

// Clear all WE-CRYPTO storage (resets learning)
Object.keys(localStorage)
  .filter(k => k.startsWith('beta1_'))
  .forEach(k => localStorage.removeItem(k))
```

---

**Last Updated:** 2026-05-01 | **Version:** 2.11.0+
