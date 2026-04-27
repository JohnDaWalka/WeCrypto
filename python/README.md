# WE-CFM-Orchestrator — Python Analytics Layer

This directory contains a standalone Python analytics layer that mirrors the
JavaScript CFM engine for research, backtesting, and live signal evaluation.
It has **no effect** on the Electron `.exe` build.

---

## Setup

```bash
cd python
pip install -r requirements.txt
```

---

## Credential File

Create `KALSHI-API-KEY.txt` in the **repository root** (not inside `python/`):

```
<your-api-key-uuid>          ← line 0: API Key ID
(blank lines)
-----BEGIN PRIVATE KEY-----  ← line 4+: RSA private key in PEM format
...
-----END PRIVATE KEY-----
```

This is the same format used by the JavaScript Kalshi client.

---

## Scripts

### `kalshi_api.py` — Kalshi REST client

```python
from kalshi_api import client_from_key_file

client = client_from_key_file()           # reads ../KALSHI-API-KEY.txt
print(client.get_balance())
print(client.get_markets("KXBTCD"))
```

### `cfm_analysis.py` — CFM signal analysis

```python
from cfm_analysis import CFMAnalyzer

prices = [100, 102, 101, 105, 108, 107, 110]
mom = CFMAnalyzer.compute_momentum(prices, window=5)
print("momentum:", mom)

coin = {"volume": 5_000_000, "momentum": mom, "spread": 0.005}
score = CFMAnalyzer.compute_cfm_score(coin)
print("cfm_score:", score)
print("direction:", CFMAnalyzer.predict_direction(score))
```

### `backtest_runner.py` — Historical backtest

Run from the command line:

```bash
python backtest_runner.py --file candles.csv --window 14
```

The CSV must contain columns: `timestamp, open, high, low, close, volume`.

### `signal_evaluator.py` — Live signal loop

```bash
python signal_evaluator.py
```

Polls Kalshi every 60 seconds and prints color-coded UP/DOWN/NEUTRAL signals
for all markets in the `KXBTCD` series. Requires a valid `KALSHI-API-KEY.txt`.

---

## Notes

- This Python layer is **analytics-only**. It does not start a server, write
  to files used by the Electron app, or interfere with `npm run build`.
- All scripts can be run independently from the `python/` directory.
