#!/usr/bin/env node
/**
 * Wallet Intel API Connectivity Test
 * Tests all blockchain-scan endpoints for HTTP status and JSON validity
 */

const fs = require('fs');
const https = require('https');

// API endpoints to test
const TESTS = [
  // BTC
  {
    name: 'BTC: Mempool Stats',
    url: 'https://mempool.space/api/mempool',
    method: 'GET',
    expectedFields: ['vsize', 'count'],
  },
  {
    name: 'BTC: Fees Recommended',
    url: 'https://mempool.space/api/fees/recommended',
    method: 'GET',
    expectedFields: ['fastestFee', 'halfHourFee'],
  },
  {
    name: 'BTC: Block Height',
    url: 'https://mempool.space/api/blocks/tip/height',
    method: 'GET',
    expectedFields: [],
  },
  // ETH
  {
    name: 'ETH: Blockscout Stats',
    url: 'https://eth.blockscout.com/api/v2/stats',
    method: 'GET',
    expectedFields: ['total_addresses', 'transactions_today'],
  },
  {
    name: 'ETH: Gas Price Oracle',
    url: 'https://eth.blockscout.com/api/v2/gas-price-oracle',
    method: 'GET',
    expectedFields: ['average', 'fast'],
  },
  // SOL RPC
  {
    name: 'SOL: Solana RPC (Ankr)',
    url: 'https://rpc.ankr.com/solana',
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'getEpochInfo', params: [] },
    expectedFields: ['result'],
  },
  // XRP
  {
    name: 'XRP: XRPL Cluster',
    url: 'https://xrplcluster.com',
    method: 'POST',
    body: { method: 'server_info', params: [{}] },
    expectedFields: ['result'],
  },
  // BNB BSC
  {
    name: 'BNB: BSC Blockscout Stats',
    url: 'https://bsc.blockscout.com/api/v2/stats',
    method: 'GET',
    expectedFields: ['total_addresses', 'transactions_today'],
  },
  // DOGE
  {
    name: 'DOGE: Blockchair',
    url: 'https://api.blockchair.com/dogecoin/stats',
    method: 'GET',
    expectedFields: ['data'],
  },
  // HYPE
  {
    name: 'HYPE: Hyperliquid API',
    url: 'https://api.hyperliquid.xyz/info',
    method: 'POST',
    body: { type: 'metaAndAssetCtxs' },
    expectedFields: [],
  },
];

// HTTP(S) request wrapper
function makeRequest(url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        'User-Agent': 'WE-CRYPTO Diagnostic/1.0',
        'Content-Type': 'application/json',
      },
    };

    const handler = (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: null, raw: data, parseError: e.message });
        }
      });
    };

    const req = https.request(url, options, handler);
    req.on('error', (e) => reject(e));

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Run all tests
async function runTests() {
  console.log('\n🧪 WE-CRYPTO Wallet Intel API Connectivity Test\n');
  console.log('═'.repeat(80));

  const results = [];

  for (const test of TESTS) {
    process.stdout.write(`🔍 ${test.name}... `);

    try {
      const result = await makeRequest(test.url, test.method, test.body);
      const statusOk = result.status >= 200 && result.status < 300;
      const parseOk = !result.parseError;
      const fieldsOk = !test.expectedFields.length || test.expectedFields.every((f) => f in (result.body || {}));

      let status = '❌';
      if (statusOk && parseOk && fieldsOk) {
        status = '✅';
      } else if (statusOk && parseOk) {
        status = '⚠️ ';
      }

      console.log(`${status} HTTP ${result.status}`);

      results.push({
        test: test.name,
        httpStatus: result.status,
        statusOk,
        parseOk,
        fieldsOk,
        parseError: result.parseError || null,
        bodySize: result.raw.length,
        preview: result.raw.substring(0, 100),
      });

      if (!statusOk) {
        console.log(`   └─ HTTP Error: ${result.status}`);
      }
      if (!parseOk) {
        console.log(`   └─ Parse Error: ${result.parseError}`);
      }
      if (!fieldsOk) {
        console.log(`   └─ Missing expected fields: ${test.expectedFields.join(', ')}`);
      }
    } catch (e) {
      console.log(`❌ Connection Error: ${e.message}`);
      results.push({
        test: test.name,
        error: e.message,
      });
    }
  }

  console.log('\n' + '═'.repeat(80));

  // Summary
  const passed = results.filter((r) => r.statusOk && r.parseOk && r.fieldsOk).length;
  const failed = results.length - passed;

  console.log(`\n📊 SUMMARY: ${passed}/${results.length} passed, ${failed} failed\n`);

  // Export to CSV
  const csv = [
    ['Test', 'HTTP Status', 'Status OK', 'Parse OK', 'Fields OK', 'Error', 'Body Size'].join(','),
    ...results.map((r) =>
      [
        `"${r.test}"`,
        r.httpStatus || 'N/A',
        r.statusOk ? 'YES' : 'NO',
        r.parseOk ? 'YES' : 'NO',
        r.fieldsOk ? 'YES' : 'NO',
        r.error || r.parseError || '',
        r.bodySize || 0,
      ].join(',')
    ),
  ].join('\n');

  const reportFile = `wallet-intel-api-test-${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(reportFile, csv);
  console.log(`📄 Report saved: ${reportFile}\n`);
}

runTests().catch((e) => {
  console.error('❌ Test suite failed:', e);
  process.exit(1);
});
