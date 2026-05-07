const { contextBridge, ipcRenderer } = require('electron');
const crypto = require('crypto');
const ws = require('ws');

contextBridge.exposeInMainWorld('desktopApp', {
  isElectron: true,
  // ✅ Expose Node.js modules to renderer safely
  crypto: crypto,
  ws: ws,
  proxyPort:             () => ipcRenderer.invoke('proxy:port'),
  loadKalshiCredentials: () => ipcRenderer.invoke('kalshi:loadCredentials'),
  loadBirdeyeApiKey:     () => ipcRenderer.invoke('birdeye:loadApiKey'),
  // Returns all local drives (C-Z), UNC network shares, and cloud sync folders
  getDrives:             () => ipcRenderer.invoke('storage:getDrives'),
  networkError:          (type, details) => ipcRenderer.invoke('network:logError', type, details),
});

contextBridge.exposeInMainWorld('electron', {
  invoke: ipcRenderer.invoke.bind(ipcRenderer),
  kalshi: {
    loadCSVTrades: (browserStateJson) => ipcRenderer.invoke('kalshi:loadCSVTrades', browserStateJson),
    fetchHistoricalContracts: (opts) => ipcRenderer.invoke('kalshi:fetchHistoricalContracts', opts),
  },
});

contextBridge.exposeInMainWorld('dataStore', {
  appendLine: (filePath, line)    => ipcRenderer.invoke('data:appendLine', filePath, line),
  writeFile:  (filePath, content) => ipcRenderer.invoke('data:writeFile',  filePath, content),
  ensureDir:  (dirPath)           => ipcRenderer.invoke('data:ensureDir',  dirPath),
  readFile:   (filePath)          => ipcRenderer.invoke('data:readFile',   filePath),
  listDir:    (dirPath)           => ipcRenderer.invoke('data:listDir',    dirPath),
});

contextBridge.exposeInMainWorld('auditAPI', {
  validator: {
    getStats: ()       => ipcRenderer.invoke('validator:getStats'),
    getAll: ()         => ipcRenderer.invoke('validator:getAll'),
    getCoin: (sym)     => ipcRenderer.invoke('validator:getCoin', sym),
  }
});

contextBridge.exposeInMainWorld('pythLazer', {
  onTickers:  (cb) => ipcRenderer.on('pyth:tickers', (_e, data) => cb(data)),
  offTickers: ()   => ipcRenderer.removeAllListeners('pyth:tickers'),
});
