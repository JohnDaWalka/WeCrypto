import fs from 'node:fs';
import path from 'node:path';

const reportPath = '/home/ubuntu/upload/backtest-report.json';
const outputPath = '/home/ubuntu/wecrypto-audit-site/client/src/data/reportData.ts';
const BREAK_EVEN_HIT_RATE = 54;

const raw = fs.readFileSync(reportPath, 'utf8');
const report = JSON.parse(raw);

const entries = [];
const bucketAgg = new Map();
const sessionAgg = new Map();

let totalObservations = 0;
let totalActiveSignals = 0;
let weightedWins = 0;
let weightedTrades = 0;
let aboveBreakEven = 0;
let belowBreakEven = 0;

for (const [coin, coinData] of Object.entries(report.coins ?? {})) {
  const results = coinData.results ?? {};
  for (const [horizonKey, result] of Object.entries(results)) {
    const observations = Number(result.observations ?? 0);
    const activeSignals = Number(result.activeSignals ?? 0);
    const wins = Number(result.wins ?? 0);
    const losses = Number(result.losses ?? 0);
    const scratches = Number(result.scratches ?? 0);
    const winRate = Number(result.winRate ?? 0);
    const selectionRatio = observations > 0 ? (activeSignals / observations) * 100 : 0;
    const netEdgeVsBreakEven = winRate - BREAK_EVEN_HIT_RATE;

    totalObservations += observations;
    totalActiveSignals += activeSignals;
    weightedWins += wins;
    weightedTrades += activeSignals;

    if (winRate >= BREAK_EVEN_HIT_RATE) {
      aboveBreakEven += 1;
    } else {
      belowBreakEven += 1;
    }

    const buckets = result.buckets ?? {};
    for (const [bucketName, bucket] of Object.entries(buckets)) {
      const prev = bucketAgg.get(bucketName) ?? { count: 0, weightedWinSum: 0 };
      const count = Number(bucket.count ?? 0);
      const bucketWinRate = Number(bucket.winRate ?? 0);
      bucketAgg.set(bucketName, {
        count: prev.count + count,
        weightedWinSum: prev.weightedWinSum + bucketWinRate * count,
      });
    }

    for (const session of result.sessions ?? []) {
      const name = session.session ?? 'Unknown';
      const prev = sessionAgg.get(name) ?? { total: 0, weightedWinSum: 0 };
      const total = Number(session.total ?? 0);
      const sessionWinRate = Number(session.winRate ?? 0);
      sessionAgg.set(name, {
        total: prev.total + total,
        weightedWinSum: prev.weightedWinSum + sessionWinRate * total,
      });
    }

    entries.push({
      coin,
      horizonKey,
      horizonMin: Number(result.horizonMin ?? 0),
      observations,
      activeSignals,
      selectionRatio,
      winRate,
      wins,
      losses,
      scratches,
      avgSignedReturn: Number(result.avgSignedReturn ?? 0),
      profitFactor: Number(result.profitFactor ?? 0),
      equityReturnPct: Number(result.equity?.returnPct ?? 0),
      maxDrawdownPct: Number(result.equity?.maxDrawdownPct ?? 0),
      entryThreshold: Number(result.filter?.entryThreshold ?? 0),
      minAgreement: Number(result.filter?.minAgreement ?? 0),
      netEdgeVsBreakEven,
    });
  }
}

entries.sort((a, b) => {
  if (b.netEdgeVsBreakEven !== a.netEdgeVsBreakEven) {
    return b.netEdgeVsBreakEven - a.netEdgeVsBreakEven;
  }
  return b.activeSignals - a.activeSignals;
});

const overallSelectionRatio = totalObservations > 0 ? (totalActiveSignals / totalObservations) * 100 : 0;
const overallDirectionalHitRate = weightedTrades > 0 ? (weightedWins / weightedTrades) * 100 : 0;

const confidenceDistribution = Array.from(bucketAgg.entries())
  .map(([name, value]) => ({
    bucket: name,
    count: value.count,
    weightedWinRate: value.count > 0 ? value.weightedWinSum / value.count : 0,
  }))
  .sort((a, b) => b.count - a.count);

const sessionDistribution = Array.from(sessionAgg.entries())
  .map(([name, value]) => ({
    session: name,
    total: value.total,
    weightedWinRate: value.total > 0 ? value.weightedWinSum / value.total : 0,
  }))
  .sort((a, b) => b.total - a.total);

const bestSetups = entries.slice(0, 8);
const mostActiveSetups = [...entries].sort((a, b) => b.activeSignals - a.activeSignals).slice(0, 8);
const weakestSetups = [...entries].sort((a, b) => a.netEdgeVsBreakEven - b.netEdgeVsBreakEven).slice(0, 8);

const siteData = {
  metadata: {
    generatedAt: report.generatedAt,
    daysBack: report.daysBack,
    candlesPerCoin: report.candlesPerCoin,
    breakEvenHitRate: BREAK_EVEN_HIT_RATE,
  },
  summary: {
    totalObservations,
    totalActiveSignals,
    overallSelectionRatio,
    overallDirectionalHitRate,
    aboveBreakEven,
    belowBreakEven,
  },
  bestSetups,
  mostActiveSetups,
  weakestSetups,
  confidenceDistribution,
  sessionDistribution,
  allSetups: entries,
};

const output = `/*
 * Swiss editorial forensic style: expose evidence first, keep analytical hierarchy strict,
 * and emphasize the distinction between directional accuracy and executable contract viability.
 */
export const reportData = ${JSON.stringify(siteData, null, 2)} as const;
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);
console.log(`Wrote site report data to ${outputPath}`);
