#!/usr/bin/env node
// ================================================================
// WECRYPTO — Signal Diagnostic Backtest
// Pulls 30 days of 5m candles (Coinbase → Binance.US fallback).
// Purpose: EXPOSE FLAWS — calibration, churn, regime blindness.
// Usage:  node backtest-diag.js
//         node backtest-diag.js --coin BTC
// ================================================================
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const args        = process.argv.slice(2);
const getArg      = f => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };
const FILTER_COIN = getArg('--coin')?.toUpperCase() || null;

// 30 days of 5m bars = 8640 candles — fast, representative, enough to catch flaws
const DAYS_TO_FETCH = 30;
const LIVE_WINDOW   = 300;
const WARMUP        = 52;

const CB_PAIR = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
  XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: null, HYPE: null,
};

const PREDICTION_COINS = [
  { sym: 'BTC',  binSym: 'BTCUSDT'  },
  { sym: 'ETH',  binSym: 'ETHUSDT'  },
  { sym: 'SOL',  binSym: 'SOLUSDT'  },
  { sym: 'XRP',  binSym: 'XRPUSDT'  },
  { sym: 'DOGE', binSym: 'DOGEUSDT' },
  { sym: 'BNB',  binSym: 'BNBUSDT'  },
  { sym: 'HYPE', binSym: 'HYPEUSDT' },
];

// ── Exact weights / filters from predictions.js ──────────────────
// PATCH-DIAG: ichimoku ↓ (slow, hurts short horizons), momentum ↑,
//             structure ↑, williamsR ↓ (single-indicator dominance reduced)
const COMPOSITE_WEIGHTS = {
  // ── Trend-following (74% of weight) — momentum continuation dominates at 1-15 min ──
  ema:         0.18,  // ↑↑ strongest directional anchor
  structure:   0.17,  // ↑↑ breakout/breakdown confirmation
  momentum:    0.14,  // ↑↑↑ short-term rate of change
  persistence: 0.12,  // recent candle direction continuation
  macd:        0.10,  // trend momentum confirmation
  obv:         0.09,  // volume-confirmed direction
  volume:      0.08,  // volume confirmation
  // ── Neutral / gating ──────────────────────────────────────────────
  vwap:        0.06,  // reduced — mean-reversion bias
  adx:         0.05,  // ADX gate handles flat suppression separately
  // ── Mean-reversion oscillators (15% total) ────────────────────────
  rsi:         0.04,  // ↓↓ overbought/oversold misleads at short horizons
  bands:       0.04,  // ↓↓ price at upper band ≠ sell signal at 5-min
  williamsR:   0.04,  // ↓↓↓ was 0.14 — most harmful anti-momentum signal
  stochrsi:    0.03,  // ↓↓ mean-reversion oscillator
  mfi:         0.03,  // ↓↓ mean-reversion oscillator
  ichimoku:    0.02,  // ↓↓↓ 52-bar cloud is noise at 1–5 min horizons
};
// SCORE_AMPLIFIER: trend-heavy weights give raw composite 0–0.5; 1.6× maps strong trend to ~0.7-0.9
const SCORE_AMPLIFIER = 1.6;

// Thresholds scaled for 1.6× amplification
const BACKTEST_FILTER_OVERRIDES = {
  BTC:  { h1:{et:0.23,ma:0.54}, h5:{et:0.28,ma:0.58}, h10:{et:0.33,ma:0.62}, h15:{et:0.38,ma:0.66} },
  ETH:  { h1:{et:0.23,ma:0.54}, h5:{et:0.28,ma:0.58}, h10:{et:0.33,ma:0.62}, h15:{et:0.38,ma:0.66} },
  SOL:  { h1:{et:0.20,ma:0.52}, h5:{et:0.25,ma:0.56}, h10:{et:0.30,ma:0.60}, h15:{et:0.35,ma:0.64} },
  XRP:  { h1:{et:0.19,ma:0.52}, h5:{et:0.23,ma:0.56}, h10:{et:0.28,ma:0.60}, h15:{et:0.32,ma:0.64} },
  DOGE: { h1:{et:0.28,ma:0.58}, h5:{et:0.32,ma:0.60}, h10:{et:0.35,ma:0.62}, h15:{et:0.38,ma:0.66} },
  // maxEt cap: diagnostic found conf 60%+ = strongly anti-predictive (26-35% WR) for high-beta coins
  BNB:  { h1:{et:0.20,maxEt:0.58,ma:0.54}, h5:{et:0.25,maxEt:0.58,ma:0.58}, h10:{et:0.29,maxEt:0.58,ma:0.62}, h15:{et:0.33,maxEt:0.58,ma:0.64} },
  HYPE: { h1:{et:0.18,maxEt:0.40,ma:0.52}, h5:{et:0.20,maxEt:0.40,ma:0.52}, h10:{et:0.22,maxEt:0.40,ma:0.54}, h15:{et:0.24,maxEt:0.40,ma:0.56} },
};
const DEFAULT_FILTERS = {
  h1:{et:0.18,ma:0.52}, h5:{et:0.22,ma:0.54}, h10:{et:0.26,ma:0.56}, h15:{et:0.30,ma:0.58}
};
const SHORT_HORIZON_MINUTES = [1, 5, 10, 15];
const BAR_MINUTES = 5; // candle granularity — convert minute horizons to bar counts

const clamp   = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const average = arr => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0;

// ── Indicators (same as backtest-runner.js) ──────────────────────
function computeRSI(closes, period=14) {
  if (closes.length < period+1) return 50;
  let gains=0, losses=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0) gains+=d; else losses-=d;
  }
  const rs = losses===0 ? 100 : gains/losses;
  return 100-(100/(1+rs));
}
function computeEMA(arr, period) {
  if (arr.length < period) return arr[arr.length-1];
  const k = 2/(period+1);
  let ema = arr.slice(0,period).reduce((s,v)=>s+v,0)/period;
  for (let i=period; i<arr.length; i++) ema = arr[i]*k + ema*(1-k);
  return ema;
}
function computeVWAP(bars) {
  let tpv=0, vol=0;
  for (const b of bars) { const tp=(b.h+b.l+b.c)/3; tpv+=tp*b.v; vol+=b.v; }
  return vol>0 ? tpv/vol : bars[bars.length-1].c;
}
function computeOBV(bars) {
  let obv=0;
  for (let i=1;i<bars.length;i++) {
    if (bars[i].c>bars[i-1].c) obv+=bars[i].v;
    else if (bars[i].c<bars[i-1].c) obv-=bars[i].v;
  }
  return obv;
}
function computeMACD(closes) {
  if (closes.length<26) return {line:0,signal:0,hist:0};
  const e12=computeEMA(closes,12), e26=computeEMA(closes,26);
  const line=e12-e26;
  const prevLine=computeEMA(closes.slice(0,-1),12)-computeEMA(closes.slice(0,-1),26);
  const sig=(line+prevLine)/2;
  return {line, signal:sig, hist:line-sig};
}
function computeBB(closes, period=20) {
  if (closes.length<period) return {upper:closes[0],lower:closes[0],middle:closes[0]};
  const slice=closes.slice(-period);
  const mid=average(slice);
  const std=Math.sqrt(average(slice.map(v=>(v-mid)**2)));
  return {upper:mid+2*std, lower:mid-2*std, middle:mid};
}
function computeStochRSI(closes, period=14) {
  if (closes.length<period*2) return 0.5;
  const rsis=[];
  for (let i=period;i<=closes.length;i++) rsis.push(computeRSI(closes.slice(i-period-1,i)));
  const slice=rsis.slice(-period);
  const lo=Math.min(...slice), hi=Math.max(...slice);
  return hi===lo ? 0.5 : (rsis[rsis.length-1]-lo)/(hi-lo);
}
function computeADX(bars, period=14) {
  if (bars.length<period+1) return 20;
  let pDM=0, mDM=0, atr=0;
  for (let i=bars.length-period;i<bars.length;i++) {
    const hi=bars[i].h-bars[i-1].h, lo=bars[i-1].l-bars[i].l;
    if (hi>lo&&hi>0) pDM+=hi; else if (lo>hi&&lo>0) mDM+=lo;
    atr+=Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-bars[i-1].c), Math.abs(bars[i].l-bars[i-1].c));
  }
  if (atr===0) return 20;
  const pDI=100*pDM/atr, mDI=100*mDM/atr;
  const dxSum=pDI+mDI===0?0:Math.abs(pDI-mDI)/(pDI+mDI)*100;
  return dxSum;
}
function computeWilliamsR(bars, period=14) {
  const slice=bars.slice(-period);
  const hi=Math.max(...slice.map(b=>b.h)), lo=Math.min(...slice.map(b=>b.l));
  return hi===lo ? -50 : -100*(hi-bars[bars.length-1].c)/(hi-lo);
}
function computeMFI(bars, period=14) {
  const slice=bars.slice(-period-1);
  let posFlow=0, negFlow=0;
  for (let i=1;i<slice.length;i++) {
    const tp=(slice[i].h+slice[i].l+slice[i].c)/3;
    const prevTp=(slice[i-1].h+slice[i-1].l+slice[i-1].c)/3;
    if (tp>prevTp) posFlow+=tp*slice[i].v; else negFlow+=tp*slice[i].v;
  }
  return negFlow===0 ? 80 : 100-(100/(1+(posFlow/negFlow)));
}
function computeIchimoku(bars) {
  if (bars.length<52) return {aboveCloud:false,tenkanKijun:false};
  const tenkan=(Math.max(...bars.slice(-9).map(b=>b.h))+Math.min(...bars.slice(-9).map(b=>b.l)))/2;
  const kijun=(Math.max(...bars.slice(-26).map(b=>b.h))+Math.min(...bars.slice(-26).map(b=>b.l)))/2;
  const senkouA=(tenkan+kijun)/2;
  const senkouB=(Math.max(...bars.slice(-52).map(b=>b.h))+Math.min(...bars.slice(-52).map(b=>b.l)))/2;
  const price=bars[bars.length-1].c;
  return {
    aboveCloud: price>Math.max(senkouA,senkouB),
    tenkanKijun: tenkan>kijun,
  };
}

// ── Composite signal (exact live-app logic) ──────────────────────
function computeSignal(window) {
  if (window.length < WARMUP) return null;
  const bars   = window;
  const closes = bars.map(b=>b.c);
  const last   = closes[closes.length-1];

  const rsi      = computeRSI(closes);
  const ema20    = computeEMA(closes,20);
  const ema50    = computeEMA(closes,50);
  const vwap     = computeVWAP(bars);
  const obv      = computeOBV(bars);
  const obvPrev  = computeOBV(bars.slice(0,-5));
  const volumes  = bars.map(b=>b.v);
  const avgVol   = average(volumes.slice(-20));
  const curVol   = volumes[volumes.length-1];
  const bb       = computeBB(closes);
  const macd     = computeMACD(closes);
  const stochRsi = computeStochRSI(closes);
  const adx      = computeADX(bars);
  const wR       = computeWilliamsR(bars);
  const mfi      = computeMFI(bars);
  const ichi     = computeIchimoku(bars);

  const prevClose = closes[closes.length-2];
  const momentum  = (last - closes[closes.length-6]) / closes[closes.length-6];
  const volRatio  = avgVol>0 ? curVol/avgVol : 1;

  // Persist: same direction last N bars
  const recentDir = closes.slice(-5).map((c,i,a)=>i===0?0:c>a[i-1]?1:-1).slice(1);
  const persist   = recentDir.filter(d=>d===recentDir[recentDir.length-1]).length/4;

  // Structure: higher highs / lower lows
  const highs = bars.slice(-10).map(b=>b.h);
  const lows  = bars.slice(-10).map(b=>b.l);
  const hhCount = highs.filter((h,i)=>i>0&&h>highs[i-1]).length;
  const llCount = lows.filter((l,i)=>i>0&&l<lows[i-1]).length;
  const structure = (hhCount-llCount)/9;

  const scores = {
    rsi:        clamp((50-rsi)/50, -1, 1) * -1,
    ema:        ema20>ema50 ? 1 : -1,
    vwap:       last>vwap ? 0.7 : -0.7,
    obv:        obv>obvPrev ? 0.8 : -0.8,
    volume:     clamp((volRatio-1)*0.5, -1, 1),
    momentum:   clamp(momentum*20, -1, 1),
    bands:      last<bb.lower ? 0.9 : last>bb.upper ? -0.9 : 0,
    persistence:clamp(persist*2-1, -1, 1),
    structure:  clamp(structure, -1, 1),
    macd:       macd.hist>0 ? 0.8 : -0.8,
    stochrsi:   clamp((0.5-stochRsi)*2, -1, 1) * -1,
    adx:        adx>25 ? (momentum>=0 ? 0.5 : -0.5) : adx>18 ? (momentum>=0 ? 0.25 : -0.25) : 0,
    ichimoku:   ichi.aboveCloud ? 0.7 : -0.7,
    williamsR:  clamp((wR+50)/50, -1, 1) * -1,
    mfi:        clamp((mfi-50)/50, -1, 1),
    _adxRaw:    adx, // used by ADX gate — not a scored indicator
  };

  const totalWeight = Object.values(COMPOSITE_WEIGHTS).reduce((s,v)=>s+v,0);
  let composite = 0;
  for (const [k,w] of Object.entries(COMPOSITE_WEIGHTS)) composite += (scores[k]||0)*w;
  composite /= totalWeight;

  // ADX gate: in flat/ranging markets (ADX < 20) composite is mostly noise.
  // Suppress proportionally — a dead flat market (ADX=5) kills 75% of signal.
  const adxVal = scores._adxRaw || adx;
  const adxGate = adxVal < 20 ? Math.max(0.25, adxVal / 20) : 1.0;

  // Amplify so high-agreement signals reach 0.6–0.9 range (was stuck at 0–0.40)
  const amplified = clamp(composite * SCORE_AMPLIFIER * adxGate, -1, 1);

  return { composite: amplified, scores, rsi, adx, macd, momentum, volRatio };
}

function isActive(sig, sym, horizonKey) {
  const f = (BACKTEST_FILTER_OVERRIDES[sym] || DEFAULT_FILTERS)[horizonKey];
  if (!f) return false;
  const abs = Math.abs(sig.composite);
  if (abs < f.et) return false;
  // maxEt cap: prevents momentum-exhaustion signals (when everything agrees = reversal imminent)
  if (f.maxEt !== undefined && abs > f.maxEt) return false;

  const agreeing = Object.entries(COMPOSITE_WEIGHTS).filter(([k]) => {
    const s = sig.scores[k]; return sig.composite>0 ? s>0 : s<0;
  }).reduce((sum,[,w])=>sum+w, 0);
  const totalW = Object.values(COMPOSITE_WEIGHTS).reduce((s,v)=>s+v,0);
  if (agreeing/totalW < f.ma) return false;

  // persistenceVeto
  if (sig.scores.persistence < -0.3 && abs < f.et * 1.5) return false;

  return true;
}

// ── HTTP helper ───────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: {'User-Agent':'WECRYPTO-Diag/1.0'} }, (res) => {
      if (res.statusCode>=300&&res.statusCode<400&&res.headers.location) { resolve(httpGet(res.headers.location)); return; }
      let data = ''; res.on('data', d=>data+=d); res.on('end', ()=>resolve({status:res.statusCode,body:data}));
    });
    req.on('error', reject);
    req.setTimeout(15000, ()=>{ req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Fetch 30 days — Coinbase (max 6 requests/day → ~35 req total) ─
async function fetchRecent(coin) {
  const endMs   = Date.now();
  const startMs = endMs - DAYS_TO_FETCH * 24 * 60 * 60 * 1000;
  const BAR_MS  = 5 * 60 * 1000;
  const PAGE_MS = 300 * BAR_MS;
  const allBars = [];
  let cursor    = endMs;
  let retries   = 0;

  // Coinbase
  if (CB_PAIR[coin.sym]) {
    while (cursor > startMs) {
      const pgStart = Math.max(startMs, cursor - PAGE_MS);
      const url = `https://api.exchange.coinbase.com/products/${CB_PAIR[coin.sym]}/candles?granularity=300&start=${new Date(pgStart).toISOString()}&end=${new Date(cursor).toISOString()}`;
      let resp;
      try { resp = await httpGet(url); } catch(e) {
        if (++retries>3) throw e; await new Promise(r=>setTimeout(r,2000*retries)); continue;
      }
      retries=0;
      if (resp.status===429) { await new Promise(r=>setTimeout(r,4000)); continue; }
      if (resp.status!==200) throw new Error(`Coinbase ${resp.status}: ${resp.body.slice(0,60)}`);
      const rows = JSON.parse(resp.body);
      if (!Array.isArray(rows)||rows.length===0) { cursor=pgStart-1; continue; }
      allBars.push(...rows.map(r=>({t:+r[0]*1000,o:+r[3],h:+r[2],l:+r[1],c:+r[4],v:+r[5]})));
      cursor = pgStart - 1;
      await new Promise(r=>setTimeout(r,220));
    }
    if (allBars.length > 200) {
      const seen=new Set();
      return allBars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
    }
  }

  // Binance.US fallback
  allBars.length = 0; cursor = endMs; retries = 0;
  while (cursor > startMs) {
    const url = `https://api.binance.us/api/v3/klines?symbol=${coin.binSym}&interval=5m&limit=1000&endTime=${cursor}`;
    let resp;
    try { resp = await httpGet(url); } catch(e) {
      if (++retries>3) throw e; await new Promise(r=>setTimeout(r,2000*retries)); continue;
    }
    retries=0;
    if (resp.status===429||resp.status===418) { await new Promise(r=>setTimeout(r,5000)); continue; }
    if (resp.status!==200) throw new Error(`Binance.US ${resp.status}`);
    const rows = JSON.parse(resp.body);
    if (!Array.isArray(rows)||rows.length===0) break;
    const bars = rows.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]}));
    allBars.unshift(...bars);
    cursor = bars[0].t - 1;
    if (bars[0].t <= startMs) break;
    await new Promise(r=>setTimeout(r,200));
  }
  const seen=new Set();
  return allBars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}

// ── Volatility regime label ───────────────────────────────────────
function getRegime(bars, idx) {
  const slice = bars.slice(Math.max(0,idx-48), idx+1);
  const closes = slice.map(b=>b.c);
  if (closes.length<10) return 'warm';
  const ret = Math.abs(closes[closes.length-1]/closes[0]-1);
  const adx = computeADX(slice.map(b=>b));
  if (adx>35) return 'trending';
  if (ret<0.005) return 'ranging';
  return 'warm';
}

// ── Diagnostic engine ─────────────────────────────────────────────
async function runDiag(coin, bars) {
  const N = bars.length;

  const horizons = SHORT_HORIZON_MINUTES; // [1,5,10,15]
  const hKeys    = ['h1','h5','h10','h15'];

  // Per-horizon accumulators
  const acc = {};
  horizons.forEach((h,i) => {
    acc[hKeys[i]] = {
      total:0, wins:0, losses:0, neutralsSkipped:0,
      highConfWins:0, highConfTotal:0,
      churnEvents:0, prevDir:null,
      regimes: {trending:{w:0,l:0}, ranging:{w:0,l:0}, warm:{w:0,l:0}},
      // Confidence buckets: 0-40 / 40-60 / 60-80 / 80-100
      confBuckets: [{lo:0,hi:40,w:0,l:0},{lo:40,hi:60,w:0,l:0},{lo:60,hi:80,w:0,l:0},{lo:80,hi:100,w:0,l:0}],
      consecLosses:0, maxConsecLosses:0, curStreak:0,
    };
  });

  let neutralCount = 0;

  for (let idx = LIVE_WINDOW + WARMUP; idx < N; idx++) {
    const window = bars.slice(idx - LIVE_WINDOW, idx);
    const sig = computeSignal(window);
    if (!sig) continue;

    const regime = getRegime(bars, idx);

    horizons.forEach((hMin, hi) => {
      const hk = hKeys[hi];
      const a  = acc[hk];
      const futureIdx = idx + Math.max(1, Math.round(hMin / BAR_MINUTES)); // convert minutes → bars
      if (futureIdx >= N) return;

      if (!isActive(sig, coin.sym, hk)) { a.neutralsSkipped++; return; }

      const entryPrice  = bars[idx].c;
      const futurePrice = bars[futureIdx].c;
      const direction   = sig.composite > 0 ? 'up' : 'down';
      const actualUp    = futurePrice > entryPrice;
      const win         = direction==='up' ? actualUp : !actualUp;

      // Confidence = abs(composite) mapped to 0-100
      const conf = clamp(Math.abs(sig.composite)*100, 0, 100);

      a.total++;
      if (win) a.wins++; else a.losses++;

      // Regime
      if (win) a.regimes[regime].w++; else a.regimes[regime].l++;

      // Confidence calibration
      for (const bkt of a.confBuckets) {
        if (conf>=bkt.lo && conf<bkt.hi) { if(win) bkt.w++; else bkt.l++; break; }
      }
      if (conf>=60) { a.highConfTotal++; if(win) a.highConfWins++; }

      // Churn — signal flip
      if (a.prevDir && a.prevDir !== direction) a.churnEvents++;
      a.prevDir = direction;

      // Consecutive losses
      if (!win) {
        a.curStreak++;
        a.maxConsecLosses = Math.max(a.maxConsecLosses, a.curStreak);
      } else { a.curStreak = 0; }
    });

    if (!isActive(sig, coin.sym, 'h1') && !isActive(sig, coin.sym, 'h5')) neutralCount++;
  }

  return { acc, neutralCount, totalCandles: N };
}

// ── Render flaw report ────────────────────────────────────────────
function renderReport(coin, result) {
  const { acc, neutralCount, totalCandles } = result;
  const hKeys = ['h1','h5','h10','h15'];
  const flaws = [];

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${coin.sym}  (${totalCandles.toLocaleString()} bars, ${DAYS_TO_FETCH}d)`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  ${'HRZ'.padEnd(4)}  ${'TOTAL'.padEnd(6)}  ${'WR%'.padEnd(6)}  ${'CHURN'.padEnd(6)}  ${'SKIP%'.padEnd(6)}  ${'HC-WR%'.padEnd(7)}  MAX-LOSS-STK`);

  let allTime = { total:0, wins:0 };

  hKeys.forEach(hk => {
    const a = acc[hk];
    const wr  = a.total ? (a.wins/a.total*100).toFixed(1) : '—';
    const hcwr = a.highConfTotal ? (a.highConfWins/a.highConfTotal*100).toFixed(1) : '—';
    const skipPct = (a.neutralsSkipped / ((a.total + a.neutralsSkipped)||1) * 100).toFixed(0);
    const churnPct = (a.churnEvents / (a.total||1) * 100).toFixed(0);

    allTime.total += a.total; allTime.wins += a.wins;

    // Flag flaws
    const wrNum = parseFloat(wr);
    const hcNum = parseFloat(hcwr);
    let flags = '';
    if (wrNum < 48)  { flags += ' ⚠ BELOW-RANDOM'; flaws.push(`${hk}: WR ${wr}% below random`); }
    if (hcNum < wrNum-5 && a.highConfTotal > 10) { flags += ' ⚠ OVERCONFIDENT'; flaws.push(`${hk}: High-conf WR ${hcwr}% < overall — model overconfident`); }
    if (parseInt(churnPct) > 45) { flags += ' ⚠ CHURN'; flaws.push(`${hk}: ${churnPct}% signal churn — flip-flopping`); }
    if (parseInt(skipPct) > 90)  { flags += ' ⚠ OVERTRADE-FILTER'; flaws.push(`${hk}: ${skipPct}% signals filtered — thresholds may be too tight`); }
    if (a.maxConsecLosses > 8)   { flags += ` ⚠ STREAK(${a.maxConsecLosses})`; flaws.push(`${hk}: max ${a.maxConsecLosses} consecutive losses`); }

    console.log(`  ${hk.padEnd(4)}  ${String(a.total).padEnd(6)}  ${String(wr).padEnd(6)}  ${churnPct.padEnd(6)}  ${skipPct.padEnd(6)}  ${String(hcwr).padEnd(7)}  ${a.maxConsecLosses}${flags}`);
  });

  // Regime breakdown for h5
  const h5 = acc['h5'];
  if (h5.total > 0) {
    console.log(`\n  Regime breakdown (h5):`);
    for (const [regime, v] of Object.entries(h5.regimes)) {
      const n = v.w+v.l;
      if (n===0) continue;
      const wr = (v.w/n*100).toFixed(1);
      const flag = parseFloat(wr)<48 && n>10 ? ' ⚠ FLAW' : '';
      console.log(`    ${regime.padEnd(10)} ${n.toString().padStart(4)} trades  WR ${wr}%${flag}`);
      if (flag) flaws.push(`h5/${regime}: WR ${wr}% — signal fails in ${regime} markets`);
    }
  }

  // Confidence calibration for h5
  if (h5.total > 0) {
    console.log(`\n  Confidence calibration (h5):`);
    for (const bkt of h5.confBuckets) {
      const n = bkt.w+bkt.l;
      if (n===0) continue;
      const wr = (bkt.w/n*100).toFixed(1);
      const label = `conf ${bkt.lo}-${bkt.hi}%`;
      const flag  = parseFloat(wr)<48 && n>5 ? ' ⚠' : '';
      console.log(`    ${label.padEnd(14)} ${n.toString().padStart(4)} trades  WR ${wr}%${flag}`);
    }
  }

  return flaws;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  WeCrypto — Signal Diagnostic Backtest (30d · flaw finder)  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const coins = FILTER_COIN
    ? PREDICTION_COINS.filter(c=>c.sym===FILTER_COIN)
    : PREDICTION_COINS;

  const allFlaws = {};

  for (const coin of coins) {
    process.stdout.write(`  Fetching ${coin.sym}...`);
    let bars;
    try {
      bars = await fetchRecent(coin);
      console.log(` ${bars.length} bars`);
    } catch(e) {
      console.log(` ERROR: ${e.message}`);
      continue;
    }
    if (bars.length < LIVE_WINDOW + WARMUP + 50) {
      console.log(`  ${coin.sym}: insufficient data (${bars.length}), skipping`);
      continue;
    }
    const result = await runDiag(coin, bars);
    const flaws  = renderReport(coin, result);
    if (flaws.length) allFlaws[coin.sym] = flaws;
  }

  // ── Summary of all flaws ────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  FLAW SUMMARY');
  console.log(`${'═'.repeat(70)}`);
  const flawCoins = Object.keys(allFlaws);
  if (flawCoins.length === 0) {
    console.log('  ✓ No major flaws detected in 30-day window.');
  } else {
    for (const sym of flawCoins) {
      console.log(`\n  ${sym}:`);
      allFlaws[sym].forEach(f => console.log(`    • ${f}`));
    }
  }

  // Save JSON
  const report = { generatedAt: new Date().toISOString(), days: DAYS_TO_FETCH, flaws: allFlaws };
  const outPath = path.join(__dirname, 'backtest-diag-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved → ${outPath}\n`);
}

main().catch(e=>{ console.error('\nFATAL:', e.message); process.exit(1); });
