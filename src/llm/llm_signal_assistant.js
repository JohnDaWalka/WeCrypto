/**
 * LLM Signal Assistant — Real LLM-Powered Analysis Layer
 * 
 * Connects to OpenAI, Anthropic, or any chat-completions compatible API
 * Classifies regimes, resolves conflicts, performs sanity checks
 * Non-blocking, safe-gated, fully logged
 */

const fs = require("fs");
const path = require("path");

// Configuration from environment
const LLM_API_URL = process.env.LLM_API_URL || "https://api.openai.com/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4-mini";

class LLMSignalAssistant {
  constructor() {
    this.enabled = !!(LLM_API_URL && LLM_API_KEY);
    this.stats = {
      calls: 0,
      successes: 0,
      failures: 0,
      influenceCount: 0,
    };

    console.log(
      `[LLMSignalAssistant] Initialized ${this.enabled ? '✓ ENABLED' : '⚠ DISABLED (missing LLM_API_URL or LLM_API_KEY)'}`
    );
  }

  /**
   * Main entry point: analyze market snapshot
   * Returns: { regime, confidence, suggestions, warnings }
   */
  async analyzeSnapshot(snapshot) {
    this.stats.calls++;

    if (!this.enabled) {
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: { notes: "LLM disabled" },
        warnings: ["LLM not configured"],
      };
    }

    const prompt = this.buildPrompt(snapshot);

    try {
      const rawResponse = await this.callAPI(prompt);
      const normalized = this.normalizeResponse(rawResponse);
      this.stats.successes++;
      return normalized;
    } catch (err) {
      this.stats.failures++;
      console.error("[LLMSignalAssistant] Analysis failed:", err.message);
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: {},
        warnings: [`LLM error: ${err.message}`],
      };
    }
  }

  /**
   * Build the prompt for the LLM
   */
  buildPrompt(snapshot) {
    const {
      coin = "UNKNOWN",
      volatility = 0,
      orderbook = {},
      indicators = {},
      recentAccuracy = {},
      weights = {},
      conflicts = [],
    } = snapshot;

    const indicatorSummary = Object.entries(indicators)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
      .join(", ");

    const weightSummary = Object.entries(weights)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}x`)
      .join(", ");

    return `
Analyze this crypto market snapshot and classify the regime.

COIN: ${coin}
VOLATILITY: ${volatility.toFixed(3)} (low<0.3, moderate<0.8, high<1.5, extreme>1.5)
ORDERBOOK IMBALANCE: ${((orderbook.imbalance || 0.5) * 100).toFixed(1)}%

INDICATORS: ${indicatorSummary}

WEIGHTS: ${weightSummary}

RECENT ACCURACY: WR=${((recentAccuracy.winRate || 0.5) * 100).toFixed(1)}%, trend=${recentAccuracy.trend || 0}

CONFLICTS: ${conflicts.length > 0 ? conflicts.join("; ") : "none detected"}

YOUR TASK:
1. Classify the market regime as ONE of: "trend_continuation", "mean_reversion", "chop_noise", "breakout_volatility"
2. Rate your confidence 0-1
3. If confidence >= 0.6, suggest SMALL weight nudges (max ±5%)
4. Flag any warnings (stale data, impossible values, accuracy collapse, etc.)

RESPOND ONLY WITH VALID JSON:
{
  "regime": "trend_continuation|mean_reversion|chop_noise|breakout_volatility",
  "confidence": 0.5,
  "suggestions": {
    "increase_weight": ["RSI", "Fisher"],
    "decrease_weight": ["MACD"],
    "notes": "RSI and Fisher aligned bullish; MACD lagging"
  },
  "warnings": []
}
    `.trim();
  }

  /**
   * Call the LLM API
   */
  async callAPI(prompt) {
    const payload = {
      model: LLM_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a quantitative trading assistant. You analyze technical indicators to classify market regimes. Always respond with ONLY valid JSON, no markdown or explanations.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1, // low temp for consistency
      max_tokens: 400,
    };

    const response = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `LLM API error ${response.status}: ${response.statusText}`
      );
    }

    const data = await response.json();

    // Handle different API response formats
    let content = "";
    if (data.choices?.[0]?.message?.content) {
      content = data.choices[0].message.content.trim();
    } else if (data.error) {
      throw new Error(`LLM API error: ${data.error.message}`);
    } else {
      throw new Error("Unexpected LLM API response format");
    }

    // Extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      content = jsonMatch[1];
    }

    return JSON.parse(content);
  }

  /**
   * Normalize and validate LLM response
   */
  normalizeResponse(raw) {
    if (!raw) {
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: { notes: "null response" },
        warnings: ["LLM returned null"],
      };
    }

    const regime = this.validateRegime(raw.regime);
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));

    const suggestions = {
      increase_weight: Array.isArray(raw.suggestions?.increase_weight)
        ? raw.suggestions.increase_weight.filter(s => typeof s === 'string')
        : [],
      decrease_weight: Array.isArray(raw.suggestions?.decrease_weight)
        ? raw.suggestions.decrease_weight.filter(s => typeof s === 'string')
        : [],
      notes: typeof raw.suggestions?.notes === 'string' ? raw.suggestions.notes : "",
    };

    const warnings = Array.isArray(raw.warnings)
      ? raw.warnings.map(String).filter(w => w.length > 0)
      : [];

    return {
      regime,
      confidence,
      suggestions,
      warnings,
    };
  }

  validateRegime(regime) {
    const valid = [
      "trend_continuation",
      "mean_reversion",
      "chop_noise",
      "breakout_volatility",
    ];
    return valid.includes(regime) ? regime : "unknown";
  }

  /**
   * Apply LLM suggestions to weights with safety gates
   */
  applyWeights(llmOutput, currentWeights) {
    if (!llmOutput || llmOutput.regime === "unknown") {
      return { changed: false, newWeights: currentWeights };
    }

    if (llmOutput.confidence < 0.6) {
      // Safety gate: need high confidence
      return { changed: false, newWeights: currentWeights };
    }

    let newWeights = { ...currentWeights };
    let changed = false;

    const maxAdjustment = 1.05; // max 5% nudge
    const minAdjustment = 0.95;

    // Apply increases
    for (const signal of llmOutput.suggestions.increase_weight) {
      if (newWeights[signal]) {
        newWeights[signal] = Math.min(newWeights[signal] * maxAdjustment, 2.0); // cap at 2.0x
        changed = true;
      }
    }

    // Apply decreases
    for (const signal of llmOutput.suggestions.decrease_weight) {
      if (signal === "all") {
        for (const key of Object.keys(newWeights)) {
          newWeights[key] = Math.max(newWeights[key] * minAdjustment, 0.3); // floor at 0.3x
        }
        changed = true;
      } else if (newWeights[signal]) {
        newWeights[signal] = Math.max(newWeights[signal] * minAdjustment, 0.3);
        changed = true;
      }
    }

    if (changed) {
      this.stats.influenceCount++;
    }

    return { changed, newWeights };
  }

  /**
   * Log LLM analysis to disk for forensics
   */
  logAnalysis(coin, input, output, applied) {
    try {
      const logDir = path.join(process.cwd(), "logs", "llm");
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const timestamp = new Date().toISOString();
      const filename = path.join(logDir, `${coin}-${Date.now()}.json`);

      fs.writeFileSync(
        filename,
        JSON.stringify(
          {
            timestamp,
            coin,
            input,
            output,
            applied,
          },
          null,
          2
        )
      );
    } catch (err) {
      console.warn("[LLMSignalAssistant] Failed to write log:", err.message);
    }
  }

  /**
   * Get diagnostics
   */
  getDiagnostics() {
    const rate = this.stats.calls > 0 ? (this.stats.successes / this.stats.calls * 100).toFixed(1) : 0;
    return {
      enabled: this.enabled,
      api_url: this.enabled ? LLM_API_URL : "disabled",
      model: this.enabled ? LLM_MODEL : "disabled",
      stats: {
        total_calls: this.stats.calls,
        successes: this.stats.successes,
        failures: this.stats.failures,
        success_rate: `${rate}%`,
        influence_count: this.stats.influenceCount,
      },
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════

module.exports = new LLMSignalAssistant();

if (typeof window !== "undefined") {
  window.LLMSignalAssistant = module.exports;
}

console.log("[LLMSignalAssistant] Module loaded");

