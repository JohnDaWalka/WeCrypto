#!/usr/bin/env node

/**
 * LLM Debug CLI — Real-time monitoring and debugging
 * 
 * Commands:
 * - status          Show LLM status + metrics
 * - analyze BTC     Single coin analysis
 * - batch           Multi-coin batch analysis
 * - weights         Show weight adjustment history
 * - anomalies       Show detected anomalies
 * - reset-stats     Reset all statistics
 */

const fs = require("fs");
const path = require("path");

// Import modules
const LLMAssistant = require("../src/llm/llm_signal_assistant");
const WeightApplier = require("../src/llm/weight_applier");
const AnomalyDetector = require("../src/llm/anomaly_detector");
const DashboardMetrics = require("../src/llm/dashboard_metrics");

// Color codes
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function colorize(text, color = colors.reset) {
  return `${color}${text}${colors.reset}`;
}

function log(message, color = colors.reset) {
  console.log(colorize(message, color));
}

function header(title) {
  console.log();
  log("═".repeat(80), colors.cyan);
  log(`  ${title}`, colors.bright + colors.cyan);
  log("═".repeat(80), colors.cyan);
  console.log();
}

function section(title) {
  log(`\n▸ ${title}`, colors.bright + colors.blue);
}

/**
 * Command: status
 * Show LLM system status and current metrics
 */
function commandStatus() {
  header("LLM SYSTEM STATUS");

  // LLM Assistant status
  section("LLM Assistant");
  const diag = LLMAssistant.getDiagnostics();
  log(`  Enabled: ${diag.enabled ? "✓ YES" : "✗ NO"}`, diag.enabled ? colors.green : colors.red);
  log(`  Model: ${diag.model}`);
  log(`  API URL: ${diag.api_url ? "✓ Configured" : "✗ Not configured"}`);

  if (diag.stats) {
    log(`\n  Statistics:`, colors.yellow);
    log(`    Total calls: ${diag.stats.total_calls}`);
    log(`    Successes: ${diag.stats.successes}`);
    log(`    Failures: ${diag.stats.failures}`);
    log(`    Success rate: ${diag.stats.success_rate}`);
    log(`    Influence count: ${diag.stats.influence_count}`);
  }

  // Weight Applier status
  section("Weight Applier");
  log(`  Max step per cycle: 5%`);
  log(`  Weight bounds: [0.5x, 2.0x]`);

  const coins = DashboardMetrics.getActiveCoins();
  if (coins.length > 0) {
    log(`  Active coins: ${coins.join(", ")}`);

    for (const coin of coins) {
      const stats = WeightApplier.getStatistics(coin);
      if (stats.totalAdjustments > 0) {
        log(`    ${coin}: ${stats.totalAdjustments} adjustments, avg change ${stats.avgChangePercent}%`);
      }
    }
  } else {
    log(`  No adjustments recorded yet`);
  }

  // Anomaly Detector status
  section("Anomaly Detector");
  const thresholds = AnomalyDetector.getThresholds();
  log(`  Weight imbalance threshold: ${thresholds.weightImbalance}x`);
  log(`  Accuracy collapse threshold: ${(thresholds.accuracyCollapseFraction * 100).toFixed(0)}%`);
  log(`  High conflict threshold: ${thresholds.highConflictCount}`);

  // Global metrics
  if (coins.length > 0) {
    section("Global Metrics");
    const global = DashboardMetrics.aggregateGlobal(50);

    if (global.global) {
      log(`  Active coins: ${global.global.active_coins}`);
      log(`  Avg LLM influence: ${global.global.avg_llm_influence}%`);
      log(`  Total anomalies: ${global.global.total_anomalies}`);
    }
  }

  log("\n✓ Status check complete", colors.green);
}

/**
 * Command: analyze BTC
 * Perform single coin analysis
 */
async function commandAnalyze(coin) {
  if (!coin) {
    log("✗ Error: coin symbol required (e.g., analyze BTC)", colors.red);
    return;
  }

  header(`SINGLE COIN ANALYSIS: ${coin}`);

  // Create a realistic snapshot
  const snapshot = {
    coin: coin.toUpperCase(),
    volatility: 0.015,
    orderbook: { imbalance: 0.65, buyPressure: 0.65 },
    indicators: {
      RSI: 55,
      MACD: 0.001,
      CCI: 50,
      Fisher: 0.5,
      ADX: 35,
    },
    weights: {
      RSI: 1.0,
      MACD: 1.0,
      CCI: 1.0,
      Fisher: 1.0,
      ADX: 1.0,
    },
    recentAccuracy: { winRate: 0.52, trend: 0.02 },
    conflicts: [],
  };

  try {
    log("Analyzing...", colors.yellow);
    const result = await LLMAssistant.analyzeSnapshot(snapshot);

    section("LLM Output");
    log(`  Regime: ${result.regime}`, colors.bright);
    log(`  Confidence: ${(result.confidence * 100).toFixed(1)}%`);

    if (result.suggestions) {
      section("Suggestions");
      for (const [key, value] of Object.entries(result.suggestions)) {
        if (key !== "notes") {
          log(`  ${key}: ${typeof value === "number" ? value.toFixed(4) : value}`);
        }
      }
    }

    if (result.warnings && result.warnings.length > 0) {
      section("Warnings");
      result.warnings.forEach((w) => {
        log(`  ⚠ ${w}`, colors.yellow);
      });
    }

    log("\n✓ Analysis complete", colors.green);
  } catch (err) {
    log(`✗ Analysis failed: ${err.message}`, colors.red);
  }
}

/**
 * Command: batch
 * Multi-coin batch analysis
 */
async function commandBatch() {
  header("MULTI-COIN BATCH ANALYSIS");

  const coins = ["BTC", "ETH", "SOL", "XRP"];
  const results = [];

  try {
    for (const coin of coins) {
      const snapshot = {
        coin: coin,
        volatility: 0.015,
        indicators: {
          RSI: 55,
          MACD: 0.001,
          CCI: 50,
          Fisher: 0.5,
          ADX: 35,
        },
        weights: {
          RSI: 1.0,
          MACD: 1.0,
          CCI: 1.0,
          Fisher: 1.0,
          ADX: 1.0,
        },
        recentAccuracy: { winRate: 0.52, trend: 0.02 },
        conflicts: [],
      };

      log(`Analyzing ${coin}...`, colors.yellow);
      const result = await LLMAssistant.analyzeSnapshot(snapshot);
      results.push({ coin, ...result });
    }

    section("Results");
    const table = results.map((r) => ({
      Coin: colorize(r.coin, colors.bright),
      Regime: colorize(r.regime, colors.cyan),
      Confidence: colorize(`${(r.confidence * 100).toFixed(0)}%`, r.confidence > 0.7 ? colors.green : colors.yellow),
    }));

    // Print table
    console.table(table.map((row) => {
      return Object.entries(row).reduce((acc, [key, val]) => {
        acc[key] = val.replace(/\x1b\[[0-9;]*m/g, ""); // strip colors for table
        return acc;
      }, {});
    }));

    log("\n✓ Batch analysis complete", colors.green);
  } catch (err) {
    log(`✗ Batch analysis failed: ${err.message}`, colors.red);
  }
}

/**
 * Command: weights
 * Show weight adjustment history
 */
function commandWeights() {
  header("WEIGHT ADJUSTMENT HISTORY");

  const coins = DashboardMetrics.getActiveCoins();

  if (coins.length === 0) {
    log("No adjustment history found", colors.yellow);
    return;
  }

  for (const coin of coins) {
    section(`${coin} Adjustments`);

    const history = WeightApplier.getAdjustmentHistory(coin, 10);

    if (history.length === 0) {
      log("  No adjustments recorded", colors.dim);
      continue;
    }

    history.slice(-5).forEach((adj, idx) => {
      const timestamp = new Date(adj.timestamp).toLocaleString();
      log(`  [${idx + 1}] ${timestamp}`, colors.dim);
      log(`      Reason: ${adj.reason}`);

      if (adj.deltas) {
        for (const [indicator, delta] of Object.entries(adj.deltas)) {
          const changePercent = delta.toFixed(2);
          const color = Math.abs(delta) > 2 ? colors.yellow : colors.green;
          log(`        ${indicator}: ${changePercent}%`, color);
        }
      }
    });
  }

  log("\n✓ Weight history retrieved", colors.green);
}

/**
 * Command: anomalies
 * Show detected anomalies
 */
function commandAnomalies() {
  header("DETECTED ANOMALIES");

  const coins = DashboardMetrics.getActiveCoins();

  if (coins.length === 0) {
    log("No anomaly history found", colors.yellow);
    return;
  }

  for (const coin of coins) {
    section(`${coin} Anomalies`);

    const history = AnomalyDetector.getAnomalyHistory(coin, 10);

    if (history.length === 0) {
      log("  No anomalies detected (✓ healthy)", colors.green);
      continue;
    }

    history.slice(-5).forEach((record, idx) => {
      const timestamp = new Date(record.timestamp).toLocaleString();
      const severityColor =
        record.severity_score >= 70 ? colors.red : record.severity_score >= 40 ? colors.yellow : colors.green;

      log(`  [${idx + 1}] ${timestamp} [Severity: ${record.severity_score}/100]`, severityColor);

      if (record.anomalies) {
        record.anomalies.forEach((a) => {
          const typeColor = a.severity === "high" ? colors.red : a.severity === "medium" ? colors.yellow : colors.green;
          log(`    • ${a.type} (${a.severity})`, typeColor);
          log(`      ${a.message}`);
        });
      }

      if (record.recommendations && record.recommendations.length > 0) {
        log(`    Recommendations:`, colors.cyan);
        record.recommendations.forEach((r) => {
          log(`      - ${r}`, colors.cyan);
        });
      }
    });
  }

  log("\n✓ Anomaly history retrieved", colors.green);
}

/**
 * Command: metrics
 * Show dashboard metrics for all coins
 */
function commandMetrics() {
  header("DASHBOARD METRICS");

  const coins = DashboardMetrics.getActiveCoins();

  if (coins.length === 0) {
    log("No metrics available yet", colors.yellow);
    return;
  }

  for (const coin of coins) {
    section(`${coin} Metrics`);

    const dashboard = DashboardMetrics.exportForDashboard(coin);
    const m = dashboard.metrics;

    log(`  LLM Influence: ${m.llm_influence}`, colors.cyan);
    log(`  Regime: ${m.regime}`, colors.cyan);
    log(`  Acceptance Rate: ${m.suggestion_acceptance}`, colors.cyan);
    log(`  Weight Velocity: ${m.weight_velocity}`, colors.cyan);
    log(`  Anomalies: ${m.anomalies}`, colors.cyan);
    log(`  Accuracy Correlation: ${m.accuracy_correlation}`, colors.cyan);

    // Health status
    const healthColor =
      dashboard.health.score >= 80 ? colors.green : dashboard.health.score >= 50 ? colors.yellow : colors.red;
    log(`  Health: ${dashboard.health.score}/100 [${dashboard.health.status}]`, healthColor);

    if (dashboard.health.warnings.length > 0) {
      log(`  Warnings:`, colors.yellow);
      dashboard.health.warnings.forEach((w) => {
        log(`    ⚠ ${w}`, colors.yellow);
      });
    }
  }

  log("\n✓ Metrics retrieved", colors.green);
}

/**
 * Command: reset-stats
 * Reset all statistics and logs
 */
function commandReset() {
  header("RESET STATISTICS");

  log("This will clear all logs and statistics.", colors.yellow);
  log("Proceed? (type 'yes' to confirm)", colors.yellow);

  // For CLI, we'll just show the warning
  log("\nTo reset, manually delete log files in logs/llm/:", colors.dim);
  log("  - *-adjustments.json", colors.dim);
  log("  - *-anomalies.json", colors.dim);
  log("  - *-analysis.json", colors.dim);

  // Or allow programmatic reset if called with --force
  const args = process.argv.slice(2);
  if (args.includes("--force")) {
    WeightApplier.clearHistory();
    AnomalyDetector.clearHistory();
    DashboardMetrics.reset();
    log("\n✓ All statistics reset", colors.green);
  }
}

/**
 * Command: help
 * Show available commands
 */
function commandHelp() {
  header("LLM DEBUG CLI - AVAILABLE COMMANDS");

  const commands = [
    { cmd: "status", desc: "Show LLM status + metrics" },
    { cmd: "analyze BTC", desc: "Perform single coin analysis" },
    { cmd: "batch", desc: "Multi-coin batch analysis" },
    { cmd: "weights", desc: "Show weight adjustment history" },
    { cmd: "anomalies", desc: "Show detected anomalies" },
    { cmd: "metrics", desc: "Show dashboard metrics" },
    { cmd: "reset-stats [--force]", desc: "Reset all statistics (add --force to confirm)" },
    { cmd: "help", desc: "Show this help message" },
  ];

  log("Usage: node tools/llm-debug.js <command> [arguments]\n", colors.bright);

  commands.forEach((c) => {
    log(`  ${colorize(c.cmd.padEnd(25), colors.cyan)}  ${c.desc}`);
  });

  log("\nExamples:", colors.bright);
  log("  node tools/llm-debug.js status");
  log("  node tools/llm-debug.js analyze BTC");
  log("  node tools/llm-debug.js batch");
  log("  node tools/llm-debug.js weights");
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase() || "help";

  try {
    switch (command) {
      case "status":
        commandStatus();
        break;
      case "analyze":
        await commandAnalyze(args[1]);
        break;
      case "batch":
        await commandBatch();
        break;
      case "weights":
        commandWeights();
        break;
      case "anomalies":
        commandAnomalies();
        break;
      case "metrics":
        commandMetrics();
        break;
      case "reset-stats":
        commandReset();
        break;
      case "help":
      case "--help":
      case "-h":
        commandHelp();
        break;
      default:
        log(`✗ Unknown command: ${command}`, colors.red);
        log("Use 'node tools/llm-debug.js help' for available commands", colors.yellow);
        process.exit(1);
    }
  } catch (err) {
    log(`✗ Error: ${err.message}`, colors.red);
    process.exit(1);
  }
}

// Run
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
