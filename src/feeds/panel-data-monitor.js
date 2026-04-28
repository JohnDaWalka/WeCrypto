// ================================================================
// panel-data-monitor.js — Ensures UI panels always have fresh data
// Monitors and auto-refreshes data fetches on failure
// ================================================================

(function () {
  'use strict';

  const MONITOR_INTERVAL = 5000; // Check every 5s
  const RETRY_BACKOFF_MS = 2000; // Exponential backoff
  const MAX_RETRIES = 3;
  const STALE_DATA_THRESHOLD = 60_000; // 60s without update = stale

  let _monitorTimer = null;
  const _dataChannels = new Map(); // channel → {lastUpdate, lastError, retryCount, ...}
  const _stats = {
    checked: 0,
    recovered: 0,
    errors: 0,
    channels: {},
  };

  // Register a data channel for monitoring
  function register(name, getFn, renderFn, opts = {}) {
    if (!name || typeof getFn !== 'function') {
      throw new Error('Panel monitor: name and getFn required');
    }

    _dataChannels.set(name, {
      name,
      getFn,
      renderFn: renderFn || null,
      lastUpdate: null,
      lastError: null,
      retryCount: 0,
      enabled: true,
      critical: opts.critical || false,
      interval: opts.interval || MONITOR_INTERVAL,
      maxRetries: opts.maxRetries || MAX_RETRIES,
    });

    _stats.channels[name] = { attempts: 0, failures: 0, recoveries: 0 };

    // Run immediately
    _checkChannel(name);
  }

  // Check a single channel
  async function _checkChannel(name) {
    const channel = _dataChannels.get(name);
    if (!channel || !channel.enabled) return;

    _stats.channels[name].attempts++;

    try {
      // Call fetch function
      const data = await Promise.race([
        channel.getFn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 15000)
        ),
      ]);

      // Update success state
      channel.lastUpdate = Date.now();
      channel.lastError = null;
      channel.retryCount = 0;

      // Re-render if renderer provided
      if (channel.renderFn && data) {
        try {
          channel.renderFn(data);
        } catch (renderErr) {
          console.warn(`[PanelMonitor] ${name} render failed:`, renderErr.message);
        }
      }

      if (_stats.channels[name].failures > 0) {
        _stats.recovered++;
        _stats.channels[name].recoveries++;
        console.log(`[PanelMonitor] ${name} recovered after ${_stats.channels[name].failures} failures`);
      }
      _stats.channels[name].failures = 0;
    } catch (err) {
      _stats.errors++;
      _stats.channels[name].failures++;
      channel.lastError = err.message;
      channel.retryCount++;

      const elapsed = Date.now() - (channel.lastUpdate || Date.now());
      const isStale = channel.lastUpdate && elapsed > STALE_DATA_THRESHOLD;

      // Log critical failures
      if (channel.critical || isStale) {
        console.warn(
          `[PanelMonitor] ${name} failed (retry ${channel.retryCount}/${channel.maxRetries}): ${err.message}`,
          isStale ? `[STALE: ${Math.round(elapsed / 1000)}s old]` : ''
        );
      }

      // Disable after max retries
      if (channel.retryCount >= channel.maxRetries && isStale) {
        channel.enabled = false;
        console.error(`[PanelMonitor] ${name} disabled after ${channel.maxRetries} failed retries`);
      }
    }
  }

  // Monitor loop
  function _startMonitoring() {
    if (_monitorTimer) clearInterval(_monitorTimer);

    _monitorTimer = setInterval(() => {
      _stats.checked++;

      // Check all channels
      for (const [name] of _dataChannels) {
        _checkChannel(name).catch(e =>
          console.debug(`[PanelMonitor] ${name} monitor error:`, e.message)
        );
      }
    }, MONITOR_INTERVAL);

    console.log('[PanelMonitor] Started monitoring', _dataChannels.size, 'data channels');
  }

  function _stopMonitoring() {
    if (_monitorTimer) {
      clearInterval(_monitorTimer);
      _monitorTimer = null;
    }
  }

  // Public API
  const API = {
    register,
    start: _startMonitoring,
    stop: _stopMonitoring,

    getStatus(name) {
      if (!name) {
        return {
          stats: _stats,
          channels: Array.from(_dataChannels.entries()).map(([k, v]) => ({
            name: k,
            enabled: v.enabled,
            lastUpdate: v.lastUpdate ? new Date(v.lastUpdate).toLocaleTimeString() : 'never',
            lastError: v.lastError,
            retryCount: v.retryCount,
          })),
        };
      }

      const channel = _dataChannels.get(name);
      return channel ? {
        name,
        enabled: channel.enabled,
        lastUpdate: channel.lastUpdate,
        lastError: channel.lastError,
        retryCount: channel.retryCount,
      } : null;
    },

    // Force immediate refresh of a channel
    async refresh(name) {
      if (!name) {
        // Refresh all
        for (const [key] of _dataChannels) {
          await _checkChannel(key);
        }
      } else {
        await _checkChannel(name);
      }
    },

    // Re-enable a disabled channel
    renable(name) {
      const channel = _dataChannels.get(name);
      if (channel) {
        channel.enabled = true;
        channel.retryCount = 0;
        console.log(`[PanelMonitor] ${name} re-enabled`);
        return _checkChannel(name);
      }
    },

    getDiagnostics() {
      return {
        uptime: _stats.checked * MONITOR_INTERVAL,
        totalChecks: _stats.checked,
        totalRecoveries: _stats.recovered,
        totalErrors: _stats.errors,
        channelStats: _stats.channels,
        activeChannels: _dataChannels.size,
        disabledChannels: Array.from(_dataChannels.values())
          .filter(c => !c.enabled)
          .map(c => c.name),
      };
    },
  };

  // Expose on window
  if (typeof window !== 'undefined') {
    window.PanelDataMonitor = API;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }
})();
