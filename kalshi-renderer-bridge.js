/**
 * Kalshi Renderer Bridge
 * 
 * Easy API for renderer process to access Kalshi worker.
 * Just use window.Kalshi.* in app.js
 * 
 * Usage:
 *   const balance = await window.Kalshi.getBalance();
 *   const markets = await window.Kalshi.getMarkets(50);
 */

window.Kalshi = {
  // Connection
  health: async () => {
    return await window.ipcRenderer.invoke('kalshi:health');
  },

  status: async () => {
    return await window.ipcRenderer.invoke('kalshi:status');
  },

  // Portfolio
  getBalance: async () => {
    return await window.ipcRenderer.invoke('kalshi:balance');
  },

  getPositions: async () => {
    return await window.ipcRenderer.invoke('kalshi:positions');
  },

  getOrders: async () => {
    return await window.ipcRenderer.invoke('kalshi:orders');
  },

  // Market Data
  getMarkets: async (limit = 50) => {
    return await window.ipcRenderer.invoke('kalshi:markets', { limit });
  },

  getEvents: async (ticker = null) => {
    return await window.ipcRenderer.invoke('kalshi:events', { ticker });
  },

  // Orders
  placeOrder: async (order) => {
    return await window.ipcRenderer.invoke('kalshi:placeOrder', order);
  },

  cancelOrder: async (orderId) => {
    return await window.ipcRenderer.invoke('kalshi:cancelOrder', orderId);
  },

  cancelAllOrders: async (filters = {}) => {
    return await window.ipcRenderer.invoke('kalshi:cancelAllOrders', filters);
  },

  // Market Details
  getTrades: async (marketId, filters = {}) => {
    return await window.ipcRenderer.invoke('kalshi:getTrades', marketId, filters);
  }
};

console.log('[Kalshi] Renderer bridge loaded. Use window.Kalshi.*');
