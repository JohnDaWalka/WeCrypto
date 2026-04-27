/**
 * PYTH Momentum Exit Integration
 * 
 * Wires the momentum tracker into the main polling loop
 * Called every 15 seconds with PYTH price updates
 */

(function() {
  'use strict';

  // Poll every 15 seconds to check PYTH samples and momentum
  let momentumPollTimer = null;
  let lastPythUpdateTime = 0;

  /**
   * Main integration: updates momentum tracker with PYTH samples
   * Called in the 15-sec polling cycle
   */
  window.integrateMomentumExit = function() {
    if (!window.PYTHMomentumExit) return;
    
    // Get all active positions
    const activePositions = window.PYTHMomentumExit.getAllPositions?.() || {};
    
    // For each position, check if momentum break detected
    for (const marketId in activePositions) {
      const pos = activePositions[marketId];
      
      // Determine coin from marketId (e.g., KXBTC -> BTC)
      const coin = extractCoinFromMarketId(marketId);
      if (!coin) continue;
      
      // Get PYTH price from window._cfm (which has live PYTH data)
      const currentPrice = window._cfm?.[coin]?.cfmRate;
      if (currentPrice === undefined) continue;
      
      // Update momentum tracker
      if (window.PYTHMomentumExit.updateMomentum) {
        window.PYTHMomentumExit.updateMomentum(marketId, currentPrice);
      }
      
      // Check if exit signal triggered
      if (window.PYTHMomentumExit.shouldExit?.(marketId)) {
        handleMomentumExit(marketId, pos);
      }
    }
  };

  /**
   * Extract coin symbol from market ID
   * KXBTC -> BTC, KXETH -> ETH, etc.
   */
  function extractCoinFromMarketId(marketId) {
    if (!marketId || marketId.length < 3) return null;
    if (marketId.startsWith('KX')) {
      return marketId.substring(2);
    }
    return null;
  }

  /**
   * Execute exit when momentum break detected
   */
  async function handleMomentumExit(marketId, position) {
    console.log(`🚨 [MOMENTUM EXIT] ${marketId}: Momentum break detected after ${position.samples?.length || 0} samples`);
    
    // Log the momentum exit decision
    const exitLog = {
      timestamp: Date.now(),
      marketId,
      exitReason: 'momentum_break',
      samples: position.samples?.length || 0,
      confidence: position.confidence,
      direction: position.direction
    };
    
    window._momentumExitLog = window._momentumExitLog || [];
    window._momentumExitLog.push(exitLog);
    
    // Try to execute market exit if Kalshi bridge available
    if (window.kalshiClient && typeof window.kalshiClient.closePosition === 'function') {
      try {
        const result = await window.kalshiClient.closePosition(marketId, position.quantity);
        console.log(`✅ [MOMENTUM EXIT] ${marketId} closed:`, result);
      } catch (err) {
        console.error(`❌ [MOMENTUM EXIT] ${marketId} failed to close:`, err);
      }
    }
    
    // Record exit in position tracker
    if (window.PYTHMomentumExit.exitPosition) {
      const exitResult = window.PYTHMomentumExit.exitPosition(marketId);
      console.log(`📊 [MOMENTUM EXIT] ${marketId}:`, exitResult);
    }
  }

  /**
   * Initialize momentum exit integration
   * Call this when app starts up
   */
  window.initMomentumExitIntegration = function() {
    console.log('🔄 Initializing PYTH Momentum Exit System...');
    
    if (!window.PYTHMomentumExit) {
      console.warn('⚠️ PYTHMomentumExit not loaded yet');
      return;
    }
    
    // Start the 15-second polling cycle
    if (momentumPollTimer) clearInterval(momentumPollTimer);
    
    // Run immediately first time
    window.integrateMomentumExit();
    
    // Then poll every 15 seconds
    momentumPollTimer = setInterval(() => {
      try {
        window.integrateMomentumExit();
      } catch (err) {
        console.error('Error in momentum exit integration:', err);
      }
    }, 15000);
    
    console.log('✅ PYTH Momentum Exit System initialized (polling every 15s)');
  };

  /**
   * Stop the integration
   */
  window.stopMomentumExitIntegration = function() {
    if (momentumPollTimer) {
      clearInterval(momentumPollTimer);
      momentumPollTimer = null;
      console.log('⏹️ PYTH Momentum Exit polling stopped');
    }
  };

  /**
   * Get momentum diagnostics
   */
  window.getMomentumDiagnostics = function() {
    if (!window.PYTHMomentumExit) return null;
    
    const positions = window.PYTHMomentumExit.getAllPositions?.() || {};
    const exitLog = window._momentumExitLog || [];
    
    return {
      activePositions: Object.keys(positions).length,
      positions,
      recentExits: exitLog.slice(-10),
      totalExits: exitLog.length
    };
  };

  /**
   * Render momentum exit dashboard
   */
  window.renderMomentumDashboard = function() {
    const diagnostics = window.getMomentumDiagnostics?.() || {};
    
    if (!diagnostics.positions) {
      return '<div style="color: #aaa; padding: 12px;">No active momentum positions</div>';
    }
    
    const positions = diagnostics.positions;
    let html = `
      <div style="background: #0a0a0a; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 11px;">
        <div style="color: #4caf50; font-weight: bold; margin-bottom: 8px;">🚀 MOMENTUM EXIT</div>
        <div style="font-size: 10px; color: #aaa; margin-bottom: 8px;">
          Active: ${diagnostics.activePositions} | Total Exits: ${diagnostics.totalExits}
        </div>
    `;
    
    for (const mktId in positions) {
      const pos = positions[mktId];
      const samples = pos.samples?.length || 0;
      const momentum = pos.momentum || 0;
      
      html += `
        <div style="margin: 4px 0; padding: 4px; border-left: 2px solid #666;">
          <div>${mktId}: ${pos.direction} @ ${pos.confidence}% conf</div>
          <div style="color: #aaa; font-size: 9px;">Samples: ${samples} | Momentum: ${momentum.toFixed(3)}</div>
        </div>
      `;
    }
    
    if (diagnostics.recentExits.length > 0) {
      html += `
        <div style="margin-top: 8px; border-top: 1px solid #333; padding-top: 8px;">
          <div style="color: #aaa; font-size: 10px; margin-bottom: 4px;">Recent Exits:</div>
      `;
      diagnostics.recentExits.slice(-3).forEach(exit => {
        html += `<div style="font-size: 9px; color: #4caf50;">${new Date(exit.timestamp).toLocaleTimeString()}: ${exit.marketId}</div>`;
      });
      html += `</div>`;
    }
    
    html += `</div>`;
    return html;
  };

  // Auto-initialize when page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => window.initMomentumExitIntegration?.(), 1000);
    });
  } else {
    setTimeout(() => window.initMomentumExitIntegration?.(), 500);
  }

})();
