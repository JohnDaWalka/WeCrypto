# 📱 Dashboard Guide

This guide explains every panel and indicator visible in the WE-CRYPTO UI.

---

## Layout Overview

```
┌─────────────────────────────────────────────────────┐
│  Header bar                  [Kalshi Balance badge]  │
├──────────────────────┬──────────────────────────────┤
│  Prediction Cards    │  Accuracy Scorecard           │
│  (per coin)          │  (portfolio win rate)         │
├──────────────────────┼──────────────────────────────┤
│  Trending Analysis   │  Debug / Diagnostics panel   │
│                      │  (bottom-right, collapsible) │
└──────────────────────┴──────────────────────────────┘
```

---

## Prediction Cards

Each coin (BTC, ETH, SOL, XRP, DOGE, BNB, HYPE) gets its own card showing:

| Field | Description |
|---|---|
| **Direction** | `UP ▲` or `DOWN ▼` for the next 15-minute window |
| **Confidence** | 0–100 % signal strength |
| **Spin State** | −3 (Strong Bear) to +3 (Strong Bull) |
| **Kalshi Odds** | Live YES price from Kalshi market |
| **EV** | Expected value of a YES/NO trade |

### Confidence Colour Scale

| Range | Colour | Meaning |
|---|---|---|
| 80–100 % | 🟢 Green | High conviction |
| 60–79 % | 🟡 Yellow | Moderate conviction |
| 40–59 % | 🟠 Orange | Weak signal |
| 0–39 % | 🔴 Red | Below execution threshold |

---

## Accuracy Scorecard

Located top-right. Updated every 30 seconds as contracts settle.

| Column | Description |
|---|---|
| **Coin** | Symbol |
| **Win Rate** | % of settled predictions that were correct |
| **Trades** | Number of settled contracts evaluated |
| **Trend** | ↑ improving / ↓ declining over last 10 settlements |

**Portfolio Win Rate** (header number) = average win rate across all active coins.

---

## Trending Analysis

Shows whether the model is improving or declining over recent cycles:

- **Green banner** — win rate rising (system is adapting positively)
- **Red banner** — win rate falling (automatic re-calibration triggered)
- **Neutral** — stable within normal variance

---

## Kalshi Balance Badge

Top-right corner. Shows live Kalshi account balance polled every 5 seconds.  
Pulses briefly when the balance changes.

---

## Debug / Diagnostics Panel

Bottom-right, collapsible. Available in development mode or when DevTools is open.

```javascript
// Access programmatically
window.__WECRYPTO_STARTUP.getLog()         // Startup timeline
window.KalshiAccuracyDebug.scorecard('BTC') // Per-coin accuracy
window.AdaptiveLearningEngine.status()     // Current weights
window.getMomentumDiagnostics()            // Active positions
```

---

## Status Indicators

| Indicator | Location | Meaning |
|---|---|---|
| 🟢 Live | Top bar | Prediction loop running |
| 🟡 Syncing | Top bar | Fetching fresh settlement data |
| 🔴 Offline | Top bar | Proxy or feed connection lost |
| ⚙️ Tuning | Top bar | Walk-forward tuning cycle in progress |

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `F12` | Open DevTools |
| `Ctrl+R` | Reload renderer |
| `Ctrl+Shift+I` | Toggle DevTools |

---

## Further Reading

- [SIGNALS.md](./SIGNALS.md) — what each indicator means
- [LEARNING-ENGINE.md](./LEARNING-ENGINE.md) — how win rates are computed
- [API.md](./API.md) — all console commands
