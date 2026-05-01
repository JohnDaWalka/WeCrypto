/**
 * Anomaly Response Examples
 * 
 * Demonstrates how the anomaly response handler recovers from different
 * engine failure modes in real-time
 */

const AnomalyResponseHandler = require("../src/llm/anomaly_response_handler");

// ══════════════════════════════════════════════════════════════
// SCENARIO 1: High Severity - Accuracy Collapse
// ══════════════════════════════════════════════════════════════

function scenario1_accuracyCollapse() {
  console.log("\n" + "═".repeat(70));
  console.log("SCENARIO 1: Accuracy Collapse (HIGH SEVERITY)");
  console.log("═".repeat(70));

  const anomaly = {
    anomaly: true,
    severity: "high",
    reason: "Accuracy dropped from 52% to 38% in last window",
    target: "all_weights",
  };

  const currentWeights = {
    RSI: 1.2,
    MACD: 0.95,
    CCI: 1.1,
    Fisher: 0.9,
    ADX: 1.05,
    ATR: 0.88,
    OrderBook: 1.15,
    KalshiPercent: 0.92,
    CrowdFade: 1.0,
  };

  const currentGates = {
    BTC: { minAbsScore: 0.45 },
    ETH: { minAbsScore: 0.50 },
    SOL: { minAbsScore: 0.50 },
  };

  console.log("\nBefore anomaly:");
  console.log("  Weights:", JSON.stringify(currentWeights, null, 2).split("\n").join("\n  "));
  console.log("  Gates:", JSON.stringify(currentGates, null, 2).split("\n").join("\n  "));

  const response = AnomalyResponseHandler.handle(anomaly, currentWeights, currentGates);

  console.log("\nAfter anomaly response:");
  console.log("  Actions:", JSON.stringify(response.actions, null, 2).split("\n").join("\n  "));
  console.log("  Recovery mode:", response.inRecovery);
  console.log("  Recovery cycles remaining:", response.recoveryTimeRemaining);
  console.log("  Adjusted weights:", JSON.stringify(response.weightsAfter, null, 2).split("\n").join("\n  "));

  return response;
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 2: Medium Severity - High Conflicts
// ══════════════════════════════════════════════════════════════

function scenario2_highConflicts() {
  console.log("\n" + "═".repeat(70));
  console.log("SCENARIO 2: High Indicator Conflicts (MEDIUM SEVERITY)");
  console.log("═".repeat(70));

  const anomaly = {
    anomaly: true,
    severity: "medium",
    reason: "Indicator conflicts high (6 conflicts) and volatility rising 25%",
    target: "all_weights",
  };

  const currentWeights = {
    RSI: 1.0,
    MACD: 1.0,
    CCI: 1.0,
    Fisher: 1.0,
    ADX: 1.0,
    ATR: 1.0,
    OrderBook: 1.0,
    KalshiPercent: 1.0,
    CrowdFade: 1.0,
  };

  const currentGates = {
    BTC: { minAbsScore: 0.45 },
    ETH: { minAbsScore: 0.50 },
  };

  console.log("\nBefore anomaly:");
  console.log("  Weights sum:", Object.values(currentWeights).reduce((a, b) => a + b, 0));

  const response = AnomalyResponseHandler.handle(anomaly, currentWeights, currentGates);

  console.log("\nAfter anomaly response:");
  console.log("  Actions:", JSON.stringify(response.actions, null, 2).split("\n").join("\n  "));
  console.log("  Recovery mode:", response.inRecovery);
  console.log("  Recovery cycles remaining:", response.recoveryTimeRemaining);
  console.log("  Adjusted weights sum:", Object.values(response.weightsAfter).reduce((a, b) => a + b, 0).toFixed(4));
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 3: Low Severity - Monitor Only
// ══════════════════════════════════════════════════════════════

function scenario3_monitoring() {
  console.log("\n" + "═".repeat(70));
  console.log("SCENARIO 3: Minor Alert (LOW SEVERITY)");
  console.log("═".repeat(70));

  const anomaly = {
    anomaly: true,
    severity: "low",
    reason: "ATR expanded 15%, watch for breakout",
    target: "ATR",
  };

  const currentWeights = {
    RSI: 1.0,
    MACD: 1.0,
    CCI: 1.0,
    Fisher: 1.0,
    ADX: 1.0,
    ATR: 1.0,
    OrderBook: 1.0,
    KalshiPercent: 1.0,
    CrowdFade: 1.0,
  };

  const currentGates = {
    BTC: { minAbsScore: 0.45 },
  };

  console.log("\nBefore anomaly:");
  console.log("  Weights unchanged");

  const response = AnomalyResponseHandler.handle(anomaly, currentWeights, currentGates);

  console.log("\nAfter anomaly response:");
  console.log("  Actions:", JSON.stringify(response.actions, null, 2).split("\n").join("\n  "));
  console.log("  Recovery mode:", response.inRecovery);
  console.log("  Weights adjusted:", response.adjusted);
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 4: Recovery Tick-Down
// ══════════════════════════════════════════════════════════════

function scenario4_recoveryTickdown() {
  console.log("\n" + "═".repeat(70));
  console.log("SCENARIO 4: Recovery Tick-Down (3 cycles)");
  console.log("═".repeat(70));

  // Trigger high severity
  const anomaly = {
    anomaly: true,
    severity: "high",
    reason: "Emergency: accuracy < 40%",
  };

  const weights = {
    RSI: 1.0,
    MACD: 1.0,
    CCI: 1.0,
    Fisher: 1.0,
    ADX: 1.0,
    ATR: 1.0,
    OrderBook: 1.0,
    KalshiPercent: 1.0,
    CrowdFade: 1.0,
  };

  console.log("\nCycle 0: Anomaly detected");
  const response1 = AnomalyResponseHandler.handle(anomaly, weights, {});
  console.log(`  In recovery: ${response1.inRecovery}, Time remaining: ${response1.recoveryTimeRemaining}`);

  console.log("\nCycle 1: Tick recovery");
  AnomalyResponseHandler.tickRecovery();
  console.log(`  In recovery: ${AnomalyResponseHandler.getStatus().inRecovery}, Time remaining: ${AnomalyResponseHandler.getStatus().recoveryTimeRemaining}`);

  console.log("\nCycle 2: Tick recovery");
  AnomalyResponseHandler.tickRecovery();
  console.log(`  In recovery: ${AnomalyResponseHandler.getStatus().inRecovery}, Time remaining: ${AnomalyResponseHandler.getStatus().recoveryTimeRemaining}`);

  console.log("\nCycle 3: Tick recovery");
  AnomalyResponseHandler.tickRecovery();
  console.log(`  In recovery: ${AnomalyResponseHandler.getStatus().inRecovery}, Time remaining: ${AnomalyResponseHandler.getStatus().recoveryTimeRemaining}`);

  console.log("\nRecovery complete! Engine resuming normal operation.");
  console.log(`Total anomalies handled: ${AnomalyResponseHandler.getStatus().totalAnomaliesHandled}`);
}

// ══════════════════════════════════════════════════════════════
// RUN ALL SCENARIOS
// ══════════════════════════════════════════════════════════════

if (require.main === module) {
  console.log("\n" + "╔" + "═".repeat(68) + "╗");
  console.log("║" + " ANOMALY RESPONSE HANDLER — SCENARIO DEMONSTRATIONS".padEnd(69) + "║");
  console.log("╚" + "═".repeat(68) + "╝");

  scenario1_accuracyCollapse();
  scenario2_highConflicts();

  // Reset for scenario 3
  AnomalyResponseHandler.reset();
  scenario3_monitoring();

  // Reset for scenario 4
  AnomalyResponseHandler.reset();
  scenario4_recoveryTickdown();

  console.log("\n" + "═".repeat(70));
  console.log("ALL SCENARIOS COMPLETE");
  console.log("═".repeat(70) + "\n");
}

module.exports = {
  scenario1_accuracyCollapse,
  scenario2_highConflicts,
  scenario3_monitoring,
  scenario4_recoveryTickdown,
};
