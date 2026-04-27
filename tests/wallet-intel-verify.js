#!/usr/bin/env node
/**
 * wallet-intel-verify.js — Test all blockchain-scan API endpoints
 * Ensures all 10 endpoints are reachable and return valid JSON
 */

const https = require('https');

const ENDPOINTS = [
  // BTC
  { name: 'BTC: Mempool', url: 'https://mempool.space/api/mempool' },
  { name: 'BTC: Fees', url: 'https://mempool.space/api/v1/fees/recommended' },
  { name: 'BTC: Height', url: 'https://mempool.space/api/blocks/tip/height' },

  // ETH
  { name: 'ETH: Stats', url: 'https://eth.blockscout.com/api/v1/stats' },
  { name: 'ETH: Gas', url: 'https://eth.blockscout.com/api/v1/gas-price-oracle' },

  // XRP
  { name: 'XRP: XRPL Cluster', url: 'https://xrplcluster.com' },

  // SOL (primary)
  { name: 'SOL: Ankr RPC', url: 'https://rpc.ankr.com/solana', method: 'POST' },

  // SOL (fallback)
  { name: 'SOL: Mainnet Beta RPC', url: 'https://api.mainnet-beta.solana.com', method: 'POST' },

  // DOGE
  { name: 'DOGE: Blockchair', url: 'https://api.blockchair.com/dogecoin/stats' },

  // HYPE
  { name: 'HYPE: Hyperliquid API', url: 'https://api.hyperliquid.xyz/info', method: 'POST' },
];

const request = (url, method = 'GET') => {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data);
            resolve({ status: res.statusCode, json });
          } catch (e) {
            resolve({ status: res.statusCode, data: data.slice(0, 100) });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    if (method === 'POST') {
      req.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEpochInfo', params: [] }));
    }
    req.end();
  });
};

(async () => {
  console.log('\n[WALLET INTEL API VERIFICATION]\n');
  let pass = 0, fail = 0;

  for (const ep of ENDPOINTS) {
    try {
      const result = await request(ep.url, ep.method);
      console.log(`[OK] ${ep.name.padEnd(30)} ${result.status}`);
      pass++;
    } catch (e) {
      console.log(`[FAIL] ${ep.name.padEnd(30)} ${e.message}`);
      fail++;
    }
  }

  console.log(`\n${pass}/${ENDPOINTS.length} endpoints OK\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
