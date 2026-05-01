/**
 * ================================================================
 * WECRYPTO Startup Loader
 * 
 * Fast app initialization sequence
 * Restores cached calibration in <100ms, app is immediately functional
 * Background refresh happens in parallel
 * ================================================================
 */

(function() {
  'use strict';

  const STARTUP_LOG = [];
  function log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    STARTUP_LOG.push(`[${ts}] ${msg}`);
    console.log(`[STARTUP] ${msg}`);
  }

  // ── Phase 1: Fast Restore (synchronous, <50ms) ──────────────────
  async function phaseRestoreCalibration() {
    log('Phase 1: Restoring calibration from cache...');
    
    if (typeof window === 'undefined' || !window.AdaptiveWeightRestorer) {
      log('⚠ AdaptiveWeightRestorer not loaded');
      return false;
    }

    const restorer = window.__AdaptiveWeightRestorer || new window.AdaptiveWeightRestorer();
    const result = await restorer.initialize();
    
    if (result.success) {
      log(`✓ Calibration restored (source: ${result.source})`);
      return true;
    } else {
      log('⚠ No calibration to restore (first run?)');
      return false;
    }
  }

  // ── Phase 2: Load Cached Historical Data (fast, <100ms) ─────────
  async function phaseLoadHistoricalCache() {
    log('Phase 2: Loading historical contract cache...');
    
    try {
      if (typeof window === 'undefined' || !window.electron) {
        log('ℹ Not in Electron, skipping cache load');
        return false;
      }

      const result = await window.electron.invoke('storage:readContractCache');
      if (result.success) {
        log(`✓ Loaded ${result.count} contracts from cache (${result.source})`);
        
        // Store in window for accuracy-debug.js
        window._contractCache = result.data;
        return true;
      }
    } catch (err) {
      log(`⚠ Cache load failed: ${err.message}`);
    }
    
    return false;
  }

  // ── Phase 3: Load CSV Historical Data ─────────────────────────────
  async function phaseDisplayDebugPanel() {
    log('Phase 3: Loading CSV historical contracts with resolution data...');
    
    if (typeof window === 'undefined') {
      log('ℹ Not in browser - skipping debug panel');
      return false;
    }

    if (!window.__WinRateCalculatorInstance) {
      log('⚠ Calculator instance not ready - creating new instance...');
      if (!window.ContractWinRateCalculator) {
        log('⚠ ContractWinRateCalculator class not loaded');
        return false;
      }
      // Create instance if it doesn't exist
      window.__WinRateCalculatorInstance = new window.ContractWinRateCalculator();
      log('✓ Created new calculator instance');
    }

    try {
      // CRITICAL: Ensure resolution log is loaded from localStorage
      // market-resolver.js loads with defer, so manually restore if needed
      if (!window._15mResolutionLog || window._15mResolutionLog.length === 0) {
        log('  → Restoring resolution log from localStorage...');
        try {
          const stored = localStorage.getItem('beta1_15m_resolution_log');
          if (stored) {
            window._15mResolutionLog = JSON.parse(stored);
            log(`  ✓ Restored ${window._15mResolutionLog.length} resolution records`);
          } else {
            log('  ℹ No persisted resolution log found (first run or no settlements yet)');
          }
        } catch (e) {
          log(`  ⚠ Could not restore resolution log: ${e.message}`);
        }
      } else {
        log(`  ✓ Resolution log already in memory (${window._15mResolutionLog.length} records)`);
      }
      
      const calc = window.__WinRateCalculatorInstance;
      
      // Load CSV trades, passing resolution log for merge
      log('  → Loading CSV trades with settlement outcomes...');
      const csvTrades = await calc.loadFromKalshiCSV(window._15mResolutionLog || []);
      
      if (csvTrades.length === 0) {
        log('  ℹ No CSV trades loaded (file may not exist yet - first run?)');
        // Still mark success as this is not a fatal error
        log('✓ Phase 3 complete (no historical data available yet)');
        return true;
      }
      
      log(`  ✓ Loaded ${csvTrades.length} CSV trades`);
      
      // Count trades with actual outcomes
      const withOutcome = csvTrades.filter(t => t.outcome || t.modelCorrect !== null).length;
      log(`  ✓ ${withOutcome}/${csvTrades.length} trades have settlement outcomes`);
      
      // Set contracts directly
      calc.contracts = csvTrades;
      
      // Calculate accuracy from CSV data
      log('  → Calculating accuracy from merged data...');
      calc.calculateAccuracy();
      log(`  ✓ Overall: ${calc.stats.overall.wins}W/${calc.stats.overall.losses}L (${Math.round(calc.stats.overall.winRate)}%)`);
      
      // Log per-symbol stats
      const symbolsWithData = Object.entries(calc.stats.bySymbol || {})
        .filter(([sym, stats]) => stats.total > 0)
        .map(([sym, stats]) => `${sym}:${stats.correct}/${stats.total}`);
      if (symbolsWithData.length > 0) {
        log(`  ✓ By symbol: ${symbolsWithData.join(' | ')}`);
      }
      
      // CRITICAL: Ensure getHistoricalContracts() getter is exposed
      if (!window.getHistoricalContracts) {
        window.getHistoricalContracts = () => window.__WinRateCalculatorInstance?.contracts || [];
        log('  ✓ Exposed window.getHistoricalContracts()');
      }
      
      // Broadcast for UI update
      calc.broadcastStats();
      
      // Cache for next session
      calc.persistToStorage();
      
      log('✓ CSV data loaded - scorecard ready for rendering');
      return true;
    } catch (err) {
      log(`⚠ Failed to load CSV data: ${err.message}`);
      console.error('[Phase 3]', err);
      // Don't fail completely - app can still run with cached data
      return false;
    }
  }

  // ── Phase 4: Background Persistence (async, non-blocking) ────────
  async function phaseBackgroundPersistence() {
    log('Phase 4: Caching weights for next startup...');
    
    if (typeof window === 'undefined' || !window.__AdaptiveWeightRestorer) {
      return;
    }

    try {
      window.__AdaptiveWeightRestorer.cacheCurrentWeights();
      log('✓ Weights cached');
    } catch (err) {
      log(`⚠ Weight caching failed: ${err.message}`);
    }

  // ── Main Startup Sequence ───────────────────────────────────────
  async function startup() {
    const startTime = Date.now();
    log('═══════════════════════════════════════════════════════════');
    log('WECRYPTO Startup Sequence');
    log('═══════════════════════════════════════════════════════════');

    try {
      // Phase 1: Restore weights (must complete)
      await phaseRestoreCalibration();
      
      // Phase 2: Load cached data (must complete)
      await phaseLoadHistoricalCache();
      
      // Phase 3: Load historical data for accuracy (BLOCKING - must complete)
      await phaseDisplayDebugPanel();
      
      const elapsedMs = Date.now() - startTime;
      log(`✅ STARTUP COMPLETE in ${elapsedMs}ms`);
      log('═══════════════════════════════════════════════════════════');
      
      // Phase 4: Background persistence (doesn't block)
      phaseBackgroundPersistence();
      
      // Expose logs for debugging
      window.__STARTUP_LOG = STARTUP_LOG;
      
      // Dispatch event so other modules know startup is done
      window.dispatchEvent(new CustomEvent('wecrypto:startupComplete', {
        detail: { elapsedMs, log: STARTUP_LOG }
      }));
      
    } catch (err) {
      log(`❌ STARTUP FAILED: ${err.message}`);
      console.error('[STARTUP]', err);
      
      window.dispatchEvent(new CustomEvent('wecrypto:startupFailed', {
        detail: { error: err.message, log: STARTUP_LOG }
      }));
    }
  }

  // ── Auto-start on DOM ready ──────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startup);
  } else {
    setTimeout(startup, 100);
  }

  // Expose for manual trigger if needed
  window.__WECRYPTO_STARTUP = { startup, getLog: () => STARTUP_LOG };
})();
