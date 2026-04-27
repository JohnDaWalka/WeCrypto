#!/usr/bin/env node
// ================================================================
// WECRYPTO — All-Time Walk-Forward Backtest
// Fetches maximum available 5m candle history per coin from Binance.US.
//
// Data source: api.binance.us — paginated backward, 1000 bars/req
// Max available depth:
//   BTC/ETH/BNB/XRP : Sep 23 2019  (~2 400 days)
//   DOGE            : Jul  1 2021  (~1 750 days)
//   SOL             : Sep  1 2021  (~1 690 days)
//   HYPE            : Nov 14 2024  (~  155 days)
//
// Usage:  node backtest-alltime.js
//         node backtest-alltime.js --coin BTC
// ================================================================
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CLI args ─────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const getArg     = f => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };
const FILTER_COIN = getArg('--coin')?.toUpperCase() || null;
const LIVE_WINDOW = 300;

// Earliest available 5m candles — Coinbase for deep history, Binance.US for BNB/HYPE
const COIN_GENESIS_MS = {
  BTC:  new Date('2016-01-01').getTime(),   // Coinbase Pro 5m goes back to ~Jan 2016
  ETH:  new Date('2016-05-15').getTime(),   // Coinbase Pro ETH-USD launch
  SOL:  new Date('2021-06-17').getTime(),   // Coinbase SOL-USD launch
  XRP:  new Date('2019-02-25').getTime(),   // Coinbase XRP-USD launch
  DOGE: new Date('2021-06-01').getTime(),   // Coinbase DOGE-USD launch
  BNB:  new Date('2019-09-23').getTime(),   // Binance.US only
  HYPE: new Date('2024-11-14').getTime(),   // Binance.US only
};

// Coinbase product IDs (null = not listed, falls back to Binance.US)
const CB_PAIR = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
  XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: null, HYPE: null,
};

// ── Coins ────────────────────────────────────────────────────────
const PREDICTION_COINS = [
  { sym: 'BTC',  binSym: 'BTCUSDT',  color: '🟠' },
  { sym: 'ETH',  binSym: 'ETHUSDT',  color: '🔵' },
  { sym: 'SOL',  binSym: 'SOLUSDT',  color: '🟣' },
  { sym: 'XRP',  binSym: 'XRPUSDT',  color: '🔷' },
  { sym: 'DOGE', binSym: 'DOGEUSDT', color: '🟡' },
  { sym: 'BNB',  binSym: 'BNBUSDT',  color: '💛' },
  { sym: 'HYPE', binSym: 'HYPEUSDT', color: '🟢' },
];

// ── Exact config from predictions.js ─────────────────────────────
const SHORT_HORIZON_MINUTES = [1, 5, 10, 15];
const BACKTEST_FILTER_OVERRIDES = {
  BTC:  { h1:{et:0.10,ma:0.52}, h5:{et:0.14,ma:0.56}, h10:{et:0.18,ma:0.60}, h15:{et:0.24,ma:0.66} },
  ETH:  { h1:{et:0.10,ma:0.52}, h5:{et:0.14,ma:0.56}, h10:{et:0.18,ma:0.60}, h15:{et:0.24,ma:0.66} },
  SOL:  { h1:{et:0.12,ma:0.48}, h5:{et:0.16,ma:0.50}, h10:{et:0.20,ma:0.54}, h15:{et:0.26,ma:0.62} },
  XRP:  { h1:{et:0.08,ma:0.52}, h5:{et:0.12,ma:0.54}, h10:{et:0.16,ma:0.56}, h15:{et:0.22,ma:0.64} },
  DOGE: { h1:{et:0.22,ma:0.62}, h5:{et:0.26,ma:0.64}, h10:{et:0.28,ma:0.66}, h15:{et:0.30,ma:0.68} },
  BNB:  { h1:{et:0.08,ma:0.56}, h5:{et:0.12,ma:0.58}, h10:{et:0.16,ma:0.60}, h15:{et:0.22,ma:0.64} },
  HYPE: { h1:{et:0.40,ma:0.72}, h5:{et:0.38,ma:0.72}, h10:{et:0.35,ma:0.70}, h15:{et:0.32,ma:0.68} },
};
const DEFAULT_FILTERS = {
  h1:{et:0.08,ma:0.50}, h5:{et:0.12,ma:0.54}, h10:{et:0.16,ma:0.58}, h15:{et:0.20,ma:0.65}
};
const COMPOSITE_WEIGHTS = {
  rsi:0.08, ema:0.13, vwap:0.12, obv:0.13, volume:0.15,
  momentum:0.03, bands:0.12, persistence:0.10, structure:0.13,
  macd:0.10, stochrsi:0.05, adx:0.15, ichimoku:0.09,
  williamsR:0.17, mfi:0.10,
};
const TRAIN_WARMUP = 52;

// ── Utilities ────────────────────────────────────────────────────
const clamp   = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const average = arr => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0;
const hk      = h => `h${h}`;
const filterFor = (sym, hKey) => {
  const f = BACKTEST_FILTER_OVERRIDES[sym]?.[hKey] || DEFAULT_FILTERS[hKey];
  return { entryThreshold: f.et, minAgreement: f.ma };
};

// ── Indicator Functions (exact copies from predictions.js) ────────
function calcRSI(closes, period=14) {
  if (closes.length < period+1) return 50;
  let ag=0,al=0;
  for (let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=period;al/=period;
  for (let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?-d:0))/period;}
  return al===0?100:100-(100/(1+ag/al));
}
function calcEMA(data,period){
  const k=2/(period+1),ema=[data[0]];
  for(let i=1;i<data.length;i++)ema.push(data[i]*k+ema[i-1]*(1-k));
  return ema;
}
function calcVWAP(candles){
  let cv=0,ct=0;
  return candles.map(c=>{const tp=(c.h+c.l+c.c)/3,vol=c.v||1;cv+=vol;ct+=tp*vol;return cv>0?ct/cv:tp;});
}
function calcOBV(candles){
  const obv=[0];
  for(let i=1;i<candles.length;i++){const vol=candles[i].v||1;obv.push(obv[i-1]+(candles[i].c>candles[i-1].c?vol:candles[i].c<candles[i-1].c?-vol:0));}
  return obv;
}
function calcATR(candles,period=14){
  if(candles.length<period+1)return 0;
  let s=0;for(let i=candles.length-period;i<candles.length;i++)s+=Math.max(candles[i].h-candles[i].l,Math.abs(candles[i].h-candles[i-1].c),Math.abs(candles[i].l-candles[i-1].c));
  return s/period;
}
function calcMACD(closes,fast=12,slow=26,sig=9){
  if(closes.length<slow+sig)return{macd:0,signal:0,histogram:0};
  const ef=calcEMA(closes,fast),es=calcEMA(closes,slow);
  const ml=ef.map((v,i)=>v-es[i]),sl=calcEMA(ml,sig);
  const lm=ml[ml.length-1],ls=sl[sl.length-1];
  return{macd:lm,signal:ls,histogram:lm-ls};
}
function calcStochRSI(closes,rp=14,sp=14,sk=3,sd=3){
  const needed=rp+sp+Math.max(sk,sd)+2;
  if(closes.length<needed)return{k:50,d:50};
  const rv=[];
  for(let i=rp;i<closes.length;i++)rv.push(calcRSI(closes.slice(0,i+1),rp));
  const rk=[];
  for(let i=sp-1;i<rv.length;i++){const sl=rv.slice(i-sp+1,i+1),hi=Math.max(...sl),lo=Math.min(...sl);rk.push(hi!==lo?((rv[i]-lo)/(hi-lo))*100:50);}
  if(!rk.length)return{k:50,d:50};
  const smK=calcEMA(rk,sk),smD=calcEMA(smK,sd);
  return{k:smK[smK.length-1],d:smD[smD.length-1]};
}
function calcADX(candles,period=14){
  if(candles.length<period*2+1)return{adx:25,pdi:25,mdi:25};
  const trs=[],pDMs=[],mDMs=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1];trs.push(Math.max(c.h-c.l,Math.abs(c.h-p.c),Math.abs(c.l-p.c)));const u=c.h-p.h,dn=p.l-c.l;pDMs.push(u>dn&&u>0?u:0);mDMs.push(dn>u&&dn>0?dn:0);}
  const ws=(arr,p)=>{if(arr.length<p)return[arr.reduce((s,v)=>s+v,0)];let s=arr.slice(0,p).reduce((a,v)=>a+v,0);const o=[s];for(let i=p;i<arr.length;i++){s=s-s/p+arr[i];o.push(s);}return o;};
  const aS=ws(trs,period),pS=ws(pDMs,period),mS=ws(mDMs,period);
  const dx=aS.map((a,i)=>{const p=a>0?(pS[i]/a)*100:0,m=a>0?(mS[i]/a)*100:0,sum=p+m;return sum>0?Math.abs(p-m)/sum*100:0;});
  const adxA=ws(dx,period),li=adxA.length-1,lA=aS[li];
  return{adx:adxA[li],pdi:lA>0?(pS[li]/lA)*100:0,mdi:lA>0?(mS[li]/lA)*100:0};
}
function calcIchimoku(candles){
  if(candles.length<9)return{tenkan:0,kijun:0,cloudPos:'inside'};
  const hi=a=>Math.max(...a.map(c=>c.h)),lo=a=>Math.min(...a.map(c=>c.l));
  const tenkan=(hi(candles.slice(-9))+lo(candles.slice(-9)))/2;
  const s26=candles.length>=26?candles.slice(-26):candles,kijun=(hi(s26)+lo(s26))/2;
  const s52=candles.length>=52?candles.slice(-52):s26;
  const spanA=(tenkan+kijun)/2,spanB=(hi(s52)+lo(s52))/2;
  const price=candles[candles.length-1].c;
  const cTop=Math.max(spanA,spanB),cBot=Math.min(spanA,spanB);
  return{tenkan,kijun,cloudPos:price>cTop?'above':price<cBot?'below':'inside'};
}
function calcWilliamsR(candles,period=14){
  if(candles.length<period)return-50;
  const sl=candles.slice(-period),hh=Math.max(...sl.map(c=>c.h)),ll=Math.min(...sl.map(c=>c.l)),cl=candles[candles.length-1].c;
  return hh!==ll?((hh-cl)/(hh-ll))*-100:-50;
}
function calcMFI(candles,period=14){
  if(candles.length<period+1)return 50;
  const sl=candles.slice(-period-1);let pos=0,neg=0;
  for(let i=1;i<sl.length;i++){const pt=(sl[i-1].h+sl[i-1].l+sl[i-1].c)/3,ct=(sl[i].h+sl[i].l+sl[i].c)/3,rf=ct*(sl[i].v||1);if(ct>pt)pos+=rf;else if(ct<pt)neg+=rf;}
  return neg===0?(pos>0?100:50):100-100/(1+pos/neg);
}
function calcBollinger(closes,period=20){
  if(closes.length<period){const l=closes[closes.length-1]||0;return{position:0.5};}
  const sl=closes.slice(-period),mean=average(sl),std=Math.sqrt(sl.reduce((s,v)=>s+(v-mean)**2,0)/period);
  const upper=mean+std*2,lower=mean-std*2,width=Math.max(upper-lower,mean*0.0001);
  return{position:clamp((sl[sl.length-1]-lower)/width,0,1),widthPct:mean>0?(width/mean)*100:0};
}
function calcTrendPersistence(closes,emaSeries,lookback=8){
  const span=Math.min(lookback,closes.length,emaSeries.length);
  const rc=closes.slice(-span),re=emaSeries.slice(-span);
  const above=rc.filter((c,i)=>c>=re[i]).length,aboveRate=span?(above/span)*100:50;
  const es=re[0]||re[re.length-1]||1,slopePct=es?((re[re.length-1]-es)/es)*100:0;
  return{signal:clamp(((aboveRate-50)/30)+slopePct*4,-1,1)};
}
function calcStructureBias(candles,atrPct){
  if(!candles||candles.length<12)return{signal:0,zone:'none'};
  const recent=candles.slice(-24),latest=recent[recent.length-1].c;
  const support=Math.min(...recent.map(c=>c.l)),resistance=Math.max(...recent.map(c=>c.h));
  const sgp=latest>0?((latest-support)/latest)*100:0,rgp=latest>0?((resistance-latest)/latest)*100:0;
  const buf=clamp(Math.max((atrPct||0)*1.25,0.35),0.35,2.4);
  let zone='middle',signal=0;
  if(sgp<=buf&&sgp<=rgp){zone='support';signal=clamp((buf-sgp)/buf,0,1)*0.85;}
  else if(rgp<=buf&&rgp<sgp){zone='resistance';signal=-clamp((buf-rgp)/buf,0,1)*0.85;}
  return{signal,zone,supportGapPct:sgp,resistanceGapPct:rgp};
}
function slopeOBV(arr,n=5){
  if(arr.length<n+1)return 0;
  const r=arr.slice(-n),avg=(Math.abs(r[0])+Math.abs(r[r.length-1]))/2||1;
  return((r[r.length-1]-r[0])/avg)*100;
}
function summarizeAgreement(sv){
  const vals=Object.values(sv).filter(v=>Math.abs(v)>=0.08);
  if(!vals.length)return{agreement:0.5,conflict:0};
  const bulls=vals.filter(v=>v>0).length,bears=vals.filter(v=>v<0).length,active=bulls+bears;
  return{agreement:active?Math.max(bulls,bears)/active:0.5,conflict:active?Math.min(bulls,bears)/active:0,bulls,bears};
}
function scoreBucket(a){return a>=0.4?'strong':a>=0.25?'moderate':a>=0.1?'light':'neutral';}
function signalFromScore(s){const a=Math.abs(s);if(a<0.1)return'neutral';return s>0?(a>0.4?'strong_bull':'bullish'):(a>0.4?'strong_bear':'bearish');}

// ── Signal model (sliding LIVE_WINDOW — exact live-app behaviour) ─
function buildSignalModel(candles) {
  if (!candles || candles.length < 26) return null;
  const closes = candles.map(c => c.c);
  const lastPrice = closes[closes.length - 1];

  const rsi = calcRSI(closes);
  let rsiSig = rsi > 70 ? -0.6-((rsi-70)/30)*0.4 : rsi < 30 ? 0.6+((30-rsi)/30)*0.4 : (rsi-50)/50*0.3;

  const ema9 = calcEMA(closes,9), ema21 = calcEMA(closes,21);
  const emaCross = (ema9[ema9.length-1]-ema21[ema21.length-1])/(ema21[ema21.length-1]||1)*100;
  const emaSig = clamp(emaCross*5,-1,1);

  const vwapR = calcVWAP(candles.slice(-80));
  const vwapDev = ((lastPrice-(vwapR[vwapR.length-1]||lastPrice))/(vwapR[vwapR.length-1]||1))*100;
  let vwapSig = Math.abs(vwapDev)<0.3?0:vwapDev>1.5?-0.5:vwapDev<-1.5?0.5:vwapDev>0?0.3:-0.3;

  const obv = calcOBV(candles);
  const obvSig = clamp(slopeOBV(obv,8)/5,-1,1);

  const recent12 = candles.slice(-12);
  let buyV=0,sellV=0;
  recent12.forEach(c=>{const range=c.h-c.l||0.0001,bp=(c.c-c.l)/range,vol=c.v||1;buyV+=vol*bp;sellV+=vol*(1-bp);});
  const volSig = clamp((buyV/(sellV||1)-1)*0.5,-1,1);

  const mom = closes.length>6?((closes[closes.length-1]-closes[closes.length-7])/(closes[closes.length-7]||1))*100:0;
  const momSig = clamp(mom/2,-1,1);

  const atr = calcATR(candles), atrPct = lastPrice>0?(atr/lastPrice)*100:0;
  const bands = calcBollinger(closes);
  let bandSig = bands.position>=0.88?-clamp((bands.position-0.88)/0.12,0,1):bands.position<=0.12?clamp((0.12-bands.position)/0.12,0,1):clamp(-(bands.position-0.5)*0.45,-0.22,0.22);

  const persistence = calcTrendPersistence(closes,ema21);
  const structure   = calcStructureBias(candles,atrPct);

  const macdR = calcMACD(closes);
  const macdHistN = lastPrice>0?(macdR.histogram/lastPrice)*1000:0;
  const macdSig = clamp(macdHistN*2.5+(macdR.macd>macdR.signal?0.18:macdR.macd<macdR.signal?-0.18:0),-1,1);

  const stochR = calcStochRSI(closes);
  let stochSig = stochR.k>80?-0.6-((stochR.k-80)/20)*0.4:stochR.k<20?0.6+((20-stochR.k)/20)*0.4:(stochR.k-50)/50*0.35;
  stochSig = clamp(stochSig+clamp((stochR.k-stochR.d)/20,-0.18,0.18),-1,1);

  const adxR = calcADX(candles);
  const diDiff = (adxR.pdi-adxR.mdi)/Math.max(adxR.pdi+adxR.mdi,1);
  const adxSig = clamp(diDiff*clamp(adxR.adx/50,0,1)*1.2,-1,1);

  const ichi = calcIchimoku(candles);
  let ichiSig = ichi.cloudPos==='above'?0.5+(ichi.tenkan>ichi.kijun?0.2:0):ichi.cloudPos==='below'?-0.5-(ichi.tenkan<ichi.kijun?0.2:0):(ichi.tenkan>ichi.kijun?0.12:ichi.tenkan<ichi.kijun?-0.12:0);
  ichiSig = clamp(ichiSig,-1,1);

  const wR = calcWilliamsR(candles);
  let wRSig = wR>-20?-0.6-((wR+20)/20)*0.4:wR<-80?0.6+((-80-wR)/20)*0.4:(wR+50)/50*-0.3;
  wRSig = clamp(wRSig,-1,1);

  const mfi = calcMFI(candles);
  let mfiSig = mfi>80?-0.6-((mfi-80)/20)*0.4:mfi<20?0.6+((20-mfi)/20)*0.4:(mfi-50)/50*0.35;
  mfiSig = clamp(mfiSig,-1,1);

  // Trend Regime Modulation
  const isBull = emaCross>0.15&&adxR.pdi>adxR.mdi&&adxR.adx>22;
  const isBear = emaCross<-0.15&&adxR.mdi>adxR.pdi&&adxR.adx>22;
  if (isBull||isBear) {
    const sf = clamp((adxR.adx-22)/28,0,0.70);
    if(isBull){if(rsiSig<0)rsiSig*=(1-sf);if(stochSig<0)stochSig*=(1-sf);if(wRSig<0)wRSig*=(1-sf);if(bandSig<0)bandSig*=(1-sf*0.6);if(mfiSig<0)mfiSig*=(1-sf*0.6);}
    else      {if(rsiSig>0)rsiSig*=(1-sf);if(stochSig>0)stochSig*=(1-sf);if(wRSig>0)wRSig*=(1-sf);if(bandSig>0)bandSig*=(1-sf*0.6);if(mfiSig>0)mfiSig*=(1-sf*0.6);}
  }

  const sv={rsi:rsiSig,ema:emaSig,vwap:vwapSig,obv:obvSig,volume:volSig,momentum:momSig,bands:bandSig,persistence:persistence.signal,structure:structure.signal,macd:macdSig,stochrsi:stochSig,adx:adxSig,ichimoku:ichiSig,williamsR:wRSig,mfi:mfiSig};
  const keys=Object.keys(sv),tw=keys.reduce((s,k)=>s+(COMPOSITE_WEIGHTS[k]||0),0)||1;
  const composite=keys.reduce((s,k)=>s+sv[k]*(COMPOSITE_WEIGHTS[k]||0),0)/tw;
  const score=clamp(composite,-1,1),agr=summarizeAgreement(sv);

  return{score,signal:signalFromScore(score),absScore:Math.abs(score),agreement:agr.agreement,conflict:agr.conflict,coreScore:score,structureBias:structure.signal,structureZone:structure.zone,persistenceScore:persistence.signal,vwapDev,emaCross,rsi,mom,atrPct,signalVector:sv};
}

// ── Walk-Forward Backtest (O(n) via sliding window) ───────────────
function runBacktest(sym, candles) {
  const results = {};
  const BARMIN  = 5;

  SHORT_HORIZON_MINUTES.forEach(horizonMin => {
    const horizonBars = Math.max(1, Math.round(horizonMin / BARMIN));
    const filter = filterFor(sym, hk(horizonMin));
    const observations = [];
    const indAccum = {};
    const monthlyBuckets = {}; // 'YYYY-MM' → {wins,losses,scratches}

    for (let idx = TRAIN_WARMUP; idx < candles.length - horizonBars; idx++) {
      // === SLIDING WINDOW — only last LIVE_WINDOW candles (matches live app) ===
      const winStart = Math.max(0, idx - LIVE_WINDOW + 1);
      const windowCandles = candles.slice(winStart, idx + 1);

      const model = buildSignalModel(windowCandles);
      if (!model) continue;

      const entry      = candles[idx].c;
      const exit       = candles[idx + horizonBars].c;
      const returnPct  = entry > 0 ? ((exit - entry) / entry) * 100 : 0;

      const _directCore = model.coreScore ?? model.score ?? 0;
      const persistenceVeto = Math.sign(model.persistenceScore || 0) !== 0
        && Math.sign(model.persistenceScore || 0) !== Math.sign(_directCore)
        && Math.abs(model.persistenceScore || 0) >= 0.35
        && Math.abs(_directCore) < (filter.entryThreshold + 0.04);

      const isActive = model.absScore >= filter.entryThreshold
        && model.agreement >= filter.minAgreement
        && !(model.conflict >= 0.38 && model.agreement < filter.minAgreement + 0.08)
        && !(Math.abs(model.coreScore) < filter.entryThreshold * 0.92 && model.conflict >= 0.30)
        && !(model.structureZone === 'resistance' && model.coreScore > 0 && model.agreement < 0.65 && Math.abs(model.structureBias) >= 0.18)
        && !(model.structureZone === 'support'    && model.coreScore < 0 && model.agreement < 0.65 && Math.abs(model.structureBias) >= 0.18)
        && !persistenceVeto;

      const direction    = isActive ? (model.score > 0 ? 1 : -1) : 0;
      const signedReturn = direction === 0 ? 0 : returnPct * direction;

      const obs = {
        t: candles[idx].t, direction, score: model.score,
        absScore: model.absScore, agreement: model.agreement, conflict: model.conflict,
        signedReturn, returnPct, bucket: direction === 0 ? 'neutral' : scoreBucket(model.absScore),
        correct: direction !== 0 ? signedReturn > 0 : null, atrPct: model.atrPct,
        rsi: model.rsi, emaCross: model.emaCross, mom: model.mom,
      };
      observations.push(obs);

      // Monthly bucket
      if (direction !== 0) {
        const mo = new Date(obs.t).toISOString().slice(0,7);
        if (!monthlyBuckets[mo]) monthlyBuckets[mo] = { wins:0, losses:0, scratches:0, equity:100 };
        if (signedReturn > 0) monthlyBuckets[mo].wins++;
        else if (signedReturn < 0) monthlyBuckets[mo].losses++;
        else monthlyBuckets[mo].scratches++;
      }

      // Per-indicator accuracy
      if (direction !== 0 && model.signalVector) {
        const actualDir = returnPct > 0 ? 1 : -1;
        Object.entries(model.signalVector).forEach(([k,v]) => {
          if (!indAccum[k]) indAccum[k] = { agree:0, total:0 };
          if (Math.abs(v) >= 0.08) { indAccum[k].total++; if (Math.sign(v)===actualDir) indAccum[k].agree++; }
        });
      }
    }

    const active  = observations.filter(o => o.direction !== 0);
    const wins    = active.filter(o => o.signedReturn > 0).length;
    const losses  = active.filter(o => o.signedReturn < 0).length;
    const grossW  = active.filter(o=>o.signedReturn>0).reduce((s,o)=>s+o.signedReturn,0);
    const grossL  = Math.abs(active.filter(o=>o.signedReturn<0).reduce((s,o)=>s+o.signedReturn,0));
    const totalSR = active.reduce((s,o)=>s+o.signedReturn,0);

    let equity=100, peak=100, maxDD=0;
    active.forEach(o=>{equity*=(1+o.signedReturn/100);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/peak*100);});

    const bucketStats = ['strong','moderate','light'].reduce((acc,b)=>{
      const bt=active.filter(o=>o.bucket===b);
      acc[b]={count:bt.length,winRate:bt.length?bt.filter(o=>o.signedReturn>0).length/bt.length*100:null};
      return acc;
    },{});

    const sessionStats = {};
    active.forEach(o=>{
      const h=new Date(o.t).getUTCHours();
      const sess=h>=13&&h<18?'NY Open':h>=7&&h<12?'London':h>=0&&h<6?'Asia':'Off-Hours';
      if(!sessionStats[sess])sessionStats[sess]={wins:0,total:0};
      sessionStats[sess].total++;if(o.signedReturn>0)sessionStats[sess].wins++;
    });

    const indicatorAccuracy = Object.entries(indAccum)
      .map(([k,v])=>({indicator:k,accuracy:v.total?v.agree/v.total*100:null,samples:v.total}))
      .filter(x=>x.samples>=10)
      .sort((a,b)=>(b.accuracy||0)-(a.accuracy||0));

    // Monthly win-rate table (newest first)
    const monthly = Object.entries(monthlyBuckets)
      .sort((a,b)=>b[0].localeCompare(a[0]))
      .map(([mo, s])=>({month:mo, trades:s.wins+s.losses+s.scratches, wins:s.wins, losses:s.losses, winRate: (s.wins+s.losses)>0?s.wins/(s.wins+s.losses)*100:null}));

    results[hk(horizonMin)] = {
      horizonMin, horizonBars, filter,
      observations:observations.length, activeSignals:active.length,
      coverage: observations.length?(active.length/observations.length*100):0,
      winRate:  active.length?wins/active.length*100:0,
      wins, losses, scratches: active.length-wins-losses,
      avgSignedReturn: active.length?totalSR/active.length:0,
      profitFactor: grossL>0?grossW/grossL:grossW>0?grossW:0,
      equity:{final:equity,returnPct:equity-100,maxDrawdownPct:maxDD},
      buckets:bucketStats,
      sessions:Object.entries(sessionStats).map(([s,v])=>({session:s,total:v.total,winRate:v.total?v.wins/v.total*100:0})),
      indicatorAccuracy,
      monthly,
    };
  });

  return results;
}

// ── HTTP helper ───────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : require('http');
    const req = lib.get(url, { headers: {'User-Agent':'WECRYPTO-Backtest/P1.1'} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(httpGet(res.headers.location)); return; }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Paginated Coinbase Exchange fetch (primary — deepest history) ──
// Coinbase returns max 300 candles per request at granularity=300 (5m).
// Walks backwards from now to coin genesis.
async function fetchCoinbasePaginated(coin) {
  const pair = CB_PAIR[coin.sym];
  if (!pair) throw new Error(`No Coinbase pair for ${coin.sym}`);

  const startTs = COIN_GENESIS_MS[coin.sym];
  const BAR_MS  = 5 * 60 * 1000;
  const PAGE_MS = 300 * BAR_MS; // 300 candles × 5 min = 25 hours per request
  const allBars = [];
  let endMs   = Date.now();
  let retries = 0;
  let pages   = 0;

  while (endMs > startTs) {
    const pageStart = Math.max(startTs, endMs - PAGE_MS);
    const startIso  = new Date(pageStart).toISOString();
    const endIso    = new Date(endMs).toISOString();
    const url = `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=300&start=${startIso}&end=${endIso}`;

    let resp;
    try {
      resp = await httpGet(url);
    } catch(e) {
      if (++retries > 5) throw new Error(`Coinbase fetch failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * retries));
      continue;
    }
    retries = 0;

    if (resp.status === 429) { await new Promise(r => setTimeout(r, 4000)); continue; }
    if (resp.status !== 200) throw new Error(`Coinbase HTTP ${resp.status}: ${resp.body.slice(0,80)}`);

    const rows = JSON.parse(resp.body);
    if (!Array.isArray(rows) || rows.length === 0) { endMs = pageStart - 1; continue; }

    // Coinbase returns [time_sec, low, high, open, close, volume] — newest first
    const bars = rows.map(r => ({ t: +r[0]*1000, o: +r[3], h: +r[2], l: +r[1], c: +r[4], v: +r[5] }));
    allBars.push(...bars);

    endMs = pageStart - 1;
    pages++;
    if (pages % 50 === 0) process.stdout.write('.');
    await new Promise(r => setTimeout(r, 200));
  }

  const seen = new Set();
  return allBars
    .filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
    .sort((a, b) => a.t - b.t);
}

// ── Paginated Binance.US fetch (fallback / BNB / HYPE) ─────────────
async function fetchBinanceUSPaginated(coin) {
  const startTs = COIN_GENESIS_MS[coin.sym] || new Date('2019-09-23').getTime();
  const allBars = [];
  let endTs   = Date.now();
  let retries = 0;
  let pages   = 0;

  while (endTs > startTs) {
    const url = `https://api.binance.us/api/v3/klines?symbol=${coin.binSym}&interval=5m&limit=1000&endTime=${endTs}`;
    let resp;
    try {
      resp = await httpGet(url);
    } catch(e) {
      if (++retries > 5) throw new Error(`Binance.US fetch failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * retries));
      continue;
    }
    retries = 0;

    if (resp.status === 429 || resp.status === 418) { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (resp.status !== 200) throw new Error(`Binance.US HTTP ${resp.status}`);

    const rows = JSON.parse(resp.body);
    if (!Array.isArray(rows) || rows.length === 0) break;

    const bars = rows.map(r => ({ t:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5] }));
    allBars.unshift(...bars);

    const oldest = bars[0].t;
    endTs = oldest - 1;
    if (oldest <= startTs) break;

    pages++;
    if (pages % 20 === 0) process.stdout.write('.');
    await new Promise(r => setTimeout(r, 150));
  }

  const seen = new Set();
  return allBars
    .filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
    .sort((a, b) => a.t - b.t);
}

async function fetchCandles(coin) {
  const errs = [];

  // Coinbase first (deeper history for BTC/ETH/SOL/XRP/DOGE)
  if (CB_PAIR[coin.sym]) {
    process.stdout.write(' [CB]');
    try {
      const d = await fetchCoinbasePaginated(coin);
      if (d.length > 500) return d;
      errs.push(`CB: only ${d.length} bars`);
    } catch(e) { errs.push(`CB: ${e.message}`); }
  }

  // Binance.US fallback (BNB, HYPE, or if Coinbase failed)
  process.stdout.write(' [BinUS]');
  try {
    const d = await fetchBinanceUSPaginated(coin);
    if (d.length > 200) return d;
    errs.push(`BinUS: only ${d.length} bars`);
  } catch(e) { errs.push(`BinUS: ${e.message}`); }

  throw new Error(errs.join(' | '));
}

// ── Console helpers ───────────────────────────────────────────────
const bar = (pct, w=20) => '█'.repeat(Math.max(0,Math.round((pct/100)*w))) + '░'.repeat(Math.max(0,w-Math.round((pct/100)*w)));

function printReport(sym, bt, candleCount) {
  const div = '─'.repeat(76);
  const days = (candleCount*5/60/24).toFixed(1);
  console.log(`\n${div}`);
  console.log(` ${sym}  (${candleCount.toLocaleString()} candles · ${days} days · sliding ${LIVE_WINDOW}-bar window)`);
  console.log(div);

  SHORT_HORIZON_MINUTES.forEach(h => {
    const r = bt[hk(h)];
    if (!r || r.activeSignals < 5) { console.log(` h${h}m  insufficient signals`); return; }
    const wr = r.winRate.toFixed(1), wrN = parseFloat(wr);
    const icon = wrN >= 58 ? '✅' : wrN >= 50 ? '🟡' : '❌';
    const eq = (r.equity.returnPct>=0?'+':'')+r.equity.returnPct.toFixed(1);
    console.log(`\n ┌ h${h}m ${icon} WR: ${wr}% │ Signals: ${r.activeSignals.toLocaleString()}/${r.observations.toLocaleString()} (${r.coverage.toFixed(0)}%) │ Equity: ${eq}% │ MaxDD: ${r.equity.maxDrawdownPct.toFixed(1)}% │ PF: ${r.profitFactor.toFixed(2)}`);
    console.log(` │ ${bar(r.winRate)} Avg edge: ${r.avgSignedReturn.toFixed(3)}%  W:${r.wins} L:${r.losses}`);

    const bkts = Object.entries(r.buckets).filter(([,v])=>v.count>0);
    if (bkts.length) console.log(` │ Buckets: ${bkts.map(([b,v])=>`${b}:${v.count}@${(v.winRate??0).toFixed(0)}%`).join(' │ ')}`);

    if (r.sessions.length) {
      const ss = r.sessions.sort((a,b)=>b.total-a.total).map(s=>`${s.session}:${s.winRate.toFixed(0)}%/${s.total}`).join(' │ ');
      console.log(` │ Sessions: ${ss}`);
    }

    if (r.indicatorAccuracy.length) {
      const top = r.indicatorAccuracy.slice(0,3).map(x=>`${x.indicator}:${x.accuracy.toFixed(0)}%(${x.samples})`).join(', ');
      const bot = [...r.indicatorAccuracy].reverse().slice(0,3).map(x=>`${x.indicator}:${x.accuracy.toFixed(0)}%(${x.samples})`).join(', ');
      console.log(` │ Best  indicators: ${top}`);
      console.log(` │ Worst indicators: ${bot}`);
    }

    // Monthly breakdown — show ALL months (not just last 12)
    if (r.monthly?.length) {
      console.log(` │ Monthly win rates (all time, newest first):`);
      r.monthly.forEach(m => {
        const mr = m.winRate != null ? m.winRate.toFixed(1) : '—';
        const icon2 = m.winRate != null ? (m.winRate>=58?'✅':m.winRate>=50?'🟡':'❌') : '  ';
        console.log(`  │  ${m.month}  ${icon2} WR:${mr}%  trades:${m.trades} (W:${m.wins} L:${m.losses})`);
      });
    }
    console.log(` └${'─'.repeat(74)}`);
  });
}

function runDebugChecks(sym, candles, bt) {
  const issues = [];
  const winRates = SHORT_HORIZON_MINUTES.map(h=>bt[hk(h)]?.winRate).filter(Number.isFinite);
  if (winRates.every(w=>w>58)) issues.push(`⚠️  ALL horizons > 58% — double-check for look-ahead bias`);
  SHORT_HORIZON_MINUTES.forEach(h=>{
    const r=bt[hk(h)];
    if(r&&r.observations>50&&r.coverage<8)issues.push(`⚠️  h${h}m coverage=${r.coverage.toFixed(1)}% — filters too strict`);
    if(r&&r.activeSignals>=20&&r.winRate>55&&r.profitFactor<1)issues.push(`⚠️  h${h}m WR=${r.winRate.toFixed(1)}% but PF=${r.profitFactor.toFixed(2)} — small wins vs large losses`);
  });
  if (issues.length === 0) issues.push('✅  No anomalies detected');
  return issues;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const coins = FILTER_COIN ? PREDICTION_COINS.filter(c=>c.sym===FILTER_COIN) : PREDICTION_COINS;
  if (FILTER_COIN && !coins.length) { console.error(`Unknown coin: ${FILTER_COIN}`); process.exit(1); }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  WeCrypto — ALL-TIME Walk-Forward Backtest                              ║');
  console.log('║  Sources: Coinbase Exchange (primary) · Binance.US (BNB/HYPE/fallback) ║');
  console.log('║    BTC/ETH: Jan 2016 · XRP: Feb 2019 · SOL/DOGE: Jun 2021             ║');
  console.log(`║  Sliding ${LIVE_WINDOW}-candle window · exact live-app signal logic                ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');

  const allResults = {};

  for (const coin of coins) {
    const genesisStr = new Date(COIN_GENESIS_MS[coin.sym] || 0).toISOString().slice(0,10);
    process.stdout.write(`\n  Fetching ${coin.sym} (since ${genesisStr})...`);
    let candles;
    try {
      candles = await fetchCandles(coin);
      console.log(` ${candles.length.toLocaleString()} candles ✓  (${(candles.length*5/60/24).toFixed(1)} days)`);
    } catch(e) {
      console.log(`\n  FAILED → ${e.message}`);
      continue;
    }
    if (candles.length < 200) { console.log(`  Skipping — not enough data`); continue; }

    process.stdout.write(`  Backtesting ${coin.sym}...`);
    const startMs = Date.now();
    const results = runBacktest(coin.sym, candles);
    const issues  = runDebugChecks(coin.sym, candles, results);
    const elapsed = ((Date.now()-startMs)/1000).toFixed(1);
    console.log(` done (${elapsed}s)`);
    allResults[coin.sym] = { results, candleCount: candles.length, issues };

    printReport(coin.sym, results, candles.length);
    if (issues.length) {
      console.log('\n  Debug checks:');
      issues.forEach(i => console.log(`    ${i}`));
    }

    await new Promise(r => setTimeout(r, 400));
  }

  // ── Summary table ─────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(76));
  console.log(' ALL-TIME SUMMARY — Win Rates by Coin & Horizon');
  console.log('═'.repeat(76));
  console.log('  Coin   │  h1m   │  h5m   │  h10m  │  h15m  │  Signals  │ Best');
  console.log('─'.repeat(76));

  const global = { total:0, correct:0 };
  Object.entries(allResults).forEach(([sym, {results}]) => {
    const vals = SHORT_HORIZON_MINUTES.map(h=>results[hk(h)]?.winRate);
    const sigs = SHORT_HORIZON_MINUTES.reduce((s,h)=>s+(results[hk(h)]?.activeSignals||0),0);
    const best = SHORT_HORIZON_MINUTES.reduce((b,h)=>{const v=results[hk(h)]?.winRate??0;return v>(results[hk(b)]?.winRate??0)?h:b;},1);
    const fmt = v => v!=null?`${v.toFixed(1)}%`.padStart(6):'   —  ';
    console.log(`  ${sym.padEnd(5)}  │ ${fmt(vals[0])} │ ${fmt(vals[1])} │ ${fmt(vals[2])} │ ${fmt(vals[3])} │ ${String(sigs).padStart(9)} │ h${best}m`);
    SHORT_HORIZON_MINUTES.forEach(h=>{const r=results[hk(h)];if(r&&r.activeSignals>=5){global.total+=r.activeSignals;global.correct+=r.wins;}});
  });

  console.log('─'.repeat(76));
  const overall = global.total>0?(global.correct/global.total*100).toFixed(1):'—';
  console.log(`  Overall accuracy: ${overall}%  (${global.correct.toLocaleString()}/${global.total.toLocaleString()} active signals across all coins & horizons)`);

  // ── Save report ───────────────────────────────────────────────
  const outPath = path.join(__dirname, 'backtest-alltime-report.json');
  try {
    fs.writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      note: 'All-time backtest from coin genesis dates on Binance global',
      liveWindow: LIVE_WINDOW, coins: allResults,
    }, null, 2));
    console.log(`\n  Report saved → ${outPath}`);
  } catch(e) {
    console.warn(`  Could not save: ${e.message}`);
  }
  console.log('\n');
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
