/**
 * Pyth Lazer 1000ms Timeout & Fallback Monitor
 * Tracks strict 1000ms timeout behavior and fallback chain execution
 * 
 * Usage in DevTools:
 *   window.PythTimeoutMonitor.start()
 *   window.PythTimeoutMonitor.getReport()
 *   window.PythTimeoutMonitor.exportCSV()
 */

(function () {
  'use strict';

  const monitor = {
    // ── State ────────────────────────────────────────────────────────
    enabled: false,
    events: [],
    stats: {
      pythUpdates: 0,
      pythTimeouts: 0,
      fallbackChainCompletes: 0,
      fallbackChainFailures: 0,
      totalTimeoutDuration: 0,
      avgTimeoutMs: 0,
    },
    startTime: 0,
    lastPythUpdate: 0,
    lastTimeout: 0,
    fallbackInProgress: false,
    fallbackSources: [],

    // ── Initialize ────────────────────────────────────────────────────
    start() {
      if (this.enabled) {
        console.warn('[PythMonitor] Already enabled');
        return;
      }
      this.enabled = true;
      this.startTime = Date.now();
      this.events = [];
      this.stats = {
        pythUpdates: 0,
        pythTimeouts: 0,
        fallbackChainCompletes: 0,
        fallbackChainFailures: 0,
        totalTimeoutDuration: 0,
        avgTimeoutMs: 0,
      };
      this.fallbackSources = [];

      // ★ Listen for Pyth Lazer ticker updates (success)
      window.pythLazer?.onTickers?.((prices) => {
        this.lastPythUpdate = Date.now();
        this.stats.pythUpdates++;
        this.events.push({
          ts: this.lastPythUpdate,
          type: 'pyth:update',
          coins: Object.keys(prices).length,
          sources: Object.keys(prices).map(k => prices[k].source).filter(Boolean),
        });
        console.log(
          `[PythMonitor] ✓ Pyth update #${this.stats.pythUpdates} (${Object.keys(prices).length} coins)`
        );
      });

      // ★ Listen for Pyth timeout & fallback triggers
      window.pythLazer?.onTimeout?.((data) => {
        this.lastTimeout = Date.now();
        this.stats.pythTimeouts++;
        this.fallbackInProgress = true;
        this.fallbackSources = [];
        this.events.push({
          ts: this.lastTimeout,
          type: 'pyth:timeout',
          reason: data.reason,
          timeoutCount: data.timeoutCount,
          fallbackTo: (data.fallbackTo || '').split(',').map(s => s.trim()),
        });
        console.warn(
          `[PythMonitor] ⚠️ Pyth timeout #${this.stats.pythTimeouts} — fallback: ${data.fallbackTo}`
        );
      });

      // ★ Monitor when Pyth loses all connections
      window.pythLazer?.onConnectionLost?.((data) => {
        this.stats.pythTimeouts++;
        this.events.push({
          ts: Date.now(),
          type: 'pyth:connection-lost',
          reason: data.reason,
          fallbackTo: (data.fallbackTo || '').split(',').map(s => s.trim()),
        });
        console.error(`[PythMonitor] ✗ Pyth connection lost: ${data.reason}`);
      });

      // ★ Monitor hard startup/connect failures (missing token, max retries reached)
      window.pythLazer?.onConnectionFailed?.((data) => {
        this.stats.pythTimeouts++;
        this.events.push({
          ts: Date.now(),
          type: 'pyth:connection-failed',
          retries: data?.retries ?? 0,
          error: data?.error || 'unknown',
        });
        console.error(`[PythMonitor] ✗ Pyth connection failed: ${data?.error || 'unknown'}`);
      });

      // ★ Monitor feed status updates
      window.pythLazer?.onStatus?.((status) => {
        this.events.push({
          ts: Date.now(),
          type: 'pyth:status',
          connected: status.connected,
          dataCount: status.dataCount,
          timeoutCount: status.timeoutCount,
          lastDataAgeSecs: (Date.now() - status.lastDataTs) / 1000,
        });
      });

      console.log('[PythMonitor] ✓ Started monitoring (1000ms timeout)');
      return this;
    },

    stop() {
      this.enabled = false;
      window.pythLazer?.offTickers?.();
      console.log('[PythMonitor] Stopped');
    },

    // ── Reporting ────────────────────────────────────────────────────
    getReport() {
      const elapsed = Date.now() - this.startTime;
      const pythHealthyPct =
        this.stats.pythUpdates > 0
          ? ((this.stats.pythUpdates / (this.stats.pythUpdates + this.stats.pythTimeouts)) * 100).toFixed(1)
          : 'N/A';

      const fallbackSuccess = this.events.filter(e => e.type === 'fallback:complete').length;
      const fallbackFail = this.events.filter(e => e.type === 'fallback:error').length;

      return {
        monitoring_duration_secs: (elapsed / 1000).toFixed(1),
        pyth_lazer: {
          updates: this.stats.pythUpdates,
          timeouts: this.stats.pythTimeouts,
          health_pct: pythHealthyPct,
          last_update_ago_ms: Date.now() - this.lastPythUpdate,
          last_timeout_ago_ms: this.lastTimeout > 0 ? Date.now() - this.lastTimeout : null,
        },
        fallback_chain: {
          completions: fallbackSuccess,
          failures: fallbackFail,
          avg_timeout_ms: this.stats.totalTimeoutDuration / Math.max(1, this.stats.pythTimeouts),
        },
        total_events: this.events.length,
        recent_events: this.events.slice(-10),
      };
    },

    // ── Export data for analysis ────────────────────────────────────
    exportCSV() {
      if (!this.events.length) {
        console.warn('[PythMonitor] No events to export');
        return '';
      }

      const headers = ['timestamp', 'type', 'detail_json'];
      const rows = this.events.map(e => [
        new Date(e.ts).toISOString(),
        e.type,
        JSON.stringify(e).replace(/"/g, '""'), // CSV escape
      ]);

      const csv =
        headers.join(',') +
        '\n' +
        rows.map(r => `"${r[0]}","${r[1]}","${r[2]}"`).join('\n');

      // Copy to clipboard
      try {
        navigator.clipboard.writeText(csv).then(() => {
          console.log('[PythMonitor] CSV copied to clipboard');
        });
      } catch (e) {
        console.log('[PythMonitor] CSV (copy failed):\n' + csv);
      }

      return csv;
    },

    // ── Status check ────────────────────────────────────────────────
    getStatus() {
      const timeSinceLastPyth = Date.now() - this.lastPythUpdate;
      const timeSinceLastTimeout = Date.now() - this.lastTimeout;

      return {
        monitoring: this.enabled,
        pyth_status:
          timeSinceLastPyth < 5000
            ? `✓ Active (${timeSinceLastPyth}ms ago)`
            : timeSinceLastPyth < 30000
              ? `⚠️ Stale (${timeSinceLastPyth}ms ago)`
              : `✗ Dead (${timeSinceLastPyth}ms ago)`,
        timeout_status:
          this.stats.pythTimeouts === 0
            ? 'No timeouts yet'
            : `${this.stats.pythTimeouts} timeouts (last ${timeSinceLastTimeout}ms ago)`,
        pyth_health_pct:
          this.stats.pythUpdates > 0
            ? ((this.stats.pythUpdates / (this.stats.pythUpdates + this.stats.pythTimeouts)) * 100).toFixed(1)
            : 'N/A',
        fallback_ready: this.fallbackInProgress ? '🔄 In progress' : 'Ready',
      };
    },
  };

  // ── Expose to window ────────────────────────────────────────────────
  window.PythTimeoutMonitor = {
    start: () => monitor.start(),
    stop: () => monitor.stop(),
    getReport: () => monitor.getReport(),
    exportCSV: () => monitor.exportCSV(),
    getStatus: () => monitor.getStatus(),
    getEvents: () => monitor.events,
    clear: () => {
      monitor.events = [];
      console.log('[PythMonitor] Events cleared');
    },
  };

  console.log('[PythTimeoutMonitor] Ready. Start with: window.PythTimeoutMonitor.start()');
})();
