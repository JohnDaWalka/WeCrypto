# 🚢 Deployment Guide

This guide covers building and deploying WE-CRYPTO for production use.

---

## Build Targets

| Command | Output | Use Case |
|---|---|---|
| `npm run build:portable` | `dist/WE-CRYPTO-*.exe` (portable) | Single-file, no install required |
| `npm run build:installer` | `dist/WE-CRYPTO-*-Setup.exe` | NSIS installer with shortcuts |
| `npm run build` | Both portable + installer | Full release build |

> **Important:** Close any running instance of WE-CRYPTO before building.  
> The previous `.exe` is **never overwritten** — each build creates a versioned artifact.

---

## Pre-Deployment Checklist

- [ ] `npm install` completed with no errors
- [ ] `KALSHI-API-KEY.txt` is present and credentials are valid
- [ ] `npm start` runs without console errors
- [ ] Kalshi balance is visible in the header badge
- [ ] Prediction cards populate within 30 s
- [ ] Accuracy scorecard shows data for at least one coin
- [ ] `window.Kalshi.getBalance()` returns a success response in DevTools
- [ ] Momentum exit integration initialises: `window.getMomentumDiagnostics()`

---

## Build Process

```bash
# 1. Install dependencies
npm install

# 2. Build portable executable
npm run build:portable

# 3. Verify output
ls dist/
# → WE-CRYPTO-Kalshi-15m-v*.exe
```

Build takes approximately 2–3 minutes on a typical workstation.

---

## Deployment Steps

### Windows (Portable)

1. Copy `dist/WE-CRYPTO-Kalshi-15m-v*.exe` to the target machine
2. Place `KALSHI-API-KEY.txt` in the **same folder** as the `.exe`
3. Double-click the `.exe` to launch
4. No installation or Node.js required on the target machine

### Windows (Installer)

1. Run `dist/WE-CRYPTO-*-Setup.exe` on the target machine
2. Follow the NSIS installer prompts
3. Place `KALSHI-API-KEY.txt` in the install directory
4. Launch via Start Menu shortcut `WE--CRYPTO--BETA3`

---

## Configuration Before Go-Live

1. Set Kalshi environment (demo vs production) in `KALSHI-API-KEY.txt` header
2. Review signal thresholds in [CONFIGURATION.md](./CONFIGURATION.md)
3. Run the 8-level checkpoint framework: [CRITICAL_CHECKPOINTS.md](./CRITICAL_CHECKPOINTS.md)

---

## Monitoring in Production

```javascript
// Run in DevTools console to monitor health every 60 s
setInterval(async () => {
  const balance = await window.Kalshi.getBalance()
  const preds   = Object.keys(window._predictions).length
  console.log(`[Health] balance=${balance.data?.balance} predictions=${preds}`)
}, 60_000)
```

Key metrics to watch:
- **Kalshi balance** — should not change unexpectedly
- **Win rate** in the Accuracy Scorecard — target ≥55%
- **Active positions** via `window.getMomentumDiagnostics()`
- **Adaptive weights** drift via `window.AdaptiveLearningEngine.status()`

---

## Rolling Back

Each build produces a uniquely versioned `.exe`. To roll back:

1. Stop the current instance
2. Launch the previous versioned `.exe` from the same `dist/` folder
3. Calibration weights are stored in `localStorage` (tied to the machine, not the build)

---

## Phase-Based Rollout (Recommended)

| Phase | Contracts/trade | Monitoring |
|---|---|---|
| **Phase 1 — Micro** | 1–5 | Monitor every trade |
| **Phase 2 — Normal** | 20–50 | Daily review |
| **Phase 3 — Full** | Up to limit | Weekly review |

Stay in Phase 1 for at least 50 trades before advancing.

---

## Further Reading

- [CRITICAL_CHECKPOINTS.md](./CRITICAL_CHECKPOINTS.md) — 8-level pre-launch test suite
- [CONFIGURATION.md](./CONFIGURATION.md) — all tuning parameters
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — common deployment issues
- [PERFORMANCE.md](./PERFORMANCE.md) — expected accuracy benchmarks
