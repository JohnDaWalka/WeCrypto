# Contract Cache System v2.13.2
## 2-Hour Real-Time Cache + Auto-Archive + Complete Logging

### Overview
v2.13.2 introduces a **2-hour sliding window contract cache** that captures ALL contract data in real-time:
- Predictions (every 15 minutes)
- Settlements (when contracts resolve)
- All error logs (Kalshi API errors, signal errors, system errors)
- Correlations and metrics

**Key Features:**
✅ **2-hour memory window** — keeps recent data warm, archives older data  
✅ **localStorage persistence** — survives browser refresh and app restart  
✅ **Automatic archiving** — data >2.5h old moves to archive (cleared from memory)  
✅ **Multiple backup targets** — Z:\ network drive + OneDrive + local cache  
✅ **Console API** — access cache from DevTools without code changes  
✅ **Auto-save on events** — predictions/settlements/errors recorded immediately  

---

## Architecture

### Three-Layer Storage
```
┌─────────────────────────────────────────────────────────┐
│ MEMORY (Real-Time Cache)                                │
│ ├─ predictions[] (last 500)                             │
│ ├─ settlements[] (last 500)                             │
│ ├─ errors[] (last 200)                                  │
│ ├─ candles[] (last 500)                                 │
│ ├─ orders[] (last 500)                                  │
│ └─ correlations[] (last 500)                            │
└─────────────────────────────────────────────────────────┘
                        ↓↑ auto-save
┌─────────────────────────────────────────────────────────┐
│ localStorage (Persistent Cache)                         │
│ ├─ Key: 'contract-cache-2h'                             │
│ ├─ Size: ~1-2 MB (100% of memory buffers)               │
│ └─ Survives browser restart ✅                          │
└─────────────────────────────────────────────────────────┘
                        ↓↑ export
┌─────────────────────────────────────────────────────────┐
│ Network Backup (Permanent Archive)                      │
│ ├─ Z:\WE-CRYPTO-v2.13.2-*\dist\...exe                  │
│ ├─ Z:\WE-CRYPTO-LOGS\*                                  │
│ ├─ OneDrive\WE-CRYPTO-BUILDS\v2.13.2\...exe            │
│ └─ C:\Users\user\AppData\Local\WE-CRYPTO-CACHE\...json │
└─────────────────────────────────────────────────────────┘
```

### Integration Points

#### 1. **Prediction Recording** (app.js line ~1574)
```javascript
if (window._contractCache) {
  try {
    const confidence = (p.confidence ?? 0) * 100;
    const signals = p.signal || {};
    window._contractCache.recordPrediction(coin.sym, dir, confidence, signals);
  } catch (e) {
    console.warn('[ContractCache] Prediction record error:', e.message);
  }
}
```
**Fires:** Every 15 minutes (on prediction generation)  
**Records:** Coin, direction (UP/DOWN/FLAT), confidence (0-100), signals object  
**Auto-save:** Yes, immediately after record  

#### 2. **Settlement Recording** (app.js line ~1883)
```javascript
if (window._contractCache) {
  try {
    const outcome = yesResolved ? 'UP' : 'DOWN';
    window._contractCache.recordSettlement(
      sym,
      outcome,
      kEntry.modelCorrect,
      kEntry.marketCorrect
    );
    console.log(`[ContractCache] ✓ Settlement recorded ${sym}`);
  } catch (e) {
    console.error(`[ContractCache] ✗ Settlement error ${sym}:`, e.message);
  }
}
```
**Fires:** When Kalshi contract settles (30-60 minutes after prediction)  
**Records:** Coin, outcome, model correctness, market correctness  
**Auto-save:** Yes, immediately after record  

#### 3. **Error Recording** (app.js line ~136)
```javascript
// In logContractError() function:
if (window._contractCache) {
  try {
    window._contractCache.recordError(type, `${sym}: ${data.message || ...}`, {
      sym,
      originalData: data
    });
  } catch (e) { /* non-critical */ }
}
```
**Fires:** Any contract error (missing signals, disabled indicators, API failures)  
**Records:** Error type, message, context data  
**Auto-save:** Yes, immediately after record  
**Retention:** Last 200 errors (longer window for debugging)  

---

## Console API (DevTools)

### Status & Monitoring
```javascript
// Current cache state
window.ContractCacheDebug.status()
// Returns: { predictions: 47, settlements: 12, candles: 0, orders: 0, errors: 8, accuracy: {...} }

// Portfolio accuracy (all coins)
window.ContractCacheDebug.accuracy()
// Returns: { portfolioWR: "50.2%", totalSettlements: 12, byCoins: [...] }

// Per-coin accuracy
window.ContractCacheDebug.byCoins()
// Returns: { BTC: { coin: 'BTC', total: 3, correct: 2, winRate: '66.67%' }, ... }

// Print formatted report (in console)
window.ContractCacheDebug.print()
```

### Querying Data
```javascript
// Recent predictions (last 60 minutes)
window.ContractCacheDebug.recent(60)
// Returns: { predictions: [...], settlements: [...], errors: [...] }

// Get all errors
window.ContractCacheDebug.errors()
// Returns: Array of error objects

// Errors of specific type
window.ContractCacheDebug.errors('missing-signal')
```

### Export & Backup
```javascript
// Export as JSON (copy to file)
const data = window.ContractCacheDebug.export()
// Save with: navigator.clipboard.writeText(JSON.stringify(data))

// Export as CSV (copy to file)
const csv = window.ContractCacheDebug.exportCSV()
// Save with: navigator.clipboard.writeText(csv)

// Clear cache
window.ContractCacheDebug.clear()
// Removes from localStorage
```

---

## Data Schema

### Prediction Record
```javascript
{
  id: "BTC-1714550400000",
  coin: "BTC",
  direction: "UP",          // UP | DOWN | FLAT
  confidence: 75,           // 0-100
  signals: {                // Raw signal indicators
    rsi: 62,
    macd: "positive",
    bollingerBands: "upper",
    ...
  },
  timestamp: 1714550400000  // Unix milliseconds
}
```

### Settlement Record
```javascript
{
  id: "settle-BTC-1714551000000",
  coin: "BTC",
  outcome: "UP",            // UP | DOWN
  modelCorrect: true,       // Did model match outcome?
  marketCorrect: true,      // Did market crowd match outcome?
  timestamp: 1714551000000
}
```

### Error Record
```javascript
{
  id: "error-missing-signal-1714550300000",
  type: "missing-signal",   // Categorical
  message: "BTC: h15m RSI unavailable",
  context: {
    sym: "BTC",
    originalData: { ... }
  },
  timestamp: 1714550300000,
  stack: "Error stack trace..."
}
```

---

## Workflow: Prediction → Settlement → Accuracy Calculation

### Timeline
```
t=0:00  → snapshotPredictions() runs
  └─ Generates UP/DOWN/FLAT for each coin
  └─ Records to window._contractCache.recordPrediction()
  └─ Auto-saved to localStorage

t=0:15  → Next quarter-hour cycle
  └─ Can compare prediction vs current price movement
  └─ Early signals available if price moved unexpectedly

t=0:30-1:00 → Kalshi contract settles (market15m:resolved event)
  └─ candleWS:bucketClosed fires at 1h mark
  └─ Settlement handler calls recordSettlement()
  └─ Compares prediction vs actual outcome
  └─ Calculates modelCorrect & marketCorrect
  └─ Auto-saved to localStorage

t=1:00+ → Accuracy available
  └─ window.ContractCacheDebug.accuracy() shows WR
  └─ portfolio-level and per-coin breakdown
  └─ Updated every time new settlement arrives
```

### Example: BTC Prediction Cycle
```
14:45:00 → Prediction: BTC UP (confidence 78%)
           [Recorded in cache]

15:00:00 → Settlement: BTC went UP ✓ Market crowd also said UP
           modelCorrect = true
           marketCorrect = true
           [Recorded in cache]

Later:   → window.ContractCacheDebug.byCoins()
           { BTC: { total: 1, correct: 1, winRate: "100%" } }
```

---

## Storage Locations

### Primary Backup (Z:\ Network Drive)
```
Z:\WE-CRYPTO-v2.13.2-2026-05-01-015509\
├── dist\
│   ├── WECRYPTO-v2.13.2-contract-cache-portable.exe (86.7 MB)
│   ├── WE-CRYPTO-v2.12.0-LLM-WEAPONIZED.exe
│   ├── WECRYPTO-v2.13.1-scorecard-persistence-portable.exe
│   └── ... (all versions)
└── [logs from sync]

Z:\WE-CRYPTO-LOGS\
├── error-*.log
├── info-*.log
└── ... (timestamped logs)
```

### Cloud Backup (OneDrive)
```
OneDrive\WE-CRYPTO-BUILDS\v2.13.2\
└── WECRYPTO-v2.13.2-contract-cache-portable.exe
```

### Local Cache (Auto-Populated When App Runs)
```
C:\Users\user\AppData\Local\WE-CRYPTO-CACHE\
├── contract-cache-2h.json  (localStorage export, ~1-2 MB)
├── backup-policy.json      (archival config)
└── contracts.json          (will be written by app)
```

---

## Tuning & Configuration

### In ContractCacheManager Constructor
```javascript
const cache = new ContractCacheManager({
  maxAgeMs: 2 * 60 * 60 * 1000,           // 2 hours (default)
  archiveThresholdMs: 2.5 * 60 * 60 * 1000 // Auto-archive at 2.5h
});
```

### Auto-Trim Behavior
```javascript
// Predictions & settlements: Keep last 500, trim older
_trim('predictions', 500)

// Errors: Keep last 200 (longer window for debugging)
_trim('errors', 200)

// Candles & orders: Keep last 500
_trim('candles', 500)
_trim('orders', 500)
```

### localStorage Quota Handling
```javascript
// If localStorage full (~5-10 MB quota):
// 1. Try to save normally
// 2. On QuotaExceededError:
//    - Trim 25% oldest data from all buffers
//    - Retry save
//    - Log warning if still fails

// This prevents app crash from storage overflow
```

---

## Monitoring Checklist

### On App Startup
- [ ] `[ContractCache] Initialized with 2-hour sliding window` appears in console
- [ ] `[ContractCache] Restored X predictions, Y settlements from storage` (if resuming)
- [ ] No errors loading localStorage

### During Predictions (every 15m)
- [ ] `[ContractCache] ✓ Prediction recorded BTC` (or each coin)
- [ ] Confidence is 0-100 (not 0-1)
- [ ] Signals object contains expected indicators

### During Settlements (30-60m after prediction)
- [ ] `[ContractCache] ✓ Settlement recorded BTC`
- [ ] `[Settlement] Recording: BTC → UP/DOWN`
- [ ] modelCorrect and marketCorrect are boolean
- [ ] Timestamp matches contract resolution time

### On Errors
- [ ] `[KalshiError]` messages appear for contract issues
- [ ] `[ContractCache]` error records should appear
- [ ] Error count in `window.ContractCacheDebug.status()` increases

### Every Hour
- [ ] Run `window.ContractCacheDebug.print()` to see summary
- [ ] Verify predictions > settlements (predictions come in, settlements lag)
- [ ] Accuracy calculation is correct (correct / total)

---

## Troubleshooting

### Q: "No settled data yet" — what should I see?
**A:** After 30+ minutes:
```javascript
window.ContractCacheDebug.status()
// Should show:
{
  predictions: 4,      // 4 coins × 15m cycles
  settlements: 1,      // After first contract resolves
  accuracy: { portfolioWR: "50%", ... }
}
```

### Q: Data lost after app restart?
**A:** Check localStorage:
```javascript
localStorage.getItem('contract-cache-2h')?.length
// Should be > 100 chars (not null)
```
If null, cache wasn't persisted. Check for:
- localStorage disabled in browser
- QuotaExceededError (clear browser cache)
- Permissions issue

### Q: Predictions recorded but no settlements?
**A:** Settlements take 30-60 minutes. Check:
```javascript
// Are Kalshi contracts active?
window.KalshiDebug.pending()  // Should show open contracts

// Is the settlement handler firing?
// Check browser console for: [Settlement] Recording: ...
```

### Q: High error count?
**A:** Check types:
```javascript
const errors = window.ContractCacheDebug.errors()
// Group by type
errors.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] || 0) + 1;
  return acc;
}, {})
```
Common errors:
- `missing-signal` → Indicator not available for that coin/timeframe
- `kalshi-api-error` → Kalshi REST API failure
- `disabled-indicator` → Signal intentionally gated off

---

## Performance Impact

### Memory Usage
- 500 predictions @ ~200 bytes = 100 KB
- 500 settlements @ ~150 bytes = 75 KB
- 200 errors @ ~300 bytes = 60 KB
- **Total: ~250 KB memory overhead**

### Storage Usage
- localStorage: ~1-2 MB (auto-trims at 5-10 MB quota)
- Disk backup: ~100 MB (includes all .exe files)

### CPU Impact
- Recording: <1 ms per event (minimal)
- Auto-archive: Every 5 minutes, <10 ms
- Save to localStorage: <50 ms (batched after events)

---

## Data Retention Policy

### In-Memory Buffers (Active)
- Predictions: Last 500 (2-4 hours at 15m cadence)
- Settlements: Last 500 (8+ hours at variable cadence)
- Errors: Last 200 (24+ hours at variable cadence)

### localStorage (Persistent)
- Full copy of in-memory buffers
- Age filter: Entries >2 hours old removed on load
- Auto-trim: 25% oldest data if quota exceeded

### Network Archive (Permanent)
- Z:\WE-CRYPTO-v2.13.2-*\ → Full app backup, exe + logs
- OneDrive\WE-CRYPTO-BUILDS\ → .exe files only
- Z:\WE-CRYPTO-LOGS\ → Timestamped log files

---

## Version History

### v2.13.2 (New)
✅ Contract cache with 2-hour sliding window  
✅ localStorage persistence across restarts  
✅ Automatic archiving of >2.5h old data  
✅ Complete error logging integration  
✅ Console API (ContractCacheDebug)  
✅ Backup to Z: + OneDrive + local cache  

### v2.13.1
- Scorecard persistence fix
- localStorage caching added

### v2.13.0
- Scorecard integration
- 4 recording paths wired (predictions, settlements, errors, backtests)

---

## Next Steps

1. **Deploy v2.13.2** to staging/production
2. **Run for 24-48 hours** to populate cache with settlement data
3. **Monitor accuracy** — compare cache accuracy vs real trading outcomes
4. **Export historical data** — use CSV export to correlate with Pyth/Kalshi official records
5. **Archive to long-term storage** — periodically backup Z:\ to external drive

---

## Console Quick Reference

```javascript
// Status
window.ContractCacheDebug.status()          // Current cache state
window.ContractCacheDebug.accuracy()        // Portfolio & per-coin accuracy
window.ContractCacheDebug.print()           // Formatted table

// Recent data
window.ContractCacheDebug.recent(60)        // Last 60 minutes
window.ContractCacheDebug.errors()          // All recent errors
window.ContractCacheDebug.byCoins()         // Per-coin stats

// Export
window.ContractCacheDebug.export()          // JSON export
window.ContractCacheDebug.exportCSV()       // CSV export

// Maintenance
window.ContractCacheDebug.clear()           // Clear localStorage
```

---

**Last Updated:** 2026-05-01  
**Built:** v2.13.2-contract-cache  
**Backup:** Z:\WE-CRYPTO-v2.13.2-*, OneDrive\WE-CRYPTO-BUILDS\v2.13.2
