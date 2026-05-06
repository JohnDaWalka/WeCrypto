# 🛠️ Development Setup

How to set up a local development environment for WE-CRYPTO.

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 18 LTS+ | Runtime & build toolchain |
| npm | 9+ | Package manager |
| Git | 2.x | Version control |
| Windows 10/11 x64 | — | Electron targets Windows |
| VS Code (recommended) | Latest | Editor with Electron debugging |

---

## Initial Setup

```bash
# 1. Clone the repo
git clone https://github.com/JohnDaWalka/WE-CFM-Orchestrator.git
cd WE-CFM-Orchestrator

# 2. Install all dependencies
npm install

# 3. (Optional) Install Tauri CLI for the Tauri build target
npm install -g @tauri-apps/cli
```

---

## Running in Development Mode

```bash
npm start
```

This launches Electron with live renderer. Changes to files in `src/` and `public/` are reflected on reload (`Ctrl+R`).

> The renderer does **not** hot-reload automatically. Press `Ctrl+R` in the app window after saving files.

---

## Project Structure

```
WE-CFM-Orchestrator/
├── electron/           Electron main process & IPC
│   ├── main.js         Entry point, process lifecycle
│   ├── preload.js      contextBridge (renderer ↔ main)
│   └── kalshi-worker.js  Standalone Kalshi HTTP server
├── public/             Renderer HTML + script load order
│   └── index.html      Script tags = dependency graph
├── src/
│   ├── core/           Predictions, adaptive tuner, app
│   ├── kalshi/         Kalshi integration modules
│   └── ui/             Floating orchestrator, views
├── assets/             Icons
├── docs/               Documentation
├── tests/              Test scripts
└── package.json        Build config + scripts
```

---

## Key Conventions

### Script Load Order

`public/index.html` defines the **dependency graph** via `<script>` tag ordering.  
Startup/calibration scripts load before `app.js`. This order is operationally significant — do not reorder without understanding the dependency chain.

### Global Runtime Contract

Modules expose their APIs on `window` (e.g. `window.PredictionMarkets`, `window.KalshiOrchestrator`).  
Use this pattern when adding cross-module integrations — do **not** use ES module imports in the renderer.

### localStorage Namespace

All persistent state uses the `beta1_*` prefix.  
Never rename existing keys as this breaks calibration compatibility.

### Coin Universe

The canonical coin list is `BTC, ETH, SOL, XRP, DOGE, BNB, HYPE`.  
Adding or removing coins requires changes across: `predictions.js`, Kalshi mapping, orchestrator, and UI tables.

---

## Debugging

### Electron DevTools

```
F12  →  DevTools opens in the renderer
Ctrl+Shift+I  →  Toggle DevTools
```

The renderer has full access to the browser DevTools including Network, Performance, and Memory tabs.

### Main Process Logs

```bash
npm start
# Main process logs appear in the terminal
```

### Attach VS Code Debugger

Add to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Main Process",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "args": [".", "--inspect=9229"],
      "sourceMaps": true
    }
  ]
}
```

---

## Running Tests

See [TESTING.md](./TESTING.md) for a full guide. Quick reference:

```bash
node test-integration.js
node test-snapshot-tuner.js
node test-realtime-tuner.js
node test-signal-logic-audit.js
node tests/test-live-feeds.js        # requires proxy on :3010
node tests/test-api-status.js
```

---

## Build

```bash
npm run build:portable   # Portable .exe
npm run build:installer  # NSIS installer
npm run build            # Both
```

---

## Code Style

- **No linter is configured** — match the style of the file you are editing
- Prefer `const` / `let` over `var`
- IIFEs are used throughout the renderer; new modules should follow this pattern
- Comments should explain *why*, not *what*

---

## Further Reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system design
- [TESTING.md](./TESTING.md) — writing and running tests
- [CONFIGURATION.md](./CONFIGURATION.md) — tuneable parameters
