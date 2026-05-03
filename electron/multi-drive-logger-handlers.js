/**
 * Multi-Drive Settlement Logger - Main Process Handler
 * 
 * Handles file operations across:
 * - Network drives
 * - OneDrive (both personal + business)
 * - Google Drive
 * 
 * Add this to electron/main.js after other ipcMain handlers
 */

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Initialize all target directories
 */
ipcMain.on('multi-drive:init-directories', (event, { targets, filename }) => {
  const syncStatus = {
    network_drives: {},
    onedrive: {},
    google_drive: {}
  };

  // Network drives
  for (const dir of targets.network_drives) {
    if (!dir) continue;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      syncStatus.network_drives[dir] = {
        success: true,
        message: 'Directory ready',
        full_path: path.join(dir, filename)
      };
    } catch (e) {
      syncStatus.network_drives[dir] = {
        success: false,
        message: `Error: ${e.message}`
      };
    }
  }

  // OneDrive
  for (const dir of targets.onedrive) {
    if (!dir) continue;
    try {
      const targetDir = path.join(dir, 'WECRYP', 'settlement-logs');
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      syncStatus.onedrive[dir] = {
        success: true,
        message: 'OneDrive directory ready',
        full_path: path.join(targetDir, filename)
      };
    } catch (e) {
      syncStatus.onedrive[dir] = {
        success: false,
        message: `Error: ${e.message}`
      };
    }
  }

  // Google Drive
  for (const dir of targets.google_drive) {
    if (!dir) continue;
    try {
      const targetDir = path.join(dir, 'WECRYP', 'settlement-logs');
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      syncStatus.google_drive[dir] = {
        success: true,
        message: 'Google Drive directory ready',
        full_path: path.join(targetDir, filename)
      };
    } catch (e) {
      syncStatus.google_drive[dir] = {
        success: false,
        message: `Error: ${e.message}`
      };
    }
  }

  event.reply('multi-drive:init-complete', syncStatus);
});

/**
 * Write settlement logs to all targets
 */
ipcMain.on('multi-drive:write-settlement-log', (event, { filename, content, isNewFile, targets, recordCount }) => {
  const syncStatus = {
    network_drives: {},
    onedrive: {},
    google_drive: {},
    summary: { total: 0, success: 0, failed: 0 }
  };

  const writeToTarget = (targetList, category) => {
    for (const baseDir of targetList) {
      if (!baseDir) continue;

      let targetPath = baseDir;

      // Construct full target path
      if (category === 'onedrive' || category === 'google_drive') {
        targetPath = path.join(baseDir, 'WECRYP', 'settlement-logs', filename);
      } else {
        targetPath = path.join(baseDir, filename);
      }

      try {
        // Ensure directory exists
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Write or append
        if (isNewFile) {
          fs.writeFileSync(targetPath, content, 'utf8');
        } else {
          fs.appendFileSync(targetPath, content, 'utf8');
        }

        syncStatus[category][baseDir] = {
          success: true,
          message: `Wrote ${recordCount} records`,
          path: targetPath,
          timestamp: new Date().toISOString()
        };
        syncStatus.summary.success++;
      } catch (e) {
        syncStatus[category][baseDir] = {
          success: false,
          message: `Write failed: ${e.message}`,
          path: targetPath
        };
        syncStatus.summary.failed++;
      }
      syncStatus.summary.total++;
    }
  };

  // Write to all targets
  writeToTarget(targets.network_drives, 'network_drives');
  writeToTarget(targets.onedrive, 'onedrive');
  writeToTarget(targets.google_drive, 'google_drive');

  // Log summary
  console.log(`[Multi-Drive] Write complete: ${syncStatus.summary.success}/${syncStatus.summary.total} targets successful`);

  event.reply('multi-drive:write-complete', { syncStatus });
});

/**
 * Get all settlement log files across all targets
 */
ipcMain.handle('multi-drive:get-all-logs', async (event, { targets }) => {
  const logs = {
    network_drives: [],
    onedrive: [],
    google_drive: []
  };

  const scanDirectory = (baseDir, category) => {
    try {
      let scanPath = baseDir;
      if (category === 'onedrive' || category === 'google_drive') {
        scanPath = path.join(baseDir, 'WECRYP', 'settlement-logs');
      }

      if (!fs.existsSync(scanPath)) return;

      const files = fs.readdirSync(scanPath)
        .filter(f => f.startsWith('kalshi-settlements-') && f.endsWith('.log'))
        .map(f => ({
          filename: f,
          path: path.join(scanPath, f),
          size: fs.statSync(path.join(scanPath, f)).size,
          modified: fs.statSync(path.join(scanPath, f)).mtime
        }))
        .sort((a, b) => b.modified - a.modified);

      return files;
    } catch (e) {
      console.error(`[Multi-Drive] Error scanning ${baseDir}:`, e.message);
      return [];
    }
  };

  // Scan all targets
  for (const dir of targets.network_drives) {
    if (dir) logs.network_drives.push(...scanDirectory(dir, 'network_drives'));
  }
  for (const dir of targets.onedrive) {
    if (dir) logs.onedrive.push(...scanDirectory(dir, 'onedrive'));
  }
  for (const dir of targets.google_drive) {
    if (dir) logs.google_drive.push(...scanDirectory(dir, 'google_drive'));
  }

  return logs;
});

/**
 * Read settlement log file
 */
ipcMain.handle('multi-drive:read-log', async (event, { filepath }) => {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    // Parse CSV
    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 7) {
        records.push({
          timestamp: parts[0],
          coin: parts[1],
          model_direction: parts[2],
          kalshi_outcome: parts[3],
          result: parts[4],
          confidence: parseFloat(parts[5]),
          kalshi_probability: parseFloat(parts[6])
        });
      }
    }

    return {
      success: true,
      filepath,
      record_count: records.length,
      records: records
    };
  } catch (e) {
    return {
      success: false,
      error: e.message
    };
  }
});

/**
 * Sync/merge logs across all targets (deduplication)
 */
ipcMain.handle('multi-drive:sync-all-logs', async (event, { targets }) => {
  const allLogs = await ipcMain._invokeHandler('multi-drive:get-all-logs', event, { targets });
  const mergedRecords = new Map(); // Use timestamp+coin as key

  // Read all files and merge
  for (const category of ['network_drives', 'onedrive', 'google_drive']) {
    for (const logFile of allLogs[category]) {
      try {
        const content = fs.readFileSync(logFile.path, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',');
          if (parts.length >= 7) {
            const key = `${parts[0]}-${parts[1]}`;
            if (!mergedRecords.has(key)) {
              mergedRecords.set(key, {
                timestamp: parts[0],
                coin: parts[1],
                model_direction: parts[2],
                kalshi_outcome: parts[3],
                result: parts[4],
                confidence: parseFloat(parts[5]),
                kalshi_probability: parseFloat(parts[6]),
                source: logFile.path
              });
            }
          }
        }
      } catch (e) {
        console.error(`[Multi-Drive] Error reading ${logFile.path}:`, e.message);
      }
    }
  }

  const mergedArray = Array.from(mergedRecords.values());

  // Write merged log back to all targets
  const mergedContent = 'timestamp,coin,model_direction,kalshi_outcome,result,confidence,kalshi_probability\n' +
    mergedArray.map(r => `${r.timestamp},${r.coin},${r.model_direction},${r.kalshi_outcome},${r.result},${r.confidence},${r.kalshi_probability}`).join('\n') +
    '\n';

  const syncResults = {
    merged_record_count: mergedArray.length,
    written_to: {}
  };

  // Write merged log to all targets
  const writeToAll = (targetList, category) => {
    for (const baseDir of targetList) {
      if (!baseDir) continue;

      let targetPath = baseDir;
      if (category === 'onedrive' || category === 'google_drive') {
        targetPath = path.join(baseDir, 'WECRYP', 'settlement-logs', 'kalshi-settlements-MERGED.log');
      } else {
        targetPath = path.join(baseDir, 'kalshi-settlements-MERGED.log');
      }

      try {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetPath, mergedContent, 'utf8');
        syncResults.written_to[targetPath] = { success: true };
      } catch (e) {
        syncResults.written_to[targetPath] = { success: false, error: e.message };
      }
    }
  };

  writeToAll(targets.network_drives, 'network_drives');
  writeToAll(targets.onedrive, 'onedrive');
  writeToAll(targets.google_drive, 'google_drive');

  return syncResults;
});

console.log('[Main] Multi-Drive Settlement Logger IPC handlers registered');
