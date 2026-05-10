const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load .env — check next to .exe (packaged) then repo root (dev)
try {
  const dotenv = require('dotenv');
  const exeDir = path.dirname(app.getPath ? process.execPath : __filename);
  const candidates = [
    path.join(exeDir, '.env'),                  // next to .exe (packaged)
    path.join(__dirname, '..', '.env'),          // repo root (dev)
    path.join(process.resourcesPath || '', '..', '.env'), // resources sibling
  ];
  let loadedEnvPath = null;
  for (const p of candidates) {
    if (require('fs').existsSync(p)) {
      dotenv.config({ path: p, quiet: true });
      loadedEnvPath = p;
      break;
    }
  }
  if (loadedEnvPath) {
    console.log(`[Env] Loaded .env from ${loadedEnvPath}`);
  } else {
    console.log('[Env] No .env file found in startup candidates');
  }
} catch (e) {
  // dotenv not installed, skip silently
}

// ── Kalshi Worker Bridge ──────────────────────────────────────────────────
const { startKalshiWorker, stopKalshiWorker, getWorkerReadiness } = require('./kalshi-ipc-bridge.js');

// ── Multi-Drive Settlement Logger ──────────────────────────────────────────
require('./multi-drive-logger-handlers.js');

// ── Web Service (HTTPS) ────────────────────────────────────────────────────
const { startWebService, updateState, broadcastUpdate } = require('./wecrypto-web-service.js');
let LLMSignalAssistant = null;
try {
  LLMSignalAssistant = require('../src/llm/llm_signal_assistant');
  const diagnostics = typeof LLMSignalAssistant.getDiagnostics === 'function'
    ? LLMSignalAssistant.getDiagnostics()
    : null;
  if (diagnostics?.enabled) {
    console.log(`[LLM] Assistant ready (provider=${diagnostics.provider}, model=${diagnostics.model})`);
  } else {
    console.warn('[LLM] Assistant loaded but disabled - check LLM_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY env vars');
  }
} catch (e) {
  console.warn('[LLM] Assistant module unavailable:', e.message);
}

// ── Pyth Lazer real-time WebSocket service ────────────────────────────────────
let mainWin = null;
let pythLazerClient = null;
let pythLazerStatus = { connected: false, lastDataTs: 0, dataCount: 0, timeoutCount: 0 };
let proxyHealthy = false;
let webServiceHealth = { started: false, mode: 'stopped', protocol: 'http', port: 3443 };
const LAZER_FEED_IDS = [1, 2, 6, 10, 13, 14, 15, 110]; // BTC,ETH,SOL,DOGE,F13,XRP,BNB,F110
const LAZER_ID_MAP = { 1: 'BTCUSD', 2: 'ETHUSD', 6: 'SOLUSD', 10: 'DOGEUSD', 14: 'XRPUSD', 15: 'BNBUSD' };
const PYTH_FALLBACK_TIMEOUT_MS = 1000; // STRICT: 1s timeout before fallback

function configureCachePaths() {
  try {
    const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
    const profileRoot = path.join(localAppData, 'WE-CRYPTO');
    const cacheRoot = path.join(profileRoot, 'electron-cache');
    const userDataPath = path.join(profileRoot, 'user-data');
    const sessionPath = path.join(cacheRoot, 'session-data');
    const diskCacheDir = path.join(cacheRoot, 'disk-cache');
    fs.mkdirSync(profileRoot, { recursive: true });
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(sessionPath, { recursive: true });
    fs.mkdirSync(diskCacheDir, { recursive: true });
    app.setPath('userData', userDataPath);
    app.setPath('sessionData', sessionPath);
    app.commandLine.appendSwitch('disk-cache-dir', diskCacheDir);
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
    console.log(`[Startup] Cache paths configured: userData=${userDataPath} session=${sessionPath} disk=${diskCacheDir}`);
  } catch (e) {
    console.warn('[Startup] Cache path configuration skipped:', e.message);
  }
}

configureCachePaths();

async function startPythLazerService(win) {
  const token = process.env.PYTH_LAZER_TOKEN;
  if (!token) {
    console.warn('[PythLazer] PYTH_LAZER_TOKEN not set — Lazer WS disabled');
    if (!win.isDestroyed()) {
      win.webContents.send('pyth:connection-failed', {
        retries: 0,
        error: 'PYTH_LAZER_TOKEN not set',
      });
    }
    return;
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  let retries = 0;

  async function createClientWithRetry() {
    try {
      retries++;
      console.log(`[PythLazer] Connecting (attempt ${retries}/${MAX_RETRIES})...`);

      const { PythLazerClient } = require('@pythnetwork/pyth-lazer-sdk');
      pythLazerClient = await PythLazerClient.create({
        token,
        webSocketPoolConfig: {
          urls: [
            'wss://pyth-lazer-0.dourolabs.app/v1/stream',
            'wss://pyth-lazer-1.dourolabs.app/v1/stream',
            'wss://pyth-lazer-2.dourolabs.app/v1/stream',
          ],
        },
      });

      pythLazerClient.subscribe({
        type: 'subscribe',
        subscriptionId: 1,
        priceFeedIds: LAZER_FEED_IDS,
        properties: ['price', 'bestBidPrice', 'bestAskPrice', 'confidence', 'exponent',
          'publisherCount', 'feedUpdateTimestamp', 'marketSession',
          'fundingRate', 'fundingTimestamp', 'fundingRateInterval'],
        formats: ['solana', 'leUnsigned', 'leEcdsa', 'evm'],
        channel: 'fixed_rate@1000ms',  // ★ STRICT 1000ms updates for predictable fallback
        deliveryFormat: 'json',
        jsonBinaryEncoding: 'hex',
        parsed: true,
        ignoreInvalidFeeds: true,
      });

      let lastPush = 0;
      let pythTimeoutHandle = null;

      // ★ STRICT TIMEOUT WATCHER: If no data arrives within 1000ms, trigger fallback
      function resetPythTimeout() {
        if (pythTimeoutHandle) clearTimeout(pythTimeoutHandle);
        pythTimeoutHandle = setTimeout(() => {
          pythLazerStatus.connected = false;
          pythLazerStatus.timeoutCount++;
          console.warn(`[PythLazer] ⚠️ TIMEOUT: No data in ${PYTH_FALLBACK_TIMEOUT_MS}ms — fallback triggered`);
          if (!win.isDestroyed()) {
            win.webContents.send('pyth:timeout-fallback', {
              reason: 'no_data_1000ms',
              timeoutCount: pythLazerStatus.timeoutCount,
              fallbackTo: 'crypto.com,binance,coingecko,kraken',
              recoveryAttempt: true
            });
          }
        }, PYTH_FALLBACK_TIMEOUT_MS);
      }
      resetPythTimeout(); // Start watching immediately

      pythLazerClient.addMessageListener((message) => {
        if (message.type !== 'json') return;
        const feeds = message.value?.parsed?.priceFeeds;
        if (!feeds?.length) return;
        const now = Date.now();
        if (now - lastPush < 800) return;    // ~1 push/sec max (fixed_rate@1000ms produces ~1/sec)
        lastPush = now;

        // ★ RESET TIMEOUT on successful data arrival
        resetPythTimeout();

        const prices = {};
        for (const f of feeds) {
          const instr = LAZER_ID_MAP[f.priceFeedId];
          if (!instr) continue;              // skip unmapped feeds (13, 110)
          const exp = f.exponent ?? -8;
          const scale = Math.pow(10, exp);
          const px = Number(f.price) * scale;
          if (!px || px <= 0 || isNaN(px)) continue;
          prices[instr] = {
            instrument_name: instr,
            last: px,
            best_bid: f.bestBidPrice != null ? Number(f.bestBidPrice) * scale : null,
            best_ask: f.bestAskPrice != null ? Number(f.bestAskPrice) * scale : null,
            confidence: f.confidence != null ? Number(f.confidence) * scale : null,
            publisherCount: f.publisherCount,
            marketSession: f.marketSession,
            feedUpdateTimestamp: f.feedUpdateTimestamp,
            source: 'pyth-lazer',
            timestamp: now,
          };
        }
        if (Object.keys(prices).length && !win.isDestroyed()) {
          // ★ UPDATE STATUS: Track Pyth Lazer health
          pythLazerStatus.connected = true;
          pythLazerStatus.lastDataTs = now;
          pythLazerStatus.dataCount++;
          pythLazerStatus.timeoutCount = 0;  // Reset timeout counter on success
          win.webContents.send('pyth:tickers', prices);
          // Also send health status update every 5 data points
          if (pythLazerStatus.dataCount % 5 === 0) {
            win.webContents.send('pyth:status', pythLazerStatus);
          }
        }
      });

      pythLazerClient.addAllConnectionsDownListener(() => {
        console.error('[PythLazer] ⚠️ All WebSocket connections down — auto-reconnect triggered');
        // Renderer will gracefully degrade to other data sources
        if (!win.isDestroyed()) {
          win.webContents.send('pyth:connection-lost', { reason: 'all_connections_down' });
        }
      });

      console.log('[PythLazer] ✅ Client started — feeds:', LAZER_FEED_IDS.join(','));
      return true;

    } catch (e) {
      const errorMsg = e.message || String(e);
      console.error(`[PythLazer] Connection failed: ${errorMsg}`);

      if (retries < MAX_RETRIES) {
        console.log(`[PythLazer] Retrying in ${RETRY_DELAY_MS}ms... (${retries}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        return createClientWithRetry();
      } else {
        console.error(`[PythLazer] ❌ Max retries (${MAX_RETRIES}) reached. Pyth Lazer disabled.`);
        console.error('[PythLazer] → Renderer will use alternative price feeds (Crypto.com, CoinGecko, etc.)');
        if (!win.isDestroyed()) {
          win.webContents.send('pyth:connection-failed', { retries: MAX_RETRIES, error: errorMsg });
        }
        return false;
      }
    }
  }

  return createClientWithRetry();
}

function logStartupHealth(tag = 'snapshot') {
  const kalshi = typeof getWorkerReadiness === 'function'
    ? getWorkerReadiness()
    : { ready: false, readyLatencyMs: null, lastHealthError: 'readiness unavailable' };
  const pythAgeMs = pythLazerStatus.lastDataTs
    ? Date.now() - pythLazerStatus.lastDataTs
    : null;
  const summary = {
    tag,
    proxy: { healthy: proxyHealthy, port: proxyPort },
    kalshi: {
      ready: !!kalshi.ready,
      readyLatencyMs: kalshi.readyLatencyMs,
      lastHealthError: kalshi.lastHealthError || null,
    },
    web: {
      started: !!webServiceHealth.started,
      mode: webServiceHealth.mode,
      protocol: webServiceHealth.protocol,
      port: webServiceHealth.port,
    },
    pyth: {
      connected: !!pythLazerStatus.connected,
      dataCount: pythLazerStatus.dataCount,
      timeoutCount: pythLazerStatus.timeoutCount,
      lastDataAgeMs: pythAgeMs,
    },
  };
  const issues = [];
  if (!summary.kalshi.ready) issues.push('kalshi-not-ready');
  if (!summary.web.started) issues.push('web-not-started');
  if (summary.web.mode === 'http-fallback') issues.push('web-http-fallback');
  if (!summary.proxy.healthy) issues.push('proxy-fallback');
  if (summary.pyth.timeoutCount > 0) issues.push('pyth-timeout-fallback');
  const grade = (!summary.kalshi.ready || !summary.web.started)
    ? 'RED'
    : issues.length > 0
      ? 'YELLOW'
      : 'GREEN';
  summary.grade = grade;
  summary.issues = issues;
  console.log('[StartupHealth]', JSON.stringify(summary));
}

// ── Proxy server lifecycle ────────────────────────────────────────────────────
let proxyProcess = null;
let proxyPort = 3010;

const PROXY_PORT_CASCADE = [3010, 3011, 3012, 3013, 3014];

// Find the first port in the cascade that isn't already occupied
function findFreePort(ports) {
  const net = require('net');
  return new Promise(resolve => {
    let idx = 0;
    function tryNext() {
      if (idx >= ports.length) { resolve(ports[0]); return; }
      const port = ports[idx++];
      const srv = net.createServer();
      srv.once('error', tryNext);
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    }
    tryNext();
  });
}

// Embed full exchange config so we can write a tailored config.toml at runtime
function buildProxyConfig(port) {
  return `[server]
host         = "127.0.0.1"
port         = ${port}
timeout_secs = 12

[exchanges]
binance         = "https://api.binance.us"
binance-f       = "https://fapi.binance.com"
coingecko       = "https://api.coingecko.com"
coinbase        = "https://api.coinbase.com"
coinbase-ex     = "https://api.exchange.coinbase.com"
kraken          = "https://api.kraken.com"
bybit           = "https://api.bybit.com"
okx             = "https://www.okx.com"
kalshi          = "https://api.elections.kalshi.com"
polymarket      = "https://gamma-api.polymarket.com"
polymarket-clob = "https://clob.polymarket.com"
bitfinex        = "https://api-pub.bitfinex.com"
kucoin          = "https://api.kucoin.com"
mexc            = "https://api.mexc.com"
hypurrscan      = "https://hypurrscan.io"
dexscreener     = "https://api.dexscreener.com"
mempool         = "https://mempool.space"
blockchair      = "https://api.blockchair.com"
etherscan       = "https://api.etherscan.io"
bscscan         = "https://api.bscscan.com"
blockscout-eth  = "https://eth.blockscout.com"
blockscout-bsc  = "https://bsc.blockscout.com"
hyperliquid     = "https://api.hyperliquid.xyz"
blockcypher     = "https://api.blockcypher.com"
ripple          = "https://s2.ripple.com"
xrpl            = "https://xrplcluster.com"
solana          = "https://api.mainnet-beta.solana.com"
crypto-com      = "https://api.crypto.com"
`;
}

async function startProxy() {
  // Dev: __dirname  |  Packaged: resources/app.asar.unpacked/
  // KEY: When running inside app.asar, __dirname is inside the archive (can't execute).
  // Must ALWAYS look in app.asar.unpacked, not app.asar.
  const candidates = [
    // Correct packaged path: resources/app.asar.unpacked/we-crypto-proxy.exe (CHECK FIRST)
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'we-crypto-proxy.exe'),
    // Alternate: resourcesPath itself
    path.join(process.resourcesPath || '', 'we-crypto-proxy.exe'),
    // Dev path: electron/ is one level down from root, so ../we-crypto-proxy.exe
    path.join(__dirname, '..', 'we-crypto-proxy.exe'),
  ];

  const exePath = candidates.find(p => fs.existsSync(p));
  if (!exePath) {
    console.error('[proxy] CRITICAL: we-crypto-proxy.exe not found. Searched:', candidates);
    console.warn('[proxy] Falling back to direct API access (NO proxy routing)');
    console.warn('[proxy] Remediation:');
    console.warn('[proxy] 1) Dev mode: place we-crypto-proxy.exe at project root (same level as package.json)');
    console.warn('[proxy] 2) Packaged mode: ensure build.files includes we-crypto-proxy.exe and it is unpacked to resources/app.asar.unpacked');
    console.warn('[proxy] 3) Validate from terminal: Test-Path .\\we-crypto-proxy.exe');
    return;
  }
  console.log(`[proxy] found executable at: ${exePath}`);

  // Pick a free port then write config.toml
  const chosenPort = await findFreePort(PROXY_PORT_CASCADE);
  proxyPort = chosenPort;

  // If exe is in asar (read-only), write config to temp dir; otherwise beside exe
  let proxyDir = path.dirname(exePath);
  if (proxyDir.includes('app.asar')) {
    proxyDir = path.join(process.env.TEMP || path.join(app.getPath('appData'), 'WECRYP'), 'proxy-config');
    fs.mkdirSync(proxyDir, { recursive: true });
    console.log(`[proxy] writing config to temp: ${proxyDir}`);
  }

  try {
    fs.writeFileSync(path.join(proxyDir, 'config.toml'), buildProxyConfig(chosenPort));
    console.log(`[proxy] config.toml → port ${chosenPort}`);
  } catch (e) {
    console.warn('[proxy] could not write config.toml:', e.message);
  }

  proxyProcess = spawn(exePath, [], {
    detached: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    cwd: proxyDir,
  });
  proxyProcess.stdout.on('data', chunk => console.log('[proxy]', chunk.toString().trim()));
  proxyProcess.on('error', e => console.error('[proxy] start error:', e.message));
  proxyProcess.on('exit', code => console.log('[proxy] exited, code', code));
  console.log(`[proxy] started on port ${chosenPort} — pid ${proxyProcess.pid}`);
}

function stopProxy() {
  if (proxyProcess && !proxyProcess.killed) {
    try { proxyProcess.kill(); } catch (_) { }
    proxyProcess = null;
  }
}

// ── Wait for proxy to bind (tries each port in cascade, max 5s) ──────────────
function waitForProxy(maxMs = 5000, pollMs = 150) {
  const http = require('http');
  return new Promise(resolve => {
    const deadline = Date.now() + maxMs;
    let portIdx = 0;

    function tryPort() {
      const port = PROXY_PORT_CASCADE[portIdx] || PROXY_PORT_CASCADE[0];
      const req = http.get(`http://127.0.0.1:${port}/health`, res => {
        res.resume();
        proxyPort = port;           // lock in the responsive port
        proxyHealthy = true;
        resolve();
      });
      req.on('error', () => {
        if (Date.now() >= deadline) {
          proxyHealthy = false;
          resolve();
          return;
        }  // give up gracefully
        // advance through cascade before retrying
        portIdx = (portIdx + 1) % PROXY_PORT_CASCADE.length;
        setTimeout(tryPort, pollMs);
      });
      req.setTimeout(200, () => { req.destroy(); });
    }
    tryPort();
  });
}

// ── IPC: proxy port discovery ─────────────────────────────────────────────
ipcMain.handle('proxy:port', () => proxyPort);

// ── IPC: Pyth Lazer handlers ──────────────────────────────────────────────
ipcMain.handle('pyth:getCandles', async (_, { symbol, resolution, from, to }) => {
  try {
    if (!pythLazerClient) {
      return { success: false, error: 'Pyth Lazer client not initialized' };
    }

    // Use Pyth History API to fetch candles
    const historyUrl = `https://api.dourolabs.app/v1/ohlc?instrument_name=${symbol}&resolution=${resolution}&start_time=${from}&end_time=${to}`;
    const response = await fetch(historyUrl);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const candles = data.ohlc || [];

    return {
      success: true,
      candles: candles.map(c => ({
        t: c.timestamp,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume,
      }))
    };
  } catch (e) {
    console.warn('[PythLazer] getCandles failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pyth:getProxyLatest', async (_, feedIds) => {
  try {
    // Use Pyth Lazer proxy REST (no-auth) for latest prices
    const url = `https://pyth-lazer-proxy-0.dourolabs.app/v1/latest_price?price_feed_ids=${feedIds.join(',')}`;
    const response = await fetch(url);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    return {
      success: true,
      prices: data.prices || []
    };
  } catch (e) {
    console.warn('[PythLazer] getProxyLatest failed:', e.message);
    return { success: false, error: e.message };
  }
});

// ── IPC: Kalshi credentials loader ─────────────────────────────────────────
ipcMain.handle('kalshi:loadCredentials', async () => {
  try {
    const credPath = path.join(__dirname, '../secrets/KALSHI-API-KEY.txt');
    if (!fs.existsSync(credPath)) {
      return {
        success: false,
        error: 'KALSHI-API-KEY.txt not found'
      };
    }

    const content = fs.readFileSync(credPath, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

    if (lines.length < 5) {
      return {
        success: false,
        error: 'Invalid credential file format'
      };
    }

    const apiKeyId = lines[0];
    const privateKeyPem = lines.slice(4).join('\n');

    return {
      success: true,
      apiKeyId,
      privateKeyPem
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

// ── IPC: File system helpers for DataLogger ────────────────────────────────
ipcMain.handle('data:ensureDir', async (_, dirPath) => {
  try { fs.mkdirSync(dirPath, { recursive: true }); return true; }
  catch (e) { return false; }
});

ipcMain.handle('data:appendLine', async (_, filePath, line) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line + '\n', 'utf8');
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('data:writeFile', async (_, filePath, content) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('data:readFile', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, notFound: true };
    return { ok: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('data:listDir', async (_, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) return { ok: false, notFound: true };
    return { ok: true, entries: fs.readdirSync(dirPath) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: Log network errors to COPILOT_DEBUG ──────────────────────────────────
ipcMain.handle('network:logError', async (_, errorType, details) => {
  try {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${errorType} | ${details}`;

    const logRoots = new Set([
      'F:\\WECRYP',
      'D:\\WECRYP',
    ]);

    try {
      const drives = await ipcMain._invokeHandler('storage:getDrives', { sender: null });
      for (const drive of Array.isArray(drives) ? drives : []) {
        if (drive?.type !== 'network' || !drive?.root) continue;
        logRoots.add(path.join(drive.root, 'WECRYP'));
      }
    } catch (_) { }

    for (const root of logRoots) {
      try {
        const debugDir = path.join(root, 'COPILOT_DEBUG');
        fs.mkdirSync(debugDir, { recursive: true });
        const logFile = path.join(debugDir, 'network-errors.log');
        fs.appendFileSync(logFile, logLine + '\n', 'utf8');
      } catch (_) { }
    }

    console.log(`[IPC] Network error logged: ${errorType}`);
    return true;
  } catch (e) {
    console.error('[IPC] Failed to log network error:', e.message);
    return false;
  }
});

// ── IPC: Read Kalshi CSV and parse trades ──────────────────────────────
ipcMain.handle('kalshi:loadCSVTrades', async (event, browserStateJson) => {
  try {
    // Try multiple locations in order:
    // 1. F:\WECRYP\ (home location)
    // 2. D:\WECRYP\ (backup)
    // 3. Relative to app.getAppPath()
    const candidates = [
      'F:\\WECRYP\\Kalshi-Recent-Activity-All.csv',
      'D:\\WECRYP\\Kalshi-Recent-Activity-All.csv',
      path.join(app.getAppPath(), '..', '..', 'Kalshi-Recent-Activity-All.csv'),
      path.join(app.getAppPath(), 'Kalshi-Recent-Activity-All.csv'),
    ];

    let csvPath = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        csvPath = candidate;
        break;
      }
    }

    if (!csvPath) {
      console.warn(`[IPC] CSV not found in candidates:`, candidates);
      return { success: false, trades: [], error: 'CSV file not found in any location' };
    }

    console.log(`[IPC] Loading CSV from: ${csvPath}`);

    const content = fs.readFileSync(csvPath, 'utf-8');

    // Simple CSV parser
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      return { success: false, trades: [], error: 'CSV is empty' };
    }

    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const trades = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      // Parse CSV carefully (handle quoted fields)
      const values = [];
      let inQuotes = false;
      let current = '';
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim().replace(/^"|"$/g, ''));
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim().replace(/^"|"$/g, ''));

      const record = {};
      headers.forEach((h, idx) => {
        record[h] = values[idx] || '';
      });

      // Filter: only filled orders (source data for entries)
      // CSV has: type="Order", Status="Filled", no Result yet (will merge with resolution log)
      if (record.type === 'Order' && record.Status === 'Filled') {
        const symMatch = record.Market_Ticker?.match(/KX(\w+)15M/);
        const coin = symMatch ? symMatch[1].substring(0, 3) : null;

        if (coin) {
          trades.push({
            timestamp: new Date(record.Original_Date).getTime(),
            originalDate: record.Original_Date,
            marketTicker: record.Market_Ticker,
            symbol: coin,
            direction: record.Direction?.toUpperCase() || '', // BUY = UP, SELL = DOWN
            yesPrice: parseFloat(record.Yes_Contracts_Average_Price_In_Cents) || 0,
            noPrice: parseFloat(record.No_Contracts_Average_Price_In_Cents) || 0,
            profit: parseFloat(record.Profit_In_Dollars) || 0,
            // Result will come from resolution log merge
          });
        }
      }
    }

    console.log(`[IPC] Parsed ${trades.length} filled Kalshi orders from CSV`);

    // Try to parse resolution log from browser state
    let resolutionLog = [];
    try {
      if (browserStateJson) {
        const state = JSON.parse(browserStateJson);
        resolutionLog = state.resolutionLog || [];
        console.log(`[IPC] Received ${resolutionLog.length} resolution records from browser`);
      }
    } catch (e) {
      console.warn(`[IPC] Could not parse browser state:`, e.message);
    }

    return {
      success: true,
      trades,
      csvPath,
      count: trades.length,
      resolutionCount: resolutionLog.length,
      resolution: resolutionLog
    };
  } catch (error) {
    console.error('[IPC] Error loading Kalshi CSV:', error.message);
    return { success: false, trades: [], error: error.message };
  }
});

// ── IPC: Fetch historical contracts from Kalshi API ──────────────────────────
ipcMain.handle('kalshi:fetchHistoricalContracts', async (event, { limit = 100, symbol = null } = {}) => {
  try {
    const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

    console.log(`[IPC] Fetching historical contracts from Kalshi (limit: ${limit}, symbol: ${symbol})`);

    // Fetch portfolio to get user's historical contract IDs
    const portfolioResp = await fetch(`${KALSHI_BASE}/portfolio`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!portfolioResp.ok) {
      console.warn('[IPC] Kalshi portfolio fetch failed');
      return { success: false, contracts: [], error: 'Portfolio fetch failed' };
    }

    const portfolio = await portfolioResp.json();
    const contracts = portfolio.contracts || [];

    // Filter by symbol if requested
    let filtered = contracts;
    if (symbol) {
      filtered = contracts.filter(c => c.ticker && c.ticker.includes(symbol));
    }

    // Return most recent contracts up to limit
    const result = filtered
      .sort((a, b) => new Date(b.resolved_at || b.created_at) - new Date(a.resolved_at || a.created_at))
      .slice(0, limit)
      .map(c => ({
        symbol: c.ticker?.match(/KX(\w+)/)?.[1] || null,
        ticker: c.ticker,
        direction: c.side?.toUpperCase(), // BUY = YES (UP), SELL = NO (DOWN)
        result: c.resolved_at ? (c.outcome === 'YES' ? 'UP' : 'DOWN') : null,
        timestamp: new Date(c.resolved_at || c.created_at).getTime(),
        resolvedAt: c.resolved_at,
        profit: c.pnl || 0,
        quantity: c.quantity,
        avgPrice: c.avg_price,
        source: 'kalshi-api',
      }));

    console.log(`[IPC] Fetched ${result.length} historical contracts from Kalshi API`);
    return { success: true, contracts: result, count: result.length };
  } catch (error) {
    console.error('[IPC] Error fetching Kalshi historical:', error.message);
    return { success: false, contracts: [], error: error.message };
  }
});

const CONTRACT_CACHE_FILE_DISCOVERY_TTL_MS = 30 * 1000;
let contractCacheDiscoveryMemo = {
  expiresAt: 0,
  directFiles: [],
  directories: [],
};

function normalizeCachePath(input) {
  if (!input || typeof input !== 'string') return '';
  let normalized = input.trim();
  if (!normalized) return '';
  const isUNC = normalized.startsWith('\\\\');
  normalized = normalized.replace(/^\\\\\?\\/, '');       // strip Windows extended prefix
  normalized = normalized.replace(/[\\/]+/g, '\\');       // accept mixed / and \\ styles
  if (/^[A-Za-z]:\\$/.test(normalized)) return normalized; // keep drive roots (e.g., C:\)
  normalized = normalized.replace(/\\+$/, '');             // trim trailing slash
  if (isUNC && !normalized.startsWith('\\\\')) normalized = `\\${normalized}`;
  return normalized;
}

function dedupePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const p of paths || []) {
    const normalized = normalizeCachePath(p);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function buildStaticContractCacheFiles(home) {
  return dedupePaths([
    // Primary working drives
    'F:\\WECRYP\\data\\contract-cache.json',
    'F:\\WECRYP\\contract-cache.json',
    'D:\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'D:\\WECRYP\\data\\contract-cache.json',

    // OneDrive locations
    `${home}\\OneDrive\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\OneDrive\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\OneDrive - Personal\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\OneDrive - Personal\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\OneDrive - ctstate.edu\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\OneDrive - ctstate.edu\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\OneDrive - Azure ctstate.edu\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\OneDrive - Azure ctstate.edu\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\OneDrive\\WECRYP\\contract-cache-2h.json`,
    `${home}\\OneDrive\\WECRYP\\contract-cache.json`,
    `${home}\\OneDrive - Personal\\WECRYP\\contract-cache-2h.json`,
    `${home}\\OneDrive - Personal\\WECRYP\\contract-cache.json`,
    `${home}\\OneDrive - ctstate.edu\\WECRYP\\contract-cache-2h.json`,
    `${home}\\OneDrive - ctstate.edu\\WECRYP\\contract-cache.json`,
    `${home}\\OneDrive - Azure ctstate.edu\\WECRYP\\contract-cache-2h.json`,
    `${home}\\OneDrive - Azure ctstate.edu\\WECRYP\\contract-cache.json`,

    // Google Drive
    `${home}\\Google Drive\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\Google Drive\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\Google Drive\\WECRYP\\contract-cache-2h.json`,
    `${home}\\Google Drive\\WECRYP\\contract-cache.json`,
    `${home}\\My Drive\\WE-CRYPTO-CACHE\\contract-cache-2h.json`,
    `${home}\\My Drive\\WE-CRYPTO-CACHE\\contract-cache.json`,
    `${home}\\My Drive\\WECRYP\\contract-cache-2h.json`,
    `${home}\\My Drive\\WECRYP\\contract-cache.json`,
    'G:\\My Drive\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'G:\\My Drive\\WE-CRYPTO-CACHE\\contract-cache.json',

    // C: drive (OS/temp)
    'C:\\WE-CRYPTO-CACHE\\contract-cache.json',
    'C:\\WECRYP\\contract-cache.json',
    `${home}\\AppData\\Local\\WECRYP\\contract-cache.json`,

    // Network drives (Z:, Y:, etc.)
    'Z:\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'Z:\\WE-CRYPTO-CACHE\\contract-cache.json',
    'Z:\\WECRYP\\contract-cache-2h.json',
    'Z:\\WECRYP\\contract-cache.json',
    'Y:\\WE-CRYPTO-CACHE\\contract-cache-2h.json',
    'Y:\\WE-CRYPTO-CACHE\\contract-cache.json',
  ]);
}

function buildAutoDiscoveryDirectories(home) {
  const dirs = [];
  const rootCandidates = new Set();

  // Cloud roots from env vars (machine-specific, robust when using 2+ machines)
  [
    process.env.OneDrive,
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
    process.env.OneDriveBusiness,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : null,
    home,
    `${home}\\Google Drive`,
    `${home}\\My Drive`,
    'G:\\My Drive',
    'Z:\\My Drive',
    'Y:\\My Drive',
  ].forEach((p) => { if (p) rootCandidates.add(normalizeCachePath(p)); });

  // Enumerate local/mapped drives C-Z and include root-level cache folders
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = normalizeCachePath(`${letter}:\\`);
    try {
      fs.accessSync(root, fs.constants.R_OK);
      rootCandidates.add(root);
      rootCandidates.add(`${root}\\My Drive`);
    } catch (_) { }
  }

  // Discover OneDrive folder variants under home (e.g., OneDrive - org)
  try {
    if (home && fs.existsSync(home)) {
      for (const entry of fs.readdirSync(home)) {
        if (typeof entry === 'string' && entry.startsWith('OneDrive')) {
          rootCandidates.add(normalizeCachePath(path.join(home, entry)));
        }
      }
    }
  } catch (_) { }

  for (const root of rootCandidates) {
    if (!root) continue;
    const expanded = [
      root,
      `${root}\\WE-CRYPTO-CACHE`,
      `${root}\\WECRYP`,
      `${root}\\WECRYP\\data`,
      `${root}\\WECRYP\\cache`,
      `${root}\\WECRYP\\settlement-logs`,
    ];
    for (const dirPath of expanded) {
      const normalized = normalizeCachePath(dirPath);
      if (!normalized) continue;
      try {
        if (fs.existsSync(normalized)) dirs.push(normalized);
      } catch (_) { }
    }
  }

  return dedupePaths(dirs);
}

function getContractCacheDiscoveryTargets({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && contractCacheDiscoveryMemo.expiresAt > now) {
    return { ...contractCacheDiscoveryMemo, fromMemo: true };
  }

  const home = normalizeCachePath(process.env.USERPROFILE || process.env.HOME || '');
  const staticFiles = buildStaticContractCacheFiles(home);
  const staticDirs = staticFiles.map((p) => normalizeCachePath(path.dirname(p)));
  const discoveredDirs = buildAutoDiscoveryDirectories(home);
  const directories = dedupePaths([...staticDirs, ...discoveredDirs]);

  contractCacheDiscoveryMemo = {
    expiresAt: now + CONTRACT_CACHE_FILE_DISCOVERY_TTL_MS,
    directFiles: staticFiles,
    directories,
  };
  return { ...contractCacheDiscoveryMemo, fromMemo: false };
}

function gatherContractCacheCandidateFiles(targets) {
  const files = [];
  const pushFile = (filePath) => {
    const normalized = normalizeCachePath(filePath);
    if (!normalized) return;
    if (!/^.*contract-cache.*\.json$/i.test(normalized)) return;
    files.push(normalized);
  };

  (targets.directFiles || []).forEach(pushFile);

  for (const dirPath of targets.directories || []) {
    try {
      if (!fs.existsSync(dirPath)) continue;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry || !entry.isFile()) continue;
        if (!/^contract-cache.*\.json$/i.test(entry.name)) continue;
        pushFile(path.join(dirPath, entry.name));
      }
    } catch (_) { }
  }

  return dedupePaths(files);
}

function extractSettlementsFromContractPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const arrayCandidates = [
    payload.settlements,
    payload.data,
    payload.contracts,
    payload.records,
    payload.cache && payload.cache.settlements,
  ];

  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function toTimestampMs(value) {
  if (Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string') return null;
  const maybeNumber = Number(value);
  if (Number.isFinite(maybeNumber)) return maybeNumber > 1e12 ? maybeNumber : maybeNumber * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSettlementEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const tsFields = [
    entry.timestamp,
    entry.ts,
    entry.settledTs,
    entry.settleTime,
    entry.createdAt,
    entry.created_at,
    entry.resolvedAt,
    entry.resolved_at,
    entry.date,
  ];
  let timestampMs = null;
  for (const field of tsFields) {
    const parsed = toTimestampMs(field);
    if (Number.isFinite(parsed) && parsed > 0) {
      timestampMs = parsed;
      break;
    }
  }

  const inferredSymbol =
    entry.symbol ||
    entry.sym ||
    entry.coin ||
    (typeof entry.ticker === 'string' ? (entry.ticker.match(/KX([A-Z]{3,})/i) || [])[1] || null : null);

  return {
    ...entry,
    symbol: inferredSymbol || null,
    coin: entry.coin || inferredSymbol || null,
    ts: Number.isFinite(entry.ts) ? entry.ts : timestampMs,
    timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : timestampMs,
    settledTs: Number.isFinite(entry.settledTs) ? entry.settledTs : timestampMs,
  };
}

function settlementSortTimestamp(entry) {
  return toTimestampMs(entry?.timestamp)
    || toTimestampMs(entry?.ts)
    || toTimestampMs(entry?.settledTs)
    || 0;
}

function settlementDedupKey(entry) {
  if (entry?.id) return `id:${entry.id}`;
  if (entry?.ticker || entry?.symbol || entry?.coin) {
    const token = entry.ticker || entry.symbol || entry.coin;
    const ts = settlementSortTimestamp(entry);
    const outcome = entry.outcome || entry.result || entry.actualOutcome || 'na';
    return `tok:${token}|ts:${ts}|out:${outcome}`;
  }
  return `fallback:${JSON.stringify(entry)}`;
}

function parseContractCacheFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;

    const parsed = JSON.parse(raw);
    const settlements = extractSettlementsFromContractPayload(parsed)
      .map(normalizeSettlementEntry)
      .filter(Boolean);

    let newestSettlementMs = 0;
    for (const settlement of settlements) {
      const ts = settlementSortTimestamp(settlement);
      if (ts > newestSettlementMs) newestSettlementMs = ts;
    }

    const freshnessMs = Math.max(stats.mtimeMs || 0, newestSettlementMs || 0);

    return {
      filePath: normalizeCachePath(filePath),
      mtimeMs: stats.mtimeMs || 0,
      sizeBytes: stats.size || 0,
      settlementCount: settlements.length,
      newestSettlementMs,
      freshnessMs,
      settlements,
    };
  } catch (_) {
    return null;
  }
}

function mergeRecentSettlements(cacheFiles, maxSources = 12, lookbackMs = 24 * 60 * 60 * 1000) {
  if (!Array.isArray(cacheFiles) || cacheFiles.length === 0) {
    return { merged: [], selectedSources: [] };
  }

  const sorted = [...cacheFiles].sort((a, b) => b.freshnessMs - a.freshnessMs);
  const newestMs = sorted[0].freshnessMs || 0;

  const selectedSources = sorted.filter((entry, idx) => {
    if (idx < 3) return true; // always blend the 3 freshest sources
    if (idx >= maxSources) return false;
    return newestMs - entry.freshnessMs <= lookbackMs;
  });

  const mergedMap = new Map();
  for (const source of selectedSources) {
    for (const settlement of source.settlements || []) {
      const key = settlementDedupKey(settlement);
      const existing = mergedMap.get(key);
      if (!existing || settlementSortTimestamp(settlement) > settlementSortTimestamp(existing)) {
        mergedMap.set(key, settlement);
      }
    }
  }

  const merged = Array.from(mergedMap.values()).sort((a, b) => settlementSortTimestamp(b) - settlementSortTimestamp(a));
  return { merged, selectedSources };
}

ipcMain.handle('storage:readContractCache', async (_event, options = {}) => {
  const startedAt = Date.now();
  const forceRefresh = !!options.forceRefresh;
  const maxSources = Number.isFinite(options.maxSources) ? Math.max(1, options.maxSources) : 12;
  const lookbackMs = Number.isFinite(options.lookbackMs) ? Math.max(0, options.lookbackMs) : 24 * 60 * 60 * 1000;

  const discoveryTargets = getContractCacheDiscoveryTargets({ forceRefresh });
  const candidateFiles = gatherContractCacheCandidateFiles(discoveryTargets);

  console.log(
    `[IPC] Contract cache discovery: ${candidateFiles.length} candidate files ` +
    `across ${discoveryTargets.directories.length} directories ` +
    `(memo=${discoveryTargets.fromMemo ? 'hit' : 'miss'})`
  );

  const parsedFiles = candidateFiles
    .map(parseContractCacheFile)
    .filter(Boolean);

  if (parsedFiles.length === 0) {
    console.warn('[IPC] Contract cache not found on any discovered path');
    return {
      success: false,
      settlements: [],
      data: [],
      contracts: [],
      source: 'not_found',
      count: 0,
      discoveredFiles: 0,
      scanMs: Date.now() - startedAt,
    };
  }

  const sortedByFreshness = [...parsedFiles].sort((a, b) => b.freshnessMs - a.freshnessMs);
  const primary = sortedByFreshness[0];
  const { merged, selectedSources } = mergeRecentSettlements(sortedByFreshness, maxSources, lookbackMs);

  const sources = selectedSources.map((s) => ({
    path: s.filePath,
    count: s.settlementCount,
    mtimeMs: s.mtimeMs,
    newestSettlementMs: s.newestSettlementMs,
    freshnessMs: s.freshnessMs,
    sizeBytes: s.sizeBytes,
  }));

  console.log(
    `[IPC] Loaded ${merged.length} merged settlements ` +
    `from ${selectedSources.length}/${parsedFiles.length} discovered cache files ` +
    `(primary=${primary.filePath})`
  );

  return {
    success: true,
    settlements: merged,
    data: merged,       // back-compat for existing renderer callers
    contracts: merged,  // back-compat alias
    source: primary.filePath,
    count: merged.length,
    discoveredFiles: parsedFiles.length,
    selectedSourceCount: selectedSources.length,
    sources,
    newestTimestamp: merged.length ? settlementSortTimestamp(merged[0]) : null,
    scanMs: Date.now() - startedAt,
    cacheDiscoveryMemoHit: !!discoveryTargets.fromMemo,
  };
});

// ── IPC: Enumerate all available storage roots (local, network, cloud) ──────
ipcMain.handle('storage:getDrives', async () => {
  const found = [];

  // ── Local / mapped drive letters C-Z ─────────────────────────────────────
  for (let code = 67; code <= 90; code++) {        // 'C' … 'Z'
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try { fs.accessSync(root, fs.constants.R_OK); found.push({ type: 'local', letter, root }); }
    catch (_) { }
  }

  // ── Network / UNC shares via `net use` ────────────────────────────────────
  try {
    const { execSync } = require('child_process');
    const out = execSync('net use', { encoding: 'utf8', timeout: 3000 });
    const re = /\\\\[\w\-.]+\\[\w\-.$]+/g;
    for (const unc of (out.match(re) || [])) {
      if (!found.some(d => d.root === unc + '\\')) {
        found.push({ type: 'network', letter: null, root: unc + '\\' });
      }
    }
  } catch (_) { }

  // ── Cloud sync folders (OneDrive / Google Drive) ──────────────────────────
  const home = process.env.USERPROFILE || '';
  const cloudCandidates = [
    `${home}\\OneDrive`,
    `${home}\\OneDrive - Personal`,
    `${home}\\OneDrive - ctstate.edu`,
    `${home}\\OneDrive - Azure ctstate.edu`,
    `${home}\\Google Drive`,
    `${home}\\My Drive`,
  ];
  try {
    if (home && fs.existsSync(home)) {
      for (const name of fs.readdirSync(home)) {
        if (name.startsWith('OneDrive')) {
          const p = path.join(home, name);
          if (!cloudCandidates.includes(p)) cloudCandidates.push(p);
        }
      }
    }
  } catch (_) { }
  for (const p of cloudCandidates) {
    try { if (fs.existsSync(p)) found.push({ type: 'cloud', letter: null, root: p }); }
    catch (_) { }
  }

  return found;
});

// ── IPC: LLM inference bridge (main process inference layer) ──────────────────
ipcMain.handle('llm:analyzeSnapshot', async (_event, snapshot = {}) => {
  if (!LLMSignalAssistant || typeof LLMSignalAssistant.analyzeSnapshot !== 'function') {
    return { success: false, error: 'LLM assistant unavailable' };
  }

  if (!snapshot || typeof snapshot !== 'object' || !snapshot.coin) {
    return { success: false, error: 'Invalid snapshot payload' };
  }

  try {
    const output = await LLMSignalAssistant.analyzeSnapshot(snapshot);
    const diagnostics = typeof LLMSignalAssistant.getDiagnostics === 'function'
      ? LLMSignalAssistant.getDiagnostics()
      : {};
    return { success: true, output, diagnostics };
  } catch (error) {
    return { success: false, error: error.message || 'LLM inference failed' };
  }
});

ipcMain.handle('llm:getDiagnostics', async () => {
  if (!LLMSignalAssistant || typeof LLMSignalAssistant.getDiagnostics !== 'function') {
    return { success: false, error: 'LLM assistant unavailable' };
  }
  try {
    return { success: true, diagnostics: LLMSignalAssistant.getDiagnostics() };
  } catch (error) {
    return { success: false, error: error.message || 'LLM diagnostics failed' };
  }
});

ipcMain.handle('llm:envStatus', async () => {
  const diagnostics = (LLMSignalAssistant && typeof LLMSignalAssistant.getDiagnostics === 'function')
    ? LLMSignalAssistant.getDiagnostics()
    : null;

  const compatibleKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
  const googleKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
  const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL || process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || null;
  const apiUrl = process.env.LLM_API_URL || process.env.OPENAI_BASE_URL || null;
  const provider = process.env.LLM_PROVIDER || 'auto';

  return {
    success: true,
    status: {
      providerConfigured: provider,
      selectedModel: model,
      selectedApiUrl: apiUrl,
      hasCompatibleKey: !!compatibleKey,
      hasGoogleKey: !!googleKey,
      hasDotenvPathOverride: !!process.env.LLM_ENV_PATH,
      envPathOverride: process.env.LLM_ENV_PATH || null,
      assistantLoaded: !!LLMSignalAssistant,
      assistantEnabled: !!diagnostics?.enabled,
      assistantProvider: diagnostics?.provider || null,
      assistantModel: diagnostics?.model || null,
      assistantEnv: diagnostics?.env || null,
      checkedAt: Date.now(),
    },
  };
});

// ── IPC: Validator15m (15-min confidence calibration) ────────────────────────
// Bridge between predictions.js (renderer) and audit-suite
ipcMain.handle('validator:getStats', async (event) => {
  try {
    // Execute in renderer context to access window.Validator15m
    const stats = await event.sender.executeJavaScript(
      'window.Validator15m?.getStats() || { total: 0, hitRate: 0, calibration: [] }'
    );
    return { success: true, data: stats };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('validator:getAll', async (event) => {
  try {
    const validations = await event.sender.executeJavaScript(
      'window.Validator15m?.getAll() || []'
    );
    return { success: true, data: validations };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('validator:getCoin', async (event, sym) => {
  try {
    const coinValidations = await event.sender.executeJavaScript(
      `window.Validator15m?.getAll()?.filter(v => v.sym === '${sym}') || []`
    );
    return { success: true, data: coinValidations };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ── Web Service State Sync ────────────────────────────────────────────────
ipcMain.on('web:update-state', (event, stateUpdate) => {
  updateState(stateUpdate);
});

ipcMain.on('web:broadcast-update', (event, { type, data }) => {
  broadcastUpdate(type, data);
});

function createWindow() {
  const win = mainWin = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b1020',
    icon: path.join(__dirname, '../assets/app-icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    win.webContents.openDevTools();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '../public/index.html'));

  // Inject the live proxy port so proxy-fetch.js can correct itself if it
  // started on the wrong guess before discovery completed.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`window.__PROXY_PORT__ = ${proxyPort};`).catch(() => { });
  });
}

app.whenReady().then(async () => {
  await startProxy();
  await startKalshiWorker({ bootTimeoutMs: 12000, pollMs: 150 });  // Start Kalshi worker with explicit readiness budget
  Menu.setApplicationMenu(null);
  await waitForProxy();   // give proxy ~3s to bind before renderer fires fetchAll

  // Start web service (HTTPS)
  webServiceHealth = startWebService() || webServiceHealth;
  console.log(`[Main] Web service started on ${webServiceHealth.protocol}://localhost:${webServiceHealth.port}`);

  createWindow();
  logStartupHealth('post-bootstrap');

  // Start Pyth Lazer with proper error handling
  (async () => {
    const pythSuccess = await startPythLazerService(mainWin);
    if (pythSuccess) {
      console.log('[Main] Pyth Lazer service initialized successfully');
    } else {
      console.warn('[Main] Pyth Lazer unavailable — renderer will use alternative feeds');
    }
    logStartupHealth('post-pyth-init');
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopProxy();
  stopKalshiWorker();
  if (pythLazerClient) { try { pythLazerClient.shutdown(); } catch (_) { } pythLazerClient = null; }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
