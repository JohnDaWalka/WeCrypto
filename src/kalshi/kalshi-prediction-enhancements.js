/**
 * Kalshi Prediction Accuracy Enhancements
 *
 * 11-State Quantized Spin Model (-5 to +5) — quantum h-subshell (l=5, n=6)
 *
 * Improves predictions from 10-10 baseline through:
 * 1. Quantized spin states (+5/+4/+3/+2/+1/0/-1/-2/-3/-4/-5) mapped to orbital shells
 * 2. Per-coin orbital profiles (core/core+/momentum/highBeta) for confidence tuning
 * 3. Volatility regime detection (choppy markets dampen confidence)
 * 4. Kalshi sentiment blending (crowd wisdom 12-15% weight)
 * 5. Consensus scoring (when CFM + Kalshi + orbital align, +30-50% confidence)
 * 6. Conflict penalties (disagreement reduces exposure)
 * 7. Choppy market filters (range-bound: higher thresholds)
 * 8. Spin state → Binary contract mapping (compress 11-state to YES/NO with confidence)
 */

(function() {
  'use strict';

  window.KalshiEnhancements = window.KalshiEnhancements || {};

  /**
   * 11-State Quantized Spin System (-5 to +5)
   * Maps h-subshell orbital quantum states (l=5, m_l=-5..+5) to trading signals
   * Shell hierarchy: s(1)→p(3)→d(5)→f(7)→g(9)→h(11 states)
   */
  const SPIN_STATES = {
    5:    { label: 'Extreme Bull',      confidence: 0.97, direction:  1, execSize: 1.0, shell: 'h', n: 6 },
    4:    { label: 'Very Strong Bull',  confidence: 0.92, direction:  1, execSize: 1.0, shell: 'g', n: 5 },
    3:    { label: 'Strong Bull',       confidence: 0.85, direction:  1, execSize: 1.0, shell: 'f', n: 4 },
    2:    { label: 'Bull',              confidence: 0.72, direction:  1, execSize: 0.9, shell: 'd', n: 3 },
    1:    { label: 'Weak Bull',         confidence: 0.58, direction:  1, execSize: 0.6, shell: 'p', n: 2 },
    0:    { label: 'Neutral',           confidence: 0.50, direction:  0, execSize: 0,   shell: 's', n: 1 },
    '-1': { label: 'Weak Bear',         confidence: 0.58, direction: -1, execSize: 0.6, shell: 'p', n: 2 },
    '-2': { label: 'Bear',              confidence: 0.72, direction: -1, execSize: 0.9, shell: 'd', n: 3 },
    '-3': { label: 'Strong Bear',       confidence: 0.85, direction: -1, execSize: 1.0, shell: 'f', n: 4 },
    '-4': { label: 'Very Strong Bear',  confidence: 0.92, direction: -1, execSize: 1.0, shell: 'g', n: 5 },
    '-5': { label: 'Extreme Bear',      confidence: 0.97, direction: -1, execSize: 1.0, shell: 'h', n: 6 },
  };

  /**
   * Per-coin orbital profiles — maps each coin to its natural spin range
   * and confidence multiplier for extreme states beyond maxNaturalSpin.
   *
   * core (BTC/ETH):       stable noble-gas-like; dampen ±4/±5 confidence
   * core+ (BNB/XRP):      more reactive than core, less than momentum
   * momentum (SOL/HYPE):  outer-shell reactive; ±4/±5 occur naturally, no penalty
   * highBeta (DOGE):      extreme states are noisy; reduce confidence at ±5
   */
  const COIN_ORBITAL_PROFILES = {
    BTC:  { maxNaturalSpin: 3, extremeBoost: 0.85, profile: 'core' },
    ETH:  { maxNaturalSpin: 3, extremeBoost: 0.85, profile: 'core' },
    BNB:  { maxNaturalSpin: 4, extremeBoost: 0.90, profile: 'core_plus' },
    XRP:  { maxNaturalSpin: 4, extremeBoost: 0.90, profile: 'core_plus' },
    SOL:  { maxNaturalSpin: 5, extremeBoost: 1.00, profile: 'momentum' },
    HYPE: { maxNaturalSpin: 5, extremeBoost: 1.00, profile: 'momentum' },
    DOGE: { maxNaturalSpin: 5, extremeBoost: 0.80, profile: 'highBeta' },
  };

  /**
   * Convert quantized spin state (-5 to +5) to normalized score
   * Maps 11 h-subshell states → confidence level for binary (YES/NO) Kalshi contracts
   *
   * @param {number} spinState  - integer -5..+5
   * @param {string} [coinSymbol] - optional coin ticker (e.g. 'BTC') for orbital profile adjustment
   */
  function spinToConfidence(spinState, coinSymbol) {
    const clipped = Math.max(-5, Math.min(5, spinState));
    const metadata = SPIN_STATES[String(clipped)] || SPIN_STATES[0];

    let baseConfidence = metadata.confidence;

    // Apply per-coin orbital profile: dampen confidence when spin exceeds maxNaturalSpin
    if (coinSymbol) {
      const profile = COIN_ORBITAL_PROFILES[coinSymbol.toUpperCase()];
      if (profile && Math.abs(clipped) > profile.maxNaturalSpin) {
        baseConfidence *= profile.extremeBoost;
      }
    }

    return {
      spinState: clipped,
      label: metadata.label,
      baseConfidence,
      direction: metadata.direction,
      execSize: metadata.execSize,
      shell: metadata.shell,
      n: metadata.n,
      // Normalized score for predictions (-1 to +1)
      normalizedScore: clipped / 5,  // h-subshell: max |m_l| = 5
      // Raw quantized value for diagnostics
      quantumLevel: Math.abs(clipped),  // 0-5 intensity
    };
  }

  /**
   * Volatility Regime Detection
   * Returns: { regime: 'tight'|'normal'|'elevated'|'extreme', atrPct, score }
   */
  function detectVolatilityRegime(volatility) {
    const atrPct = volatility?.atrPct ?? 0;
    let regime = 'normal';
    let regimeScore = 1.0;  // confidence multiplier

    if (atrPct <= 0.35) {
      regime = 'tight';
      regimeScore = 0.75;  // very choppy, reduce conviction
    } else if (atrPct <= 0.65) {
      regime = 'normal';
      regimeScore = 1.0;
    } else if (atrPct <= 1.2) {
      regime = 'elevated';
      regimeScore = 1.05;  // trending, boost slightly
    } else {
      regime = 'extreme';
      regimeScore = 0.85;  // too volatile, reduce exposure
    }

    return { regime, atrPct, regimeScore };
  }

  /**
   * Kalshi Sentiment to Spin State (11-state h-subshell mapping)
   *
   * Kalshi binary market is 0-100 probability of UP.
   * Convert to quantized spin state aligned with h-subshell model (±5).
   *
   * Range mapping:
   *   0- 9: -5 (extreme bear)
   *   9-18: -4 (very strong bear)
   *  18-30: -3 (strong bear)
   *  30-40: -2 (bear)
   *  40-45: -1 (weak bear)
   *  45-55:  0 (neutral)
   *  55-60: +1 (weak bull)
   *  60-70: +2 (bull)
   *  70-82: +3 (strong bull)
   *  82-91: +4 (very strong bull)
   *  91-100: +5 (extreme bull)
   */
  function kalshiToSpinState(kalshiPrice) {
    if (kalshiPrice <  9) return -5;   // extreme bear: <9%
    if (kalshiPrice < 18) return -4;   // very strong bear: 9-18%
    if (kalshiPrice < 30) return -3;   // strong bear: 18-30%
    if (kalshiPrice < 40) return -2;   // bear: 30-40%
    if (kalshiPrice < 45) return -1;   // weak bear: 40-45%
    if (kalshiPrice < 55) return  0;   // neutral: 45-55%
    if (kalshiPrice < 60) return  1;   // weak bull: 55-60%
    if (kalshiPrice < 70) return  2;   // bull: 60-70%
    if (kalshiPrice < 82) return  3;   // strong bull: 70-82%
    if (kalshiPrice < 91) return  4;   // very strong bull: 82-91%
    return  5;                          // extreme bull: 91-100%
  }

  /**
   * Blend CFM Spin State with Kalshi Spin State
   * 
   * When both point same direction:
   *   - Average the spin states (+20% confidence boost)
   *   - Increase execution size
   * 
   * When opposite:
   *   - Take lower confidence signal
   *   - Apply conflict penalty (-25% confidence)
   *   - Reduce execution size
   */
  function blendSpinStates(cfmSpin, kalshiPrice, regime) {
    if (kalshiPrice === null || kalshiPrice === undefined) {
      // No Kalshi data
      return {
        blendedSpin: cfmSpin,
        kalshiSpin: null,
        agreement: null,
        confidenceBoost: 1.0,
        execSizeMultiplier: 1.0,
      };
    }

    const kalshiSpin = kalshiToSpinState(kalshiPrice);
    const sameDirection = Math.sign(cfmSpin) === Math.sign(kalshiSpin) && cfmSpin !== 0;
    const alignmentScore = 1 - (Math.abs(cfmSpin - kalshiSpin) / 10);  // 0 to 1, max separation is now 10 (±5 range)

    let blendedSpin = cfmSpin;
    let confidenceBoost = 1.0;
    let execSizeMultiplier = 1.0;

    if (sameDirection && alignmentScore > 0.6) {
      // Strong agreement: average spin states
      blendedSpin = (cfmSpin + kalshiSpin) / 2;
      confidenceBoost = 1.25;  // +25% confidence
      execSizeMultiplier = 1.3;
    } else if (sameDirection && alignmentScore > 0.4) {
      // Mild agreement
      blendedSpin = (cfmSpin + kalshiSpin) / 2;
      confidenceBoost = 1.10;  // +10% confidence
      execSizeMultiplier = 1.1;
    } else if (!sameDirection && alignmentScore < 0.3) {
      // Strong disagreement
      blendedSpin = cfmSpin * 0.7;  // dampen CFM signal
      confidenceBoost = 0.70;  // -30% confidence
      execSizeMultiplier = 0.5;
    } else if (!sameDirection) {
      // Mild disagreement
      blendedSpin = cfmSpin * 0.85;
      confidenceBoost = 0.85;  // -15% confidence
      execSizeMultiplier = 0.75;
    }

    // Regime adjustment
    if (regime === 'tight') {
      // Choppy markets: reduce confidence further if signals weak
      if (Math.abs(cfmSpin) <= 1) confidenceBoost *= 0.85;
      execSizeMultiplier *= 0.7;
    } else if (regime === 'extreme') {
      confidenceBoost *= 0.90;
      execSizeMultiplier *= 0.85;
    }

    return {
      blendedSpin: Math.round(blendedSpin * 2) / 2,  // round to nearest 0.5
      kalshiSpin,
      agreement: {
        aligned: sameDirection,
        alignmentScore,
        cfmLabel: SPIN_STATES[String(Math.round(cfmSpin))].label,
        kalshiLabel: SPIN_STATES[String(kalshiSpin)].label,
      },
      confidenceBoost,
      execSizeMultiplier,
    };
  }

  /**
   * Choppy Market Filter
   * In tight regimes (ATR ≤ 0.35%), applies tighter filters
   */
  function applyChoppyMarketFilter(score, confidence, regime, entryThreshold) {
    if (regime !== 'tight') return { adjustedScore: score, adjustedConf: confidence, adjustedThreshold: entryThreshold };

    const absScore = Math.abs(score);
    let adjusted = score;
    let adjustedConf = confidence;
    let adjustedThreshold = entryThreshold;

    if (absScore < (entryThreshold * 1.3)) {
      // Too weak for choppy markets
      adjusted = 0;  // flatten to neutral
      adjustedConf = Math.max(0, confidence - 30);
    } else if (absScore < (entryThreshold * 1.6)) {
      // Weak signal in choppy market
      adjustedConf = Math.max(0, confidence - 15);
      adjusted = score * 0.8;  // dampen
    }

    adjustedThreshold = entryThreshold + 0.04;  // require stronger entry

    return { adjustedScore: adjusted, adjustedConf, adjustedThreshold };
  }

  /**
   * Consensus Signal Strength
   * When multiple signals align, boost confidence significantly
   * Used for: CFM + Kalshi + derivatives + structural confluence
   */
  function getConsensusBoost(cfmSignal, kalshiAlignment, derivsAlignment, structureAlignment) {
    let alignedCount = 0;
    alignedCount += cfmSignal ? 1 : 0;
    alignedCount += kalshiAlignment ? 1 : 0;
    alignedCount += derivsAlignment ? 1 : 0;
    alignedCount += structureAlignment ? 1 : 0;

    // Confidence boosts by consensus level
    const consensusMap = {
      0: 1.0,  // no consensus
      1: 1.05,  // weak
      2: 1.25,  // moderate
      3: 1.50,  // strong
      4: 1.80,  // very strong (all models agree)
    };

    return consensusMap[alignedCount] || 1.0;
  }

  /**
   * Entry Signal Calibration for Choppy Markets
   * 
   * Choppy markets need:
   * 1. Higher entry thresholds (0.18-0.22 instead of 0.10-0.15)
   * 2. Lower confidence ceilings (max 70-75% instead of 90+%)
   * 3. Mandatory Kalshi + CFM agreement
   * 4. Reduced order size
   */
  function calibrateForRegime(regime, baseThreshold, baseConfCeiling) {
    const calibration = {
      tight: {
        thresholdMultiplier: 1.4,  // 40% higher bar
        confidenceCeiling: 72,
        requireConsensus: true,
        minKalshiConfidence: 0.50,
      },
      normal: {
        thresholdMultiplier: 1.0,
        confidenceCeiling: 85,
        requireConsensus: false,
        minKalshiConfidence: 0.35,
      },
      elevated: {
        thresholdMultiplier: 0.95,  // slightly lower bar (trending)
        confidenceCeiling: 88,
        requireConsensus: false,
        minKalshiConfidence: 0.30,
      },
      extreme: {
        thresholdMultiplier: 1.2,  // higher bar again
        confidenceCeiling: 70,
        requireConsensus: true,
        minKalshiConfidence: 0.55,
      },
    };

    const config = calibration[regime] || calibration.normal;
    return {
      adjustedThreshold: baseThreshold * config.thresholdMultiplier,
      confidenceCeiling: config.confidenceCeiling,
      requireConsensus: config.requireConsensus,
      minKalshiConfidence: config.minKalshiConfidence,
    };
  }

  /**
   * Main Enhancement Entry Point (For Spin States)
   * 
   * Takes 7-state quantized spin signal and blends with Kalshi
   * Returns enhanced prediction with execution guidance
   */
  function enhanceWithKalshiSpinStates(prediction, cfmSpinState, volatility) {
    if (!window._kalshiByTicker) {
      // No Kalshi data — use CFM spin as-is
      return enhancePredictionFromSpinState(prediction, cfmSpinState, null, volatility);
    }

    const sym = prediction.sym;
    const ticker = sym + 'USD';
    const kalshiData = window._kalshiByTicker[ticker];

    if (!kalshiData) {
      return enhancePredictionFromSpinState(prediction, cfmSpinState, null, volatility);
    }

    // 1. Detect regime
    const volRegime = detectVolatilityRegime(volatility);

    // 2. Blend CFM spin with Kalshi spin
    const blend = blendSpinStates(cfmSpinState, kalshiData.price, volRegime.regime);

    // 3. Enhance from blended spin
    return enhancePredictionFromSpinState(
      prediction,
      blend.blendedSpin,
      blend,
      volRegime
    );
  }

  /**
   * Convert Spin State to Prediction
   * Handles confidence calculation, size adjustment, and filtering
   */
  function enhancePredictionFromSpinState(prediction, spinState, blend, volRegime) {
    // Convert spin to confidence
    const spinMeta = spinToConfidence(spinState);

    // Start with base confidence from spin state
    let finalConf = spinMeta.baseConfidence * 100;

    // Apply Kalshi blend boost/penalty if available
    if (blend) {
      finalConf *= blend.confidenceBoost;
    }

    // Apply regime adjustment
    if (volRegime) {
      finalConf *= volRegime.regimeScore;

      // Choppy markets: reduce confidence for weak signals
      if (volRegime.regime === 'tight' && Math.abs(spinState) <= 1) {
        finalConf *= 0.80;
      }
    }

    // Cap confidence by regime
    const maxConf = volRegime?.regime === 'tight' ? 72
                  : volRegime?.regime === 'extreme' ? 70
                  : 88;
    finalConf = Math.min(finalConf, maxConf);
    finalConf = Math.max(0, finalConf);

    // Flatten to neutral if signal is too weak
    let finalScore = spinMeta.normalizedScore;
    if (volRegime?.regime === 'tight' && Math.abs(spinState) < 1.5) {
      finalScore = 0;
      finalConf = Math.max(0, finalConf - 20);
    }

    // Execution size multiplier
    let execSize = spinMeta.execSize;
    if (blend) {
      execSize *= blend.execSizeMultiplier;
    }
    if (volRegime?.regime === 'tight') {
      execSize *= 0.65;
    } else if (volRegime?.regime === 'extreme') {
      execSize *= 0.80;
    }

    return {
      ...prediction,
      score: finalScore,
      confidence: Math.round(finalConf),
      signal: finalScore === 0 ? 'neutral' : finalScore > 0 ? 'up' : 'down',
      // Quantum metadata
      diagnostics: {
        ...prediction.diagnostics,
        quantumSpinState: {
          cfmSpinState: spinState,
          kalshiSpinState: blend?.kalshiSpin ?? null,
          blendedSpinState: spinState,
          spinLabel: spinMeta.label,
          quantumLevel: spinMeta.quantumLevel,
          agreement: blend?.agreement ?? null,
        },
        volatility: {
          regime: volRegime?.regime ?? 'unknown',
          atrPct: volRegime?.atrPct ?? 0,
          regimeScore: volRegime?.regimeScore ?? 1,
        },
        blending: {
          confidenceBoost: blend?.confidenceBoost ?? 1.0,
          execSizeMultiplier: blend?.execSizeMultiplier ?? 1.0,
        },
      },
      // Kalshi contract execution guidance
      kalshiExecution: {
        spinState: spinState,
        spinLabel: spinMeta.label,
        direction: spinMeta.direction > 0 ? 'YES' : spinMeta.direction < 0 ? 'NO' : 'SKIP',
        quantity: Math.max(1, Math.round(10 * execSize)),  // base 10, scaled
        confidence: Math.round(finalConf),
        executionProbability: (finalConf / 100) * 0.85,  // add friction for realism
        regime: volRegime?.regime ?? 'normal',
        consensusStrength: blend?.agreement?.alignmentScore ?? 0,
      },
    };
  }

  // Export for use in predictions.js
  window.KalshiEnhancements = {
    // Main entry points
    enhanceWithKalshi: enhanceWithKalshiSpinStates,
    enhanceFromSpinState: enhancePredictionFromSpinState,
    
    // Utilities
    spinToConfidence,
    spinStates: SPIN_STATES,
    kalshiToSpinState,
    detectVolatilityRegime,
    blendSpinStates,
    calibrateForRegime,
    
    // Metadata
    SPIN_STATES,
  };
})();
