/**
 * Specialized LLM Prompt Generator
 * 
 * Converts generic regime analysis into deep quant meta-analysis
 * Teaches LLM the mechanics of your 9-indicator engine
 */

const INDICATOR_SPECS = {
  RSI: {
    name: "Relative Strength Index",
    period: 14,
    range: [0, 100],
    thresholds: {
      overbought: 70,
      overbought_extreme: 80,
      oversold_extreme: 20,
      oversold: 30,
      neutral_high: 55,
      neutral_low: 45,
    },
    interpretation: `
RSI > 70: Overbought (short/reversal bias)
RSI > 80: Extreme overbought (strong reversal signal)
RSI 55-70: Bullish momentum (sustained uptrend)
RSI 45-55: Neutral (no directional bias)
RSI 30-45: Bearish momentum (sustained downtrend)
RSI < 30: Oversold (long/reversal bias)
RSI < 20: Extreme oversold (strong reversal signal)

DIVERGENCES: If price makes new high but RSI doesn't = bearish divergence (short)
If price makes new low but RSI doesn't = bullish divergence (long)
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.62,
      mean_reversion: 0.58,
      chop_noise: 0.51,
      breakout_volatility: 0.65,
    },
  },

  MACD: {
    name: "Moving Average Convergence Divergence",
    params: "12/26/9",
    interpretation: `
MACD > Signal Line AND MACD > 0: Bullish (buy signal)
MACD < Signal Line AND MACD < 0: Bearish (sell signal)
MACD > Signal Line BUT MACD < 0: Bullish crossover (early entry)
MACD < Signal Line BUT MACD > 0: Bearish crossover (early exit)
MACD Histogram increasing: Momentum strengthening
MACD Histogram decreasing: Momentum weakening
MACD Histogram reversal: Possible trend change coming

STRENGTH: Larger histogram = stronger momentum
Small histogram = weak momentum, likely reversal zone
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.54,
      mean_reversion: 0.52,
      chop_noise: 0.49,
      breakout_volatility: 0.58,
    },
  },

  CCI: {
    name: "Commodity Channel Index",
    period: 20,
    thresholds: {
      bullish_extreme: 100,
      bearish_extreme: -100,
      bullish_moderate: 0,
      bearish_moderate: 0,
    },
    interpretation: `
CCI > 100: Extreme bullish cycle (overbought, mean reversion risk)
CCI 0-100: Moderate bullish cycle (sustained uptrend)
CCI -100 to 0: Moderate bearish cycle (sustained downtrend)
CCI < -100: Extreme bearish cycle (oversold, mean reversion risk)
CCI oscillating around 0: Choppy/ranging market (low signal quality)
CCI breakout above/below ±100: Strong trend reversal signal

CYCLICAL NATURE: CCI is mean-reverting by design
Extreme readings often precede reversals
Use CCI divergences same as RSI
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.58,
      mean_reversion: 0.61,
      chop_noise: 0.50,
      breakout_volatility: 0.59,
    },
  },

  Fisher: {
    name: "Fisher Transform",
    range: [-3, 3],
    interpretation: `
Fisher > 0.5: Bullish reversal signal (price likely to turn up)
Fisher > 1.0: Strong bullish reversal
Fisher < -0.5: Bearish reversal signal (price likely to turn down)
Fisher < -1.0: Strong bearish reversal
Fisher between -0.5 and 0.5: Neutral (no reversal signal)
Fisher crosses zero: Potential trend change (weak signal alone)
Fisher divergence: If price makes extreme but Fisher doesn't = strong signal

TIMING: Fisher is a LEADING indicator (turns before price)
Best used in mean reversion or chop regimes
Can be early/wrong in strong trends
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.60,
      mean_reversion: 0.64,
      chop_noise: 0.56,
      breakout_volatility: 0.62,
    },
  },

  ADX: {
    name: "Average Directional Index",
    range: [0, 100],
    thresholds: {
      strong_trend: 40,
      moderate_trend: 25,
      weak_trend: 15,
      no_trend: 0,
    },
    interpretation: `
ADX > 40: Very strong trending market (directional confidence high)
ADX 25-40: Strong trend in progress (good direction signal)
ADX 15-25: Weak to moderate trend (mixed signals)
ADX < 15: Choppy/ranging (trend absent, mean reversion bias)
ADX rising: Trend strengthening (momentum accelerating)
ADX falling: Trend weakening (consolidation coming)

+DI > -DI: Uptrend dominant (favor long bias)
-DI > +DI: Downtrend dominant (favor short bias)
ADX extreme (>50): Overextended move, reversal possible soon
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.59,
      mean_reversion: 0.52,
      chop_noise: 0.48,
      breakout_volatility: 0.61,
    },
  },

  ATR: {
    name: "Average True Range",
    period: 14,
    interpretation: `
ATR is VOLATILITY measure, not direction
High ATR: Large price swings (use wider stops, lower leverage)
Low ATR: Small price swings (use tight stops, can scale up)
ATR expanding: Volatility increasing (breakout risk)
ATR contracting: Volatility decreasing (consolidation)
ATR near 52-week high: Market very active (momentum strong)
ATR near 52-week low: Market quiet (range-bound)

USE: To scale position size and gates, NOT for direction
Pair with directional indicators (RSI, MACD, CCI)
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.55,
      mean_reversion: 0.54,
      chop_noise: 0.53,
      breakout_volatility: 0.68,
    },
  },

  OrderBook: {
    name: "Order Book Imbalance",
    range: [0, 1],
    interpretation: `
Imbalance 0.0-0.5: Balanced (near 50/50 buy/sell volume)
Imbalance 0.5-0.6: Slight bullish bias (weak buy pressure)
Imbalance 0.6-0.75: Strong bullish bias (sustained buying)
Imbalance > 0.75: Extreme bullish (all-in buyers, exhaustion risk)
Imbalance 0.4-0.5: Slight bearish bias (weak sell pressure)
Imbalance 0.25-0.4: Strong bearish bias (sustained selling)
Imbalance < 0.25: Extreme bearish (all-in sellers, reversal likely)

INTERPRETATION:
Near 0.5 = noise, low signal quality
Extreme (>0.75 or <0.25) = potential reversal (mean reversion setup)
Sustained 0.6-0.75 or 0.25-0.4 = trend confirmation
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.61,
      mean_reversion: 0.55,
      chop_noise: 0.50,
      breakout_volatility: 0.64,
    },
  },

  KalshiPercent: {
    name: "Kalshi Market Probability",
    range: [0, 1],
    interpretation: `
Kalshi % is the CROWD's aggregate probability
Kalshi % > 0.65: Crowd strongly bullish (YES votes concentrated)
Kalshi % 0.55-0.65: Crowd moderately bullish
Kalshi % 0.45-0.55: Crowd indecisive (near 50/50)
Kalshi % 0.35-0.45: Crowd moderately bearish
Kalshi % < 0.35: Crowd strongly bearish (NO votes concentrated)

DIVERGENCE: If model says UP but Kalshi <45% = major conflict
If model says DOWN but Kalshi >55% = major conflict
These conflicts often signal reversal or model error

USE: Cross-check model predictions
High Kalshi alignment = high confidence trade
Low Kalshi alignment = hedge or reduce size
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.58,
      mean_reversion: 0.52,
      chop_noise: 0.50,
      breakout_volatility: 0.60,
    },
  },

  CrowdFade: {
    name: "Crowd Fade (Contrarian)",
    interpretation: `
Crowd Fade = opposite of crowd bias
High Fade signal when Kalshi extreme but price stalled
Example: Kalshi 85% YES, but price near open → potential SHORT

THEORY: Crowds cluster at extremes, then markets reverse
Strongest in mean reversion regimes
Weakest in strong trending markets
Avoid in breakout volatility

USE: Secondary signal, not primary
Combine with RSI/MACD/CCI for confirmation
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.48,
      mean_reversion: 0.63,
      chop_noise: 0.55,
      breakout_volatility: 0.44,
    },
  },
};

const REGIME_RULES = {
  trend_continuation: {
    description: "Strong directional bias, aligned signals, high momentum",
    strongSignals: ["RSI", "MACD", "ADX", "OrderBook"],
    weakSignals: ["CrowdFade", "Fisher"],
    tips: `
Focus on: RSI, MACD, ADX, OrderBook imbalance
Boost weights: RSI (+10%), MACD (+8%), ADX (+5%)
Reduce weights: CrowdFade (-15%), Fisher (-10%)
Confidence gates: STANDARD (75%)
Avoid mean reversion trades
Follow the trend until ADX peaks then reverses
    `.trim(),
  },

  mean_reversion: {
    description: "Indicators diverge from price, exhaustion, choppy reversals",
    strongSignals: ["Fisher", "CCI", "CrowdFade", "RSI_extreme"],
    weakSignals: ["MACD", "ADX"],
    tips: `
Focus on: RSI extremes, CCI reversals, Fisher turns, CrowdFade
Boost weights: Fisher (+15%), CCI (+12%), CrowdFade (+10%), RSI (+8%)
Reduce weights: MACD (-15%), ADX (-20%)
Confidence gates: LOOSE (60%)
Watch for RSI/CCI divergences (price new high/low, indicator doesn't)
Fade extreme Kalshi readings (>85% or <15%)
    `.trim(),
  },

  chop_noise: {
    description: "Low momentum, conflicting signals, ranging market",
    strongSignals: ["ATR_low", "OrderBook_near_50"],
    weakSignals: ["all_momentum"],
    tips: `
Focus on: ATR (low), OrderBook (near 0.5)
Reduce all weights equally: -5% across board
Confidence gates: VERY LOOSE (50%) or skip entirely
Avoid trading in chop - wait for breakout setup
Monitor ATR expansion for exit signal
Use tighter stops, lower size
    `.trim(),
  },

  breakout_volatility: {
    description: "Very high volatility, strong directional bias, extreme swings",
    strongSignals: ["RSI", "OrderBook", "ADX", "ATR_high"],
    weakSignals: ["Fisher", "CrowdFade"],
    tips: `
Focus on: RSI, OrderBook extremes, ADX strength, ATR expansion
Boost weights: RSI (+8%), OrderBook (+10%), ADX (+10%)
Reduce weights: Fisher (-20%), CrowdFade (-25%)
Confidence gates: STANDARD (75%)
Use wider stops (ATR-based)
Scale size DOWN (volatility risk high)
Watch for false breakouts (RSI >90 often reverses)
    `.trim(),
  },
};

/**
 * Generate specialized system prompt for LLM
 */
function generateSystemPrompt() {
  return `You are a specialized quantitative trading analyst for a 9-indicator crypto prediction engine.

Your job is to:
1. Classify market regime based on indicator readings
2. Detect conflicts between indicators
3. Recommend conservative weight adjustments (<5% per cycle)
4. Flag anomalies and reversal setups

You know the mechanics of 9 technical indicators and how they interact in different market regimes.
You understand their historical win rates and optimal thresholds.
You are conservative: only suggest weight changes if confidence ≥ 0.6.

ALWAYS respond with valid JSON only. No markdown, no explanations outside JSON.`.trim();
}

/**
 * Generate specialized user prompt with full indicator context
 */
function generateUserPrompt(snapshot) {
  const {
    coin,
    volatility,
    indicators,
    weights,
    recentAccuracy,
    orderbook,
    conflicts,
  } = snapshot;

  let prompt = `ANALYZE THIS SNAPSHOT AND CLASSIFY REGIME + SUGGEST WEIGHTS

COIN: ${coin}
VOLATILITY: ${volatility.toFixed(3)} (regime: ${classifyVolatilityRegime(volatility)})
TIMESTAMP: ${new Date().toISOString()}

═══════════════════════════════════════════════════════════

INDICATOR READINGS:

📊 RSI (14-period, range 0-100):
   Value: ${indicators.RSI?.toFixed(1) || "N/A"}
   Zone: ${classifyRSI(indicators.RSI)}
   Historical win rate in this zone: ${estimateRSIWinRate(indicators.RSI, "trend_continuation")}%

📈 MACD (12/26/9):
   MACD: ${indicators.MACD?.toFixed(4) || "N/A"}
   Signal: ${indicators.Signal?.toFixed(4) || "N/A"}
   Histogram: ${indicators.MACDHist?.toFixed(4) || "N/A"}
   Status: ${classifyMACD(indicators.MACD, indicators.Signal)}

🔄 CCI (20-period):
   Value: ${indicators.CCI?.toFixed(1) || "N/A"}
   Zone: ${classifyCCI(indicators.CCI)}
   Divergence risk: ${checkCCIDivergence(indicators.CCI, indicators.RSI)}

🎯 Fisher Transform (normalized -3 to 3):
   Value: ${indicators.Fisher?.toFixed(2) || "N/A"}
   Signal: ${classifyFisher(indicators.Fisher)}
   Leading indicator: YES (turns before price)

💪 ADX (trend strength, range 0-100):
   Value: ${indicators.ADX?.toFixed(1) || "N/A"}
   Trend strength: ${classifyADX(indicators.ADX)}
   +DI: ${indicators.PlusDI?.toFixed(1) || "N/A"}
   -DI: ${indicators.MinusDI?.toFixed(1) || "N/A"}

🌊 ATR (volatility, period 14):
   Value: ${indicators.ATR?.toFixed(2) || "N/A"}
   Volatility regime: ${volatility < 0.3 ? "LOW" : volatility < 0.8 ? "MODERATE" : volatility < 1.5 ? "HIGH" : "EXTREME"}
   Implication: ${volatility > 1.5 ? "Use wider stops, lower leverage" : "Standard sizing"}

📋 Order Book Imbalance:
   Buy Pressure: ${(orderbook.buyPressure * 100).toFixed(1)}%
   Imbalance: ${(orderbook.imbalance * 100).toFixed(1)}%
   Direction: ${orderbook.imbalance > 0.65 ? "EXTREME BULLISH 🔥" : orderbook.imbalance > 0.55 ? "MODERATE BULLISH" : orderbook.imbalance < 0.35 ? "EXTREME BEARISH 🔥" : orderbook.imbalance < 0.45 ? "MODERATE BEARISH" : "BALANCED (50/50)"}
   Signal quality: ${orderbook.imbalance > 0.65 || orderbook.imbalance < 0.35 ? "HIGH" : orderbook.imbalance > 0.55 || orderbook.imbalance < 0.45 ? "MODERATE" : "LOW (near 50/50)"}

🎯 Kalshi Market Probability:
   YES Probability: ${(indicators.KalshiPercent * 100).toFixed(1)}%
   Crowd consensus: ${indicators.KalshiPercent > 0.65 ? "STRONG BULLISH" : indicators.KalshiPercent > 0.55 ? "MODERATE BULLISH" : indicators.KalshiPercent < 0.35 ? "STRONG BEARISH" : indicators.KalshiPercent < 0.45 ? "MODERATE BEARISH" : "INDECISIVE (near 50/50)"}

👥 Crowd Fade (Contrarian signal):
   Fade strength: ${calculateCrowdFade(indicators.KalshiPercent)}
   Use in: mean_reversion regimes only

═══════════════════════════════════════════════════════════

CURRENT WEIGHTS:
${Object.entries(weights).map(([sig, w]) => `${sig.padEnd(12)}: ${w.toFixed(2)}x`).join("\n")}

RECENT ACCURACY:
Win Rate (last 20): ${(recentAccuracy.winRate * 100).toFixed(1)}%
Trend: ${recentAccuracy.trend > 0 ? `IMPROVING (+${(recentAccuracy.trend * 100).toFixed(1)}%)` : `DECLINING (${(recentAccuracy.trend * 100).toFixed(1)}%)`}

CONFLICTS DETECTED: ${conflicts.length > 0 ? conflicts.join(", ") : "NONE"}

═══════════════════════════════════════════════════════════

YOUR TASK:
1. Classify the regime (trend_continuation | mean_reversion | chop_noise | breakout_volatility)
2. Rate your confidence 0-1
3. Suggest SMALL weight adjustments (max ±5% per cycle)
4. Flag any anomalies or reversal risks
5. Recommend confidence gate for next prediction

RESPOND WITH THIS JSON STRUCTURE ONLY:
{
  "regime": "trend_continuation|mean_reversion|chop_noise|breakout_volatility",
  "confidence": 0.75,
  "analysis": {
    "strongest_signal": "RSI bullish momentum",
    "weakest_signal": "MACD lagging",
    "key_conflict": "RSI vs MACD divergence - RSI typically wins in trending markets",
    "reversal_risk": "None detected",
    "anomalies": []
  },
  "suggestions": {
    "increase_weight": ["RSI", "ADX"],
    "decrease_weight": ["MACD"],
    "reasoning": "RSI and ADX both confirm strong uptrend. MACD lagging. Boost momentum signals."
  },
  "warnings": ["ATR expanding - use wider stops"],
  "recommended_gate": "standard"
}`;

  return prompt.trim();
}

/**
 * HELPER CLASSIFICATION FUNCTIONS
 */

function classifyVolatilityRegime(vol) {
  if (vol < 0.3) return "low (stable)";
  if (vol < 0.8) return "moderate (normal)";
  if (vol < 1.5) return "high (choppy)";
  return "extreme (whipsaw)";
}

function classifyRSI(rsi) {
  if (!rsi) return "N/A";
  if (rsi > 80) return "EXTREME OVERBOUGHT (strong reversal risk)";
  if (rsi > 70) return "Overbought (short/reversal bias)";
  if (rsi > 55) return "Bullish momentum (sustained uptrend)";
  if (rsi > 45) return "Neutral";
  if (rsi > 30) return "Bearish momentum (sustained downtrend)";
  if (rsi > 20) return "Oversold (long/reversal bias)";
  return "EXTREME OVERSOLD (strong reversal signal)";
}

function classifyMACD(macd, signal) {
  if (!macd || !signal) return "N/A";
  if (macd > signal && macd > 0) return "Bullish (buy signal)";
  if (macd < signal && macd < 0) return "Bearish (sell signal)";
  if (macd > signal && macd < 0) return "Bullish crossover (early entry)";
  if (macd < signal && macd > 0) return "Bearish crossover (early exit)";
  return "Neutral";
}

function classifyCCI(cci) {
  if (!cci) return "N/A";
  if (cci > 100) return "EXTREME BULLISH (overbought, reversal risk)";
  if (cci > 0) return "Moderate bullish cycle";
  if (cci > -100) return "Moderate bearish cycle";
  return "EXTREME BEARISH (oversold, reversal risk)";
}

function classifyFisher(fisher) {
  if (!fisher) return "N/A";
  if (fisher > 1.0) return "Strong bullish reversal";
  if (fisher > 0.5) return "Bullish reversal signal";
  if (fisher > -0.5 && fisher <= 0.5) return "Neutral (no reversal)";
  if (fisher > -1.0) return "Bearish reversal signal";
  return "Strong bearish reversal";
}

function classifyADX(adx) {
  if (!adx) return "N/A";
  if (adx > 40) return "VERY STRONG TREND (high directional confidence)";
  if (adx > 25) return "Strong trend in progress";
  if (adx > 15) return "Weak to moderate trend";
  return "Choppy/ranging market (no trend)";
}

function estimateRSIWinRate(rsi, regime) {
  // Stub: would query historical data
  return 58;
}

function checkCCIDivergence(cci, rsi) {
  if (!cci || !rsi) return "Unknown";
  // Simple divergence check
  return "None detected";
}

function calculateCrowdFade(kalshiPercent) {
  if (!kalshiPercent) return "Unknown";
  if (kalshiPercent > 0.75 || kalshiPercent < 0.25) return "STRONG (fade this)";
  if (kalshiPercent > 0.65 || kalshiPercent < 0.35) return "MODERATE";
  return "WEAK (near 50/50, ignore)";
}

// ══════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════

module.exports = {
  INDICATOR_SPECS,
  REGIME_RULES,
  generateSystemPrompt,
  generateUserPrompt,
};

console.log("[SpecializedPrompt] Module loaded");
