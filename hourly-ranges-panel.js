// ================================================================
// WE|||CRYPTO — Hourly Ranges Panel v3 (Price Ladder with Peg)
//
// Shows current price pegged in middle with 6 ranges above/below
// Increment sizes per coin:
//   BTC:   0.100      ETH: 0.10      SOL/XRP/DOGE/BNB/HYPE: 0.1
//
// Layout: Full-width grid, per-coin price ladder
// ================================================================

(function () {
  'use strict';

  const MAIN_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const COIN_COLORS = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#00d4aa', XRP: '#23292f',
    DOGE: '#c2a633', BNB: '#f3ba2f', HYPE: '#00dcff',
  };
  const PRICE_INCREMENTS = {
    BTC: 100, ETH: 0.10, SOL: 0.1, XRP: 0.1, DOGE: 0.1, BNB: 0.1, HYPE: 0.1
  };
  const LEVELS_SHOWN = 6; // 6 above + current + 6 below

  // ── Get current price for coin ───────────────────────────────────
  function getCurrentPrice(sym) {
    // Try: window._predictions → PredictionMarkets → tickers fallback
    const pred = window._predictions?.[sym];
    if (pred?.price) return pred.price;
    
    const pm = window.PredictionMarkets?.getCoin?.(sym);
    if (pm?.price) return pm.price;
    
    return null;
  }

  // ── Build price ladder for a coin ────────────────────────────────
  function buildPriceLadder(sym, currentPrice) {
    if (!currentPrice || currentPrice <= 0) {
      return `<div class="hr-ladder-empty">Waiting for price data…</div>`;
    }

    const increment = PRICE_INCREMENTS[sym] || 0.1;
    const priceColor = COIN_COLORS[sym];

    // Generate price levels: current ± 6 levels
    const levels = [];
    for (let i = -LEVELS_SHOWN; i <= LEVELS_SHOWN; i++) {
      const price = currentPrice + (i * increment);
      if (price <= 0) continue;
      
      const isCurrent = i === 0;
      const priceStr = price >= 1 ? price.toFixed(2) : price.toFixed(4);
      
      levels.push(`
        <div class="hr-level ${isCurrent ? 'hr-level-current' : ''}">
          <span class="hr-level-price">$${priceStr}</span>
          ${isCurrent ? '<span class="hr-level-peg">● CURRENT</span>' : ''}
        </div>
      `);
    }

    return `<div class="hr-ladder">${levels.join('')}</div>`;
  }

  // ── Build full panel ─────────────────────────────────────────────
  function buildPanelHTML() {
    let html = `<div class="hr-panel">
      <div class="hr-panel-header">
        <h2>Hourly Price Ladders</h2>
      </div>
      <div class="hr-grid-wrapper">`;

    for (const sym of MAIN_COINS) {
      const currentPrice = getCurrentPrice(sym);
      const ladder = buildPriceLadder(sym, currentPrice);
      const color = COIN_COLORS[sym];
      
      html += `
        <div class="hr-coin-section">
          <div class="hr-coin-label" style="color:${color}">${sym}</div>
          ${ladder}
        </div>
      `;
    }

    html += `</div></div>`;
    return html;
  }

  // ── Render panel ─────────────────────────────────────────────────
  function renderPanel() {
    const container = document.getElementById('content');
    if (!container) return;

    const panelHTML = buildPanelHTML();
    const panel = document.createElement('div');
    panel.id = 'hourly-ranges-panel';
    panel.innerHTML = panelHTML;
    
    container.replaceChildren(panel);
    window.dispatchEvent(new CustomEvent('hourly-ranges:ready'));
  }

  // ── Public API ───────────────────────────────────────────────────
  window.HourlyRangesPanel = {
    render: renderPanel,
  };

  console.log('[HourlyRangesPanel] Ready — price ladders for hourly ranges');
})();
