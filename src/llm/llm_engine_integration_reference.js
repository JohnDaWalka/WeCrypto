/**
 * LLM Engine Integration Example
 * 
 * Shows how to wire LLM signal assistant, anomaly detector, and response handler
 * into the main 30-second polling cycle
 * 
 * This is a reference implementation. Copy relevant portions into src/core/app.js
 */

const LLMAssistant = require("./llm_signal_assistant");
const AnomalyResponseHandler = require("./anomaly_response_handler");
const { analyzeBatch } = require("./multi_coin_analyzer");

let llmCycleCount = 0;
let llmSuccesses = 0;

/**
 * Main LLM integration function
 * Call this every N cycles (e.g., every 2-3 cycles, not every cycle)
 */
async function runLLMCycle(snapshot, weights, gates) {
  llmCycleCount++;

  try {
    // STEP 1: Analyze snapshot with LLM
    console.log(`[LLMEngine] Cycle ${llmCycleCount}: Running LLM analysis...`);
    
    const llmResult = await LLMAssistant.analyzeSnapshot(snapshot);

    if (llmResult.regime === "unknown") {
      console.log("[LLMEngine] LLM returned unknown regime, skipping adjustments");
      return { applied: false, reason: "unknown_regime" };
    }

    // STEP 2: Apply LLM weight suggestions
    console.log(`[LLMEngine] Regime: ${llmResult.regime}, Confidence: ${llmResult.confidence.toFixed(2)}`);

    const { updated: adjustedWeights, changed } = LLMAssistant.applyWeights(
      llmResult,
      weights
    );

    if (changed) {
      llmSuccesses++;
      console.log(`[LLMEngine] ✓ Applied LLM suggestions (influence score: ${(llmSuccesses / llmCycleCount * 100).toFixed(1)}%)`);
    }

    // STEP 3: Log the analysis
    const coin = snapshot.coin || "UNKNOWN";
    LLMAssistant.logAnalysis(coin, snapshot, llmResult, changed);

    // STEP 4: Detector anomalies in response
    const engineState = {
      weights: adjustedWeights,
      recent_accuracy: snapshot.recent_accuracy_window || {},
      volatility: snapshot.volatility || 0,
      indicator_conflicts: snapshot.indicator_conflicts || 0,
      llm_influence_score: llmSuccesses / llmCycleCount,
    };

    // Note: Anomaly detector would go here if you have it implemented
    // const anomaly = AnomalyDetector.detect(engineState);
    // const recovery = AnomalyResponseHandler.handle(anomaly, adjustedWeights, gates);

    return {
      applied: changed,
      regime: llmResult.regime,
      confidence: llmResult.confidence,
      newWeights: adjustedWeights,
      suggestions: llmResult.suggestions,
    };
  } catch (err) {
    console.error("[LLMEngine] Cycle failed:", err.message);
    return { applied: false, reason: "error", error: err.message };
  }
}

/**
 * Multi-coin batch analysis
 * Call this once per minute for all active coins
 */
async function runBatchAnalysis(coinSnapshots) {
  try {
    console.log(`[LLMEngine] Running batch analysis for ${Object.keys(coinSnapshots).length} coins...`);

    const batchResult = await analyzeBatch(coinSnapshots, LLMAssistant);

    if (!batchResult) {
      console.warn("[LLMEngine] Batch analysis failed");
      return null;
    }

    console.log(`[LLMEngine] Batch analysis complete, got regimes for ${Object.keys(batchResult).length} coins`);

    // Apply per-coin target weights
    const perCoinAdjustments = {};
    for (const [coin, analysis] of Object.entries(batchResult)) {
      if (analysis.target_weights) {
        perCoinAdjustments[coin] = {
          regime: analysis.regime,
          confidence: analysis.confidence,
          targets: analysis.target_weights,
          warnings: analysis.warnings || [],
        };
      }
    }

    return perCoinAdjustments;
  } catch (err) {
    console.error("[LLMEngine] Batch analysis error:", err.message);
    return null;
  }
}

/**
 * Get LLM influence metrics
 */
function getLLMMetrics() {
  const diagnostics = LLMAssistant.getDiagnostics();
  const recoveryStatus = AnomalyResponseHandler.getStatus();

  return {
    llm: {
      ...diagnostics,
      influence_score: llmCycleCount > 0 ? (llmSuccesses / llmCycleCount * 100).toFixed(1) + "%" : "N/A",
    },
    recovery: recoveryStatus,
  };
}

/**
 * Example: How to integrate into app.js 30-second polling loop
 * 
 * In src/core/app.js, add this to the historicalPollTimer callback:
 * 
 * ```javascript
 * // Every 2 cycles (every 60 seconds), run LLM analysis
 * if (cycleCount % 2 === 0) {
 *   const llmResult = await runLLMCycle(snapshot, weights, gates);
 *   if (llmResult.applied) {
 *     // Update weights for next predictions
 *     Object.assign(weights, llmResult.newWeights);
 *   }
 * }
 * 
 * // Every 4 cycles (every 2 minutes), run batch analysis
 * if (cycleCount % 4 === 0) {
 *   const batchAdjustments = await runBatchAnalysis(allCoinSnapshots);
 *   if (batchAdjustments) {
 *     // Apply per-coin adjustments
 *     for (const [coin, adj] of Object.entries(batchAdjustments)) {
 *       Object.assign(weights[coin], adj.targets);
 *     }
 *   }
 * }
 * 
 * // Every 6 cycles, tick recovery counter and check metrics
 * if (cycleCount % 6 === 0) {
 *   AnomalyResponseHandler.tickRecovery();
 *   const metrics = getLLMMetrics();
 *   console.log("[App] LLM Metrics:", metrics);
 * }
 * ```
 */

// ══════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════

module.exports = {
  runLLMCycle,
  runBatchAnalysis,
  getLLMMetrics,
};

console.log("[LLMEngineIntegration] Reference implementation loaded");
