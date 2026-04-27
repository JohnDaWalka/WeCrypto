#!/usr/bin/env node
// ================================================================
// WECRYPTO — Prediction Engine Accuracy & Debug Runner
// Fetches real Binance historical 5m candles, runs the EXACT
// indicator logic from predictions.js, and validates each signal
// against actual outcomes. No mocks, no approximations.
//
// Usage:  node backtest-runner.js
//         node backtest-runner.js --coin BTC
//         node backtest-runner.js --days 14
// ================================================================
'use strict';

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ── CLI args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const FILTER_COIN  = getArg('--coin')?.toUpperCase() || null;
const DAYS_BACK    = parseInt(getArg('--days') || '7', 10);
const CANDLES_WANT = Math.min(1000, DAYS_BACK * 288);  // 288 × 5m = 1 day

// ── Coins (matches PREDICTION_COINS in data.js) ─────────────────
const PREDICTION_COINS = [
  { sym: 'BTC',  binSym: 'BTCUSDT',  geckoId: 'bitcoin',     color: '🟠' },
  { sym: 'ETH',  binSym: 'ETHUSDT',  geckoId: 'ethereum',    color: '🔵' },
  { sym: 'SOL',  binSym: 'SOLUSDT',  geckoId: 'solana',      color: '🟣' },
  { sym: 'XRP',  binSym: 'XRPUSDT',  geckoId: 'ripple',      color: '🔷' },
  { sym: 'HYPE', binSym: 'HYPEUSDT', geckoId: 'hyperliquid', color: '🟢' },
  { sym: 'DOGE', binSym: 'DOGEUSDT', geckoId: 'dogecoin',    color: '🟡' },
  { sym: 'BNB',  binSym: 'BNBUSDT',  geckoId: 'binancecoin', color: '💛' },
];

// ── RESCALED -3 TO +3 CONCEPTUAL (CONVERTED TO 0-1 WORKING DECIMALS) ───
const SHORT_HORIZON_MINUTES = [1, 5, 10, 15];
const SHORT_HORIZON_FILTERS = {
  h1:  { entryThreshold: 0.42, minAgreement: 0.55 },  // -0.5 → 0.42, +0.5 → 0.55
  h5:  { entryThreshold: 0.50, minAgreement: 0.65 },  // 0.0 → 0.50, +1.0 → 0.65
  h10: { entryThreshold: 0.58, minAgreement: 0.75 },  // +0.5 → 0.58, +1.5 → 0.75
  h15: { entryThreshold: 0.66, minAgreement: 0.85 },  // +1.0 → 0.66, +2.0 → 0.85
};
const DEFAULT_FILTERS = {
  h1:  { entryThreshold: 0.42, minAgreement: 0.55 },
  h5:  { entryThreshold: 0.50, minAgreement: 0.65 },
  h10: { entryThreshold: 0.58, minAgreement: 0.75 },
  h15: { entryThreshold: 0.66, minAgreement: 0.85 },
};
const BACKTEST_FILTER_OVERRIDES = {
  BTC:  { h1: { entryThreshold: 0.54, minAgreement: 0.65 }, h5: { entryThreshold: 0.62, minAgreement: 0.75 }, h10: { entryThreshold: 0.70, minAgreement: 0.83 }, h15: { entryThreshold: 0.78, minAgreement: 0.92 } },
  ETH:  { h1: { entryThreshold: 0.54, minAgreement: 0.65 }, h5: { entryThreshold: 0.62, minAgreement: 0.75 }, h10: { entryThreshold: 0.70, minAgreement: 0.83 }, h15: { entryThreshold: 0.78, minAgreement: 0.92 } },
  SOL:  { h1: { entryThreshold: 0.50, minAgreement: 0.58 }, h5: { entryThreshold: 0.58, minAgreement: 0.68 }, h10: { entryThreshold: 0.66, minAgreement: 0.78 }, h15: { entryThreshold: 0.74, minAgreement: 0.88 } },
  XRP:  { h1: { entryThreshold: 0.36, minAgreement: 0.42 }, h5: { entryThreshold: 0.42, minAgreement: 0.50 }, h10: { entryThreshold: 0.50, minAgreement: 0.58 }, h15: { entryThreshold: 0.58, minAgreement: 0.66 } },
  DOGE: { h1: { entryThreshold: 0.66, minAgreement: 0.75 }, h5: { entryThreshold: 0.74, minAgreement: 0.85 }, h10: { entryThreshold: 0.82, minAgreement: 0.92 }, h15: { entryThreshold: 0.90, minAgreement: 1.00 } },
  BNB:  { h1: { entryThreshold: 0.46, minAgreement: 0.58 }, h5: { entryThreshold: 0.54, minAgreement: 0.68 }, h10: { entryThreshold: 0.62, minAgreement: 0.78 }, h15: { entryThreshold: 0.70, minAgreement: 0.88 } },
  HYPE: { h1: { entryThreshold: 0.50, minAgreement: 0.58 }, h5: { entryThreshold: 0.58, minAgreement: 0.68 }, h10: { entryThreshold: 0.66, minAgreement: 0.78 }, h15: { entryThreshold: 0.74, minAgreement: 0.88 } },
};
const COMPOSITE_WEIGHTS = {
  ema: 3.0, structure: 2.73, momentum: 1.91, persistence: 1.36, macd: 1.09,
  obv: 0.82, volume: 0.27, vwap: -0.82, adx: -1.36,
  rsi: -1.91, bands: -1.91, williamsR: -1.91, stochrsi: -2.45, mfi: -2.45, ichimoku: -3.0,
};
const SCORE_AMPLIFIER = 1.8;
const BACKTEST_MIN_TRAIN_OBS = 36;

// ── Utility ─────────────────────────────────────────────────────
const clamp    = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average  = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const median   = arr => { if (!arr.length) return 0; const s = [...arr].sort((a,b) => a-b); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
const horizonKey = h => `h${h}`;

// ── EXACT Indicator Functions (copied verbatim from predictions.js) ─
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function calcVWAP(candles) {
  let cumVol = 0, cumTP = 0;
  return candles.map(c => {
    const tp = (c.h + c.l + c.c) / 3;
    const vol = c.v || 1;
    cumVol += vol; cumTP += tp * vol;
    return cumVol > 0 ? cumTP / cumVol : tp;
  });
}

function calcStdDev(arr, period) {
  if (arr.length < period) return 0;
  const slice = arr.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
}

function calcOBV(candles) {
  const obv = [0];
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].v || 1;
    if (candles[i].c > candles[i - 1].c) obv.push(obv[i - 1] + vol);
    else if (candles[i].c < candles[i - 1].c) obv.push(obv[i - 1] - vol);
    else obv.push(obv[i - 1]);
  }
  return obv;
}

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSig  = signalLine[signalLine.length - 1];
  return { macd: lastMACD, signal: lastSig, histogram: lastMACD - lastSig };
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const needed = rsiPeriod + stochPeriod + Math.max(smoothK, smoothD) + 2;
  if (closes.length < needed) return { k: 50, d: 50 };
  const rsiValues = [];
  for (let i = rsiPeriod; i < closes.length; i++) rsiValues.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const hi = Math.max(...slice), lo = Math.min(...slice);
    rawK.push(hi !== lo ? ((rsiValues[i] - lo) / (hi - lo)) * 100 : 50);
  }
  if (!rawK.length) return { k: 50, d: 50 };
  const smoothedK = calcEMA(rawK, smoothK);
  const smoothedD = calcEMA(smoothedK, smoothD);
  return { k: smoothedK[smoothedK.length - 1], d: smoothedD[smoothedD.length - 1] };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return { adx: 25, pdi: 25, mdi: 25 };
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    const up = c.h - p.h, down = p.l - c.l;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
  }
  const wilderSmooth = (arr, p) => {
    if (arr.length < p) return [arr.reduce((s, v) => s + v, 0)];
    let s = arr.slice(0, p).reduce((a, v) => a + v, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
    return out;
  };
  const atrS = wilderSmooth(trs, period);
  const pdiS = wilderSmooth(plusDMs, period);
  const mdiS = wilderSmooth(minusDMs, period);
  const dxArr = atrS.map((atr, i) => {
    const pdi = atr > 0 ? (pdiS[i] / atr) * 100 : 0;
    const mdi = atr > 0 ? (mdiS[i] / atr) * 100 : 0;
    const sum = pdi + mdi;
    return sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0;
  });
  const adxArr = wilderSmooth(dxArr, period);
  const li = adxArr.length - 1;
  const lastATR = atrS[li];
  return { adx: adxArr[li], pdi: lastATR > 0 ? (pdiS[li] / lastATR) * 100 : 0, mdi: lastATR > 0 ? (mdiS[li] / lastATR) * 100 : 0 };
}

function calcIchimoku(candles) {
  if (candles.length < 9) return { tenkan: 0, kijun: 0, cloudPos: 'inside' };
  const high = arr => Math.max(...arr.map(c => c.h));
  const low  = arr => Math.min(...arr.map(c => c.l));
  const tenkan = (high(candles.slice(-9)) + low(candles.slice(-9))) / 2;
  const slice26 = candles.length >= 26 ? candles.slice(-26) : candles;
  const kijun = (high(slice26) + low(slice26)) / 2;
  const slice52 = candles.length >= 52 ? candles.slice(-52) : slice26;
  const spanA = (tenkan + kijun) / 2;
  const spanB = (high(slice52) + low(slice52)) / 2;
  const price = candles[candles.length - 1].c;
  const cloudTop = Math.max(spanA, spanB);
  const cloudBot = Math.min(spanA, spanB);
  const cloudPos = price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside';
  return { tenkan, kijun, spanA, spanB, cloudPos };
}

function calcWilliamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period);
  const hh = Math.max(...slice.map(c => c.h));
  const ll = Math.min(...slice.map(c => c.l));
  const close = candles[candles.length - 1].c;
  return hh !== ll ? ((hh - close) / (hh - ll)) * -100 : -50;
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const slice = candles.slice(-period - 1);
  let posFlow = 0, negFlow = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevTP = (slice[i-1].h + slice[i-1].l + slice[i-1].c) / 3;
    const currTP = (slice[i].h   + slice[i].l   + slice[i].c)   / 3;
    const rawFlow = currTP * (slice[i].v || 1);
    if (currTP > prevTP) posFlow += rawFlow;
    else if (currTP < prevTP) negFlow += rawFlow;
  }
  if (negFlow === 0) return posFlow > 0 ? 100 : 50;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++)
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
  return sum / period;
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) { const last = closes[closes.length - 1] || 0; return { position: 0.5 }; }
  const slice  = closes.slice(-period);
  const middle = average(slice);
  const std    = calcStdDev(closes, period);
  const upper  = middle + std * 2, lower = middle - std * 2;
  const width  = Math.max(upper - lower, middle * 0.0001);
  return { position: clamp((slice[slice.length - 1] - lower) / width, 0, 1), widthPct: middle > 0 ? (width / middle) * 100 : 0 };
}

function calcTrendPersistence(closes, emaSeries, lookback = 8) {
  const span = Math.min(lookback, closes.length, emaSeries.length);
  const recentCloses = closes.slice(-span), recentEma = emaSeries.slice(-span);
  const above = recentCloses.filter((c, i) => c >= recentEma[i]).length;
  const aboveRate = span ? (above / span) * 100 : 50;
  const emaStart = recentEma[0] || recentEma[recentEma.length - 1] || 1;
  const slopePct = emaStart ? ((recentEma[recentEma.length - 1] - emaStart) / emaStart) * 100 : 0;
  return { signal: clamp(((aboveRate - 50) / 30) + slopePct * 4, -1, 1) };
}

function calcStructureBias(candles, atrPct) {
  if (!candles || candles.length < 12) return { signal: 0, zone: 'none' };
  const recent = candles.slice(-24), latest = recent[recent.length - 1].c;
  const support = Math.min(...recent.map(c => c.l));
  const resistance = Math.max(...recent.map(c => c.h));
  const supportGapPct    = latest > 0 ? ((latest - support) / latest) * 100 : 0;
  const resistanceGapPct = latest > 0 ? ((resistance - latest) / latest) * 100 : 0;
  const bufferPct = clamp(Math.max((atrPct || 0) * 1.25, 0.35), 0.35, 2.4);
  let zone = 'middle', signal = 0;
  if (supportGapPct <= bufferPct && supportGapPct <= resistanceGapPct) {
    zone = 'support';
    signal = clamp((bufferPct - supportGapPct) / bufferPct, 0, 1) * 0.85;
  } else if (resistanceGapPct <= bufferPct && resistanceGapPct < supportGapPct) {
    zone = 'resistance';
    signal = -clamp((bufferPct - resistanceGapPct) / bufferPct, 0, 1) * 0.85;
  }
  return { signal, zone, supportGapPct, resistanceGapPct };
}

function slopeOBV(arr, n = 5) {
  if (arr.length < n + 1) return 0;
  const r = arr.slice(-n);
  const avg = (Math.abs(r[0]) + Math.abs(r[r.length - 1])) / 2 || 1;
  return ((r[r.length - 1] - r[0]) / avg) * 100;
}

function summarizeAgreement(signalMap) {
  const values = Object.values(signalMap).filter(v => Math.abs(v) >= 0.08);
  if (!values.length) return { agreement: 0.5, conflict: 0 };
  const bulls = values.filter(v => v > 0).length;
  const bears = values.filter(v => v < 0).length;
  const active = bulls + bears;
  const majority = Math.max(bulls, bears), minority = Math.min(bulls, bears);
  return { agreement: active ? majority / active : 0.5, conflict: active ? minority / active : 0, bulls, bears };
}

function scoreBucket(absScore) {
  if (absScore >= 0.4) return 'strong';
  if (absScore >= 0.25) return 'moderate';
  if (absScore >= 0.1) return 'light';
  return 'neutral';
}

function signalFromScore(score) {
  const a = Math.abs(score);
  if (a < 0.20) return 'neutral';             // scaled for 1.6× post-amplification
  return score > 0 ? (a > 0.55 ? 'strong_bull' : 'bullish') : (a > 0.55 ? 'strong_bear' : 'bearish');
}

// ── Main signal model (no book/flow/mktSentiment — historical only) ─
function buildSignalModel(candles) {
  if (!candles || candles.length < 26) return null;
  const closes   = candles.map(c => c.c);
  const lastPrice = closes[closes.length - 1];

  const rsi = calcRSI(closes);
  let rsiSig = 0;
  if (rsi > 70) rsiSig = -0.6 - ((rsi - 70) / 30) * 0.4;
  else if (rsi < 30) rsiSig = 0.6 + ((30 - rsi) / 30) * 0.4;
  else rsiSig = (rsi - 50) / 50 * 0.3;

  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const emaCross = (ema9[ema9.length-1] - ema21[ema21.length-1]) / (ema21[ema21.length-1] || 1) * 100;
  const emaSig = clamp(emaCross * 5, -1, 1);

  const vwap = calcVWAP(candles);
  const vwapLast = vwap[vwap.length - 1];
  // Use rolling 80-candle VWAP for deviation signal (avoids session-level drift)
  const vwapRolling = calcVWAP(candles.slice(-80));
  const vwapRollingLast = vwapRolling[vwapRolling.length - 1];
  const vwapDev  = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
  let vwapSig = 0;
  if (Math.abs(vwapDev) < 0.3) vwapSig = 0;
  else if (vwapDev > 1.5) vwapSig = -0.5;
  else if (vwapDev < -1.5) vwapSig = 0.5;
  else vwapSig = vwapDev > 0 ? 0.3 : -0.3;

  const obv = calcOBV(candles);
  const obvSig = clamp(slopeOBV(obv, 8) / 5, -1, 1);

  const recent = candles.slice(-12);
  let buyV = 0, sellV = 0;
  recent.forEach(c => {
    const range = c.h - c.l || 0.0001, bodyPos = (c.c - c.l) / range, vol = c.v || 1;
    buyV += vol * bodyPos; sellV += vol * (1 - bodyPos);
  });
  const volSig = clamp((buyV / (sellV || 1) - 1) * 0.5, -1, 1);

  const mom = closes.length > 6 ? ((closes[closes.length-1] - closes[closes.length-7]) / (closes[closes.length-7] || 1)) * 100 : 0;
  const momSig = clamp(mom / 2, -1, 1);

  const atr    = calcATR(candles);
  const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
  const bands  = calcBollinger(closes);
  let bandSig  = 0;
  if (bands.position >= 0.88) bandSig = -clamp((bands.position - 0.88) / 0.12, 0, 1);
  else if (bands.position <= 0.12) bandSig = clamp((0.12 - bands.position) / 0.12, 0, 1);
  else bandSig = clamp(-(bands.position - 0.5) * 0.45, -0.22, 0.22);

  const persistence = calcTrendPersistence(closes, ema21);
  const structure   = calcStructureBias(candles, atrPct);

  const macdR = calcMACD(closes);
  const macdHistNorm = lastPrice > 0 ? (macdR.histogram / lastPrice) * 1000 : 0;
  const macdCross = macdR.macd > macdR.signal ? 0.18 : macdR.macd < macdR.signal ? -0.18 : 0;
  const macdSig = clamp(macdHistNorm * 2.5 + macdCross, -1, 1);

  const stochR = calcStochRSI(closes);
  let stochSig = 0;
  if (stochR.k > 80) stochSig = -0.6 - ((stochR.k - 80) / 20) * 0.4;
  else if (stochR.k < 20) stochSig = 0.6 + ((20 - stochR.k) / 20) * 0.4;
  else stochSig = (stochR.k - 50) / 50 * 0.35;
  stochSig = clamp(stochSig + clamp((stochR.k - stochR.d) / 20, -0.18, 0.18), -1, 1);

  const adxR = calcADX(candles);
  const diDiff = (adxR.pdi - adxR.mdi) / Math.max(adxR.pdi + adxR.mdi, 1);
  const adxSig = clamp(diDiff * clamp(adxR.adx / 50, 0, 1) * 1.2, -1, 1);

  const ichi = calcIchimoku(candles);
  let ichiSig = 0;
  if (ichi.cloudPos === 'above') ichiSig = 0.5 + (ichi.tenkan > ichi.kijun ? 0.2 : 0);
  else if (ichi.cloudPos === 'below') ichiSig = -0.5 - (ichi.tenkan < ichi.kijun ? 0.2 : 0);
  else ichiSig = ichi.tenkan > ichi.kijun ? 0.12 : ichi.tenkan < ichi.kijun ? -0.12 : 0;
  ichiSig = clamp(ichiSig, -1, 1);

  const wR = calcWilliamsR(candles);
  let wRSig = 0;
  if (wR > -20) wRSig = -0.6 - ((wR + 20) / 20) * 0.4;
  else if (wR < -80) wRSig = 0.6 + ((-80 - wR) / 20) * 0.4;
  else wRSig = (wR + 50) / 50 * -0.3;
  wRSig = clamp(wRSig, -1, 1);

  const mfi = calcMFI(candles);
  let mfiSig = 0;
  if (mfi > 80) mfiSig = -0.6 - ((mfi - 80) / 20) * 0.4;
  else if (mfi < 20) mfiSig = 0.6 + ((20 - mfi) / 20) * 0.4;
  else mfiSig = (mfi - 50) / 50 * 0.35;
  mfiSig = clamp(mfiSig, -1, 1);

  // Trend Regime Modulation — suppress contrarian oscillator signals in strong trends
  const isBullTrend = emaCross > 0.15 && adxR.pdi > adxR.mdi && adxR.adx > 22;
  const isBearTrend = emaCross < -0.15 && adxR.mdi > adxR.pdi && adxR.adx > 22;
  if (isBullTrend || isBearTrend) {
    const sf = clamp((adxR.adx - 22) / 28, 0, 0.70);
    if (isBullTrend) {
      if (rsiSig   < 0) rsiSig   *= (1 - sf);
      if (stochSig < 0) stochSig *= (1 - sf);
      if (wRSig    < 0) wRSig    *= (1 - sf);
      if (bandSig  < 0) bandSig  *= (1 - sf * 0.6);
      if (mfiSig   < 0) mfiSig   *= (1 - sf * 0.6);
    } else {
      if (rsiSig   > 0) rsiSig   *= (1 - sf);
      if (stochSig > 0) stochSig *= (1 - sf);
      if (wRSig    > 0) wRSig    *= (1 - sf);
      if (bandSig  > 0) bandSig  *= (1 - sf * 0.6);
      if (mfiSig   > 0) mfiSig   *= (1 - sf * 0.6);
    }
  }

  const sv = { rsi: rsiSig, ema: emaSig, vwap: vwapSig, obv: obvSig, volume: volSig,
               momentum: momSig, bands: bandSig, persistence: persistence.signal, structure: structure.signal,
               macd: macdSig, stochrsi: stochSig, adx: adxSig, ichimoku: ichiSig, williamsR: wRSig, mfi: mfiSig };

  const keys = Object.keys(sv);
  const totalWeight = keys.reduce((s, k) => s + (COMPOSITE_WEIGHTS[k] || 0), 0) || 1;
  const rawComposite = keys.reduce((s, k) => s + sv[k] * (COMPOSITE_WEIGHTS[k] || 0), 0) / totalWeight;
  // ADX gate: suppress signal in flat/ranging markets; amplify to realistic confidence range
  const adxGate = adxR.adx < 20 ? Math.max(0.25, adxR.adx / 20) : 1.0;
  const score = clamp(rawComposite * SCORE_AMPLIFIER * adxGate, -1, 1);
  const agr   = summarizeAgreement(sv);

  return {
    score, signal: signalFromScore(score),
    absScore: Math.abs(score),
    agreement: agr.agreement, conflict: agr.conflict,
    coreScore: score,
    structureBias: structure.signal, structureZone: structure.zone,
    persistenceScore: persistence.signal,
    vwapDev, emaCross, rsi, mom, atrPct,
    signalVector: sv,
  };
}

// ── Walk-Forward Backtest ────────────────────────────────────────
function runBacktest(sym, candles) {
  const results = {};
  const BARMIN  = 5;  // 5-minute candles from Binance

  SHORT_HORIZON_MINUTES.forEach(horizonMin => {
    const horizonBars = Math.max(1, Math.round(horizonMin / BARMIN));
    const startIdx    = Math.max(52, BACKTEST_MIN_TRAIN_OBS);  // warm up window
    const LIVE_WINDOW = 300;  // live app fetches ~300 candles — match it exactly
    const filter      = BACKTEST_FILTER_OVERRIDES[sym]?.[horizonKey(horizonMin)] || SHORT_HORIZON_FILTERS[horizonKey(horizonMin)];
    const observations = [], history = [];
    const indAccum     = {};  // per-indicator accuracy tracker

    for (let idx = startIdx; idx < candles.length - horizonBars; idx++) {
      const windowCandles = candles.slice(Math.max(0, idx - LIVE_WINDOW + 1), idx + 1);
      const model = buildSignalModel(windowCandles);
      if (!model) continue;

      const entry = candles[idx].c;
      const exit  = candles[idx + horizonBars].c;
      const returnPct = entry > 0 ? ((exit - entry) / entry) * 100 : 0;

      const _directCore = model.coreScore ?? model.score ?? 0;
      const persistenceVeto = Math.sign(model.persistenceScore || 0) !== 0
        && Math.sign(model.persistenceScore || 0) !== Math.sign(_directCore)
        && Math.abs(model.persistenceScore || 0) >= 0.35
        && Math.abs(_directCore) < (filter.entryThreshold + 0.04);

      const isActive = model.absScore >= filter.entryThreshold && model.agreement >= filter.minAgreement
        && !(model.conflict >= 0.38 && model.agreement < filter.minAgreement + 0.08)
        && !(Math.abs(model.coreScore||0) < filter.entryThreshold * 0.92 && model.conflict >= 0.30)
        && !(model.structureZone === 'resistance' && model.coreScore > 0 && model.agreement < 0.65 && Math.abs(model.structureBias||0) >= 0.18)
        && !(model.structureZone === 'support'    && model.coreScore < 0 && model.agreement < 0.65 && Math.abs(model.structureBias||0) >= 0.18)
        && !persistenceVeto;

      const direction    = isActive ? (model.score > 0 ? 1 : -1) : 0;
      const signedReturn = direction === 0 ? 0 : returnPct * direction;

      const obs = {
        t: candles[idx].t, direction, score: model.score, absScore: model.absScore,
        agreement: model.agreement, conflict: model.conflict,
        signedReturn, returnPct, bucket: direction === 0 ? 'neutral' : scoreBucket(model.absScore),
        correct: direction !== 0 ? signedReturn > 0 : null,
        atrPct: model.atrPct, rsi: model.rsi, emaCross: model.emaCross, mom: model.mom,
      };
      observations.push(obs);
      history.push(obs);

      // Per-indicator accuracy (does each indicator agree with actual outcome?)
      if (direction !== 0 && model.signalVector) {
        const actualDir = returnPct > 0 ? 1 : -1;
        Object.entries(model.signalVector).forEach(([k, v]) => {
          if (!indAccum[k]) indAccum[k] = { agree: 0, total: 0 };
          if (Math.abs(v) >= 0.08) {
            indAccum[k].total++;
            if (Math.sign(v) === actualDir) indAccum[k].agree++;
          }
        });
      }
    }

    const active  = observations.filter(o => o.direction !== 0);
    const wins    = active.filter(o => o.signedReturn > 0).length;
    const losses  = active.filter(o => o.signedReturn < 0).length;
    const totalSR = active.reduce((s, o) => s + o.signedReturn, 0);
    const grossW  = active.filter(o => o.signedReturn > 0).reduce((s, o) => s + o.signedReturn, 0);
    const grossL  = Math.abs(active.filter(o => o.signedReturn < 0).reduce((s, o) => s + o.signedReturn, 0));

    // Equity simulation ($100 start, size = 1/active.length of portfolio per trade)
    let equity = 100;
    let peak   = 100, maxDD = 0;
    active.forEach(o => { equity *= (1 + o.signedReturn / 100); peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak * 100); });

    // Confidence calibration: accuracy per score bucket
    const bucketStats = ['strong', 'moderate', 'light'].reduce((acc, b) => {
      const bt  = active.filter(o => o.bucket === b);
      acc[b] = { count: bt.length, winRate: bt.length ? bt.filter(o => o.signedReturn > 0).length / bt.length * 100 : null };
      return acc;
    }, {});

    // Session accuracy
    const sessionStats = {};
    active.forEach(o => {
      const utcH = new Date(o.t).getUTCHours();
      let sess = utcH >= 13 && utcH < 18 ? 'NY Open' : utcH >= 7 && utcH < 12 ? 'London' : utcH >= 0 && utcH < 6 ? 'Asia' : 'Off-Hours';
      if (!sessionStats[sess]) sessionStats[sess] = { wins: 0, total: 0 };
      sessionStats[sess].total++;
      if (o.signedReturn > 0) sessionStats[sess].wins++;
    });

    // Indicator accuracy vs actual outcomes
    const indicatorAccuracy = Object.entries(indAccum)
      .map(([k, v]) => ({ indicator: k, accuracy: v.total ? v.agree / v.total * 100 : null, samples: v.total }))
      .filter(x => x.samples >= 5)
      .sort((a, b) => (b.accuracy || 0) - (a.accuracy || 0));

    results[horizonKey(horizonMin)] = {
      horizonMin, horizonBars, filter,
      observations: observations.length, activeSignals: active.length,
      coverage: observations.length ? (active.length / observations.length * 100) : 0,
      winRate:  active.length ? wins / active.length * 100 : 0,
      wins, losses, scratches: active.length - wins - losses,
      avgSignedReturn: active.length ? totalSR / active.length : 0,
      profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? grossW : 0,
      equity: { final: equity, returnPct: equity - 100, maxDrawdownPct: maxDD },
      buckets: bucketStats,
      sessions: Object.entries(sessionStats).map(([s, v]) => ({ session: s, total: v.total, winRate: v.total ? v.wins/v.total*100 : 0 })),
      indicatorAccuracy,
    };
  });

  return results;
}

// ── HTTP helper ──────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : require('http');
    lib.get(url, { headers: { 'User-Agent': 'WECRYPTO-Backtest/1.2' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGet(res.headers.location)); return;
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// ── Data Sources (fallback chain: Binance US → Kraken → Coinbase) ─
const KRAKEN_PAIR = { BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD', DOGE: 'XDGUSD', BNB: 'BNBUSD', HYPE: 'HYPEUSD' };
const CB_PRODUCT  = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD' };

async function fetchKrakenCandles(sym, limit = 1000) {
  const pair = KRAKEN_PAIR[sym]; if (!pair) throw new Error(`No Kraken pair for ${sym}`);
  // Kraken max is 720 candles per call for 5m
  const since = Math.floor((Date.now() - (limit * 5 * 60 * 1000)) / 1000);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=5&since=${since}`;
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`Kraken HTTP ${status}`);
  const json = JSON.parse(body);
  if (json.error && json.error.length) throw new Error(`Kraken error: ${json.error[0]}`);
  const key = Object.keys(json.result).find(k => k !== 'last');
  const rows = json.result[key];
  if (!Array.isArray(rows) || !rows.length) throw new Error(`No Kraken data for ${sym}`);
  // Kraken OHLC: [time, open, high, low, close, vwap, volume, count]
  return rows.map(r => ({
    t: Number(r[0]) * 1000,
    o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[6]),
  }));
}

async function fetchCoinbaseCandles(sym, limit = 300) {
  const product = CB_PRODUCT[sym]; if (!product) throw new Error(`No Coinbase product for ${sym}`);
  // Coinbase Advanced Trade API — 300 candle max per call
  const end   = Math.floor(Date.now() / 1000);
  const start = end - limit * 5 * 60;
  const url   = `https://api.coinbase.com/api/v3/brokerage/market/products/${product}/candles?start=${start}&end=${end}&granularity=FIVE_MINUTE&limit=${limit}`;
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`Coinbase HTTP ${status}`);
  const json = JSON.parse(body);
  const rows = json.candles;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`No Coinbase data for ${sym}`);
  // Coinbase format: {start, low, high, open, close, volume}  — newest first
  return rows.reverse().map(r => ({
    t: Number(r.start) * 1000,
    o: parseFloat(r.open), h: parseFloat(r.high), l: parseFloat(r.low), c: parseFloat(r.close), v: parseFloat(r.volume),
  }));
}

async function fetchBinanceUSCandles(symbol, limit = 1000) {
  const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`;
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`Binance.US HTTP ${status}`);
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error(`Bad response: ${body.slice(0,100)}`);
  return rows.map(r => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
}

async function fetchCandles(coin, limit) {
  // Try Binance.US first, then Kraken, then Coinbase
  const errors = [];
  try { return await fetchBinanceUSCandles(coin.binSym, limit); } catch(e) { errors.push(`BinanceUS: ${e.message}`); }
  try { return await fetchKrakenCandles(coin.sym, limit); } catch(e) { errors.push(`Kraken: ${e.message}`); }
  try { return await fetchCoinbaseCandles(coin.sym, Math.min(300, limit)); } catch(e) { errors.push(`Coinbase: ${e.message}`); }
  throw new Error(errors.join(' | '));
}

// ── Report Printer ───────────────────────────────────────────────
function bar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}

function printReport(sym, backtestResults, candleCount) {
  const divider = '─'.repeat(72);
  console.log(`\n${divider}`);
  console.log(` ${sym}  (${candleCount} candles · ${(candleCount*5/60/24).toFixed(1)} days)`);
  console.log(divider);

  SHORT_HORIZON_MINUTES.forEach(h => {
    const r = backtestResults[horizonKey(h)];
    if (!r || r.activeSignals < 5) { console.log(` h${h}m  insufficient data`); return; }

    const wr   = r.winRate.toFixed(1);
    const wrN  = parseFloat(wr);
    const wrColor = wrN >= 58 ? '✅' : wrN >= 50 ? '🟡' : '❌';
    const eq   = r.equity.returnPct >= 0 ? `+${r.equity.returnPct.toFixed(1)}` : r.equity.returnPct.toFixed(1);
    console.log(`\n ┌ h${h}m ${wrColor} WinRate: ${wr}% │ Signals: ${r.activeSignals}/${r.observations} (${r.coverage.toFixed(0)}%) │ Equity: ${eq}% │ MaxDD: ${r.equity.maxDrawdownPct.toFixed(1)}% │ PF: ${r.profitFactor.toFixed(2)}`);
    console.log(` │ ${bar(r.winRate)} AvgEdge: ${r.avgSignedReturn.toFixed(3)}%  Wins:${r.wins} Losses:${r.losses}`);

    // Bucket breakdown
    const buckets = Object.entries(r.buckets).filter(([,v]) => v.count > 0);
    if (buckets.length) {
      const bStr = buckets.map(([b, v]) => `${b}: ${v.count} @ ${v.winRate?.toFixed(0) ?? '—'}%`).join(' │ ');
      console.log(` │ Signal Buckets: ${bStr}`);
    }

    // Session breakdown
    if (r.sessions.length) {
      const sStr = r.sessions.sort((a,b) => b.total - a.total).map(s => `${s.session}: ${s.winRate.toFixed(0)}%/${s.total}`).join(' │ ');
      console.log(` │ Sessions: ${sStr}`);
    }

    // Top/Bottom indicators
    if (r.indicatorAccuracy.length) {
      const top3 = r.indicatorAccuracy.slice(0, 3).map(x => `${x.indicator}: ${x.accuracy.toFixed(0)}%(${x.samples})`).join(', ');
      const bot3 = [...r.indicatorAccuracy].reverse().slice(0, 3).map(x => `${x.indicator}: ${x.accuracy.toFixed(0)}%(${x.samples})`).join(', ');
      console.log(` │ Best  indicators: ${top3}`);
      console.log(` └ Worst indicators: ${bot3}`);
    } else {
      console.log(` └ No indicator data`);
    }
  });
}

// ── Anomaly / Debug Checks ───────────────────────────────────────
function runDebugChecks(sym, candles, backtestResults) {
  const issues = [];

  // 1. Signal clustering — too many consecutive same-direction signals (potential look-ahead)
  const h15 = backtestResults.h15;
  if (h15 && h15.activeSignals > 10) {
    const winRates = [backtestResults.h1?.winRate, backtestResults.h5?.winRate, backtestResults.h10?.winRate, h15.winRate].filter(Number.isFinite);
    const allAbove55 = winRates.every(w => w > 55);
    if (allAbove55) issues.push(`⚠️  ALL horizons > 55% — verify no look-ahead bias in data or indicator math`);
  }

  // 2. Coverage too low — filters too strict
  SHORT_HORIZON_MINUTES.forEach(h => {
    const r = backtestResults[horizonKey(h)];
    if (r && r.observations > 20 && r.coverage < 10) issues.push(`⚠️  h${h}m coverage=${r.coverage.toFixed(1)}% — filters may be too strict, signal is rare`);
  });

  // 3. Profit factor vs win rate mismatch
  SHORT_HORIZON_MINUTES.forEach(h => {
    const r = backtestResults[horizonKey(h)];
    if (r && r.activeSignals >= 10 && r.winRate > 55 && r.profitFactor < 1) issues.push(`⚠️  h${h}m winRate=${r.winRate.toFixed(1)}% but PF=${r.profitFactor.toFixed(2)} — wins too small vs losses`);
  });

  // 4. ATR spike detection in raw candles
  const atrs = candles.map((_,i) => i < 14 ? 0 : calcATR(candles.slice(i-14, i+1)));
  const avgAtr = average(atrs.filter(a => a > 0));
  const spikes = atrs.filter(a => a > avgAtr * 3).length;
  if (spikes > 5) issues.push(`⚠️  ${spikes} ATR spikes (>3× avg) — may distort signal quality during high-vol events`);

  // 5. Indicator consensus at neutral
  let neutralCount = 0;
  candles.slice(-50).forEach((_, i) => {
    if (i < 26) return;
    const m = buildSignalModel(candles.slice(0, candles.length - 50 + i + 1));
    if (m && m.absScore < 0.05) neutralCount++;
  });
  if (neutralCount > 25) issues.push(`⚠️  Model outputs near-zero score on ${neutralCount}/50 recent candles — signals may be cancelling out`);

  if (issues.length === 0) issues.push('✅  No anomalies detected');
  return issues;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const coins = FILTER_COIN ? PREDICTION_COINS.filter(c => c.sym === FILTER_COIN) : PREDICTION_COINS;
  if (FILTER_COIN && coins.length === 0) { console.error(`Unknown coin: ${FILTER_COIN}`); process.exit(1); }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  WECRYPTO-1.2 — Prediction Engine Accuracy & Debug Report           ║');
  console.log(`║  Fetching ${CANDLES_WANT} × 5m candles per coin (≈${DAYS_BACK} days) from Binance          ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const allResults = {};

  for (const coin of coins) {
    process.stdout.write(`\n  Fetching ${coin.sym}... `);
    let candles;
    try {
      candles = await fetchCandles(coin, CANDLES_WANT);
      console.log(`${candles.length} candles ✓`);
    } catch(e) {
      console.log(`FAILED (${e.message})`);
      continue;
    }

    if (candles.length < 60) { console.log(`  Skipping ${coin.sym} — not enough data`); continue; }

    process.stdout.write(`  Backtesting ${coin.sym}...`);
    const results = runBacktest(coin.sym, candles);
    const issues  = runDebugChecks(coin.sym, candles, results);
    allResults[coin.sym] = { results, candleCount: candles.length, issues };

    printReport(coin.sym, results, candles.length);
    if (issues.length > 0) {
      console.log('\n  Debug checks:');
      issues.forEach(i => console.log(`    ${i}`));
    }

    // Small delay to avoid hammering Binance
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Cross-coin summary table ─────────────────────────────────
  console.log('\n\n' + '═'.repeat(72));
  console.log(' SUMMARY — Win Rates by Coin & Horizon');
  console.log('═'.repeat(72));
  const header = '  Coin   │  h1m   │  h5m   │  h10m  │  h15m  │ Best Horizon';
  console.log(header);
  console.log('─'.repeat(72));

  const globalStats = { total: 0, correct: 0 };
  Object.entries(allResults).forEach(([sym, { results }]) => {
    const vals = SHORT_HORIZON_MINUTES.map(h => results[horizonKey(h)]?.winRate);
    const bestH = SHORT_HORIZON_MINUTES.reduce((b, h) => {
      const v = results[horizonKey(h)]?.winRate ?? 0;
      return v > (results[horizonKey(b)]?.winRate ?? 0) ? h : b;
    }, 1);
    const fmt = (v) => v != null ? `${v.toFixed(1)}%`.padStart(6) : '   —  ';
    console.log(`  ${sym.padEnd(5)}  │ ${fmt(vals[0])} │ ${fmt(vals[1])} │ ${fmt(vals[2])} │ ${fmt(vals[3])} │ h${bestH}m`);

    SHORT_HORIZON_MINUTES.forEach(h => {
      const r = results[horizonKey(h)];
      if (r && r.activeSignals >= 5) { globalStats.total += r.activeSignals; globalStats.correct += r.wins; }
    });
  });

  console.log('─'.repeat(72));
  const overall = globalStats.total > 0 ? (globalStats.correct / globalStats.total * 100).toFixed(1) : '—';
  console.log(`  Overall accuracy across all coins & horizons: ${overall}% (${globalStats.correct}/${globalStats.total} active signals)`);

  // ── Save JSON report ─────────────────────────────────────────
  const outPath = path.join(__dirname, 'backtest-report.json');
  try {
    fs.writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      daysBack: DAYS_BACK, candlesPerCoin: CANDLES_WANT,
      coins: allResults,
    }, null, 2));
    console.log(`\n  Full report saved to: ${outPath}`);
  } catch(e) {
    console.warn(`  Could not save JSON: ${e.message}`);
  }

  console.log('\n');
}

main().catch(e => { console.error('\nFatal error:', e); process.exit(1); });
