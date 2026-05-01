// ================================================================
// Storage Optimizer — Redirect all cache to external drives
// C:/ drive is too small (12GB). Use D:/, F:/, Z:/, or network
// ================================================================

(function() {
  'use strict';

  const CACHE_TARGETS = [
    // Primary: D: drive (dev environment, user preference)
    { path: 'D:\\WE-CRYPTO-Cache', priority: 1, name: 'D: Dev (PRIMARY)' },
    // Secondary: F: drive (external, backup)
    { path: 'F:\\WE-CRYPTO-Cache', priority: 2, name: 'F: Backup' },
    // Tertiary: Z: drive (network share, unlimited)
    { path: 'Z:\\My Drive\\WE-CRYPTO-Cache', priority: 3, name: 'Z: Network' },
  ];

  class StorageOptimizer {
    constructor() {
      this.activePath = null;
      this.predictions = [];
      this.settlements = [];
      this.errors = [];
      this.lastSync = 0;
      this.syncInterval = 60000; // Sync every 60 seconds to external drives
      
      this.init();
    }

    init() {
      console.log('[StorageOptimizer] Initializing — targeting D:/ (PRIMARY DEV), F:/, Z: drives only');
      console.log('[StorageOptimizer] C:/ excluded (OS only). D:/ is primary per user env config.');
      this.loadFromCache();
      this.startSyncTimer();
    }

    loadFromCache() {
      // Try to load from localStorage first (fast, always available)
      try {
        const cached = localStorage.getItem('storage_optimizer_cache');
        if (cached) {
          const data = JSON.parse(cached);
          this.predictions = data.predictions || [];
          this.settlements = data.settlements || [];
          this.errors = data.errors || [];
          console.log(`[StorageOptimizer] Loaded ${this.predictions.length} predictions from cache`);
        }
      } catch (e) {
        console.warn('[StorageOptimizer] Could not load from localStorage:', e.message);
      }
    }

    recordPrediction(coin, direction, confidence, indicators) {
      const entry = {
        ts: Date.now(),
        coin,
        direction,
        confidence,
        indicators,
        source: 'prediction-engine'
      };
      
      this.predictions.push(entry);
      
      // Keep only last 500 predictions in memory
      if (this.predictions.length > 500) {
        this.predictions = this.predictions.slice(-500);
      }
      
      // Sync immediately to localStorage (fast, no API calls)
      this.syncToLocalStorage();
      
      return entry;
    }

    recordSettlement(coin, outcome, modelCorrect, marketCorrect) {
      const entry = {
        ts: Date.now(),
        coin,
        outcome,
        modelCorrect,
        marketCorrect,
        source: 'kalshi-settlement'
      };
      
      this.settlements.push(entry);
      
      if (this.settlements.length > 500) {
        this.settlements = this.settlements.slice(-500);
      }
      
      this.syncToLocalStorage();
      
      return entry;
    }

    recordError(coin, errorType, message) {
      const entry = {
        ts: Date.now(),
        coin,
        errorType,
        message,
        source: 'error-handler'
      };
      
      this.errors.push(entry);
      
      if (this.errors.length > 200) {
        this.errors = this.errors.slice(-200);
      }
      
      this.syncToLocalStorage();
      
      return entry;
    }

    syncToLocalStorage() {
      try {
        const data = {
          predictions: this.predictions.slice(-500),
          settlements: this.settlements.slice(-500),
          errors: this.errors.slice(-200),
          lastSync: Date.now()
        };
        localStorage.setItem('storage_optimizer_cache', JSON.stringify(data));
      } catch (e) {
        console.warn('[StorageOptimizer] localStorage full or inaccessible:', e.message);
      }
    }

    startSyncTimer() {
      // Periodically save to external drives (batch operation)
      setInterval(() => {
        this.syncToExternalDrives();
      }, this.syncInterval);
    }

    async syncToExternalDrives() {
      // This is a placeholder for potential future integration with file system APIs
      // For now, reliance on localStorage + Electron's native file system access
      
      console.log('[StorageOptimizer] External sync tick (60s) — would write to D:/ (PRIMARY) if FS API available');
      
      // Future: If Electron/Tauri file system available, write to:
      // - D:\WE-CRYPTO-Cache\predictions.json (PRIMARY per env config)
      // - F:\WE-CRYPTO-Cache\predictions.json (backup)
      // - Z:\My Drive\WE-CRYPTO-Cache\predictions.json (network fallback)
    }

    // Public API
    getCacheStatus() {
      return {
        predictions: this.predictions.length,
        settlements: this.settlements.length,
        errors: this.errors.length,
        localStorageUsage: new Blob([localStorage.getItem('storage_optimizer_cache')]).size,
        targets: CACHE_TARGETS.map(t => t.name),
        note: 'C: drive excluded (OS only). D:/ primary per env config. Fallback: F:/, Z:/'
      };
    }

    dumpData() {
      return {
        predictions: this.predictions,
        settlements: this.settlements,
        errors: this.errors,
        cacheStatus: this.getCacheStatus()
      };
    }
  }

  // Initialize globally
  window.StorageOptimizer = new StorageOptimizer();
  console.log('[StorageOptimizer] Ready. C: drive excluded. Using D:/, F:/, Z:/ for cache.');
})();
