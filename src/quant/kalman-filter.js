/**
 * ================================================================
 * Kalman Filter — Latent Trend Extraction
 * Separates signal (trend) from observation noise
 * State: [trend_level, trend_velocity]
 * ================================================================
 */

(function () {
    'use strict';

    class KalmanFilter {
        /**
         * Initialize 2-state Kalman filter for trend extraction
         * State: [level, velocity]
         * 
         * @param {object} config - {process_noise, observation_noise, initial_state, initial_cov}
         */
        constructor(config = {}) {
            // State vector: [level (trend), velocity (rate of change)]
            this.x = config.initial_state || [0, 0];

            // Covariance matrix (2x2) — uncertainty in state estimate
            this.P = config.initial_cov || [
                [1, 0],
                [0, 1],
            ];

            // Process noise covariance (Q) — model uncertainty
            // Higher Q = more trust in new data
            this.Q = config.process_noise || [
                [0.01, 0],
                [0, 0.001],
            ];

            // Observation noise variance (R) — measurement uncertainty
            // Higher R = more smoothing
            this.R = config.observation_noise || 0.1;

            // State transition matrix F
            // [level_t] = [1 dt] [level_t-1] + [process_noise]
            // [vel_t]   = [0 1 ] [vel_t-1]
            this.dt = 1;  // time step
            this.F = [
                [1, this.dt],
                [0, 1],
            ];

            // Observation matrix H — how we observe state
            // We only observe level, not velocity
            this.H = [1, 0];

            this.history = [];
            this.innovationHistory = [];
            this.gainHistory = [];

            console.log('[KalmanFilter] Trend extraction filter initialized');
        }

        /**
         * Multiply 2x2 matrix by 2x2 matrix
         */
        matmul2x2(A, B) {
            return [
                [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
                [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]],
            ];
        }

        /**
         * Multiply 2x2 matrix by 2x1 vector
         */
        matvec2x2(A, v) {
            return [
                A[0][0] * v[0] + A[0][1] * v[1],
                A[1][0] * v[0] + A[1][1] * v[1],
            ];
        }

        /**
         * Add two 2x2 matrices
         */
        matadd2x2(A, B) {
            return [
                [A[0][0] + B[0][0], A[0][1] + B[0][1]],
                [A[1][0] + B[1][0], A[1][1] + B[1][1]],
            ];
        }

        /**
         * Inverse of 2x2 matrix
         */
        matinv2x2(A) {
            const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
            if (Math.abs(det) < 1e-10) return [[1, 0], [0, 1]];

            return [
                [A[1][1] / det, -A[0][1] / det],
                [-A[1][0] / det, A[0][0] / det],
            ];
        }

        /**
         * Prediction step (time update)
         * x_pred = F * x
         * P_pred = F * P * F^T + Q
         */
        predict() {
            // Predict state
            const xPred = this.matvec2x2(this.F, this.x);

            // Predict covariance: P = F * P * F^T + Q
            const FP = this.matmul2x2(this.F, this.P);
            const FPF = this.matmul2x2(FP, [
                [this.F[0][0], this.F[1][0]],
                [this.F[0][1], this.F[1][1]],
            ]);

            const PPred = this.matadd2x2(FPF, this.Q);

            return { x: xPred, P: PPred };
        }

        /**
         * Update step (measurement update)
         * Incorporates new observation
         * 
         * @param {number} z - observed price/value
         * @returns {object} {level, velocity, innovation, gain}
         */
        update(z) {
            if (!Number.isFinite(z)) {
                const lastLevel = Number.isFinite(this.x[0]) ? this.x[0] : 0;
                return {
                    timestamp: Date.now(),
                    observation: z,
                    level: lastLevel,
                    velocity: this.x[1],
                    innovation: 0,
                    gain: [0, 0],
                    innovation_cov: this.R,
                    skipped: true,
                };
            }

            // Prediction
            const pred = this.predict();
            let xPred = pred.x;
            let PPred = pred.P;

            // Innovation (prediction error)
            // y = z - H * x_pred
            const zPred = this.H[0] * xPred[0] + this.H[1] * xPred[1];
            const innovation = z - zPred;

            // Innovation covariance
            // S = H * P * H^T + R
            const HPH = this.H[0] * PPred[0][0] * this.H[0] +
                this.H[0] * PPred[0][1] * this.H[1] +
                this.H[1] * PPred[1][0] * this.H[0] +
                this.H[1] * PPred[1][1] * this.H[1];
            const S = HPH + this.R;

            // Kalman gain
            // K = P * H^T / S
            const K = [
                (PPred[0][0] * this.H[0] + PPred[0][1] * this.H[1]) / S,
                (PPred[1][0] * this.H[0] + PPred[1][1] * this.H[1]) / S,
            ];

            // Update state
            // x = x_pred + K * innovation
            this.x = [
                xPred[0] + K[0] * innovation,
                xPred[1] + K[1] * innovation,
            ];

            // Update covariance
            // P = (I - K*H) * P_pred
            const IKH = [
                [1 - K[0] * this.H[0], -K[0] * this.H[1]],
                [-K[1] * this.H[0], 1 - K[1] * this.H[1]],
            ];

            this.P = this.matmul2x2(IKH, PPred);

            this.innovationHistory.push(innovation);
            this.gainHistory.push(K);

            const entry = {
                timestamp: Date.now(),
                observation: z,
                level: this.x[0],
                velocity: this.x[1],
                innovation: innovation,
                gain: K,
                innovation_cov: S,
            };

            this.history.push(entry);

            // Keep history bounded
            if (this.history.length > 1000) {
                this.history.shift();
                this.innovationHistory.shift();
                this.gainHistory.shift();
            }

            return entry;
        }

        step(observation) {
            return this.update(observation);
        }

        /**
         * Process sequence of observations
         * @param {number[]} observations - price/value series
         * @returns {object} {levels, velocities, innovations}
         */
        process(observations) {
            const levels = [];
            const velocities = [];
            const innovations = [];

            for (let obs of observations) {
                const result = this.update(obs);
                levels.push(result.level);
                velocities.push(result.velocity);
                innovations.push(result.innovation);
            }

            return {
                levels: levels,        // estimated trend
                velocities: velocities, // velocity
                innovations: innovations,  // residuals
                state_means: {
                    level: this.x[0],
                    velocity: this.x[1],
                },
            };
        }

        extractTrend(observations) {
            const result = this.process(observations || []);
            const levels = result.levels;
            const velocities = result.velocities;
            const lastLevel = levels.length > 0 ? levels[levels.length - 1] : this.x[0];
            const lastVelocity = velocities.length > 0 ? velocities[velocities.length - 1] : this.x[1];

            return {
                levels,
                velocities,
                innovations: result.innovations,
                level: lastLevel,
                velocity: lastVelocity,
                trendDirection: lastVelocity >= 0 ? 'UP' : 'DOWN',
                trendStrength: Math.min(1, Math.abs(lastVelocity)),
            };
        }

        setNoise(config = {}) {
            if (Array.isArray(config.process_noise) && config.process_noise.length === 2) {
                this.Q = config.process_noise;
            }
            if (Number.isFinite(config.observation_noise) && config.observation_noise > 0) {
                this.R = config.observation_noise;
            }
        }

        /**
         * Get current state estimate
         */
        getState() {
            return {
                level: this.x[0],
                velocity: this.x[1],
                covariance: this.P,
            };
        }

        /**
         * Adaptive noise tuning based on innovation statistics
         * If innovations are large/correlated, increase observation noise
         */
        tuneNoise() {
            if (this.innovationHistory.length < 20) return;

            const recent = this.innovationHistory.slice(-20);
            const mean = recent.reduce((a, b) => a + b) / recent.length;
            const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2)) / recent.length;

            // Auto-adjust observation noise
            if (variance > 2 * this.R) {
                this.R *= 1.1;  // Increase smoothing
            } else if (variance < 0.5 * this.R && this.R > 0.01) {
                this.R *= 0.95;  // Decrease smoothing
            }

            // Auto-adjust process noise (trust in model)
            const autocorr = this.computeAutocorrelation(recent, 1);
            if (autocorr > 0.7) {
                // High autocorrelation = trending, increase process noise slightly
                this.Q[0][0] = Math.min(this.Q[0][0] * 1.05, 0.05);
            }

            return {
                R: this.R,
                Q: this.Q,
            };
        }

        /**
         * Autocorrelation at lag k
         */
        computeAutocorrelation(series, lag) {
            if (series.length <= lag) return 0;

            const mean = series.reduce((a, b) => a + b) / series.length;
            let c0 = 0, ck = 0;

            for (let i = 0; i < series.length; i++) {
                c0 += Math.pow(series[i] - mean, 2);
            }

            for (let i = lag; i < series.length; i++) {
                ck += (series[i] - mean) * (series[i - lag] - mean);
            }

            return ck / c0;
        }

        /**
         * Signal-to-noise ratio (diagnostic)
         * Higher ratio = cleaner signal extraction
         */
        getSnr() {
            if (this.innovationHistory.length === 0) return 0;

            const innovations = this.innovationHistory.slice(-50);
            const noiseVar = innovations.reduce((a, b) => a + b * b) / innovations.length;

            const levels = this.history.slice(-50).map(h => h.level);
            const levelVar = levels.reduce((a, b, i, arr) => {
                if (i === 0) return 0;
                return a + Math.pow(levels[i] - levels[i - 1], 2);
            }) / Math.max(1, levels.length - 1);

            return levelVar > 0 ? 20 * Math.log10(levelVar / noiseVar) : 0;
        }

        /**
         * Export for backtesting
         */
        export() {
            return {
                state: this.x,
                covariance: this.P,
                history: this.history,
                snr: this.getSnr(),
            };
        }

        /**
         * Reset filter
         */
        reset() {
            this.x = [0, 0];
            this.P = [[1, 0], [0, 1]];
            this.history = [];
            this.innovationHistory = [];
            this.gainHistory = [];
        }
    }

    window.KalmanFilter = KalmanFilter;
    console.log('[KalmanFilter] Latent trend extraction filter loaded');
})();
