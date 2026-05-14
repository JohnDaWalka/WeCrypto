const { contextBridge, ipcRenderer } = require('electron');

function safeRequire(name) {
  try {
    return require(name);
  } catch (_) {
    return null;
  }
}

const crypto = safeRequire('crypto');
const ws = safeRequire('ws');

contextBridge.exposeInMainWorld('desktopApp', {
  isElectron: true,
  // Expose optional Node modules when available in preload context.
  crypto: crypto,
  ws: ws,
  hasNodeCrypto: !!crypto,
  hasNodeWs: !!ws,
  proxyPort: () => ipcRenderer.invoke('proxy:port'),
  loadKalshiCredentials: () => ipcRenderer.invoke('kalshi:loadCredentials'),
  // Returns all local drives (C-Z), UNC network shares, and cloud sync folders
  getDrives: () => ipcRenderer.invoke('storage:getDrives'),
  networkError: (type, details) => ipcRenderer.invoke('network:logError', type, details),
});

contextBridge.exposeInMainWorld('electron', {
  invoke: ipcRenderer.invoke.bind(ipcRenderer),
  web: {
    updateState: (stateUpdate) => ipcRenderer.send('web:update-state', stateUpdate),
    broadcastUpdate: (type, data) => ipcRenderer.send('web:broadcast-update', { type, data }),
  },
  ipcFetch: (url, opts) => ipcRenderer.invoke('ipc:fetch', url, opts),
  kalshi: {
    loadCSVTrades: (browserStateJson) => ipcRenderer.invoke('kalshi:loadCSVTrades', browserStateJson),
    fetchHistoricalContracts: (opts) => ipcRenderer.invoke('kalshi:fetchHistoricalContracts', opts),
  },
  llm: {
    getDiagnostics: () => ipcRenderer.invoke('llm:getDiagnostics'),
    envStatus: () => ipcRenderer.invoke('llm:envStatus'),
  },
});

// Power-user bridge alias for context-isolated renderer integrations
contextBridge.exposeInMainWorld('wecryp', {
  onTelemetry: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('telemetry-update', (_event, value) => callback(value));
  },
  runInference: async (prompt, context) => {
    return await ipcRenderer.invoke('ai:run-inference', { prompt, context });
  },
  syncDrive: async (payload) => {
    return await ipcRenderer.invoke('drive:sync-backup', payload);
  },
  recoverDrive: async (options) => {
    return await ipcRenderer.invoke('drive:recover-backups', options || {});
  },
  cloudStatus: async () => {
    return await ipcRenderer.invoke('google:cloudStatus');
  },
  cloudSqlStatus: async (options) => {
    return await ipcRenderer.invoke('google:cloudSqlStatus', options || {});
  },
  testCloudSql: async () => {
    return await ipcRenderer.invoke('google:testCloudSql');
  },
  tideForecast: async (payload) => {
    return await ipcRenderer.invoke('google:tideForecast', payload);
  },
  firebaseStatus: async () => {
    return await ipcRenderer.invoke('firebase:status');
  },
  firebaseStartupCheck: async (options) => {
    return await ipcRenderer.invoke('firebase:startupCheck', options || {});
  },
  appendInference: async (record) => {
    return await ipcRenderer.invoke('firebase:appendInference', record || {});
  },
  getInferences: async (options) => {
    return await ipcRenderer.invoke('firebase:getInferences', options || {});
  },
});

contextBridge.exposeInMainWorld('dataStore', {
  appendLine: (filePath, line) => ipcRenderer.invoke('data:appendLine', filePath, line),
  writeFile: (filePath, content) => ipcRenderer.invoke('data:writeFile', filePath, content),
  ensureDir: (dirPath) => ipcRenderer.invoke('data:ensureDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('data:readFile', filePath),
  listDir: (dirPath) => ipcRenderer.invoke('data:listDir', dirPath),
});

contextBridge.exposeInMainWorld('auditAPI', {
  validator: {
    getStats: () => ipcRenderer.invoke('validator:getStats'),
    getAll: () => ipcRenderer.invoke('validator:getAll'),
    getCoin: (sym) => ipcRenderer.invoke('validator:getCoin', sym),
  }
});

contextBridge.exposeInMainWorld('pythLazer', {
  onTickers: (cb) => ipcRenderer.on('pyth:tickers', (_e, data) => cb(data)),
  offTickers: () => ipcRenderer.removeAllListeners('pyth:tickers'),
  onStatus: (cb) => ipcRenderer.on('pyth:status', (_e, data) => cb(data)),
  onTimeout: (cb) => ipcRenderer.on('pyth:timeout-fallback', (_e, data) => cb(data)),
  onConnectionLost: (cb) => ipcRenderer.on('pyth:connection-lost', (_e, data) => cb(data)),
  onConnectionFailed: (cb) => ipcRenderer.on('pyth:connection-failed', (_e, data) => cb(data)),
  getCandles: (opts) => ipcRenderer.invoke('pyth:getCandles', opts),
  getProxyLatest: (feedIds) => ipcRenderer.invoke('pyth:getProxyLatest', feedIds),
});
