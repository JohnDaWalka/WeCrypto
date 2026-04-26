const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');

// ── Proxy server lifecycle ────────────────────────────────────────────────────
let proxyProcess = null;
let proxyPort    = 3010;

const PROXY_PORT_CASCADE = [3010, 3011, 3012, 3013, 3014];

// Find the first port in the cascade that isn't already occupied
function findFreePort(ports) {
  const net = require('net');
  return new Promise(resolve => {
    let idx = 0;
    function tryNext() {
      if (idx >= ports.length) { resolve(ports[0]); return; }
      const port = ports[idx++];
      const srv  = net.createServer();
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
    // Fallback for dev (root directory)
    path.join(__dirname, '..', '..', 'we-crypto-proxy.exe'),
    // Correct packaged path: resources/app.asar.unpacked/we-crypto-proxy.exe
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'we-crypto-proxy.exe'),
    // Alternate: resourcesPath itself
    path.join(process.resourcesPath || '', 'we-crypto-proxy.exe'),
  ];
  
  const exePath = candidates.find(p => fs.existsSync(p));
  if (!exePath) {
    console.error('[proxy] CRITICAL: we-crypto-proxy.exe not found. Searched:', candidates);
    console.warn('[proxy] Falling back to direct API access (NO proxy routing)');
    return;
  }
  console.log(`[proxy] found executable at: ${exePath}`);

  // Pick a free port then write config.toml beside the exe so the binary uses it
  const chosenPort = await findFreePort(PROXY_PORT_CASCADE);
  proxyPort = chosenPort;
  const proxyDir = path.dirname(exePath);
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
  proxyProcess.on('error', e    => console.error('[proxy] start error:', e.message));
  proxyProcess.on('exit',  code => console.log('[proxy] exited, code', code));
  console.log(`[proxy] started on port ${chosenPort} — pid ${proxyProcess.pid}`);
}

function stopProxy() {
  if (proxyProcess && !proxyProcess.killed) {
    try { proxyProcess.kill(); } catch (_) {}
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
      const req  = http.get(`http://127.0.0.1:${port}/health`, res => {
        res.resume();
        proxyPort = port;           // lock in the responsive port
        resolve();
      });
      req.on('error', () => {
        if (Date.now() >= deadline) { resolve(); return; }  // give up gracefully
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b1020',
    icon: path.join(__dirname, 'app-icon.png'),
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
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Inject the live proxy port so proxy-fetch.js can correct itself if it
  // started on the wrong guess before discovery completed.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`window.__PROXY_PORT__ = ${proxyPort};`).catch(() => {});
  });
}

app.whenReady().then(async () => {
  await startProxy();
  Menu.setApplicationMenu(null);
  await waitForProxy();   // give proxy ~3s to bind before renderer fires fetchAll
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopProxy();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
