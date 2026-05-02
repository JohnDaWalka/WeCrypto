// floating-orchestrator.js v2.0 — EV Engine
// Model-primary. Kalshi = house odds. Edge = modelProbUp vs kalshiYesPrice.
// Divergence = OPPORTUNITY. Entry price = context + risk flags, never a gate.
// Near-close trades: minimum gate is 5 seconds.
// 
// RETUNED 2026-05-02: Coin weights adjusted toward high-shell-activation assets (DOGE, ETH, HYPE).
// Reduces BTC concentration (55%→35%), increases DOGE (1%→10%), ETH steady, adds BNB diversification.

(function () {
  'use strict';

  // Allocation weights (normalized; divide by sum for probability)
  // Physics-aligned to shell activation rates from ionization model
  const COIN_WEIGHTS = {
    BTC:  0.65,   // 55% → 35%  (reduce: 16% shell3 activation)
    ETH:  1.05,   // 27% → 30%  (steady: 45% shell3 activation)
    SOL:  0.45,   // 13% → 8%   (reduce: 0% shell3 activation)
    XRP:  0.70,   // 3% → 2%    (maintain: 0% shell3 activation)
    HYPE: 7.50,   // 1% → 8%    (increase: 41% shell3 activation)
    DOGE: 12.0,   // 1% → 10%   (increase: 52% shell3 activation)
    BNB:  9.99    // 0% → 10%   (new: 18% shell3 activation)
  };
  
  // Compute normalized weights for probability allocation
  const _weightSum = Object.values(COIN_WEIGHTS).reduce((a, b) => a + b, 0);
  const COIN_ALLOCATION = {};
  for (const [coin, weight] of Object.entries(COIN_WEIGHTS)) {
    COIN_ALLOCATION[coin] = weight / _weightSum;
  }

  const MODEL_THRESHOLD  = 0.12;
  const MIN_SECONDS_LEFT = 5;
  const EDGE_MIN_CENTS   = 8;
  const INVERSION_THRESH = 30;
  const THIN_BOOK_THRESH = 0.05;
  const TAIL_RISK_THRESH = 0.80;
  const LAST_CALL_MS     = 60000;
  const MAX_KELLY        = 0.25;

  // Signal stability — prevents flipping in final minutes
  const LOCK_MS          = 45000;   // hold a trade signal for 45s on same contract
  const CROWD_FADE_PCT   = 0.80;    // fade crowd when >=80% on one side (last 90s)
  const CROWD_FADE_SECS  = 90;      // only apply crowd fade in last 90s

  // Sweet spot entry window — best payout + not too close to close
  const SWEET_MIN_SECS   = 180;     // 3 min left
  const SWEET_MAX_SECS   = 360;     // 6 min left
  const SWEET_PAYOUT_MIN = 1.65;    // payout >= 1.65x (entry price <= ~0.61)

  // _locks[sym+closeTimeMs] = { direction, side, ts, closeTimeMs }
  var _locks = {};

  function crowdFadeDir(kalshiYesPrice, secsLeft) {
    if (secsLeft == null || secsLeft > CROWD_FADE_SECS) return null;
    if (kalshiYesPrice >= CROWD_FADE_PCT)        return 'DOWN'; // fade heavy YES
    if (kalshiYesPrice <= (1 - CROWD_FADE_PCT))  return 'UP';  // fade heavy NO
    return null;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function scoreToProbUp(score) {
    return clamp(0.5 + score * 0.40, 0.02, 0.98);
  }

  function computeEV(side, modelProbUp, kalshiYesPrice) {
    return side === 'YES' ? modelProbUp - kalshiYesPrice
                         : kalshiYesPrice - modelProbUp;
  }

  function analyseEntry(side, modelProbUp, kalshiYesPrice) {
    var entryPrice = side === 'YES' ? kalshiYesPrice : (1 - kalshiYesPrice);
    var winProb    = side === 'YES' ? modelProbUp    : (1 - modelProbUp);
    var evRaw      = computeEV(side, modelProbUp, kalshiYesPrice);
    var edgeCents  = Math.round(evRaw * 100);
    var payoutMult = entryPrice > 0 ? parseFloat((1 / entryPrice).toFixed(2)) : null;
    var breakEven  = parseFloat(entryPrice.toFixed(4));
    var netPayout  = 1 - entryPrice;
    var kellyFrac  = 0;
    if (evRaw > 0 && winProb > 0 && netPayout > 0)
      kellyFrac = clamp(evRaw / (winProb * netPayout), 0, MAX_KELLY);
    return {
      entryPrice  : parseFloat(entryPrice.toFixed(4)),
      evRaw, edgeCents, payoutMult, breakEven,
      kellyFrac   : parseFloat(kellyFrac.toFixed(4)),
      kellyPct    : Math.round(kellyFrac * 100),
      isInversion : Math.abs(edgeCents) >= INVERSION_THRESH,
      thinBook    : entryPrice <= THIN_BOOK_THRESH,
      tailRisk    : entryPrice >= TAIL_RISK_THRESH,
      lossErasesWins: (entryPrice >= TAIL_RISK_THRESH && netPayout > 0)
        ? Math.round(entryPrice / netPayout) : null,
    };
  }

  function translate(sym, pred) {
    var pm  = window.PredictionMarkets && window.PredictionMarkets.getCoin && window.PredictionMarkets.getCoin(sym);
    var k15 = (pm && pm.kalshi15m) || null;
    var modelScore   = (pred && pred.score) || 0;
    var modelActive  = Math.abs(modelScore) >= MODEL_THRESHOLD;
    var modelProbUp  = scoreToProbUp(modelScore);
    var modelBullish = modelScore > 0;
    var kalshiYesPrice = k15 ? k15.probability : null;
    var kalshiActive   = kalshiYesPrice !== null && kalshiYesPrice !== undefined;
    var kalshiBullish  = kalshiActive && kalshiYesPrice >= 0.55;
    var kalshiBearish  = kalshiActive && kalshiYesPrice <= 0.45;
    var kalshiNeutral  = kalshiActive && !kalshiBullish && !kalshiBearish;
    var closeTimeMs = k15 && k15.closeTime ? new Date(k15.closeTime).getTime() : null;
    var msLeft      = closeTimeMs != null ? Math.max(0, closeTimeMs - Date.now()) : null;
    var secsLeft    = msLeft != null ? msLeft / 1000 : null;
    var minsLeft    = msLeft != null ? msLeft / 60000 : null;
    var tooLate     = msLeft != null && msLeft < MIN_SECONDS_LEFT * 1000;
    var tooEarly    = minsLeft != null && minsLeft > 14.5;
    var lastCall    = msLeft != null && msLeft <= LAST_CALL_MS;
    var vetoSt = window.ShellRouter && window.ShellRouter.getVetoState && window.ShellRouter.getVetoState(sym);
    if (vetoSt && vetoSt.phase === 'evaluating') {
      return { sym: sym, action: 'hold', side: null, direction: null, alignment: 'SHELL_EVAL',
        confidence: 0, msLeft: msLeft ? Math.round(msLeft) : null, secsLeft: secsLeft ? parseFloat(secsLeft.toFixed(1)) : null,
        minsLeft: minsLeft, lastCall: lastCall, closeTimeMs: closeTimeMs, closeTime: k15 ? k15.closeTime : null,
        contractTicker: k15 ? k15.ticker : null,
        reason: 'Shell wall evaluating (' + (vetoSt.evalTick || '?') + '/3) — data collection' };
    }
    if (vetoSt && vetoSt.phase === 'confirmed')
      return _earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall, 'Shell wall confirmed — stand aside');
    var earlyExit = pred && pred.diagnostics && pred.diagnostics.earlyExit;
    if (!kalshiActive && !modelActive)
      return _skip(sym, 'No signal — score ' + modelScore.toFixed(3) + ', no Kalshi data');
    if (tooLate)
      return _skip(sym, 'Settlement < ' + MIN_SECONDS_LEFT + 's — too late to fill');
    if (earlyExit)
      return _earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall);
    var direction, alignment;
    if (kalshiActive && modelActive) {
      var sameDir = (modelBullish && kalshiBullish) || (!modelBullish && kalshiBearish);
      if (sameDir)        { direction = modelBullish ? 'UP' : 'DOWN'; alignment = 'ALIGNED';     }
      else if (kalshiNeutral) { direction = modelBullish ? 'UP' : 'DOWN'; alignment = 'MODEL_LEADS'; }
      else                { direction = modelBullish ? 'UP' : 'DOWN'; alignment = 'DIVERGENT';   }
    } else if (modelActive) {
      direction = modelBullish ? 'UP' : 'DOWN'; alignment = 'MODEL_ONLY';
    } else {
      if (kalshiNeutral)
        return _skip(sym, 'Kalshi ~50/50, model below threshold (' + modelScore.toFixed(3) + ')');
      direction = kalshiBullish ? 'UP' : 'DOWN'; alignment = 'KALSHI_ONLY';
    }
    var side  = direction === 'UP' ? 'YES' : 'NO';
    var entry = kalshiYesPrice !== null ? analyseEntry(side, modelProbUp, kalshiYesPrice) : null;
    var mStr  = clamp(Math.abs(modelScore), 0, 1);
    var eBoost = entry ? clamp(Math.abs(entry.edgeCents) / 60, 0, 0.25) : 0;
    var confidence = Math.round(clamp((mStr + eBoost) * 75, 0, 99));
    var action;
    if (alignment === 'KALSHI_ONLY') action = 'watch';
    else if (!entry || entry.edgeCents < EDGE_MIN_CENTS) action = (entry && entry.edgeCents < 0) ? 'skip' : 'watch';
    else action = modelActive ? 'trade' : 'watch';
    if (action === 'skip')
      return _skip(sym, 'Negative EV — edge ' + (entry ? entry.edgeCents : 0) + 'c (need >=' + EDGE_MIN_CENTS + 'c)');

    // Tier 1: Sweet spot window (3–6 min left, payout >= 1.65x)
    var payout = entry ? entry.payoutMult : null;
    var sweetSpot = secsLeft != null && secsLeft >= SWEET_MIN_SECS && secsLeft <= SWEET_MAX_SECS
                    && payout != null && payout >= SWEET_PAYOUT_MIN
                    && action === 'trade';
    var kPct    = kalshiYesPrice != null ? 'Kalshi ' + Math.round(kalshiYesPrice * 100) + '% YES' : '';
    var mPct    = 'model ' + Math.round(modelProbUp * 100) + '% UP';
    var edgeStr = entry ? ((entry.edgeCents >= 0 ? '+' : '') + entry.edgeCents + 'c/contract') : '';
    var reasonMap = {
      ALIGNED:     sym + ' ' + direction + ': ' + kPct + ' + ' + mPct + ' -> ' + edgeStr,
      DIVERGENT:   sym + ': ' + mPct + ' vs ' + kPct + ' -> INVERSION — buy ' + side + ' cheap, house is wrong — ' + edgeStr,
      MODEL_LEADS: sym + ' ' + direction + ': ' + mPct + ' (Kalshi ~50/50, model ahead) -> ' + edgeStr,
      MODEL_ONLY:  sym + ' ' + direction + ': ' + mPct + ' (no Kalshi data)',
      KALSHI_ONLY: sym + ' ' + direction + ': ' + kPct + ' (model score ' + modelScore.toFixed(3) + ' below threshold)',
    };
    var strikeStr = null;
    if (k15 && k15.ticker) {
      var tm = k15.ticker.match(/T(\d+(?:\.\d+)?)$/);
      if (tm) strikeStr = 'T' + Number(tm[1]).toLocaleString();
    }
    var result = {
      sym: sym, contractTicker: k15 ? k15.ticker : null, strikeStr: strikeStr,
      side: side, direction: direction, alignment: alignment, action: action, confidence: confidence,
      modelScore: modelScore, modelProbUp: parseFloat(modelProbUp.toFixed(4)),
      kalshiYesPrice: kalshiYesPrice, kalshiActive: kalshiActive,
      closeTimeMs: closeTimeMs,
      msLeft:   msLeft != null ? Math.round(msLeft) : null,
      secsLeft: secsLeft != null ? parseFloat(secsLeft.toFixed(1)) : null,
      minsLeft: minsLeft != null ? parseFloat(minsLeft.toFixed(3)) : null,
      minutesLeft: minsLeft,
      lastCall: lastCall, tooEarly: tooEarly,
      targetPrice: k15 ? k15.targetPrice : null, targetPriceNum: k15 ? k15.targetPriceNum : null,
      liquidity: k15 ? k15.liquidity : 0, closeTime: k15 ? k15.closeTime : null,
      humanReason: reasonMap[alignment] || (sym + ' ' + direction),
      sweetSpot: sweetSpot,
    };
    if (entry) Object.assign(result, entry);

    // --- Signal lock + crowd fade ---
    var lockKey  = sym + '_' + (closeTimeMs || 'none');
    var lock     = _locks[lockKey];
    var fadeDir  = crowdFadeDir(kalshiYesPrice, secsLeft);

    if (fadeDir) {
      // Last 90s + extreme crowd → fade, override everything
      result.direction  = fadeDir;
      result.side       = fadeDir === 'UP' ? 'YES' : 'NO';
      result.action     = 'trade';
      result.alignment  = 'CROWD_FADE';
      result.crowdFade  = true;
      result.humanReason = sym + ' CROWD FADE → ' + fadeDir + ': Kalshi ' + Math.round(kalshiYesPrice * 100) + '% YES extreme — fading crowd in final ' + Math.round(secsLeft) + 's';
      _locks[lockKey]   = { direction: fadeDir, side: result.side, ts: Date.now(), closeTimeMs: closeTimeMs };
    } else if (result.action === 'trade') {
      // New trade signal — lock it
      _locks[lockKey] = { direction: result.direction, side: result.side, ts: Date.now(), closeTimeMs: closeTimeMs };
    } else if (lock && lock.closeTimeMs === closeTimeMs && (Date.now() - lock.ts) < LOCK_MS) {
      // Signal drifted off trade but lock is still fresh — hold it
      result.direction   = lock.direction;
      result.side        = lock.side;
      result.action      = 'trade';
      result.signalLocked = true;
      result.humanReason  = sym + ' [LOCKED ' + Math.round((Date.now() - lock.ts) / 1000) + 's ago] ' + lock.direction;
    }

    return result;
  }

  function _skip(sym, reason) {
    return { sym: sym, action: 'skip', side: null, direction: null, reason: reason, alignment: null, confidence: 0 };
  }
  function _earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall, reason) {
    return { sym: sym, action: 'earlyExit', side: null, direction: null,
      alignment: 'EARLY_EXIT', confidence: 0,
      reason: reason || 'CFM Router early-exit signal',
      contractTicker: k15 ? k15.ticker : null,
      closeTimeMs: k15 && k15.closeTime ? new Date(k15.closeTime).getTime() : null,
      closeTime: k15 ? k15.closeTime : null,
      msLeft: msLeft != null ? Math.round(msLeft) : null,
      secsLeft: secsLeft != null ? parseFloat(secsLeft.toFixed(1)) : null,
      minsLeft: minsLeft, lastCall: lastCall };
  }

  function resolveAll(predAll) {
    var COINS = ['BTC','ETH','SOL','XRP','DOGE','BNB','HYPE'];
    var intents = {};
    COINS.forEach(function(sym) {
      try { intents[sym] = translate(sym, predAll && predAll[sym]); }
      catch(e) { intents[sym] = _skip(sym, 'Error: ' + e.message); }
    });
    return intents;
  }

  var _cache = {};
  window.KalshiOrchestrator = {
    translate: translate,
    resolveAll: resolveAll,
    scoreToProbUp: scoreToProbUp,
    analyseEntry: analyseEntry,
    getIntent:    function(sym) { return _cache[sym] || null; },
    getAllIntents: function()    { return _cache; },
    update: function(predAll, cfmAll) {
      // cfmAll reserved for future enhancements (e.g., liquidity-weighted entry pricing)
      _cache = resolveAll(predAll);
      return _cache;
    },
  };
  console.log('[KalshiOrchestrator] v2.0 loaded — EV engine | gate=5s | ms-precision clock');
})();