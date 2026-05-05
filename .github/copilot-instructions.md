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

### Linting
- No lint script is defined in the package manifests; do not assume ESLint/Prettier CLI tasks exist.

## High-level architecture

1. **Electron main process (`electron/main.js`)** boots the desktop shell, starts:
   - the local Rust proxy executable (`we-crypto-proxy.exe`, port cascade starting at 3010),
   - the Kalshi Node worker (`electron/kalshi-worker.js`, HTTP bridge on 3050),
   - the optional web mirror service (`electron/wecrypto-web-service.js`, default 3443),
   then loads `public/index.html` into the renderer.
2. **Renderer boot chain (`public/index.html`)** is script-ordered and non-module. It loads startup/calibration scripts first, then infra/feed/orbital/Kalshi/core modules, then `src/core/app.js` last as the composition layer.
3. **Prediction pipeline**:
   - `src/core/predictions.js` computes multi-horizon scores from exchange/order-flow/on-chain inputs and stores outputs in global runtime state (`window._predictions`, `window._backtests`).
   - `src/kalshi/prediction-markets.js` polls Kalshi (15m + 5m) and Polymarket every 30s, fuses probabilities, and exposes `window.PredictionMarkets`.
   - `src/ui/floating-orchestrator.js` converts model output + Kalshi pricing into EV-based intents (`window.KalshiOrchestrator`).
4. **UI/runtime orchestrator (`src/core/app.js`)** manages views, timers, persistence, and cross-module wiring (including log/history stores and orchestrator rendering).
5. **Startup recovery path (`src/kalshi/wecrypto-startup-loader.js`)** restores adaptive calibration + cached historical data before normal polling loops continue.

## Key codebase conventions

- **Global runtime contract over imports:** modules are mostly IIFEs that expose APIs on `window` (for example `window.PredictionMarkets`, `window.KalshiOrchestrator`, `window.AdaptiveLearningEngine`). Preserve this style when adding cross-module integrations.
- **Script order is a dependency graph:** `public/index.html` ordering is operationally significant (startup/calibration modules intentionally load before `app.js`).
- **Canonical coin universe is fixed in many modules:** `BTC, ETH, SOL, XRP, DOGE, BNB, HYPE`. Keep additions/removals synchronized across predictions, Kalshi mapping, orchestrator, and UI tables.
- **Kalshi contract interpretation is explicit:** code relies on `strike_type`/`floor_strike` semantics (`above` vs `below`) to derive YES-direction. Avoid subtitle-text parsing unless the existing fallback path is already used.
- **Persistence keys use `beta1_*` namespaces:** localStorage and contract cache compatibility depend on these keys staying stable.
- **Proxy-first external access:** many network calls are designed to flow through the local proxy + throttled/backoff helpers; reuse existing fetch wrappers before adding direct calls.
- **Packaging caveat from current build flow:** close running WECRYPTO executable before running builder targets, or output artifacts in `dist\` may be locked.
- **Workspace agent context:** `.github/AGENTS.md` defines a repo-specific **WE CFM Orchestrator Agent**; prefer that agent for deep domain-specific orchestration work in this repo.
