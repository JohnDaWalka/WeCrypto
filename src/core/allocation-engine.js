// ================================================================
// WECRYPTO Allocation Engine v1.0
// Raw + ATR-adjusted + Regime-Aware Portfolio Weighting
// 
// Input:  scores (coin → -3 to +3 signal strength)
//         atr    (coin → 14-bar average true range)
// Output: raw, atr, blended, final weights (all normalized to 1.0)
//
// Features:
//   • Raw score normalization (negative scores → 0)
//   • ATR smoothing (EMA, α=0.2 to prevent whipsaw)
//   • Regime detection (low/normal/high volatility)
//   • Dynamic blending (λ = 0.0/0.5/1.0 based on ATR percentile)
//   • Volatility caps (per-asset max/min constraints)
// ================================================================

function ema(value, prev, alpha = 0.2) {
  return alpha * value + (1 - alpha) * prev;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index % 1;
  
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function allocationEngine(scores, atr, options = {}) {
  const {
    prevAtrSmooth = null,
    maxWeight = 0.70,
    minWeight = 0.00,
    alphaSmooth = 0.2,
    regimeLowVol = 0.30,
    regimeHighVol = 0.70,
  } = options;

  // ─────────────────────────────────────────────────────────────────
  // 1. RAW WEIGHTS (signal-only, no volatility adjustment)
  // ─────────────────────────────────────────────────────────────────
  const pos = {};
  for (const c in scores) {
    pos[c] = Math.max(scores[c], 0);
  }

  const totalPos = Object.values(pos).reduce((a, b) => a + b, 0) || 1e-9;
  const raw = {};
  for (const c in pos) {
    raw[c] = pos[c] / totalPos;
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. ATR SMOOTHING (prevent whipsaw from sudden vol spikes)
  // ─────────────────────────────────────────────────────────────────
  const atrSmooth = {};
  for (const c in atr) {
    if (prevAtrSmooth && prevAtrSmooth[c]) {
      atrSmooth[c] = ema(atr[c], prevAtrSmooth[c], alphaSmooth);
    } else {
      atrSmooth[c] = atr[c];
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. ATR-ADJUSTED WEIGHTS (volatility normalization)
  // ─────────────────────────────────────────────────────────────────
  const riskAdj = {};
  for (const c in pos) {
    riskAdj[c] = pos[c] / atrSmooth[c];
  }

  const totalRisk = Object.values(riskAdj).reduce((a, b) => a + b, 0) || 1e-9;
  const atrW = {};
  for (const c in riskAdj) {
    atrW[c] = riskAdj[c] / totalRisk;
  }

  // ─────────────────────────────────────────────────────────────────
  // 4. REGIME DETECTION (based on ATR percentiles)
  // ─────────────────────────────────────────────────────────────────
  const atrValues = Object.values(atrSmooth);
  const p30 = percentile(atrValues, 30);
  const p70 = percentile(atrValues, 70);
  const avgAtr = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;

  let lam = 0.5; // normal regime: 50/50 blend
  if (avgAtr < p30) {
    lam = 0.0; // low volatility: favor raw (signal) weights
  } else if (avgAtr > p70) {
    lam = 1.0; // high volatility: favor ATR-adjusted weights
  }

  // ─────────────────────────────────────────────────────────────────
  // 5. BLENDED WEIGHTS (regime-aware interpolation)
  // ─────────────────────────────────────────────────────────────────
  // w_blended = (1-λ) * w_raw + λ * w_atr
  // λ adjusts dynamically based on volatility environment
  const blended = {};
  for (const c in raw) {
    blended[c] = (1 - lam) * raw[c] + lam * atrW[c];
  }

  // ─────────────────────────────────────────────────────────────────
  // 6. VOLATILITY CAPS (enforce per-asset constraints)
  // ─────────────────────────────────────────────────────────────────
  const capped = {};
  for (const c in blended) {
    capped[c] = Math.min(Math.max(blended[c], minWeight), maxWeight);
  }

  // Re-normalize after capping to ensure sum = 1.0
  const totalCapped = Object.values(capped).reduce((a, b) => a + b, 0) || 1e-9;
  const final = {};
  for (const c in capped) {
    final[c] = capped[c] / totalCapped;
  }

  // ─────────────────────────────────────────────────────────────────
  // 7. RETURN SUMMARY
  // ─────────────────────────────────────────────────────────────────
  return {
    raw,           // signal-only weights
    atr: atrW,     // volatility-adjusted weights
    blended,       // regime-aware interpolation (before capping)
    final,         // final weights (after capping & renormalization)
    atrSmooth,     // smoothed ATR (cache for next iteration)
    regime: {
      lambda: lam,
      avgAtr,
      p30,
      p70,
      classification:
        lam === 0.0 ? 'low-volatility' :
        lam === 1.0 ? 'high-volatility' :
        'normal',
    },
  };
}

// ================================================================
// EXPORT FOR USE IN PREDICTIONS.JS & TESTS
// ================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { allocationEngine, ema, percentile };
}

// Browser/Electron: attach to window for use in predictions.js
if (typeof window !== 'undefined') {
  window.allocationEngine = allocationEngine;
  window._allocationState = null; // cache for ATR smoothing between cycles
  window._allocationWeights = null; // latest computed weights
}
