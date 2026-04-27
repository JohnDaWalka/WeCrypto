# WE-CFM-Orchestrator — Architecture Overview

## Repository Structure

```
/                          ← Electron entry points (must stay at root)
  main.js                  ← Electron main process
  preload.js               ← Electron preload (contextBridge)
  index.html               ← Renderer entry point
  app.js                   ← Main renderer application logic
  styles.css               ← Global stylesheet
  sw.js                    ← PWA service worker (must be at scope root)
  manifest.webmanifest     ← PWA manifest
  app-icon.ico / .png      ← App icons
  pwa-icon.svg             ← PWA icon
  package.json             ← Electron-builder config

src/
  kalshi/                  ← Kalshi exchange integration
    kalshi-client.js           Combined REST + WS client facade
    kalshi-rest.js             REST API client (signed requests)
    kalshi-ws.js               WebSocket market data feed
    kalshi-ipc-bridge.js       Electron IPC ↔ Kalshi worker bridge
    kalshi-worker.js           Standalone Kalshi worker process
    kalshi-worker-client.js    Renderer-side worker client
    kalshi-renderer-bridge.js  Renderer bridge helper
    kalshi-prediction-enhancements.js  Signal enhancement layer
    kalshi-entry-logic.js      Entry qualification rules
    kalshi-sustenance-filter.js Risk / sustenance filter
    kalshi-shell-entry.js      CLI entry point
    kalshi-test-harness.js     Integration test helpers
    hourly-kalshi-tracker.js   Hourly market tracker

  engine/                  ← Core signal engine
    cfm-engine.js              CFM benchmark computation
    signal-router-cfm.js       Signal routing and dispatch
    prediction-markets.js      Market signal generation
    predictions.js             UP/DOWN prediction logic
    market-resolver.js         Market resolution handler
    orderbook.js               Order book state management
    floating-orchestrator.js   Dynamic orchestration layer
    MOMENTUM_INTEGRATION.js    Momentum signal integration
    pyth-momentum-exit.js      Pyth oracle momentum exits

  feeds/                   ← Real-time data feeds
    candle-ws.js               OHLCV WebSocket feed
    pyth-lazer-poller.js       Pyth Lazer REST poller
    pyth-lazer-websocket.js    Pyth Lazer WebSocket handler
    cex-flow.js                CEX order flow analysis
    social-sentiment.js        Social signal ingestion

  network/                 ← Network / proxy utilities
    proxy-fetch.js             Proxied HTTP fetch with port discovery
    throttled-fetch.js         Rate-limited fetch wrapper
    ws-proxy-server.js         Local WebSocket proxy server
    chain-router.js            Multi-chain routing layer
    blockchain-scan.js         Blockchain transaction scanner
    shell-router.js            CLI/shell routing helper

  data/                    ← Data persistence
    data.js                    Core data store
    data-logger.js             Structured file logger
    wallet-cache.js            Wallet data cache

  ui/                      ← UI components
    hourly-ranges-panel.js     Hourly ranges panel renderer
    tauri-bridge.js            Tauri desktop bridge stub

vendor/                    ← Bundled third-party chart libraries
  chart.umd.min.js
  chartjs-adapter-date-fns.bundle.min.js
  lightweight-charts.standalone.production.js

python/                    ← Standalone Python analytics layer
  kalshi_api.py                Kalshi REST client (RSA-signed)
  cfm_analysis.py              CFM momentum scoring & ranking
  backtest_runner.py           Historical backtest harness
  signal_evaluator.py          Live signal evaluation loop
  requirements.txt
  README.md

backtests/                 ← Backtest scripts (not in Electron build)
  backtest-1yr.js
  backtest-alltime.js
  backtest-diag.js
  backtest-runner.js

docs/                      ← Architecture and analysis documentation
  ARCHITECTURE.md            ← this file
  architecture.md
  orbital-model.md
  signal-engine.md
```

---

## Signal Pipeline

```
Real-time feeds (candle-ws, pyth-lazer, cex-flow, social-sentiment)
        │
        ▼
CFM Engine (cfm-engine.js)  ←─ Momentum (MOMENTUM_INTEGRATION, pyth-momentum-exit)
        │
        ▼
Prediction Engine (predictions.js, prediction-markets.js)
        │
        ▼
Kalshi Order Execution (kalshi-client → kalshi-rest / kalshi-ws)
        │
        ▼
UI Renderer (app.js, index.html)
```

---

## Electron Build

The packaged `.exe` is built with `npm run build` (electron-builder).

Key constraints:
- `main.js`, `preload.js`, `index.html`, `sw.js`, `manifest.webmanifest` must remain at root.
- `we-crypto-proxy.exe` is unpacked from the ASAR archive (`asarUnpack`).
- All `src/**/*` and `vendor/**/*` are included in the build via glob patterns.
- The Python layer (`python/`) is excluded from the Electron build and has no effect on it.
