/**
 * Kalshi Test Harness
 * 
 * Run in browser console after app loads to test the integration.
 * Copy/paste each section sequentially.
 */

// ──────────────────────────────────────────────────────────────────────────
// PHASE 1: Verify modules loaded
// ──────────────────────────────────────────────────────────────────────────
console.log('=== PHASE 1: Verify Modules ===');
console.log('KalshiWS loaded:', typeof window.KalshiWS !== 'undefined');
console.log('KalshiRestClient loaded:', typeof window.KalshiRestClient !== 'undefined');
console.log('KalshiClient loaded:', typeof window.KalshiClient !== 'undefined');

// ──────────────────────────────────────────────────────────────────────────
// PHASE 2: Load credentials
// ──────────────────────────────────────────────────────────────────────────
console.log('\n=== PHASE 2: Load Credentials ===');
const creds = await window.desktopApp.loadKalshiCredentials();
console.log('Credentials loaded:', creds.success);
if (!creds.success) {
  console.error('Failed:', creds.error);
  throw new Error('Cannot load credentials');
}
console.log('API Key ID:', creds.apiKeyId.slice(0, 8) + '...');
console.log('Private Key:', creds.privateKeyPem.slice(0, 30) + '...');

// ──────────────────────────────────────────────────────────────────────────
// PHASE 3: Initialize client
// ──────────────────────────────────────────────────────────────────────────
console.log('\n=== PHASE 3: Initialize Client ===');
window.KalshiClient = new window.KalshiClient(
  creds.apiKeyId,
  creds.privateKeyPem,
  'production'
);
console.log('Client initialized');

// ──────────────────────────────────────────────────────────────────────────
// PHASE 4: Connect REST + WebSocket
// ──────────────────────────────────────────────────────────────────────────
console.log('\n=== PHASE 4: Connect ===');
const connected = await window.KalshiClient.connect();
console.log('Connected:', connected);

if (!connected) {
  throw new Error('Connection failed');
}

// ──────────────────────────────────────────────────────────────────────────
// PHASE 5: Get balance
// ──────────────────────────────────────────────────────────────────────────
console.log('\n=== PHASE 5: Get Balance ===');
const balance = await window.KalshiClient.getBalance();
console.log('Balance response:', balance);

// ──────────────────────────────────────────────────────────────────────────
// PHASE 6: Subscribe to market data
// ──────────────────────────────────────────────────────────────────────────
console.log('\n=== PHASE 6: Subscribe to Market Data ===');
const sid1 = window.KalshiClient.subscribe('ticker', ['INXUSD']);
console.log('Ticker subscription:', sid1);

const sid2 = window.KalshiClient.subscribe('trade');
console.log('Trade subscription:', sid2);

// ──────────────────────────────────────────────────────────────────────────
// PHASE 7: Setup event listeners
// ──────────────────────────────────────────────────────────────────────────
console.log('\n=== PHASE 7: Setup Event Listeners ===');

let tickerCount = 0;
window.addEventListener('kalshi:ticker', (e) => {
  tickerCount++;
  const ticker = e.detail;
  console.log(`[Ticker ${tickerCount}] ${ticker.market_ticker}: $${ticker.last_price} (24h vol: ${ticker.last_price_24h_volume})`);
});

let tradeCount = 0;
window.addEventListener('kalshi:trade', (e) => {
  tradeCount++;
  const trade = e.detail;
  console.log(`[Trade ${tradeCount}] ${trade.market_ticker}: ${trade.side === 'yes' ? '↑' : '↓'} $${trade.yes_price} x ${trade.quantity}`);
});

window.addEventListener('kalshi:error', (e) => {
  const error = e.detail;
  console.error(`[Error] ${error.type}: ${error.message}`);
});

console.log('Listeners registered');

// ──────────────────────────────────────────────────────────────────────────
// PHASE 8: Monitor for 1 minute
// ──────────────────────────────────────────────────────────────────────────
console.log('\n=== PHASE 8: Monitoring (60s) ===');
console.log('Check console for ticker and trade updates...');
console.log('Messages will appear automatically as they arrive');

// Show status every 10 seconds
const monitorInterval = setInterval(() => {
  const state = window.KalshiClient.getState();
  console.log(`[Status] Tickers: ${state.latestTickers}, Trades: ${state.recentTrades}, Errors: ${state.errors}`);
}, 10000);

// Stop after 60 seconds
setTimeout(() => {
  clearInterval(monitorInterval);
  console.log('\n=== PHASE 9: Final State ===');
  const finalState = window.KalshiClient.getState();
  console.table(finalState);
  console.log('Test complete!');
}, 60000);

// ──────────────────────────────────────────────────────────────────────────
// PHASE 10: Utility functions
// ──────────────────────────────────────────────────────────────────────────

// View current state anytime
window.kalshiStatus = () => {
  const state = window.KalshiClient.getState();
  console.table(state);
  return state;
};

// View all recent trades
window.kalshiTrades = () => {
  const trades = window.KalshiClient.getTrades(20);
  console.table(trades);
  return trades;
};

// Get ticker for a market
window.kalshiTicker = (market = 'INXUSD') => {
  const ticker = window.KalshiClient.getTicker(market);
  console.log(`${market}:`, ticker);
  return ticker;
};

// Manually place order (caution!)
window.kalshiOrder = async (marketTicker, side, quantity, yesPrice) => {
  const result = await window.KalshiClient.placeOrder({
    market_ticker: marketTicker,
    side, // 'yes' or 'no'
    action: 'buy',
    quantity,
    yes_price: yesPrice
  });
  console.log('Order result:', result);
  return result;
};

// Get positions
window.kalshiPositions = async () => {
  const positions = await window.KalshiClient.getPositions();
  console.table(positions);
  return positions;
};

// Subscribe to another market
window.kalshiSubscribe = (channel, markets = []) => {
  const sid = window.KalshiClient.subscribe(channel, markets);
  console.log(`Subscribed: ${channel} -> ${sid}`);
  return sid;
};

// Unsubscribe
window.kalshiUnsubscribe = (sid) => {
  window.KalshiClient.unsubscribe(sid);
  console.log(`Unsubscribed: ${sid}`);
};

console.log('\n=== Available Commands ===');
console.log('window.kalshiStatus()          - Show current state');
console.log('window.kalshiTicker("INXUSD")  - Get ticker for market');
console.log('window.kalshiTrades()          - View recent trades');
console.log('window.kalshiPositions()       - Get your positions');
console.log('window.kalshiSubscribe(ch, ms) - Subscribe to channel');
console.log('window.kalshiUnsubscribe(sid)  - Unsubscribe');
console.log('window.kalshiOrder(...)        - Place order (CAUTION!)');
console.log('\nTesting started. Monitor console for updates...');
