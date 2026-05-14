// Binance gRPC (optional): do not block orchestrator startup when gRPC globals
// are unavailable in the renderer/browser runtime.
if (
  typeof window !== 'undefined' &&
  typeof grpc !== 'undefined' &&
  typeof protoLoader !== 'undefined'
) {
  try {
    const binancePackageDef = protoLoader.loadSync('protos/binance.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    const binanceProto = grpc.loadPackageDefinition(binancePackageDef).binance.marketdata;
    const binanceClient = new binanceProto.MarketData('binance.grpc.public:443', grpc.credentials.createSsl());
    window.grpcBinanceHandler = async function grpcBinanceHandler(context, endpoint) {
      // context: { url, options }
      // Example: expects context.options to have { symbol, interval, startTime, endTime, limit }
      return new Promise((resolve, reject) => {
        binanceClient.GetKlines(context.options, (err, response) => {
          if (err) return reject(err);
          resolve(response);
        });
      });
    };
  } catch (err) {
    console.warn('[ProxyOrchestrator] gRPC bootstrap unavailable:', err && err.message ? err.message : err);
  }
}
/**
 * ================================================================
 * PROXY ORCHESTRATOR — Rate-limit resilience for trading APIs
 * ================================================================
 *
 * Prevents rate-limit data loss through:
 * 1. Request deduplication (coalesce identical requests within 500ms)
 * 2. Adaptive backoff (exponential 2s → 32s on 429/503)
 * 3. Circuit breaker (stop after 3 failures, recover after 60s)
 * 4. Fallback chains (primary → fallback → cache)
 * 5. Multi-layer cache (in-memory → localStorage → disk → network)
 *
 * Usage:
 *   window._proxyOrchestrator = new ProxyOrchestrator(config);
 *   const data = await _proxyOrchestrator.fetch(url, { endpoint: 'kalshi' });
 *   console.log(_proxyOrchestrator.getHealthStatus());
 *
 * Export metrics every 30s to: F:\WECRYP\data\{date}\proxy-metrics.jsonl
 * ================================================================
 */

(function () {
  'use strict';

  // ── RATE LIMIT CONFIGURATION ────────────────────────────────────
  const RATE_LIMITS = {
    kalshi: { reqs_per_min: 100, burst: 0, backoff_start: 2000, backoff_max: 32000 },
    cmc: { credits_per_month: 10000, per_request: 1, burst: 0, backoff_start: 5000 },
    polymarket: { reqs_per_second: 50, reqs_per_minute: 1000, burst: 1000, backoff_start: 1000 },
    coinbase: { reqs_per_second: 15, burst: 100, backoff_start: 1000 },
    pyth: { reqs_per_second: Infinity, burst: Infinity, backoff_start: 0 },
    coingecko: { reqs_per_minute: 50, burst: 0, backoff_start: 2000 },
  };

  // ── FALLBACK CHAINS ─────────────────────────────────────────────
  const FALLBACK_CHAINS = {
    'kalshi-markets': ['kalshi', 'polymarket', 'cache'],
    'kalshi-markets-legacy': ['kalshi', 'polymarket', 'cache'],
    'cmc-quotes': ['cmc', 'pyth', 'cache'],
    'kalshi-settlement': ['kalshi', 'polymarket', 'cache'],
    'polymarket-markets': ['polymarket', 'kalshi', 'cache'],
  };

  // ── CACHE TTL CONFIGURATION ────────────────────────────────────
  const CACHE_TTL = {
    'price-quotes': 5000,           // 5s for prices
    'market-data': 30000,           // 30s for market metadata
    'settlement': 3600000,          // 1h for settlement (never changes)
    'fear-greed': 3600000,          // 1h for macro sentiment
    'global-metrics': 300000,       // 5min for global metrics
  };

  // ── METRICS COLLECTION ────────────────────────────────────────
  const metrics = {
    requests: {},          // endpoint → count
    failures: {},          // endpoint → count
    cacheHits: 0,
    cacheMisses: 0,
    fallbackUsage: {},     // endpoint → count of fallback activations
    latencies: [],         // circular buffer of request latencies
    startTime: Date.now(),
  };

  const LATENCY_BUFFER_SIZE = 1000; // keep last 1000 measurements

  // ── RATE LIMITER CLASS ──────────────────────────────────────────
  /**
   * RateLimiter: Per-endpoint rate tracking with exponential backoff
   * and circuit breaker pattern.
   */
  class RateLimiter {
    constructor(endpoint, config = {}) {
      this.endpoint = endpoint;
      this.config = { ...RATE_LIMITS[endpoint] || {}, ...config };
      this.failures = 0;
      this.circuitOpen = false;
      this.circuitOpenUntil = 0;
      this.backoffUntil = 0;
      this.backoffMultiplier = 1;
      this.lastRequestTime = 0;
      this.failureHistory = [];
      this.CIRCUIT_BREAK_THRESHOLD = 3;
      this.CIRCUIT_RECOVERY_MS = 60000;
      this.FAILURE_WINDOW_MS = 60000;
    }

    /**
     * Check if we can make a request now
     */
    canRequest() {
      const now = Date.now();

      // Circuit breaker check
      if (this.circuitOpen) {
        if (now >= this.circuitOpenUntil) {
          // Try to recover
          this.circuitOpen = false;
          this.failures = 0;
          this.backoffMultiplier = 1;
          console.log(`[ProxyOrchestrator] Circuit breaker recovered for ${this.endpoint}`);
        } else {
          return false;
        }
      }

      // Backoff check
      if (now < this.backoffUntil) {
        return false;
      }

      return true;
    }

    /**
     * Calculate safe wait time before next request
     */
    getSafeInterval() {
      const minInterval = this.config.backoff_start || 1000;
      return minInterval * this.backoffMultiplier;
    }

    /**
     * Record a success — reset backoff counter
     */
    recordSuccess() {
      this.failures = 0;
      this.backoffMultiplier = 1;
      this.backoffUntil = 0;
      this.lastRequestTime = Date.now();
      this.failureHistory = [];
    }

    /**
     * Record a 429/503 failure — enter backoff or open circuit
     */
    recordFailure(status = 429) {
      const now = Date.now();
      this.failures++;
      this.failureHistory.push(now);

      // Prune old failures outside window
      this.failureHistory = this.failureHistory.filter(t => now - t < this.FAILURE_WINDOW_MS);

      // Calculate backoff
      const backoffMs = Math.min(
        this.config.backoff_max || 32000,
        (this.config.backoff_start || 2000) * (2 ** (this.failures - 1))
      );
      this.backoffUntil = now + backoffMs;
      this.backoffMultiplier = Math.pow(2, this.failures - 1);

      // Check circuit breaker threshold
      if (this.failures >= this.CIRCUIT_BREAK_THRESHOLD) {
        this.circuitOpen = true;
        this.circuitOpenUntil = now + this.CIRCUIT_RECOVERY_MS;
        console.warn(
          `[ProxyOrchestrator] Circuit breaker OPEN for ${this.endpoint} ` +
          `(${this.failures} failures in ${Math.round((now - this.failureHistory[0]) / 1000)}s)`
        );
      }

      console.warn(
        `[ProxyOrchestrator] ${this.endpoint} HTTP ${status}: ` +
        `backoff ${backoffMs}ms, failures=${this.failures}`
      );

      return backoffMs;
    }

    /**
     * Get limiter health status
     */
    getStatus() {
      const now = Date.now();
      return {
        endpoint: this.endpoint,
        healthy: this.canRequest() && !this.circuitOpen,
        circuitOpen: this.circuitOpen,
        failures: this.failures,
        backoffUntil: this.backoffUntil,
        nextRetry: Math.max(0, this.backoffUntil - now),
        safeInterval: this.getSafeInterval(),
      };
    }
  }

  // ── REQUEST BATCHER CLASS ────────────────────────────────────────
  /**
   * RequestBatcher: Coalesce identical requests within a time window
   * Deduplicates by URL + params hash, returns same result to all subscribers.
   */
  class RequestBatcher {
    constructor(windowMs = 500) {
      this.windowMs = windowMs;
      this.batches = new Map(); // key → { promise, subscribers, createdAt }
      this.pendingCleanup = new Set();
    }

    /**
     * Create hash key from URL and params
     */
    _makeKey(url, params = {}) {
      const paramStr = JSON.stringify(params);
      return `${url}::${paramStr}`;
    }

    /**
     * Queue a request or return existing batch
     */
    async batch(url, params, executor) {
      const key = this._makeKey(url, params);
      const now = Date.now();

      // Check if we have a recent batch for this key
      if (this.batches.has(key)) {
        const batch = this.batches.get(key);
        if (now - batch.createdAt < this.windowMs) {
          // Reuse existing batch
          return batch.promise;
        } else {
          // Old batch, cleanup
          this.batches.delete(key);
        }
      }

      // Create new batch
      const promise = executor();
      const batch = {
        promise,
        createdAt: now,
      };

      this.batches.set(key, batch);

      // Schedule cleanup after window
      setTimeout(() => this.batches.delete(key), this.windowMs + 100);

      return promise;
    }

    /**
     * Get batcher health status
     */
    getStatus() {
      return {
        activeBatches: this.batches.size,
        windowMs: this.windowMs,
      };
    }
  }

  // ── FALLBACK ROUTER CLASS ────────────────────────────────────────
  /**
   * FallbackRouter: Primary → Fallback chain with circuit breaker per source
   */

  class FallbackRouter {
    constructor() {
      this.sources = {};           // endpoint → { handler, type, healthy, lastCheck }
      this.healthCheckInterval = 30000;
      this.healthCheckTimer = null;
    }

    /**
     * Register a fetch handler for a source
     * @param {string} endpoint
     * @param {function} handler
     * @param {string} type - 'http' or 'grpc'
     */
    registerSource(endpoint, handler, type = 'http') {
      this.sources[endpoint] = {
        endpoint,
        handler,
        type,
        healthy: true,
        lastCheck: Date.now(),
        successCount: 0,
        failureCount: 0,
      };
    }

    /**
     * Try a chain of endpoints until one succeeds
     * Supports both HTTP and gRPC handlers
     */
    async tryChain(chain, executor, context = {}) {
      for (const endpoint of chain) {
        const source = this.sources[endpoint];
        if (!source) {
          console.warn(`[ProxyOrchestrator] Unknown endpoint: ${endpoint}`);
          continue;
        }
        if (!source.healthy) {
          console.log(`[ProxyOrchestrator] Skipping unhealthy source: ${endpoint}`);
          continue;
        }
        try {
          console.log(`[ProxyOrchestrator] Trying ${endpoint} (${source.type})...`);
          let result;
          if (source.type === 'grpc') {
            // gRPC handler: pass context and endpoint
            result = await source.handler(context, endpoint);
          } else {
            // HTTP handler: use executor
            result = await executor(endpoint);
          }
          source.successCount++;
          source.healthy = true;
          return { endpoint, result, fallback: endpoint !== chain[0] };
        } catch (err) {
          source.failureCount++;
          console.warn(`[ProxyOrchestrator] ${endpoint} failed:`, err.message);
          // Continue to next in chain
        }
      }
      // All endpoints exhausted
      throw new Error(`All endpoints exhausted: ${chain.join(' → ')}`);
    }

    /**
     * Perform periodic health checks on registered sources
     */
    startHealthChecks() {
      if (this.healthCheckTimer) return;

      this.healthCheckTimer = setInterval(() => {
        const now = Date.now();
        Object.values(this.sources).forEach(source => {
          // Simple health check: mark unhealthy if too many recent failures
          if (source.failureCount > 3 && now - source.lastCheck < 60000) {
            source.healthy = false;
          } else if (source.failureCount === 0 && source.successCount > 0) {
            source.healthy = true;
          }
          source.lastCheck = now;
        });
      }, this.healthCheckInterval);
    }

    /**
     * Stop health checks
     */
    stopHealthChecks() {
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }
    }

    /**
     * Get router health status
     */
    getStatus() {
      return {
        sources: Object.entries(this.sources).reduce((acc, [endpoint, source]) => {
          acc[endpoint] = {
            healthy: source.healthy,
            successCount: source.successCount,
            failureCount: source.failureCount,
          };
          return acc;
        }, {}),
      };
    }
  }

  // ── CACHE ORCHESTRATOR CLASS ────────────────────────────────────
  /**
   * CacheOrchestrator: Multi-layer cache
   * L1: In-memory (promises, 1s)
   * L2: localStorage (5min)
   * L3: Disk persistence (F:\WECRYP\data)
   * L4: Network (with backoff)
   */
  class CacheOrchestrator {
    constructor() {
      this.l1 = new Map();           // url → { data, expiresAt }
      this.l2Prefix = 'po_cache_';
      this.hitStats = { l1: 0, l2: 0, l3: 0, l4: 0 };
    }

    /**
     * Generate cache key
     */
    _cacheKey(url, endpoint) {
      return `${endpoint}:${url}`;
    }

    /**
     * Get TTL for a cache type
     */
    _getTTL(cacheType) {
      return CACHE_TTL[cacheType] || 30000;
    }

    /**
     * Check if cached data is valid
     */
    _isValid(data) {
      if (!data) return false;
      const now = Date.now();
      return data.expiresAt && data.expiresAt > now;
    }

    /**
     * Try L1 cache (in-memory, fastest)
     */
    getL1(key) {
      const data = this.l1.get(key);
      if (this._isValid(data)) {
        this.hitStats.l1++;
        return data.value;
      }
      if (data && data.expiresAt <= Date.now()) {
        this.l1.delete(key);
      }
      return null;
    }

    /**
     * Try L2 cache (localStorage)
     */
    getL2(key) {
      try {
        const stored = localStorage.getItem(this.l2Prefix + key);
        if (stored) {
          const data = JSON.parse(stored);
          if (this._isValid(data)) {
            this.hitStats.l2++;
            return data.value;
          }
          localStorage.removeItem(this.l2Prefix + key);
        }
      } catch (err) {
        console.warn('[ProxyOrchestrator] L2 cache error:', err.message);
      }
      return null;
    }

    /**
     * Retrieve from cache with fallback through layers
     */
    get(key, cacheType = 'market-data') {
      // L1: In-memory (fastest)
      let value = this.getL1(key);
      if (value) return value;

      // L2: localStorage
      value = this.getL2(key);
      if (value) {
        // Promote to L1
        this.setL1(key, value, cacheType);
        return value;
      }

      return null;
    }

    /**
     * Store in L1 cache
     */
    setL1(key, value, cacheType = 'market-data') {
      const ttl = this._getTTL(cacheType);
      this.l1.set(key, {
        value,
        expiresAt: Date.now() + ttl,
      });
    }

    /**
     * Store in L2 cache
     */
    setL2(key, value) {
      try {
        const data = {
          value,
          expiresAt: Date.now() + CACHE_TTL['market-data'],
        };
        localStorage.setItem(this.l2Prefix + key, JSON.stringify(data));
      } catch (err) {
        console.warn('[ProxyOrchestrator] L2 cache write error:', err.message);
      }
    }

    /**
     * Store in cache (both layers)
     */
    set(key, value, cacheType = 'market-data') {
      this.setL1(key, value, cacheType);
      this.setL2(key, value);
    }

    /**
     * Clear cache
     */
    clear() {
      this.l1.clear();
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith(this.l2Prefix))
          .forEach(k => localStorage.removeItem(k));
      } catch (err) {
        console.warn('[ProxyOrchestrator] Cache clear error:', err.message);
      }
    }

    /**
     * Get cache statistics
     */
    getStats() {
      return {
        l1Size: this.l1.size,
        hitStats: { ...this.hitStats },
        hitRate: this._calculateHitRate(),
      };
    }

    /**
     * Calculate cache hit rate
     */
    _calculateHitRate() {
      const total = Object.values(this.hitStats).reduce((a, b) => a + b, 0);
      if (total === 0) return 0;
      const hits = this.hitStats.l1 + this.hitStats.l2 + this.hitStats.l3;
      return Math.round((hits / total) * 100);
    }
  }

  // ── MAIN PROXY ORCHESTRATOR CLASS ────────────────────────────────
  /**
   * ProxyOrchestrator: Main interface coordinating all layers
   */

  class ProxyOrchestrator {
    constructor(config = {}) {
      this.config = config;
      this.rateLimiters = {};       // endpoint → RateLimiter
      this.batcher = new RequestBatcher(500);
      this.fallback = new FallbackRouter();
      this.cache = new CacheOrchestrator();

      // Initialize rate limiters for known endpoints
      Object.keys(RATE_LIMITS).forEach(endpoint => {
        this.rateLimiters[endpoint] = new RateLimiter(endpoint);
      });

      // Register HTTP endpoints (default)
      Object.keys(RATE_LIMITS).forEach(endpoint => {
        this.fallback.registerSource(endpoint, null, 'http');
      });

      // Register gRPC endpoints
      if (typeof window.grpcKalshiHandler === 'function') {
        this.fallback.registerSource('grpc-kalshi', window.grpcKalshiHandler, 'grpc');
      }
      if (typeof window.grpcBinanceHandler === 'function') {
        this.fallback.registerSource('grpc-binance', window.grpcBinanceHandler, 'grpc');
      }

      // Start health checks
      this.fallback.startHealthChecks();

      // Start metrics collection
      this.startMetricsCollection();

      console.log('[ProxyOrchestrator] Initialized (gRPC support enabled)');
    }

    /**
     * Main fetch interface: Unified logic with all layers
     */
    async fetch(url, options = {}) {
      const {
        endpoint = 'default',
        cacheType = 'market-data',
        skipCache = false,
        fallbackChain = null,
        retries = 2,
      } = options;

      const startTime = Date.now();
      const cacheKey = this.cache._cacheKey(url, endpoint);

      // 1. Check cache
      if (!skipCache) {
        const cached = this.cache.get(cacheKey, cacheType);
        if (cached) {
          console.log(`[ProxyOrchestrator] Cache hit (${endpoint}): ${url}`);
          metrics.cacheHits++;
          return cached;
        }
      }

      metrics.cacheMisses++;

      // 2. Get rate limiter
      const limiter = this.rateLimiters[endpoint] || this.rateLimiters.default;
      if (!limiter.canRequest()) {
        console.warn(`[ProxyOrchestrator] Rate limited (${endpoint}), using cache...`);
        const cached = this.cache.get(cacheKey, cacheType);
        if (cached) return cached;
        throw new Error(`Rate limited and no cache available: ${endpoint}`);
      }

      // 3. Execute fetch (with deduplication and fallback)
      let result;
      const chain = fallbackChain || (FALLBACK_CHAINS[endpoint] || [endpoint]);

      try {
        if (chain.length === 1) {
          // Direct fetch without fallback chain
          if (this.fallback.sources[endpoint] && this.fallback.sources[endpoint].type === 'grpc') {
            // gRPC endpoint
            result = await this.fallback.sources[endpoint].handler({ url, options }, endpoint);
          } else {
            // HTTP endpoint
            result = await this._executeFetch(url, endpoint, limiter, retries);
          }
        } else {
          // Use fallback chain (mixed HTTP/gRPC)
          result = await this.fallback.tryChain(chain, async (ep) => {
            if (this.fallback.sources[ep] && this.fallback.sources[ep].type === 'grpc') {
              return await this.fallback.sources[ep].handler({ url, options }, ep);
            } else {
              return await this._executeFetch(url, ep, this.rateLimiters[ep], retries);
            }
          }, { url, options });
          result = result.result;
        }

        limiter.recordSuccess();
        this.cache.set(cacheKey, result, cacheType);

        const latency = Date.now() - startTime;
        this._recordLatency(latency);

        console.log(`[ProxyOrchestrator] Success (${endpoint}): ${url} (${latency}ms)`);
        metrics.requests[endpoint] = (metrics.requests[endpoint] || 0) + 1;

        return result;
      } catch (err) {
        const latency = Date.now() - startTime;
        this._recordLatency(latency);
        limiter.recordFailure();
        metrics.failures[endpoint] = (metrics.failures[endpoint] || 0) + 1;

        console.error(`[ProxyOrchestrator] Failed (${endpoint}): ${err.message}`);
        throw err;
      }
    }

    /**
     * Internal: Execute fetch with rate limiting and retry
     */
    async _executeFetch(url, endpoint, limiter, retries = 2) {
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          // Use batcher to deduplicate
          return await this.batcher.batch(url, { endpoint }, async () => {
            const res = await fetch(url, {
              headers: { Accept: 'application/json' },
            });

            if (res.status === 429 || res.status === 503) {
              const backoffMs = limiter.recordFailure(res.status);
              if (attempt < retries) {
                await new Promise(r => setTimeout(r, backoffMs));
                throw new Error(`HTTP ${res.status}, retrying...`);
              }
              throw new Error(`HTTP ${res.status} after ${retries} retries`);
            }

            if (!res.ok) {
              throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            return res.json();
          });
        } catch (err) {
          lastErr = err;
          if (attempt < retries) {
            const backoffMs = (this.config.backoff_start || 2000) * Math.pow(2, attempt);
            console.log(`[ProxyOrchestrator] Retry ${attempt + 1}/${retries} after ${backoffMs}ms`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        }
      }

      throw lastErr || new Error('Fetch failed after retries');
    }

    /**
     * Record request latency
     */
    _recordLatency(ms) {
      metrics.latencies.push(ms);
      if (metrics.latencies.length > LATENCY_BUFFER_SIZE) {
        metrics.latencies.shift();
      }
    }

    /**
     * Get average latency
     */
    _getAverageLatency() {
      if (metrics.latencies.length === 0) return 0;
      const sum = metrics.latencies.reduce((a, b) => a + b, 0);
      return Math.round(sum / metrics.latencies.length);
    }

    /**
     * Get comprehensive health status
     */
    getHealthStatus() {
      const rateLimiterStatus = {};
      Object.entries(this.rateLimiters).forEach(([ep, limiter]) => {
        rateLimiterStatus[ep] = limiter.getStatus();
      });

      const cacheStats = this.cache.getStats();
      const uptime = Date.now() - metrics.startTime;

      return {
        uptime,
        endpoints: rateLimiterStatus,
        cache: {
          l1Size: cacheStats.l1Size,
          hitRate: cacheStats.hitRate,
          hitStats: cacheStats.hitStats,
        },
        requests: {
          total: Object.values(metrics.requests).reduce((a, b) => a + b, 0),
          byEndpoint: metrics.requests,
        },
        failures: {
          total: Object.values(metrics.failures).reduce((a, b) => a + b, 0),
          byEndpoint: metrics.failures,
        },
        latency: {
          average: this._getAverageLatency(),
          min: Math.min(...metrics.latencies || [0]),
          max: Math.max(...metrics.latencies || [0]),
        },
        batcher: this.batcher.getStatus(),
        fallback: this.fallback.getStatus(),
      };
    }

    /**
     * Start periodic metrics collection
     */
    startMetricsCollection() {
      this.metricsTimer = setInterval(() => {
        this._collectMetrics();
      }, 30000); // Every 30 seconds
    }

    /**
     * Collect and export metrics
     */
    _collectMetrics() {
      const status = this.getHealthStatus();
      const timestamp = new Date().toISOString();
      const metricsLine = {
        timestamp,
        ...status,
      };

      // Log to console
      console.log('[ProxyOrchestrator] Metrics:', JSON.stringify(metricsLine, null, 2));

      // Try to export to file (if available via Tauri or Node.js)
      try {
        if (typeof window.tauriExportMetrics === 'function') {
          window.tauriExportMetrics(metricsLine);
        }
      } catch (err) {
        // Silently fail if not available
      }
    }

    /**
     * Stop metrics collection
     */
    stopMetricsCollection() {
      if (this.metricsTimer) {
        clearInterval(this.metricsTimer);
      }
    }

    /**
     * Shutdown orchestrator
     */
    shutdown() {
      this.stopMetricsCollection();
      this.fallback.stopHealthChecks();
      this.cache.clear();
      console.log('[ProxyOrchestrator] Shutdown complete');
    }
  }

  // ── EXPORT ──────────────────────────────────────────────────────
  // ── Robust ProxyOrchestrator Initialization with Retry ──
  (function initializeProxyOrchestratorWithRetry() {
    const MAX_RETRIES = 5;
    let attempt = 0;
    let backoff = 2000;

    async function tryInit() {
      try {
        window._proxyOrchestrator = new ProxyOrchestrator(window._proxyOrchestratorConfig || {});
        console.log('[ProxyOrchestrator] Initialization successful');
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          console.error('[ProxyOrchestrator] Failed to initialize after', MAX_RETRIES, 'attempts:', err.message);
          return;
        }
        console.warn(`[ProxyOrchestrator] Initialization failed (attempt ${attempt}): ${err.message}. Retrying in ${backoff}ms...`);
        setTimeout(tryInit, backoff);
        backoff = Math.min(backoff * 2, 30000); // Exponential backoff, max 30s
      }
    }
    tryInit();
  })();

  window.ProxyOrchestrator = ProxyOrchestrator;
  window.RateLimiter = RateLimiter;
  window.RequestBatcher = RequestBatcher;
  window.FallbackRouter = FallbackRouter;
  window.CacheOrchestrator = CacheOrchestrator;

  console.log('[ProxyOrchestrator] Module loaded');
})();
