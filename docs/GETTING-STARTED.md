# 🚀 Getting Started

This guide walks you through installing, configuring, and running WE-CRYPTO for the first time.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18 LTS or later | [nodejs.org](https://nodejs.org/) |
| npm | 9+ | Bundled with Node.js |
| Windows | 10 / 11 x64 | Electron targets Win x64 |
| Kalshi API key | — | [kalshi.com](https://kalshi.com/) (optional for preview) |

---

## 1. Clone & Install

```bash
git clone https://github.com/JohnDaWalka/WE-CFM-Orchestrator.git
cd WE-CFM-Orchestrator
npm install
```

Installation installs Electron, electron-builder, and all runtime dependencies.

---

## 2. Configure Kalshi Credentials (optional)

Create a file named `KALSHI-API-KEY.txt` in the project root:

```
<your-api-key-id-uuid>

<empty line>

<empty line>

-----BEGIN RSA PRIVATE KEY-----
<your-rsa-private-key>
-----END RSA PRIVATE KEY-----
```

> **Without credentials** the app still runs in preview mode — predictions and the dashboard work, but Kalshi order placement is disabled.

---

## 3. Start the App

```bash
npm start
```

The Electron window opens, the Rust proxy starts on port 3010, and (if credentials exist) the Kalshi worker starts on port 3050.

**Expected console output on successful startup:**

```
[Startup] Restoring adaptive weights...  ✓ (<50ms)
[Startup] Loading contract cache...      ✓ (<100ms)
[Kalshi Worker] Listening on http://127.0.0.1:3050
[Predictions] First cycle complete
```

---

## 4. First Run Checklist

- [ ] App window opens without errors
- [ ] Dashboard shows prediction cards for BTC, ETH, SOL, XRP
- [ ] Accuracy scorecard populates within 30 s (first polling cycle)
- [ ] (Optional) Open DevTools (F12) and run `window.Kalshi.getBalance()` to verify Kalshi connectivity

---

## 5. Build a Portable Executable

```bash
npm run build:portable
```

Output: `dist/WE-CRYPTO-Kalshi-15m-v*.exe`  
Build time: approximately 2–3 minutes.

> **Important:** Close any running instance of the app before building or the output file may be locked.

---

## Troubleshooting First Run

| Symptom | Fix |
|---|---|
| Blank prediction cards | Wait 30–60 s for the first polling cycle |
| `KALSHI-API-KEY.txt not found` | Credentials file missing — app runs in preview mode |
| Port 3010 in use | Another process is using the port; close it or restart |
| `electron: command not found` | Run `npm install` again |

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for a full reference.

---

## Next Steps

- [Dashboard Guide](./DASHBOARD.md) — understand every panel
- [Configuration](./CONFIGURATION.md) — tune thresholds and environment variables
- [Architecture](./ARCHITECTURE.md) — understand how the system works
