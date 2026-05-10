/**
 * ================================================================
 * Hurst Exponent — Trend vs Mean-Reversion Gate
 * Classify: TREND (H>0.6), MEAN_REVERT (H<0.4), RANDOM (0.4-0.6)
 * 
 * Hurst exponent measures persistence in time series:
 * H = 0.5: random walk (Brownian motion)
 * H > 0.5: trending (momentum)
 * H < 0.5: mean-reverting (anti-persistent)
 * ================================================================
 */

(function () {
    'use strict';

    class HurstExponent {
        /**
         * Constructor
         * @param {object} config - {min_window, max_window, adaptive_mode}
         */
        constructor(config = {}) {
            this.minWindow = config.min_window || 20;
            this.maxWindow = config.max_window || 200;
            this.adaptiveMode = config.adaptive_mode !== false;

            this.history = [];
            this.hurstHistory = [];
            this.regimeHistory = [];

            console.log('[HurstExponent] Initialized (adaptive=' + this.adaptiveMode + ')');
        }

        /**
         * Rescaled Range Analysis (Hurst)
         * Computes H for a given time series
         * 
         * @param {number[]} series - price or returns time series
         * @param {number} lag - window size for analysis (default 50)
         * @returns {number} Hurst exponent [0, 1]
         */
        compute(series, lag = 50) {
            if (!series || series.length < 20) {
                return 0.5;  // default random walk
            }

            const maxScale = Math.min(Math.max(8, lag), Math.floor(series.length / 2));
            const minScale = Math.max(8, Math.floor(maxScale / 4));
            const scales = [];
            for (let s = minScale; s <= maxScale; s = Math.floor(s * 1.5)) {
                if (scales.length === 0 || scales[scales.length - 1] !== s) {
                    scales.push(s);
                }
                if (s === maxScale) {
                    break;
                }
            }
            if (scales[scales.length - 1] !== maxScale) {
                scales.push(maxScale);
            }

            const x = [];
            const y = [];

            for (let i = 0; i < scales.length; i++) {
                const scale = scales[i];
                const nChunks = Math.floor(series.length / scale);
                if (nChunks < 2) {
                    continue;
                }

                let rsSum = 0;
                let rsCount = 0;
                for (let c = 0; c < nChunks; c++) {
                    const chunk = series.slice(c * scale, (c + 1) * scale);
                    const rsVal = this.computeRS(chunk);
                    if (Number.isFinite(rsVal) && rsVal > 0) {
                        rsSum += rsVal;
                        rsCount++;
                    }
                }

                if (rsCount > 0) {
                    x.push(Math.log(scale));
                    y.push(Math.log(rsSum / rsCount));
                }
            }

            if (x.length < 2) {
                return 0.5;
            }

            const h = this.regression(x, y);
            return Math.max(0, Math.min(1, h));
        }

        /**
         * Rescaled Range statistic for single chunk
         * R/S = (max(Y_t) - min(Y_t)) / std(returns)
         * 
         * @param {number[]} chunk - time series chunk
         * @returns {number} R/S value
         */
        computeRS(chunk) {
            if (chunk.length < 2) return 1;

            // Compute mean-adjusted returns
            const mean = chunk.reduce((a, b) => a + b) / chunk.length;
            const adjusted = chunk.map(x => x - mean);

            // Cumulative sum (Y_t)
            const Y = [];
            let cumsum = 0;
            for (let val of adjusted) {
                cumsum += val;
                Y.push(cumsum);
            }

            // Range: max(Y_t) - min(Y_t)
            const maxY = Math.max(...Y);
            const minY = Math.min(...Y);
            const R = maxY - minY;

            // Standard deviation
            const variance = chunk.reduce((a, b) => a + Math.pow(b - mean, 2)) / chunk.length;
            const S = Math.sqrt(variance) || 1e-6;

            return R / S;
        }

        /**
         * Simple linear regression (least squares)
         * y = a + b*x, return b (slope)
         */
        regression(x, y) {
            if (x.length === 0 || x.length !== y.length) return 0.5;

            const n = x.length;
            const meanX = x.reduce((a, b) => a + b) / n;
            const meanY = y.reduce((a, b) => a + b) / n;

            let numerator = 0;
            let denominator = 0;

            for (let i = 0; i < n; i++) {
                numerator += (x[i] - meanX) * (y[i] - meanY);
                denominator += (x[i] - meanX) * (x[i] - meanX);
            }

            return denominator !== 0 ? numerator / denominator : 0.5;
        }

        /**
         * Multi-scale Hurst analysis
         * Compute H across multiple lag scales, find dominant
         * 
         * @param {number[]} series - time series
         * @param {number[]} lags - array of lag windows to test
         * @returns {object} {hurst_by_lag, dominant_hurst, lag_distribution}
         */
        multiScale(series, lags = [10, 20, 30, 50, 75, 100]) {
            const results = {};

            for (let lag of lags) {
                if (lag < series.length / 2) {
                    results[lag] = this.compute(series, lag);
                }
            }

            // Find dominant lag (most stable H estimate)
            let dominant = 0.5;
            if (Object.keys(results).length > 0) {
                const values = Object.values(results);
                const mean = values.reduce((a, b) => a + b) / values.length;
                let minVar = Infinity;

                for (let lag of Object.keys(results)) {
                    const v = results[lag];
                    if (Math.abs(v - mean) < minVar) {
                        minVar = Math.abs(v - mean);
                        dominant = v;
                    }
                }
            }

            return {
                hurst_by_lag: results,
                dominant_hurst: dominant,
                lag_distribution: Object.keys(results).length,
            };
        }

        /**
         * Rolling Hurst with adaptive window
         * Uses optimal window based on recent volatility
         * 
         * @param {number[]} series - full price series
         * @param {number} fixedWindow - override window (optional)
         * @returns {number} current Hurst estimate
         */
        rolling(series, fixedWindow = null) {
            if (!series || series.length < this.minWindow) {
                return 0.5;
            }

            let window = fixedWindow;

            if (!window && this.adaptiveMode) {
                // Adaptive window: scale with volatility
                const recent = series.slice(-100);
                const returns = [];
                for (let i = 1; i < recent.length; i++) {
                    returns.push((recent[i] - recent[i - 1]) / recent[i - 1]);
                }

                const vol = Math.sqrt(returns.reduce((a, b) => a + b * b) / returns.length);
                window = Math.floor(this.minWindow + (vol * 100) * (this.maxWindow - this.minWindow));
                window = Math.min(Math.max(window, this.minWindow), this.maxWindow);
            } else if (!window) {
                window = Math.floor((this.minWindow + this.maxWindow) / 2);
            }

            const recentSeries = series.slice(-window);
            const lag = Math.max(10, Math.floor(window / 2));
            return this.compute(recentSeries, lag);
        }

        /**
         * Classify regime based on Hurst exponent
         * @param {number} h - Hurst exponent
         * @returns {object} {regime, strength, signal_gate}
         */
        classify(h) {
            let regime, strength, signal_gate;

            if (h > 0.6) {
                regime = 'TREND';
                strength = Math.min(1.0, (h - 0.5) * 5);  // 0.5-1.0 scale
                // Gate momentum signals (RSI, MACD)
                signal_gate = {
                    rsi_weight: 1.3,
                    macd_weight: 1.2,
                    fisher_weight: 0.7,
                    bollinger_weight: 0.8,
                };
            } else if (h < 0.4) {
                regime = 'MEAN_REVERT';
                strength = Math.min(1.0, (0.5 - h) * 5);
                // Gate mean-reversion signals
                signal_gate = {
                    rsi_weight: 1.0,
                    fisher_weight: 1.3,
                    bollinger_weight: 1.2,
                    macd_weight: 0.7,
                };
            } else {
                regime = 'RANDOM';
                strength = 0.5;
                // Balanced signal weighting
                signal_gate = {
                    rsi_weight: 1.0,
                    macd_weight: 1.0,
                    fisher_weight: 1.0,
                    bollinger_weight: 1.0,
                };
            }

            return {
                h: h,
                regime: regime,
                strength: strength,
                signal_gate: signal_gate,
            };
        }

        /**
         * Track Hurst over time (for drift detection)
         * 
         * @param {number[]} series - price series
         * @param {number} lookback - number of points to check
         * @returns {object} {current, trend, volatility, drift_score}
         */
        trend(series, lookback = 50) {
            if (!series || series.length < lookback + 10) {
                return {
                    current: 0.5,
                    trend: 'STABLE',
                    volatility: 0,
                    drift_score: 0,
                };
            }

            const recent = series.slice(-lookback);
            const older = series.slice(-lookback * 2, -lookback);

            const hurstRecent = this.rolling(recent);
            const hurstOlder = this.rolling(older);

            const trend = hurstRecent > hurstOlder ? 'INCREASING_PERSISTENCE' : 'DECREASING_PERSISTENCE';
            const volatility = Math.abs(hurstRecent - hurstOlder);
            const driftScore = volatility > 0.1 ? 1 : 0;  // significant drift threshold

            this.hurstHistory.push(hurstRecent);
            if (this.hurstHistory.length > 100) {
                this.hurstHistory.shift();
            }

            return {
                current: hurstRecent,
                older: hurstOlder,
                trend: trend,
                volatility: volatility,
                drift_score: driftScore,
            };
        }

        /**
         * Regime change detector
         * @returns {boolean} true if regime shifted significantly
         */
        regimeChanged() {
            if (this.hurstHistory.length < 2) return false;

            const current = this.hurstHistory[this.hurstHistory.length - 1];
            const prev = this.hurstHistory[this.hurstHistory.length - 2];

            // Different regimes?
            const currentReg = this.classify(current).regime;
            const prevReg = this.classify(prev).regime;

            return currentReg !== prevReg;
        }

        /**
         * Export state for persistence
         */
        export() {
            return {
                hurstHistory: this.hurstHistory,
                regimeHistory: this.regimeHistory,
            };
        }

        /**
         * Reset
         */
        reset() {
            this.history = [];
            this.hurstHistory = [];
            this.regimeHistory = [];
        }
    }

    window.HurstExponent = HurstExponent;
    console.log('[HurstExponent] Trend/mean-reversion classifier loaded');
})();
