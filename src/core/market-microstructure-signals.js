/**
 * Advanced market microstructure signal helpers.
 *
 * Exposes window.MicrostructureSignals for predictions.js. The helpers are
 * intentionally defensive because live order book payloads vary by exchange.
 */
(function () {
  'use strict';

  function clamp(value, min = -1, max = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(min, Math.min(max, n));
  }

  function toLevel(level) {
    if (Array.isArray(level)) {
      return { price: Number(level[0]), size: Number(level[1]) };
    }
    if (level && typeof level === 'object') {
      return {
        price: Number(level.price ?? level.p ?? level[0]),
        size: Number(level.size ?? level.quantity ?? level.amount ?? level.qty ?? level[1]),
      };
    }
    return { price: NaN, size: NaN };
  }

  function normalizeLevels(levels, limit) {
    return (Array.isArray(levels) ? levels : [])
      .slice(0, Math.max(1, Number(limit) || 1))
      .map(toLevel)
      .filter(level => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size >= 0);
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  async function fetchFundingRateBybit(symbol, timeoutMs = 5000) {
    const sym = `${String(symbol || '').toUpperCase()}USDT`;
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&limit=1`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
      const data = await response.json();
      const latest = data?.result?.list?.[0];
      return {
        rate: Number(latest?.fundingRate) || 0,
        nextTime: Number(latest?.nextFundingTime) || 0,
        timestamp: Number(latest?.fundingRateTimestamp) || Date.now(),
      };
    } catch (err) {
      console.warn(`[MicroSignals] Funding rate fetch failed for ${symbol}:`, err?.message || err);
      return { rate: 0, nextTime: 0, timestamp: Date.now() };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function analyzeFundingPressure(fundingRate) {
    const rate = Number(fundingRate) || 0;
    const absRate = Math.abs(rate);
    const normal = 0.0005;
    const high = 0.001;
    const extreme = 0.0015;

    if (absRate < 0.00001) {
      return { signal: 0, pressure: 'neutral', strength: 0 };
    }

    const side = rate > 0 ? -1 : 1;
    let pressure = rate > 0 ? 'long_bias' : 'short_bias';
    let signal = 0;
    let strength = 0;

    if (absRate >= extreme) {
      pressure = rate > 0 ? 'extreme_long_heavy' : 'extreme_short_heavy';
      strength = clamp((absRate - extreme) / 0.001, 0, 1);
      signal = side * (0.65 + strength * 0.35);
    } else if (absRate >= high) {
      pressure = rate > 0 ? 'high_long_bias' : 'high_short_bias';
      strength = (absRate - high) / (extreme - high);
      signal = side * (0.45 + strength * 0.20);
    } else if (absRate >= normal) {
      strength = (absRate - normal) / (high - normal);
      signal = side * (0.15 + strength * 0.15);
    }

    return { signal: clamp(signal), pressure, strength: clamp(strength, 0, 1) };
  }

  function analyzeOrderBookImbalance(book, levels = 15) {
    const bids = normalizeLevels(book?.bids, levels);
    const asks = normalizeLevels(book?.asks, levels);
    if (bids.length < 2 || asks.length < 2) {
      return { imbalance: 0, distribution: {}, depth: {}, error: 'Insufficient book data' };
    }

    function weightedSum(rows) {
      return rows.reduce((sum, row, index) => {
        const weight = 1 / (1 + index * 0.15);
        return sum + row.size * weight;
      }, 0);
    }

    const bidNear = bids.slice(0, 3).reduce((sum, row) => sum + row.size, 0);
    const askNear = asks.slice(0, 3).reduce((sum, row) => sum + row.size, 0);
    const bidMid = bids.slice(3, 8).reduce((sum, row) => sum + row.size, 0);
    const askMid = asks.slice(3, 8).reduce((sum, row) => sum + row.size, 0);
    const bidDeep = bids.slice(8).reduce((sum, row) => sum + row.size, 0);
    const askDeep = asks.slice(8).reduce((sum, row) => sum + row.size, 0);
    const bidTotal = weightedSum(bids);
    const askTotal = weightedSum(asks);
    const total = bidTotal + askTotal;

    return {
      imbalance: total > 0 ? clamp((bidTotal - askTotal) / total) : 0,
      distribution: { bidNear, bidMid, bidDeep, askNear, askMid, askDeep },
      depth: {
        bidTotal,
        askTotal,
        spread: Math.max(0, asks[0].price - bids[0].price),
      },
    };
  }

  function imbalanceToSignal(imbalance) {
    const value = clamp(imbalance);
    const absValue = Math.abs(value);
    if (absValue < 0.10) return { signal: 0, strength: 0, type: 'balanced' };

    let magnitude = 0.15;
    let type = value > 0 ? 'slight_buy_bias' : 'slight_sell_bias';
    if (absValue >= 0.50) {
      magnitude = 0.55 + Math.min(0.45, (absValue - 0.50) * 0.90);
      type = value > 0 ? 'strong_buy_wall' : 'strong_sell_wall';
    } else if (absValue >= 0.25) {
      magnitude = 0.35 + (absValue - 0.25) * 0.80;
      type = value > 0 ? 'moderate_buy_bias' : 'moderate_sell_bias';
    } else {
      magnitude = 0.15 + (absValue - 0.10) * 1.33;
    }

    return {
      signal: clamp(Math.sign(value) * magnitude),
      strength: clamp(absValue, 0, 1),
      type,
    };
  }

  function detectLiquidityVacuum(book, midPrice, lookupLevels = 30) {
    const mid = Number(midPrice) || 0;
    const bids = normalizeLevels(book?.bids, lookupLevels).sort((a, b) => b.price - a.price);
    const asks = normalizeLevels(book?.asks, lookupLevels).sort((a, b) => a.price - b.price);
    if (!mid || bids.length < 3 || asks.length < 3) {
      return { vacuumFound: false, zones: [], zonesCount: 0, risk: 0, error: 'Invalid inputs' };
    }

    function collectZones(rows, side) {
      const gaps = [];
      for (let i = 0; i < rows.length - 1; i++) {
        gaps.push(Math.abs(rows[i + 1].price - rows[i].price));
      }
      const baseGap = median(gaps) || Math.max(mid * 0.0001, 0.000001);
      const avgSize = rows.reduce((sum, row) => sum + row.size, 0) / rows.length || 0;
      const zones = [];

      for (let i = 0; i < rows.length - 1; i++) {
        const current = rows[i];
        const next = rows[i + 1];
        const gap = Math.abs(next.price - current.price);
        const localSize = (current.size + next.size) / 2;
        const gapIntensity = clamp((gap / baseGap - 1.5) / 3, 0, 1);
        const thinIntensity = avgSize > 0 ? clamp(1 - localSize / avgSize, 0, 1) : 0;
        const intensity = Math.max(gapIntensity, thinIntensity * 0.75);

        if (intensity >= 0.25) {
          zones.push({
            side,
            lower: Math.min(current.price, next.price),
            upper: Math.max(current.price, next.price),
            gap,
            gapPct: gap / mid,
            intensity,
          });
        }
      }

      return zones;
    }

    const zones = collectZones(bids, 'bid').concat(collectZones(asks, 'ask'));
    const risk = zones.reduce((max, zone) => Math.max(max, zone.intensity), 0);
    return {
      vacuumFound: zones.length > 0,
      zones,
      zonesCount: zones.length,
      risk: clamp(risk, 0, 1),
    };
  }

  function vacuumToSignal(vacuumData) {
    const zones = Array.isArray(vacuumData?.zones) ? vacuumData.zones : [];
    if (!vacuumData?.vacuumFound || zones.length === 0) {
      return { signal: 0, type: 'none', risk: 0 };
    }

    const upside = zones
      .filter(zone => zone.side === 'ask')
      .reduce((max, zone) => Math.max(max, zone.intensity), 0);
    const downside = zones
      .filter(zone => zone.side === 'bid')
      .reduce((max, zone) => Math.max(max, zone.intensity), 0);
    const signal = clamp((upside - downside) * 0.75);
    const risk = clamp(Math.max(upside, downside, Number(vacuumData.risk) || 0), 0, 1);

    let type = 'mixed_vacuum';
    if (signal > 0.05) type = 'upside_vacuum';
    if (signal < -0.05) type = 'downside_vacuum';
    return { signal, type, risk, upside, downside };
  }

  window.MicrostructureSignals = {
    fetchFundingRateBybit,
    analyzeFundingPressure,
    analyzeOrderBookImbalance,
    imbalanceToSignal,
    detectLiquidityVacuum,
    vacuumToSignal,
  };
})();
