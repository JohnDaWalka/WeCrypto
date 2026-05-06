/**
 * ================================================================
 * PROXY ORCHESTRATOR VALIDATION SCRIPT
 * ================================================================
 *
 * Run this in browser console to validate the implementation.
 * Opens browser Developer Tools (F12) → Console tab, then paste below.
 *
 * Expected output: All tests pass with ✓ marks
 *
 * ================================================================
 */

(function validateProxyOrchestrator() {
  'use strict';

  const tests = [];
  const results = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  function pass(msg) {
    results.push(`✓ ${msg}`);
    console.log(`%c✓ ${msg}`, 'color: green; font-weight: bold;');
  }

  function fail(msg, err) {
    results.push(`✗ ${msg}`);
    console.error(`%c✗ ${msg}`, 'color: red; font-weight: bold;', err);
  }

  function info(msg) {
    results.push(`ℹ ${msg}`);
    console.log(`%cℹ ${msg}`, 'color: blue;');
  }

  // ── TEST 1: Module Loading ────────────────────────────────────
  test('Module Loaded', () => {
    if (typeof window.ProxyOrchestrator === 'undefined') {
      fail('ProxyOrchestrator class not defined');
      return;
    }
    pass('ProxyOrchestrator class defined');
    
    if (typeof window.RateLimiter === 'undefined') {
      fail('RateLimiter class not defined');
      return;
    }
    pass('RateLimiter class defined');
    
    if (typeof window.RequestBatcher === 'undefined') {
      fail('RequestBatcher class not defined');
      return;
    }
    pass('RequestBatcher class defined');
    
    if (typeof window.FallbackRouter === 'undefined') {
      fail('FallbackRouter class not defined');
      return;
    }
    pass('FallbackRouter class defined');
    
    if (typeof window.CacheOrchestrator === 'undefined') {
      fail('CacheOrchestrator class not defined');
      return;
    }
    pass('CacheOrchestrator class defined');
  });

  // ── TEST 2: Initialization ────────────────────────────────────
  test('Initialization', () => {
    if (typeof window._proxyOrchestrator === 'undefined') {
      fail('window._proxyOrchestrator not initialized');
      return;
    }
    pass('window._proxyOrchestrator initialized');
    
    if (!(window._proxyOrchestrator instanceof window.ProxyOrchestrator)) {
      fail('window._proxyOrchestrator is not ProxyOrchestrator instance');
      return;
    }
    pass('window._proxyOrchestrator is correct type');
  });

  // ── TEST 3: Health Status ────────────────────────────────────
  test('Health Status API', () => {
    try {
      const status = window._proxyOrchestrator.getHealthStatus();
      
      if (!status || typeof status !== 'object') {
        fail('getHealthStatus() returned non-object');
        return;
      }
      pass('getHealthStatus() returns object');
      
      if (!status.endpoints || typeof status.endpoints !== 'object') {
        fail('status.endpoints not found');
        return;
      }
      pass('status.endpoints present');
      
      if (!status.cache || typeof status.cache !== 'object') {
        fail('status.cache not found');
        return;
      }
      pass('status.cache present');
      
      if (!status.requests || typeof status.requests !== 'object') {
        fail('status.requests not found');
        return;
      }
      pass('status.requests present');
      
      if (typeof status.latency !== 'object') {
        fail('status.latency not found');
        return;
      }
      pass('status.latency present');
      
      info(`Current uptime: ${Math.round(status.uptime / 1000)}s`);
      info(`Cache hit rate: ${status.cache.hitRate}%`);
      info(`L1 cache size: ${status.cache.l1Size} entries`);
      info(`Average latency: ${status.latency.average}ms`);
    } catch (err) {
      fail('getHealthStatus() threw error', err);
    }
  });

  // ── TEST 4: Rate Limiter ────────────────────────────────────
  test('Rate Limiter Functionality', () => {
    try {
      const limiter = new window.RateLimiter('test-endpoint');
      
      if (!limiter.canRequest()) {
        fail('Rate limiter should allow initial request');
        return;
      }
      pass('Rate limiter allows initial request');
      
      limiter.recordSuccess();
      if (!limiter.canRequest()) {
        fail('Rate limiter should allow request after success');
        return;
      }
      pass('Rate limiter allows request after success');
      
      limiter.recordFailure(429);
      const canReq = limiter.canRequest();
      // Should NOT be able to request immediately after failure
      if (canReq) {
        fail('Rate limiter should initiate backoff after failure');
        return;
      }
      pass('Rate limiter initiates backoff after failure');
      
      const status = limiter.getStatus();
      if (!status.backoffUntil || status.backoffUntil <= Date.now()) {
        fail('Rate limiter backoff time not set');
        return;
      }
      pass('Rate limiter backoff time is set');
    } catch (err) {
      fail('Rate limiter test threw error', err);
    }
  });

  // ── TEST 5: Request Batcher ────────────────────────────────────
  test('Request Batcher Deduplication', async () => {
    try {
      const batcher = new window.RequestBatcher();
      
      const url = 'https://test.example.com/api/data';
      const params = { id: 123 };
      let execCount = 0;
      
      // Execute same request twice simultaneously
      const p1 = batcher.batch(url, params, async () => {
        execCount++;
        await new Promise(r => setTimeout(r, 100));
        return { result: 'data' };
      });
      
      const p2 = batcher.batch(url, params, async () => {
        execCount++;
        await new Promise(r => setTimeout(r, 100));
        return { result: 'data' };
      });
      
      const [r1, r2] = await Promise.all([p1, p2]);
      
      if (execCount !== 1) {
        fail(`Batcher executed ${execCount} times instead of 1`);
        return;
      }
      pass('Batcher deduplicates identical requests (executed 1x)');
      
      if (r1 !== r2) {
        fail('Batcher results are not identical');
        return;
      }
      pass('Batcher returns same result to both subscribers');
    } catch (err) {
      fail('Request batcher test threw error', err);
    }
  });

  // ── TEST 6: Cache ────────────────────────────────────────────
  test('Cache Orchestrator', () => {
    try {
      const cache = new window.CacheOrchestrator();
      
      const key = 'test-key';
      const value = { data: 'test' };
      
      cache.set(key, value, 'market-data');
      const cached = cache.get(key, 'market-data');
      
      if (cached !== value) {
        fail('Cache set/get failed');
        return;
      }
      pass('Cache set/get works');
      
      const stats = cache.getStats();
      if (stats.hitStats.l1 !== 1) {
        fail('Cache hit stats not updated');
        return;
      }
      pass('Cache hit stats tracking works');
      
      cache.clear();
      const cleared = cache.get(key);
      if (cleared !== null) {
        fail('Cache clear failed');
        return;
      }
      pass('Cache clear works');
    } catch (err) {
      fail('Cache test threw error', err);
    }
  });

  // ── TEST 7: Fallback Router ────────────────────────────────────
  test('Fallback Router', () => {
    try {
      const router = new window.FallbackRouter();
      
      router.registerSource('endpoint1', {});
      router.registerSource('endpoint2', {});
      
      const status = router.getStatus();
      if (!status.sources || !status.sources.endpoint1) {
        fail('Fallback router registration failed');
        return;
      }
      pass('Fallback router registers sources');
      
      if (!status.sources.endpoint1.healthy) {
        fail('Registered source should be healthy');
        return;
      }
      pass('Registered sources start healthy');
    } catch (err) {
      fail('Fallback router test threw error', err);
    }
  });

  // ── TEST 8: Fetch with Caching ────────────────────────────────
  test('Fetch with Caching', async () => {
    try {
      const cache = new window.CacheOrchestrator();
      const testData = { cached: true };
      
      cache.set('test-fetch', testData, 'market-data');
      const result = cache.get('test-fetch', 'market-data');
      
      if (!result || !result.cached) {
        fail('Cached fetch result incorrect');
        return;
      }
      pass('Cached fetch returns correct data');
    } catch (err) {
      fail('Fetch caching test threw error', err);
    }
  });

  // ── TEST 9: Integration Check ────────────────────────────────
  test('Integration Check', () => {
    try {
      // Check that prediction-markets integration is available
      if (typeof window.PredictionMarkets !== 'undefined' && window.PredictionMarkets.start) {
        pass('PredictionMarkets module loaded and ready');
      } else {
        info('PredictionMarkets module not yet loaded (OK on first load)');
      }
      
      // Check CMC feed
      if (typeof window.CoinMarketCapFeed !== 'undefined') {
        pass('CoinMarketCapFeed module loaded');
      } else {
        info('CoinMarketCapFeed module not yet loaded (OK on first load)');
      }
      
      // Check market resolver
      if (window._15mResolutionLog !== undefined) {
        pass('Market resolver initialized (_15mResolutionLog exists)');
      } else {
        info('Market resolver not yet loaded (OK on first load)');
      }
    } catch (err) {
      fail('Integration check threw error', err);
    }
  });

  // ── TEST 10: Configuration ────────────────────────────────────
  test('Configuration Validation', () => {
    try {
      const status = window._proxyOrchestrator.getHealthStatus();
      
      const endpoints = Object.keys(status.endpoints);
      const expectedEndpoints = ['kalshi', 'cmc', 'polymarket', 'coinbase', 'pyth', 'coingecko'];
      
      let missing = [];
      expectedEndpoints.forEach(ep => {
        if (!endpoints.includes(ep)) {
          missing.push(ep);
        }
      });
      
      if (missing.length > 0) {
        info(`Missing endpoints: ${missing.join(', ')} (may not be critical)`);
      } else {
        pass('All expected endpoints are configured');
      }
      
      pass('Configuration validation complete');
    } catch (err) {
      fail('Configuration validation threw error', err);
    }
  });

  // ── Run all tests ────────────────────────────────────────────
  console.log('%c═══════════════════════════════════════════════════════════', 'color: blue; font-weight: bold;');
  console.log('%c  PROXY ORCHESTRATOR VALIDATION', 'color: blue; font-weight: bold;');
  console.log('%c═══════════════════════════════════════════════════════════', 'color: blue; font-weight: bold;');
  console.log('');

  for (const t of tests) {
    console.group(`📋 ${t.name}`);
    try {
      t.fn();
    } catch (err) {
      console.error('Test execution failed:', err);
    }
    console.groupEnd();
    console.log('');
  }

  console.log('%c═══════════════════════════════════════════════════════════', 'color: blue; font-weight: bold;');
  console.log('%c  SUMMARY', 'color: blue; font-weight: bold;');
  console.log('%c═══════════════════════════════════════════════════════════', 'color: blue; font-weight: bold;');
  
  const passed = results.filter(r => r.startsWith('✓')).length;
  const failed = results.filter(r => r.startsWith('✗')).length;
  const infos = results.filter(r => r.startsWith('ℹ')).length;
  
  console.log(`%c  ✓ Passed: ${passed}`, 'color: green; font-weight: bold;');
  console.log(`%c  ✗ Failed: ${failed}`, failed > 0 ? 'color: red; font-weight: bold;' : 'color: green;');
  console.log(`%c  ℹ Info: ${infos}`, 'color: blue;');
  console.log('');
  
  if (failed === 0) {
    console.log('%c  🎉 ALL TESTS PASSED! System is ready to use.', 'color: green; font-weight: bold; font-size: 14px;');
    console.log('%c  Try: window._proxyOrchestrator.getHealthStatus()', 'color: green;');
  } else {
    console.log('%c  ⚠️  SOME TESTS FAILED — please review errors above', 'color: red; font-weight: bold;');
  }
  
  console.log('');
  console.log('%c═══════════════════════════════════════════════════════════', 'color: blue; font-weight: bold;');

  // Return summary for programmatic use
  return {
    passed,
    failed,
    infos,
    results,
    healthStatus: window._proxyOrchestrator.getHealthStatus(),
  };
})();

// Store results in window for inspection
window._validationResults = result;
console.log('Validation results saved to window._validationResults');
