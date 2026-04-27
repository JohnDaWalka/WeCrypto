const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  isElectron: true,
  proxyPort:  () => ipcRenderer.invoke('proxy:port'),
  loadKalshiCredentials: () => ipcRenderer.invoke('kalshi:loadCredentials'),
});

contextBridge.exposeInMainWorld('dataStore', {
  appendLine: (filePath, line)    => ipcRenderer.invoke('data:appendLine', filePath, line),
  writeFile:  (filePath, content) => ipcRenderer.invoke('data:writeFile',  filePath, content),
  ensureDir:  (dirPath)           => ipcRenderer.invoke('data:ensureDir',  dirPath),
});
