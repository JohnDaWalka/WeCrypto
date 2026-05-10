# Quantitative Core Integration Guide

## Overview

The quantitative core consists of 7 production-grade statistical modules for the 15-minute binary prediction engine. These modules enable regime detection, signal calibration, drift monitoring, and performance analysis.

## Module Stack

### 1. **Statistical Utils** (`src/quant/statistical-utils.js`)

Foundation library with 14 utility functions:

- **Isotonic Regression** — monotone increasing regression for confidence calibration
- **PSI (Population Stability Index)** — distribution shift detection (threshold: 0.1)
- **KL Divergence** — asymmetric distance between distributions
- **Entropy** — market uncertainty quantification
- **Percentiles, Moving Averages, Z-score** — standard operations
- **Correlation, Covariance** — feature relationships
- **ADWIN Detector** — adaptive windowing drift detector
- **Q-Q Stats** — normality testing (skewness, kurtosis)

**Usage:**

```javascript
// PSI drift detection
const psi = window.QuantStatUtils.populationStabilityIndex(baseline, actual, 10);
if (psi > 0.1) console.log('DRIFT DETECTED');

// Isotonic calibration
const iso = window.QuantStatUtils.isotonicRegression(confidences, outcomes);
```

---

### 2. **HMM Regime Classifier** (`src/quant/hmm-regime-classifier.js`)

4-state Hidden Markov Model for market regimes.

**States:**

- `CHOP` — low volatility, choppy (mean-revert favorable)
- `TREND` — high momentum, sustained direction
- `CASCADE` — sharp down with high volume (liquidation)
- `MANIA` — speculative top, extreme long bias

**Input Features:** `returns`, `volatility`, `orderflow_imbalance`, `funding_rate`

**Output:** Regime classification + confidence + state probabilities + Viterbi path

**Key Methods:**

```javascript
const hmm = new HMMRegimeClassifier();

// Add observations
const obsSeq = [
  { returns: 0.008, vol: 0.012, orderflow: 0.30, fundingRate: 0.0002 },
  // ...
];

// Classify
const result = hmm.classify(obsSeq);
// { regime: 'TREND', confidence: 0.87, state_probs: [0.05, 0.87, 0.05, 0.03], ... }

// Baum-Welch EM refinement
hmm.baumWelch(obsSeq, 5);  // 5 iterations

// Transition analysis
const analysis = hmm.transitionAnalysis(obsSeq);
// { transition_matrix, state_durations, avg_durations }
```

**Integration with predictions.js:**

```javascript
// In predictions.js signal computation
const regime = window.HMMRegimeClassifier.classify(recent_obs).regime;
const regimeGate = regime === 'TREND' ? 1.5 : (regime === 'CHOP' ? 0.7 : 1.0);
rsiScore *= regimeGate;
macdScore *= regimeGate;
```

---

### 3. **Kalman Filter** (`src/quant/kalman-filter.js`)

State-space model separating latent trend from observation noise.

**State:** `[level (trend), velocity (rate of change)]`

**Key Methods:**

```javascript
const kf = new KalmanFilter({
  process_noise: [[0.01, 0], [0, 0.001]],
  observation_noise: 0.1,
});

// Process observations
const result = kf.process(pricesSeries);
// { levels, velocities, innovations, state_means }

// Adaptive noise tuning
kf.tuneNoise();  // Auto-scales Q, R based on innovation stats

// Signal-to-noise ratio (diagnostic)
const snr = kf.getSnr();  // dB, higher = cleaner extraction
```

**Integration Point:**
Use extracted `levels` instead of raw price for momentum signal comparison.

---

### 4. **Hurst Exponent** (`src/quant/hurst-exponent.js`)

Trend vs Mean-Reversion classifier via Rescaled Range Analysis.

**Classification:**

- `H > 0.6` — **TREND** (momentum favorable)
- `H < 0.4` — **MEAN_REVERT** (mean-reversion favorable)
- `0.4 ≤ H ≤ 0.6` — **RANDOM** (balanced)

**Key Methods:**

```javascript
const hurst = new HurstExponent({ min_window: 20, max_window: 200 });

// Single computation
const h = hurst.rolling(priceSeries, 50);

// Multi-scale analysis
const multi = hurst.multiScale(priceSeries, [10, 20, 50, 75, 100]);
// { hurst_by_lag, dominant_hurst, lag_distribution }

// Classify with signal gating
const class = hurst.classify(h);
// {
//   regime: 'TREND',
//   strength: 0.75,
//   signal_gate: { rsi_weight: 1.3, macd_weight: 1.2, fisher_weight: 0.7, ... }
// }

// Drift detection
const trend = hurst.trend(priceSeries, 50);
// { current, older, trend, volatility, drift_score }
```

**Integration:** Gate signals based on Hurst regime classification.

---

### 5. **Calibration Analyzer** (`src/quant/calibration-curve.js`)

Isotonic regression for confidence → win-rate mapping.

**Detects:**

- Overconfidence patterns (pred_conf >> actual_wr)
- Underconfidence
- Per-regime calibration quality

**Key Methods:**

```javascript
const cal = new CalibrationAnalyzer();

// Add predictions (recorded at execution time)
cal.add(0.72, 1, { regime: 'TREND', coin: 'BTC' });
cal.add(0.55, 0, { regime: 'CHOP', coin: 'ETH' });

// Fit isotonic model
cal.fit(30);  // require min 30 samples

// Get metrics
const metrics = cal.metrics;
// {
//   calibration_error: 0.082,
//   brier_score: 0.091,
//   win_rate_by_confidence: [ { bin: 0, avg_confidence: 0.05, win_rate: 0.48, ... }, ... ],
//   overconfidence: { detected: true, regions: [...] }
// }

// Apply calibration to raw confidence
const calibrated = cal.calibrate(rawConfidence);

// Regime-specific analysis
const trendCal = cal.regimeCalibration('TREND');
// { regime, samples, avg_confidence, win_rate, calibration_error, under_over_confident }

// Overall calibration score (0-100)
const score = cal.calibrationScore();  // 100 = perfect, <50 = poor
```

---

### 6. **Drift Detector** (`src/quant/drift-detector.js`)

Multi-method distribution shift detection (PSI, KL, ADWIN, K-S).

**Features Monitored:** returns, volatility, orderflow_imbalance, volume_ratio, funding_rate, skewness

**Thresholds:**

- PSI > 0.1 → significant shift
- PSI > 0.25 → major shift
- KL divergence > 0.05 → alert
- K-S > 0.15 → significant difference

**Key Methods:**

```javascript
const drift = new DriftDetector({
  features: ['returns', 'volatility', 'orderflow_imbalance', 'funding_rate'],
  baseline_window: 100,
  monitor_window: 50,
  psi_threshold: 0.1,
  kl_threshold: 0.05,
});

// Feed observations
drift.observe({ returns: 0.008, volatility: 0.012, orderflow_imbalance: 0.30, ... });

// Get per-feature status
const btcStatus = drift.getStatus('returns');
// {
//   feature: 'returns',
//   status: 'STABLE' | 'WARNING' | 'DRIFT_DETECTED',
//   psi: 0.082,
//   kl: 0.034,
//   ks: 0.08,
//   baseline_mean, current_mean, baseline_std, current_std
// }

// Overall status
const overall = drift.overallStatus();
// { features: [...], drift_count, warning_count, overall_status, recent_alerts }
```

---

### 7. **Winrate Segmentation** (`src/quant/winrate-segmentation.js`)

Performance analysis by regime, confidence, coin, exchange lead.

**Key Methods:**

```javascript
const seg = new WinRateSegmentation();

// Add prediction records
seg.add({
  prediction: 'UP',
  outcome: 'UP',
  confidence: 0.72,
  regime: 'TREND',
  coin: 'BTC',
  exchange_lead: { BTC: 0.62, ETH: 0.55 },
  horizon: 15,
});

// Segment by dimension
const byRegime = seg.segments.by_regime;
// {
//   TREND: { count: 145, wins: 98, win_rate: 0.676, edge: 0.352, ... },
//   CHOP: { count: 89, wins: 41, win_rate: 0.461, edge: -0.078, ... },
//   ...
// }

// Get comparison tables
const comparison = seg.comparisonTable('regime');
// [
//   { segment: 'TREND', win_rate: 0.676, edge: 0.352, significant: true, pvalue: 0.003 },
//   ...
// ]

// Find underperforming segments
const underperf = seg.underperformingSegments(0.45);
// [
//   { segment: 'CASCADE', win_rate: 0.38, recommendation: 'reduce_size_or_skip' },
//   ...
// ]

// Exchange lead analysis
const exchange = seg.segments.by_exchange;
// { aligned: { ... }, opposed: { ... }, independence: { ... } }
```

---

### 8. **Trade Journal** (`src/quant/trade-journal.js`)

JSONL trade recording with persistence to localStorage + multi-drive cache.

**Trade Schema:**

```javascript
{
  id: "TRD_1715000000000_abc123",
  timestamp: 1715000000000,
  timestamp_iso: "2025-05-06T12:00:00Z",
  asset: "BTC",
  prediction: "UP",
  confidence: 0.72,
  regime: "TREND",
  signals: { rsi: 0.65, macd: 0.58, fisher: 0.72, ... },
  market_state: { price: 65000, volume: 1200, bid_ask_spread: 2.5, ... },
  fill_price: 64995,
  close_price: 65120,
  outcome: "UP",
  settled: true,
  win: 1,
  metadata: { ... }
}
```

**Key Methods:**

```javascript
const journal = new TradeJournal({ max_trades: 10000 });

// Record trade at execution
const tradeId = journal.recordTrade({
  asset: 'BTC',
  prediction: 'UP',
  confidence: 0.72,
  regime: 'TREND',
  signals: { rsi: 0.65, macd: 0.58, ... },
  market_state: { price: 65000, volume: 1200, ... },
  fill_price: 64995,
});

// Update with settlement (30s later after contract closes)
journal.updateTrade(tradeId, {
  close_price: 65120,
  outcome: 'UP',
  settled: true,
});

// Summary stats
const summary = journal.summary();
// {
//   trades_settled: 247,
//   win_rate: 0.621,
//   profit_factor: 1.59,
//   pnl: 34,
//   avg_confidence_winners: 0.68,
//   avg_confidence_losers: 0.55,
//   confidence_edge: 0.13
// }

// Asset-specific summary
const btcSummary = journal.assetSummary('BTC');
// { asset: 'BTC', trades: 82, wins: 54, win_rate: 0.659, ... }

// Export JSONL / CSV
const jsonl = journal.exportJsonl();
const csv = journal.exportCsv();
```

---

## Integration with Predictions.js + App.js

### Step 1: Load Modules in HTML

Add to `public/index.html` **before** `src/core/app.js`:

```html
<!-- Quantitative Core -->
<script src="src/quant/statistical-utils.js"></script>
<script src="src/quant/hmm-regime-classifier.js"></script>
<script src="src/quant/kalman-filter.js"></script>
<script src="src/quant/hurst-exponent.js"></script>
<script src="src/quant/calibration-curve.js"></script>
<script src="src/quant/drift-detector.js"></script>
<script src="src/quant/winrate-segmentation.js"></script>
<script src="src/quant/trade-journal.js"></script>

<!-- Existing modules -->
<script src="src/core/predictions.js"></script>
<script src="src/core/app.js"></script>
```

### Step 2: Initialize in App.js Startup

```javascript
// In app.js initialization
window.QuantCore = {
  hmm: new HMMRegimeClassifier(),
  kalman: new KalmanFilter({ process_noise: [[0.01, 0], [0, 0.001]], observation_noise: 0.1 }),
  hurst: new HurstExponent({ min_window: 20, max_window: 200 }),
  calibration: new CalibrationAnalyzer(),
  drift: new DriftDetector({ baseline_window: 100, monitor_window: 50 }),
  segmentation: new WinRateSegmentation(),
  journal: new TradeJournal({ storage_key: 'beta1_trade_journal' }),
};

console.log('[App] Quantitative core initialized');
```

### Step 3: Feed Data in Real-Time Loop

```javascript
// Every 15-min candle close or settlement event
async function updateQuantCore() {
  const recent = candleCache[coin].slice(-60);  // 60 candles = ~1 hour
  
  // HMM regime
  const hmm_obs = recent.map(c => ({
    returns: (c.close - c.open) / c.open,
    vol: (c.high - c.low) / c.open,
    orderflow: calculateOrderflow(c),
    fundingRate: getFundingRate(coin),
  }));
  const regime = window.QuantCore.hmm.classify(hmm_obs);
  
  // Hurst trend/revert gate
  const prices = recent.map(c => c.close);
  const hurst = window.QuantCore.hurst.rolling(prices, 50);
  const hurstClass = window.QuantCore.hurst.classify(hurst);
  
  // Kalman filter trend extraction
  const kalman = window.QuantCore.kalman.process(prices);
  
  // Apply gating in predictions
  const prediction = computePrediction(coin, {
    regime_gate: regime.confidence,
    hurst_signal_gate: hurstClass.signal_gate,
    kalman_trend: kalman.state_means.level,
  });
  
  // Record trade + metadata
  const tradeId = window.QuantCore.journal.recordTrade({
    asset: coin,
    prediction: prediction.direction,
    confidence: prediction.confidence,
    regime: regime.regime,
    signals: prediction.signals,
    market_state: getCurrentMarketState(coin),
    fill_price: getCurrentPrice(coin),
  });
  
  // Drift monitoring
  window.QuantCore.drift.observe({
    returns: (c.close - c.open) / c.open,
    volatility: calculateVolatility(recent),
    orderflow_imbalance: calculateOrderflow(c) - 0.5,
    volume_ratio: c.volume / averageVolume,
    funding_rate: getFundingRate(coin),
    skewness: calculateSkewness(prices),
  });
  
  // Store for settlement update
  window._lastTradeId = tradeId;
}
```

### Step 4: Update on Contract Settlement

```javascript
// When Kalshi contract settles (~1s after 15m close)
function handleSettlement(settlement) {
  const { coin, outcome } = settlement;
  
  if (window._lastTradeId) {
    window.QuantCore.journal.updateTrade(window._lastTradeId, {
      close_price: settlement.settle_price,
      outcome: outcome,
      settled: true,
    });
    
    // Record for calibration
    window.QuantCore.calibration.add(
      window._predictions[coin].confidence,
      outcome === 'UP' ? 1 : 0,
      {
        regime: window.QuantCore.hmm.lastViterbiPath[window.QuantCore.hmm.lastViterbiPath.length - 1],
        coin: coin,
      }
    );
    
    // Record for segmentation
    window.QuantCore.segmentation.add({
      prediction: window._predictions[coin].direction,
      outcome: outcome,
      confidence: window._predictions[coin].confidence,
      regime: window.QuantCore.hmm.lastViterbiPath[...],
      coin: coin,
      exchange_lead: window.PredictionMarkets.getCoin(coin),
      horizon: 15,
    });
  }
}
```

---

## Statistical Thresholds (Tuning Guide)

### HMM Transition Matrix

Current default initialization (empirical, can be refined with Baum-Welch):

```
CHOP    → CHOP: 0.70  (high persistence in chop)
TREND   → TREND: 0.60 (trends persist)
CASCADE → CASCADE: 0.60 (cascades are fast, short-lived)
MANIA   → MANIA: 0.40 (mania is unstable)
```

Tuning: Run `hmm.baumWelch(historical_obs, 10)` every 1h with recent market data.

### Hurst Window Sizes

- **Min:** 20 (too small = noisy H estimates)
- **Max:** 200 (captures multi-hour persistence)
- **Adaptive scaling:** window = 20 + (volatility × 100) × 180

Reduce `min_window` for fast intraday edge, increase for swing setups.

### Kalman Filter Q, R

- **Q = [[0.01, 0], [0, 0.001]]** — process noise (model uncertainty)
  - ↓ lower Q = smoother trend (trust model more)
  - ↑ higher Q = responsive trend (trust data more)
- **R = 0.1** — observation noise (measurement uncertainty)
  - ↓ lower R = smoother (trusts prices, ignores noise)
  - ↑ higher R = jerky (expects noise)

**Adaptive Tuning:** `kf.tuneNoise()` auto-scales based on innovation statistics.

### Calibration Bins

- **10 bins** — recommended (covers 0-10%, 10-20%, ..., 90-100%)
- **Overconfidence threshold:** >75% confidence, <60% actual win rate

### Drift Detection Thresholds

- **PSI > 0.10** — alert
- **PSI > 0.25** — major shift (consider pausing)
- **KL > 0.05** — alert
- **K-S > 0.15** — significant (>1% effect size)

Raise thresholds in high-vol environments, lower in stable markets.

---

## Testing & Validation

Run the test suite:

```bash
node tests/quant/quant-core-validation.js
```

Expected output:

```
✓ Isotonic Regression - monotonicity
✓ PSI calculation
✓ HMM Gaussian PDF
✓ Kalman Filter - state update
✓ Hurst - trending series (H > 0.5)
✓ Calibration - well-calibrated predictions
...
Tests Passed: 42
Tests Failed: 0
```

---

## Performance Considerations

1. **HMM.classify()** — O(T × S²) where T=sequence length, S=4 states → ~1ms for 60 obs
2. **Kalman.process()** — O(T) → ~0.2ms for 100 prices
3. **Hurst.rolling()** — O(window × log(window)) → ~2ms for 200-point window
4. **Calibration.fit()** — O(N log N) isotonic regression → ~5ms for 1000 samples
5. **Drift.observe()** — O(features) → <1ms

**Total overhead per update:** ~10ms (well under 1-second budget for real-time loop)

---

## Storage & Persistence

- **Trade Journal:** localStorage (`beta1_trade_journal`) + multi-drive cache (D:, F: on Windows)
- **Calibration Model:** saved to `window.QuantCore.calibration.export()`
- **HMM Checkpoint:** `window.QuantCore.hmm.save()` / `.load(checkpoint)`

Example persistence:

```javascript
// Save state
const state = {
  hmm: window.QuantCore.hmm.save(),
  calibration: window.QuantCore.calibration.export(),
  drift: window.QuantCore.drift.export(),
  journal: window.QuantCore.journal.export(),
};
localStorage.setItem('beta1_quant_core_state', JSON.stringify(state));

// Restore on app startup
const saved = JSON.parse(localStorage.getItem('beta1_quant_core_state'));
window.QuantCore.hmm.load(saved.hmm);
```

---

## Troubleshooting

### HMM stuck in one regime

- Increase `Q` (process noise) to allow state transitions
- Run `baumWelch()` to refine transition matrix
- Check feature signals (returns, vol, orderflow, funding) have sufficient variance

### Kalman trend lagging price

- Decrease `R` (observation noise) to be more responsive
- Increase `Q` to trust the model less

### Hurst H always ~0.5

- Series is truly random (good for mean-reversion)
- Or: window too small (increase to 50+)
- Or: insufficient data (need 100+ candles)

### Calibration error stuck high

- Insufficient samples (fit() requires min 30)
- Model is genuinely poorly calibrated (confidence ≠ actual WR)
  - Solution: apply `calibrate()` to confidence before using
- Or: confidence ranges narrow (e.g., all 0.55-0.65), hard to fit

### Drift detector always triggering

- Increase `psi_threshold` / `kl_threshold` (market is naturally noisy)
- Increase `baseline_window` to smooth baseline estimate

---

## References

- **Isotonic Regression:** Pool Adjacent Violators algorithm (PAV)
- **PSI:** Used in credit risk for population drift detection
- **HMM:** Rabiner's forward-backward algorithm + Viterbi decoding
- **Kalman Filter:** Discrete-time linear state-space filtering
- **Hurst Exponent:** Rescaled Range Analysis (R/S)
- **ADWIN:** Bifet & Gavaldà's drift detector for unbounded streams
- **KL Divergence:** Information-theoretic distance measure

All implementations are production-grade with bounded memory, efficient algorithms, and error handling.

---

## Next Steps

1. **Backtest Integration:** Pass regime + Hurst gates to historical backtest engine
2. **Live Monitoring Dashboard:** Render regime heatmap + calibration curves + drift alerts
3. **RL Optimization:** Use segmentation + calibration to optimize position sizing
4. **Model Ensemble:** Weight predictions by regime + calibration score
5. **Feature Engineering:** Add skewness, kurtosis, orderflow imbalance features to HMM
