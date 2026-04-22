// ================================================================
// WE|||CRYPTO — Hourly Ranges Panel v4 (Kalshi API Integration)
//
// Fetches actual hourly range contracts from Kalshi API (~70 ranges per coin)
// Displays all available range strikes with live odds
//
// Kalshi hourly range series (e.g., KXBTC_H, KXETH_H, etc.)
// Each range: e.g., "KXBTC_H_75000_75100" = BTC between $75000-$75100
// ================================================================

(function () {
  'use strict';

  const MAIN_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const COIN_COLORS = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#00d4aa', XRP: '#23292f',
    DOGE: '#c2a633', BNB: '#f3ba2f', HYPE: '#00dcff',
  };
  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const COINBASE_BASE = 'https://api.coinbase.com/api/v3/brokerage';
  const KRAKEN_BASE = 'https://api.kraken.com/0/public';
  
  // Hourly range series base names (e.g., KXBTC_H)
  const HOURLY_RANGE_SERIES = {
    BTC:  'KXBTC_H',
    ETH:  'KXETH_H',
    SOL:  'KXSOL_H',
    XRP:  'KXXRP_H',
    DOGE: 'KXDOGE_H',
    BNB:  'KXBNB_H',
    HYPE: 'KXHYPE_H',
  };

  // Coinbase product IDs for live pricing
  const COINBASE_PRODUCTS = {
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
    DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD',
  };

  // Kraken tickers
  const KRAKEN_TICKERS = {
    BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLZUSD', XRP: 'XXRPZUSD',
    DOGE: 'XDOGEZUSD', BNB: 'BNBUSD', HYPE: null,
  };

  let _cachedRanges = {}; // { 'BTC': [{ ...market }, ...], ... }
  let _cachedPrices = {}; // { 'BTC': 45000, ... }

  // ── Fetch live price from Coinbase, fallback to Kraken ──────────
  async function getLivePrice(sym) {
    // Try Coinbase first (fastest, most reliable)
    const cbProduct = COINBASE_PRODUCTS[sym];
    if (cbProduct) {
      try {
        const res = await fetch(`${COINBASE_BASE}/market/products/${cbProduct}/ticker`);
        if (res.ok) {
          const data = await res.json();
          if (data.price) return parseFloat(data.price);
        }
      } catch (e) {
        console.warn(`[HourlyRangesPanel] Coinbase fetch failed for ${sym}:`, e.message);
      }
    }

    // Fallback to Kraken
    const krakenTicker = KRAKEN_TICKERS[sym];
    if (krakenTicker) {
      try {
        const res = await fetch(`${KRAKEN_BASE}/Ticker?pair=${krakenTicker}`);
        if (res.ok) {
          const data = await res.json();
          if (data.result?.[krakenTicker]) {
            const tickerData = data.result[krakenTicker];
            return parseFloat(tickerData.c[0]); // c = last trade close array
          }
        }
      } catch (e) {
        console.warn(`[HourlyRangesPanel] Kraken fetch failed for ${sym}:`, e.message);
      }
    }

    // Fallback to cached prediction market data
    const pred = window._predictions?.[sym];
    if (pred?.price) return pred.price;
    
    return null;
  }

  // ── Fetch all hourly range contracts for a coin ─────────────────
  async function fetchHourlyRangesForCoin(sym) {
    const series = HOURLY_RANGE_SERIES[sym];
    if (!series) return [];

    try {
      // Fetch all markets matching the hourly range series (status=open, limit=100)
      const url = `${KALSHI_BASE}/markets?series_ticker=${series}&status=open&limit=100`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      
      if (!data?.markets) return [];

      // Parse contract titles to extract range bounds: "KXBTC_H_75000_75100" → { low: 75000, high: 75100 }
      const ranges = data.markets.map(m => {
        const parts = m.ticker.split('_');
        // Format: [KXBTC, H, 75000, 75100]
        const low = parseFloat(parts[2]);
        const high = parseFloat(parts[3]);
        return {
          ticker: m.ticker,
          low,
          high,
          yesPrice: m.yes_price || 0,
          noPrice: m.no_price || 0,
          prob: m.yes_price / 100, // yes_price is in cents, convert to probability (0-1)
          closeTime: m.close_time,
        };
      });

      // Sort by low price descending (highest at top, lowest at bottom)
      ranges.sort((a, b) => b.low - a.low);
      return ranges;
    } catch (e) {
      console.warn(`[HourlyRangesPanel] Error fetching ranges for ${sym}:`, e);
      return [];
    }
  }

  // ── Fetch all hourly ranges for all coins + live prices ────────
  async function loadAllRanges() {
    _cachedRanges = {};
    _cachedPrices = {};
    
    for (const sym of MAIN_COINS) {
      // Fetch ranges and live price in parallel
      const [ranges, price] = await Promise.all([
        fetchHourlyRangesForCoin(sym),
        getLivePrice(sym),
      ]);
      _cachedRanges[sym] = ranges;
      _cachedPrices[sym] = price;
    }
  }

  // ── Determine range classification relative to current price ────
  function classifyRange(low, high, currentPrice) {
    if (!currentPrice) return 'neutral'; // grey if no price
    if (currentPrice >= low && currentPrice <= high) return 'current'; // GREEN
    if (currentPrice < low) return 'lower'; // RED
    return 'higher'; // ORANGE (projected higher)
  }

  // ── Build range ladder with color coding ──────────────────────
  function buildRangeLadder(sym, ranges, currentPrice) {
    if (!ranges || ranges.length === 0) {
      return `<div class="hr-ladder-empty">Loading ranges…</div>`;
    }

    const levels = ranges.map(r => {
      const probPct = Math.round(r.prob * 100);
      const classification = classifyRange(r.low, r.high, currentPrice);
      
      const priceStr = r.low >= 1 ? `$${r.low.toFixed(0)}-$${r.high.toFixed(0)}` : 
                                     `$${r.low.toFixed(4)}-$${r.high.toFixed(4)}`;
      
      let badge = '';
      if (classification === 'current' && currentPrice) {
        badge = ` <span class="hr-range-badge">● ${currentPrice.toFixed(2)}</span>`;
      }
      
      return `
        <div class="hr-level hr-level-${classification}" title="${r.ticker}">
          <span class="hr-level-price">${priceStr}</span>
          <span class="hr-level-prob">${probPct}%</span>
          ${badge}
        </div>
      `;
    });

    return `<div class="hr-ladder">${levels.join('')}</div>`;
  }

  // ── Build full panel ─────────────────────────────────────────────
  function buildPanelHTML() {
    let html = `<div class="hr-panel">
      <div class="hr-panel-header">
        <h2>Kalshi Hourly Range Contracts</h2>
      </div>
      <div class="hr-grid-wrapper">`;

    for (const sym of MAIN_COINS) {
      const ranges = _cachedRanges[sym] || [];
      const currentPrice = _cachedPrices[sym];
      const ladder = buildRangeLadder(sym, ranges, currentPrice);
      const color = COIN_COLORS[sym];
      
      const priceDisplay = currentPrice ? `$${currentPrice.toFixed(2)}` : 'Loading...';
      
      html += `
        <div class="hr-coin-section">
          <div class="hr-coin-label" style="color:${color}">${sym}</div>
          <div class="hr-coin-price">Current: ${priceDisplay}</div>
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
    load: loadAllRanges,
    getRanges: (sym) => _cachedRanges[sym] || [],
  };

  console.log('[HourlyRangesPanel] Ready — fetching Kalshi hourly range contracts');
})();
