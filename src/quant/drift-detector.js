/**
 * ================================================================
 * Drift Detection Monitors
 * PSI, KL divergence, ADWIN for feature distribution shifts
 * ================================================================
 */

(function () {
    'use strict';

    class DriftDetector {
        constructor(config = {}) {
            this.featureNames = config.features || [
                'returns', 'volatility', 'orderflow_imbalance',
                'volume_ratio', 'funding_rate', 'skewness'
            ];

            this.baselineWindow = config.baseline_window || 100;
            this.monitorWindow = config.monitor_window || 50;
            this.psiThreshold = config.psi_threshold || 0.1;
            this.klThreshold = config.kl_threshold || 0.05;
            this.minSamplesForAlert = config.min_samples_for_alert || (this.baselineWindow + this.monitorWindow);

            // Historical data
            this.featureHistory = {};
            this.driftAlerts = [];
            this.adwinDetectors = {};

            for (let feat of this.featureNames) {
                this.featureHistory[feat] = [];
                this.adwinDetectors[feat] = new window.QuantStatUtils.ADWINDetector(0.002);
            }

            this.lastPSI = {};
            this.lastKL = {};

            console.log('[DriftDetector] Initialized for', this.featureNames.length, 'features');
        }

        /**
         * Add observation to detector
         * @param {object} features - {feature_name: value, ...}
         */
        observe(features) {
            for (let feat of this.featureNames) {
                if (feat in features) {
                    const val = features[feat];
                    this.featureHistory[feat].push(val);

                    // Bounded history
                    if (this.featureHistory[feat].length > this.baselineWindow * 3) {
                        this.featureHistory[feat].shift();
                    }

                    // ADWIN drift test
                    const driftDetected = this.adwinDetectors[feat].add(val);
                    if (driftDetected && this.featureHistory[feat].length >= this.minSamplesForAlert) {
                        this.recordAlert(feat, 'ADWIN', Date.now());
                    }
                }
            }

            // Periodic PSI + KL tests
            if (this.featureHistory[this.featureNames[0]].length >= this.baselineWindow + this.monitorWindow) {
                this.checkDistributionShift();
            }
        }

        /**
         * Check all distribution metrics
         */
        checkDistributionShift() {
            for (let feat of this.featureNames) {
                const hist = this.featureHistory[feat];
                if (hist.length < this.baselineWindow + this.monitorWindow) continue;

                const baseline = hist.slice(-this.baselineWindow - this.monitorWindow, -this.monitorWindow);
                const current = hist.slice(-this.monitorWindow);

                // PSI (Population Stability Index)
                const psi = window.QuantStatUtils.populationStabilityIndex(baseline, current, 10);
                this.lastPSI[feat] = psi;

                if (psi > this.psiThreshold) {
                    this.recordAlert(feat, 'PSI', Date.now(), { psi });
                }

                // KL Divergence
                const klDiv = this.klDivergence(baseline, current);
                this.lastKL[feat] = klDiv;

                if (klDiv > this.klThreshold) {
                    this.recordAlert(feat, 'KL', Date.now(), { kl: klDiv });
                }
            }
        }

        /**
         * Compute KL divergence between two distributions
         * Approximates via histogram
         */
        klDivergence(baseline, current, numBins = 10) {
            const minVal = Math.min(...baseline, ...current);
            const maxVal = Math.max(...baseline, ...current);
            const binWidth = (maxVal - minVal) / numBins || 1;

            const baselineHist = Array(numBins).fill(0);
            const currentHist = Array(numBins).fill(0);

            baseline.forEach(val => {
                const bin = Math.floor((val - minVal) / binWidth);
                const idx = Math.min(numBins - 1, Math.max(0, bin));
                baselineHist[idx]++;
            });

            current.forEach(val => {
                const bin = Math.floor((val - minVal) / binWidth);
                const idx = Math.min(numBins - 1, Math.max(0, bin));
                currentHist[idx]++;
            });

            // Normalize to probabilities (with Laplace smoothing)
            const baselineProb = baselineHist.map(c => (c + 1) / (baseline.length + numBins));
            const currentProb = currentHist.map(c => (c + 1) / (current.length + numBins));

            // KL(baseline || current)
            return window.QuantStatUtils.klDivergence(baselineProb, currentProb);
        }

        /**
         * Wasserstein distance (Earth Mover Distance)
         * Robust to distribution shifts
         */
        wasserstein(baseline, current) {
            const sorted1 = [...baseline].sort((a, b) => a - b);
            const sorted2 = [...current].sort((a, b) => a - b);

            const n = Math.max(sorted1.length, sorted2.length);
            const padded1 = sorted1.concat(Array(n - sorted1.length).fill(sorted1[sorted1.length - 1]));
            const padded2 = sorted2.concat(Array(n - sorted2.length).fill(sorted2[sorted2.length - 1]));

            let distance = 0;
            for (let i = 0; i < n; i++) {
                distance += Math.abs(padded1[i] - padded2[i]);
            }

            return distance / n;
        }

        /**
         * Kolmogorov-Smirnov test statistic
         * max |CDF1(x) - CDF2(x)|
         */
        ksTest(baseline, current) {
            const sorted1 = [...baseline].sort((a, b) => a - b);
            const sorted2 = [...current].sort((a, b) => a - b);

            const n1 = sorted1.length;
            const n2 = sorted2.length;

            let maxD = 0;
            let i = 0, j = 0;

            while (i < n1 && j < n2) {
                const cdf1 = (i + 1) / n1;
                const cdf2 = (j + 1) / n2;
                const d = Math.abs(cdf1 - cdf2);
                maxD = Math.max(maxD, d);

                if (sorted1[i] < sorted2[j]) {
                    i++;
                } else {
                    j++;
                }
            }

            // Remaining elements
            while (i < n1) {
                maxD = Math.max(maxD, Math.abs((i + 1) / n1));
                i++;
            }
            while (j < n2) {
                maxD = Math.max(maxD, Math.abs((j + 1) / n2));
                j++;
            }

            return maxD;
        }

        /**
         * Record drift alert
         */
        recordAlert(feature, testType, timestamp, metadata = {}) {
            this.driftAlerts.push({
                feature,
                test_type: testType,
                timestamp,
                ...metadata,
            });

            // Bounded alerts
            if (this.driftAlerts.length > 500) {
                this.driftAlerts.shift();
            }

            console.warn(`[DriftDetector] ALERT: ${feature} drift detected via ${testType}`, metadata);
        }

        /**
         * Get drift status for feature
         */
        getStatus(feature) {
            const hist = this.featureHistory[feature];
            if (!hist || hist.length < this.baselineWindow + this.monitorWindow) {
                return { status: 'insufficient_data', samples: hist ? hist.length : 0 };
            }

            const baseline = hist.slice(-this.baselineWindow - this.monitorWindow, -this.monitorWindow);
            const current = hist.slice(-this.monitorWindow);

            const psi = this.lastPSI[feature] || 0;
            const kl = this.lastKL[feature] || 0;
            if (baseline.length === 0 || current.length === 0) {
                return { status: 'insufficient_data', samples: hist.length };
            }

            const ks = this.ksTest(baseline, current);

            let status = 'STABLE';
            if (psi > this.psiThreshold || kl > this.klThreshold || ks > 0.15) {
                status = 'DRIFT_DETECTED';
            } else if (psi > this.psiThreshold * 0.5 || ks > 0.1) {
                status = 'WARNING';
            }

            return {
                feature,
                status,
                psi,
                kl,
                ks,
                baseline_mean: baseline.reduce((a, b) => a + b) / baseline.length,
                current_mean: current.reduce((a, b) => a + b) / current.length,
                baseline_std: this.computeStd(baseline),
                current_std: this.computeStd(current),
            };
        }

        /**
         * Overall drift status
         */
        overallStatus() {
            const statuses = this.featureNames.map(feat => this.getStatus(feat));

            const driftCount = statuses.filter(s => s.status === 'DRIFT_DETECTED').length;
            const warningCount = statuses.filter(s => s.status === 'WARNING').length;

            return {
                features: statuses,
                drift_count: driftCount,
                warning_count: warningCount,
                overall_status: driftCount > 2 ? 'MAJOR_DRIFT' : driftCount > 0 ? 'DRIFT' : 'STABLE',
                recent_alerts: this.driftAlerts.slice(-10),
            };
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
         * Reset detector
         */
        reset() {
            for (let feat of this.featureNames) {
                this.featureHistory[feat] = [];
                this.adwinDetectors[feat] = new window.QuantStatUtils.ADWINDetector(0.002);
            }
            this.driftAlerts = [];
            this.lastPSI = {};
            this.lastKL = {};
        }

        /**
         * Export state
         */
        export() {
            return {
                feature_history: this.featureHistory,
                drift_alerts: this.driftAlerts,
                overall_status: this.overallStatus(),
            };
        }
    }

    window.DriftDetector = DriftDetector;
    console.log('[DriftDetector] Loaded with PSI, KL, ADWIN, KS tests');
})();
