# 📋 API Reference

All commands are available in the Electron DevTools console (F12 → Console).

---

## Prediction Engine

```javascript
// Current prediction for a coin
window._predictions['BTC']
// → { direction: 'UP', confidence: 78, spinState: 2, ... }

// All predictions
window._predictions

// Backtest results
window._backtests['BTC']

// Force a prediction refresh
window.PredictionMarkets.refresh()
```

---

## Accuracy & Scorecard

```javascript
// Per-coin scorecard
window.KalshiAccuracyDebug.scorecard('BTC')
// → { winRate: 0.62, trades: 47, correct: 29, ... }

// Find signal inversions (signs that were flipped)
window.KalshiAccuracyDebug.findInversions()

// Export all accuracy data as CSV
window.KalshiAccuracyDebug.exportCSV()

// Historical scorecard (full table)
window.historicalScorecard
```

---

## Adaptive Learning Engine

```javascript
// Current adaptive signal weights
window.AdaptiveLearningEngine.getWeights('BTC')

// Run a manual tuning cycle
window.AdaptiveLearningEngine.runCycle()

// Status report
window.AdaptiveLearningEngine.status()

// Reset weights to baseline
window.AdaptiveLearningEngine.reset('BTC')
```

---

## Kalshi Integration

```javascript
// Account balance
await window.Kalshi.getBalance()
// → { success: true, data: { balance: "50000.00" } }

// List markets (up to N)
await window.Kalshi.getMarkets(100)

// Place an order
await window.Kalshi.placeOrder({
  market_ticker: 'KXBTC-25MAY1423-T103499',
  side: 'yes',
  action: 'buy',
  quantity: 5,
  yes_price: 65
})

// Cancel an order
await window.Kalshi.cancelOrder('order-id-here')

// Cancel all open orders
await window.Kalshi.cancelAllOrders()

// Get open positions
await window.Kalshi.getPositions()
```

---

## Kalshi Worker (HTTP — port 3050)

These are equivalent REST calls to the standalone worker process:

```bash
# Health check
curl http://127.0.0.1:3050/health

# Account balance
curl http://127.0.0.1:3050/balance

# Markets
curl "http://127.0.0.1:3050/markets?limit=50"

# Events
curl http://127.0.0.1:3050/events

# Positions
curl http://127.0.0.1:3050/positions

# Orders
curl http://127.0.0.1:3050/orders
```

See [KALSHI_WORKER_GUIDE.md](./KALSHI_WORKER_GUIDE.md) for the full HTTP API reference.

---

## Orchestrator (EV Engine)

```javascript
// Current trade intents
window.KalshiOrchestrator.getIntents()

// Diagnostic dump
window.KalshiOrchestrator.diagnostics()

// Force re-evaluation
window.KalshiOrchestrator.evaluate()
```

---

## Momentum Exit

```javascript
// Active positions + exit status
window.getMomentumDiagnostics()
// → { activePositions: 3, positions: {...}, recentExits: [...] }

// HTML render of momentum status
window.renderMomentumDashboard()

// Stop momentum polling
window.stopMomentumExitIntegration()
```

---

## Startup Diagnostics

```javascript
// Full startup timeline (ms per phase)
window.__WECRYPTO_STARTUP.getLog()

// Read contract cache from Electron storage
await window.electron.invoke('storage:readContractCache')

// Check localStorage calibration
localStorage.getItem('beta1_adaptive_weights')
```

---

## Pyth Price Feed

```javascript
// Live price for a coin
await window.PythSettlement.getCurrentPrice('BTC')

// Validate a settlement outcome
await window.PythSettlement.validateSettlement(trade)

// Current volatility regime
window.PythSettlement.getVolatility('BTC')
```

---

## Debug Helpers

```javascript
// Log prediction diagnostics for all coins
Object.keys(window._predictions).forEach(sym =>
  console.log(sym, window._predictions[sym])
)

// Watch weights in real-time
setInterval(() =>
  console.table(window.AdaptiveLearningEngine.getWeights('BTC')),
  5000
)

// Export backtest to JSON
JSON.stringify(window._backtests, null, 2)
```
