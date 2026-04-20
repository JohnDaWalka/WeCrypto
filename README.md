# WE|||CRYPTO

**Predictions dashboard for Kalshi UP/DOWN crypto binary contracts.**

Built on a subatomic orbital model — each coin maps to a periodic table element, layering benchmark, microstructure, and conviction signals to issue short-horizon UP/DOWN calls.

## Coins Covered
BTC · ETH · SOL · XRP · DOGE · BNB · HYPE

## Signal System
| Tier | Window | Condition | Action |
|------|--------|-----------|--------|
| 1 — Sweet Spot | 3–6 min left | Payout ≥ 1.65x + model aligned | ⭐ Prime entry |
| 2 — Crowd Fade | Last 90s | Kalshi crowd ≥ 80% one side | 🔄 Fade the crowd |
| Lock | Any | Trade committed | 🔒 Hold 45s — no flip |

## Stack
- **Electron 37** portable `.exe` (Windows)
- **Kalshi API** — crypto UP/DOWN contract data
- **Multi-exchange feeds** — Coinbase, Binance, Kraken, Bybit, KuCoin, Bitfinex, CDC, MEXC
- **CoinGecko** — price + market data for HYPE/BNB
- Prediction engine: RSI · VWAP · EMA · OBV · order book imbalance · CVD · trade flow

## Build
```bash
npm install
npm run build
# → dist/WECRYPTO-PATCH-2.1.1.exe
```

## Disclaimer
Not financial advice. These UP/DOWN calls are algorithmic signals. Always manage risk.
