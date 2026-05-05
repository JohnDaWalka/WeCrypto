# 🛠️ Development Setup

How to set up a local development environment for WE-CRYPTO.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 18+ | v20 LTS recommended |
| npm / pnpm | 8+ | Either works |
| Git | Any | For cloning and branching |
| Windows 10/11 | — | Required for Electron + .exe builds |
| VS Code | Recommended | With ESLint extension |

---

## Initial Setup

```bash
# 1. Clone the repo
git clone https://github.com/JohnDaWalka/WE-CFM-Orchestrator.git
cd WE-CFM-Orchestrator

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
# Edit .env with your API credentials

# 4. Start in development mode
npm start
```

This launches Electron with DevTools enabled.

---

## Project Structure

```
WE-CFM-Orchestrator/
├── electron/               ← Electron main process
│   ├── main.js             ← App entry point (boots proxy, Kalshi worker, renderer)
│   ├── kalshi-worker.js    ← Kalshi Node.js worker (port 3050)
│   └── wecrypto-web-service.js  ← Optional web mirror (port 3443)
├── public/
│   └── index.html          ← Renderer boot chain (script order matters!)
├── src/
│   ├── core/
│   │   ├── app.js          ← UI orchestrator and composition layer
│   │   └── predictions.js  ← Prediction engine
│   ├── kalshi/
│   │   ├── prediction-markets.js  ← Kalshi + Polymarket data
│   │   └── wecrypto-startup-loader.js  ← Startup recovery
│   ├── ui/
│   │   └── floating-orchestrator.js  ← EV engine + trade intents
│   └── ...                 ← Other modules
├── docs/                   ← Documentation (you are here)
├── tests/                  ← Test scripts
├── electron/               ← Electron main process files
└── package.json
```

---

## Key Architecture Conventions

> Read these carefully before making changes — they are load-order critical.

### 1. Script Load Order

`public/index.html` loads scripts in a specific order. **This order is a dependency graph.**

- Startup/calibration modules load **before** `app.js`
- `prediction-markets.js` loads **before** `market-resolver.js` which loads **before** `app.js`
- Do not reorder script tags without understanding the dependency chain

### 2. Global Window APIs

Modules expose their APIs on `window`, not as ES module exports. Example:

```js
// predictions.js
window.PredictionEngine = { ... }

// prediction-markets.js
window.PredictionMarkets = { ... }

// app.js consumes them:
const engine = window.PredictionEngine
```

**Preserve this pattern** when adding cross-module integrations.

### 3. Coin Universe

The canonical coin list is fixed across many modules:

```
BTC, ETH, SOL, XRP, DOGE, BNB, HYPE
```

Adding or removing a coin requires synchronised updates in: predictions, Kalshi mapping, orchestrator, and UI tables.

### 4. localStorage Keys

All persisted state uses the `beta1_*` prefix. **Do not rename these keys.**

---

## Development Workflow

```bash
# Start with hot-reload (Electron DevTools available)
npm start

# Make changes to src/ files
# Reload the renderer: Ctrl+Shift+R (or restart app for main process changes)

# Run tests
node test-integration.js
node test-signal-logic-audit.js

# Build for testing
npm run build:portable
```

---

## Debugging

### Renderer (UI) Debugging

Open DevTools with `F12` or from the View menu.

```js
// Inspect module state
window.PredictionEngine
window.PredictionMarkets
window.KalshiOrchestrator
window._predictions
window._backtests
```

### Main Process Debugging

Main process logs appear in the terminal where you ran `npm start`.

To add VS Code debugging, create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Main Process",
      "program": "${workspaceFolder}/electron/main.js",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "windows": {
        "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron.cmd"
      }
    }
  ]
}
```

---

## Making Changes

### Adding a New Signal

1. Implement the signal function in `src/core/predictions.js`
2. Add it to the `buildSignalModel()` layer aggregation
3. Add its default weight in `CONFIGURATION.md` and `AdaptiveLearningEngine`
4. Update `SIGNALS.md` documentation
5. Add a test in `test-signal-logic-audit.js`

### Adding a New Coin

1. Add to the coin list in `predictions.js`
2. Add Kalshi contract mapping in `prediction-markets.js`
3. Add to orchestrator coin list in `floating-orchestrator.js`
4. Add to UI tables in `app.js`

---

## Contributing

See [../CONTRIBUTING.md](../CONTRIBUTING.md) for contribution guidelines.

---

**Last Updated:** 2026-05-01 | **Version:** 2.11.0+
