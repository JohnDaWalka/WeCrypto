const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  isElectron: true,
  proxyPort:             () => ipcRenderer.invoke('proxy:port'),
  loadKalshiCredentials: () => ipcRenderer.invoke('kalshi:loadCredentials'),
  loadBirdeyeApiKey:     () => ipcRenderer.invoke('birdeye:loadApiKey'),
  // Returns all local drives (C-Z), UNC network shares, and cloud sync folders
  getDrives:             () => ipcRenderer.invoke('storage:getDrives'),
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
});

contextBridge.exposeInMainWorld('auditAPI', {
  validator: {
    getStats: ()       => ipcRenderer.invoke('validator:getStats'),
    getAll: ()         => ipcRenderer.invoke('validator:getAll'),
    getCoin: (sym)     => ipcRenderer.invoke('validator:getCoin', sym),
  }
});
