(function () {
    "use strict";

    const MAX_HISTORY = 180;
    const MAX_TRADES = 140;

    const stateBySym = {};

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    function toNum(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function avg(arr) {
        if (!arr || !arr.length) return 0;
        return arr.reduce((s, v) => s + v, 0) / arr.length;
    }

    function std(arr) {
        if (!arr || arr.length < 2) return 0;
        const m = avg(arr);
        const variance = arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length;
        return Math.sqrt(variance);
    }

    function median(arr) {
        if (!arr || !arr.length) return 0;
        const sorted = arr.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function initSym(sym) {
        if (!stateBySym[sym]) {
            stateBySym[sym] = {
                spreadPctHist: [],
                depthHist: [],
                imbalanceHist: [],
                sweepHist: [],
                vacuumHist: [],
                toxicityHist: [],
                last: null,
            };
        }
        return stateBySym[sym];
    }

    function getLevelQty(level) {
        return toNum(level && level.qty, 0);
    }

    function normalizeBook(book) {
        if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
        const bids = book.bids.slice(0, 20).map(l => ({ price: toNum(l.price, 0), qty: toNum(l.qty, 0) })).filter(l => l.price > 0 && l.qty > 0);
        const asks = book.asks.slice(0, 20).map(l => ({ price: toNum(l.price, 0), qty: toNum(l.qty, 0) })).filter(l => l.price > 0 && l.qty > 0);
        if (!bids.length || !asks.length) return null;
        return { bids, asks };
    }

    function normalizeTrades(trades) {
        if (!Array.isArray(trades) || !trades.length) return [];
        return trades.slice(-MAX_TRADES).map(t => ({
            side: (t.side || "").toLowerCase(),
            qty: toNum(t.qty, 0),
            price: toNum(t.price, 0),
            ts: toNum(t.ts || t.timestamp, Date.now()),
        })).filter(t => t.qty > 0 && (t.side === "buy" || t.side === "sell"));
    }

    function analyzeImbalance(bookN) {
        if (!bookN) {
            return {
                value: 0,
                bidVolume: 0,
                askVolume: 0,
                spreadPct: 0,
            };
        }
        const bidVolume = bookN.bids.reduce((s, l) => s + l.qty, 0);
        const askVolume = bookN.asks.reduce((s, l) => s + l.qty, 0);
        const denom = bidVolume + askVolume;
        const value = denom > 0 ? (bidVolume - askVolume) / denom : 0;
        const bestBid = bookN.bids[0].price;
        const bestAsk = bookN.asks[0].price;
        const spreadPct = bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;
        return {
            value: clamp(value, -1, 1),
            bidVolume,
            askVolume,
            spreadPct,
        };
    }

    function analyzeSweep(tradesN, bookN) {
        if (!tradesN.length) {
            return {
                score: 0,
                direction: 0,
                hitRate: 0,
                burstRatio: 0,
                sideDominance: 0,
                label: "No tape",
            };
        }

        const totalQty = tradesN.reduce((s, t) => s + t.qty, 0);
        const buyQty = tradesN.reduce((s, t) => s + (t.side === "buy" ? t.qty : 0), 0);
        const sellQty = totalQty - buyQty;
        const sideDominance = totalQty > 0 ? (buyQty - sellQty) / totalQty : 0;

        const qtySeries = tradesN.map(t => t.qty);
        const medQty = Math.max(1e-9, median(qtySeries));
        const largeTrades = tradesN.filter(t => t.qty >= medQty * 3.2);
        const burstRatio = tradesN.length ? largeTrades.length / tradesN.length : 0;

        let hitRate = 0;
        if (bookN) {
            const bestAsk = bookN.asks[0]?.price || 0;
            const bestBid = bookN.bids[0]?.price || 0;
            let crossing = 0;
            for (const t of tradesN) {
                if (t.side === "buy" && bestAsk > 0 && t.price >= bestAsk) crossing++;
                if (t.side === "sell" && bestBid > 0 && t.price <= bestBid) crossing++;
            }
            hitRate = tradesN.length ? crossing / tradesN.length : 0;
        }

        const dir = sideDominance > 0.06 ? 1 : sideDominance < -0.06 ? -1 : 0;
        const raw = sideDominance * 0.55 + burstRatio * 0.25 + hitRate * 0.20;
        const score = clamp(raw, -1, 1);

        return {
            score,
            direction: dir,
            hitRate,
            burstRatio,
            sideDominance,
            label: Math.abs(score) >= 0.40
                ? (score > 0 ? "Buy-side sweep" : "Sell-side sweep")
                : "No clear sweep",
        };
    }

    function analyzeVacuum(symState, imbalance, bookN) {
        const spreadHist = symState.spreadPctHist;
        const depthHist = symState.depthHist;

        const spreadNow = imbalance.spreadPct;
        const depthNow = bookN
            ? bookN.bids.slice(0, 10).reduce((s, l) => s + l.qty, 0) + bookN.asks.slice(0, 10).reduce((s, l) => s + l.qty, 0)
            : 0;

        const spreadAvg = avg(spreadHist);
        const spreadStd = std(spreadHist);
        const depthAvg = avg(depthHist);

        const spreadZ = spreadStd > 1e-9 ? (spreadNow - spreadAvg) / spreadStd : 0;
        const depthCollapse = depthAvg > 1e-9 ? 1 - depthNow / depthAvg : 0;

        const spreadExpanded = spreadNow > (spreadAvg + spreadStd * 1.2);
        const depthCollapsed = depthCollapse > 0.33;
        const active = spreadExpanded && depthCollapsed;

        // Liquidity vacuum increases slippage and makes directional calls less reliable.
        const severity = clamp((Math.max(0, spreadZ) * 0.6 + Math.max(0, depthCollapse) * 1.25) / 2, 0, 1);

        return {
            active,
            severity,
            spreadNow,
            spreadAvg,
            spreadZ,
            depthNow,
            depthAvg,
            depthCollapse,
            score: -severity,
            label: active ? "Liquidity vacuum" : "Normal liquidity",
        };
    }

    function analyzeToxicity(tradesN) {
        if (!tradesN.length) {
            return {
                available: false,
                proxy: 0,
                imbalance: 0,
                signedMean: 0,
                signedStd: 0,
                label: "No flow",
            };
        }

        const signed = tradesN.map(t => (t.side === "buy" ? 1 : -1) * t.qty);
        const signedMean = avg(signed);
        const signedStd = std(signed);
        const absFlow = signed.reduce((s, v) => s + Math.abs(v), 0);
        const netFlow = signed.reduce((s, v) => s + v, 0);
        const imbalance = absFlow > 0 ? netFlow / absFlow : 0;

        // VPIN-style toxicity proxy: strong one-sided signed flow with high signed variance.
        const variancePressure = signedStd > 0 ? Math.min(1, Math.abs(signedMean) / (signedStd + 1e-9) * 1.7) : 0;
        const proxy = clamp(Math.abs(imbalance) * 0.65 + variancePressure * 0.35, 0, 1);

        return {
            available: true,
            proxy,
            imbalance,
            signedMean,
            signedStd,
            label: proxy > 0.6 ? "High toxicity" : proxy > 0.35 ? "Elevated toxicity" : "Calm flow",
        };
    }

    function pushHist(arr, value) {
        arr.push(value);
        if (arr.length > MAX_HISTORY) arr.shift();
    }

    function analyze(sym, book, trades, options) {
        const symKey = String(sym || "UNK").toUpperCase();
        const state = initSym(symKey);
        const bookN = normalizeBook(book);
        const tradesN = normalizeTrades(trades);

        const imbalance = analyzeImbalance(bookN);
        const sweep = analyzeSweep(tradesN, bookN);
        const vacuum = analyzeVacuum(state, imbalance, bookN);
        const toxicity = analyzeToxicity(tradesN);

        pushHist(state.spreadPctHist, imbalance.spreadPct);
        pushHist(state.depthHist, bookN
            ? bookN.bids.slice(0, 10).reduce((s, l) => s + l.qty, 0) + bookN.asks.slice(0, 10).reduce((s, l) => s + l.qty, 0)
            : 0);
        pushHist(state.imbalanceHist, imbalance.value);
        pushHist(state.sweepHist, sweep.score);
        pushHist(state.vacuumHist, vacuum.severity);
        pushHist(state.toxicityHist, toxicity.proxy || 0);

        // Conservative composite: imbalance remains dominant; sweep/vacuum/toxicity are secondary.
        const composite = clamp(
            imbalance.value * 0.55 + sweep.score * 0.25 + vacuum.score * 0.12 + (toxicity.available ? (-Math.sign(imbalance.value || sweep.score || 1) * toxicity.proxy * 0.08) : 0),
            -1,
            1
        );

        const snapshot = {
            sym: symKey,
            ts: Date.now(),
            imbalance,
            sweep,
            vacuum,
            toxicity,
            composite,
            latencySafe: true,
            sampleSize: {
                bookLevels: bookN ? (bookN.bids.length + bookN.asks.length) : 0,
                trades: tradesN.length,
            },
            options: options || null,
        };

        state.last = snapshot;
        return snapshot;
    }

    function getSnapshot(sym) {
        const key = String(sym || "").toUpperCase();
        return stateBySym[key]?.last || null;
    }

    function getAll() {
        const out = {};
        Object.keys(stateBySym).forEach(sym => {
            out[sym] = stateBySym[sym].last;
        });
        return out;
    }

    window.MicrostructureEngine = {
        analyze,
        getSnapshot,
        getAll,
    };

    window.getMicrostructureDiagnostics = function () {
        return window.MicrostructureEngine.getAll();
    };

    // Emergency dashboard data hook: minimal, serializable, always safe.
    window.__MICROSTRUCTURE_EMERGENCY__ = function () {
        const all = window.MicrostructureEngine.getAll();
        const reduced = {};
        Object.keys(all).forEach(sym => {
            const s = all[sym];
            if (!s) return;
            reduced[sym] = {
                ts: s.ts,
                composite: s.composite,
                imbalance: s.imbalance?.value || 0,
                sweep: s.sweep?.score || 0,
                vacuum: s.vacuum?.severity || 0,
                toxicity: s.toxicity?.proxy || 0,
                label: s.vacuum?.active ? "vacuum" : s.sweep?.label || "normal",
            };
        });
        return reduced;
    };
})();
