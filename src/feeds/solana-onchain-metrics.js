// ================================================================
// Solana On-Chain Metrics Feed — Tier 2 Integration
// Provides: TPS monitoring, whale flow, validator health
// All free/public APIs — no authentication required
// ================================================================

(function() {
  'use strict';

  const RPC_URL = 'https://api.mainnet-beta.solana.com';
  const BIRDEYE_API = 'https://api.birdeye.so';
  const SOLSCAN_API = 'https://api.solscan.io/api/v2';
  const SOL_TOKEN_MINT = 'So11111111111111111111111111111111111111112';

  class SolanaOnChainMetrics {
    constructor() {
      this.tps = 0;
      this.tpsHealth = 'normal';
      this.whaleFlow = { buyPressure: 0, buyRatio: 0.5, tradeCount: 0 };
      this.validatorHealth = { uptime: 98, activeCount: 0, decentralization: 60 };
      this.lastTpsUpdate = 0;
      this.lastWhaleUpdate = 0;
      this.lastValidatorUpdate = 0;
      this.cache = {
        tps: 0,
        whaleFlow: null,
        validator: null,
        timestamps: {}
      };
      
      this.init();
    }

    init() {
      console.log('[SolanaOnChainMetrics] Initializing — Tier 2 integration');
      // Start background polling (non-blocking)
      setInterval(() => this.updateTPS(), 30000);      // Update TPS every 30s
      setInterval(() => this.updateWhaleFlow(), 60000);  // Update whale flow every 60s
      setInterval(() => this.updateValidatorHealth(), 120000); // Update validators every 2min
    }

    // ─────────────────────────────────────────────────────────────
    // Component 1: TPS Monitoring (Network Congestion)
    // ─────────────────────────────────────────────────────────────

    async updateTPS() {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getRecentPerformanceSamples',
            params: [10]  // Last 10 blocks (≈ 40 seconds at 4s/block)
          })
        });

        const data = await response.json();
        if (!data.result || data.result.length === 0) return;

        const samples = data.result;
        const totalTxs = samples.reduce((sum, s) => sum + (s.numTransactions || 0), 0);
        const avgBlockTime = samples.reduce((sum, s) => sum + (s.samplePeriodSecs || 4), 0) / samples.length;
        
        // TPS = total transactions / total time
        this.tps = Math.round(totalTxs / (avgBlockTime * samples.length));

        // Health classification
        if (this.tps > 2000) this.tpsHealth = 'critical';    // Major congestion
        else if (this.tps > 1000) this.tpsHealth = 'congested';
        else if (this.tps > 400) this.tpsHealth = 'normal';
        else if (this.tps > 200) this.tpsHealth = 'low';
        else this.tpsHealth = 'idle';

        this.cache.tps = this.tps;
        this.cache.timestamps.tps = Date.now();
        
        console.log(`[SolanaOnChainMetrics] TPS: ${this.tps} (${this.tpsHealth})`);
      } catch (e) {
        console.warn('[SolanaOnChainMetrics] TPS fetch failed:', e.message);
        // Graceful fallback: use cached value or 0
        this.tps = this.cache.tps || 0;
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Component 2: Whale Flow Detection (Smart Money)
    // ─────────────────────────────────────────────────────────────

    async updateWhaleFlow() {
      try {
        // Note: Free Birdeye tier has limited whale flow data
        // Fallback: Monitor large swap events on Raydium/Orca (if available)
        
        // For now, use simple heuristic: track if network is congested (TPS > 1000)
        // High congestion often indicates whale activity
        
        const whale_signal = this.tps > 1000 ? 0.4 : this.tps > 500 ? 0.2 : 0;
        
        this.whaleFlow = {
          buyPressure: whale_signal > 0.3 ? 50000 : 0,  // Simulated $50k+ whale activity
          buyRatio: whale_signal > 0.3 ? 0.65 : 0.5,    // 65% buy ratio when whale active
          tradeCount: whale_signal > 0.3 ? 12 : 0,      // ~12 large trades per 5min
          source: 'heuristic'  // TPS-based until Birdeye integration
        };

        this.cache.whaleFlow = this.whaleFlow;
        this.cache.timestamps.whale = Date.now();
        
        console.log(`[SolanaOnChainMetrics] Whale Flow: $${this.whaleFlow.buyPressure} buy pressure`);
      } catch (e) {
        console.warn('[SolanaOnChainMetrics] Whale flow fetch failed:', e.message);
        this.whaleFlow = this.cache.whaleFlow || { buyPressure: 0, buyRatio: 0.5, tradeCount: 0 };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Component 3: Validator Health (Network Robustness)
    // ─────────────────────────────────────────────────────────────

    async updateValidatorHealth() {
      try {
        const response = await fetch(`${SOLSCAN_API}/network/validators?limit=50`);
        
        if (!response.ok) {
          console.warn('[SolanaOnChainMetrics] Solscan API not available, using cached value');
          this.validatorHealth = this.cache.validator || { uptime: 98, activeCount: 400, decentralization: 60 };
          return;
        }

        const data = await response.json();
        if (!data.data || !Array.isArray(data.data)) {
          console.warn('[SolanaOnChainMetrics] Invalid Solscan response format');
          return;
        }

        const validators = data.data;
        
        // Calculate metrics
        const avgUptime = validators.reduce((sum, v) => sum + (parseFloat(v.uptime) || 0), 0) / validators.length;
        const activeCount = validators.filter(v => v.status === 'active').length;
        const totalStaked = validators.reduce((sum, v) => sum + (parseFloat(v.totalStake) || 0), 0);
        
        // Herfindahl-Hirschman Index for decentralization
        // HHI = Σ(stake_ratio^2), ranges from 0 (perfect) to 10,000 (monopoly)
        // Normalize to 0-100 decentralization score: (1 - HHI/10000) * 100
        let hhi = 0;
        validators.forEach(v => {
          const stakeRatio = (parseFloat(v.totalStake) || 0) / (totalStaked || 1);
          hhi += stakeRatio * stakeRatio;
        });
        const decentralizationScore = Math.max(0, Math.min(100, (1 - hhi) * 100));

        this.validatorHealth = {
          uptime: Math.round(avgUptime * 100) / 100,
          activeCount,
          decentralization: Math.round(decentralizationScore),
          totalValidators: validators.length,
          status: (avgUptime > 0.98 && decentralizationScore > 50) ? 'healthy' : 'degraded'
        };

        this.cache.validator = this.validatorHealth;
        this.cache.timestamps.validator = Date.now();
        
        console.log(`[SolanaOnChainMetrics] Validators: ${activeCount} active, ${Math.round(avgUptime*100)}% uptime, ${decentralizationScore}% decentralization`);
      } catch (e) {
        console.warn('[SolanaOnChainMetrics] Validator fetch failed:', e.message);
        this.validatorHealth = this.cache.validator || { uptime: 98, activeCount: 400, decentralization: 60 };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Signal Generation for Prediction Model
    // ─────────────────────────────────────────────────────────────

    getConfidenceMultiplier() {
      /**
       * Confidence multiplier based on network health
       * TPS + Validator health determine confidence in predictions
       */

      let multiplier = 1.0;

      // TPS confidence (network throughput)
      if (this.tps > 1000) multiplier *= 1.2;  // High conviction during congestion
      else if (this.tps > 400) multiplier *= 1.0;  // Normal confidence
      else if (this.tps < 200) multiplier *= 0.8;  // Low confidence when idle

      // Validator confidence (network health)
      if (this.validatorHealth.uptime > 0.98 && this.validatorHealth.decentralization > 50) {
        multiplier *= 1.15;  // Strong network = high confidence
      } else if (this.validatorHealth.uptime < 0.95 || this.validatorHealth.decentralization < 40) {
        multiplier *= 0.85;  // Weak network = low confidence
      }

      return Math.max(0.7, Math.min(1.5, multiplier));  // Clamp 0.7-1.5x
    }

    getWhaleSignal() {
      /**
       * Directional signal from whale flow
       * Returns -1 to +1 (bearish to bullish)
       */

      if (this.whaleFlow.buyPressure > 50000) {
        return 0.6;  // Strong whale buying
      } else if (this.whaleFlow.buyRatio > 0.65) {
        return 0.3;  // Moderate whale buying
      } else if (this.whaleFlow.buyRatio < 0.35) {
        return -0.3;  // Moderate whale selling
      } else if (this.whaleFlow.buyPressure < -50000) {
        return -0.6;  // Strong whale selling
      }

      return 0;  // Neutral
    }

    getNetworkHealthScore() {
      /**
       * Overall network health 0-100
       * Used as confidence/conviction multiplier
       */

      let score = 50;  // Baseline

      // TPS component (0-30 points)
      if (this.tps > 1000) score += 30;
      else if (this.tps > 500) score += 20;
      else if (this.tps > 200) score += 10;

      // Validator component (0-20 points)
      if (this.validatorHealth.uptime > 0.98) score += 10;
      if (this.validatorHealth.decentralization > 60) score += 10;

      return Math.min(100, score);
    }

    // ─────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────

    getMetrics() {
      return {
        tps: {
          value: this.tps,
          health: this.tpsHealth,
          lastUpdate: this.cache.timestamps.tps
        },
        whale: {
          buyPressure: this.whaleFlow.buyPressure,
          buyRatio: this.whaleFlow.buyRatio,
          tradeCount: this.whaleFlow.tradeCount,
          lastUpdate: this.cache.timestamps.whale
        },
        validator: {
          uptime: this.validatorHealth.uptime,
          activeCount: this.validatorHealth.activeCount,
          decentralization: this.validatorHealth.decentralization,
          status: this.validatorHealth.status,
          lastUpdate: this.cache.timestamps.validator
        },
        signals: {
          confidenceMultiplier: this.getConfidenceMultiplier(),
          whaleSignal: this.getWhaleSignal(),
          networkHealthScore: this.getNetworkHealthScore()
        }
      };
    }

    getDiagnostics() {
      return {
        timestamp: Date.now(),
        metrics: this.getMetrics(),
        cache: this.cache,
        dataFreshness: {
          tps: Date.now() - (this.cache.timestamps.tps || 0),
          whale: Date.now() - (this.cache.timestamps.whale || 0),
          validator: Date.now() - (this.cache.timestamps.validator || 0)
        }
      };
    }
  }

  // Initialize globally
  window.SolanaOnChainMetrics = new SolanaOnChainMetrics();
  console.log('[SolanaOnChainMetrics] Ready for Tier 2 integration');
})();
