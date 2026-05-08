# WECRYPTO Copilot Instructions

## Build, run, and test commands

### Primary app (repo root)
- `npm install`
- `npm start` (runs Electron with `electron/main.js`)
- `npm run build` (Windows installer + portable targets via electron-builder)
- `npm run build:portable`
- `npm run build:installer`
- `npm run tauri:dev`
- `npm run tauri:build`

### Run a single test script
- `node test-snapshot-tuner.js`
- `node test-realtime-tuner.js`
- `node test-integration.js`
- `node test-signal-logic-audit.js`
- `node tests/test-live-feeds.js` (expects proxy endpoints on `http://127.0.0.1:3010`)
- `node tests/test-api-status.js`

### Other package roots in this repo
- `desktop-build\` (`npm start`, `npm run build`, `npm run build:portable`, `npm run build:installer`)
- `we-crypto-electron\` (`npm start`, `npm run dist`)
- `we-crypto-cfm-tauri\` (`npm run dev`, `npm run build`)

### Linting & Formatting
- No lint script is defined in package manifests
- **Prettier is configured** (`.prettierrc`): use 2-space indents, double quotes, semicolons, trailing commas (es5), 80 char line width, LF line endings
- Format with Prettier locally before committing (no automated linting in CI)

## High-level architecture

### Three-Layer Adaptive Learning Stack

The core prediction engine runs in **three parallel feedback loops**:

1. **Real-Time Layer (30 seconds)**
   - `realtime-tuner.js` polls Kalshi historical markets every 30s
   - Rapid accuracy checks against just-settled contracts
   - Fast gate adjustments (±4-8% weight changes)
   - Continuous during market hours

2. **Snapshot Layer (1 hour)**
   - `snapshot-tuner.js` aggregates 60 minutes of market data
   - Detects market regime (trending/range-bound/crash via ADX, ATR)
   - Weight tuning ±8% based on regime
   - Runs once per hour, applies temporary multipliers

3. **Walk-Forward Layer (daily)**
   - `h15-tuner.js` uses 14-day sliding window for baseline calibration
   - Seasonal adjustment and long-term drift correction
   - Runs daily for stability
   - Locks in robust weights that persist across sessions

All three feed `src/core/predictions.js`, which calculates **9 signals**: RSI, MACD, CCI, Fisher, ADX, ATR, Order Book pressure, Kalshi probability, Crowd Fade contrarian.

### Process Architecture

1. **Electron main process (`electron/main.js`)** boots the desktop shell and starts:
   - The local Rust proxy executable (`we-crypto-proxy.exe`, port cascade starting at 3010)
   - The Kalshi Node worker (`electron/kalshi-worker.js`, HTTP bridge on 3050)
   - Optional web mirror service (`electron/wecrypto-web-service.js`, default 3443)
   - Loads `public/index.html` into the renderer

2. **Renderer boot chain (`public/index.html`)** is script-ordered and non-module:
   - Startup/calibration scripts load first (`adaptive-weight-restorer.js`, `h15-tuner.js`, validators)
   - Infrastructure/feed/Kalshi modules in dependency order
   - `src/core/app.js` loads last as the composition layer
   - Order is a **critical dependency graph** — scripts must not be reordered

3. **Prediction pipeline**:
   - `src/core/predictions.js` computes multi-horizon scores from exchange/order-flow inputs → `window._predictions`
   - `src/kalshi/prediction-markets.js` polls Kalshi (15m + 5m) and Polymarket every 30s, fuses probabilities → `window.PredictionMarkets`
   - `src/core/adaptive-learning-engine.js` adjusts signal weights every 2 minutes based on recent accuracy
   - Settlement data from `src/kalshi/historical-settlement-fetcher.js` feeds back into tuners

4. **UI orchestrator (`src/core/app.js`)** manages views, timers, persistence, cross-module wiring, and accuracy rendering

5. **Startup recovery (`src/kalshi/wecrypto-startup-loader.js`)** restores:
   - Adaptive calibration from localStorage (`beta1_adaptive_weights`)
   - Contract win-rate cache from multi-drive storage (D: and F: drives on Windows)
   - Ensures app boots trading-ready (<200ms to live prediction)

## Key codebase conventions

- **Global runtime contract over imports:** modules are mostly IIFEs that expose APIs on `window` (e.g., `window.PredictionMarkets`, `window.KalshiOrchestrator`, `window.AdaptiveLearningEngine`). Preserve this style when adding cross-module integrations. Avoid ES module imports in the renderer—use `window` exports instead.

- **Script order is a dependency graph:** `public/index.html` ordering is operationally significant. Startup/calibration modules intentionally load **before** `app.js`. When adding new modules:
  - Place **before** `src/core/app.js`
  - Place **after** any modules it depends on
  - Critical path modules: calibration restorers → validators → feed inits → app.js

- **Canonical coin universe is fixed and synchronized:** BTC, ETH, SOL, XRP, DOGE, BNB, HYPE. Any addition/removal must update:
  - `src/kalshi/prediction-markets.js` (signal definitions)
  - Kalshi contract ID mappings
  - `src/core/app.js` UI tables
  - `shared/const.ts` (if applicable)
  - Orchestrator and bridge configs

- **Kalshi contract interpretation is explicit:** code relies on `strike_type`/`floor_strike` semantics (`above` vs `below`) to derive YES-direction. Avoid parsing subtitle text unless existing fallback is already in use.

- **Persistence keys use `beta1_*` namespaces:** all localStorage keys and contract cache paths depend on these prefixes. Never rename existing keys—it breaks user state recovery on app restart.

- **Proxy-first external access:** many network calls flow through the local proxy with throttle/backoff helpers. Reuse existing fetch wrappers before adding direct API calls. Check `kalshi-rest.js` and `kalshi-client.js` for established patterns.

- **Adaptive weights are bounded 0.3x to 2.0x:** RSI default ×1.2, MACD ×0.9, etc. Trending boost ×1.5 if improving, degradation penalty ×1.3. Weights are stored in `beta1_adaptive_weights` localStorage key every 5 minutes.

- **Signal inversion detection:** when a signal consistently predicts opposite direction (win rate <40% for 10+ predictions), code flips the direction and logs the event. See `test-signal-inversion.js` and `signal-logic-audit.js` for validation.

- **Market regime detection via ADX/ATR:**
  - **Trending**: ADX > 25 → boost momentum signals (RSI, MACD)
  - **Range-bound**: ADX ≤ 25, low volatility → boost mean reversion (Fisher)
  - **Crash**: ATR spike > 2σ → boost volatility stops (ATR)
  - Regime-specific multipliers apply temporarily, reset after 5-10 cycles

- **Packaging caveat:** close running WECRYPTO executable before building, or output artifacts in `dist/` may be locked.

- **Workspace agent context:** `.github/AGENTS.md` defines a repo-specific **WE CFM Orchestrator Agent**; prefer that for deep domain work.

- **DevTools debugging commands:**
  ```javascript
  window.__WECRYPTO_STARTUP.getLog()           // Startup timeline
  window.KalshiAccuracyDebug.scorecard('BTC')  // Coin accuracy stats
  window.KalshiAccuracyDebug.findInversions()  // Find signal flips
  window.KalshiAccuracyDebug.exportCSV()       // Export to CSV
  ```

---

## Global Runtime State & Important APIs

### Critical Window Globals

**Prediction Engine Output:**
- `window._predictions` — Object mapping coin symbols to live prediction scores
  ```javascript
  {
    BTC: { direction: 'UP', score: 72, confidence: 0.65, horizon: 15 },
    ETH: { direction: 'DOWN', score: 45, confidence: 0.52, horizon: 15 },
    ...
  }
  ```

- `window._backtests` — Cached walk-forward backtest results (5-year rolling window)
  ```javascript
  {
    BTC: { winRate: 0.62, sharpe: 1.4, maxDD: -18, trades: 2847 },
    ...
  }
  ```

**Market Intelligence:**
- `window.PredictionMarkets` — Kalshi + Polymarket probability aggregator
  ```javascript
  window.PredictionMarkets.getCoin('BTC')
  // { kalshi15m: 0.58, kalshi5m: 0.61, poly: 0.54, combinedProb: 0.575, ... }
  ```

- `window.PREDICTION_COINS` — Array of canonical prediction targets (BTC, ETH, SOL, XRP)
  ```javascript
  [
    { sym: 'BTC', name: 'Bitcoin', instrument: 'BTCUSD', color: '#f7931a', ... },
    ...
  ]
  ```

**Kalshi Bridge:**
- `window.Kalshi` — IPC-based API for market access (requires Electron)
  ```javascript
  const balance = await window.Kalshi.getBalance();
  const markets = await window.Kalshi.getMarkets(50);
  const positions = await window.Kalshi.getPositions();
  ```

**Learning Engine:**
- `window.AdaptiveLearningEngine` — Weight tuning interface
- `window.ContractWinRateCalculator` — Settlement accuracy tracker
- `window.SnapshotTuner` — Hourly regime detection and weight multipliers

### localStorage Keys (All Prefixed with `beta1_`)

- `beta1_adaptive_weights` — Current signal weights (JSON, persisted every 5 min)
  ```javascript
  {
    BTC: { rsi: 1.2, macd: 0.9, fisher: 1.1, ... },
    ETH: { ... },
    ...
  }
  ```

- `beta1_bt_cache` — Walk-forward backtest cache (4-hour TTL)
- `beta1_contract_cache` — Historical settled contracts
- Other `beta1_*` keys for UI state, preferences, timers

---

## External API Integration Patterns

### Prediction Data Sources (No Auth Required)

1. **Crypto.com Exchange API** (`https://api.crypto.com/exchange/v1/public`)
   - 5m/15m candles for BTC, ETH, SOL, XRP, DOGE, BNB, HYPE
   - Order book depth for bid/ask imbalance signals
   - Rate limit: ~50 req/min

2. **CoinGecko API** (`https://api.coingecko.com/api/v3`)
   - OHLC, market cap, dominance trends
   - Fear & Greed Index (cached 5-min TTL)
   - Rate limit: 10 req/sec on free tier

3. **Binance/Bybit/Kraken APIs**
   - OHLCV candles, order book, funding rates (derivatives)
   - Rate limits vary; reuse fetch wrappers in `predictions.js`

4. **Kalshi API** (`https://api.elections.kalshi.com/trade-api/v2`)
   - Markets endpoint: active contracts with bid/ask prices
   - Settled contracts for historical accuracy validation
   - No auth for market data; auth only for trading
   - Rate limit: ~30 req/min (handle with backoff)

5. **Polymarket API** (Gamma: `https://gamma-api.polymarket.com`)
   - Prediction markets for crypto direction (5m, 15m, 1h)
   - Fallback to CLOB (`https://clob.polymarket.com`) on Gamma failure
   - Rate limit: throttled by SDK

### Fetching Patterns

**Always use existing wrappers** (don't make raw fetch calls):
- `src/kalshi/kalshi-rest.js` — Kalshi API with backoff/retry
- `src/kalshi/kalshi-client.js` — Kalshi market data cache
- `predictions.js` — Exchange candle fetching with waterfall (CDC → Binance → Bybit → Kraken)

Example (Kalshi):
```javascript
// Existing wrapper
const settledMarkets = await window.KalshiAPIClient.fetchSettledMarkets({ limit: 100 });
```

---

## Important Data Structures

### Prediction Object
```javascript
{
  direction: 'UP' | 'DOWN',           // Primary output
  score: 0-100,                       // Confidence (higher = more confident)
  confidence: 0-1,                    // Normalized agreement % among signals
  horizon: 1 | 5 | 10 | 15,          // Minutes ahead
  signals: {
    rsi: 0.7,                         // Individual signal strength
    macd: -0.3,
    fisher: 0.85,
    obv: 0.4,
    // ... 9+ signals total
  },
  commentary: 'string',               // Human-readable reason (for testing)
  timestamp: Date,
}
```

### Settlement Record
```javascript
{
  source: 'kalshi' | 'polymarket' | 'coinbase',
  symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP',
  marketId: 'string',
  direction: 'UP' | 'DOWN',           // Our prediction
  outcome: 'YES' | 'NO',              // Actual result
  settleTime: Date,
  profitLoss: 1 | -1,                 // 1 = won, -1 = lost
}
```

---

## Performance & Gotchas

### Critical Path Timing

- **Startup to live predictions**: <200ms (critical for trading)
  - Calibration restorers must load before app.js
  - Cache hits should finish in <50ms
  - If >500ms, check localStorage bloat

- **Prediction cycle**: Every 30 seconds (Kalshi polling frequency)
  - Don't add blocking I/O in render loop
  - Use promises/async for API calls
  - Background tasks should not block UI updates

- **Signal weight persistence**: Every 5 minutes to localStorage
  - Avoid JSON.stringify of very large objects (>5MB)
  - Use check `Date.now() - lastSaveTs > 300_000` to throttle

### Common Issues

1. **Rate Limiting**
   - Kalshi: 429 responses trigger 10-second backoff
   - CoinGecko: 10 requests/sec, not per-user (share session-wide)
   - Solution: Check for `_rateLimitUntil` timestamp before fetching

2. **Missing Market Data**
   - Some coins (e.g., HYPE) not listed on all exchanges
   - Code uses waterfall (CDC → Binance → Bybit) and nullable gracefully
   - If a coin has no data, win rate stalls (weights don't update)

3. **Contract Settlement Delay**
   - Kalshi settles ~1 second after 15m candle close
   - Polymarket may take minutes
   - Accuracy check runs 30s after prediction, so delays are normal

4. **localStorage Full**
   - Electron on Windows may have 50MB limits
   - Backtest cache (4-hour TTL) can grow large
   - Trim with `saveBtCache()` if exceeding limits

### Architecture Bottlenecks

- **Single-threaded renderer**: Heavy backtests freeze UI
  - Walk-forward tuning should spawn subprocess (`h15-tuner.js`)
  - Real-time tuning runs in background threads

- **Multi-drive cache (Windows D:, F: drives)**
  - Contract cache stored on multiple drives for redundancy
  - If drives unavailable, fallback to localStorage
  - Paths hard-coded; won't work on macOS/Linux

---

## Testing & Validation

### Running Validation Tests

```bash
# Signal logic (detects inversions, evaluates all indicators)
node test-signal-logic-audit.js

# Real-time tuner (validates 30-second weight updates)
node test-realtime-tuner.js

# Snapshot tuner (validates hourly regime detection)
node test-snapshot-tuner.js

# Integration (API connectivity, settlement fetching)
node test-integration.js

# Signal inversion detector (finds signals predicting opposite)
node test-signal-inversion.js
```

### Key Test Patterns

1. **Sanity checks** (in `sanity-check-uptrend.js`):
   - Feed known uptrend data, verify predictions are UP with high confidence
   - Inverse test: feed downtrend, expect DOWN

2. **Backtest validation**:
   - Compare current backtest against historical baseline
   - If Sharpe drops >15%, alert developer (weights may have degraded)

3. **Contract settlement matching**:
   - Fetch settled Kalshi contract, compare our direction prediction
   - Calculate accuracy % over last 100 contracts
   - If <45%, signal is probably inverted

---

## Environment & Configuration

### No .env File (Design Choice)

This app intentionally **does not use .env files**. Credentials and config are:
- **Market data APIs**: Public (no auth needed)
- **Kalshi auth**: Stored in Electron secure storage (if trading)
- **Pyth Lazer token**: Optional, `process.env.PYTH_LAZER_TOKEN` only

Check `electron/main.js` for .env loading logic (fallback-based):
1. `.env` next to .exe (packaged)
2. `.env` in repo root (dev)
3. `.env` in resources sibling

### Process Environment Variables

- `PYTH_LAZER_TOKEN` — Pyth Lazer WebSocket token (optional)
- `NODE_ENV` — 'development' or 'production' (affects console logs)
- `LOCALAPPDATA` — Windows cache directory (contract cache)
- `HOME` — macOS/Linux home directory

---

## Modules Directory Reference

| Path | Purpose |
|------|---------|
| `src/core/` | Predictions, learning engine, UI app logic, validators |
| `src/kalshi/` | Kalshi API, settlement fetching, debug tools, startup |
| `src/feeds/` | Market data feeds (Pyth, Binance, Dexscreener) |
| `src/agents/` | LLM signal assistance, anomaly detection |
| `src/ui/` | Floating UI components, orchestrator rendering |
| `electron/` | Main process, IPC bridges, worker management, web service |
| `client/src/` | React UI components (Vite) |
| `server/` | TypeScript backend (if applicable) |
| `shared/` | TypeScript shared constants |

---

## Pyth Lazer Network Resilience (v2.15.5+)

### Problem: Transient API Endpoint Failures
Pyth Lazer WebSocket endpoints (dourolabs.app) occasionally experience DNS failures or HTTP 404 responses, causing the app to lose real-time price feeds.

### Solution: Retry Logic + Graceful Fallback
- **Retry mechanism**: 3 connection attempts with 2-second delays
- **Fallback**: When Pyth fails, app switches to alternative price sources (Crypto.com, CoinGecko, Binance)
- **IPC events**: `pyth:connection-lost` and `pyth:connection-failed` notify renderer of status
- **Non-blocking init**: App window opens immediately regardless of Pyth status

### Debugging Pyth Status
1. **Dev tools auto-open** on app launch (visible on startup)
2. **Console logs** show connection attempts:
   ```
   [PythLazer] Connecting (attempt 1/3)...
   [PythLazer] Connection failed: ENOTFOUND pyth-lazer-proxy-0.dourolabs.app
   [PythLazer] Retrying in 2000ms... (1/3)
   ```
3. **Monitor IPC events**:
   ```javascript
   window.addEventListener('message', (e) => {
     if (e.data.type === 'pyth:connection-failed') {
       console.warn('[APP] Using alternative price feeds');
     }
   });
   ```

### Related Files
- `electron/main.js` lines 43-149 (retry logic, connection handling)
- `src/feeds/pyth-lazer-websocket.js` (SDK integration)
- `src/core/predictions.js` (fallback to exchange candles)

### If Pyth Still Failing
1. Check https://status.pyth.network/ for outages
2. Verify `PYTH_LAZER_TOKEN` environment variable is set
3. Test endpoint connectivity:
   ```powershell
   Invoke-WebRequest -Uri "https://pyth-lazer.dourolabs.app" -TimeoutSec 5
   ```
