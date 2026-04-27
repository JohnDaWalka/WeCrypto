#!/usr/bin/env node
/**
 * API Status Test Suite
 * Tests all integrated APIs and data sources
 */

const https = require('https');
const http = require('http');

console.log('\n' + '='.repeat(80));
console.log('  API STATUS TEST SUITE — WE-CRYPTO v2.4.8');
console.log('='.repeat(80) + '\n');

const tests = [];
let passCount = 0;
let failCount = 0;

// Helper: HTTP request with timeout
async function testEndpoint(url, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || 5000;
    const protocol = url.startsWith('https') ? https : http;
    
    const timeoutId = setTimeout(() => {
      resolve({ status: 'TIMEOUT', error: `No response after ${timeout}ms` });
    }, timeout);

    try {
      const req = protocol.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          clearTimeout(timeoutId);
          resolve({
            status: res.statusCode,
            statusText: `${res.statusCode} ${http.STATUS_CODES[res.statusCode] || 'UNKNOWN'}`,
            contentType: res.headers['content-type'],
            dataLength: data.length,
            success: res.statusCode >= 200 && res.statusCode < 300
          });
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeoutId);
        resolve({ status: 'ERROR', error: err.message });
      });
    } catch (err) {
      clearTimeout(timeoutId);
      resolve({ status: 'ERROR', error: err.message });
    }
  });
}

// Test runner
async function test(name, url, options = {}) {
  process.stdout.write(`  Testing: ${name.padEnd(45)} `);
  const result = await testEndpoint(url, options);
  
  const passed = result.success || (options.expectedStatus && result.status === options.expectedStatus);
  
  if (passed) {
    console.log(`✅ ${result.statusText}`);
    passCount++;
  } else {
    console.log(`❌ ${result.statusText || result.status}`);
    if (result.error) console.log(`     Error: ${result.error}`);
    failCount++;
  }
  
  tests.push({ name, url, result, passed });
  return result;
}

// Run all tests
async function runTests() {
  console.log('📡 PYTH NETWORK');
  console.log('─'.repeat(80));
  await test('Pyth WebSocket (health check)', 'https://api.pythnetwork.com/v1/prices?ids=Crypto.BTC/USD', {
    expectedStatus: 200
  });
  console.log();

  console.log('💱 ORDER BOOK EXCHANGES');
  console.log('─'.repeat(80));
  
  // Hyperliquid
  await test('Hyperliquid: Get Open Orders', 'https://api.hyperliquid.xyz/info', {
    timeout: 3000,
    expectedStatus: 200
  });
  
  // Binance
  await test('Binance: Server Time', 'https://api.binance.com/api/v3/time', {
    expectedStatus: 200
  });
  await test('Binance: BTC Ticker', 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
    expectedStatus: 200
  });
  
  // Bybit
  await test('Bybit: Server Time', 'https://api.bybit.com/v5/market/time', {
    expectedStatus: 200
  });
  
  // Coinbase
  await test('Coinbase: Products', 'https://api.exchange.coinbase.com/products/BTC-USDC/ticker', {
    expectedStatus: 200
  });
  
  console.log();

  console.log('⛓️  BLOCKCHAIN DATA');
  console.log('─'.repeat(80));
  
  // Mempool BTC
  await test('Mempool (v1): BTC Fees', 'https://mempool.space/api/v1/fees/recommended', {
    expectedStatus: 200
  });
  
  // Blockscout ETH Gas
  await test('Blockscout: ETH Gas Tracker', 'https://eth.blockscout.com/api/v2/gas-tracker', {
    expectedStatus: 200,
    timeout: 3000
  });
  
  // Etherscan fallback
  await test('Etherscan: Gas Tracker', 'https://api.etherscan.io/api?module=gastracker&action=gasprices&apikey=demo', {
    expectedStatus: 200
  });
  
  console.log();

  console.log('💰 PRICING DATA');
  console.log('─'.repeat(80));
  
  // CoinGecko
  await test('CoinGecko: BTC/USD Price', 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', {
    expectedStatus: 200
  });
  
  await test('CoinGecko: Market Data', 'https://api.coingecko.com/api/v3/global', {
    expectedStatus: 200,
    timeout: 5000
  });
  
  console.log();

  console.log('🔗 CFM BENCHMARKS');
  console.log('─'.repeat(80));
  
  await test('CFB: Settlement Prices', 'https://api.cfbenchmarks.com/v1/BTC_Settle.json', {
    timeout: 3000
  });
  
  console.log();

  console.log('📊 MARKET DATA');
  console.log('─'.repeat(80));
  
  // DexScreener
  await test('DexScreener: Trading Pairs', 'https://api.dexscreener.com/latest/dex/search?q=hyperliquid', {
    expectedStatus: 200
  });
  
  console.log();

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('  TEST SUMMARY');
  console.log('='.repeat(80));
  console.log(`  ✅ Passed: ${passCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  📊 Total:  ${tests.length}`);
  console.log(`  ⚡ Pass Rate: ${Math.round((passCount / tests.length) * 100)}%`);
  console.log('='.repeat(80) + '\n');

  if (failCount === 0) {
    console.log('  🟢 ALL APIS OPERATIONAL\n');
  } else {
    console.log('  🟡 SOME APIS DEGRADED — SEE FAILURES ABOVE\n');
    console.log('  Degraded APIs:');
    tests.filter(t => !t.passed).forEach(t => {
      console.log(`    • ${t.name}`);
      console.log(`      URL: ${t.url}`);
      console.log(`      Result: ${t.result.status} ${t.result.error ? '(' + t.result.error + ')' : ''}`);
    });
    console.log();
  }

  console.log('RECOMMENDATIONS:');
  console.log('─'.repeat(80));
  if (passCount >= tests.length - 2) {
    console.log('✅ APIs are healthy. Order books should initialize normally.');
    console.log('✅ Fallback cascades will activate only if primaries timeout.');
    console.log('✅ Backoff guards active for rate-limited endpoints.');
  } else {
    console.log('⚠️  Multiple API endpoints degraded or unreachable.');
    console.log('⚠️  App will rely on fallback cascade immediately.');
    console.log('⚠️  Monitor Network tab in DevTools for failover behavior.');
  }
  console.log();
}

// Run tests
runTests().catch(console.error);
