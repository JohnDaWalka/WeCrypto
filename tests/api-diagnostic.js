#!/usr/bin/env node
/**
 * App API Usage Diagnostic
 * Tests the actual endpoints used by WE-CRYPTO app
 */

const https = require('https');

console.log('\n' + '='.repeat(80));
console.log('  WE-CRYPTO v2.4.8 — API CONNECTIVITY DIAGNOSTIC');
console.log('='.repeat(80) + '\n');

let results = {
  working: [],
  blocked: [],
  degraded: [],
  dns_fails: []
};

async function testUrl(name, url, options = {}) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      results.degraded.push({ name, reason: 'TIMEOUT', url });
      process.stdout.write('⏱️  ');
      resolve();
    }, options.timeout || 3000);

    https.get(url, { timeout: 3000 }, (res) => {
      clearTimeout(timeout);
      
      if (res.statusCode === 200) {
        results.working.push({ name, status: 200, url });
        process.stdout.write('✅ ');
      } else if (res.statusCode === 403 || res.statusCode === 429) {
        results.blocked.push({ name, status: res.statusCode, url });
        process.stdout.write('🔒 ');
      } else if (res.statusCode >= 400) {
        results.degraded.push({ name, status: res.statusCode, url });
        process.stdout.write('⚠️  ');
      } else {
        results.working.push({ name, status: res.statusCode, url });
        process.stdout.write('✅ ');
      }
      
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', resolve);
    }).on('error', (err) => {
      clearTimeout(timeout);
      
      if (err.code === 'ENOTFOUND') {
        results.dns_fails.push({ name, reason: 'DNS_FAIL', url, error: err.message });
        process.stdout.write('❌ ');
      } else {
        results.degraded.push({ name, reason: err.message, url });
        process.stdout.write('❌ ');
      }
      
      resolve();
    });
  });
}

async function runDiagnostics() {
  console.log('🔄 EXCHANGE ORDER BOOKS (Primary Sources)');
  console.log('─'.repeat(80));
  process.stdout.write('  Hyperliquid WebSocket: ');
  await testUrl('Hyperliquid', 'https://api.hyperliquid.xyz/exchange');
  console.log('\n  Binance REST API:       ');
  process.stdout.write('  ');
  await testUrl('Binance', 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
  console.log('\n  Bybit WebSocket:        ');
  process.stdout.write('  ');
  await testUrl('Bybit', 'https://api.bybit.com/v5/market/time');
  console.log('\n  Coinbase REST API:      ');
  process.stdout.write('  ');
  await testUrl('Coinbase', 'https://api.exchange.coinbase.com/products');
  console.log('\n');

  console.log('⛓️  BLOCKCHAIN FEES & DATA (Mempool/Gas)');
  console.log('─'.repeat(80));
  process.stdout.write('  Mempool v1 (BTC fees): ');
  await testUrl('Mempool', 'https://mempool.space/api/v1/fees/recommended');
  console.log('\n  Mempool v0 (fallback):  ');
  process.stdout.write('  ');
  await testUrl('Mempool v0', 'https://mempool.space/api/fees/recommended');
  console.log('\n  Blockscout (ETH gas):   ');
  process.stdout.write('  ');
  await testUrl('Blockscout', 'https://eth.blockscout.com/api/v2/gas-tracker');
  console.log('\n  Etherscan (fallback):   ');
  process.stdout.write('  ');
  await testUrl('Etherscan', 'https://api.etherscan.io/api?module=gastracker&action=gasprices');
  console.log('\n');

  console.log('💰 PRICING DATA (CoinGecko)');
  console.log('─'.repeat(80));
  process.stdout.write('  CoinGecko API:         ');
  await testUrl('CoinGecko', 'https://api.coingecko.com/api/v3/global');
  console.log('\n');

  console.log('🌐 INFRASTRUCTURE CHECK');
  console.log('─'.repeat(80));
  process.stdout.write('  DNS Resolution:        ');
  const dns = require('dns').promises;
  try {
    const addr = await dns.resolve4('api.binance.com');
    console.log('✅ Working');
    results.working.push({ name: 'DNS Resolution', status: 'OK' });
  } catch (e) {
    console.log('❌ Failed');
    results.dns_fails.push({ name: 'DNS Resolution', reason: e.message });
  }
  console.log();

  // Summary
  console.log('='.repeat(80));
  console.log('  SUMMARY');
  console.log('='.repeat(80));
  console.log(`  ✅ Working:  ${results.working.length}`);
  console.log(`  ⚠️  Degraded: ${results.degraded.length}`);
  console.log(`  🔒 Blocked:  ${results.blocked.length}`);
  console.log(`  ❌ DNS Fail: ${results.dns_fails.length}`);
  console.log();

  if (results.working.length >= 6) {
    console.log('  🟢 STATUS: HEALTHY');
    console.log('     Most APIs working. App will function normally.');
    console.log();
  } else if (results.working.length >= 3) {
    console.log('  🟡 STATUS: DEGRADED');
    console.log('     Some APIs working. Fallbacks will be used.');
    console.log();
  } else {
    console.log('  🔴 STATUS: CRITICAL');
    console.log('     Most APIs down. Limited functionality.');
    console.log();
  }

  console.log('WORKING ENDPOINTS:');
  console.log('─'.repeat(80));
  results.working.forEach(r => {
    console.log(`  ✅ ${r.name}`);
  });
  console.log();

  if (results.blocked.length > 0) {
    console.log('BLOCKED/RATE-LIMITED:');
    console.log('─'.repeat(80));
    results.blocked.forEach(r => {
      console.log(`  🔒 ${r.name} (${r.status})`);
    });
    console.log();
  }

  if (results.degraded.length > 0) {
    console.log('DEGRADED/SLOW:');
    console.log('─'.repeat(80));
    results.degraded.forEach(r => {
      console.log(`  ⚠️  ${r.name}${r.status ? ` (${r.status})` : ` (${r.reason})`}`);
    });
    console.log();
  }

  if (results.dns_fails.length > 0) {
    console.log('DNS FAILURES:');
    console.log('─'.repeat(80));
    results.dns_fails.forEach(r => {
      console.log(`  ❌ ${r.name} - ${r.reason}`);
    });
    console.log();
  }

  console.log('NEXT STEPS:');
  console.log('─'.repeat(80));
  console.log('  1. Check browser DevTools Network tab for actual requests');
  console.log('  2. Look for failed requests (4xx, 5xx, timeout)');
  console.log('  3. Watch for fallback activation (cascade messages in console)');
  console.log('  4. Monitor order books for data arrival');
  console.log('  5. Export HAR for detailed analysis');
  console.log();
}

runDiagnostics().catch(console.error);
