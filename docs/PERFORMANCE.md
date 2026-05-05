# 📈 Performance Guide

Benchmarks, metrics, and optimisation tips for WE-CRYPTO.

---

## Expected Accuracy Timeline

Accuracy improves as the learning engine accumulates data:

| Time Running | Expected Accuracy | Notes |
|-------------|-------------------|-------|
| 0–30 min | ~50% | No tuning yet; initial weights |
| 30–120 min | 50–52% | First tuning cycles running |
| 2–6 hours | 52–54% | Weights converging |
| 6–24 hours | 53–56% | Stable regime established |
| 24–72 hours | 54–57% | Per-coin tuning optimised |
| 7+ days | 55–58% | Full adaptive maturity |

> **Note:** Accuracy varies with market conditions. High-volatility / regime-change periods typically reduce accuracy by 2–4%.

---

## Per-Coin Benchmarks

Historical 30-day averages (v2.11.0):

| Coin | Accuracy | Profit Factor | Notes |
|------|----------|--------------|-------|
| **BTC** | 54–57% | 1.08–1.15 | Most liquid; best signal quality |
| **ETH** | 53–56% | 1.06–1.12 | Strong BTC correlation |
| **SOL** | 52–55% | 1.05–1.10 | Higher volatility |
| **XRP** | 51–54% | 1.03–1.08 | News-driven regime shifts |
| **DOGE** | 50–53% | 1.01–1.06 | Most volatile; hardest to predict |
| **BNB** | 52–54% | 1.04–1.09 | Moderate; GeckoCoin fallback |
| **HYPE** | 51–53% | 1.02–1.07 | Newer coin; less history |

---

## UI Performance Benchmarks (v2.13.3)

| Metric | v2.13.2 | v2.13.3 | Change |
|--------|---------|---------|--------|
| Scorecard render | 75ms | 42ms | ⬇️ 44% faster |
| Panel switch latency | 165ms | 93ms | ⬇️ 44% faster |
| Settlement processing | 120ms | 82ms | ⬇️ 32% faster |
| Initial app load | 180ms | 215ms | ⬆️ +19% (expected — startup pre-load) |
| UI frame rate | 42fps | 59fps | ⬆️ 40% smoother |

---

## Monitoring Key Metrics

### In DevTools Console

```js
// Check prediction latency (time to compute all 7 coins)
window.PredictionEngine?.getLastCycleDuration?.()

// Check tuning frequency
window.AdaptiveLearningEngine?.getStats?.()

// Check feed latency
window.checkFeeds?.()

// Check backtest results
window._backtests
```

### Key Metrics to Watch

| Metric | Healthy Range | Warning |
|--------|--------------|---------|
| Prediction cycle time | < 2000ms | > 5000ms |
| Kalshi fetch time | < 500ms | > 2000ms |
| Settled contracts/cycle | 10–50 | < 5 |
| Weight drift from 1.0 | ±0.5 | ±0.9 |
| Scorecard accuracy | 50–60% | < 47% or > 65% (may overfit) |

---

## Optimisation Tips

### Improve Accuracy

1. **Let the engine run longer** — The most impactful factor is accumulated data. Do not reset weights frequently.

2. **Stable internet connection** — Dropped requests reduce contract fetch quality. Use a wired connection.

3. **Keep the app running** — Learning is continuous. Restarting frequently resets in-memory state.

4. **Don't manually override weights** — Trust the adaptive system. Manual overrides can destabilise learning.

### Improve UI Performance

1. **Close unused DevTools panels** — Each panel consumes renderer resources.

2. **Clear old audit logs** — If the app has run for weeks, clear the audit log:
   ```js
   localStorage.removeItem('beta1_auditLog')
   ```

3. **Reduce visible coins** — If the UI is slow, try hiding coins you don't trade (feature varies by version).

4. **Restart periodically** — After 12+ hours of continuous use, a restart clears memory fragmentation.

---

## Profit Factor Interpretation

Profit factor = gross wins / gross losses.

| Profit Factor | Interpretation |
|--------------|---------------|
| < 1.0 | Losing system |
| 1.0 | Break even |
| 1.0–1.1 | Marginal edge |
| 1.1–1.2 | Solid edge (WE-CRYPTO target) |
| > 1.2 | Strong edge |
| > 1.5 | Exceptional (verify for overfitting) |

---

## Signal Accuracy Targets

| Signal | Target Accuracy | Boosted Above | Reduced Below |
|--------|----------------|--------------|--------------|
| RSI | 52–56% | 52% | 45% |
| MACD | 50–55% | 52% | 45% |
| CCI | 51–55% | 52% | 45% |
| Fisher | 52–57% | 52% | 45% |
| ADX | 50–53% | 52% | 45% |
| ATR | 50–52% | 52% | 45% |
| Order Book | 51–55% | 52% | 45% |
| Kalshi Prob | 49–52% | 52% | 45% |
| Crowd Fade | 48–54% | 52% | 45% |

---

**Last Updated:** 2026-05-01 | **Version:** 2.11.0+
