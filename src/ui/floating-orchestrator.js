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

  const MODEL_THRESHOLD  = 0.06;
  const MIN_SECONDS_LEFT = 5;
  const EDGE_MIN_CENTS   = 8;
  const INVERSION_THRESH = 30;
  const THIN_BOOK_THRESH = 0.05;
  const TAIL_RISK_THRESH = 0.80;
  const LAST_CALL_MS     = 60000;
  const MAX_KELLY        = 0.25;
  const ENABLE_CROWD_FADE_OVERRIDE = true;

  // Signal stability — prevents flipping in final minutes
  const LOCK_MS          = 45000;   // hold a trade signal for 45s on same contract
  const CROWD_FADE_NEUTRAL_BAND = 0.03; // treat 47/53 as neutral to avoid noisy fades
  const CROWD_FADE_MIN_SECS = 180;  // only fade in the 3m–7m window
  const CROWD_FADE_MAX_SECS = 420;
  const CROWD_FADE_CONFIRM_MIN_MS = 15000; // dynamic confirm at 3m left
  const CROWD_FADE_CONFIRM_MAX_MS = 35000; // dynamic confirm at 7m left
  const CROWD_FADE_MIN_EDGE_CENTS = 14; // stronger edge required than normal trade
  const CROWD_FADE_MIN_MISPRICE = 0.16; // dynamic floor starts at 16pp
  const CROWD_FADE_MAX_MISPRICE = 0.22; // and rises to 22pp when earlier
  const CROWD_FADE_MIN_MODEL_CONF = 0.12; // require model to be at least 62/38
  const CROWD_FADE_MIN_LIQUIDITY = 1500; // gate out very thin markets
  const STATE_PRUNE_MS = 120000;

  // Sweet spot entry window — best payout + not too close to close
  const SWEET_MIN_SECS   = 180;     // 3 min left
  const SWEET_MAX_SECS   = 360;     // 6 min left
  const SWEET_PAYOUT_MIN = 1.65;    // payout >= 1.65x (entry price <= ~0.61)

  // _locks[sym+closeTimeMs] = { direction, side, ts, closeTimeMs }
  var _locks = {};
  // _fadeCandidates[sym+closeTimeMs] = { direction, side, firstTs, lastTs }
  var _fadeCandidates = {};

  function crowdFadeDir(kalshiYesPrice, secsLeft, dirs, modelDir) {
    if (!Number.isFinite(kalshiYesPrice)) return null;
    if (!Number.isFinite(secsLeft) || secsLeft <= 0) return null;
    if (secsLeft < CROWD_FADE_MIN_SECS || secsLeft > CROWD_FADE_MAX_SECS) return null;
    if (!dirs || !modelDir) return null;

    // Crowd-fade is blockchain-led: follow model direction only when crowd pricing disagrees.
    var kalshiDir = null;
    if (kalshiYesPrice >= (0.5 + CROWD_FADE_NEUTRAL_BAND)) kalshiDir = dirs.yesDir;
    else if (kalshiYesPrice <= (0.5 - CROWD_FADE_NEUTRAL_BAND)) kalshiDir = dirs.noDir;
    if (!kalshiDir || kalshiDir === modelDir) return null;
    return modelDir;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function crowdFadeConfirmMs(secsLeft) {
    if (!Number.isFinite(secsLeft)) return CROWD_FADE_CONFIRM_MAX_MS;
    var span = Math.max(1, CROWD_FADE_MAX_SECS - CROWD_FADE_MIN_SECS);
    var t = clamp((secsLeft - CROWD_FADE_MIN_SECS) / span, 0, 1);
    return Math.round(CROWD_FADE_CONFIRM_MIN_MS + t * (CROWD_FADE_CONFIRM_MAX_MS - CROWD_FADE_CONFIRM_MIN_MS));
  }

  function crowdFadeMinMisprice(secsLeft) {
    if (!Number.isFinite(secsLeft)) return CROWD_FADE_MAX_MISPRICE;
    var span = Math.max(1, CROWD_FADE_MAX_SECS - CROWD_FADE_MIN_SECS);
    var t = clamp((secsLeft - CROWD_FADE_MIN_SECS) / span, 0, 1);
    return CROWD_FADE_MIN_MISPRICE + t * (CROWD_FADE_MAX_MISPRICE - CROWD_FADE_MIN_MISPRICE);
  }

  function pruneContractState(nowMs) {
    Object.keys(_locks).forEach(function(key) {
      var v = _locks[key];
      if (!v) { delete _locks[key]; return; }
      var expiredByClose = Number.isFinite(v.closeTimeMs) && nowMs > (v.closeTimeMs + 60000);
      var expiredByAge = Number.isFinite(v.ts) ? (nowMs - v.ts > LOCK_MS * 4) : true;
      if (expiredByClose || expiredByAge) delete _locks[key];
    });
    Object.keys(_fadeCandidates).forEach(function(key) {
      var v = _fadeCandidates[key];
      if (!v) { delete _fadeCandidates[key]; return; }
      if (!Number.isFinite(v.lastTs) || (nowMs - v.lastTs) > STATE_PRUNE_MS) delete _fadeCandidates[key];
    });
  }

  function scoreToProbUp(score) {
    return clamp(0.5 + score * 0.40, 0.02, 0.98);
  }

  function yesNoFromStrikeDir(strikeDir) {
    var yesDir = strikeDir === 'below' ? 'DOWN' : 'UP';
    return { yesDir: yesDir, noDir: yesDir === 'UP' ? 'DOWN' : 'UP' };
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

  function evaluateCrowdFade(params) {
    var sym            = params.sym;
    var closeTimeMs    = params.closeTimeMs;
    var kalshiYesPrice = params.kalshiYesPrice;
    var secsLeft       = params.secsLeft;
    var dirs           = params.dirs;
    var modelDir       = params.modelDir;
    var modelYesProb   = params.modelYesProb;
    var modelActive    = params.modelActive;
    var entryYes       = params.entryYes;
    var entryNo        = params.entryNo;
    var liquidity      = params.liquidity;

    var key = sym + '_' + (closeTimeMs || 'none');
    function clearCandidate() { delete _fadeCandidates[key]; }

    var fadeDir = crowdFadeDir(kalshiYesPrice, secsLeft, dirs, modelDir);
    if (!fadeDir || !modelActive || !Number.isFinite(modelYesProb)) {
      clearCandidate();
      return null;
    }

    var fadeSide = fadeDir === dirs.yesDir ? 'YES' : 'NO';
    var fadeEntry = fadeSide === 'YES' ? entryYes : entryNo;
    if (!fadeEntry) {
      clearCandidate();
      return null;
    }

    var mispricing = Math.abs(modelYesProb - kalshiYesPrice);
    var minMispricing = crowdFadeMinMisprice(secsLeft);
    var confirmMs = crowdFadeConfirmMs(secsLeft);
    var modelConfidence = Math.abs(modelYesProb - 0.5);
    var edgeOk = Number.isFinite(fadeEntry.edgeCents) && fadeEntry.edgeCents >= CROWD_FADE_MIN_EDGE_CENTS;
    var modelConfOk = modelConfidence >= CROWD_FADE_MIN_MODEL_CONF;
    var liquidityOk = !Number.isFinite(liquidity) || liquidity <= 0 || liquidity >= CROWD_FADE_MIN_LIQUIDITY;
    var qualified = modelConfOk && edgeOk && liquidityOk && mispricing >= minMispricing;
    if (!qualified) {
      clearCandidate();
      return null;
    }

    var now = Date.now();
    var prev = _fadeCandidates[key];
    if (prev && prev.direction === fadeDir && prev.side === fadeSide) {
      prev.lastTs = now;
      var ageMs = now - prev.firstTs;
      return {
        suggested: true,
        confirmed: ageMs >= confirmMs,
        direction: fadeDir,
        side: fadeSide,
        entry: fadeEntry,
        ageMs: ageMs,
        confirmMs: confirmMs,
        mispricing: mispricing,
        minMispricing: minMispricing,
      };
    }

    _fadeCandidates[key] = { direction: fadeDir, side: fadeSide, firstTs: now, lastTs: now };
    return {
      suggested: true,
      confirmed: false,
      direction: fadeDir,
      side: fadeSide,
      entry: fadeEntry,
      ageMs: 0,
      confirmMs: confirmMs,
      mispricing: mispricing,
      minMispricing: minMispricing,
    };
  }

  function translate(sym, pred) {
    var pm  = window.PredictionMarkets && window.PredictionMarkets.getCoin && window.PredictionMarkets.getCoin(sym);
    var k15 = (pm && pm.kalshi15m) || null;
    var kAlign = pred && pred.projections && pred.projections.p15 && pred.projections.p15.kalshiAlign ? pred.projections.p15.kalshiAlign : null;
    var strikeDirRaw = (kAlign && kAlign.strikeDir) || (k15 && k15.strikeDir) || 'above';
    var strikeDir = strikeDirRaw === 'below' ? 'below' : 'above';
    var dirs = yesNoFromStrikeDir(strikeDir);
    var modelScore   = (pred && pred.score) || 0;
    var modelProbUpRaw = scoreToProbUp(modelScore);
    var modelYesProb = null;
    if (kAlign && Number.isFinite(kAlign.modelYesPct)) {
      modelYesProb = clamp(kAlign.modelYesPct / 100, 0.02, 0.98);
    } else {
      modelYesProb = strikeDir === 'below' ? (1 - modelProbUpRaw) : modelProbUpRaw;
    }
    var modelProbUp = strikeDir === 'below' ? (1 - modelYesProb) : modelYesProb;
    var modelActive = Number.isFinite(kAlign && kAlign.modelYesPct)
      ? Math.abs((kAlign.modelYesPct / 100) - 0.5) >= 0.08
      : Math.abs(modelScore) >= MODEL_THRESHOLD;
    var modelDir = modelYesProb >= 0.5 ? dirs.yesDir : dirs.noDir;
    var modelBullish = modelDir === 'UP';
    var kalshiYesPrice = k15 ? k15.probability : null;
    var kalshiActive   = kalshiYesPrice !== null && kalshiYesPrice !== undefined;
    var kalshiDirHint  = !kalshiActive ? null
                      : kalshiYesPrice >= 0.55 ? dirs.yesDir
                      : kalshiYesPrice <= 0.45 ? dirs.noDir
                      : null;
    var kalshiBullish  = kalshiDirHint === 'UP';
    var kalshiBearish  = kalshiDirHint === 'DOWN';
    var kalshiNeutral  = kalshiDirHint === null;
    var closeTimeMs = k15 && k15.closeTime ? new Date(k15.closeTime).getTime() : null;
    var msLeft      = closeTimeMs != null ? Math.max(0, closeTimeMs - Date.now()) : null;
    var secsLeft    = msLeft != null ? msLeft / 1000 : null;
    var minsLeft    = msLeft != null ? msLeft / 60000 : null;
    pruneContractState(Date.now());
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
      if (sameDir)        { direction = modelDir; alignment = 'ALIGNED';     }
      else if (kalshiNeutral) { direction = modelDir; alignment = 'MODEL_LEADS'; }
      else                { direction = modelDir; alignment = 'DIVERGENT';   }
    } else if (modelActive) {
      direction = modelDir; alignment = 'MODEL_ONLY';
    } else {
      if (kalshiNeutral)
        return _skip(sym, 'Kalshi ~50/50, model below threshold (' + modelScore.toFixed(3) + ')');
      direction = kalshiYesPrice >= 0.5 ? dirs.yesDir : dirs.noDir;
      alignment = 'KALSHI_ONLY';
    }
    var entryYes = kalshiYesPrice !== null ? analyseEntry('YES', modelYesProb, kalshiYesPrice) : null;
    var entryNo  = kalshiYesPrice !== null ? analyseEntry('NO', modelYesProb, kalshiYesPrice) : null;
    var side  = direction === dirs.yesDir ? 'YES' : 'NO';
    var entry = side === 'YES' ? entryYes : side === 'NO' ? entryNo : null;
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
    var mPct    = 'model ' + Math.round(modelYesProb * 100) + '% YES';
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
      modelProbYes: parseFloat(modelYesProb.toFixed(4)),
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
    var nowTs    = Date.now();
    var fadeEval = evaluateCrowdFade({
      sym: sym,
      closeTimeMs: closeTimeMs,
      kalshiYesPrice: kalshiYesPrice,
      secsLeft: secsLeft,
      dirs: dirs,
      modelDir: modelDir,
      modelYesProb: modelYesProb,
      modelActive: modelActive,
      entryYes: entryYes,
      entryNo: entryNo,
      liquidity: k15 ? k15.liquidity : null,
    });

    if (fadeEval && fadeEval.confirmed && ENABLE_CROWD_FADE_OVERRIDE) {
      // Persistent, model-confirmed mispricing fade.
      result.direction  = fadeEval.direction;
      result.side       = fadeEval.side;
      result.action     = 'trade';
      result.alignment  = 'CROWD_FADE';
      result.crowdFade  = true;
      result.crowdFadeAgeMs = fadeEval.ageMs;
      result.crowdFadeConfirmLeftSec = 0;
      result.crowdFadeMispricingPp = Math.round((fadeEval.mispricing || 0) * 100);
      if (fadeEval.entry) Object.assign(result, fadeEval.entry);
      result.humanReason = sym + ' CROWD FADE (mispricing hunter) → ' + fadeEval.direction +
        ': model-vs-market gap ' + result.crowdFadeMispricingPp + 'pp, edge ' + (result.edgeCents || 0) + 'c';
      _locks[lockKey]   = { direction: fadeEval.direction, side: result.side, ts: nowTs, closeTimeMs: closeTimeMs };
    } else if (fadeEval && fadeEval.suggested) {
      // Candidate mispricing is building but not persistent enough yet.
      result.crowdFadeSuggested = true;
      result.crowdFade = false;
      result.crowdFadeAgeMs = fadeEval.ageMs;
      var confirmLeft = Math.max(0, Math.ceil(((fadeEval.confirmMs || CROWD_FADE_CONFIRM_MAX_MS) - fadeEval.ageMs) / 1000));
      result.crowdFadeConfirmLeftSec = confirmLeft;
      result.crowdFadeMispricingPp = Math.round((fadeEval.mispricing || 0) * 100);
      result.humanReason += ' · crowd-fade setup ' + Math.round((fadeEval.mispricing || 0) * 100) +
        'pp/' + Math.round((fadeEval.minMispricing || CROWD_FADE_MIN_MISPRICE) * 100) + 'pp (confirm ' + confirmLeft + 's)';
    } else if (result.action === 'trade') {
      // New trade signal — lock it
      _locks[lockKey] = { direction: result.direction, side: result.side, ts: nowTs, closeTimeMs: closeTimeMs };
    } else if (lock && lock.closeTimeMs === closeTimeMs && (nowTs - lock.ts) < LOCK_MS) {
      // Signal drifted off trade but lock is still fresh — hold it
      var lockConflict = modelActive && modelDir && lock.direction && modelDir !== lock.direction;
      if (lockConflict) {
        delete _locks[lockKey];
      } else {
        result.direction   = lock.direction;
        result.side        = lock.side;
        result.action      = 'trade';
        result.signalLocked = true;
        result.humanReason  = sym + ' [LOCKED ' + Math.round((nowTs - lock.ts) / 1000) + 's ago] ' + lock.direction;
      }
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
