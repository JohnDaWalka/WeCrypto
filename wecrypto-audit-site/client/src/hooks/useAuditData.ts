import { useState, useCallback } from 'react';

export interface PredEntry {
  sym: string;
  ts: number;
  bucketT: number;
  predDir: 'UP' | 'DOWN' | 'FLAT';
  actual: 'UP' | 'DOWN' | 'FLAT';
  correct: boolean;
  pctMove: number;
  signal?: unknown;
  isDemo?: boolean;
}

export interface KalshiEntry {
  sym: string;
  ts: number;
  ref: number;
  outcome: 'YES' | 'NO';
  kYesPct: number;
  mYesPct: number;
  modelDir: string;
  closePrice: number;
  marketCorrect: boolean;
  modelCorrect: boolean | null;
  isDemo?: boolean;
}

export interface AuditData {
  predLog: PredEntry[];
  kalshiLog: KalshiEntry[];
  hasRealData: boolean;
}

// Seeded pseudo-random number generator for reproducible demo data
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function normalRandom(rng: () => number, mean: number, std: number): number {
  // Box-Muller transform
  const u1 = Math.max(rng(), 1e-10);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

function generateDemoData(): AuditData {
  const rng = seededRandom(42);

  const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'];
  const coinAccuracy: Record<string, number> = {
    BTC: 0.72, ETH: 0.68, SOL: 0.64, XRP: 0.65, HYPE: 0.61, DOGE: 0.63, BNB: 0.66,
  };

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const intervalMs = 15 * 60 * 1000; // 15 minutes
  const totalBuckets = Math.floor((now - sevenDaysAgo) / intervalMs);

  const predLog: PredEntry[] = [];

  // Generate 120 pred entries spread across 7 days
  const targetEntries = 120;
  // Distribution: ~70 UP, ~40 DOWN, ~10 FLAT
  const dirDistribution: Array<'UP' | 'DOWN' | 'FLAT'> = [
    ...Array(70).fill('UP'),
    ...Array(40).fill('DOWN'),
    ...Array(10).fill('FLAT'),
  ];

  for (let i = 0; i < targetEntries; i++) {
    const coin = coins[Math.floor(rng() * coins.length)];
    const bucketIndex = Math.floor(rng() * totalBuckets);
    const bucketT = sevenDaysAgo + bucketIndex * intervalMs;
    const ts = bucketT + Math.floor(rng() * intervalMs);

    const dirIndex = Math.floor(rng() * dirDistribution.length);
    const predDir = dirDistribution[dirIndex];
    const pctMove = normalRandom(rng, 0, 0.25);

    let actual: 'UP' | 'DOWN' | 'FLAT';
    let correct: boolean;

    if (predDir === 'FLAT') {
      // FLAT predictions: actual is whatever the market did
      actual = rng() > 0.6 ? 'UP' : rng() > 0.5 ? 'DOWN' : 'FLAT';
      correct = actual === 'FLAT';
    } else {
      const accuracy = coinAccuracy[coin] ?? 0.65;
      correct = rng() < accuracy;
      if (correct) {
        actual = predDir;
      } else {
        actual = predDir === 'UP' ? 'DOWN' : 'UP';
      }
    }

    predLog.push({
      sym: coin,
      ts,
      bucketT,
      predDir,
      actual,
      correct,
      pctMove: Math.round(pctMove * 10000) / 10000,
      isDemo: true,
    });
  }

  // Sort by ts ascending
  predLog.sort((a, b) => a.ts - b.ts);

  // Generate 80 kalshi entries
  const kalshiLog: KalshiEntry[] = [];
  for (let i = 0; i < 80; i++) {
    const coin = coins[Math.floor(rng() * coins.length)];
    const bucketIndex = Math.floor(rng() * totalBuckets);
    const bucketT = sevenDaysAgo + bucketIndex * intervalMs;
    const ts = bucketT + Math.floor(rng() * intervalMs);

    const closePrice = 100 + rng() * 900; // simplified
    const ref = closePrice * (1 + (rng() - 0.5) * 0.01);
    const outcome: 'YES' | 'NO' = closePrice >= ref ? 'YES' : 'NO';

    const kYesPct = Math.round((40 + rng() * 20) * 10) / 10; // Kalshi: 40-60%
    const mYesPct = Math.round((45 + rng() * 40) * 10) / 10; // Model: more spread

    const marketCorrect = (kYesPct >= 50) === (outcome === 'YES');
    const modelCorrectRaw = rng() < 0.68; // model correct 68% of the time
    const modelCorrect: boolean | null = modelCorrectRaw;

    kalshiLog.push({
      sym: coin,
      ts,
      ref: Math.round(ref * 100) / 100,
      outcome,
      kYesPct,
      mYesPct,
      modelDir: mYesPct >= 50 ? 'UP' : 'DOWN',
      closePrice: Math.round(closePrice * 100) / 100,
      marketCorrect,
      modelCorrect,
      isDemo: true,
    });
  }

  kalshiLog.sort((a, b) => a.ts - b.ts);

  return { predLog, kalshiLog, hasRealData: false };
}

const STORAGE_KEY = 'audit_import';

function loadFromStorage(): AuditData | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuditData;
    if (!parsed.predLog || !Array.isArray(parsed.predLog)) return null;
    return { ...parsed, hasRealData: true };
  } catch {
    return null;
  }
}

export function useAuditData() {
  const [data, setData] = useState<AuditData>(() => {
    const stored = loadFromStorage();
    return stored ?? generateDemoData();
  });

  const importData = useCallback((json: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('Invalid JSON — could not parse input');
    }

    let predLog: PredEntry[] = [];
    let kalshiLog: KalshiEntry[] = [];

    if (Array.isArray(parsed)) {
      // Array of PredEntry
      predLog = parsed as PredEntry[];
      kalshiLog = [];
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.predLog)) {
        predLog = obj.predLog as PredEntry[];
      }
      if (Array.isArray(obj.kalshiLog)) {
        kalshiLog = obj.kalshiLog as KalshiEntry[];
      }
    }

    if (predLog.length === 0) {
      throw new Error('No valid predLog entries found in imported data');
    }

    const newData: AuditData = { predLog, kalshiLog, hasRealData: true };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(newData));
    setData(newData);
    return { predCount: predLog.length, kalshiCount: kalshiLog.length };
  }, []);

  const clearData = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setData(generateDemoData());
  }, []);

  return {
    predLog: data.predLog,
    kalshiLog: data.kalshiLog,
    hasRealData: data.hasRealData,
    importData,
    clearData,
  };
}
