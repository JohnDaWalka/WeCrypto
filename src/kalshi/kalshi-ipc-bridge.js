/**
 * Kalshi IPC Bridge
 * 
 * Main process (Electron) connects to Kalshi worker via HTTP,
 * then exposes API to renderer via IPC.
 * 
 * This goes in main.js after existing ipc handlers.
 */

const { ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// Kalshi worker state
let kalshiWorker = null;
let kalshiWorkerUrl = 'http://127.0.0.1:3050';

/**
 * Start Kalshi worker as subprocess
 */
async function startKalshiWorker() {
  return new Promise((resolve) => {
    console.log('[Main] Starting Kalshi worker...');
    
    kalshiWorker = spawn('node', [
      path.join(__dirname, 'kalshi-worker.js'),
      '--port', '3050',
      '--env', 'production'
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: __dirname
    });

    // Log worker output
    kalshiWorker.stdout?.on('data', (data) => {
      console.log('[Kalshi Worker]', data.toString().trim());
    });
    kalshiWorker.stderr?.on('data', (data) => {
      console.error('[Kalshi Worker Error]', data.toString().trim());
    });

    kalshiWorker.on('error', (err) => {
      console.error('[Main] Failed to start worker:', err.message);
      resolve(false);
    });

    kalshiWorker.on('exit', (code) => {
      console.log('[Main] Worker exited with code', code);
      kalshiWorker = null;
    });

    // Wait for worker to be ready (health check)
    waitForWorkerReady(5000).then(resolve);
  });
}

/**
 * Wait for worker to be ready
 */
async function waitForWorkerReady(maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${kalshiWorkerUrl}/health`);
      if (res.ok) {
        console.log('[Main] Kalshi worker ready');
        return true;
      }
    } catch (e) {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.warn('[Main] Kalshi worker did not start in time');
  return false;
}

/**
 * Stop Kalshi worker
 */
function stopKalshiWorker() {
  if (kalshiWorker) {
    console.log('[Main] Stopping Kalshi worker...');
    try {
      kalshiWorker.kill();
    } catch (e) {
      console.error('[Main] Error killing worker:', e.message);
    }
    kalshiWorker = null;
  }
}

/**
 * Proxy HTTP request to worker
 */
async function proxyToWorker(method, path, body = null) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${kalshiWorkerUrl}${path}`, options);
    const data = await res.json();
    return {
      success: res.ok,
      data,
      status: res.status
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      status: 0
    };
  }
}

// ──────────────────────────────────────────────────────────────
// IPC Handlers (for renderer process)
// ──────────────────────────────────────────────────────────────

/**
 * kalshi:health — Check if worker is alive
 */
ipcMain.handle('kalshi:health', async () => {
  return await proxyToWorker('GET', '/health');
});

/**
 * kalshi:status — Get full worker status
 */
ipcMain.handle('kalshi:status', async () => {
  return await proxyToWorker('GET', '/status');
});

/**
 * kalshi:balance — Get account balance
 */
ipcMain.handle('kalshi:balance', async () => {
  return await proxyToWorker('GET', '/balance');
});

/**
 * kalshi:markets — Get markets list
 */
ipcMain.handle('kalshi:markets', async (event, options = {}) => {
  const limit = options.limit || 50;
  return await proxyToWorker('GET', `/markets?limit=${limit}`);
});

/**
 * kalshi:events — Get events
 */
ipcMain.handle('kalshi:events', async (event, options = {}) => {
  const ticker = options.ticker ? `?ticker=${encodeURIComponent(options.ticker)}` : '';
  return await proxyToWorker('GET', `/events${ticker}`);
});

/**
 * kalshi:positions — Get your positions
 */
ipcMain.handle('kalshi:positions', async () => {
  return await proxyToWorker('GET', '/positions');
});

/**
 * kalshi:orders — Get your orders
 */
ipcMain.handle('kalshi:orders', async () => {
  return await proxyToWorker('GET', '/orders');
});

/**
 * kalshi:placeOrder — Place an order
 */
ipcMain.handle('kalshi:placeOrder', async (event, orderRequest) => {
  return await proxyToWorker('POST', '/', {
    command: 'placeOrder',
    params: orderRequest
  });
});

/**
 * kalshi:cancelOrder — Cancel an order
 */
ipcMain.handle('kalshi:cancelOrder', async (event, orderId) => {
  return await proxyToWorker('POST', '/', {
    command: 'cancelOrder',
    params: { orderId }
  });
});

/**
 * kalshi:cancelAllOrders — Cancel all orders
 */
ipcMain.handle('kalshi:cancelAllOrders', async (event, filters = {}) => {
  return await proxyToWorker('POST', '/', {
    command: 'cancelAllOrders',
    params: { filters }
  });
});

/**
 * kalshi:getTrades — Get trades for market
 */
ipcMain.handle('kalshi:getTrades', async (event, marketId, filters = {}) => {
  return await proxyToWorker('POST', '/', {
    command: 'getTrades',
    params: { marketId, filters }
  });
});

// ──────────────────────────────────────────────────────────────
// Export for use in main.js
// ──────────────────────────────────────────────────────────────

module.exports = {
  startKalshiWorker,
  stopKalshiWorker,
  getWorkerStatus: () => kalshiWorker ? 'running' : 'stopped'
};
