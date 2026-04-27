/**
 * Test blockchain API connectivity
 * Run in DevTools console: window.testBlockchainAPIs()
 */

window.testBlockchainAPIs = async function() {
  console.log('\n🔍 BLOCKCHAIN API CONNECTIVITY TEST\n');
  
  const tests = [
    // BTC
    { name: 'BTC Mempool', url: 'https://mempool.space/api/mempool', method: 'GET' },
    { name: 'BTC Fees', url: 'https://mempool.space/api/fees/recommended', method: 'GET' },
    { name: 'BTC Height', url: 'https://mempool.space/api/blocks/tip/height', method: 'GET' },
    
    // ETH
    { name: 'ETH Stats', url: 'https://eth.blockscout.com/api/v2/stats', method: 'GET' },
    { name: 'ETH Gas', url: 'https://eth.blockscout.com/api/v2/gas-price-oracle', method: 'GET' },
    
    // SOL (POST)
    { name: 'SOL RPC', url: 'https://rpc.ankr.com/solana', method: 'POST', 
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEpochInfo', params: [] }) },
    
    // XRP (POST)
    { name: 'XRP XRPL', url: 'https://xrplcluster.com', method: 'POST',
      body: JSON.stringify({ method: 'server_info', params: [{}] }) },
    
    // BNB
    { name: 'BNB Stats', url: 'https://bsc.blockscout.com/api/v2/stats', method: 'GET' },
    { name: 'BNB Gas', url: 'https://bsc.blockscout.com/api/v2/gas-price-oracle', method: 'GET' },
    
    // DOGE
    { name: 'DOGE Stats', url: 'https://api.blockchair.com/dogecoin/stats', method: 'GET' },
    
    // HYPE
    { name: 'HYPE Hyperliquid', url: 'https://api.hyperliquid.xyz/info', method: 'POST',
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }) },
  ];
  
  const results = [];
  
  for (const test of tests) {
    try {
      const opts = {
        method: test.method,
        headers: { 'Content-Type': 'application/json' }
      };
      if (test.body) opts.body = test.body;
      
      const start = Date.now();
      const response = await fetch(test.url, opts);
      const elapsed = Date.now() - start;
      
      if (!response.ok) {
        results.push({
          name: test.name,
          status: '❌ HTTP ' + response.status,
          elapsed: elapsed + 'ms',
          error: response.statusText
        });
        console.log(`❌ ${test.name}: HTTP ${response.status} (${elapsed}ms)`);
        continue;
      }
      
      const data = await response.json();
      results.push({
        name: test.name,
        status: '✅',
        elapsed: elapsed + 'ms',
        dataSize: JSON.stringify(data).length + ' bytes'
      });
      console.log(`✅ ${test.name}: ${elapsed}ms, ${Object.keys(data).length} fields`);
    } catch (err) {
      results.push({
        name: test.name,
        status: '❌ Error',
        error: err.message
      });
      console.log(`❌ ${test.name}: ${err.message}`);
    }
  }
  
  console.log('\n📊 SUMMARY\n');
  const passed = results.filter(r => r.status === '✅').length;
  console.log(`Passed: ${passed}/${results.length}`);
  
  // Show failures
  const failed = results.filter(r => r.status !== '✅');
  if (failed.length > 0) {
    console.log('\n🔴 FAILURES:');
    failed.forEach(r => {
      console.log(`  ${r.name}: ${r.status} - ${r.error}`);
    });
  }
  
  return results;
};

// Auto-run on load
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  console.log('💡 Run: window.testBlockchainAPIs() to test all endpoints');
}
