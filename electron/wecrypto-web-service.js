/**
 * WECRYPTO Web Service Server
 * 
 * Serves entire WECRYPTO orchestrator via HTTPS
 * Accessible via Edge browser + Copilot integration
 * 
 * Endpoints:
 *   GET  /                       → Web UI (full app dashboard)
 *   GET  /api/predictions        → Current predictions for all coins
 *   GET  /api/signals            → Live signals (color-coded)
 *   GET  /api/settlements        → All settlement records
 *   GET  /api/stats              → Win rates by coin
 *   GET  /api/kalshi-markets     → Current Kalshi contract prices
 *   GET  /api/network-status     → Real-time network congestion metrics
 *   WS   /ws                     → WebSocket for live updates
 */

const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.WECRYPTO_WEB_PORT || 3443;
const HOST = process.env.WECRYPTO_WEB_HOST || '0.0.0.0';

let app = null;
let server = null;
let wss = null;

/**
 * Start HTTPS web service
 */
function startWebService() {
  if (server) return;

  app = express();

  // Middleware
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // ── API Routes ──────────────────────────────────────────────────────────

  /**
   * GET /api/predictions
   * Current predictions for all coins
   */
  app.get('/api/predictions', (req, res) => {
    // This will be populated by IPC from the Electron app
    const predictions = global.WECRYPTO_STATE?.predictions || {};
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      predictions: predictions
    });
  });

  /**
   * GET /api/signals
   * Live signals with direction, confidence, color
   */
  app.get('/api/signals', (req, res) => {
    const signals = global.WECRYPTO_STATE?.signals || {};
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      signals: signals
    });
  });

  /**
   * GET /api/settlements
   * All settlement records
   */
  app.get('/api/settlements', (req, res) => {
    const settlements = global.WECRYPTO_STATE?.settlements || [];
    
    res.json({
      success: true,
      record_count: settlements.length,
      settlements: settlements
    });
  });

  /**
   * GET /api/stats
   * Win rates and statistics
   */
  app.get('/api/stats', (req, res) => {
    const stats = global.WECRYPTO_STATE?.stats || {};
    
    res.json({
      success: true,
      stats: stats
    });
  });

  /**
   * GET /api/kalshi-markets
   * Current Kalshi contract prices and odds
   */
  app.get('/api/kalshi-markets', (req, res) => {
    const markets = global.WECRYPTO_STATE?.kalshiMarkets || {};
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      markets: markets
    });
  });

  /**
   * GET /api/network-status
   * Real-time blockchain network metrics
   */
  app.get('/api/network-status', (req, res) => {
    const networkStatus = global.WECRYPTO_STATE?.networkStatus || {};
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      status: networkStatus
    });
  });

  /**
   * GET /api/status
   * Overall system health
   */
  app.get('/api/status', (req, res) => {
    const uptime = process.uptime();
    
    res.json({
      success: true,
      system: {
        uptime_seconds: Math.floor(uptime),
        uptime_formatted: formatUptime(uptime),
        memory: process.memoryUsage(),
        platform: process.platform,
        arch: process.arch,
        node_version: process.version
      },
      wecrypto: {
        running: !!global.WECRYPTO_STATE,
        last_update: global.WECRYPTO_STATE?.lastUpdate || null,
        active_coins: global.WECRYPTO_STATE?.activeCoins || []
      }
    });
  });

  // Web UI
  app.get('/', (req, res) => {
    res.send(getWebUIHTML());
  });

  // Generate or load HTTPS certificate
  const certDir = path.join(os.homedir(), 'AppData', 'Roaming', 'WE-CRYPTO', 'certs');
  const certFile = path.join(certDir, 'wecrypto-web.crt');
  const keyFile = path.join(certDir, 'wecrypto-web.key');

  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  // Try to generate self-signed cert
  let useHTTPS = true;
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    console.log('[WebService] Generating self-signed HTTPS certificate...');
    const { execSync } = require('child_process');
    try {
      execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 365 -nodes -subj "/CN=localhost"`, {
        stdio: 'ignore',
        shell: true
      });
      console.log('[WebService] Certificate generated successfully');
    } catch (e) {
      console.warn('[WebService] Could not generate certificate with openssl:', e.message);
      useHTTPS = false;
    }
  }

  // Start server (HTTPS or HTTP)
  try {
    if (useHTTPS && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      const options = {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile)
      };
      server = https.createServer(options, app);
      console.log('[WebService] Using HTTPS');
    } else {
      const http = require('http');
      server = http.createServer(app);
      console.log('[WebService] Using HTTP (fallback)');
    }
  } catch (e) {
    const http = require('http');
    server = http.createServer(app);
    console.log('[WebService] HTTPS setup failed, using HTTP:', e.message);
  }

  // WebSocket for live updates
  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('[WebService] WebSocket client connected');
    
    // Send initial state
    ws.send(JSON.stringify({
      type: 'state',
      data: global.WECRYPTO_STATE || {}
    }));

    ws.on('close', () => {
      console.log('[WebService] WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[WebService] WebSocket error:', err.message);
    });
  });

  // Start listening
  server.listen(PORT, HOST, () => {
    const protocol = useHTTPS ? 'HTTPS' : 'HTTP';
    console.log(`[WebService] WECRYPTO web service running: ${protocol}://localhost:${PORT}`);
    console.log(`[WebService] Access via Edge: edge://open?url=https://localhost:${PORT}`);
  });
}

/**
 * Broadcast update to all WebSocket clients
 */
function broadcastUpdate(type, data) {
  if (wss) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type, data }));
      }
    });
  }
}

/**
 * Update global state from Electron renderer
 */
function updateState(stateUpdate) {
  if (!global.WECRYPTO_STATE) {
    global.WECRYPTO_STATE = {};
  }
  Object.assign(global.WECRYPTO_STATE, stateUpdate);
  global.WECRYPTO_STATE.lastUpdate = new Date().toISOString();
  
  // Broadcast to all WebSocket clients
  broadcastUpdate('state', global.WECRYPTO_STATE);
}

/**
 * Format uptime
 */
function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Get web UI HTML
 */
function getWebUIHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WECRYPTO Orchestrator</title>
  <script src="vendors/lightweight-charts.standalone.production.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      background: linear-gradient(135deg, #0b1020 0%, #1a2540 100%);
      color: #e0e0e0;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      height: 100%;
    }
    .container {
      max-width: 1600px;
      margin: 0 auto;
      padding: 20px;
      height: 100%;
      overflow-y: auto;
    }
    header {
      border-bottom: 2px solid #00d4ff;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    h1 {
      color: #00d4ff;
      font-size: 32px;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #90caf9;
      font-size: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .card {
      background: rgba(26, 37, 64, 0.8);
      border: 1px solid #00d4ff;
      border-radius: 8px;
      padding: 20px;
    }
    .card h3 {
      color: #ffd700;
      margin-bottom: 15px;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .signal {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      margin: 8px 0;
      background: rgba(15, 22, 34, 0.8);
      border-radius: 4px;
      border-left: 3px solid #00d4ff;
    }
    .signal.up {
      border-left-color: #26d47e;
    }
    .signal.down {
      border-left-color: #ff4444;
    }
    .signal.wait {
      border-left-color: #ffd700;
    }
    .coin-name {
      font-weight: 700;
      color: #ffd700;
    }
    .direction {
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .direction.up {
      background: rgba(38, 212, 126, 0.2);
      color: #26d47e;
    }
    .direction.down {
      background: rgba(255, 68, 68, 0.2);
      color: #ff4444;
    }
    .direction.wait {
      background: rgba(255, 215, 0, 0.2);
      color: #ffd700;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: #00d4ff;
      margin: 10px 0;
    }
    .stat-label {
      font-size: 12px;
      color: #90caf9;
      text-transform: uppercase;
    }
    .markets-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .market {
      background: rgba(15, 22, 34, 0.8);
      padding: 12px;
      border-radius: 4px;
      border-left: 3px solid #00d4ff;
    }
    .market-name {
      color: #ffd700;
      font-weight: 700;
      font-size: 12px;
    }
    .market-price {
      color: #26d47e;
      font-size: 18px;
      margin: 8px 0;
    }
    .market-prob {
      color: #90caf9;
      font-size: 12px;
    }
    .status-icon {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-right: 8px;
    }
    .status-icon.online {
      background: #26d47e;
    }
    .status-icon.offline {
      background: #ff4444;
    }
    .ws-status {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 10px 15px;
      background: rgba(26, 37, 64, 0.9);
      border: 1px solid #00d4ff;
      border-radius: 4px;
      font-size: 12px;
      color: #90caf9;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🚀 WECRYPTO Orchestrator</h1>
      <p class="subtitle">Real-time Kalshi 15-minute prediction engine</p>
    </header>

    <div class="grid">
      <!-- Live Signals -->
      <div class="card">
        <h3>📊 Live Signals (h15m)</h3>
        <div id="signals-container">
          <div style="color: #888;">Loading...</div>
        </div>
      </div>

      <!-- Statistics -->
      <div class="card">
        <h3>📈 Statistics</h3>
        <div class="stat-label">Overall Win Rate</div>
        <div class="stat-value" id="win-rate">—</div>
        <div class="stat-label">Total Records</div>
        <div class="stat-value" id="total-records">—</div>
        <div class="stat-label">Avg Confidence</div>
        <div class="stat-value" id="avg-confidence">—</div>
      </div>

      <!-- Kalshi Markets -->
      <div class="card">
        <h3>💰 Kalshi Markets (15m)</h3>
        <div class="markets-grid" id="markets-container">
          <div style="color: #888;">Loading...</div>
        </div>
      </div>

      <!-- Network Status -->
      <div class="card">
        <h3>🌐 Network Status</h3>
        <div id="network-status">
          <div style="color: #888;">Loading blockchain metrics...</div>
        </div>
      </div>
    </div>

    <!-- System Status -->
    <div class="card">
      <h3>⚙️ System Status</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px;">
        <div>
          <div class="stat-label">Uptime</div>
          <div class="stat-value" id="uptime">—</div>
        </div>
        <div>
          <div class="stat-label">Memory</div>
          <div class="stat-value" id="memory">—</div>
        </div>
        <div>
          <div class="stat-label">Platform</div>
          <div class="stat-value" id="platform" style="font-size: 16px;">—</div>
        </div>
        <div>
          <div class="stat-label">WECRYPTO Status</div>
          <div style="margin-top: 10px;"><span class="status-icon online"></span><span id="app-status">Connecting...</span></div>
        </div>
      </div>
    </div>
  </div>

  <div class="ws-status">
    <span class="status-icon" id="ws-icon"></span>
    <span id="ws-text">Connecting...</span>
  </div>

  <script>
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}\`;
    let ws = null;

    function connectWebSocket() {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[Web] WebSocket connected');
        updateWSStatus(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'state') {
            updateUI(msg.data);
          }
        } catch (e) {
          console.error('[Web] Parse error:', e);
        }
      };

      ws.onerror = (err) => {
        console.error('[Web] WebSocket error:', err);
        updateWSStatus(false);
      };

      ws.onclose = () => {
        console.log('[Web] WebSocket closed');
        updateWSStatus(false);
        setTimeout(connectWebSocket, 3000);
      };
    }

    function updateWSStatus(connected) {
      const icon = document.getElementById('ws-icon');
      const text = document.getElementById('ws-text');
      if (connected) {
        icon.className = 'status-icon online';
        text.textContent = 'Live';
      } else {
        icon.className = 'status-icon offline';
        text.textContent = 'Offline';
      }
    }

    function updateUI(state) {
      // Update signals
      if (state.signals) {
        const html = Object.entries(state.signals).map(([coin, sig]) => {
          const dir = sig.direction.toLowerCase();
          const color = dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'wait';
          return \`
            <div class="signal \${color}">
              <span class="coin-name">\${coin}</span>
              <div style="display: flex; gap: 10px; align-items: center;">
                <span style="color: #90caf9;">\${sig.confidence}%</span>
                <span class="direction \${color}">\${sig.direction}</span>
              </div>
            </div>
          \`;
        }).join('');
        document.getElementById('signals-container').innerHTML = html || '<div style="color: #888;">No signals</div>';
      }

      // Update stats
      if (state.stats) {
        document.getElementById('win-rate').textContent = (state.stats.win_rate || 0) + '%';
        document.getElementById('total-records').textContent = state.stats.total || 0;
        document.getElementById('avg-confidence').textContent = (state.stats.avg_confidence || 0).toFixed(2);
      }

      // Update markets
      if (state.kalshiMarkets) {
        const html = Object.entries(state.kalshiMarkets).map(([market, data]) => {
          return \`
            <div class="market">
              <div class="market-name">\${market}</div>
              <div class="market-price">\${data.price || '—'}</div>
              <div class="market-prob">\${data.probability || '—'}% YES</div>
            </div>
          \`;
        }).join('');
        document.getElementById('markets-container').innerHTML = html || '<div style="color: #888;">No markets</div>';
      }

      // Update network status
      if (state.networkStatus) {
        const html = Object.entries(state.networkStatus).map(([coin, net]) => {
          return \`
            <div style="margin: 8px 0; padding: 8px; background: rgba(15,22,34,0.8); border-radius: 4px;">
              <strong style="color: #ffd700;">\${coin}</strong>
              <div style="color: #90caf9; font-size: 12px;">
                \${Object.entries(net).map(([k,v]) => \`\${k}: \${v}\`).join(' | ')}
              </div>
            </div>
          \`;
        }).join('');
        document.getElementById('network-status').innerHTML = html || '<div style="color: #888;">No data</div>';
      }

      // Update system status
      if (state.system) {
        document.getElementById('uptime').textContent = state.system.uptime_formatted || '—';
        document.getElementById('memory').textContent = 
          Math.round((state.system.memory?.heapUsed || 0) / 1024 / 1024) + ' MB';
        document.getElementById('platform').textContent = state.system.platform || '—';
      }

      document.getElementById('app-status').textContent = state.running ? 'Running' : 'Offline';
    }

    // Load initial data
    async function loadInitialData() {
      try {
        const [predsRes, statsRes, marketsRes, networkRes, statusRes] = await Promise.all([
          fetch('/api/predictions'),
          fetch('/api/stats'),
          fetch('/api/kalshi-markets'),
          fetch('/api/network-status'),
          fetch('/api/status')
        ]);

        const preds = await predsRes.json();
        const stats = await statsRes.json();
        const markets = await marketsRes.json();
        const network = await networkRes.json();
        const status = await statusRes.json();

        const combined = {
          signals: preds.predictions || {},
          stats: stats.stats || {},
          kalshiMarkets: markets.markets || {},
          networkStatus: network.status || {},
          system: status.system || {},
          running: status.wecrypto?.running
        };

        updateUI(combined);
      } catch (e) {
        console.error('[Web] Error loading data:', e);
      }
    }

    // Start
    connectWebSocket();
    loadInitialData();
    setInterval(loadInitialData, 5000);
  </script>
</body>
</html>
  `;
}

// Export
module.exports = {
  startWebService,
  updateState,
  broadcastUpdate,
  PORT,
  HOST
};

console.log('[WECRYPTO WebService] Module loaded');
