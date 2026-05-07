/**
 * api-circuit-breaker.js — Circuit breaker pattern for API resilience
 *
 * Prevents cascade failures by temporarily disabling endpoints that are failing.
 * States: CLOSED (working) → OPEN (disabled) → HALF_OPEN (testing) → CLOSED
 *
 * Usage:
 *   const breaker = new CircuitBreaker('bybit-kline', { threshold: 5, timeout: 60000 });
 *   try {
 *     await breaker.execute(async () => fetch(url));
 *   } catch (err) {
 *     console.error('Circuit is OPEN, endpoint disabled');
 *   }
 */

(function () {
  'use strict';

  const States = {
    CLOSED: 'CLOSED',      // Normal operation
    OPEN: 'OPEN',          // Endpoint is down, reject all
    HALF_OPEN: 'HALF_OPEN' // Testing recovery
  };

  class CircuitBreaker {
    constructor(name, options = {}) {
      this.name = name;
      this.state = States.CLOSED;
      this.failureCount = 0;
      this.successCount = 0;
      this.failureThreshold = options.threshold || 5;
      this.successThreshold = options.successThreshold || 2;
      this.timeout = options.timeout || 60000; // 60 seconds
      this.lastFailureTime = null;
      this.nextRetryTime = null;
      this.halfOpenAttempts = 0;
    }

    /**
     * Execute an async operation with circuit breaker protection
     * @param {Function} fn - Async function to execute
     * @returns {Promise}
     */
    async execute(fn) {
      // If OPEN and timeout expired, try half-open
      if (this.state === States.OPEN) {
        if (Date.now() < this.nextRetryTime) {
          throw new Error(`[CircuitBreaker ${this.name}] OPEN: Endpoint disabled, retry at ${new Date(this.nextRetryTime).toISOString()}`);
        }
        this.state = States.HALF_OPEN;
        this.halfOpenAttempts = 0;
        console.warn(`[CircuitBreaker ${this.name}] Transitioning to HALF_OPEN, testing recovery...`);
      }

      try {
        const result = await fn();

        // Success
        if (this.state === States.HALF_OPEN) {
          this.successCount++;
          if (this.successCount >= this.successThreshold) {
            this.close();
          }
        } else {
          this.failureCount = 0;
        }

        return result;
      } catch (err) {
        this.recordFailure();
        throw err;
      }
    }

    /**
     * Record a failure and potentially trip the breaker
     */
    recordFailure() {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      this.successCount = 0;

      if (this.failureCount >= this.failureThreshold && this.state !== States.OPEN) {
        this.trip();
      }
    }

    /**
     * Trip the circuit breaker (CLOSED → OPEN)
     */
    trip() {
      this.state = States.OPEN;
      this.nextRetryTime = Date.now() + this.timeout;
      console.error(
        `[CircuitBreaker ${this.name}] TRIPPED after ${this.failureCount} failures. ` +
        `Endpoint disabled until ${new Date(this.nextRetryTime).toISOString()}`
      );
    }

    /**
     * Close the circuit breaker (restore to CLOSED)
     */
    close() {
      console.info(`[CircuitBreaker ${this.name}] Circuit CLOSED: Endpoint recovered ✓`);
      this.state = States.CLOSED;
      this.failureCount = 0;
      this.successCount = 0;
      this.halfOpenAttempts = 0;
      this.nextRetryTime = null;
    }

    /**
     * Get current state
     */
    getState() {
      return {
        state: this.state,
        failureCount: this.failureCount,
        successCount: this.successCount,
        lastFailureTime: this.lastFailureTime,
        nextRetryTime: this.nextRetryTime,
      };
    }

    /**
     * Reset the breaker
     */
    reset() {
      this.state = States.CLOSED;
      this.failureCount = 0;
      this.successCount = 0;
      this.halfOpenAttempts = 0;
      this.lastFailureTime = null;
      this.nextRetryTime = null;
    }

    /**
     * Check if circuit is available (not OPEN, or ready for half-open test)
     */
    isAvailable() {
      if (this.state === States.CLOSED) return true;
      if (this.state === States.OPEN && Date.now() >= this.nextRetryTime) return true; // Half-open test
      return false;
    }
  }

  // Registry of breakers by name
  const breakers = {
    'bybit-kline': new CircuitBreaker('bybit-kline', { threshold: 5, timeout: 60000 }),
    'bybit-orderbook': new CircuitBreaker('bybit-orderbook', { threshold: 5, timeout: 60000 }),
    'binance-futures': new CircuitBreaker('binance-futures', { threshold: 5, timeout: 120000 }),
    'coingecko-quotes': new CircuitBreaker('coingecko-quotes', { threshold: 10, timeout: 30000 }),
    'coinmarketcap-fear': new CircuitBreaker('coinmarketcap-fear', { threshold: 5, timeout: 120000 }),
    'blockcypher-doge': new CircuitBreaker('blockcypher-doge', { threshold: 5, timeout: 60000 }),
  };

  /**
   * Get or create a circuit breaker
   * @param {string} name - Name of breaker
   * @param {Object} options - Breaker options
   * @returns {CircuitBreaker}
   */
  function getBreaker(name, options) {
    if (!breakers[name]) {
      breakers[name] = new CircuitBreaker(name, options);
    }
    return breakers[name];
  }

  /**
   * Get all breaker statuses
   */
  function getStatus() {
    const status = {};
    Object.entries(breakers).forEach(([name, breaker]) => {
      status[name] = breaker.getState();
    });
    return status;
  }

  /**
   * Reset all breakers
   */
  function resetAll() {
    Object.values(breakers).forEach(b => b.reset());
    console.info('[CircuitBreaker] All breakers reset');
  }

  // ─── Export to window ───────────────────────────────────────────────────
  window.ApiCircuitBreaker = {
    getBreaker,
    getStatus,
    resetAll,
    CircuitBreaker,
    States,
  };

  console.info('[ApiCircuitBreaker] Loaded: Circuit breaker pattern for API resilience');
})();
