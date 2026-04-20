// floating-orchestrator.js v2.0 — EV Engine
// Model-primary. Kalshi = house odds. Edge = modelProbUp vs kalshiYesPrice.
// Divergence = OPPORTUNITY. Entry price = context + risk flags, never a gate.
// Near-close trades: minimum gate is 5 seconds.

(function () {
  'use strict';

  const MODEL_THRESHOLD  = 0.12;
  const MIN_SECONDS_LEFT = 5;
  const EDGE_MIN_CENTS   = 8;
  const INVERSION_THRESH = 30;
  const THIN_BOOK_THRESH = 0.05;
  const TAIL_RISK_THRESH = 0.80;
  const LAST_CALL_MS     = 60000;
  const MAX_KELLY        = 0.25;

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
    };
    if (entry) Object.assign(result, entry);
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
    update: function(predAll) {
      _cache = resolveAll(predAll);
      return _cache;
    },
  };
  console.log('[KalshiOrchestrator] v2.0 loaded — EV engine | gate=5s | ms-precision clock');
})();