/**
 * ================================================================
 * Win-Rate Segmentation Analysis
 * Segment performance by: regime, confidence bucket, exchange lead
 * Identify where edge actually lives
 * ================================================================
 */

(function () {
    'use strict';

    class WinRateSegmentation {
        constructor() {
            this.predictions = [];
            this.segments = {
                by_regime: {},
                by_confidence: {},
                by_coin: {},
                by_exchange: {},
                by_exchange_lead: {},
                by_horizon: {},
                by_regime_confidence: {},  // 2D: regime × confidence
            };

            console.log('[WinRateSegmentation] Initialized');
        }

        /**
         * Add prediction record
         * @param {object} record - {
         *   prediction: {UP|DOWN},
         *   outcome: {UP|DOWN},
         *   confidence: 0-1,
         *   regime: CHOP|TREND|...,
         *   coin: BTC|ETH|...,
         *   exchange_lead: {coin: probability},
         *   horizon: 15,
         *   timestamp: ms
         * }
         */
        add(record) {
            const outcome = (record.outcome === record.prediction) ? 1 : 0;

            this.predictions.push({
                ...record,
                outcome: outcome,
                timestamp: record.timestamp || Date.now(),
            });

            // Bounded
            if (this.predictions.length > 5000) {
                this.predictions.shift();
            }

            this.analyze();
        }

        /**
         * Recompute all segments
         */
        analyze() {
            if (this.predictions.length === 0) return;

            // By regime
            this.segments.by_regime = this.segmentBy('regime');

            // By confidence bucket
            this.segments.by_confidence = this.segmentByConfidence();

            // By coin
            this.segments.by_coin = this.segmentBy('coin');

            // By horizon
            this.segments.by_horizon = this.segmentBy('horizon');

            // By exchange lead dependency
            this.segments.by_exchange = this.analyzeExchangeLead();
            this.segments.by_exchange_lead = this.segmentByExchangeLeadBucket();

            // 2D: regime × confidence
            this.segments.by_regime_confidence = this.segment2D('regime', 'confidence');
        }

        /**
         * Segment by single dimension
         */
        segmentBy(dimension) {
            const segments = {};

            for (let pred of this.predictions) {
                const key = pred[dimension];
                if (!(key in segments)) {
                    segments[key] = { preds: [], outcomes: [] };
                }

                segments[key].preds.push(pred.confidence);
                segments[key].outcomes.push(pred.outcome);
            }

            // Compute stats
            const result = {};
            for (let key in segments) {
                const seg = segments[key];
                const n = seg.outcomes.length;
                const wins = seg.outcomes.reduce((a, b) => a + b);

                result[key] = {
                    count: n,
                    wins: wins,
                    win_rate: wins / n,
                    avg_confidence: seg.preds.reduce((a, b) => a + b) / n,
                    confidence_std: this.computeStd(seg.preds),
                    edge: (wins / n - 0.5) * 2,  // edge as % above 50%
                };
            }

            return result;
        }

        /**
         * Segment by confidence buckets
         */
        segmentByConfidence(numBins = 10) {
            const bins = Array(numBins).fill(0).map(() => ({
                preds: [],
                outcomes: [],
            }));

            for (let pred of this.predictions) {
                const bin = Math.min(numBins - 1, Math.floor(pred.confidence * numBins));
                bins[bin].preds.push(pred.confidence);
                bins[bin].outcomes.push(pred.outcome);
            }

            const result = {};
            for (let i = 0; i < numBins; i++) {
                const bin = bins[i];
                if (bin.outcomes.length > 0) {
                    const wins = bin.outcomes.reduce((a, b) => a + b);
                    const n = bin.outcomes.length;

                    result[`${(i / numBins).toFixed(2)}-${((i + 1) / numBins).toFixed(2)}`] = {
                        count: n,
                        wins: wins,
                        win_rate: wins / n,
                        avg_confidence: bin.preds.reduce((a, b) => a + b) / n,
                        confidence_std: this.computeStd(bin.preds),
                    };
                }
            }

            return result;
        }

        /**
         * 2D segmentation: dimension1 × dimension2
         */
        segment2D(dim1, dim2, numBins = 5) {
            const result = {};

            for (let pred of this.predictions) {
                const key1 = pred[dim1];
                const key2 = dim2 === 'confidence'
                    ? Math.floor(pred.confidence * numBins) / numBins
                    : pred[dim2];

                const compositeKey = `${key1}|${key2}`;
                if (!(compositeKey in result)) {
                    result[compositeKey] = { preds: [], outcomes: [], dim1: key1, dim2: key2 };
                }

                result[compositeKey].preds.push(pred.confidence);
                result[compositeKey].outcomes.push(pred.outcome);
            }

            // Compute stats
            const formatted = {};
            for (let key in result) {
                const seg = result[key];
                const n = seg.outcomes.length;
                if (n < 3) continue;  // Skip small segments

                const wins = seg.outcomes.reduce((a, b) => a + b);

                formatted[key] = {
                    dim1: seg.dim1,
                    dim2: seg.dim2,
                    count: n,
                    wins: wins,
                    win_rate: wins / n,
                    avg_confidence: seg.preds.reduce((a, b) => a + b) / n,
                };
            }

            return formatted;
        }

        /**
         * Analyze exchange lead dependency
         * Does our edge depend on external market signals?
         */
        analyzeExchangeLead() {
            // Group by whether we predicted same direction as exchange
            const aligned = [];
            const opposed = [];

            for (let pred of this.predictions) {
                if (!pred.exchange_lead || !Number.isFinite(pred.exchange_lead[pred.coin])) {
                    continue;
                }

                const exProb = pred.exchange_lead[pred.coin];
                const predictedUp = pred.prediction === 'UP';
                const exchangeUp = exProb > 0.5;

                if (predictedUp === exchangeUp) {
                    aligned.push(pred);
                } else {
                    opposed.push(pred);
                }
            }

            const alignedResults = aligned.map(p => p.outcome);
            const opposedResults = opposed.map(p => p.outcome);

            const alignedWR = alignedResults.length > 0
                ? alignedResults.reduce((a, b) => a + b) / alignedResults.length
                : 0;
            const opposedWR = opposedResults.length > 0
                ? opposedResults.reduce((a, b) => a + b) / opposedResults.length
                : 0;
            const alignedEdge = alignedWR - 0.5;
            const opposedEdge = opposedWR - 0.5;

            return {
                aligned: {
                    count: aligned.length,
                    win_rate: alignedWR,
                    samples: aligned,
                },
                opposed: {
                    count: opposed.length,
                    win_rate: opposedWR,
                    samples: opposed,
                },
                independence: {
                    statistic: Math.abs(opposedEdge) > 1e-9 ? alignedEdge / opposedEdge : 0,
                    interpretation: 'ratio of edge in aligned vs opposed predictions',
                },
            };
        }

        segmentByExchangeLeadBucket() {
            const buckets = {
                FOLLOWING: [],
                CONTRARIAN: [],
                UNKNOWN: [],
            };

            for (let i = 0; i < this.predictions.length; i++) {
                const pred = this.predictions[i];
                if (!pred.exchange_lead || !Number.isFinite(pred.exchange_lead[pred.coin])) {
                    buckets.UNKNOWN.push(pred.outcome);
                    continue;
                }

                const exProb = pred.exchange_lead[pred.coin];
                const predictedUp = pred.prediction === 'UP';
                const exchangeUp = exProb > 0.5;
                if (predictedUp === exchangeUp) {
                    buckets.FOLLOWING.push(pred.outcome);
                } else {
                    buckets.CONTRARIAN.push(pred.outcome);
                }
            }

            const out = {};
            const keys = Object.keys(buckets);
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const arr = buckets[key];
                const wins = arr.reduce((a, b) => a + b, 0);
                out[key] = {
                    count: arr.length,
                    wins,
                    win_rate: arr.length > 0 ? wins / arr.length : 0,
                    edge: arr.length > 0 ? (wins / arr.length - 0.5) * 2 : 0,
                };
            }

            return out;
        }

        /**
         * Find highest-edge segments
         * Where is the model's true edge?
         */
        topEdges(dimension, top = 5) {
            const seg = this.segments[`by_${dimension}`];
            if (!seg) return [];

            return Object.entries(seg)
                .map(([key, stats]) => ({
                    key,
                    ...stats,
                }))
                .sort((a, b) => b.edge - a.edge)
                .slice(0, top);
        }

        /**
         * Test statistical significance
         * Chi-square test: win_rate vs expected 50%
         */
        chiSquareTest(segment_outcomes) {
            if (!segment_outcomes || segment_outcomes.length < 5) {
                return { significant: false, statistic: 0, pvalue: 1 };
            }

            const n = segment_outcomes.length;
            const wins = segment_outcomes.reduce((a, b) => a + b);
            const expected = n / 2;

            // Chi-square = (observed - expected)^2 / expected
            const obs_wins = (wins - expected) * (wins - expected) / expected;
            const obs_losses = ((n - wins) - expected) * ((n - wins) - expected) / expected;
            const chisq = obs_wins + obs_losses;

            // P-value approximation (1 df)
            // chisq > 3.84 ≈ p < 0.05
            const significant = chisq > 3.84;
            const pvalue = chisq > 3.84 ? Math.exp(-chisq / 2) : 0.5;

            return {
                significant: significant,
                statistic: chisq,
                pvalue: pvalue,
                effect_size: (wins / n - 0.5),
            };
        }

        /**
         * Generate comparison table
         */
        comparisonTable(dimension) {
            const seg = this.segments[`by_${dimension}`];
            if (!seg) return [];

            return Object.entries(seg)
                .map(([key, stats]) => {
                    const sigTest = this.chiSquareTest(
                        this.predictions
                            .filter(p => p[dimension] === key)
                            .map(p => p.outcome)
                    );

                    return {
                        segment: key,
                        ...stats,
                        significant: sigTest.significant,
                        pvalue: sigTest.pvalue,
                        samples: stats.count,
                    };
                })
                .sort((a, b) => b.edge - a.edge);
        }

        /**
         * Compute standard deviation
         */
        computeStd(values) {
            if (values.length === 0) return 0;
            const mean = values.reduce((a, b) => a + b) / values.length;
            const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2)) / values.length;
            return Math.sqrt(variance);
        }

        /**
         * Find underperforming segments
         * Where should we reduce size or change approach?
         */
        underperformingSegments(threshold = 0.45) {
            const allSegs = Object.entries(this.segments.by_regime)
                .concat(Object.entries(this.segments.by_coin))
                .concat(Object.entries(this.segments.by_confidence));

            return allSegs
                .filter(([key, stats]) => stats.win_rate < threshold && stats.count > 10)
                .map(([key, stats]) => ({
                    segment: key,
                    win_rate: stats.win_rate,
                    count: stats.count,
                    recommendation: 'reduce_size_or_skip',
                }));
        }

        /**
         * Export segmentation results
         */
        export() {
            return {
                total_predictions: this.predictions.length,
                segments: this.segments,
                top_edges: {
                    by_regime: this.topEdges('regime', 3),
                    by_coin: this.topEdges('coin', 3),
                    by_confidence: this.topEdges('confidence', 3),
                },
                underperforming: this.underperformingSegments(0.45),
            };
        }

        /**
         * Reset
         */
        reset() {
            this.predictions = [];
            this.segments = {
                by_regime: {},
                by_confidence: {},
                by_coin: {},
                by_exchange: {},
                by_exchange_lead: {},
                by_horizon: {},
                by_regime_confidence: {},
            };
        }
    }

    window.WinRateSegmentation = WinRateSegmentation;
    console.log('[WinRateSegmentation] Loaded');
})();
