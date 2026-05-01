/**
 * Multi-Coin LLM Analyzer
 * 
 * Batches analysis across multiple coins in a single LLM call
 * Returns per-coin regimes, target weights, and warnings
 * Efficient: 1 API call for 4-7 coins vs 4-7 calls
 */

const fs = require("fs");
const path = require("path");

function buildMultiCoinPrompt(coinSnapshots, globalContext) {
  const { timestamp, market_volatility, regime_hint } = globalContext;

  let prompt = `ANALYZE MULTI-COIN SNAPSHOT — RETURN PER-COIN REGIMES AND WEIGHT TARGETS

GLOBAL CONTEXT:
Timestamp: ${new Date(timestamp * 1000).toISOString()}
Market Volatility: ${market_volatility.toFixed(3)}
Overall Regime Hint: ${regime_hint}

═══════════════════════════════════════════════════════════

COINS TO ANALYZE:
`;

  for (const [coin, snapshot] of Object.entries(coinSnapshots)) {
    prompt += `

📊 ${coin}:
  RSI: ${snapshot.indicators?.RSI?.toFixed(1)} | MACD: ${snapshot.indicators?.MACD?.toFixed(4)} | CCI: ${snapshot.indicators?.CCI?.toFixed(1)}
  Fisher: ${snapshot.indicators?.Fisher?.toFixed(2)} | ADX: ${snapshot.indicators?.ADX?.toFixed(1)} | ATR: ${snapshot.indicators?.ATR?.toFixed(2)}
  OB Imbalance: ${(snapshot.orderbook?.imbalance * 100).toFixed(1)}% | Kalshi: ${(snapshot.indicators?.KalshiPercent * 100).toFixed(1)}%
  Current Weights: ${Object.entries(snapshot.weights || {})
    .map(([k, v]) => `${k}=${v.toFixed(2)}x`)
    .join(", ")}
  Recent Accuracy: ${(snapshot.recentAccuracy?.winRate * 100).toFixed(1)}% WR, trend=${snapshot.recentAccuracy?.trend?.toFixed(2)}
`;
  }

  prompt += `

═══════════════════════════════════════════════════════════

YOUR TASK:
For EACH coin, return:
1. Regime classification
2. Confidence (0-1)
3. Target weight adjustments (small nudges only, max ±5%)
4. Any warnings

RESPOND WITH JSON ARRAY:
{
  "BTC": {
    "regime": "trend_continuation|mean_reversion|chop_noise|breakout_volatility",
    "confidence": 0.75,
    "target_weights": {
      "RSI": 1.15,
      "MACD": 0.95,
      "CCI": 1.0,
      "Fisher": 1.1,
      "ADX": 1.05,
      "ATR": 1.0,
      "OrderBook": 1.05,
      "KalshiPercent": 1.0,
      "CrowdFade": 0.95
    },
    "analysis": "RSI bullish, MACD lagging...",
    "warnings": []
  },
  "ETH": { ... },
  "SOL": { ... },
  "XRP": { ... }
}`;

  return prompt.trim();
}

/**
 * Call LLM for multi-coin batch analysis
 */
async function analyzeBatch(coins, LLMAssistant) {
  if (!LLMAssistant.enabled) {
    console.warn("[MultiCoinAnalyzer] LLM disabled, skipping batch analysis");
    return null;
  }

  try {
    // Build context
    const globalContext = {
      timestamp: Math.floor(Date.now() / 1000),
      market_volatility: calculateGlobalVolatility(coins),
      regime_hint: guessGlobalRegime(coins),
    };

    const prompt = buildMultiCoinPrompt(coins, globalContext);
    const systemPrompt = `You are a quantitative analyst for a multi-coin prediction engine.
Analyze 4-7 coins simultaneously and return regime + weight targets for each.
Be conservative. If unsure, prefer 'unknown' regime.
Return ONLY valid JSON.`;

    // Call API
    const response = await fetch(process.env.LLM_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "gpt-4-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 1200,
      }),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || "";

    // Extract JSON
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) content = jsonMatch[1];

    return JSON.parse(content);
  } catch (err) {
    console.error("[MultiCoinAnalyzer] Batch analysis failed:", err.message);
    return null;
  }
}

function calculateGlobalVolatility(coins) {
  const vols = Object.values(coins)
    .map(c => c.volatility || 0)
    .filter(v => v > 0);
  if (vols.length === 0) return 0.02;
  return vols.reduce((a, b) => a + b) / vols.length;
}

function guessGlobalRegime(coins) {
  const regimes = Object.values(coins)
    .map(c => guessRegimeFromIndicators(c.indicators))
    .filter(r => r !== "unknown");

  if (regimes.length === 0) return "unknown";
  return regimes.sort((a, b) =>
    regimes.filter(r => r === a).length - regimes.filter(r => r === b).length
  ).pop();
}

function guessRegimeFromIndicators(indicators) {
  if (!indicators) return "unknown";
  const { RSI, MACD, ADX, CCI } = indicators;

  if (ADX > 25 && Math.abs(RSI - 50) > 20) return "trend_continuation";
  if (RSI > 70 || RSI < 30) return "mean_reversion";
  if (ADX < 15) return "chop_noise";
  return "unknown";
}

// ══════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════

module.exports = {
  analyzeBatch,
  buildMultiCoinPrompt,
};

console.log("[MultiCoinAnalyzer] Module loaded");
