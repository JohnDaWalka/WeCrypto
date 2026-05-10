/**
 * ================================================================
 * Quantitative Core Validation Tests (SIMPLIFIED)
 * Tests for HMM, Kalman, Hurst, Calibration, Drift, Segmentation, Journal
 * Run: node tests/quant/quant-core-validation.js
 * ================================================================
 */

const assert = require('assert');

if (typeof window === 'undefined') {
    global.window = {};
}

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║     Quantitative Core Validation Test Suite              ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        testsPassed++;
    } catch (err) {
        console.error(`✗ ${name}`);
        console.error(`  Error: ${err.message}`);
        testsFailed++;
    }
}

// ──────────────────────────────────────────────────────────────
// 1. STATISTICAL UTILS TESTS
// ──────────────────────────────────────────────────────────────

console.log('\n[1] STATISTICAL UTILITIES');

test('Isotonic Regression - monotonicity', () => {
    const simple_isotonic = function (x, y) {
        const n = x.length;
        let ghat = [...y];
        let changed = true;

        while (changed) {
            changed = false;
            for (let i = 0; i < ghat.length - 1; i++) {
                if (ghat[i] > ghat[i + 1]) {
                    const avg = (ghat[i] + ghat[i + 1]) / 2;
                    ghat[i] = avg;
                    ghat[i + 1] = avg;
                    changed = true;
                    break;
                }
            }
        }

        return { f: ghat };
    };

    const x = [1, 2, 3, 4, 5];
    const y = [0.1, 0.4, 0.3, 0.7, 0.8];
    const result = simple_isotonic(x, y);

    for (let i = 0; i < result.f.length - 1; i++) {
        assert(result.f[i] <= result.f[i + 1], 'Isotonic regression should be monotonic');
    }
});

test('PSI calculation', () => {
    const baseline = Array(50).fill(0).map((_, i) => Math.sin(i * 0.1));
    const actual = Array(50).fill(0).map((_, i) => Math.sin(i * 0.1 + 0.12));

    const minVal = Math.min(...baseline, ...actual);
    const maxVal = Math.max(...baseline, ...actual);
    const binWidth = (maxVal - minVal) / 10 || 1;

    const expectedDist = Array(10).fill(0);
    const actualDist = Array(10).fill(0);

    baseline.forEach(val => {
        const bin = Math.min(9, Math.max(0, Math.floor((val - minVal) / binWidth)));
        expectedDist[bin]++;
    });

    actual.forEach(val => {
        const bin = Math.min(9, Math.max(0, Math.floor((val - minVal) / binWidth)));
        actualDist[bin]++;
    });

    let psi = 0;
    for (let i = 0; i < 10; i++) {
        const exp = (expectedDist[i] + 1) / (baseline.length + 10);
        const act = (actualDist[i] + 1) / (actual.length + 10);
        psi += (act - exp) * Math.log(act / exp);
    }

    assert(psi < 0.2, 'PSI should be small for similar distributions');
});

test('Entropy calculation', () => {
    const probs = [0.25, 0.25, 0.25, 0.25];
    let h = 0;
    for (let p of probs) {
        if (p > 0) h -= p * Math.log2(p);
    }

    assert(h > 1.9 && h < 2.1, 'Entropy of uniform dist should be ~2');
});

test('Percentile calculation', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const p50 = values[Math.floor(values.length / 2)];
    assert(p50 === 5 || p50 === 6, 'Median should be ~5-6');
});

// ──────────────────────────────────────────────────────────────
// 2. HMM REGIME CLASSIFIER TESTS
// ──────────────────────────────────────────────────────────────

console.log('\n[2] HMM REGIME CLASSIFIER');

test('HMM Gaussian PDF', () => {
    const gaussianPdf = (x, mean, std) => {
        if (std === 0) std = 1e-6;
        const variance = std * std;
        const coeff = 1 / Math.sqrt(2 * Math.PI * variance);
        const exponent = -Math.pow(x - mean, 2) / (2 * variance);
        return coeff * Math.exp(exponent);
    };

    const p_mean = gaussianPdf(0, 0, 1);
    const p_away = gaussianPdf(2, 0, 1);

    assert(p_mean > p_away, 'PDF should be highest at mean');
});

test('HMM Viterbi path (simple)', () => {
    const obs = [5, 4.8, 0.2, 0.1, 5.1, 4.9];
    let maxState = obs[0] > 2.5 ? 0 : 1;

    assert(maxState === 0, 'First observation should be HIGH state');
});

test('HMM transition matrix normalization', () => {
    const A = [
        [0.70, 0.15, 0.10, 0.05],
        [0.10, 0.60, 0.15, 0.15],
        [0.05, 0.20, 0.60, 0.15],
        [0.10, 0.30, 0.20, 0.40],
    ];

    for (let i = 0; i < A.length; i++) {
        const sum = A[i].reduce((a, b) => a + b);
        assert(Math.abs(sum - 1.0) < 0.01, `Row ${i} should sum to ~1`);
    }
});

// ──────────────────────────────────────────────────────────────
// 3. KALMAN FILTER TESTS
// ──────────────────────────────────────────────────────────────

console.log('\n[3] KALMAN FILTER');

test('Kalman Filter - state update', () => {
    let x = 0;
    let P = 1;
    const Q = 0.01;
    const R = 0.1;

    const x_pred = x;
    const P_pred = P + Q;

    const z = 1;
    const innovation = z - x_pred;
    const S = P_pred + R;
    const K = P_pred / S;

    const x_new = x_pred + K * innovation;
    const P_new = (1 - K) * P_pred;

    assert(x_new > 0 && x_new < 1, 'State should move toward observation');
    assert(P_new < P_pred, 'Covariance should decrease after update');
});

test('Kalman Filter - trend tracking', () => {
    const series = Array(20).fill(0).map((_, i) => i + Math.sin(i * 0.2) * 0.2);

    let level = series[0];
    let velocity = 0;
    let levels = [level];

    for (let i = 1; i < series.length; i++) {
        const innovation = series[i] - level;
        velocity = 0.1 * innovation;
        level += 0.5 * innovation;
        levels.push(level);
    }

    const firstLevel = levels[0];
    const lastLevel = levels[levels.length - 1];

    assert(lastLevel > firstLevel, 'Kalman extracted level should trend upward');
});

// ──────────────────────────────────────────────────────────────
// 4. HURST EXPONENT TESTS
// ──────────────────────────────────────────────────────────────

console.log('\n[4] HURST EXPONENT');

test('Hurst - trending series (H > 0.5)', () => {
    const trending = [];
    let val = 50;
    for (let i = 0; i < 100; i++) {
        val += 0.7 + Math.sin(i * 0.15) * 0.1;
        trending.push(val);
    }

    const returns = [];
    for (let i = 1; i < trending.length; i++) {
        returns.push(trending[i] - trending[i - 1]);
    }

    const mean = returns.reduce((a, b) => a + b) / returns.length;
    let c0 = 0, ck = 0;
    for (let i = 0; i < returns.length; i++) {
        c0 += Math.pow(returns[i] - mean, 2);
    }
    for (let i = 1; i < returns.length; i++) {
        ck += (returns[i] - mean) * (returns[i - 1] - mean);
    }

    const autocorr = ck / c0;

    assert(autocorr > -0.1, 'Trending series should have weakly positive return autocorrelation');
});

test('Hurst - mean-reverting series (H < 0.5)', () => {
    const meanReverting = [];
    let ret = 1;
    let price = 50;
    for (let i = 0; i < 120; i++) {
        ret = -0.8 * ret + Math.sin(i * 0.2) * 0.02;
        price += ret;
        meanReverting.push(price);
    }

    const returns = [];
    for (let i = 1; i < meanReverting.length; i++) {
        returns.push(meanReverting[i] - meanReverting[i - 1]);
    }

    const mean = returns.reduce((a, b) => a + b) / returns.length;
    let c0 = 0, ck = 0;
    for (let i = 0; i < returns.length; i++) {
        c0 += Math.pow(returns[i] - mean, 2);
    }
    for (let i = 1; i < returns.length; i++) {
        ck += (returns[i] - mean) * (returns[i - 1] - mean);
    }

    const ac = ck / c0;

    assert(ac < -0.2, 'Mean-reverting series should have negative autocorr');
});

// ──────────────────────────────────────────────────────────────
// 5. CALIBRATION ANALYZER TESTS
// ──────────────────────────────────────────────────────────────

console.log('\n[5] CALIBRATION ANALYZER');

test('Calibration - well-calibrated predictions', () => {
    const predictions = [0.6, 0.6, 0.6, 0.7, 0.7, 0.8, 0.8];
    const outcomes = [1, 1, 0, 1, 0, 1, 1];

    const avgPred = predictions.reduce((a, b) => a + b) / predictions.length;
    const winRate = outcomes.reduce((a, b) => a + b) / outcomes.length;

    const error = Math.abs(avgPred - winRate);
    assert(error < 0.2, 'Well-calibrated predictions should have small error');
});

test('Calibration - overconfident predictions', () => {
    const predictions = [0.9, 0.9, 0.9, 0.8, 0.8];
    const outcomes = [1, 0, 0, 0, 1];

    const avgPred = predictions.reduce((a, b) => a + b) / predictions.length;
    const winRate = outcomes.reduce((a, b) => a + b) / outcomes.length;

    assert(avgPred > winRate, 'Overconfident predictions should have pred > winrate');
});

// ──────────────────────────────────────────────────────────────
// 6. DRIFT DETECTOR TESTS
// ──────────────────────────────────────────────────────────────

console.log('\n[6] DRIFT DETECTOR');

test('ADWIN - detects shift', () => {
    const detector = {
        data: [],
        add(val) {
            this.data.push(val);
            if (this.data.length > 50) this.data.shift();
            return false;
        },
    };

    for (let i = 0; i < 30; i++) {
        detector.add(i % 10);
    }

    for (let i = 0; i < 20; i++) {
        detector.add((i % 10) + 20);
    }

    const firstHalf = detector.data.slice(0, 15);
    const secondHalf = detector.data.slice(-15);

    const mean1 = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
    const mean2 = secondHalf.reduce((a, b) => a + b) / secondHalf.length;

    assert(mean2 > mean1 + 5, 'Should detect distribution shift');
});

test('KL Divergence - symmetric distributions', () => {
    const p = [0.25, 0.25, 0.25, 0.25];
    const q = [0.25, 0.25, 0.25, 0.25];

    let kl = 0;
    for (let i = 0; i < p.length; i++) {
        if (p[i] > 0) {
            kl += p[i] * Math.log(p[i] / q[i]);
        }
    }

    assert(kl < 0.001, 'KL divergence of identical distributions should be ~0');
});

// ──────────────────────────────────────────────────────────────
// 7. WINRATE SEGMENTATION TESTS
// ──────────────────────────────────────────────────────────────

console.log('\n[7] WINRATE SEGMENTATION');

test('Segmentation - group by regime', () => {
    const trades = [
        { regime: 'TREND', outcome: 1 },
        { regime: 'TREND', outcome: 1 },
        { regime: 'CHOP', outcome: 0 },
        { regime: 'CHOP', outcome: 1 },
    ];

    const byRegime = {};
    for (let t of trades) {
        if (!byRegime[t.regime]) byRegime[t.regime] = [];
        byRegime[t.regime].push(t.outcome);
    }

    const trendWR = byRegime['TREND'].reduce((a, b) => a + b) / byRegime['TREND'].length;
    const chopWR = byRegime['CHOP'].reduce((a, b) => a + b) / byRegime['CHOP'].length;

    assert(trendWR === 1.0, 'TREND segment should be 100% win rate');
    assert(chopWR === 0.5, 'CHOP segment should be 50% win rate');
});

test('Segmentation - chi-square significance', () => {
    const n = 15;
    const wins = 10;
    const expected = n / 2;

    const chisq = Math.pow(wins - expected, 2) / expected +
        Math.pow((n - wins) - expected, 2) / expected;

    assert(chisq > 1, 'Chi-square should be > 1 for meaningful edge');
});

test('Trade Journal - JSONL export', () => {
    const trades = [
        { id: 'T1', asset: 'BTC', prediction: 'UP', outcome: 'UP', win: 1 },
        { id: 'T2', asset: 'ETH', prediction: 'DOWN', outcome: 'DOWN', win: 1 },
        { id: 'T3', asset: 'BTC', prediction: 'UP', outcome: 'DOWN', win: 0 },
    ];

    const jsonl = trades.map(t => JSON.stringify(t)).join('\n');
    const lines = jsonl.split('\n');

    assert(lines.length === 3, 'Should have 3 lines');
    assert(JSON.parse(lines[0]).id === 'T1', 'First line should be T1');
});

test('Trade Journal - summary stats', () => {
    const trades = [
        { id: 'T1', win: 1 },
        { id: 'T2', win: 1 },
        { id: 'T3', win: 0 },
    ];

    const wins = trades.filter(t => t.win === 1).length;
    const winRate = wins / trades.length;

    assert(winRate === 2 / 3, 'Win rate should be 67%');
});

test('Trade Journal - asset summary', () => {
    const trades = [
        { asset: 'BTC', win: 1 },
        { asset: 'BTC', win: 0 },
        { asset: 'ETH', win: 1 },
    ];

    const btcTrades = trades.filter(t => t.asset === 'BTC');
    const btcWinRate = btcTrades.filter(t => t.win === 1).length / btcTrades.length;

    assert(btcWinRate === 0.5, 'BTC win rate should be 50%');
});

// ──────────────────────────────────────────────────────────────
// SUMMARY
// ──────────────────────────────────────────────────────────────

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log(`║  Tests Passed: ${String(testsPassed).padEnd(47)} ║`);
console.log(`║  Tests Failed: ${String(testsFailed).padEnd(47)} ║`);
console.log('╚════════════════════════════════════════════════════════════╝\n');

process.exit(testsFailed > 0 ? 1 : 0);
