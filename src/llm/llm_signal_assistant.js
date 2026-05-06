/**
 * LLM Signal Assistant — Real LLM-Powered Analysis Layer
 * 
 * Connects to Google Gemini SDK or any chat-completions compatible API
 * Uses SPECIALIZED prompt for 9-indicator crypto engine
 * Non-blocking, safe-gated, fully logged
 */

const fs = require("fs");
const path = require("path");
const { generateSystemPrompt, generateUserPrompt } = require("./specialized_prompt");

// Configuration from environment
const LLM_API_URL = process.env.LLM_API_URL || "https://api.openai.com/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4-mini";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
const GOOGLE_MODEL = process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash";
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "auto").toLowerCase();
const CONTEXT_CACHE_TTL_MS = Number(process.env.LLM_CONTEXT_CACHE_TTL_MS || 15000);
const MARKET_MEMORY_LIMIT = Number(process.env.LLM_MARKET_MEMORY_LIMIT || 12);

class LLMSignalAssistant {
  constructor() {
    this.provider = this.resolveProvider();
    this.enabled = this.provider === "google"
      ? !!GOOGLE_API_KEY
      : !!(LLM_API_URL && LLM_API_KEY);
    this.contextCache = new Map();      // short-lived prompt/result cache
    this.marketMemory = new Map();      // per-coin rolling recall memory
    this._googleClient = null;
    this._googleClientKind = null;

    this.stats = {
      calls: 0,
      successes: 0,
      failures: 0,
      influenceCount: 0,
      cacheHits: 0,
    };

    console.log(
      `[LLMSignalAssistant] Initialized ${this.enabled ? "✓ ENABLED" : "⚠ DISABLED"} ` +
      `(provider=${this.provider}, model=${this.provider === "google" ? GOOGLE_MODEL : LLM_MODEL})`
    );
  }

  resolveProvider() {
    if (LLM_PROVIDER === "google") return "google";
    if (LLM_PROVIDER === "openai" || LLM_PROVIDER === "compatible") return "compatible";
    if (GOOGLE_API_KEY) return "google";
    return "compatible";
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

    try {
      const cacheKey = this.getCacheKey(snapshot);
      const now = Date.now();
      const cached = this.contextCache.get(cacheKey);
      if (cached && (now - cached.ts) < CONTEXT_CACHE_TTL_MS) {
        this.stats.cacheHits++;
        return cached.value;
      }

      // Use specialized prompt
      const systemPrompt = generateSystemPrompt();
      const rawUserPrompt = generateUserPrompt(snapshot);
      const userPrompt = this.enrichPromptWithRecall(snapshot, rawUserPrompt);

      const rawResponse = await this.callAPI(systemPrompt, userPrompt);
      const normalized = this.normalizeResponse(rawResponse);
      this.recordMarketMemory(snapshot, normalized);
      this.contextCache.set(cacheKey, { ts: now, value: normalized });
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
   * Call the LLM API with specialized prompts
   */
  getCacheKey(snapshot) {
    const coin = String(snapshot?.coin || "ALL");
    const horizon = String(snapshot?.horizon || "h15");
    const volatility = Number(snapshot?.volatility || 0).toFixed(4);
    const indicatorsHash = JSON.stringify(snapshot?.indicators || {});
    return `${coin}|${horizon}|${volatility}|${indicatorsHash}`;
  }

  getRecentMemory(coin, limit = 4) {
    const key = String(coin || "ALL");
    const rows = this.marketMemory.get(key) || [];
    return rows.slice(-limit);
  }

  enrichPromptWithRecall(snapshot, userPrompt) {
    const coin = String(snapshot?.coin || "ALL");
    const recent = this.getRecentMemory(coin, 4);
    if (!recent.length) return userPrompt;

    const recall = recent.map((row, idx) => {
      const conf = Math.round((row.confidence || 0) * 100);
      const notes = row?.suggestions?.notes || "";
      return `${idx + 1}. regime=${row.regime} conf=${conf}% notes=${notes.slice(0, 180)}`;
    }).join("\n");

    return `${userPrompt}

Recent memory for ${coin} (most recent last):
${recall}

Use this recall only as context, and prioritize current market snapshot data if conflict occurs.`;
  }

  recordMarketMemory(snapshot, output) {
    const key = String(snapshot?.coin || "ALL");
    const rows = this.marketMemory.get(key) || [];
    rows.push({
      ts: Date.now(),
      regime: output?.regime || "unknown",
      confidence: Number(output?.confidence || 0),
      suggestions: output?.suggestions || {},
      warnings: output?.warnings || [],
    });
    if (rows.length > MARKET_MEMORY_LIMIT) rows.splice(0, rows.length - MARKET_MEMORY_LIMIT);
    this.marketMemory.set(key, rows);
  }

  /**
   * Call the LLM API with specialized prompts
   */
  async callAPI(systemPrompt, userPrompt) {
    if (this.provider === "google") {
      return this.callGoogleAPI(systemPrompt, userPrompt);
    }

    return this.callCompatibleAPI(systemPrompt, userPrompt);
  }

  async callCompatibleAPI(systemPrompt, userPrompt) {
    const payload = {
      model: LLM_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.1, // low temp for consistency
      max_tokens: 600,
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

  getGoogleClient() {
    if (this._googleClient) {
      return { kind: this._googleClientKind, client: this._googleClient };
    }

    try {
      const { GoogleGenAI } = require("@google/genai");
      this._googleClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
      this._googleClientKind = "genai";
      return { kind: this._googleClientKind, client: this._googleClient };
    } catch (_) {}

    try {
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      this._googleClient = new GoogleGenerativeAI(GOOGLE_API_KEY);
      this._googleClientKind = "generative-ai";
      return { kind: this._googleClientKind, client: this._googleClient };
    } catch (_) {}

    throw new Error("Google provider selected but no supported SDK found (@google/genai or @google/generative-ai)");
  }

  extractJsonContent(rawText) {
    const content = String(rawText || "").trim();
    if (!content) throw new Error("Empty LLM response");

    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return fenced[1];

    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }

    return content;
  }

  async callGoogleAPI(systemPrompt, userPrompt) {
    if (!GOOGLE_API_KEY) {
      throw new Error("GOOGLE_API_KEY (or GEMINI_API_KEY) is required for Google provider");
    }

    const { kind, client } = this.getGoogleClient();
    const prompt = `${systemPrompt}\n\nReturn valid JSON only.\n\n${userPrompt}`;
    let content = "";

    if (kind === "genai") {
      const response = await client.models.generateContent({
        model: GOOGLE_MODEL,
        contents: prompt,
        config: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      });
      content = typeof response?.text === "function" ? response.text() : response?.text;
    } else {
      const model = client.getGenerativeModel({
        model: GOOGLE_MODEL,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      content = typeof response?.text === "function" ? response.text() : response?.text;
    }

    const json = this.extractJsonContent(content);
    return JSON.parse(json);
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

    const increaseWeight = Array.isArray(raw.suggestions?.increase_weight)
      ? raw.suggestions.increase_weight
      : Array.isArray(raw.suggestions?.increase)
        ? raw.suggestions.increase
        : [];
    const decreaseWeight = Array.isArray(raw.suggestions?.decrease_weight)
      ? raw.suggestions.decrease_weight
      : Array.isArray(raw.suggestions?.decrease)
        ? raw.suggestions.decrease
        : [];

    const suggestions = {
      increase_weight: increaseWeight.filter(s => typeof s === 'string'),
      decrease_weight: decreaseWeight.filter(s => typeof s === 'string'),
      notes: typeof raw.suggestions?.notes === 'string' ? raw.suggestions.notes :
             typeof raw.suggestions?.reasoning === 'string' ? raw.suggestions.reasoning :
             typeof raw.suggestions?.summary === 'string' ? raw.suggestions.summary : "",
    };

    const warnings = Array.isArray(raw.warnings)
      ? raw.warnings.map(String).filter(w => w.length > 0)
      : Array.isArray(raw.suggestions?.issues)
        ? raw.suggestions.issues.map(String).filter(w => w.length > 0)
      : [];

    return {
      regime,
      confidence,
      suggestions,
      warnings,
      analysis: raw.analysis || {},
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
      provider: this.provider,
      api_url: this.enabled
        ? (this.provider === "google" ? "google-sdk" : LLM_API_URL)
        : "disabled",
      model: this.enabled
        ? (this.provider === "google" ? GOOGLE_MODEL : LLM_MODEL)
        : "disabled",
      stats: {
        total_calls: this.stats.calls,
        successes: this.stats.successes,
        failures: this.stats.failures,
        success_rate: `${rate}%`,
        influence_count: this.stats.influenceCount,
        cache_hits: this.stats.cacheHits,
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

console.log("[LLMSignalAssistant] Module loaded with SPECIALIZED prompts");

