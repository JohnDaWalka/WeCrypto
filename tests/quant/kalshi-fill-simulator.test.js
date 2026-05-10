const assert = require('assert');
const FillSimulator = require('../../src/quant/kalshi-fill-simulator.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`PASS ${name}`);
    } catch (err) {
        failed++;
        console.error(`FAIL ${name}`);
        console.error(err.message);
    }
}

console.log('\n[Kalshi Fill Simulator] deterministic scenarios');

test('estimateFill deterministic mode is stable', () => {
    const params = {
        deterministic: true,
        side: 'BUY_YES',
        quotePrice: 0.54,
        midPrice: 0.54,
        spreadBps: 110,
        latencyMs: 350,
        volatilityBpsPerSec: 44,
        queueAhead: 12,
        queueOutflowPerSec: 3,
        orderSize: 15,
        visibleSize: 240,
        liquidityScore: 0.7,
        collapseProbability: 0.05,
    };

    const a = FillSimulator.estimateFill(params);
    const b = FillSimulator.estimateFill(params);

    assert.strictEqual(a.expected.slippageBps, b.expected.slippageBps);
    assert.strictEqual(a.expected.fillProbability, b.expected.fillProbability);
    assert.strictEqual(a.expected.fillPrice, b.expected.fillPrice);
});

test('higher latency increases expected slippage', () => {
    const base = FillSimulator.estimateFill({
        deterministic: true,
        quotePrice: 0.51,
        latencyMs: 100,
        spreadBps: 90,
        volatilityBpsPerSec: 30,
        liquidityScore: 0.8,
        queueAhead: 6,
        queueOutflowPerSec: 4,
    });

    const stressed = FillSimulator.estimateFill({
        deterministic: true,
        quotePrice: 0.51,
        latencyMs: 900,
        spreadBps: 90,
        volatilityBpsPerSec: 30,
        liquidityScore: 0.8,
        queueAhead: 6,
        queueOutflowPerSec: 4,
    });

    assert(stressed.expected.latencyDriftBps > base.expected.latencyDriftBps);
    assert(stressed.expected.slippageBps > base.expected.slippageBps);
});

test('liquidity collapse reduces fill probability', () => {
    const healthy = FillSimulator.estimateFill({
        deterministic: true,
        quotePrice: 0.56,
        spreadBps: 80,
        latencyMs: 250,
        queueAhead: 5,
        queueOutflowPerSec: 5,
        orderSize: 8,
        visibleSize: 300,
        liquidityScore: 0.92,
        collapseProbability: 0.01,
        collapseSeverity: 0.2,
    });

    const collapsed = FillSimulator.estimateFill({
        deterministic: true,
        quotePrice: 0.56,
        spreadBps: 180,
        latencyMs: 450,
        queueAhead: 40,
        queueOutflowPerSec: 1,
        orderSize: 35,
        visibleSize: 60,
        liquidityScore: 0.2,
        collapseProbability: 0.9,
        collapseSeverity: 0.9,
    });

    assert(collapsed.expected.fillProbability < healthy.expected.fillProbability);
    assert(collapsed.expected.partialFillRatio < healthy.expected.partialFillRatio);
});

test('simulateBatch returns deterministic aggregate summary', () => {
    const batch = FillSimulator.simulateBatch([
        { quotePrice: 0.49, side: 'BUY_YES', latencyMs: 200 },
        { quotePrice: 0.61, side: 'BUY_NO', latencyMs: 400, queueAhead: 18 },
        { quotePrice: 0.53, side: 'SELL_YES', latencyMs: 300, orderSize: 20, visibleSize: 80 },
    ], { deterministic: true, seed: 7 });

    assert.strictEqual(batch.results.length, 3);
    assert(batch.summary.avgFillProbability > 0);
    assert(batch.summary.avgSlippageBps > 0);
    assert(batch.summary.fillRate >= 0 && batch.summary.fillRate <= 1);
});

test('guardrails clamp invalid assumptions', () => {
    const guarded = FillSimulator.estimateFill({
        deterministic: true,
        side: 'INVALID_SIDE',
        quotePrice: 99,
        spreadBps: -5,
        latencyMs: -100,
        liquidityScore: 3,
        minFillProbability: 0.9,
        maxFillProbability: 0.2,
    });

    assert(guarded.params.quotePrice <= 0.99);
    assert(guarded.params.spreadBps >= 1);
    assert(guarded.params.latencyMs >= 0);
    assert(guarded.warnings.length >= 1);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
