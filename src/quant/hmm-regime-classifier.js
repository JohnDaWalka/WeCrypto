/**
 * ================================================================
 * HMM Regime Classifier (4-State)
 * Detects market regimes: chop, trend, cascade, mania
 * Inputs: returns, realized_vol, orderflow_imbalance, funding_rate
 * Output: regime state assignments + transition matrix
 * ================================================================
 */

(function () {
    'use strict';

    class HMMRegimeClassifier {
        constructor() {
            this.states = ['CHOP', 'TREND', 'CASCADE', 'MANIA'];
            this.stateIdx = { CHOP: 0, TREND: 1, CASCADE: 2, MANIA: 3 };
            this.epsilon = 1e-12;

            // Initial state probabilities (uniform)
            this.pi = [0.25, 0.25, 0.25, 0.25];

            // Transition matrix (initialized, will be refined via Baum-Welch)
            this.A = [
                [0.70, 0.15, 0.10, 0.05],  // CHOP → {CHOP, TREND, CASCADE, MANIA}
                [0.10, 0.60, 0.15, 0.15],  // TREND → ...
                [0.05, 0.20, 0.60, 0.15],  // CASCADE → ...
                [0.10, 0.30, 0.20, 0.40],  // MANIA → ...
            ];

            // Observation model parameters (Gaussian for each state/feature combo)
            this.means = {
                CHOP: { returns: 0.0, vol: 0.010, orderflow: 0.0, fundingRate: 0.0001 },
                TREND: { returns: 0.008, vol: 0.012, orderflow: 0.30, fundingRate: 0.0002 },
                CASCADE: { returns: -0.020, vol: 0.035, orderflow: -0.50, fundingRate: -0.0003 },
                MANIA: { returns: 0.025, vol: 0.020, orderflow: 0.60, fundingRate: 0.0005 },
            };

            this.stds = {
                CHOP: { returns: 0.005, vol: 0.003, orderflow: 0.15, fundingRate: 0.0001 },
                TREND: { returns: 0.008, vol: 0.005, orderflow: 0.20, fundingRate: 0.0002 },
                CASCADE: { returns: 0.015, vol: 0.010, orderflow: 0.25, fundingRate: 0.0003 },
                MANIA: { returns: 0.020, vol: 0.008, orderflow: 0.30, fundingRate: 0.0004 },
            };

            this.history = [];
            this.lastViterbiPath = [];
            this.normalizeTransitionMatrix();

            console.log('[HMM] 4-state regime classifier initialized');
        }

        normalizeTransitionMatrix() {
            const m = this.states.length;
            for (let i = 0; i < m; i++) {
                const row = this.A[i] || [];
                let sum = 0;
                for (let j = 0; j < m; j++) {
                    const val = Number.isFinite(row[j]) ? row[j] : 0;
                    this.A[i][j] = Math.max(this.epsilon, val);
                    sum += this.A[i][j];
                }
                if (sum <= this.epsilon) {
                    for (let j = 0; j < m; j++) {
                        this.A[i][j] = 1 / m;
                    }
                } else {
                    for (let j = 0; j < m; j++) {
                        this.A[i][j] /= sum;
                    }
                }
            }
        }

        sanitizeObservation(obs) {
            const fallback = { returns: 0, vol: 0.01, orderflow: 0, fundingRate: 0 };
            const safe = {};
            const features = ['returns', 'vol', 'orderflow', 'fundingRate'];
            for (let i = 0; i < features.length; i++) {
                const feat = features[i];
                const val = obs && Number.isFinite(obs[feat]) ? obs[feat] : fallback[feat];
                safe[feat] = val;
            }
            return safe;
        }

        /**
         * Gaussian PDF
         * @param {number} x - observation
         * @param {number} mean - state mean
         * @param {number} std - state std dev
         * @returns {number} probability density
         */
        gaussianPdf(x, mean, std) {
            if (std === 0) std = 1e-6;
            const variance = std * std;
            const coeff = 1 / Math.sqrt(2 * Math.PI * variance);
            const exponent = -Math.pow(x - mean, 2) / (2 * variance);
            return coeff * Math.exp(exponent);
        }

        /**
         * Observation probability: P(obs | state)
         * Assumes feature independence
         * 
         * @param {object} obs - { returns, vol, orderflow, fundingRate }
         * @param {string} state - CHOP|TREND|CASCADE|MANIA
         * @returns {number} likelihood
         */
        observationPdf(obs, state) {
            const safeObs = this.sanitizeObservation(obs);
            const mean = this.means[state];
            const std = this.stds[state];

            // Multivariate Gaussian with independence assumption
            const features = ['returns', 'vol', 'orderflow', 'fundingRate'];
            let likelihood = 1;

            for (let feat of features) {
                const pf = this.gaussianPdf(safeObs[feat], mean[feat], std[feat]);
                likelihood *= Math.max(this.epsilon, pf);
            }

            return Math.max(this.epsilon, likelihood);
        }

        /**
         * Forward algorithm (Alpha pass)
         * Computes forward probabilities for sequence
         * 
         * @param {array} obsSeq - observations [{returns, vol, orderflow, fundingRate}, ...]
         * @returns {array} alpha[t][s] = P(O_1...O_t, Q_t=s | model)
         */
        forwardPass(obsSeq) {
            const n = obsSeq.length;
            const m = this.states.length;
            const alpha = Array(n).fill(0).map(() => Array(m).fill(0));

            // t=0
            for (let j = 0; j < m; j++) {
                alpha[0][j] = this.pi[j] * this.observationPdf(obsSeq[0], this.states[j]);
            }

            // t=1..n-1
            for (let t = 1; t < n; t++) {
                for (let j = 0; j < m; j++) {
                    let sum = 0;
                    for (let i = 0; i < m; i++) {
                        sum += alpha[t - 1][i] * this.A[i][j];
                    }
                    alpha[t][j] = sum * this.observationPdf(obsSeq[t], this.states[j]);
                }
            }

            return alpha;
        }

        /**
         * Backward algorithm (Beta pass)
         * @param {array} obsSeq - observations
         * @returns {array} beta[t][s]
         */
        backwardPass(obsSeq) {
            const n = obsSeq.length;
            const m = this.states.length;
            const beta = Array(n).fill(0).map(() => Array(m).fill(0));

            // t=n-1
            for (let j = 0; j < m; j++) {
                beta[n - 1][j] = 1;
            }

            // t=n-2..0
            for (let t = n - 2; t >= 0; t--) {
                for (let i = 0; i < m; i++) {
                    let sum = 0;
                    for (let j = 0; j < m; j++) {
                        sum += this.A[i][j] * this.observationPdf(obsSeq[t + 1], this.states[j]) * beta[t + 1][j];
                    }
                    beta[t][i] = sum;
                }
            }

            return beta;
        }

        /**
         * Viterbi algorithm
         * Finds most likely state sequence given observations
         * 
         * @param {array} obsSeq - observations
         * @returns {object} { path: [state_idx, ...], likelihood: }
         */
        viterbi(obsSeq) {
            const n = obsSeq.length;
            const m = this.states.length;

            const delta = Array(n).fill(0).map(() => Array(m).fill(-Infinity));
            const psi = Array(n).fill(0).map(() => Array(m).fill(0));

            // t=0
            for (let j = 0; j < m; j++) {
                const pi = Math.max(this.epsilon, this.pi[j]);
                const emit = Math.max(this.epsilon, this.observationPdf(obsSeq[0], this.states[j]));
                delta[0][j] = Math.log(pi) + Math.log(emit);
                psi[0][j] = 0;
            }

            // t=1..n-1
            for (let t = 1; t < n; t++) {
                for (let j = 0; j < m; j++) {
                    let maxVal = -Infinity;
                    let argmax = 0;

                    for (let i = 0; i < m; i++) {
                        const trans = Math.max(this.epsilon, this.A[i][j]);
                        const val = delta[t - 1][i] + Math.log(trans);
                        if (val > maxVal || (val === maxVal && i < argmax)) {
                            maxVal = val;
                            argmax = i;
                        }
                    }

                    const emit = Math.max(this.epsilon, this.observationPdf(obsSeq[t], this.states[j]));
                    delta[t][j] = maxVal + Math.log(emit);
                    psi[t][j] = argmax;
                }
            }

            // Backtrack
            const path = Array(n);
            let maxState = 0;
            let maxProb = delta[n - 1][0];

            for (let j = 1; j < m; j++) {
                if (delta[n - 1][j] > maxProb) {
                    maxProb = delta[n - 1][j];
                    maxState = j;
                }
            }

            path[n - 1] = maxState;
            for (let t = n - 2; t >= 0; t--) {
                path[t] = psi[t + 1][path[t + 1]];
            }

            return {
                path: path,
                likelihood: Math.exp(maxProb),
                logLikelihood: maxProb,
                lastLogProbs: delta[n - 1].slice(),
            };
        }

        /**
         * Baum-Welch EM algorithm
         * Refines transition matrix and observation parameters from data
         * (Simplified version: updates transition matrix only)
         * 
         * @param {array} obsSeq - observations
         * @param {number} maxIter - EM iterations (default 5)
         */
        baumWelch(obsSeq, maxIter = 5) {
            for (let iter = 0; iter < maxIter; iter++) {
                const alpha = this.forwardPass(obsSeq);
                const beta = this.backwardPass(obsSeq);

                const n = obsSeq.length;
                const m = this.states.length;

                // Compute gammas
                const gamma = Array(n).fill(0).map(() => Array(m).fill(0));
                for (let t = 0; t < n; t++) {
                    let sum = 0;
                    for (let j = 0; j < m; j++) {
                        gamma[t][j] = alpha[t][j] * beta[t][j];
                        sum += gamma[t][j];
                    }
                    if (sum > 0) {
                        for (let j = 0; j < m; j++) {
                            gamma[t][j] /= sum;
                        }
                    }
                }

                // Update transition matrix
                const newA = Array(m).fill(0).map(() => Array(m).fill(0));

                for (let i = 0; i < m; i++) {
                    for (let j = 0; j < m; j++) {
                        let num = 0;
                        let den = 0;

                        for (let t = 0; t < n - 1; t++) {
                            const xi = (gamma[t][i] * this.A[i][j] * this.observationPdf(obsSeq[t + 1], this.states[j]) * beta[t + 1][j]) / (alpha[t + 1][j] + 1e-10);
                            num += xi;
                            den += gamma[t][i];
                        }

                        newA[i][j] = den > 1e-10 ? num / den : this.A[i][j];
                    }
                }

                // Normalize rows
                for (let i = 0; i < m; i++) {
                    const sum = newA[i].reduce((a, b) => a + b);
                    if (sum > 0) {
                        for (let j = 0; j < m; j++) {
                            newA[i][j] /= sum;
                        }
                    }
                }

                this.A = newA;
            }

            console.log('[HMM] Baum-Welch EM completed, transition matrix updated');
        }

        /**
         * Classify single observation window
         * 
         * @param {array} obsSeq - recent observations [{returns, vol, orderflow, fundingRate}, ...]
         * @returns {object} { regime: state, confidence: 0-1, viterbi_path: [...], }
         */
        classify(obsSeq) {
            if (!obsSeq || obsSeq.length === 0) {
                return {
                    regime: 'CHOP',
                    confidence: 0,
                    path: [],
                    stateProbs: [0.25, 0.25, 0.25, 0.25],
                };
            }

            // Viterbi decoding
            const viterbi = this.viterbi(obsSeq);
            const currentState = viterbi.path[viterbi.path.length - 1];

            const smoothedProbs = (() => {
                const logs = viterbi.lastLogProbs || [];
                if (logs.length !== 4) {
                    return [0.25, 0.25, 0.25, 0.25];
                }

                const maxLog = Math.max(...logs);
                const exps = logs.map(v => Math.exp(v - maxLog));
                const sum = exps.reduce((a, b) => a + b, 0);
                if (!(sum > 0)) {
                    return [0.25, 0.25, 0.25, 0.25];
                }
                return exps.map(v => v / sum);
            })();

            const confidence = Math.max(...smoothedProbs);

            this.lastViterbiPath = viterbi.path;

            return {
                regime: this.states[currentState],
                regime_idx: currentState,
                confidence: confidence,
                state_probs: smoothedProbs,  // [P(CHOP), P(TREND), P(CASCADE), P(MANIA)]
                viterbi_path: viterbi.path.map(idx => this.states[idx]),
                likelihood: viterbi.likelihood,
            };
        }

        /**
         * Track regime transitions
         * @param {array} obsSeq - observations over time
         * @returns {object} stats on state transitions
         */
        transitionAnalysis(obsSeq) {
            if (!obsSeq || obsSeq.length < 2) return null;

            const viterbi = this.viterbi(obsSeq);
            const path = viterbi.path;

            const transitionCounts = Array(4).fill(0).map(() => Array(4).fill(0));

            for (let i = 0; i < path.length - 1; i++) {
                transitionCounts[path[i]][path[i + 1]]++;
            }

            // Convert to probabilities
            const transitionProbs = Array(4).fill(0).map(() => Array(4).fill(0));
            for (let i = 0; i < 4; i++) {
                const total = transitionCounts[i].reduce((a, b) => a + b);
                if (total > 0) {
                    for (let j = 0; j < 4; j++) {
                        transitionProbs[i][j] = transitionCounts[i][j] / total;
                    }
                }
            }

            // State duration analysis
            const stateDurations = {};
            this.states.forEach(s => stateDurations[s] = []);

            let currentState = path[0];
            let duration = 1;

            for (let i = 1; i < path.length; i++) {
                if (path[i] === currentState) {
                    duration++;
                } else {
                    stateDurations[this.states[currentState]].push(duration);
                    currentState = path[i];
                    duration = 1;
                }
            }
            stateDurations[this.states[currentState]].push(duration);

            // Compute average durations
            const avgDurations = {};
            this.states.forEach(s => {
                const durs = stateDurations[s];
                if (durs.length > 0) {
                    avgDurations[s] = durs.reduce((a, b) => a + b) / durs.length;
                } else {
                    avgDurations[s] = 0;
                }
            });

            return {
                transition_matrix: transitionProbs,
                state_durations: stateDurations,
                avg_durations: avgDurations,
                state_counts: path.reduce((acc, s) => {
                    const state = this.states[s];
                    acc[state] = (acc[state] || 0) + 1;
                    return acc;
                }, {}),
            };
        }

        /**
         * Persistence: save/load model
         */
        save() {
            return {
                A: this.A,
                pi: this.pi,
                means: this.means,
                stds: this.stds,
            };
        }

        load(checkpoint) {
            if (checkpoint.A) this.A = checkpoint.A;
            if (checkpoint.pi) this.pi = checkpoint.pi;
            if (checkpoint.means) this.means = checkpoint.means;
            if (checkpoint.stds) this.stds = checkpoint.stds;
        }
    }

    window.HMMRegimeClassifier = HMMRegimeClassifier;
    console.log('[HMMRegimeClassifier] Loaded');
})();
