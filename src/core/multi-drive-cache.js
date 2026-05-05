/**
 * ════════════════════════════════════════════════════════════════════════════
 * MULTI-DRIVE INSTANT CACHE SYSTEM
 * 
 * Writes predictions/settlements/errors INSTANTLY to:
 *   1. Z:\ (network primary)
 *   2. D:\ (local backup)
 *   3. F:\ (secondary backup)
 *   4. D:\Users\admin (secondary network)
 *   5. C:\Users\user (local cache)
 *   6. localStorage (browser persistence)
 *   7. OneDrive (cloud)
 *   8. Google Drive (cloud)
 * 
 * No async delays — synchronous to each drive before returning
 * ════════════════════════════════════════════════════════════════════════════
 */

(function() {
  'use strict';

  class MultiDriveCache {
    constructor() {
      this.cacheFile = 'contract-cache-2h.json';
      this.isElectron = typeof window !== 'undefined' && window.require;
      this.fs = this.isElectron ? window.require('fs') : null;
      this.path = this.isElectron ? window.require('path') : null;

      // Drive paths (Windows)
      this.drivePaths = [
        'Z:\\WE-CRYPTO-CACHE',           // Network primary
        'D:\\WE-CRYPTO-CACHE',           // Local backup
        'F:\\WE-CRYPTO-CACHE',           // Secondary backup
        'D:\\Users\\admin\\WE-CRYPTO-CACHE',  // Secondary network
        'C:\\Users\\user\\AppData\\Local\\WE-CRYPTO-CACHE',  // Local cache
      ];

      // OneDrive paths (personal + org profiles)
      this.onedriveFolders = this._getOnedriveFolders();
      this.onedriveFolder = this.onedriveFolders[0] || null; // backward-compatible alias
      this.googleDriveFolder = this._getGoogleDriveFolder();

      // In-memory cache (same structure as ContractCacheManager)
      this.data = {
        predictions: [],
        settlements: [],
        candles: [],
        orders: [],
        errors: [],
        correlations: [],
        marketContexts: [],
        inferences: [],
        lastSyncTime: Date.now(),
      };

      this._ensureDirectories();
      this._loadFromDrives();

      console.log('[MultiDriveCache] Initialized with', this.drivePaths.length, 'base drive targets');
    }

    /**
     * Get OneDrive folder paths (Windows 10/11)
     */
    _getOnedriveFolders() {
      if (!this.isElectron || !this.path || !this.fs) return [];

      const username = process.env.USERNAME || 'user';
      const home = process.env.USERPROFILE || `C:\\Users\\${username}`;
      const candidates = [
        process.env.OneDriveConsumer || '',
        process.env.OneDriveCommercial || '',
        process.env.ONEDRIVE || '',
        process.env.ONEDRIVE_BUSINESS || '',
        this.path.join(home, 'OneDrive'),
        this.path.join(home, 'OneDrive - Personal'),
        this.path.join(home, 'OneDrive - ctstate.edu'),
        this.path.join(home, 'OneDrive - Azure ctstate.edu'),
      ].filter(Boolean);

      // Capture any additional OneDrive profile folder under C:\Users\user\
      try {
        if (home && this.fs.existsSync(home)) {
          for (const name of this.fs.readdirSync(home)) {
            if (name.startsWith('OneDrive')) {
              candidates.push(this.path.join(home, name));
            }
          }
        }
      } catch (_) {}

      const unique = Array.from(new Set(candidates));
      return unique
        .filter(folder => {
          try { return this.fs.existsSync(folder); } catch (_) { return false; }
        })
        .map(folder => this.path.join(folder, 'WE-CRYPTO-CACHE'));
    }

    /**
     * Get Google Drive folder path (Windows)
     */
    _getGoogleDriveFolder() {
      if (!this.isElectron || !this.path || !this.fs) return null;

      const username = process.env.USERNAME || 'user';
      const home = process.env.USERPROFILE || `C:\\Users\\${username}`;
      const candidates = [
        `Z:\\`,
        `Z:\\My Drive`,
        process.env.GOOGLE_DRIVE_PATH || '',
        process.env.GOOGLEDRIVEPATH || '',
        `G:\\My Drive`,
        this.path.join(home, 'Google Drive'),
        this.path.join(home, 'My Drive'),
      ].filter(Boolean);

      for (const candidate of candidates) {
        try {
          if (this.fs.existsSync(candidate)) {
            return this.path.join(candidate, 'WE-CRYPTO-CACHE');
          }
        } catch (_) {}
      }

      return null;
    }

    /**
     * Ensure all target directories exist
     */
    _ensureDirectories() {
      if (!this.isElectron || !this.fs) return;

      const allPaths = [...this.drivePaths];
      if (this.onedriveFolders.length) allPaths.push(...this.onedriveFolders);
      if (this.googleDriveFolder) allPaths.push(this.googleDriveFolder);

      allPaths.forEach(dirPath => {
        try {
          if (!this.fs.existsSync(dirPath)) {
            this.fs.mkdirSync(dirPath, { recursive: true });
            console.log(`[MultiDriveCache] Created directory: ${dirPath}`);
          }
        } catch (e) {
          console.warn(`[MultiDriveCache] Could not create directory ${dirPath}:`, e.message);
        }
      });
    }

    /**
     * Record prediction and write INSTANTLY to all drives
     */
    recordPrediction(coin, direction, confidence, signals = {}) {
      const now = Date.now();
      const record = {
        coin,
        direction,
        confidence,
        signals,
        timestamp: now,
        id: `pred-${coin}-${now}`,
      };

      this.data.predictions.push(record);
      this._trim('predictions');

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage (browser)
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-predictions-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record compact market context for inference/recall
     */
    recordMarketContext(coin, context = {}, options = {}) {
      const now = Date.now();
      const record = {
        coin,
        ...context,
        timestamp: now,
        id: `ctx-${coin}-${now}`,
      };

      this.data.marketContexts.push(record);
      this._trim('marketContexts', 3000);

      if (options.sync !== false) {
        this._syncAllDrives();
      }

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-market-context-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record inference output + optional input snapshot
     */
    recordInference(coin, inference = {}, snapshot = null, options = {}) {
      const now = Date.now();
      const record = {
        coin,
        inference,
        snapshot,
        timestamp: now,
        id: `inf-${coin}-${now}`,
      };

      this.data.inferences.push(record);
      this._trim('inferences', 1500);

      if (options.sync !== false) {
        this._syncAllDrives();
      }

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-inference-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record settlement and write INSTANTLY to all drives
     */
    recordSettlement(coin, outcome, modelCorrect, marketCorrect) {
      const now = Date.now();
      const record = {
        coin,
        outcome,
        modelCorrect,
        marketCorrect,
        timestamp: now,
        id: `settle-${coin}-${now}`,
      };

      this.data.settlements.push(record);
      this._trim('settlements');

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-settlements-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record error and write INSTANTLY to all drives
     */
    recordError(type, message, context = {}) {
      const now = Date.now();
      const record = {
        type,
        message,
        context,
        timestamp: now,
        id: `error-${type}-${now}`,
      };

      this.data.errors.push(record);
      this._trim('errors', 500);  // Keep last 500 errors

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-errors-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * SYNC ALL DRIVES - SYNCHRONOUS, NO ASYNC
     * Writes current cache to all target drives
     */
    _syncAllDrives() {
      if (!this.isElectron || !this.fs) {
        console.warn('[MultiDriveCache] Electron/fs not available, skipping drive sync');
        return;
      }

      const cacheJson = JSON.stringify(this.data, null, 2);
      let successCount = 0;

      this.drivePaths.forEach(dirPath => {
        try {
          const filePath = this.path.join(dirPath, this.cacheFile);

          // Synchronous write — BLOCKS until complete
          this.fs.writeFileSync(filePath, cacheJson, 'utf8');
          successCount++;
        } catch (e) {
          console.warn(`[MultiDriveCache] Write to ${dirPath} failed:`, e.message);
        }
      });

      // OneDrive (all discovered profiles)
      this.onedriveFolders.forEach(onedriveFolder => {
        try {
          const filePath = this.path.join(onedriveFolder, this.cacheFile);
          this.fs.writeFileSync(filePath, cacheJson, 'utf8');
          successCount++;
        } catch (e) {
          console.warn(`[MultiDriveCache] Write to OneDrive failed (${onedriveFolder}):`, e.message);
        }
      });

      // Google Drive
      if (this.googleDriveFolder) {
        try {
          const filePath = this.path.join(this.googleDriveFolder, this.cacheFile);
          this.fs.writeFileSync(filePath, cacheJson, 'utf8');
          successCount++;
        } catch (e) {
          console.warn(`[MultiDriveCache] Write to Google Drive failed:`, e.message);
        }
      }

      this.data.lastSyncTime = Date.now();
      const targetCount = this.drivePaths.length
        + this.onedriveFolders.length
        + (this.googleDriveFolder ? 1 : 0);

      if (successCount === 0) {
        console.error('[MultiDriveCache] Failed to write to all drives!');
      } else if (successCount < targetCount) {
        console.warn(`[MultiDriveCache] Partial write: ${successCount}/${targetCount} targets`);
      }
    }

    /**
     * Public sync trigger for batched writes
     */
    flushSync() {
      this._syncAllDrives();
    }

    /**
     * Load cache from drives (priority order)
     */
    _loadFromDrives() {
      if (!this.isElectron || !this.fs) return;

      const allPaths = [...this.drivePaths];
      if (this.onedriveFolders.length) allPaths.push(...this.onedriveFolders);
      if (this.googleDriveFolder) allPaths.push(this.googleDriveFolder);

      for (const dirPath of allPaths) {
        try {
          const filePath = this.path.join(dirPath, this.cacheFile);

          if (this.fs.existsSync(filePath)) {
            const content = this.fs.readFileSync(filePath, 'utf8');
            const loaded = JSON.parse(content);

            // Restore and filter old data
            const now = Date.now();
            const maxAge = 2 * 60 * 60 * 1000;  // 2 hours

            this.data.predictions = (loaded.predictions || [])
              .filter(p => now - p.timestamp < maxAge);
            this.data.settlements = (loaded.settlements || [])
              .filter(s => now - s.timestamp < maxAge);
            this.data.candles = (loaded.candles || [])
              .filter(c => now - c.timestamp < maxAge);
            this.data.orders = (loaded.orders || [])
              .filter(o => now - o.timestamp < maxAge);
            this.data.errors = (loaded.errors || []).slice(-500);
            this.data.correlations = (loaded.correlations || [])
              .filter(c => now - c.timestamp < maxAge);
            this.data.marketContexts = (loaded.marketContexts || loaded.contexts || [])
              .filter(c => now - c.timestamp < maxAge);
            this.data.inferences = (loaded.inferences || loaded.inference || [])
              .filter(i => now - i.timestamp < maxAge);

            console.log(`[MultiDriveCache] Loaded from ${dirPath}: ${this.data.predictions.length} predictions, ${this.data.settlements.length} settlements`);
            return;  // Loaded successfully, stop looking
          }
        } catch (e) {
          console.warn(`[MultiDriveCache] Load from ${dirPath} failed:`, e.message);
        }
      }

      console.log('[MultiDriveCache] No cache found on any drive, starting fresh');
    }

    /**
     * Trim old data from arrays
     */
    _trim(key, maxCount = null) {
      const now = Date.now();
      const maxAge = 2 * 60 * 60 * 1000;  // 2 hours

      if (key === 'errors') {
        this.data.errors = this.data.errors.filter(e => now - e.timestamp < maxAge).slice(-500);
      } else if (key === 'predictions') {
        this.data.predictions = this.data.predictions.filter(p => now - p.timestamp < maxAge);
      } else if (key === 'settlements') {
        this.data.settlements = this.data.settlements.filter(s => now - s.timestamp < maxAge);
      } else if (key === 'candles') {
        this.data.candles = this.data.candles.filter(c => now - c.timestamp < maxAge);
      } else if (key === 'orders') {
        this.data.orders = this.data.orders.filter(o => now - o.timestamp < maxAge);
      } else if (key === 'correlations') {
        this.data.correlations = this.data.correlations.filter(c => now - c.timestamp < maxAge);
      } else if (key === 'marketContexts') {
        this.data.marketContexts = this.data.marketContexts.filter(c => now - c.timestamp < maxAge);
      } else if (key === 'inferences') {
        this.data.inferences = this.data.inferences.filter(i => now - i.timestamp < maxAge);
      }

      if (maxCount) {
        this.data[key] = this.data[key].slice(-maxCount);
      }
    }

    /**
     * Get cache status
     */
    getStatus() {
      return {
        predictions: this.data.predictions.length,
        settlements: this.data.settlements.length,
        candles: this.data.candles.length,
        orders: this.data.orders.length,
        errors: this.data.errors.length,
        correlations: this.data.correlations.length,
        marketContexts: this.data.marketContexts.length,
        inferences: this.data.inferences.length,
        lastSyncTime: new Date(this.data.lastSyncTime).toISOString(),
        drivesConfigured: this.drivePaths.length,
        onedriveConfigured: this.onedriveFolders.length > 0,
        onedriveTargets: this.onedriveFolders.length,
        googleDriveConfigured: this.googleDriveFolder ? true : false,
        totalTargets: this.drivePaths.length + this.onedriveFolders.length + (this.googleDriveFolder ? 1 : 0),
      };
    }

    /**
     * Get accuracy by coin
     */
    getAccuracyByCoins() {
      const byCoins = {};

      this.data.settlements.forEach(s => {
        if (!byCoins[s.coin]) {
          byCoins[s.coin] = { correct: 0, total: 0 };
        }
        byCoins[s.coin].total++;
        if (s.modelCorrect === true) byCoins[s.coin].correct++;
      });

      return Object.entries(byCoins).reduce((acc, [coin, data]) => {
        acc[coin] = {
          accuracy: Math.round((data.correct / data.total) * 100),
          correct: data.correct,
          total: data.total,
        };
        return acc;
      }, {});
    }

    /**
     * Export recent data
     */
    exportRecent(minutes = 60) {
      const cutoff = Date.now() - (minutes * 60 * 1000);

      return {
        predictions: this.data.predictions.filter(p => p.timestamp > cutoff),
        settlements: this.data.settlements.filter(s => s.timestamp > cutoff),
        errors: this.data.errors.filter(e => e.timestamp > cutoff),
        marketContexts: this.data.marketContexts.filter(c => c.timestamp > cutoff),
        inferences: this.data.inferences.filter(i => i.timestamp > cutoff),
      };
    }
  }

  // Global instance
  const multiDriveCache = new MultiDriveCache();

  // Expose to window
  if (typeof window !== 'undefined') {
    window.MultiDriveCache = multiDriveCache;
    window.MultiDriveCacheDebug = {
      status: () => {
        console.table(multiDriveCache.getStatus());
        return multiDriveCache.getStatus();
      },
      accuracy: () => {
        console.table(multiDriveCache.getAccuracyByCoins());
        return multiDriveCache.getAccuracyByCoins();
      },
      recent: (minutes = 60) => {
        const data = multiDriveCache.exportRecent(minutes);
        console.log(`Exported last ${minutes}m:`, data);
        return data;
      },
      syncNow: () => {
        multiDriveCache._syncAllDrives();
        console.log('✓ Manual sync complete');
      },
    };
  }

  // Expose to Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = multiDriveCache;
  }
})();
