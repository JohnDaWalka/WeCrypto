# v2.13.2 Deployment & Testing Guide

## What Changed?

### New Components
1. **ContractCacheManager** (`src/core/contract-cache-manager.js`)
   - Records predictions, settlements, errors, candles, orders, correlations
   - 2-hour sliding window + localStorage persistence
   - Auto-saves after every event
   - Console API: `window.ContractCacheDebug`

2. **Enhanced app.js**
   - Initialization: Cache setup at line 88-97 (after restore)
   - Prediction recording: Line 1574-1586 (snapshotPredictions)
   - Settlement recording: Line 1883-1901 (market15m:resolved)
   - Error recording: Line 136 (logContractError)

3. **Updated index.html**
   - Added script tag for contract-cache-manager.js (line 218)

### Backward Compatibility
✅ **100% compatible** — all changes are additive
- Existing scorecard aggregator still works
- All previous console APIs intact (KalshiDebug, etc.)
- No breaking changes to app.js logic

---

## Deployment Steps

### 1. Replace Executable
```powershell
# Backup old version
Copy-Item "C:\Program Files\WE-CRYPTO\*.exe" "Z:\WE-CRYPTO-BACKUP-$(date +%s)"

# Deploy v2.13.2
Copy-Item "F:\WECRYP\dist\WECRYPTO-v2.13.2-contract-cache-portable.exe" "C:\Program Files\WE-CRYPTO\"

# Verify
"C:\Program Files\WE-CRYPTO\WECRYPTO-v2.13.2-contract-cache-portable.exe" --version
```

### 2. Clean Start (Recommended)
```
1. Close the app completely
2. Delete browser cache/localStorage (or use new profile)
3. Delete C:\Users\user\AppData\Local\WE-CRYPTO-CACHE\ (if exists)
4. Start v2.13.2
5. Wait for first prediction cycle (15 minutes)
```

### 3. Verify Initialization
Look for in browser console (F12):
```
[ContractCache] Initialized with 2-hour sliding window
[ContractCacheDebug] API ready — ContractCacheDebug.status() .accuracy() .byCoins() .recent(minutes)
```

---

## Testing Workflow

### Phase 1: Verify Cache Initialization (Minutes 0-5)
```javascript
// In DevTools console:
window.ContractCacheDebug.status()

// Expected output (empty cache):
{
  predictions: 0,
  settlements: 0,
  candles: 0,
  orders: 0,
  errors: 0,
  accuracy: null,
  oldestData: null,
  newestData: null,
  archiveCycles: 0
}

// Should see console logs:
// [ContractCache] Initialized with 2-hour sliding window
```

### Phase 2: Verify Prediction Recording (Minutes 15-25)
```javascript
// After first prediction cycle:
window.ContractCacheDebug.status()

// Expected output (4 coins):
{
  predictions: 4,        // BTC, ETH, SOL, DOGE (or your coin set)
  settlements: 0,        // No settlements yet
  accuracy: null,        // Need ≥1 settlement for accuracy
  oldestData: "2026-05-01T02:15:00.000Z",
  newestData: "2026-05-01T02:15:00.000Z"
}

// Should see console logs:
// [ContractCache] ✓ Prediction recorded BTC
// [ContractCache] ✓ Prediction recorded ETH
// ... etc
```

**Verify prediction data:**
```javascript
window.ContractCacheDebug.recent(60).predictions
// [
//   { id: "BTC-1714...", coin: "BTC", direction: "UP", confidence: 75, ... },
//   { id: "ETH-1714...", coin: "ETH", direction: "DOWN", confidence: 62, ... },
//   ...
// ]
```

### Phase 3: Monitor for Settlements (Minutes 30-90)
```javascript
// Keep checking every 15 minutes:
window.ContractCacheDebug.status().settlements
// 0 → 0 → ... → 1 (when first contract settles)

// Once settlement appears:
window.ContractCacheDebug.byCoins()
// {
//   BTC: { 
//     coin: "BTC",
//     total: 1,
//     correct: 1,
//     winRate: "100%",  // or "0%" if wrong
//     dataAge: 120000   // milliseconds since settlement
//   },
//   ...
// }
```

### Phase 4: Verify Accuracy Calculation (After 2+ Settlements)
```javascript
window.ContractCacheDebug.accuracy()

// Expected output:
{
  portfolioWR: "50.5%",          // Overall win rate
  totalSettlements: 2,            // 2 contracts resolved
  byCoins: [
    { coin: "BTC", total: 1, correct: 1, winRate: "100%" },
    { coin: "ETH", total: 1, correct: 0, winRate: "0%" }
  ]
}
```

### Phase 5: Verify localStorage Persistence (After 30+ Minutes)
```javascript
// Check raw localStorage size:
localStorage.getItem('contract-cache-2h')?.length
// Should be >1000 (not null, not empty)

// Simulate app restart by refreshing browser (F5):
window.location.reload()

// After reload, verify data was restored:
window.ContractCacheDebug.status()
// Same count as before refresh
// Console should show:
// [ContractCache] Restored X predictions, Y settlements from storage
```

### Phase 6: Verify Error Recording (Watch for Errors)
```javascript
// If any signals missing or API fails:
window.ContractCacheDebug.errors()
// [
//   { 
//     type: "missing-signal",
//     message: "BTC: h15m RSI unavailable",
//     timestamp: 1714...,
//     ...
//   },
//   ...
// ]

// Count errors by type:
const errors = window.ContractCacheDebug.errors()
errors.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] || 0) + 1
  return acc
}, {})
```

---

## Success Criteria (✅ All Should Pass)

### Performance
- [ ] No console errors on startup
- [ ] No performance impact (<1ms per prediction/settlement)
- [ ] App responsive during cache operations
- [ ] localStorage saves complete <50ms

### Data Integrity
- [ ] Predictions recorded within seconds of generation
- [ ] Settlements recorded within 1 second of contract resolution
- [ ] Error counts increase when issues occur
- [ ] Timestamps are monotonically increasing

### Persistence
- [ ] Cache survives browser refresh (F5)
- [ ] Cache survives app restart (close + reopen)
- [ ] No data loss after 1+ hours of operation
- [ ] localStorage doesn't exceed quota (stays <5 MB)

### Accuracy
- [ ] Portfolio WR calculated correctly (correct / total)
- [ ] Per-coin WR matches manual count
- [ ] modelCorrect and marketCorrect are accurate
- [ ] Confidence values are 0-100 (not 0-1)

### Backup
- [ ] Z:\ has current exe and logs
- [ ] OneDrive has current exe
- [ ] Local cache dir exists: `C:\Users\user\AppData\Local\WE-CRYPTO-CACHE\`

---

## Monitoring During Live Trading

### Every 15 Minutes
```javascript
window.ContractCacheDebug.print()
// Should show increasing prediction count
```

### Every Hour
```javascript
window.ContractCacheDebug.status()
// Verify predictions accumulating
// Verify accuracy hasn't dropped unexpectedly
```

### After First Settlement (30-60 min)
```javascript
window.ContractCacheDebug.accuracy()
// Verify WR is reasonable (30-70%, not 0% or 100%)
// Check if matches scorecard aggregator
```

### Daily
```javascript
// Export historical data
const json = window.ContractCacheDebug.export()
// Save to file for long-term analysis

// Check backup status
// Z:\WE-CRYPTO-LOGS\ should have updated logs
```

---

## Troubleshooting

### Issue: "No predictions recorded after 20 minutes"
**Check:**
```javascript
window.ContractCacheDebug.status().predictions
// Should be > 0 after 15 min

// If 0, check:
1. Are predictions being generated? window._predictions
2. Is snapshotPredictions() running? (check console logs)
3. Is cache initialized? window._contractCache (should be object)
4. Any errors? window.ContractCacheDebug.errors()
```

### Issue: "Settlements not appearing after 1 hour"
**Check:**
```javascript
// Are Kalshi contracts active?
window.KalshiDebug.pending()

// Are settlements firing?
// Look for: [Settlement] Recording: BTC → UP/DOWN

// If missing, check:
1. market15m:resolved event is firing
2. window._aggregator is available
3. Check [Settlement] error messages in console
```

### Issue: "localStorage full" warning
**Fix:**
```javascript
// Clear old data:
window.ContractCacheDebug.clear()

// Or in browser settings:
// Settings → Privacy & Security → Clear browsing data → Cookies, Cache
```

### Issue: "After app restart, predictions lost"
**Check:**
```javascript
// Was localStorage saved before restart?
localStorage.getItem('contract-cache-2h')?.length
// Should be > 100

// If null, something prevented save:
1. Check for QuotaExceededError logs
2. Check if localStorage disabled in browser
3. Check privacy mode (disables localStorage)
```

---

## Rollback Plan (If Issues Occur)

### Quick Rollback to v2.13.1
```powershell
# Replace exe
Copy-Item "F:\WECRYP\dist\WECRYPTO-v2.13.1-scorecard-persistence-portable.exe" `
          "C:\Program Files\WE-CRYPTO\"

# Clear cache (optional)
rm "C:\Users\user\AppData\Local\WE-CRYPTO-CACHE\*"

# Restart app
```

### Root Cause Analysis
1. Check `window.ContractCacheDebug.errors()` for crash reasons
2. Check browser console for JavaScript errors
3. Check F12 → Network for failed requests
4. Check F12 → Storage → localStorage for corruption

---

## Performance Baseline

### Expected Resource Usage

**Memory:**
- Cache objects: ~250 KB (predictions, settlements, errors)
- localStorage string: ~1-2 MB

**CPU:**
- Recording prediction: <1 ms
- Recording settlement: <1 ms
- Auto-archive (5m cycle): <10 ms
- Save to localStorage: <50 ms

**Disk I/O:**
- localStorage saves: Periodic, <100 ms each
- Network backup: Manual, ~100-200 MB transfer

**Network:**
- No new external calls
- Only IPC to Node.js for backup (future)

---

## Version Check

```javascript
// Verify v2.13.2 is running:
const version = window.location.href.includes('app.js')
  ? 'v2.13.x'
  : 'unknown'

// Check app title
document.title  // Should include version in window title (if displayed)

// Check build artifacts
window._buildInfo || 'Check package.json'
```

---

## Questions?

1. **Cache not initialized?** → Check that contract-cache-manager.js loaded
2. **Predictions not recording?** → Verify snapshotPredictions() runs
3. **Settlements missing?** → Check Kalshi contracts are active
4. **Performance slow?** → Check localStorage size
5. **Data lost?** → Verify localStorage wasn't cleared

**Debug command (copy-paste into console):**
```javascript
console.table({
  CacheInitialized: !!window._contractCache,
  PredictionsRecorded: window._contractCache?.predictions?.length || 0,
  SettlementsRecorded: window._contractCache?.settlements?.length || 0,
  ErrorsLogged: window._contractCache?.errors?.length || 0,
  StorageSize: localStorage.getItem('contract-cache-2h')?.length || 'empty',
  PortfolioWR: window._contractCache?.getAllAccuracy?.()?.portfolioWR || 'N/A'
})
```

---

**Version:** v2.13.2-contract-cache  
**Build Date:** 2026-05-01  
**Backup Location:** Z:\WE-CRYPTO-v2.13.2-*  
**Status:** ✅ Ready for staging deployment
