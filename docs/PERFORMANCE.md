# 📊 Performance Reference

Expected accuracy, per-coin benchmarks, and optimisation tips for WE-CRYPTO.

---

## Baseline vs Target Accuracy

| State | Win Rate | Notes |
|---|---|---|
| **Cold start** (no data) | ~50 % | Random baseline |
| **After 50 contracts** | 55–60 % | Weights starting to calibrate |
| **Steady state (> 200)** | 60–68 % | Adaptive learning in full effect |
| **Target (quantum spin)** | 65–72 % | With Kalshi fusion + regime filters |

> Accuracy is measured as: `correct settlements / total settled predictions`

---

## Per-Coin Benchmarks (v2.13.3)

| Coin | Baseline WR | Target WR | Kalshi Alignment |
|---|---|---|---|
| BTC | 56 % | 65 % | High (liquid market) |
| ETH | 54 % | 63 % | High |
| SOL | 52 % | 61 % | Medium |
| XRP | 51 % | 60 % | Medium |
| DOGE | 49 % | 57 % | Low |
| BNB | 50 % | 58 % | Low |
| HYPE | 48 % | 55 % | Very low |

---

## Accuracy by Spin State

| Spin State | Label | Target Win Rate |
|---|---|---|
| ±3 | Strong Bear / Bull | > 75 % |
| ±2 | Bear / Bull | > 65 % |
| ±1 | Weak Bear / Bull | > 55 % |
| 0 | Neutral | No trade |

Avoid trading spin ±1 in tight (choppy) regimes — the system auto-filters these.

---

## Improvement Factors

| Factor | Expected WR Lift |
|---|---|
| 7-state quantisation | +5–8 % |
| Kalshi fusion | +10–15 % |
| Volatility regime filters | +5 % |
| Signal consensus scoring | +3–5 % |
| Dynamic order sizing | +2–3 % |
| Choppy market filter | +2–3 % |

---

## Render Performance (v2.13.3 benchmarks)

| Metric | v2.13.2 | v2.13.3 | Δ |
|---|---|---|---|
| Scorecard render | 75 ms | 42 ms | ⬇️ 44 % |
| Panel switch latency | 165 ms | 93 ms | ⬇️ 44 % |
| Settlement processing | 120 ms | 82 ms | ⬇️ 32 % |
| Initial app load | 180 ms | 215 ms | ⬆️ +19 % (expected — pre-loads cache) |
| UI frame rate | 42 fps | 59 fps | ⬆️ 40 % |

---

## Expected Timeline to Steady State

```
Day 1     : Cold start, ~50% win rate, weights at baseline
Day 2-3   : 50+ contracts settled, first meaningful calibration
Day 5-7   : 200+ contracts, weights stable, 58-62% typical
Week 2+   : Full regime history, 62-68% achievable
```

---

## Optimisation Tips

### Improve Accuracy

1. **Run the full startup sequence** — let the app run for 30+ minutes before evaluating accuracy
2. **Monitor regime transitions** — accuracy dips during regime changes (tight→trending) are normal
3. **Check for inversions** — `window.KalshiAccuracyDebug.findInversions()` detects systematic sign errors
4. **Use Phase 1 (micro trades)** for the first 50 contracts to validate signal quality

### Reduce Latency

1. Ensure `KALSHI-API-KEY.txt` is on the same drive as the `.exe`
2. The contract cache saves to `D:` and `F:` drives automatically; prefer fast drives
3. Close other Electron apps that may compete for Chromium GPU resources

### Memory Footprint

```javascript
// Check current memory
performance.memory
// → { usedJSHeapSize: ..., totalJSHeapSize: ..., jsHeapSizeLimit: ... }
```

Normal operating range: 100–250 MB. Restart if over 500 MB.

---

## Historical Performance Logs

Detailed per-release performance data:

- [PERFORMANCE-ANALYSIS-v2.13.3.md](./PERFORMANCE-ANALYSIS-v2.13.3.md) — v2.13.3 profiling
- [ACCURACY-TRENDING-v2.13.3.md](./ACCURACY-TRENDING-v2.13.3.md) — accuracy trend analysis
- [BACKTEST-2DAY-ANALYSIS-59pct.md](./BACKTEST-2DAY-ANALYSIS-59pct.md) — 2-day backtest at 59 %

---

## Further Reading

- [LEARNING-ENGINE.md](./LEARNING-ENGINE.md) — how weights are adapted
- [CONFIGURATION.md](./CONFIGURATION.md) — gate thresholds
- [SIGNALS.md](./SIGNALS.md) — per-indicator accuracy contribution
