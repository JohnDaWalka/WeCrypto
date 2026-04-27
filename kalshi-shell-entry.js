/**
 * Kalshi 15-Min Entry: Shell-Based Only
 * 
 * Single source of truth: Ionization Shell States
 * 
 * BTC/ETH (7 shells):  -3, -2, -1, 0, +1, +2, +3
 * SOL (5 shells):      -2, -1, 0, +1, +2
 * 
 * Entry rule: If shell reaches ±3 (or ±2 for 5-shell coins), EXECUTE
 */

(function() {
  'use strict';

  window.KalshiShellEntry = window.KalshiShellEntry || {};

  /**
   * Per-coin shell configuration
   */
  const COIN_SHELL_CONFIG = {
    BTC: {
      shells: 7,
      maxShell: 3,
      entryThreshold: 3,      // Execute at Shell ±3
      confidence_3: 0.95,
      confidence_2: 0.80,
      confidence_1: 0.60
    },
    ETH: {
      shells: 7,
      maxShell: 3,
      entryThreshold: 3,
      confidence_3: 0.95,
      confidence_2: 0.80,
      confidence_1: 0.60
    },
    BNB: {
      shells: 7,
      maxShell: 3,
      entryThreshold: 3,
      confidence_3: 0.95,
      confidence_2: 0.80,
      confidence_1: 0.60
    },
    XRP: {
      shells: 5,
      maxShell: 2,
      entryThreshold: 2,      // Execute at Shell ±2 (no ±3 for 5-shell)
      confidence_2: 0.90,
      confidence_1: 0.70
    },
    SOL: {
      shells: 5,
      maxShell: 2,
      entryThreshold: 2,
      confidence_2: 0.90,
      confidence_1: 0.70
    },
    HYPE: {
      shells: 7,
      maxShell: 3,
      entryThreshold: 3,
      confidence_3: 0.95,
      confidence_2: 0.80,
      confidence_1: 0.60
    },
    DOGE: {
      shells: 7,
      maxShell: 3,
      entryThreshold: 3,
      confidence_3: 0.95,
      confidence_2: 0.80,
      confidence_1: 0.60
    }
  };

  /**
   * Main entry decision: Shell state only
   * 
   * @param {string} coin - BTC, ETH, SOL, etc
   * @param {number} shellState - -3 to +3
   * @param {number} baseConfidence - from shell model (0-100)
   * @returns {object} decision
   */
  function makeShellEntry(coin, shellState, baseConfidence) {
    const cfg = COIN_SHELL_CONFIG[coin];
    if (!cfg) {
      return { trade: false, reason: 'unknown_coin' };
    }

    const absShell = Math.abs(shellState);

    // Check if shell reached entry threshold
    if (absShell >= cfg.entryThreshold) {
      return {
        trade: true,
        reason: 'shell_threshold_reached',
        coin,
        shellState,
        shellCount: cfg.shells,
        baseConfidence,
        action: {
          direction: shellState > 0 ? 'YES' : 'NO',
          quantity: calculateQuantityFromShell(coin, absShell),
          confidence: baseConfidence
        }
      };
    }

    // Below threshold: don't trade
    return {
      trade: false,
      reason: 'below_shell_threshold',
      coin,
      shellState,
      threshold: cfg.entryThreshold,
      required: cfg.entryThreshold
    };
  }

  /**
   * Position sizing based on shell intensity
   * Higher shell = higher conviction = larger position
   */
  function calculateQuantityFromShell(coin, shellIntensity) {
    // shellIntensity: 0-3
    // 0: 1 contract (minimal)
    // 1: 2 contracts
    // 2: 3 contracts
    // 3: 5 contracts (max)
    const quantities = [1, 2, 3, 5];
    return quantities[Math.min(3, shellIntensity)] || 1;
  }

  /**
   * Validate coin configuration exists
   */
  function isValidCoin(coin) {
    return !!COIN_SHELL_CONFIG[coin];
  }

  /**
   * Get shell config for coin
   */
  function getConfig(coin) {
    return COIN_SHELL_CONFIG[coin];
  }

  /**
   * Get all configs
   */
  function getAllConfigs() {
    return COIN_SHELL_CONFIG;
  }

  // Export
  window.KalshiShellEntry = {
    makeShellEntry,
    calculateQuantityFromShell,
    isValidCoin,
    getConfig,
    getAllConfigs,
    COIN_SHELL_CONFIG
  };

  console.log('[KalshiShellEntry] Loaded — Shell-based entry framework active');
})();
