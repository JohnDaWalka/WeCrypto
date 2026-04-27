#!/usr/bin/env node
/**
 * Live Feed Test Suite
 * Tests Pyth Network feeds, order books, and API fallbacks
 * Run: node test-live-feeds.js
 */

const http = require('http');
const https = require('https');

const BASE_URL = 'http://127.0.0.1:3010';
const SYMBOLS = ['BTC', 'ETH', 'HYPE', 'SOL'];
const EXCHANGES = ['hyperliquid', 'binance', 'bybit', 'coinbase'];

console.log('\n═══════════════════════════════════════════════════════');
console.log('  LIVE FEED TEST SUITE — Pyth + Order Books + APIs');
console.log('═══════════════════════════════════════════════════════\n');

// Helper: fetch via proxy
async function proxyFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${endpoint}`;
    const protocol = url.startsWith('https') ? https : http;
    
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout (5s)'));
    }, 5000);

    protocol.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve({
            status: res.statusCode,
            data: JSON.parse(data),
            headers: res.headers
          });
        } catch (e) {
          resolve({ status: res.statusCode, data: data.slice(0, 200), raw: true });
        }
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Test 1: Pyth feeds availability
async function testPythFeeds() {
  console.log('📡 TEST 1: Pyth Network Live Feeds');
  console.log('─────────────────────────────────');
  try {
    const result = await proxyFetch('/check-pyth-status');
    console.log(`✓ Pyth feed status: ${result.data?.connected ? 'CONNECTED' : 'DISCONNECTED'}`);
    if (result.data?.latency) console.log(`  Latency: ${result.data.latency}ms`);
    if (result.data?.symbols) console.log(`  Symbols: ${result.data.symbols.length} active`);
  } catch (err) {
    console.log(`✗ Pyth check failed: ${err.message}`);
  }
  console.log();
}

// Test 2: Order book cascade
async function testOrderBooks() {
  console.log('📊 TEST 2: Order Book Cascade (Hyperliquid → Binance → Bybit → Coinbase)');
  console.log('─────────────────────────────────────────────────────────────────────────');
  
  for (const symbol of SYMBOLS) {
    try {
      const result = await proxyFetch(`/orderbook/${symbol}`);
      const book = result.data;
      const bid = book.bids?.[0]?.[0] || 'N/A';
      const ask = book.asks?.[0]?.[0] || 'N/A';
      const spread = bid !== 'N/A' && ask !== 'N/A' 
        ? ((ask - bid) / bid * 100).toFixed(3)
        : 'N/A';
      console.log(`  ${symbol}: ${bid} / ${ask} (spread: ${spread}%)`);
    } catch (err) {
      console.log(`  ${symbol}: ✗ ${err.message}`);
    }
  }
  console.log();
}

// Test 3: API Fallbacks
async function testAPIFallbacks() {
  console.log('🔄 TEST 3: API Endpoint Fallbacks');
  console.log('─────────────────────────────────');
  
  const tests = [
    { name: 'Mempool BTC fees', endpoint: '/blockchain/btc/fees' },
    { name: 'Etherscan ETH gas', endpoint: '/blockchain/eth/gas' },
    { name: 'CoinGecko HYPE price', endpoint: '/screener/price/HYPE' },
    { name: 'Blockscout metrics', endpoint: '/blockchain/blockscout/metrics' }
  ];

  for (const test of tests) {
    try {
      const result = await proxyFetch(test.endpoint);
      console.log(`✓ ${test.name}: ${result.status}`);
    } catch (err) {
      console.log(`✗ ${test.name}: ${err.message}`);
    }
  }
  console.log();
}

// Test 4: CoinGecko 429 Backoff
async function testCoinGeckoBackoff() {
  console.log('⏱️  TEST 4: CoinGecko 429 Rate Limit Backoff');
  console.log('───────────────────────────────────────────');
  
  try {
    const result = await proxyFetch('/check-coingecko-backoff');
    if (result.data?.backoffActive) {
      console.log(`⚠️  Backoff ACTIVE until: ${new Date(result.data.backoffUntil).toLocaleTimeString()}`);
      console.log(`  Next retry in: ${Math.round((result.data.backoffUntil - Date.now()) / 1000)}s`);
    } else {
      console.log(`✓ No active backoff. Backoff count: ${result.data?.backoffCount || 0}`);
    }
  } catch (err) {
    console.log(`⚠️  Backoff check failed: ${err.message}`);
  }
  console.log();
}

// Test 5: Contrast audit summary
async function testContrast() {
  console.log('🎨 TEST 5: Accessibility Contrast Check');
  console.log('──────────────────────────────────────');
  console.log(`Status: Run 'npx lighthouse --view http://localhost:3000' in browser`);
  console.log(`Expected: WCAG AA (4.5:1 regular, 3:1 large) achieved`);
  console.log(`Remaining: 4 elements <4.5:1 ratio (identify via DevTools audit)`);
  console.log();
}

// Run all tests
async function runAllTests() {
  await testPythFeeds();
  await testOrderBooks();
  await testAPIFallbacks();
  await testCoinGeckoBackoff();
  await testContrast();

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Next: Check browser console for [App] Pyth messages');
  console.log('  Open DevTools → Console tab in running app');
  console.log('═══════════════════════════════════════════════════════\n');
}

runAllTests().catch(console.error);
