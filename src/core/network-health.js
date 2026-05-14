// window.NetworkHealth.js
// Global network health state for all market data providers
(function () {
    if (window.NetworkHealth) return; // Singleton

    const PROVIDERS = [
        'Kalshi',
        'Polymarket',
        'ProxyOrchestrator',
        'Pyth',
        // Add more as needed
    ];

    const DEFAULT_STATUS = {
        status: 'unknown', // healthy | degraded | down | unknown
        lastFetch: null,
        fallback: false,
        reason: '',
    };


    const state = {};
    const failureCounters = {}; // provider -> { count, lastDown }
    const FAILURE_THRESHOLD = 3; // cycles before alert
    for (const p of PROVIDERS) {
        state[p] = { ...DEFAULT_STATUS };
        failureCounters[p] = { count: 0, lastDown: null, alertActive: false };
    }


    function update(provider, statusObj) {
        if (!state[provider]) state[provider] = { ...DEFAULT_STATUS };
        Object.assign(state[provider], statusObj);
        state[provider].lastUpdate = Date.now();

        // Persistent failure tracking
        if (statusObj.status === 'down') {
            failureCounters[provider].count++;
            failureCounters[provider].lastDown = Date.now();
        } else {
            failureCounters[provider].count = 0;
            failureCounters[provider].alertActive = false;
        }

        // Escalation: trigger alert if threshold breached
        if (failureCounters[provider].count >= FAILURE_THRESHOLD && !failureCounters[provider].alertActive) {
            failureCounters[provider].alertActive = true;
            // Emit alert event for UI
            if (typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new CustomEvent('network-health-alert', { detail: { provider, count: failureCounters[provider].count, since: failureCounters[provider].lastDown, reason: state[provider].reason } }));
            }
        }

        // Optionally: emit event for UI listeners
        if (typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('network-health-update', { detail: { provider, ...state[provider] } }));
        }
    }

    function get(provider) {
        return provider ? state[provider] : { ...state };
    }

    function getAll() {
        return { ...state };
    }

    window.NetworkHealth = {
        update,
        get,
        getAll,
        PROVIDERS,
        failureCounters,
    };
})();
