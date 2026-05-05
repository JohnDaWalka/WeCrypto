'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https'); // built-in — no external deps needed

// ─── Paths ────────────────────────────────────────────────────────────────────
const ROOT       = path.resolve(__dirname, '..');
const PREDS_PATH = path.join(ROOT, 'src', 'core', 'predictions.js');
const BT_PATH    = path.join(ROOT, 'backtest', 'backtest-runner.js');
const LOG_DIR    = path.join(ROOT, 'backtest-logs');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const csvFiles = [];
let writeWeights = false;
let testMode     = false;
let coinFilter   = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--csv') {
    while (i + 1 < args.length && !args[i + 1].startsWith('--')) csvFiles.push(args[++i]);
  } else if (args[i] === '--write-weights') {
    writeWeights = true;
  } else if (args[i] === '--test') {
    testMode = true;
  } else if (args[i] === '--coins') {
    coinFilter = args[++i].split(',');
  }
}

// ─── Helper constants (required by calcBollinger / calcStructureBias) ─────────
const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const average = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

// ══════════════════════════════════════════════════════════════════════════════
// INDICATOR FUNCTIONS — copied verbatim from backtest-runner.js
// ══════════════════════════════════════════════════════════════════════════════

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

function calcHMA(data, period) {
  period = period || 16;
  if (data.length < period * 2) return data.slice(-1);
  function wma(arr, n) {
    if (arr.length < n) return [arr[arr.length - 1]];
    const result = [];
    for (let i = n - 1; i < arr.length; i++) {
      let sum = 0, wSum = 0;
      for (let j = 0; j < n; j++) { sum += arr[i - j] * (n - j); wSum += (n - j); }
      result.push(sum / wSum);
    }
    return result;
  }
  const half = Math.floor(period / 2);
  const sqrtP = Math.floor(Math.sqrt(period));
  const wmaHalf = wma(data, half);
  const wmaFull = wma(data, period);
  const minLen = Math.min(wmaHalf.length, wmaFull.length);
  const diff = [];
  for (let i = 0; i < minLen; i++) diff.push(2 * wmaHalf[wmaHalf.length - minLen + i] - wmaFull[wmaFull.length - minLen + i]);
  return wma(diff, sqrtP);
}

function calcVWMA(candles, period) {
  period = period || 20;
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - period + 1), i + 1);
    let pv = 0, v = 0;
    for (const c of slice) { pv += c.c * (c.v || 1); v += (c.v || 1); }
    result.push(v > 0 ? pv / v : candles[i].c);
  }
  return result;
}

function calcSupertrend(candles, period, multiplier) {
  period = period || 10; multiplier = multiplier || 3.0;
  if (candles.length < period + 2) return { signal: 0, bullish: null };
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const atrs = [atr];
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrs.push(atr);
  }
  let finalUpper = 0, finalLower = 0, supertrend = 0, bullish = false;
  let initialized = false;
  for (let i = 0; i < atrs.length; i++) {
    const ci = candles[i + 1];
    const hl2 = (ci.h + ci.l) / 2;
    const rawUpper = hl2 + multiplier * atrs[i];
    const rawLower = hl2 - multiplier * atrs[i];
    const prevClose = candles[i].c;
    if (!initialized) {
      finalUpper = rawUpper; finalLower = rawLower;
      supertrend = rawUpper; bullish = false; initialized = true;
    } else {
      const newUpper = (rawUpper < finalUpper || prevClose > finalUpper) ? rawUpper : finalUpper;
      const newLower = (rawLower > finalLower || prevClose < finalLower) ? rawLower : finalLower;
      const prevST = supertrend;
      if (prevST === finalUpper) {
        bullish = ci.c > newUpper;
        supertrend = bullish ? newLower : newUpper;
      } else {
        bullish = ci.c >= newLower;
        supertrend = bullish ? newLower : newUpper;
      }
      finalUpper = newUpper; finalLower = newLower;
    }
  }
  return { signal: bullish ? 1 : -1, bullish, supertrend };
}

function calcCCI(candles, period) {
  period = period || 14;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const tps = slice.map(c => (c.h + c.l + c.c) / 3);
  const mean = tps.reduce((s, v) => s + v, 0) / period;
  const meanDev = tps.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
  return meanDev > 0 ? (tps[tps.length - 1] - mean) / (0.015 * meanDev) : 0;
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) { return { position: 0.5 }; }
  const slice  = closes.slice(-period);
  const middle = average(slice);
  const std    = calcStdDev(closes, period);
  const upper  = middle + std * 2, lower = middle - std * 2;
  const width  = Math.max(upper - lower, middle * 0.0001);
  return { position: clamp((slice[slice.length - 1] - lower) / width, 0, 1), widthPct: middle > 0 ? (width / middle) * 100 : 0, upper, lower, middle };
}

// ══════════════════════════════════════════════════════════════════════════════
// TICKER PARSING
// Format: KX{COIN}15M-{YY}{MON}{DD}{HHMM}-{STRIKE}
// Example: KXBTC15M-26MAY040115-15  →  year=2026, month=MAY, day=04, time=01:15
// ══════════════════════════════════════════════════════════════════════════════

function parseTicker(ticker) {
  const m = ticker.match(/KX(BTC|ETH|SOL|XRP|HYPE)15M-(\d{2})([A-Z]{3})(\d{2})(\d{4})-(\d+)/);
  if (!m) return null;
  const [, coin, yy, mon, dd, hhmm] = m;
  const months = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
  const year  = 2000 + parseInt(yy, 10);
  const month = months[mon];
  if (month === undefined) return null;
  const day  = parseInt(dd, 10);
  const hour = parseInt(hhmm.slice(0, 2), 10);
  const min  = parseInt(hhmm.slice(2, 4), 10);
  const startMs = Date.UTC(year, month, day, hour, min, 0);
  const endMs   = startMs + 15 * 60 * 1000;
  return { coin, startMs, endMs, ticker };
}

// ══════════════════════════════════════════════════════════════════════════════
// CSV PARSER
// ══════════════════════════════════════════════════════════════════════════════

function parseCSV(filePath) {
  const text  = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const parseRow = (line) => {
    const result = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    result.push(cur.trim());
    return result;
  };

  const headers = parseRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseRow(lines[i]);
    const row = {};
    headers.forEach((h, idx) => row[h.trim()] = vals[idx] || '');
    rows.push(row);
  }
  return rows;
}

function extractWindows(csvRows) {
  const seen = new Map();

  for (const row of csvRows) {
    const status = (row['Status'] || row['status'] || '').trim();
    const type   = (row['type']   || row['Type']   || '').trim();
    const ticker = (row['Market_Ticker'] || row['market_ticker'] || '').trim();
    const mktId  = (row['Market_Id']     || row['market_id']     || ticker).trim();

    if (status !== 'Filled') continue;
    if (type !== 'Order') continue;

    const parsed = parseTicker(ticker);
    if (!parsed) continue;

    if (!seen.has(mktId)) {
      seen.set(mktId, parsed);
    }
  }

  return [...seen.values()];
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP HELPER
// ══════════════════════════════════════════════════════════════════════════════

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════════
// BINANCE FETCHER
// Rate limit: 120ms between requests. On 429, sleep 5s and retry once.
// ══════════════════════════════════════════════════════════════════════════════

const SYMBOL_MAP   = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', HYPE: 'HYPEUSDT' };
const BINANCE_BASE = 'https://api.binance.com/api/v3/klines';

async function fetchKlines(symbol, interval, startMs, endMs, limit) {
  const url = `${BINANCE_BASE}?symbol=${symbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${limit}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await httpsGet(url);
      if (!Array.isArray(data)) {
        // -1003 / -1015 = rate-limited; -1121 = bad symbol
        if (data && (data.code === -1003 || data.code === -1015)) {
          console.warn(`  WARN: Binance rate-limit (code ${data.code}) — sleeping 5s`);
          await sleep(5000);
          continue; // retry
        }
        if (data && data.code === -1121) {
          console.warn(`  WARN: Invalid symbol ${symbol} on Binance — skipping`);
          return null;
        }
        throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return data;
    } catch (e) {
      if (attempt === 0) { await sleep(1000); continue; }
      return null;
    }
  }
  return null;
}

function getActualDirection(klines) {
  if (!klines || klines.length < 2) return null;
  const open  = parseFloat(klines[0][1]);
  const close = parseFloat(klines[klines.length - 1][4]);
  if (open === 0) return null;
  const pctChange = (close - open) / open * 100;
  return { direction: pctChange > 0 ? 'UP' : pctChange < 0 ? 'DOWN' : 'FLAT', pctChange, open, close };
}

// ══════════════════════════════════════════════════════════════════════════════
// SIGNAL VECTOR BUILDER
// Produces a normalised [-1, 1] signal per indicator from 5m candles.
// Adapts return-value field names to match the actual implementations above:
//   calcBollinger → { position, upper, lower, middle }
//   calcADX       → { adx, pdi, mdi }
//   calcSupertrend → { signal, bullish }
// ══════════════════════════════════════════════════════════════════════════════

function buildSignalVector(candles5m) {
  if (!candles5m || candles5m.length < 30) return null;

  const closes  = candles5m.map(c => c.c);
  const volumes = candles5m.map(c => c.v);
  const n = closes.length;

  // ── RSI ──────────────────────────────────────────────────────────────────
  const rsi = calcRSI(closes, 14);
  let rsiSig = 0;
  if      (rsi > 70) rsiSig = clamp(-0.6 - ((rsi - 70) / 30) * 0.4, -1, -0.2);
  else if (rsi < 30) rsiSig = clamp( 0.6 + ((30 - rsi) / 30) * 0.4,  0.2,  1);
  else               rsiSig = (rsi - 50) / 50 * 0.3;

  // ── MACD ─────────────────────────────────────────────────────────────────
  const macdResult = calcMACD(closes);
  const macdSig = macdResult
    ? clamp(macdResult.histogram / (Math.abs(macdResult.macd) || 0.001), -1, 1) * 0.5
    : 0;

  // ── EMA crossover ────────────────────────────────────────────────────────
  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const e9val  = ema9[ema9.length - 1];
  const e21val = ema21[ema21.length - 1];
  const emaSig = e9val > e21val
    ? clamp((e9val - e21val) / e21val * 100 * 5,  0,  1)
    : clamp((e9val - e21val) / e21val * 100 * 5, -1,  0);

  // ── Bollinger Bands  (bb.position is already (close-lower)/width in [0,1]) ─
  const bb = calcBollinger(closes, 20);
  let bandSig = 0;
  if (bb && bb.position !== undefined) {
    bandSig = clamp((bb.position - 0.5) * 2, -1, 1) * -0.6;
  }

  // ── Williams %R ───────────────────────────────────────────────────────────
  const wR    = calcWilliamsR(candles5m, 14);
  const wRSig = clamp((-wR - 50) / 50 * 0.6, -1, 1);

  // ── CCI ───────────────────────────────────────────────────────────────────
  const cci    = calcCCI(candles5m, 20);
  const cciSig = clamp(cci / 200, -1, 1);

  // ── StochRSI ─────────────────────────────────────────────────────────────
  const stoch = calcStochRSI(closes);
  let stochSig = 0;
  if (stoch) {
    const kdCross = stoch.k > stoch.d ? 1 : stoch.k < stoch.d ? -1 : 0;
    if      (stoch.k > 80) stochSig = -0.6 - ((stoch.k - 80) / 20) * 0.4;
    else if (stoch.k < 20) stochSig =  0.6 + ((20 - stoch.k) / 20) * 0.4;
    else                    stochSig = (stoch.k - 50) / 50 * 0.35;
    stochSig = clamp(stochSig + kdCross * 0.12, -1, 1);
  }

  // ── HMA ───────────────────────────────────────────────────────────────────
  let hmaSig = 0;
  const hmaLine = calcHMA(closes, 20);
  if (hmaLine && hmaLine.length >= 3) {
    const hmaCurr = hmaLine[hmaLine.length - 1];
    const hmaPrev = hmaLine[hmaLine.length - 3];
    const hmaSlopePct = hmaPrev !== 0 ? (hmaCurr - hmaPrev) / hmaPrev * 100 : 0;
    hmaSig = clamp(hmaSlopePct * 5, -0.8, 0.8);
    const hmaDevPct = closes[n-1] !== 0 ? (closes[n-1] - hmaCurr) / hmaCurr * 100 : 0;
    if (Math.abs(hmaDevPct) > 0.4) hmaSig += clamp(hmaDevPct * 0.28, -0.3, 0.3);
    hmaSig = clamp(hmaSig, -1, 1);
  }

  // ── VWMA ─────────────────────────────────────────────────────────────────
  let vwmaSig = 0;
  const vwmaLine = calcVWMA(candles5m, 20);
  if (vwmaLine && vwmaLine.length >= 3) {
    const vwmaCurr = vwmaLine[vwmaLine.length - 1];
    const vwmaPrev = vwmaLine[vwmaLine.length - 3] ?? vwmaCurr;
    const vwmaSlope = vwmaPrev !== 0 ? (vwmaCurr - vwmaPrev) / vwmaPrev * 100 : 0;
    vwmaSig = clamp(vwmaSlope * 5, -0.8, 0.8);
    const vwmaDevPct = closes[n-1] !== 0 ? (closes[n-1] - vwmaCurr) / vwmaCurr * 100 : 0;
    vwmaSig += clamp(vwmaDevPct * 0.15, -0.2, 0.2);
    vwmaSig = clamp(vwmaSig, -1, 1);
  }

  // ── OBV ───────────────────────────────────────────────────────────────────
  let obvSig = 0;
  const obvLine = calcOBV(candles5m);
  if (obvLine && obvLine.length >= 10) {
    const obvSlice = obvLine.slice(-10);
    const obvMin = Math.min(...obvSlice), obvMax = Math.max(...obvSlice);
    const obvRange = obvMax - obvMin;
    obvSig = obvRange > 0
      ? clamp((obvLine[obvLine.length - 1] - obvMin) / obvRange * 2 - 1, -1, 1) * 0.6
      : 0;
  }

  // ── Volume surge ─────────────────────────────────────────────────────────
  let volSig = 0;
  if (volumes.length >= 10) {
    const avgVol = volumes.slice(-10).reduce((s, v) => s + v, 0) / 10;
    const curVol = volumes[volumes.length - 1];
    if (avgVol > 0) volSig = clamp((curVol / avgVol - 1) * 0.5, -0.5, 0.5);
  }

  // ── MFI ───────────────────────────────────────────────────────────────────
  const mfi = calcMFI(candles5m, 14);
  let mfiSig = 0;
  if (mfi !== null && mfi !== undefined) {
    if      (mfi > 80) mfiSig = clamp(-0.6 - ((mfi - 80) / 20) * 0.4, -1, -0.2);
    else if (mfi < 20) mfiSig = clamp( 0.6 + ((20 - mfi) / 20) * 0.4,  0.2,  1);
    else               mfiSig = (mfi - 50) / 50 * 0.3;
  }

  // ── ADX  (returns { adx, pdi, mdi }) ─────────────────────────────────────
  let adxSig = 0;
  const adxResult = calcADX(candles5m, 14);
  if (adxResult) {
    const adxGate = adxResult.adx < 10
      ? Math.max(0.05, adxResult.adx / 10 * 0.25)
      : adxResult.adx < 20
      ? Math.max(0.25, adxResult.adx / 20)
      : 1.0;
    // Use pdi / mdi (the actual field names from calcADX)
    const diCross = (adxResult.pdi - adxResult.mdi) / ((adxResult.pdi + adxResult.mdi) || 1);
    adxSig = clamp(diCross * adxGate, -1, 1);
  }

  // ── Supertrend  (returns { signal: 1|-1, bullish }) ───────────────────────
  let strendSig = 0;
  const strendResult = calcSupertrend(candles5m, 10, 3);
  if (strendResult) {
    strendSig = strendResult.signal === 1 ? 0.7 : strendResult.signal === -1 ? -0.7 : 0;
  }

  // ── VWAP (rolling 20-candle) ──────────────────────────────────────────────
  let vwapSig = 0;
  if (candles5m.length >= 5) {
    let cumTPV = 0, cumVol = 0;
    for (const c of candles5m.slice(-20)) {
      const tp = (c.h + c.l + c.c) / 3;
      cumTPV += tp * c.v;
      cumVol += c.v;
    }
    const vwap    = cumVol > 0 ? cumTPV / cumVol : closes[n - 1];
    const vwapDev = (closes[n - 1] - vwap) / (vwap || 1) * 100;
    vwapSig = clamp(vwapDev * 0.4, -0.8, 0.8);
  }

  // ── Momentum (ROC 10) ─────────────────────────────────────────────────────
  let momentumSig = 0;
  if (closes.length >= 10) {
    const roc = (closes[n - 1] - closes[n - 10]) / (closes[n - 10] || 1) * 100;
    momentumSig = clamp(roc * 0.3, -0.8, 0.8);
  }

  return {
    rsi:        rsiSig,
    macd:       macdSig,
    ema:        emaSig,
    bands:      bandSig,
    williamsR:  wRSig,
    cci:        cciSig,
    stochrsi:   stochSig,
    hma:        hmaSig,
    vwma:       vwmaSig,
    obv:        obvSig,
    volume:     volSig,
    mfi:        mfiSig,
    adx:        adxSig,
    supertrend: strendSig,
    vwap:       vwapSig,
    momentum:   momentumSig,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GRADIENT DESCENT OPTIMIZER
// Simple per-weight SGD with tanh loss; clamps weights to [0.01, 10].
// ══════════════════════════════════════════════════════════════════════════════

function optimizeWeights(observations, coinBias, learningRate = 0.01, epochs = 150) {
  const weights    = { ...coinBias };
  const indicators = Object.keys(weights);
  const epochLogs  = [];

  function computeAccuracy(W) {
    let correct = 0;
    for (const obs of observations) {
      let score = 0, totalW = 0;
      for (const k of indicators) {
        const sig = obs.signalVector[k] || 0;
        score  += sig * (W[k] || 1);
        totalW += Math.abs(W[k] || 1);
      }
      const normScore = totalW > 0 ? score / totalW : 0;
      const pred = normScore > 0 ? 'UP' : 'DOWN';
      if (pred === obs.actualDirection) correct++;
    }
    return observations.length > 0 ? correct / observations.length : 0;
  }

  const initialAccuracy = computeAccuracy(weights);

  for (let epoch = 0; epoch < epochs; epoch++) {
    let totalLoss = 0;
    const gradients = {};
    indicators.forEach(k => gradients[k] = 0);

    for (const obs of observations) {
      let score = 0, totalW = 0;
      for (const k of indicators) {
        const sig = obs.signalVector[k] || 0;
        score  += sig * (weights[k] || 1);
        totalW += Math.abs(weights[k] || 1);
      }
      const normScore = totalW > 0 ? score / totalW : 0;
      const target = obs.actualDirection === 'UP' ? 1 : -1;
      const pred   = Math.tanh(normScore * 2);
      const loss   = (pred - target) ** 2;
      totalLoss   += loss;

      const dLoss = 2 * (pred - target);
      const dTanh = 1 - pred ** 2;
      for (const k of indicators) {
        const sig = obs.signalVector[k] || 0;
        gradients[k] += dLoss * dTanh * sig / (totalW || 1);
      }
    }

    for (const k of indicators) {
      weights[k] -= (learningRate * gradients[k]) / Math.max(1, observations.length);
      weights[k]  = Math.max(0.01, Math.min(10, weights[k]));
    }

    if (epoch % 30 === 0 || epoch === epochs - 1) {
      const acc = computeAccuracy(weights);
      const logLine = `  Epoch ${epoch}: loss=${(totalLoss / Math.max(1, observations.length)).toFixed(4)}, acc=${(acc * 100).toFixed(1)}%`;
      epochLogs.push(logLine);
      console.log(logLine);
    }
  }

  const finalAccuracy = computeAccuracy(weights);
  return { updatedWeights: weights, initialAccuracy, finalAccuracy, epochLogs };
}

// ══════════════════════════════════════════════════════════════════════════════
// WEIGHT WRITER
// Surgically replaces numeric values inside the coin's PER_COIN_INDICATOR_BIAS
// block in predictions.js (and optionally backtest-runner.js).
// Only writes weights that changed by >5%.
// ══════════════════════════════════════════════════════════════════════════════

function writeWeightsToPredictions(coin, oldWeights, newWeights, filePath, tradeCount, dateStr) {
  let src = fs.readFileSync(filePath, 'utf8');

  const changed = [];
  for (const [key, newVal] of Object.entries(newWeights)) {
    const oldVal = oldWeights[key];
    if (oldVal === undefined) continue;
    const changePct = Math.abs((newVal - oldVal) / (Math.abs(oldVal) || 1)) * 100;
    if (changePct > 5) changed.push({ key, oldVal, newVal, changePct });
  }

  if (changed.length === 0) {
    console.log(`  [${coin}] No weights changed by >5%, skipping write`);
    return 0;
  }

  let updatedSrc   = src;
  let updatedCount = 0;

  for (const { key, newVal } of changed) {
    // Match `key: <number>` inside the coin's block (dotall flag for multiline)
    const coinBlockRegex = new RegExp(
      `(${coin}[^}]*?${key}\\s*:\\s*)([\\d.]+)`,
      's'
    );
    const newSrc = updatedSrc.replace(coinBlockRegex, (match, prefix) => {
      updatedCount++;
      return `${prefix}${parseFloat(newVal.toFixed(3))}`;
    });
    if (newSrc !== updatedSrc) updatedSrc = newSrc;
  }

  if (updatedCount > 0) {
    const tuneComment = `// outcome-feedback tuned ${dateStr} from ${tradeCount} trades`;
    const coinMarker  = new RegExp(`(${coin}\\s*:\\s*\\{)`);
    updatedSrc = updatedSrc.replace(coinMarker, `$1 ${tuneComment}`);

    fs.writeFileSync(filePath, updatedSrc, 'utf8');
    console.log(`  [${coin}] Wrote ${updatedCount} weight updates to ${path.basename(filePath)}`);
  }

  return updatedCount;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const dateStr        = new Date().toISOString().slice(0, 10);
  const crossCheckPath = path.join(LOG_DIR, `outcome-feedback-${dateStr}.log`);
  const logLines       = [];
  const log = (msg) => { console.log(msg); logLines.push(msg); };

  log(`\n${'='.repeat(60)}`);
  log(`WECRYPTO Outcome Feedback System — ${new Date().toISOString()}`);
  log(`${'='.repeat(60)}\n`);

  if (csvFiles.length === 0) {
    log('ERROR: No --csv files specified');
    process.exit(1);
  }

  // ── Step 1: Parse CSVs ─────────────────────────────────────────────────────
  log('── Step 1: Parsing CSVs ──────────────────────────────────');
  let allRows = [];
  for (const f of csvFiles) {
    if (!fs.existsSync(f)) { log(`  WARN: File not found: ${f}`); continue; }
    const rows = parseCSV(f);
    log(`  ${path.basename(f)}: ${rows.length} rows`);
    allRows = allRows.concat(rows);
  }

  const windows = extractWindows(allRows);
  log(`  Total unique Filled/Order windows: ${windows.length}`);

  const filteredWindows = coinFilter
    ? windows.filter(w => coinFilter.includes(w.coin))
    : windows;
  log(`  After coin filter (${coinFilter ? coinFilter.join(',') : 'all'}): ${filteredWindows.length} windows\n`);

  // Group by coin
  const byCoin = {};
  for (const w of filteredWindows) {
    if (!byCoin[w.coin]) byCoin[w.coin] = [];
    byCoin[w.coin].push(w);
  }
  for (const [coin, wins] of Object.entries(byCoin)) {
    log(`  [${coin}] ${wins.length} windows`);
  }

  // ── Step 2: Load current PER_COIN_INDICATOR_BIAS ────────────────────────────
  log('\n── Step 2: Loading current weights ──────────────────────');
  const predsSrc  = fs.readFileSync(PREDS_PATH, 'utf8');
  const biasMatch = predsSrc.match(/PER_COIN_INDICATOR_BIAS\s*=\s*(\{[\s\S]*?\}\s*;)/);
  let currentBias = {};
  if (biasMatch) {
    try {
      const obj = new Function(`return ${biasMatch[1].slice(0, -1)}`)();
      currentBias = obj;
      log(`  Loaded biases for: ${Object.keys(currentBias).join(', ')}`);
    } catch (e) {
      log(`  WARN: Could not parse PER_COIN_INDICATOR_BIAS: ${e.message}`);
    }
  } else {
    log('  WARN: PER_COIN_INDICATOR_BIAS not found in predictions.js');
  }

  // ── TEST MODE ──────────────────────────────────────────────────────────────
  if (testMode) {
    log('\n── TEST MODE: skipping API calls and gradient descent ────');
    log('  Windows by coin:');
    for (const [coin, wins] of Object.entries(byCoin)) {
      log(`    ${coin}: ${wins.length} windows`);
      wins.slice(0, 3).forEach(w =>
        log(`      ${w.ticker} → ${new Date(w.startMs).toISOString()} – ${new Date(w.endMs).toISOString()}`)
      );
    }
    log('\n  Current bias keys per coin:');
    for (const [coin, bias] of Object.entries(currentBias)) {
      log(`    ${coin}: ${Object.keys(bias).join(', ')}`);
    }
    log('\n  TEST MODE complete — no API calls made');
    fs.writeFileSync(crossCheckPath, logLines.join('\n'), 'utf8');
    log(`  Log written: ${crossCheckPath}`);
    process.exit(0);
  }

  // ── Step 3: Fetch candles & compute signals ────────────────────────────────
  log('\n── Step 3: Fetching candle data & computing signals ──────');
  const observations = {};
  const tradeDetails = [];

  // Coins not listed on Binance (e.g. HYPE = Hyperliquid)
  const NO_BINANCE = new Set(['HYPE']);

  for (const [coin, wins] of Object.entries(byCoin)) {
    const sym = SYMBOL_MAP[coin];
    if (!sym)               { log(`  SKIP: No symbol mapping for ${coin}`); continue; }
    if (NO_BINANCE.has(coin)) { log(`  SKIP [${coin}]: Not available on Binance`); continue; }

    log(`\n  [${coin}] Processing ${wins.length} windows (symbol: ${sym})...`);
    observations[coin] = [];
    let fetched = 0, skipped = 0, errors = 0;
    let consecutiveNulls = 0;

    for (const win of wins) {
      await sleep(120); // rate-limit

      const outcomeKlines = await fetchKlines(sym, '1m', win.startMs, win.endMs, 15);

      // If the symbol returns null 3× in a row before any success, assume not on Binance
      if (outcomeKlines === null) {
        if (fetched === 0) {
          consecutiveNulls++;
          if (consecutiveNulls >= 3) {
            log(`  SKIP [${coin}]: Symbol ${sym} appears unavailable on Binance`);
            NO_BINANCE.add(coin);
            break;
          }
        }
        skipped++;
        continue;
      }
      consecutiveNulls = 0;

      if (outcomeKlines.length < 2) { skipped++; continue; }

      const outcome = getActualDirection(outcomeKlines);
      if (!outcome || outcome.direction === 'FLAT') { skipped++; continue; }

      await sleep(120); // rate-limit
      const lookbackKlines = await fetchKlines(
        sym, '5m',
        win.startMs - 160 * 5 * 60 * 1000,
        win.startMs,
        160
      );

      if (!lookbackKlines || lookbackKlines.length < 30) { skipped++; continue; }

      const candles = lookbackKlines.map(k => ({
        t: k[0],
        o: parseFloat(k[1]),
        h: parseFloat(k[2]),
        l: parseFloat(k[3]),
        c: parseFloat(k[4]),
        v: parseFloat(k[5]),
      }));

      let sigVec;
      try { sigVec = buildSignalVector(candles); }
      catch (e) {
        errors++;
        tradeDetails.push({ coin, windowStart: win.startMs, error: e.message });
        continue;
      }

      if (!sigVec) { skipped++; continue; }

      // Compute baseline model score using current bias
      const bias = currentBias[coin] || {};
      let modelScore = 0, totalW = 0;
      for (const [k, w] of Object.entries(bias)) {
        const sig = sigVec[k] || 0;
        modelScore += sig * w;
        totalW     += Math.abs(w);
      }
      const normScore  = totalW > 0 ? modelScore / totalW : 0;
      const modelPred  = normScore > 0 ? 'UP' : 'DOWN';
      const wasCorrect = modelPred === outcome.direction;
      const errType    = !wasCorrect
        ? (Math.abs(normScore) < 0.2 ? 'LOW_CONFIDENCE' : 'SIGNAL_INVERSION')
        : null;

      const topSignals = Object.entries(sigVec)
        .map(([k, v]) => ({ name: k, value: v, wt: bias[k] || 1, contrib: Math.abs(v * (bias[k] || 1)) }))
        .sort((a, b) => b.contrib - a.contrib)
        .slice(0, 3)
        .map(s => `${s.name}:${s.value.toFixed(2)}`);

      tradeDetails.push({
        coin,
        windowStart:      new Date(win.startMs).toISOString(),
        windowEnd:        new Date(win.endMs).toISOString(),
        actualDirection:  outcome.direction,
        pctChange:        outcome.pctChange.toFixed(4),
        modelScore:       normScore.toFixed(4),
        modelPrediction:  modelPred,
        wasCorrect,
        topSignals,
        errorType:        errType,
      });

      observations[coin].push({
        coin,
        signalVector:    sigVec,
        actualDirection: outcome.direction,
        windowStart:     win.startMs,
      });

      fetched++;
      if (fetched % 20 === 0) log(`    ...${fetched}/${wins.length} fetched`);
    }

    if (!NO_BINANCE.has(coin)) {
      log(`  [${coin}] Done: ${fetched} usable, ${skipped} skipped, ${errors} errors`);
      // Print baseline accuracy
      if (fetched > 0) {
        const correct = tradeDetails.filter(d => d.coin === coin && d.wasCorrect).length;
        const total   = tradeDetails.filter(d => d.coin === coin && d.wasCorrect !== undefined).length;
        if (total > 0) log(`  [${coin}] Baseline accuracy: ${(correct / total * 100).toFixed(1)}% (${correct}/${total})`);
      }
    }
  }

  // Write cross-check log (includes trade detail JSON)
  fs.writeFileSync(
    crossCheckPath,
    logLines.join('\n') + '\n\n--- TRADE DETAIL ---\n' + JSON.stringify(tradeDetails, null, 2),
    'utf8'
  );
  log(`\n  Cross-check log: ${crossCheckPath}`);

  // ── Step 4: Gradient Descent per coin ─────────────────────────────────────
  log('\n── Step 4: Gradient Descent Optimization ─────────────────');
  const optimized = {};

  for (const [coin, obs] of Object.entries(observations)) {
    if (obs.length < 15) {
      log(`  [${coin}] Only ${obs.length} observations — need ≥15, skipping`);
      continue;
    }
    log(`\n  [${coin}] ${obs.length} observations — optimizing (150 epochs)...`);

    const bias = currentBias[coin] || {};
    if (Object.keys(bias).length === 0) {
      log(`  [${coin}] No bias weights found in predictions.js, skipping`);
      continue;
    }

    const result = optimizeWeights(obs, bias, 0.01, 150);
    optimized[coin] = result;

    log(`  [${coin}] Initial accuracy: ${(result.initialAccuracy * 100).toFixed(1)}%`);
    log(`  [${coin}] Final accuracy:   ${(result.finalAccuracy   * 100).toFixed(1)}%`);
    log(`  [${coin}] Delta: ${((result.finalAccuracy - result.initialAccuracy) * 100).toFixed(1)}pp`);

    log(`\n  Weight changes for ${coin}:`);
    log(`  ${'Indicator'.padEnd(15)} ${'Old'.padStart(6)} → ${'New'.padStart(6)} (${'Δ%'.padStart(7)})`);
    log(`  ${'-'.repeat(45)}`);
    for (const [k, newW] of Object.entries(result.updatedWeights)) {
      const oldW  = bias[k] || 1;
      const delta = (newW - oldW) / (Math.abs(oldW) || 1) * 100;
      const mark  = Math.abs(delta) > 5 ? ' ◄' : '';
      log(`  ${k.padEnd(15)} ${oldW.toFixed(3).padStart(6)} → ${newW.toFixed(3).padStart(6)} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)${mark}`);
    }
  }

  // ── Step 5: Write tuned-weights JSON ──────────────────────────────────────
  const weightsOutPath = path.join(LOG_DIR, `tuned-weights-${dateStr}.json`);
  const weightsJson    = {};
  for (const [coin, res] of Object.entries(optimized)) {
    weightsJson[coin] = {
      initialAccuracy: res.initialAccuracy,
      finalAccuracy:   res.finalAccuracy,
      observations:    observations[coin].length,
      weights:         res.updatedWeights,
    };
  }
  fs.writeFileSync(weightsOutPath, JSON.stringify(weightsJson, null, 2), 'utf8');
  log(`\n  Tuned weights written: ${weightsOutPath}`);

  // ── Step 6: Optionally write weights back to source ────────────────────────
  if (writeWeights) {
    log('\n── Step 5: Writing Weights to Source Files ───────────────');
    for (const [coin, res] of Object.entries(optimized)) {
      const tradeCount = observations[coin].length;
      const oldBias    = currentBias[coin] || {};
      writeWeightsToPredictions(coin, oldBias, res.updatedWeights, PREDS_PATH, tradeCount, dateStr);
      writeWeightsToPredictions(coin, oldBias, res.updatedWeights, BT_PATH,    tradeCount, dateStr);
    }

    log('\n── Step 6: Syntax Validation ─────────────────────────────');
    const { execSync } = require('child_process');
    for (const [label, fp] of [[`predictions.js`, PREDS_PATH], [`backtest-runner.js`, BT_PATH]]) {
      try {
        execSync(`node --check "${fp}"`, { stdio: 'pipe' });
        log(`  ${label} — ✅ OK`);
      } catch (e) {
        log(`  ${label} — ❌ SYNTAX ERROR: ${e.stderr?.toString().slice(0, 200)}`);
      }
    }
  }

  log('\n── COMPLETE ──────────────────────────────────────────────\n');
  // Final flush of log (includes optimizer output)
  fs.writeFileSync(crossCheckPath, logLines.join('\n'), 'utf8');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
