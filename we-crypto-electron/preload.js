const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  runBacktest: (coin, days) => ipcRenderer.invoke('run-backtest', coin, days)
})
