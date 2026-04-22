// ================================================================
// WE|||CRYPTO — Hourly Ranges Panel v1
//
// Fetches active hourly Kalshi contracts for 7 main coins
// Parses strike ranges and displays in side panel with:
//   - Hourly min/avg/max prices
//   - Model UP % vs Kalshi YES %
//   - Edge detection (green >20pp, gold >10pp)
//   - Win rate calibration per range
//
// Data sources:
//   Kalshi API — active hourly contracts
//   HourlyKalshiTracker — outcome calibration per coin
//
// Dispatch: CustomEvent 'hourly-ranges:ready' when panel ready
// ================================================================

(function () {
  'use strict';

  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const MAIN_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
  const POLL_INTERVAL_MS = 30 * 1000; // Update every 30s
  const EDGE_HIGH_PP = 20; // 20+ percentage points = green
  const EDGE_MID_PP = 10;  // 10+ pp = gold

  // ── State ────────────────────────────────────────────────────────
  let _rangesCache = {}; // sym → { ts, ranges: [{ minPrice, maxPrice, kalshiYes, model... }] }
  let _pollTimer = null;
  let _panelEl = null;
  let _renderVersion = 0;

  // ── Kalshi API wrapper ───────────────────────────────────────────
  async function fetchKalshiContracts(market) {
    try {
      const url = `${KALSHI_BASE}/markets?market_type=event&category=${market}&status=open`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (!resp.ok) return [];
      const { markets } = await resp.json();
      return markets || [];
    } catch (e) {
      console.error('[HourlyRanges] Kalshi fetch error:', e);
      return [];
    }
  }

  // ── Parse strike ranges from contract spec ───────────────────────
  // Kalshi hourly contracts have ticker like "BTC_77500_77600_20260421_0300"
  // Extract min/max strike from ticker
  function parseRangeFromTicker(ticker, sym) {
    // Format: SYM_MINPRICE_MAXPRICE_DATE_TIME
    const parts = ticker.split('_');
    if (parts.length < 3) return null;
    
    const minPrice = parseFloat(parts[1]);
    const maxPrice = parseFloat(parts[2]);
    
    if (isNaN(minPrice) || isNaN(maxPrice) || minPrice >= maxPrice) return null;
    
    return {
      sym,
      ticker,
      minPrice,
      maxPrice,
      midPrice: (minPrice + maxPrice) / 2,
      spread: maxPrice - minPrice,
    };
  }

  // ── Fetch hourly ranges for a coin ───────────────────────────────
  async function fetchHourlyRanges(sym) {
    // Use cached result if fresh
    if (_rangesCache[sym] && Date.now() - _rangesCache[sym].ts < CACHE_TTL_MS) {
      return _rangesCache[sym].ranges;
    }

    const contracts = await fetchKalshiContracts(sym);
    
    // Filter to hourly contracts (will have specific pattern)
    const hourlyContracts = contracts.filter(c => {
      const isHourly = c.duration_minutes === 60 || c.ticker.includes('_0100') || c.ticker.includes('_0200');
      return isHourly && c.status === 'open';
    });

    // Parse strike ranges
    const ranges = hourlyContracts
      .map(c => {
        const range = parseRangeFromTicker(c.ticker, sym);
        if (!range) return null;
        
        return {
          ...range,
          kalshiYes: (c.last_price || 0.5) * 100, // Convert to percentage
          lastPrice: c.last_price,
          liquidity: c.liquidity || 0,
          volume24h: c.volume_24h || 0,
          expirationTime: new Date(c.expiration_time).getTime(),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.minPrice - b.minPrice); // Sort by strike ascending

    // Cache result
    _rangesCache[sym] = { ts: Date.now(), ranges };
    return ranges;
  }

  // ── Compute model probability for range ──────────────────────────
  // Placeholder: in production, derive from signal-router-cfm model
  function computeModelProbability(sym, range) {
    // TODO: Call window.SignalRouter.getIntent(sym) for live model prob
    // For now, use neutral 50%
    return 50;
  }

  // ── Get win rate from HourlyKalshiTracker ────────────────────────
  function getWinRateForRange(sym, range) {
    if (!window.HourlyKalshiTracker) return null;
    
    const stats = window.HourlyKalshiTracker.getStats(sym);
    if (!stats || !stats.calibration) return null;

    // Find bucket that contains this range's odds (kalshiYes)
    const odds = Math.round(range.kalshiYes);
    for (const [bucket, data] of Object.entries(stats.calibration)) {
      const [min, max] = bucket.split('-').map(Number);
      if (odds >= min && odds <= max) {
        return data.samples > 0 ? (data.wins / data.samples * 100).toFixed(1) : null;
      }
    }
    return null;
  }

  // ── Build HTML for ranges table ──────────────────────────────────
  function buildRangesTableHTML(sym, ranges) {
    if (ranges.length === 0) {
      return `<div style="padding:12px;color:var(--color-text-muted);font-size:12px">No hourly contracts available</div>`;
    }

    const rows = ranges.map(range => {
      const modelUp = computeModelProbability(sym, range);
      const kalshiYes = Math.round(range.kalshiYes);
      const edge = Math.abs(modelUp - kalshiYes);
      const edgeColor = edge >= EDGE_HIGH_PP ? 'var(--color-up)' : edge >= EDGE_MID_PP ? 'var(--color-gold)' : 'var(--color-text-muted)';
      const edgeIcon = edge >= EDGE_HIGH_PP ? '⚡' : edge >= EDGE_MID_PP ? '▲' : '—';
      
      const winRate = getWinRateForRange(sym, range);
      const priceStr = `$${range.minPrice.toLocaleString()} - $${range.maxPrice.toLocaleString()}`;

      return `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);font-size:11px">
          <td style="padding:8px 4px;color:var(--color-text-muted)">${priceStr}</td>
          <td style="padding:8px 4px;color:${kalshiYes > 50 ? 'var(--color-up)' : 'var(--color-down)'};text-align:right">${kalshiYes}%</td>
          <td style="padding:8px 4px;color:${modelUp > 50 ? 'var(--color-up)' : 'var(--color-down)'};text-align:right">${Math.round(modelUp)}%</td>
          <td style="padding:8px 4px;color:${edgeColor};text-align:center"><span title="${edge.toFixed(1)}pp">${edgeIcon} ${Math.round(edge)}</span></td>
          <td style="padding:8px 4px;color:var(--color-text-muted);text-align:right">${winRate ? winRate + '%' : '—'}</td>
        </tr>
      `;
    }).join('');

    return `
      <table style="width:100%;border-collapse:collapse;font-family:monospace">
        <thead style="border-bottom:2px solid rgba(255,255,255,0.1);font-size:10px;color:var(--color-text-muted)">
          <tr>
            <th style="padding:6px 4px;text-align:left">Strike Range</th>
            <th style="padding:6px 4px;text-align:right">Kalshi %</th>
            <th style="padding:6px 4px;text-align:right">Model %</th>
            <th style="padding:6px 4px;text-align:center">Edge</th>
            <th style="padding:6px 4px;text-align:right">Win Rate</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // ── Build full panel HTML ────────────────────────────────────────
  async function buildPanelHTML() {
    const rv = ++_renderVersion;
    
    let html = `
      <div style="
        display:flex;
        flex-direction:column;
        height:100%;
        background:rgba(0,0,0,0.3);
        border-left:1px solid rgba(255,255,255,0.1);
        font-family:var(--font-mono,'JetBrains Mono',monospace);
      ">
        <!-- Panel Header -->
        <div style="
          padding:16px 12px;
          border-bottom:1px solid rgba(255,255,255,0.1);
          display:flex;
          justify-content:space-between;
          align-items:center;
        ">
          <div style="font-weight:600;font-size:13px">Hourly Ranges</div>
          <button class="hr-refresh-btn" style="
            background:transparent;
            border:1px solid rgba(255,255,255,0.2);
            color:var(--color-text);
            padding:4px 8px;
            border-radius:4px;
            cursor:pointer;
            font-size:10px;
          ">Refresh</button>
        </div>

        <!-- Scrollable Ranges Container -->
        <div style="
          flex:1;
          overflow-y:auto;
          padding:0;
        " id="rangesContainer">
    `;

    // Fetch and render ranges for each coin
    for (const sym of MAIN_COINS) {
      if (rv !== _renderVersion) return null; // Self-cancel if newer render started
      
      const ranges = await fetchHourlyRanges(sym);
      const rangesHTML = buildRangesTableHTML(sym, ranges);
      
      html += `
        <div style="
          border-bottom:1px solid rgba(255,255,255,0.05);
          padding:12px;
        ">
          <div style="
            font-weight:600;
            font-size:12px;
            margin-bottom:8px;
            color:var(--color-up);
          ">${sym}</div>
          ${rangesHTML}
        </div>
      `;
    }

    html += `
        </div>

        <!-- Panel Footer (Stats) -->
        <div style="
          padding:8px 12px;
          border-top:1px solid rgba(255,255,255,0.1);
          font-size:9px;
          color:var(--color-text-muted);
          background:rgba(0,0,0,0.2);
        ">
          <div>📊 Auto-refresh every 30s</div>
          <div>⚡ = 20+pp edge (green) | ▲ = 10+pp (gold)</div>
        </div>
      </div>
    `;

    return html;
  }

  // ── Render panel into DOM ────────────────────────────────────────
  async function renderPanel() {
    const container = document.getElementById('content');
    if (!container) return;

    // Create panel wrapper
    _panelEl = document.createElement('div');
    _panelEl.id = 'hourly-ranges-panel';
    _panelEl.style.cssText = `
      display:grid;
      grid-template-columns:1fr 380px;
      height:100%;
      gap:0;
      width:100%;
    `;

    const panelHTML = await buildPanelHTML();
    if (!panelHTML) return; // Render was cancelled

    // Create left placeholder (for future market view)
    const leftDiv = document.createElement('div');
    leftDiv.style.cssText = `
      display:flex;
      align-items:center;
      justify-content:center;
      color:var(--color-text-muted);
      font-size:14px;
    `;
    leftDiv.innerHTML = '<p>Select a range to see live chart →</p>';

    // Create right side panel
    const rightDiv = document.createElement('div');
    rightDiv.innerHTML = panelHTML;
    
    _panelEl.appendChild(leftDiv);
    _panelEl.appendChild(rightDiv);
    
    container.replaceChildren(_panelEl);

    // Wire refresh button
    const refreshBtn = _panelEl.querySelector('.hr-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        _rangesCache = {}; // Clear cache
        renderPanel();
      });
    }

    // Dispatch ready event
    window.dispatchEvent(new CustomEvent('hourly-ranges:ready'));
  }

  // ── Start polling for updates ────────────────────────────────────
  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      // Refresh cached ranges periodically
      for (const sym of MAIN_COINS) {
        const cached = _rangesCache[sym];
        if (cached && Date.now() - cached.ts > 5 * 60 * 1000) { // 5 min refresh
          delete _rangesCache[sym];
        }
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────
  window.HourlyRangesPanel = {
    render: renderPanel,
    startPolling,
    stopPolling,
    getCache: () => _rangesCache,
    clearCache: () => { _rangesCache = {}; },
  };

  console.log('[HourlyRangesPanel] Ready — hourly strike ranges for 7 main coins');
})();
