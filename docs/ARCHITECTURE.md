# 🏗️ System Architecture

> For the full visual component map see [architecture.md](./architecture.md) and for the deepest layer-by-layer breakdown see [DEEP_ARCHITECTURE_ANALYSIS.md](./DEEP_ARCHITECTURE_ANALYSIS.md).

---

## Overview

WE-CRYPTO is an Electron desktop application that pairs a real-time crypto prediction engine (CFM) with Kalshi prediction-market integration.  
The system is built around three orthogonal concerns:

| Layer | Role |
|---|---|
| **Electron shell** | Process management, native file I/O, IPC bridging |
| **Prediction engine** | Signal computation, adaptive learning, Kalshi fusion |
| **UI / renderer** | Dashboard, scorecard, orchestrator panels |

---

## Process Map

```
┌──────────────────────────────────────────────────────────┐
│  Electron Main Process  (electron/main.js)               │
│                                                          │
│  ┌─────────────────┐   ┌───────────────────────────┐    │
│  │  Rust Proxy exe │   │  Kalshi Worker  (Node.js)  │    │
│  │  port 3010      │   │  port 3050                │    │
│  └────────┬────────┘   └────────────┬──────────────┘    │
│           │  IPC                    │  HTTP             │
│  ┌────────▼────────────────────────▼──────────────┐     │
│  │            Renderer (Chromium)                  │     │
│  │  public/index.html  →  src/core/app.js          │     │
│  │  prediction-markets.js · predictions.js         │     │
│  │  floating-orchestrator.js · ui modules          │     │
│  └─────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

---

## Boot Sequence

1. `electron/main.js` spawns **we-crypto-proxy.exe** (port 3010 cascade)
2. Main process spawns **kalshi-worker.js** (port 3050) and waits for `/health`
3. BrowserWindow loads `public/index.html`
4. Scripts execute in order:  
   calibration → infra → feed → orbital → Kalshi → `src/core/app.js`
5. `wecrypto-startup-loader.js` restores adaptive weights + contract cache in `<100 ms`
6. Live polling loops begin (30 s prediction cycle, 15 s momentum, 5 s balance)

---

## Prediction Pipeline

```
Exchange Candles (Coinbase OHLCV)
         │
         ▼
   predictions.js
   ├─ RSI / MACD / CCI / Fisher / ADX / ATR
   ├─ Order-book imbalance
   ├─ Kalshi probability fusion
   └─ Multi-horizon scoring (5m · 15m · 1h)
         │
         ▼
   prediction-markets.js  (polls every 30 s)
   ├─ Kalshi 15m markets
   ├─ Kalshi 5m markets
   └─ Polymarket fusion
         │
         ▼
   floating-orchestrator.js
   └─ EV-based trade intents → window.KalshiOrchestrator
```

---

## Three-Layer Adaptive Learning

| Layer | Frequency | What it adjusts |
|---|---|---|
| Real-Time | 30 s | Gate thresholds ±4–8% |
| Snapshot | 1 h | Signal weights ±8% |
| Walk-Forward | Daily | 14-day baseline optimisation |

Weight deltas are persisted to `localStorage` under the `beta1_*` namespace and restored by `adaptive-weight-restorer.js` on next startup.

---

## Key Files

| File | Purpose |
|---|---|
| `electron/main.js` | Process lifecycle, IPC handlers |
| `electron/kalshi-worker.js` | Standalone Kalshi HTTP server (port 3050) |
| `public/index.html` | Script load order (dependency graph) |
| `src/core/app.js` | Renderer orchestration, view routing |
| `src/core/predictions.js` | Signal computation + backtest engine |
| `src/kalshi/prediction-markets.js` | Kalshi/Polymarket polling + fusion |
| `src/ui/floating-orchestrator.js` | EV-based trade intents |
| `src/kalshi/wecrypto-startup-loader.js` | Boot-time calibration restore |

---

## Further Reading

- [SIGNALS.md](./SIGNALS.md) — per-indicator deep dive
- [LEARNING-ENGINE.md](./LEARNING-ENGINE.md) — adaptive tuning algorithm
- [DEEP_ARCHITECTURE_ANALYSIS.md](./DEEP_ARCHITECTURE_ANALYSIS.md) — layer-by-layer analysis
- [diagrams.md](./diagrams.md) — Mermaid component diagrams
- [KALSHI_WORKER_GUIDE.md](./KALSHI_WORKER_GUIDE.md) — Kalshi worker quick-start
