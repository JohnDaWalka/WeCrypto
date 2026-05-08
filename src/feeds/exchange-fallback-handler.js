/**
 * exchange-fallback-handler.js — Multi-exchange fallback & automatic routing
 *
 * Handles API errors (403, 451, etc.) and automatically routes to alternative exchanges.
 * Priority order: Binance → Bybit → Kraken → Crypto.com → CoinGecko
 *
 * Usage:
 *   const handler = new ExchangeFallbackHandler();
 *   const candles = await handler.fetchCandles('BTC', '15m');
 */

(function () {
  'use strict';

  // Exchange configurations with priority and capabilities
  const EXCHANGES = {
    BINANCE: {
      name: 'Binance',
      priority: 1,
      baseUrl: 'https://api.binance.com',
      candleEndpoint: '/api/v3/klines',
      capabilities: ['candles', 'orderbook', 'trades', 'futures'],
    },
    BYBIT: {
      name: 'Bybit',
      priority: 2,
      baseUrl: 'https://api.bybit.com',
      candleEndpoint: '/v5/market/kline',
      capabilities: ['candles', 'orderbook', 'trades', 'perpetuals'],
    },
    KRAKEN: {
      name: 'Kraken',
      priority: 3,
      baseUrl: 'https://api.kraken.com',
      candleEndpoint: '/0/public/OHLC',
      capabilities: ['candles', 'trades'],
    },
    CRYPTO_COM: {
      name: 'Crypto.com',
      priority: 4,
      baseUrl: 'https://api.crypto.com/v2',
      candleEndpoint: '/public/get-candlestick',
      capabilities: ['candles'],
    },
    COINGECKO: {
      name: 'CoinGecko',
      priority: 5,
      baseUrl: 'https://api.coingecko.com/api/v3',
      candleEndpoint: '/coins/{id}/ohlc',
      capabilities: ['candles-historical'],
    },
  };

  // Symbol mappings for each exchange
  const SYMBOL_MAPS = {
    BINANCE: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT', HYPE: 'HYPEUSDT' },
    BYBIT: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT', HYPE: 'HYPEUSDT' },
    KRAKEN: { BTC: 'XBTUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT' },
    CRYPTO_COM: { BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD' },
    COINGECKO: { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin' },
  };

  class ExchangeFallbackHandler {
    constructor() {
      this.priorityOrder = Object.values(EXCHANGES)
        .sort((a, b) => a.priority - b.priority)
        .map(e => Object.keys(EXCHANGES).find(k => EXCHANGES[k].name === e.name));
      
      this.failureLog = {}; // Track failures per exchange
      this.circuitBreakers = {}; // Active circuit breakers per exchange
    }

    /**
     * Fetch candles with automatic fallback
     * @param {string} symbol - Coin symbol (BTC, ETH, etc.)
     * @param {string} interval - Candle interval (1m, 5m, 15m, 1h, etc.)
     * @param {number} limit - Number of candles to fetch
     * @returns {Promise<Array>} - Candle data in standard format
     */
    async fetchCandles(symbol, interval = '15m', limit = 300) {
      console.info(`[ExchangeFallback] Fetching ${symbol} ${interval} candles...`);

      for (const exchangeKey of this.priorityOrder) {
        try {
          // Check if exchange is already failing (circuit breaker)
          if (this.isCircuitOpen(exchangeKey)) {
            console.debug(`[ExchangeFallback] ${EXCHANGES[exchangeKey].name} circuit open, skipping`);
            continue;
          }

          const exchange = EXCHANGES[exchangeKey];
          const symbolMap = SYMBOL_MAPS[exchangeKey];

          // Check if symbol is available on this exchange
          if (!symbolMap || !symbolMap[symbol]) {
            console.debug(`[ExchangeFallback] ${exchange.name} doesn't support ${symbol}`);
            continue;
          }

          console.debug(`[ExchangeFallback] Trying ${exchange.name}...`);
          const candles = await this._fetchFromExchange(exchangeKey, symbol, interval, limit);

          if (candles && candles.length > 0) {
            console.info(`[ExchangeFallback] ✓ ${exchange.name} succeeded, got ${candles.length} candles`);
            this.recordSuccess(exchangeKey);
            return candles;
          }
        } catch (err) {
          this.recordFailure(exchangeKey, err);
          console.warn(`[ExchangeFallback] ${EXCHANGES[exchangeKey].name} failed:`, err.message);
          continue; // Try next exchange
        }
      }

      // All exchanges failed
      console.error('[ExchangeFallback] ✗ All exchanges exhausted for', symbol);
      throw new Error(`Failed to fetch ${symbol} candles from all exchanges`);
    }

    /**
     * Fetch from specific exchange with standard normalization
     */
    async _fetchFromExchange(exchangeKey, symbol, interval, limit) {
      const exchange = EXCHANGES[exchangeKey];
      const exchangeSymbol = SYMBOL_MAPS[exchangeKey][symbol];

      let url;
      switch (exchangeKey) {
        case 'BINANCE':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?symbol=${exchangeSymbol}&interval=${this._binanceInterval(interval)}&limit=${limit}`;
          const binResp = await fetch(url);
          if (!binResp.ok) {
            if (binResp.status === 403) throw new Error('403 Forbidden - IP or region blocked');
            throw new Error(`HTTP ${binResp.status}`);
          }
          const binData = await binResp.json();
          return binData.map(c => ({
            timestamp: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[7]),
            source: 'BINANCE'
          }));

        case 'BYBIT':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?category=spot&symbol=${exchangeSymbol}&interval=${this._bybitInterval(interval)}&limit=${limit}`;
          const byResp = await fetch(url);
          if (!byResp.ok) {
            if (byResp.status === 403) throw new Error('403 Forbidden - IP or region blocked');
            throw new Error(`HTTP ${byResp.status}`);
          }
          const byData = await byResp.json();
          if (!byData.result || !byData.result.list) throw new Error('Invalid response format');
          return byData.result.list.map(c => ({
            timestamp: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[7]),
            source: 'BYBIT'
          })).reverse(); // Bybit returns newest first

        case 'KRAKEN':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?pair=${exchangeSymbol}&interval=${this._krakenInterval(interval)}`;
          const krResp = await fetch(url);
          if (!krResp.ok) throw new Error(`HTTP ${krResp.status}`);
          const krData = await krResp.json();
          const pairKey = Object.keys(krData.result)[0];
          if (!pairKey) throw new Error('No data from Kraken');
          return krData.result[pairKey].map(c => ({
            timestamp: c[0] * 1000,
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[6]),
            source: 'KRAKEN'
          }));

        case 'CRYPTO_COM':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?instrument_name=${exchangeSymbol}&timeframe=${this._cryptoComInterval(interval)}&limit=${limit}`;
          const ccResp = await fetch(url);
          if (!ccResp.ok) throw new Error(`HTTP ${ccResp.status}`);
          const ccData = await ccResp.json();
          if (!ccData.result) throw new Error('Invalid response format');
          return ccData.result.map(c => ({
            timestamp: c.t * 1000,
            open: parseFloat(c.o),
            high: parseFloat(c.h),
            low: parseFloat(c.l),
            close: parseFloat(c.c),
            volume: parseFloat(c.v),
            source: 'CRYPTO_COM'
          }));

        case 'COINGECKO':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?vs_currency=usd&days=${this._coingeckoDays(interval)}&interval=${this._coingeckoInterval(interval)}`;
          const cgResp = await fetch(url);
          if (!cgResp.ok) {
            if (cgResp.status === 429) throw new Error('429 Rate Limited - wait before retry');
            throw new Error(`HTTP ${cgResp.status}`);
          }
          const cgData = await cgResp.json();
          return cgData.map(c => ({
            timestamp: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: 0, // CoinGecko doesn't provide volume in OHLC
            source: 'COINGECKO'
          }));

        default:
          throw new Error(`Unknown exchange: ${exchangeKey}`);
      }
    }

    /**
     * Convert standard interval to Binance format
     */
    _binanceInterval(interval) {
      const map = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
      return map[interval] || '15m';
    }

    /**
     * Convert standard interval to Bybit format
     */
    _bybitInterval(interval) {
      const map = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
      return map[interval] || '15';
    }

    /**
     * Convert standard interval to Kraken format
     */
    _krakenInterval(interval) {
      const map = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
      return map[interval] || 15;
    }

    /**
     * Convert standard interval to Crypto.com format
     */
    _cryptoComInterval(interval) {
      const map = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
      return map[interval] || '15m';
    }

    /**
     * Convert standard interval to CoinGecko format
     */
    _coingeckoDays(interval) {
      const days = { '1m': 1, '5m': 1, '15m': 7, '1h': 30, '4h': 90, '1d': 365 };
      return days[interval] || 7;
    }

    _coingeckoInterval(interval) {
      return this._coingeckoDays(interval) > 1 ? '' : '';
    }

    /**
     * Check if circuit breaker is open for exchange
     */
    isCircuitOpen(exchangeKey) {
      if (!window.ApiCircuitBreaker) return false;
      const breaker = window.ApiCircuitBreaker.getBreaker(`exchange-${exchangeKey}`, { threshold: 5 });
      return breaker.getState().state === 'OPEN';
    }

    /**
     * Record success for exchange
     */
    recordSuccess(exchangeKey) {
      if (!this.failureLog[exchangeKey]) this.failureLog[exchangeKey] = 0;
      this.failureLog[exchangeKey] = 0; // Reset counter
    }

    /**
     * Record failure for exchange
     */
    recordFailure(exchangeKey, err) {
      if (!this.failureLog[exchangeKey]) this.failureLog[exchangeKey] = 0;
      this.failureLog[exchangeKey]++;

      // Trip circuit breaker after 5 consecutive failures
      if (this.failureLog[exchangeKey] >= 5 && window.ApiCircuitBreaker) {
        const breaker = window.ApiCircuitBreaker.getBreaker(`exchange-${exchangeKey}`, { threshold: 5 });
        breaker.trip();
      }
    }

    /**
     * Get fallback status
     */
    getStatus() {
      return {
        priorityOrder: this.priorityOrder,
        failureLog: this.failureLog,
        exchanges: Object.keys(EXCHANGES).map(k => ({
          name: EXCHANGES[k].name,
          priority: EXCHANGES[k].priority,
          failures: this.failureLog[k] || 0,
        })),
      };
    }
  }

  // ─── Export to window ───────────────────────────────────────────────────
  window.ExchangeFallbackHandler = ExchangeFallbackHandler;

  console.info('[ExchangeFallbackHandler] Loaded: Multi-exchange fallback with automatic routing');
})();
