/**
 * api-rate-limiter.js — Global rate limiter with token bucket algorithm
 *
 * Provides token bucket rate limiting for APIs to prevent 429 errors.
 * Each API has configurable requests-per-second limit.
 *
 * Usage:
 *   const limiter = new RateLimiter('coingecko', 8);  // 8 req/sec
 *   await limiter.acquire();
 *   const response = await fetch(url);
 */

(function () {
  'use strict';

  class RateLimiter {
    constructor(name, requestsPerSecond) {
      this.name = name;
      this.rps = requestsPerSecond || 10;
      this.tokens = this.rps;
      this.lastRefill = Date.now();
      this.waitQueue = [];
    }

    /**
     * Acquire a token, waiting if necessary
     * @returns {Promise<void>}
     */
    async acquire() {
      return new Promise((resolve) => {
        const now = Date.now();
        const timePassed = (now - this.lastRefill) / 1000;
        
        // Refill tokens based on time passed
        this.tokens = Math.min(this.rps, this.tokens + timePassed * this.rps);
        this.lastRefill = now;

        if (this.tokens >= 1) {
          // Immediate acquisition
          this.tokens -= 1;
          resolve();
        } else {
          // Queue for later
          const waitTime = (1 - this.tokens) * 1000 / this.rps;
          setTimeout(() => {
            this.tokens = Math.min(this.rps, Date.now() - this.lastRefill);
            this.tokens -= 1;
            resolve();
          }, Math.ceil(waitTime));
        }
      });
    }

    /**
     * Get current queue length
     */
    getQueueLength() {
      return this.waitQueue.length;
    }

    /**
     * Get available tokens
     */
    getAvailableTokens() {
      return Math.max(0, Math.floor(this.tokens));
    }

    /**
     * Reset limiter
     */
    reset() {
      this.tokens = this.rps;
      this.lastRefill = Date.now();
      this.waitQueue = [];
    }
  }

  // Registry of all limiters by name
  const limiters = {
    'coingecko': new RateLimiter('coingecko', 8),      // 10 req/sec official, 8 conservative
    'coinmarketcap': new RateLimiter('coinmarketcap', 14), // ~30 req/min, = ~0.5 req/sec, but burst to 14
    'binance': new RateLimiter('binance', 10),         // 1200 req/min = 20 req/sec
    'bybit': new RateLimiter('bybit', 10),             // 50 req/sec
    'kraken': new RateLimiter('kraken', 15),           // 15 req/sec public
    'blockcypher': new RateLimiter('blockcypher', 3),  // 200 req/hr free = ~0.056 req/sec
    'blockscout': new RateLimiter('blockscout', 10),   // 5 req/sec default
    'chainso': new RateLimiter('chainso', 5),          // 5 req/sec
    'default': new RateLimiter('default', 5),          // Conservative default
  };

  /**
   * Get or create a rate limiter for an API
   * @param {string} apiName - Name of API
   * @param {number} rps - Requests per second (optional)
   * @returns {RateLimiter}
   */
  function getLimiter(apiName, rps) {
    if (!limiters[apiName]) {
      limiters[apiName] = new RateLimiter(apiName, rps || 5);
    }
    return limiters[apiName];
  }

  /**
   * Acquire token from limiter, with automatic API name detection
   * @param {string} apiName - Name of API
   * @returns {Promise<void>}
   */
  async function acquireToken(apiName) {
    const limiter = getLimiter(apiName);
    await limiter.acquire();
  }

  /**
   * Get status of all limiters (for debugging)
   */
  function getStatus() {
    const status = {};
    Object.entries(limiters).forEach(([name, limiter]) => {
      status[name] = {
        availableTokens: limiter.getAvailableTokens(),
        rps: limiter.rps,
        queueLength: limiter.getQueueLength(),
      };
    });
    return status;
  }

  // ─── Export to window ───────────────────────────────────────────────────
  window.ApiRateLimiter = {
    getLimiter,
    acquireToken,
    getStatus,
    RateLimiter,
  };

  console.info('[ApiRateLimiter] Loaded: Token bucket rate limiter for all APIs');
})();
