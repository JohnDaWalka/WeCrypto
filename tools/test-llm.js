#!/usr/bin/env node

/**
 * CLI Test Harness for LLM Signal Assistant
 * 
 * Run from terminal:
 *   Set env vars first (PowerShell):
 *     $env:LLM_API_URL = "https://api.openai.com/v1/chat/completions"
 *     $env:LLM_API_KEY = "sk-..."
 *     $env:LLM_MODEL = "gpt-4-mini"
 *   
 *   Then run:
 *     node tools\test-llm.js
 */

const LLMAssistant = require("../src/llm/llm_signal_assistant");

// Test scenarios
const testSnapshots = [
  {
    name: "Trend Continuation (Strong Signals)",
    snapshot: {
      coin: "BTC",
      volatility: 0.015,
      orderbook: { imbalance: 0.72, buyPressure: 0.72 },
      indicators: {
        RSI: 65,
        MACD: 0.0025,
        CCI: 140,
        Fisher: 0.78,
        ADX: 45,
      },
      weights: {
        RSI: 1.2,
        MACD: 0.9,
        CCI: 1.0,
        Fisher: 1.1,
        ADX: 0.8,
      },
      recentAccuracy: { winRate: 0.56, trend: 0.05 },
      conflicts: [],
    },
  },
  {
    name: "Mean Reversion (Conflicting Signals)",
    snapshot: {
      coin: "ETH",
      volatility: 0.008,
      orderbook: { imbalance: 0.51, buyPressure: 0.51 },
      indicators: {
        RSI: 72,
        MACD: -0.0008,
        CCI: -85,
        Fisher: -0.62,
        ADX: 22,
      },
      weights: {
        RSI: 1.2,
        MACD: 0.9,
        CCI: 1.0,
        Fisher: 1.1,
        ADX: 0.8,
      },
      recentAccuracy: { winRate: 0.48, trend: -0.08 },
      conflicts: ["RSI vs MACD", "CCI vs Fisher"],
    },
  },
  {
    name: "Chop / Noise (Low Confidence)",
    snapshot: {
      coin: "SOL",
      volatility: 0.002,
      orderbook: { imbalance: 0.52, buyPressure: 0.51 },
      indicators: {
        RSI: 52,
        MACD: 0.00001,
        CCI: 15,
        Fisher: 0.08,
        ADX: 15,
      },
      weights: {
        RSI: 0.8,
        MACD: 0.7,
        CCI: 0.9,
        Fisher: 0.85,
        ADX: 1.2,
      },
      recentAccuracy: { winRate: 0.50, trend: 0.0 },
      conflicts: ["all indicators neutral"],
    },
  },
  {
    name: "Breakout Volatility (High Risk)",
    snapshot: {
      coin: "XRP",
      volatility: 2.1,
      orderbook: { imbalance: 0.85, buyPressure: 0.85 },
      indicators: {
        RSI: 82,
        MACD: 0.0089,
        CCI: 312,
        Fisher: 1.2,
        ADX: 58,
      },
      weights: {
        RSI: 1.4,
        MACD: 1.2,
        CCI: 1.3,
        Fisher: 1.5,
        ADX: 1.1,
      },
      recentAccuracy: { winRate: 0.62, trend: 0.12 },
      conflicts: [],
    },
  },
];

// ──────────────────────────────────────────────────────────────
// MAIN TEST RUNNER
// ──────────────────────────────────────────────────────────────

(async () => {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║           LLM SIGNAL ASSISTANT — TEST HARNESS              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Check configuration
  const diagnostics = LLMAssistant.getDiagnostics();
  console.log(`📊 LLM Status: ${diagnostics.enabled ? "✓ ENABLED" : "⚠ DISABLED"}`);
  if (diagnostics.enabled) {
    console.log(`   API URL: ${diagnostics.api_url}`);
    console.log(`   Model: ${diagnostics.model}`);
  } else {
    console.log(
      "   ⚠ Set LLM_API_URL and LLM_API_KEY env vars to enable LLM features"
    );
    console.log("   Falling back to mock responses for demonstration...\n");
  }

  // Run each test
  for (const test of testSnapshots) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`🧪 TEST: ${test.name}`);
    console.log(`${"─".repeat(60)}`);

    console.log("\n📥 INPUT SNAPSHOT:");
    console.log(`   Coin: ${test.snapshot.coin}`);
    console.log(`   Volatility: ${test.snapshot.volatility.toFixed(3)}`);
    console.log(`   RSI: ${test.snapshot.indicators.RSI}`);
    console.log(`   MACD: ${test.snapshot.indicators.MACD.toFixed(4)}`);
    console.log(`   CCI: ${test.snapshot.indicators.CCI}`);
    console.log(`   Win Rate: ${(test.snapshot.recentAccuracy.winRate * 100).toFixed(1)}%`);
    if (test.snapshot.conflicts.length > 0) {
      console.log(`   ⚠ Conflicts: ${test.snapshot.conflicts.join(", ")}`);
    }

    try {
      console.log("\n⏳ Calling LLM...");
      const result = await LLMAssistant.analyzeSnapshot(test.snapshot);

      console.log("\n📤 LLM OUTPUT:");
      console.log(`   Regime: ${result.regime}`);
      console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);

      if (result.suggestions && result.suggestions.increase_weight && result.suggestions.increase_weight.length > 0) {
        console.log(
          `   📈 Increase: ${result.suggestions.increase_weight.join(", ")}`
        );
      }
      if (result.suggestions && result.suggestions.decrease_weight && result.suggestions.decrease_weight.length > 0) {
        console.log(
          `   📉 Decrease: ${result.suggestions.decrease_weight.join(", ")}`
        );
      }
      if (result.suggestions && result.suggestions.notes) {
        console.log(`   💬 Notes: ${result.suggestions.notes}`);
      }

      if (result.warnings && result.warnings.length > 0) {
        console.log(`   ⚠️ Warnings:`);
        result.warnings.forEach((w) => console.log(`      - ${w}`));
      }

      // Simulate weight application
      console.log("\n🔧 SIMULATED WEIGHT APPLICATION:");
      const appliedWeights = JSON.parse(JSON.stringify(test.snapshot.weights));
      const { changed, newWeights } = LLMAssistant.applyWeights(
        result,
        appliedWeights
      );

      if (changed) {
        console.log("   ✓ Weights adjusted:");
        for (const [signal, oldWeight] of Object.entries(appliedWeights)) {
          const newWeight = newWeights[signal];
          const pct = ((newWeight / oldWeight - 1) * 100).toFixed(1);
          if (Math.abs(newWeight - oldWeight) > 0.001) {
            console.log(
              `      ${signal}: ${oldWeight.toFixed(2)}x → ${newWeight.toFixed(2)}x (${pct > 0 ? "+" : ""}${pct}%)`
            );
          }
        }
      } else {
        console.log("   ✗ No weight changes (safety gates applied)");
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n${"─".repeat(60)}`);
  console.log("📈 DIAGNOSTICS:");
  console.log(`${"─".repeat(60)}`);
  const finalDiagnostics = LLMAssistant.getDiagnostics();
  console.log(`Total calls: ${finalDiagnostics.stats.total_calls}`);
  console.log(`Successes: ${finalDiagnostics.stats.successes}`);
  console.log(`Failures: ${finalDiagnostics.stats.failures}`);
  console.log(`Success rate: ${finalDiagnostics.stats.success_rate}`);
  console.log(`Times LLM influenced weights: ${finalDiagnostics.stats.influence_count}`);

  console.log("\n✅ Test suite complete!\n");
})();
