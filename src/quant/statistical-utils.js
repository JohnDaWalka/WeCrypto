/**
 * ================================================================
 * Statistical Utilities — Core Building Blocks
 * Isotonic regression, entropy, distributions, percentiles
 * ================================================================
 */

(function () {
    'use strict';

    /**
     * Isotonic Regression (PAV algorithm)
     * Monotone increasing regression: maps predictions → win rates
     * Detects overconfidence patterns (high pred, low actual outcome)
     * 
     * @param {number[]} x - predictions (confidence scores 0-1)
     * @param {number[]} y - outcomes (0 or 1)
     * @param {number[]} weights - optional sample weights (default 1)
     * @returns {object} { f: fitted values, theta: breakpoints, blocks: }
     */
    function isotonicRegression(x, y, weights) {
        if (!x || !y || x.length === 0 || x.length !== y.length) {
            throw new Error('isotonicRegression: x and y must have same non-zero length');
        }

        const n = x.length;
        weights = weights || Array(n).fill(1);

        // Sort by x values
        const indices = Array.from({ length: n }, (_, i) => i)
            .sort((i, j) => x[i] - x[j]);

        const xs = indices.map(i => x[i]);
        const ys = indices.map(i => y[i]);
        const ws = indices.map(i => weights[i]);

        // PAV (Pool Adjacent Violators) Algorithm
        let ghat = ys.slice();
        let gw = ws.slice();
        let blocks = Array.from({ length: n }, (_, i) => [i]);

        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < ghat.length - 1; i++) {
                if (ghat[i] > ghat[i + 1]) {
                    // Pool blocks i and i+1
                    const newVal = (ghat[i] * gw[i] + ghat[i + 1] * gw[i + 1]) / (gw[i] + gw[i + 1]);
                    ghat[i] = newVal;
                    ghat[i + 1] = newVal;
                    gw[i] = gw[i] + gw[i + 1];

                    // Merge blocks
                    blocks[i] = blocks[i].concat(blocks[i + 1]);
                    blocks.splice(i + 1, 1);
                    ghat.splice(i + 1, 1);
                    gw.splice(i + 1, 1);

                    changed = true;
                    break;
                }
            }
        }

        // Map back to original indices
        const f = Array(n);
        blocks.forEach((blockIndices, blockIdx) => {
            blockIndices.forEach(idx => {
                f[indices[idx]] = ghat[blockIdx];
            });
        });

        return {
            f: f,  // fitted values (monotone increasing)
            theta: ghat,  // unique fitted values
            blocks: blocks,  // block structure (used for MSE calc)
            xs: xs,  // sorted x values
            ys: ys,  // sorted y values
        };
    }

    /**
     * Calculate calibration error (mean absolute calibration error)
     * Compares predicted confidence vs actual win rate in bins
     * Low error = well-calibrated predictions
     * 
     * @param {number[]} predictions - predicted confidence [0,1]
     * @param {number[]} outcomes - actual outcomes [0,1]
     * @param {number} numBins - bins for calibration (default 10)
     * @returns {object} { error, byBin: [{pred, actual, count, error}] }
     */
    function calibrationError(predictions, outcomes, numBins = 10) {
        if (predictions.length === 0) return { error: 0, byBin: [] };

        const bins = Array(numBins).fill(0).map(() => ({ preds: [], outcomes: [] }));

        for (let i = 0; i < predictions.length; i++) {
            const bin = Math.min(numBins - 1, Math.floor(predictions[i] * numBins));
            bins[bin].preds.push(predictions[i]);
            bins[bin].outcomes.push(outcomes[i]);
        }

        let totalError = 0;
        const byBin = bins
            .map((bin, idx) => {
                if (bin.preds.length === 0) return null;

                const avgPred = bin.preds.reduce((a, b) => a + b) / bin.preds.length;
                const avgOutcome = bin.outcomes.reduce((a, b) => a + b) / bin.outcomes.length;
                const error = Math.abs(avgPred - avgOutcome);
                totalError += error * bin.preds.length;

                return {
                    binIdx: idx,
                    pred: avgPred,
                    actual: avgOutcome,
                    count: bin.preds.length,
                    error: error,
                };
            })
            .filter(b => b !== null);

        return {
            error: totalError / predictions.length,
            byBin: byBin,
        };
    }

    /**
     * Population Stability Index (PSI)
     * Measures distribution shift between expected (baseline) and actual
     * PSI > 0.1 = significant shift, > 0.25 = major shift
     * 
     * @param {number[]} expected - baseline distribution (values)
     * @param {number[]} actual - current distribution (values)
     * @param {number} numBins - histogram bins (default 10)
     * @returns {number} PSI value
     */
    function populationStabilityIndex(expected, actual, numBins = 10) {
        if (!expected || !actual || expected.length === 0 || actual.length === 0) {
            return 0;
        }

        const minVal = Math.min(...expected, ...actual);
        const maxVal = Math.max(...expected, ...actual);
        const binWidth = (maxVal - minVal) / numBins || 1;

        const expectedDist = Array(numBins).fill(0);
        const actualDist = Array(numBins).fill(0);

        expected.forEach(val => {
            const bin = Math.floor((val - minVal) / binWidth);
            const idx = Math.min(numBins - 1, Math.max(0, bin));
            expectedDist[idx]++;
        });

        actual.forEach(val => {
            const bin = Math.floor((val - minVal) / binWidth);
            const idx = Math.min(numBins - 1, Math.max(0, bin));
            actualDist[idx]++;
        });

        // Normalize to probabilities
        const expProb = expectedDist.map(c => (c + 1) / (expected.length + numBins));
        const actProb = actualDist.map(c => (c + 1) / (actual.length + numBins));

        // Sum PSI across bins
        let psi = 0;
        for (let i = 0; i < numBins; i++) {
            psi += (actProb[i] - expProb[i]) * Math.log(actProb[i] / expProb[i]);
        }

        return psi;
    }

    /**
     * Kullback-Leibler Divergence
     * Asymmetric distance between two probability distributions
     * KL(P || Q) = sum(P(x) * log(P(x) / Q(x)))
     * 
     * @param {number[]} p - baseline distribution (probabilities, sums to 1)
     * @param {number[]} q - comparison distribution
     * @returns {number} KL divergence (0+ value)
     */
    function klDivergence(p, q) {
        if (!p || !q || p.length !== q.length) {
            throw new Error('klDivergence: arrays must have same length');
        }

        let kl = 0;
        for (let i = 0; i < p.length; i++) {
            if (p[i] > 1e-10) {  // avoid log(0)
                const qVal = Math.max(1e-10, q[i]);
                kl += p[i] * Math.log(p[i] / qVal);
            }
        }

        return kl;
    }

    /**
     * Entropy (information content of distribution)
     * H(X) = -sum(p(x) * log(p(x)))
     * Used for market uncertainty quantification
     * 
     * @param {number[]} probs - probability distribution (sums to ~1)
     * @returns {number} Entropy (bits if log2, nats if ln)
     */
    function entropy(probs) {
        let h = 0;
        for (let p of probs) {
            if (p > 1e-10) {
                h -= p * Math.log2(p);  // base-2: entropy in bits
            }
        }
        return h;
    }

    /**
     * Percentile calculation (linear interpolation)
     * @param {number[]} values - sorted array
     * @param {number} p - percentile (0-100)
     * @returns {number} percentile value
     */
    function percentile(values, p) {
        if (!values || values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const idx = (p / 100) * (sorted.length - 1);
        const lower = Math.floor(idx);
        const upper = Math.ceil(idx);
        const frac = idx - lower;

        if (lower === upper) return sorted[lower];
        return sorted[lower] * (1 - frac) + sorted[upper] * frac;
    }

    /**
     * Moving average (simple, exponential)
     * @param {number[]} values
     * @param {number} period - window size
     * @param {string} type - 'sma' or 'ema'
     * @returns {number[]} moving average
     */
    function movingAverage(values, period, type = 'sma') {
        if (!values || values.length === 0) return [];
        if (period <= 0) return values;

        if (type === 'sma') {
            const result = [];
            for (let i = 0; i < values.length; i++) {
                const start = Math.max(0, i - period + 1);
                const chunk = values.slice(start, i + 1);
                result.push(chunk.reduce((a, b) => a + b) / chunk.length);
            }
            return result;
        } else if (type === 'ema') {
            const result = [];
            const alpha = 2 / (period + 1);
            let ema = values[0];
            result.push(ema);

            for (let i = 1; i < values.length; i++) {
                ema = values[i] * alpha + ema * (1 - alpha);
                result.push(ema);
            }
            return result;
        }

        return values;
    }

    /**
     * Z-score normalization
     * @param {number[]} values
     * @returns {number[]} standardized values (mean=0, std=1)
     */
    function zscore(values) {
        if (values.length === 0) return [];

        const mean = values.reduce((a, b) => a + b) / values.length;
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2)) / values.length;
        const std = Math.sqrt(variance) || 1;

        return values.map(v => (v - mean) / std);
    }

    /**
     * Min-Max scaling
     * @param {number[]} values
     * @param {number} min - target min (default 0)
     * @param {number} max - target max (default 1)
     * @returns {number[]} scaled values
     */
    function minMaxScale(values, min = 0, max = 1) {
        if (values.length === 0) return [];
        const dataMin = Math.min(...values);
        const dataMax = Math.max(...values);
        const range = dataMax - dataMin || 1;

        return values.map(v => {
            const normalized = (v - dataMin) / range;
            return normalized * (max - min) + min;
        });
    }

    /**
     * Covariance between two series
     * @param {number[]} x
     * @param {number[]} y
     * @returns {number} covariance
     */
    function covariance(x, y) {
        if (x.length === 0 || x.length !== y.length) return 0;

        const meanX = x.reduce((a, b) => a + b) / x.length;
        const meanY = y.reduce((a, b) => a + b) / y.length;

        let cov = 0;
        for (let i = 0; i < x.length; i++) {
            cov += (x[i] - meanX) * (y[i] - meanY);
        }

        return cov / (x.length - 1 || 1);
    }

    /**
     * Pearson correlation coefficient
     * @param {number[]} x
     * @param {number[]} y
     * @returns {number} correlation [-1, 1]
     */
    function correlation(x, y) {
        if (x.length === 0 || x.length !== y.length) return 0;

        const meanX = x.reduce((a, b) => a + b) / x.length;
        const meanY = y.reduce((a, b) => a + b) / y.length;

        let numSum = 0;
        let denomX = 0;
        let denomY = 0;

        for (let i = 0; i < x.length; i++) {
            const dx = x[i] - meanX;
            const dy = y[i] - meanY;
            numSum += dx * dy;
            denomX += dx * dx;
            denomY += dy * dy;
        }

        const denom = Math.sqrt(denomX * denomY);
        return denom === 0 ? 0 : numSum / denom;
    }

    /**
     * ADWIN (Adaptive Windowing) — drift detector
     * Maintains adaptive window of recent events
     * Detects sudden changes in distribution
     * 
     * @param {number} value - new data point
     * @param {number} delta - significance level (default 0.002)
     * @returns {boolean} true if drift detected
     */
    class ADWINDetector {
        constructor(delta = 0.002) {
            this.delta = delta;
            this.buckets = [];  // [{size, sum, variance}]
            this.total = 0;
            this.count = 0;
            this.lastDriftTime = 0;
        }

        add(value) {
            this.buckets.push({
                size: 1,
                sum: value,
                var: 0,
            });
            this.total += value;
            this.count++;

            // Compress buckets when too many
            if (this.buckets.length > 100) {
                this.compress();
            }

            return this.detectChange();
        }

        detectChange() {
            if (this.buckets.length < 2) return false;

            let driftDetected = false;
            const m = this.buckets.length;

            // Check all splits (windowing strategy)
            for (let k = 1; k < m; k++) {
                const w0 = this.sumBuckets(0, k);
                const w1 = this.sumBuckets(k, m);

                if (w0.n === 0 || w1.n === 0) continue;

                const m0 = w0.sum / w0.n;
                const m1 = w1.sum / w1.n;
                const v0 = w0.var / w0.n;
                const v1 = w1.var / w1.n;

                const epsilon = Math.sqrt((1 / (2 * w0.n)) * Math.log(2 * m / this.delta)) +
                    Math.sqrt((1 / (2 * w1.n)) * Math.log(2 * m / this.delta));

                if (Math.abs(m0 - m1) > epsilon) {
                    driftDetected = true;
                    this.lastDriftTime = Date.now();
                    // Remove older bucket (w0)
                    this.buckets.splice(0, k);
                    break;
                }
            }

            return driftDetected;
        }

        sumBuckets(start, end) {
            let sum = 0, sumVar = 0, n = 0;
            for (let i = start; i < end; i++) {
                if (i < this.buckets.length) {
                    const b = this.buckets[i];
                    sum += b.sum;
                    sumVar += b.var;
                    n += b.size;
                }
            }
            return { sum, var: sumVar, n };
        }

        compress() {
            if (this.buckets.length <= 50) return;

            // Merge oldest two buckets
            const b0 = this.buckets[0];
            const b1 = this.buckets[1];

            const newSum = b0.sum + b1.sum;
            const newN = b0.size + b1.size;
            const newVar = b0.var + b1.var;

            this.buckets[0] = {
                size: newN,
                sum: newSum,
                var: newVar,
            };

            this.buckets.splice(1, 1);
        }
    }

    /**
     * Quantile-Quantile plot statistics (for normality testing)
     * @param {number[]} values
     * @returns {object} { skewness, kurtosis, normality_score }
     */
    function qqStats(values) {
        if (values.length < 3) return { skewness: 0, kurtosis: 0, normality: 0 };

        const sorted = [...values].sort((a, b) => a - b);
        const mean = sorted.reduce((a, b) => a + b) / sorted.length;
        const std = Math.sqrt(sorted.reduce((a, b) => a + Math.pow(b - mean, 2)) / sorted.length) || 1;

        // Skewness
        let skew = 0;
        for (let x of sorted) {
            skew += Math.pow((x - mean) / std, 3);
        }
        skew /= sorted.length;

        // Kurtosis (excess)
        let kurt = 0;
        for (let x of sorted) {
            kurt += Math.pow((x - mean) / std, 4);
        }
        kurt = (kurt / sorted.length) - 3;

        // Jarque-Bera normality test (0-1 score, 1 = normal)
        const jb = (sorted.length / 6) * (skew * skew + (kurt * kurt) / 4);
        const normality = Math.exp(-jb);  // rough approximation

        return {
            skewness: skew,
            kurtosis: kurt,
            normality_score: normality,
        };
    }

    // ── Expose API ──────────────────────────────────────────────────
    window.QuantStatUtils = {
        isotonicRegression,
        calibrationError,
        populationStabilityIndex,
        klDivergence,
        entropy,
        percentile,
        movingAverage,
        zscore,
        minMaxScale,
        covariance,
        correlation,
        ADWINDetector,
        qqStats,
    };

    console.log('[QuantStatUtils] Loaded: 14 utility functions');
})();
