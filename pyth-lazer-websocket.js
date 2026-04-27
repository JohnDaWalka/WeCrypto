/**
 * Pyth Lazer WebSocket Handler (Official SDK)
 * Real-time price feeds via Pyth Lazer with redundant endpoint pool
 * 200ms fixed-rate updates, proper connection pooling
 */

const { PythLazerClient } = require("@pythnetwork/pyth-lazer-sdk");

const LAZER_TOKEN = process.env.LAZER_TOKEN || "HjkdyqJTX45K7nrqtkiKwHPuCpDkh2gmvKNof29RwTW";

const PRICE_FEED_IDS = {
  BTC: 1,
  ETH: 2,
  SOL: 3,
  XRP: 4,
  DOGE: 5,
  BNB: 6,
  HYPE: 7,
};

class PythLazerWebSocketHandler {
  constructor() {
    this.client = null;
    this.clients = new Set();
    this.connected = false;
    this.subscriptionId = 1;
  }

  /**
   * Initialize and connect to Pyth Lazer WebSocket pool
   */
  async connect() {
    try {
      console.log("[PythLazerWS] Initializing official SDK client...");

      this.client = await PythLazerClient.create({
        token: LAZER_TOKEN,
        webSocketPoolConfig: {
          urls: [
            "wss://pyth-lazer-0.dourolabs.app/v1/stream",
            "wss://pyth-lazer-1.dourolabs.app/v1/stream",
            "wss://pyth-lazer-2.dourolabs.app/v1/stream",
          ],
        },
      });

      console.log("[PythLazerWS] ✅ Client created, subscribing to price feeds...");

      // Subscribe to all price feeds with enhanced properties
      this.client.subscribe({
        type: "subscribe",
        subscriptionId: this.subscriptionId,
        priceFeedIds: Object.values(PRICE_FEED_IDS), // [1, 2, 3, 4, 5, 6, 7] for all 7 coins
        properties: [
          "price",
          "marketSession",
          "fundingRateInterval",
          "feedUpdateTimestamp",
          "confidence",
          "fundingRate",
          "bestAskPrice",
          "publisherCount",
          "bestBidPrice",
          "exponent",
          "fundingTimestamp",
        ],
        formats: ["solana", "leUnsigned", "leEcdsa", "evm"], // Multiple encoding formats
        channel: "real_time", // Real-time updates (no 200ms throttle)
        deliveryFormat: "json",
        jsonBinaryEncoding: "hex",
        parsed: true,
        ignoreInvalidFeeds: true,
      });

      console.log("[PythLazerWS] ✅ Subscribed to 7 price feeds with enhanced properties (real-time)");

      // Listen for price updates
      this.client.addMessageListener((message) => {
        if (message.type === "json") {
          this.handlePriceUpdate(message.value);
        }
      });

      // Handle connection failures
      this.client.addAllConnectionsDownListener(() => {
        console.error("[PythLazerWS] ⚠️ All WebSocket connections down, reconnecting...");
        this.connected = false;
        // SDK handles reconnection automatically
      });

      this.connected = true;
      console.log("[PythLazerWS] 🟢 Connected to Pyth Lazer (3x endpoint pool)");
    } catch (err) {
      console.error(`[PythLazerWS] ❌ Connection failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Handle price update and relay to all clients with enhanced data
   */
  handlePriceUpdate(data) {
    try {
      if (!data.parsed || !data.parsed.priceFeedUpdates) {
        return;
      }

      data.parsed.priceFeedUpdates.forEach((feed) => {
        // Convert feed ID back to symbol
        const symbol = Object.entries(PRICE_FEED_IDS).find(
          ([_, id]) => id === feed.priceFeedId
        )?.[0];

        if (!symbol) return;

        // Convert to Pyth standard format with all enhanced properties
        const update = {
          type: "price_update",
          account: `Crypto.${symbol}/USD`,
          price: {
            price: feed.price?.price || 0,
            conf: feed.price?.conf || 0,
            expo: feed.price?.expo || 0,
            publish_time: feed.publishTime || Math.floor(Date.now() / 1000),
          },
          // Enhanced Lazer properties
          marketSession: feed.marketSession || null,
          fundingRateInterval: feed.fundingRateInterval || null,
          feedUpdateTimestamp: feed.feedUpdateTimestamp || null,
          confidence: feed.confidence || null,
          fundingRate: feed.fundingRate || null,
          bestAskPrice: feed.bestAskPrice || null,
          publisherCount: feed.publisherCount || null,
          bestBidPrice: feed.bestBidPrice || null,
          exponent: feed.exponent || feed.price?.expo || 0,
          fundingTimestamp: feed.fundingTimestamp || null,
        };

        // Relay to all connected clients
        this.clients.forEach((client) => {
          try {
            if (client.readyState === 1) { // WebSocket.OPEN
              client.send(JSON.stringify(update));
            }
          } catch (e) {
            console.error(`[PythLazerWS] Send error: ${e.message}`);
          }
        });
      });
    } catch (err) {
      console.error(`[PythLazerWS] Parse error: ${err.message}`);
    }
  }

  /**
   * Register a client to receive updates
   */
  addClient(client) {
    this.clients.add(client);
    console.log(`[PythLazerWS] Client added (total: ${this.clients.size})`);
  }

  /**
   * Unregister a client
   */
  removeClient(client) {
    this.clients.delete(client);
    console.log(`[PythLazerWS] Client removed (total: ${this.clients.size})`);
  }

  /**
   * Shutdown the client
   */
  async disconnect() {
    if (this.client) {
      this.client.unsubscribe(this.subscriptionId);
      await this.client.shutdown();
      this.connected = false;
      console.log("[PythLazerWS] Disconnected");
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.connected,
      clients: this.clients.size,
      updateRate: "real-time (lowest latency)",
      endpoints: 3,
      priceFeedsCount: Object.keys(PRICE_FEED_IDS).length,
      properties: 11,
      formats: ["solana", "leUnsigned", "leEcdsa", "evm"],
    };
  }
}

module.exports = PythLazerWebSocketHandler;
