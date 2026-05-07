# Blockchain Research Agent 🤖

Continuous cutting-edge research engine that keeps your Kalshi 15-minute contract predictor up-to-date with:
- MEV & on-chain flow analysis
- Emerging ML prediction techniques
- Kalshi settlement patterns
- Blockchain infrastructure updates
- Market microstructure dynamics

## Architecture

```
research-agent.js (core research loop)
    ↓
    ├→ on-chain-data (MEV, flow, whales)
    ├→ prediction-models (ML, transformers, ensembles)
    ├→ kalshi-contracts (patterns, liquidity)
    ├→ blockchain-infrastructure (upgrades, chain health)
    └→ market-microstructure (volatility, spreads)
    ↓
research-insights.json (shared cache)
    ↓
    ├→ prediction-engine (model improvements)
    ├→ feeds (market data augmentation)
    └→ orchestrator (Kalshi pattern detection)
```

## Files

- **`.github/research-agent-config.json`** - Configuration: topics, sources, update intervals, beta features
- **`src/agents/research-agent.js`** - Core research loop (Node.js standalone)
- **`src/agents/research-agent-init.js`** - Manager & integration hooks for app
- **`src/feeds/research-insights.json`** - Output cache (auto-generated)

## Usage

### Standalone (Node.js)
```bash
node src/agents/research-agent.js
```

### From Electron Main Process
```javascript
const ResearchAgentManager = require('./src/agents/research-agent-init');
const manager = new ResearchAgentManager();
await manager.start();
console.log(manager.getStatus());
```

### From Renderer (App.js)
```javascript
// After app init:
const manager = window._researchAgentManager;
if (manager) {
  console.log('Research insights:', window._researchMarketInsights);
  console.log('Model tuning needed:', window._predictionEngineResearchReady?.needsRetuning);
}
```

## Feeds

The agent outputs to three subsystems:

1. **Prediction Engine** (`_predictionEngineResearchReady`)
   - Emerging ML techniques
   - Model improvement suggestions
   - Retuning recommendations

2. **Market Feeds** (`_researchMarketInsights`)
   - On-chain MEV & flow
   - Volatility surface changes
   - Order book dynamics

3. **Kalshi Orchestrator** (`_kalshiOrchestrator.researchInsights`)
   - Contract pattern updates
   - Settlement rule changes
   - Liquidity insights

## Security

✅ **Environment Variables Only**
- API keys read from `process.env`
- No hardcoded credentials
- Supports: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `KALSHI_API_KEY`, `PYTH_API_KEY`

✅ **No Third-Party Integration**
- All data stays local (written to `research-insights.json`)
- No credentials shared with external agents

## Update Intervals

| Category | Frequency | Next Update |
|----------|-----------|-------------|
| on-chain-data | Realtime | Every 30s |
| prediction-models | Daily | 24h |
| kalshi-contracts | Hourly | 60m |
| blockchain-infrastructure | Hourly | 60m |
| market-microstructure | Realtime | Every 30s |

## Next Steps

1. Configure API endpoints in `.github/research-agent-config.json`
2. Implement web scraping/API calls in `research-agent.js` (currently mocked)
3. Add web_search integration for real-time research
4. Hook into main.js to start on app launch
5. Monitor output in `src/feeds/research-insights.json`

---

**Status:** Ready for integration
**Last Updated:** 2026-05-07
