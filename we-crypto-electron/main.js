const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  win.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

ipcMain.handle('run-backtest', async (event, coin, days) => {
  return new Promise((resolve, reject) => {
    // Prefer packaged JS script located alongside the Electron app
    const scriptPath = path.join(process.cwd(), 'backtest-1yr.js')
    const nodeCmd = 'node'
    const child = spawn(nodeCmd, [scriptPath, '--coin', coin, '--days', String(days)], { cwd: process.cwd() })
    let out = ''
    let err = ''
    child.stdout.on('data', d => out += d.toString())
    child.stderr.on('data', d => err += d.toString())
    child.on('close', code => {
      if (code !== 0) reject(err || `Exit ${code}`)
      else resolve(out)
    })
  })
})
