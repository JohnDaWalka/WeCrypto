// network-health-dashboard.js
// UI panel for displaying network health of all market data providers
(function () {
    if (window.NetworkHealthDashboard) return;

    // Create dashboard container
    const dash = document.createElement('div');
    dash.id = 'network-health-dashboard';
    dash.style.position = 'fixed';
    dash.style.bottom = '18px';
    dash.style.right = '18px';
    dash.style.zIndex = 9999;
    dash.style.background = 'rgba(24,28,36,0.98)';
    dash.style.border = '1.5px solid #333';
    dash.style.borderRadius = '10px';
    dash.style.boxShadow = '0 2px 12px #0008';
    dash.style.padding = '14px 18px 10px 18px';
    dash.style.minWidth = '260px';
    dash.style.fontFamily = 'JetBrains Mono, monospace';
    dash.style.fontSize = '14px';
    dash.style.color = '#e0e6f0';
    dash.style.pointerEvents = 'auto';


    dash.innerHTML = `
        <div style="font-weight:600;font-size:15px;margin-bottom:8px;letter-spacing:0.5px;">Network Health</div>
        <div id="network-health-alert" style="display:none;margin-bottom:8px;"></div>
        <div id="network-health-list"></div>
        <div id="network-health-lastupdate" style="font-size:12px;color:#aaa;margin-top:6px;"></div>
    `;

    document.body.appendChild(dash);

    function statusColor(status) {
        if (status === 'healthy') return '#3ecf8e';
        if (status === 'degraded') return '#ffd166';
        if (status === 'down') return '#ff5e5e';
        return '#888';
    }

    function formatAgo(ts) {
        if (!ts) return '—';
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 2) return 'just now';
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        return new Date(ts).toLocaleTimeString();
    }


    function render() {
        const state = window.NetworkHealth?.getAll?.() || {};
        const list = Object.entries(state).map(([provider, v]) => {
            return `<div style="display:flex;align-items:center;margin-bottom:4px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${statusColor(v.status)};margin-right:8px;"></span>
        <span style="font-weight:500;width:110px;display:inline-block;">${provider}</span>
        <span style="color:#aaa;font-size:12px;width:80px;display:inline-block;">${formatAgo(v.lastFetch)}</span>
        <span style="font-size:12px;color:${v.fallback ? '#ffd166' : '#aaa'};margin-left:6px;">${v.fallback ? 'Fallback' : ''}</span>
        <span style="font-size:12px;color:#ff5e5e;margin-left:6px;">${v.status === 'degraded' || v.status === 'down' ? v.reason : ''}</span>
      </div>`;
        }).join('');
        document.getElementById('network-health-list').innerHTML = list;
        document.getElementById('network-health-lastupdate').textContent = 'Updated ' + formatAgo(Date.now());

        // Render persistent failure alert if any
        const alertDiv = document.getElementById('network-health-alert');
        let alertMsg = '';
        if (window.NetworkHealth?.failureCounters) {
            for (const [provider, fc] of Object.entries(window.NetworkHealth.failureCounters)) {
                if (fc.alertActive) {
                    alertMsg += `<div style="background:#ff5e5e;color:#fff;padding:7px 12px;border-radius:6px;font-weight:600;margin-bottom:2px;">
                        ${provider} is DOWN (${fc.count} cycles): ${state[provider]?.reason || ''}
                    </div>`;
                }
            }
        }
        alertDiv.innerHTML = alertMsg;
        alertDiv.style.display = alertMsg ? '' : 'none';
    }


    // Listen for updates and alerts
    window.addEventListener('network-health-update', render);
    window.addEventListener('network-health-alert', render);
    setInterval(render, 2000);
    setTimeout(render, 100);

    window.NetworkHealthDashboard = { render };
})();
