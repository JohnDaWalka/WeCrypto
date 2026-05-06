# ⚙️ Configuration Reference

All tuneable parameters, environment variables, and settings for WE-CRYPTO.

---

## Kalshi Credentials

**File:** `KALSHI-API-KEY.txt` (project root, never committed)

```
<api-key-id-uuid>



-----BEGIN RSA PRIVATE KEY-----
<RSA-2048 private key>
-----END RSA PRIVATE KEY-----
```

Lines 2–4 are empty; the RSA key begins on line 5.

---

## Worker CLI Flags

The Kalshi worker (`electron/kalshi-worker.js`) accepts these flags when run standalone:

| Flag | Default | Description |
|---|---|---|
| `--port` | `3050` | HTTP port for the worker |
| `--env` | `production` | `production` or `demo` |
| `--file` | `KALSHI-API-KEY.txt` | Path to credentials file |

```bash
node kalshi-worker.js --port 3050 --env production
```

---

## Proxy Port

The Rust proxy (`we-crypto-proxy.exe`) cascades through ports starting at **3010**.  
If 3010 is in use it tries 3011, 3012, etc. No configuration required.

---

## localStorage Keys (`beta1_*` namespace)

All persistent state uses the `beta1_` prefix for compatibility. **Do not rename these keys.**

| Key | Description |
|---|---|
| `beta1_adaptive_weights` | Per-coin signal weights (JSON) |
| `beta1_gate_thresholds` | Per-coin entry gate values |
| `beta1_accuracy_history` | Rolling accuracy log |
| `beta1_contract_cache` | Settled Kalshi contracts |

```javascript
// Read current weights
JSON.parse(localStorage.getItem('beta1_adaptive_weights'))

// Reset a specific coin's weights
localStorage.removeItem('beta1_adaptive_weights')  // will be recreated on next startup
```

---

## Adaptive Tuner Bounds

Signal gate thresholds are constrained per-coin to prevent runaway tuning:

| Coin | Min Gate | Baseline | Max Gate |
|---|---|---|---|
| BTC | 0.15 | 0.19 | 0.25 |
| ETH | 0.18 | 0.22 | 0.28 |
| XRP | 0.26 | 0.30 | 0.38 |
| SOL | 0.24 | 0.28 | 0.35 |
| BNB | 0.26 | 0.30 | 0.40 |

These values live in `src/core/adaptive-tuner.js`.

---

## Tuning Rules

| Rule | Condition | Action |
|---|---|---|
| 1 | `winRate < 40 %` | Tighten gate +0.03 |
| 2 | `winRate > 55 %` | Relax gate −0.02 |
| 3 | `falsePositiveRate > 50 %` | Tighten gate +0.02 |
| 4 | `volatility > 0.7` | Tighten gate (conservative) |

---

## Volatility Regimes

The signal behaviour changes based on ATR percentage:

| Regime | ATR % | Behaviour |
|---|---|---|
| Tight / Choppy | < 0.3 % | Entry threshold +40 %; weak signals filtered |
| Normal | 0.3–0.8 % | Standard parameters |
| Elevated | 0.8–1.5 % | Slightly more aggressive |
| Extreme | > 1.5 % | Very conservative; confidence cap reduced |

---

## Execution Sizing

Order size is dynamic:

```
size = baseSize × spinMultiplier × blendingMultiplier × regimeMultiplier
```

| Parameter | Location |
|---|---|
| `baseSize` | Hardcoded in `floating-orchestrator.js` |
| `spinMultiplier` | `kalshi-prediction-enhancements.js` SPIN_STATES table |
| `blendingMultiplier` | Agreement between CFM and Kalshi ±25 % |
| `regimeMultiplier` | Volatility regime table |

---

## Polling Intervals

| Loop | Interval | File |
|---|---|---|
| Prediction cycle | 30 s | `src/core/predictions.js` |
| Kalshi 15m markets | 30 s | `src/kalshi/prediction-markets.js` |
| Momentum exit check | 15 s | `pyth-momentum-exit.js` |
| Kalshi balance | 5 s | `src/core/app.js` |
| Auto-tune | 120 s | `src/core/adaptive-tuner.js` |
| Walk-forward tune | Daily | `src/core/adaptive-tuner.js` |

---

## Further Reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how components use these settings
- [LEARNING-ENGINE.md](./LEARNING-ENGINE.md) — adaptive tuning deep dive
- [ADAPTIVE_TUNING_GUIDE.md](./ADAPTIVE_TUNING_GUIDE.md) — walk-forward integration guide
