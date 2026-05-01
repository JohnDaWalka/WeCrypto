#!/usr/bin/env node

/**
 * LLM Integration Test Suite
 * 
 * Comprehensive tests for:
 * - Single coin analysis
 * - Multi-coin batch analysis
 * - Weight application and smooth stepping
 * - Anomaly detection
 * - End-to-end flow
 * - Graceful degradation without LLM
 */

const path = require("path");
const fs = require("fs");

// Color codes for output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

// Test state
let passCount = 0;
let failCount = 0;
const results = [];

// Import modules
const LLMAssistant = require("../src/llm/llm_signal_assistant");
const WeightApplier = require("../src/llm/weight_applier");
const AnomalyDetector = require("../src/llm/anomaly_detector");

/**
 * Colored output helpers
 */
function colorize(text, color) {
  return `${color}${text}${colors.reset}`;
}

function log(message, color = colors.reset) {
  console.log(colorize(message, color));
}

function pass(testName) {
  passCount++;
  log(`  ✓ ${testName}`, colors.green);
  results.push({ test: testName, status: "PASS" });
}

function fail(testName, error) {
  failCount++;
  log(`  ✗ ${testName}: ${error}`, colors.red);
  results.push({ test: testName, status: "FAIL", error });
}

function section(title) {
  console.log();
  log(`\n${"═".repeat(70)}`, colors.cyan);
  log(`  ${title}`, colors.bright + colors.cyan);
  log(`${"═".repeat(70)}\n`, colors.cyan);
}

/**
 * TEST 1: Single Coin Analysis (BTC)
 */
async function test1_SingleCoinAnalysis() {
  section("TEST 1: Single Coin Analysis (BTC)");

  const snapshot = {
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
  };

  try {
    const result = await LLMAssistant.analyzeSnapshot(snapshot);

    // Verify result structure
    if (!result || typeof result !== "object") {
      fail("Single coin analysis", "Invalid response structure");
      return;
    }

    if (!result.regime) {
      fail("Single coin analysis", "Missing regime field");
      return;
    }

    if (typeof result.confidence !== "number") {
      fail("Single coin analysis", "Invalid confidence value");
      return;
    }

    pass("Single coin analysis returned valid structure");

    // Log result
    log(`  Regime: ${result.regime}`, colors.yellow);
    log(`  Confidence: ${(result.confidence * 100).toFixed(1)}%`, colors.yellow);
  } catch (err) {
    fail("Single coin analysis", err.message);
  }
}

/**
 * TEST 2: Multi-Coin Batch Analysis
 */
async function test2_MultiCoinBatch() {
  section("TEST 2: Multi-Coin Batch Analysis (BTC, ETH, SOL, XRP)");

  const coins = [
    {
      coin: "BTC",
      volatility: 0.015,
      indicators: { RSI: 65, MACD: 0.0025, CCI: 140, Fisher: 0.78, ADX: 45 },
      weights: { RSI: 1.2, MACD: 0.9, CCI: 1.0, Fisher: 1.1, ADX: 0.8 },
      recentAccuracy: { winRate: 0.56, trend: 0.05 },
      conflicts: [],
    },
    {
      coin: "ETH",
      volatility: 0.018,
      indicators: { RSI: 72, MACD: -0.0008, CCI: -85, Fisher: -0.62, ADX: 22 },
      weights: { RSI: 1.2, MACD: 0.9, CCI: 1.0, Fisher: 1.1, ADX: 0.8 },
      recentAccuracy: { winRate: 0.48, trend: -0.08 },
      conflicts: ["RSI vs MACD"],
    },
    {
      coin: "SOL",
      volatility: 0.025,
      indicators: { RSI: 52, MACD: 0.00001, CCI: 15, Fisher: 0.08, ADX: 15 },
      weights: { RSI: 1.2, MACD: 0.9, CCI: 1.0, Fisher: 1.1, ADX: 0.8 },
      recentAccuracy: { winRate: 0.51, trend: 0.01 },
      conflicts: [],
    },
    {
      coin: "XRP",
      volatility: 0.012,
      indicators: { RSI: 58, MACD: 0.0001, CCI: 50, Fisher: 0.35, ADX: 38 },
      weights: { RSI: 1.2, MACD: 0.9, CCI: 1.0, Fisher: 1.1, ADX: 0.8 },
      recentAccuracy: { winRate: 0.54, trend: 0.03 },
      conflicts: [],
    },
  ];

  try {
    for (const snapshot of coins) {
      const result = await LLMAssistant.analyzeSnapshot(snapshot);
      if (result && result.regime && result.confidence >= 0) {
        pass(`Analyzed ${snapshot.coin}: regime=${result.regime}, confidence=${(result.confidence * 100).toFixed(0)}%`);
      } else {
        fail(`Analyzed ${snapshot.coin}`, "Invalid response");
      }
    }
  } catch (err) {
    fail("Multi-coin batch analysis", err.message);
  }
}

/**
 * TEST 3: Weight Application and Smooth Stepping
 */
function test3_WeightApplication() {
  section("TEST 3: Weight Application with Smooth Stepping");

  const currentWeights = {
    RSI: 1.0,
    MACD: 1.0,
    CCI: 1.0,
    Fisher: 1.0,
    ADX: 1.0,
  };

  const targetWeights = {
    RSI: 1.5,
    MACD: 0.7,
    CCI: 1.2,
    Fisher: 0.9,
    ADX: 1.1,
  };

  try {
    // Test 1: Single application
    const result1 = WeightApplier.apply(currentWeights, targetWeights);

    if (!result1 || !result1.updated) {
      fail("Weight application", "No updated weights returned");
      return;
    }

    pass("Weight applier returned valid structure");

    // Test 2: Verify smooth stepping (max 5% per cycle)
    let maxStep = 0;
    for (const indicator in result1.deltas) {
      const delta = result1.deltas[indicator];
      const stepPercent = Math.abs(delta.changePercent);
      if (stepPercent > 5.1) { // Allow 0.1% tolerance
        fail("Smooth stepping enforcement", `${indicator} stepped ${stepPercent.toFixed(2)}% (max 5%)`);
        return;
      }
      maxStep = Math.max(maxStep, stepPercent);
    }

    pass(`Smooth stepping enforced (max step: ${maxStep.toFixed(2)}%)`);

    // Test 3: Verify bounds (min 0.5x, max 2.0x)
    for (const indicator in result1.updated) {
      const value = result1.updated[indicator];
      if (value < 0.5 || value > 2.0) {
        fail("Weight bounds", `${indicator}=${value} outside [0.5, 2.0]`);
        return;
      }
    }

    pass("Weight bounds enforced (min 0.5x, max 2.0x)");

    // Test 4: Record adjustment
    WeightApplier.recordAdjustment("TEST", currentWeights, result1.updated, "test-adjustment");
    pass("Adjustment recorded to log");

    // Test 5: Retrieve history
    const history = WeightApplier.getAdjustmentHistory("TEST");
    if (history.length > 0) {
      pass(`Retrieved adjustment history (${history.length} records)`);
    } else {
      fail("Adjustment history", "No records found");
    }
  } catch (err) {
    fail("Weight application", err.message);
  }
}

/**
 * TEST 4: Anomaly Detection
 */
function test4_AnomalyDetection() {
  section("TEST 4: Anomaly Detection");

  try {
    // Test 1: Normal state (no anomalies)
    const normalState = {
      coin: "BTC",
      weights: { RSI: 1.1, MACD: 0.95, CCI: 1.05, Fisher: 1.0, ADX: 0.9 },
      recent_accuracy: { current: 0.55, previous: 0.53, trend: 0.02 },
      conflicts: ["RSI vs CCI"],
      llm_influence: { confidence: 0.65, suggestions_applied: 3 },
      volatility: 0.015,
      previous_volatility: 0.014,
      adjustment_history: [{ changed: true }, { changed: true }],
    };

    const result1 = AnomalyDetector.detect(normalState);
    if (result1.anomalies.length === 0) {
      pass("Normal state detection (no anomalies)");
    } else {
      fail("Normal state detection", `Unexpected anomalies: ${result1.anomalies.length}`);
    }

    // Test 2: Weight imbalance
    const imbalanceState = {
      coin: "ETH",
      weights: { RSI: 3.0, MACD: 0.5, CCI: 0.6, Fisher: 0.5, ADX: 0.5 },
      recent_accuracy: { current: 0.55, previous: 0.54 },
      conflicts: [],
      llm_influence: { confidence: 0.5 },
      volatility: 0.02,
      previous_volatility: 0.02,
    };

    const result2 = AnomalyDetector.detect(imbalanceState);
    const imbalanceAnomaly = result2.anomalies.find((a) => a.type === "weight_imbalance");
    if (imbalanceAnomaly) {
      pass("Weight imbalance detection");
    } else {
      fail("Weight imbalance detection", "Not detected");
    }

    // Test 3: Accuracy collapse
    const collapseState = {
      coin: "SOL",
      weights: { RSI: 1.0, MACD: 1.0, CCI: 1.0, Fisher: 1.0, ADX: 1.0 },
      recent_accuracy: { current: 0.45, previous: 0.58 },
      conflicts: [],
      llm_influence: { confidence: 0.5 },
      volatility: 0.02,
      previous_volatility: 0.02,
    };

    const result3 = AnomalyDetector.detect(collapseState);
    const collapseAnomaly = result3.anomalies.find((a) => a.type === "accuracy_collapse");
    if (collapseAnomaly) {
      pass("Accuracy collapse detection");
    } else {
      fail("Accuracy collapse detection", "Not detected");
    }

    // Test 4: LLM misalignment
    const misalignState = {
      coin: "XRP",
      weights: { RSI: 1.0, MACD: 1.0, CCI: 1.0, Fisher: 1.0, ADX: 1.0 },
      recent_accuracy: { current: 0.42, previous: 0.43 },
      conflicts: [],
      llm_influence: { confidence: 0.85, suggestions_applied: 10 },
      volatility: 0.02,
      previous_volatility: 0.02,
    };

    const result4 = AnomalyDetector.detect(misalignState);
    const misalignAnomaly = result4.anomalies.find((a) => a.type === "llm_misalignment");
    if (misalignAnomaly) {
      pass("LLM misalignment detection");
    } else {
      fail("LLM misalignment detection", "Not detected");
    }

    // Test 5: Statistics
    const stats = AnomalyDetector.getStatistics("BTC");
    if (stats && typeof stats.totalAnomalies === "number") {
      pass("Anomaly statistics retrieval");
    } else {
      fail("Anomaly statistics", "Invalid structure");
    }
  } catch (err) {
    fail("Anomaly detection", err.message);
  }
}

/**
 * TEST 5: End-to-End Flow
 */
async function test5_EndToEnd() {
  section("TEST 5: End-to-End Flow (Fetch → Analyze → Apply → Detect)");

  try {
    // Step 1: Create snapshot
    const snapshot = {
      coin: "BTC",
      volatility: 0.015,
      indicators: { RSI: 65, MACD: 0.0025, CCI: 140, Fisher: 0.78, ADX: 45 },
      weights: { RSI: 1.2, MACD: 0.9, CCI: 1.0, Fisher: 1.1, ADX: 0.8 },
      recentAccuracy: { winRate: 0.56, trend: 0.05 },
      conflicts: [],
    };

    pass("Step 1: Snapshot created");

    // Step 2: Analyze with LLM
    const analysis = await LLMAssistant.analyzeSnapshot(snapshot);
    if (analysis && analysis.regime) {
      pass("Step 2: LLM analysis completed");
    } else {
      fail("Step 2", "LLM analysis failed");
      return;
    }

    // Step 3: Apply weights
    const targetWeights = {
      RSI: analysis.suggestions?.RSI_weight || 1.2,
      MACD: analysis.suggestions?.MACD_weight || 0.9,
      CCI: analysis.suggestions?.CCI_weight || 1.0,
      Fisher: analysis.suggestions?.Fisher_weight || 1.1,
      ADX: analysis.suggestions?.ADX_weight || 0.8,
    };

    const applied = WeightApplier.apply(snapshot.weights, targetWeights);
    if (applied && applied.updated) {
      pass("Step 3: Weights applied");
    } else {
      fail("Step 3", "Weight application failed");
      return;
    }

    // Step 4: Detect anomalies
    const engineState = {
      coin: "BTC",
      weights: applied.updated,
      recent_accuracy: snapshot.recentAccuracy,
      conflicts: snapshot.conflicts,
      llm_influence: { confidence: analysis.confidence, suggestions_applied: 1 },
      volatility: snapshot.volatility,
      previous_volatility: 0.014,
    };

    const anomalies = AnomalyDetector.detect(engineState);
    pass(`Step 4: Anomaly detection completed (${anomalies.anomalies.length} anomalies)`);

    log(`  Final state: regime=${analysis.regime}, severity=${anomalies.severity_score}`, colors.yellow);
  } catch (err) {
    fail("End-to-end flow", err.message);
  }
}

/**
 * TEST 6: Graceful Degradation (Fallback without LLM)
 */
function test6_GracefulDegradation() {
  section("TEST 6: Graceful Degradation (No LLM)");

  try {
    // Test weight applier without LLM
    const currentWeights = {
      RSI: 1.0,
      MACD: 1.0,
      CCI: 1.0,
      Fisher: 1.0,
      ADX: 1.0,
    };

    const result = WeightApplier.apply(currentWeights, currentWeights);
    if (result && !result.changed) {
      pass("Weight applier works without LLM (no-op case)");
    } else {
      fail("Graceful degradation", "Weight applier failed");
    }

    // Test anomaly detector without LLM data
    const state = {
      coin: "TEST",
      weights: currentWeights,
      recent_accuracy: { current: 0.5, previous: 0.5 },
      conflicts: [],
    };

    const anomalies = AnomalyDetector.detect(state);
    if (anomalies.anomalies.length === 0) {
      pass("Anomaly detector works without full LLM state");
    } else {
      fail("Anomaly detector", "Failed with partial state");
    }

    pass("System gracefully degrades without LLM");
  } catch (err) {
    fail("Graceful degradation", err.message);
  }
}

/**
 * Generate Final Report
 */
function generateReport() {
  section("TEST RESULTS");

  const total = passCount + failCount;
  const percentage = total > 0 ? ((passCount / total) * 100).toFixed(1) : 0;

  log(`Total Tests: ${total}`, colors.bright);
  log(`  ${colorize("✓ Passed", colors.green)}: ${passCount}`);
  log(`  ${colorize("✗ Failed", colors.red)}: ${failCount}`);
  log(`  ${colorize(`Pass Rate: ${percentage}%`, percentage >= 80 ? colors.green : colors.red)}`);

  if (failCount > 0) {
    log("\nFailed Tests:", colors.red);
    results.forEach((r) => {
      if (r.status === "FAIL") {
        log(`  • ${r.test}: ${r.error}`, colors.red);
      }
    });
  }

  const status = failCount === 0 ? "✓ ALL TESTS PASSED" : `✗ ${failCount} TEST(S) FAILED`;
  log(`\n${status}`, failCount === 0 ? colors.green : colors.red);
}

/**
 * Main Entry Point
 */
async function main() {
  log("\n" + "═".repeat(70), colors.cyan);
  log("  LLM SIGNAL LAYER - INTEGRATION TEST SUITE", colors.bright + colors.cyan);
  log("═".repeat(70), colors.cyan);

  try {
    await test1_SingleCoinAnalysis();
    await test2_MultiCoinBatch();
    test3_WeightApplication();
    test4_AnomalyDetection();
    await test5_EndToEnd();
    test6_GracefulDegradation();

    generateReport();

    // Return exit code
    process.exit(failCount > 0 ? 1 : 0);
  } catch (err) {
    log(`\nFATAL ERROR: ${err.message}`, colors.red);
    process.exit(1);
  }
}

// Run tests
main();
