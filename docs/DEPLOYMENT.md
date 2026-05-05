# 🚢 Deployment Guide

How to build and deploy WE-CRYPTO for production use.

---

## Overview

WE-CRYPTO ships as a self-contained Windows portable executable. No installation required on the target machine — just copy and run.

---

## Build Requirements

| Tool | Version |
|------|---------|
| Node.js | 18+ (20 LTS recommended) |
| npm / pnpm | 8+ |
| electron-builder | Bundled via devDependencies |
| Windows | 10/11 (for building .exe targets) |

---

## Build Commands

```bash
# Install dependencies first
npm install

# Portable single-file executable (recommended)
npm run build:portable

# Windows installer (NSIS)
npm run build:installer

# Both targets
npm run build
```

### Output Location

```
dist/
  WECRYPTO-v2.x.x-portable.exe    ← portable app (no install needed)
  WECRYPTO-Setup-v2.x.x.exe       ← installer (optional)
  win-unpacked/                    ← unpacked app (for debugging)
    resources/
      app.asar
      app.asar.unpacked/
        we-crypto-proxy.exe        ← local proxy server (bundled)
```

> ⚠️ **Important:** Close any running WECRYPTO process before building, or output files in `dist/` may be locked.

> ⚠️ **Do not overwrite previous builds.** Preserve build history in `dist/` for rollback capability. Rename or archive old executables rather than deleting them.

---

## Pre-Deployment Checklist

- [ ] `.env` configured with valid API keys
- [ ] All running WECRYPTO instances closed
- [ ] `npm install` completed successfully
- [ ] No TypeScript/build errors
- [ ] `we-crypto-proxy.exe` present in build output
- [ ] Kalshi credentials valid (test with `node tests/test-api-status.js`)
- [ ] Port 3010 available on target machine

---

## Deployment Steps

### 1. Build the Executable

```bash
npm run build:portable
```

### 2. Verify the Build

```bash
# Check build output
ls dist/
# Should show: WECRYPTO-v2.x.x-portable.exe

# Run smoke test
node tests/test-api-status.js
```

### 3. Deploy to Target

Copy `dist/WECRYPTO-v2.x.x-portable.exe` to the target machine. No installer needed.

### 4. Configure on Target

Ensure `we-crypto-proxy.exe` is accessible (it is bundled inside the `.exe`). On first launch, the proxy will start automatically on port 3010.

---

## Port Usage

| Port | Service | Description |
|------|---------|-------------|
| 3010 | Rust Proxy | Local API proxy (cascade: 3010 → 3011 → ...) |
| 3050 | Kalshi Worker | Node.js Kalshi bridge (HTTP) |
| 3443 | Web Mirror | Optional web service |

Ensure these ports are available and not blocked by firewall rules.

---

## Monitoring After Deployment

```js
// In DevTools console — check all systems are live
window.checkFeeds?.()

// Verify Kalshi data is flowing
window.PredictionMarkets?.getCoin?.('BTC')

// Confirm predictions are updating
window._predictions?.BTC
```

---

## Rolling Back

To roll back to a previous version:

1. Close the current WECRYPTO process
2. Launch the previous `WECRYPTO-v2.x.x-portable.exe` from `dist/`
3. Stored weights and scorecard in `localStorage` are version-compatible

To fully reset learning state:

```js
// In DevTools console
Object.keys(localStorage)
  .filter(k => k.startsWith('beta1_'))
  .forEach(k => localStorage.removeItem(k))
location.reload()
```

---

## Environment Variables

See [CONFIGURATION.md](./CONFIGURATION.md) for all `.env` variables.

---

**Last Updated:** 2026-05-01 | **Version:** 2.11.0+
