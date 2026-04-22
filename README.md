# WE|||CRYPTO

> **Predictions dashboard for Kalshi UP/DOWN crypto binary contracts**
> Built on a subatomic orbital model — signal packets orbit each coin's nucleus, weighted by orbital profile, fused into a single EV-optimised trade intent.

![Version](https://img.shields.io/badge/version-2.1.1-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Electron](https://img.shields.io/badge/Electron-37-47848F?logo=electron)
![Kalshi](https://img.shields.io/badge/exchange-Kalshi-green)

---

## Architecture

```mermaid
flowchart TD
    subgraph feeds["📡 Market Feeds"]
        A1[Coinbase Exchange]
        A2[Binance · Kraken]
        A3[Bybit · KuCoin · MEXC]
        A4[CoinGecko]
    end

    subgraph kalshi["🏛️ Kalshi API"]
        K1[UP/DOWN 15M markets]
        K2[floor_strike · yes_pct]
        K3[liquidity · close_time]
    end

    subgraph engine["⚛️ Orbital Signal Engine"]
        B[candleCache\nOHLCV ring buffer]
        C[Technical Indicators\nRSI · EMA · VWAP · OBV · CVD]
        D[Order Book\nbid/ask imbalance]
        E[Shell Router\ncross-coin propagation]
        F[Orbital Router\nper-coin weight profiles]
        G[buildSignalModel\nscore → modelProbUp]
    end

    subgraph orchestrator["🎯 Floating Orchestrator"]
        H[EV Engine\nmodelProbUp vs kalshiYesPrice]
        I{3-Tier Decision}
        J["⭐ Tier 1 — Sweet Spot\n3–6 min · payout ≥1.65x"]
        L["🔄 Tier 2 — Crowd Fade\nlast 90s · crowd ≥80%"]
        M["🔒 Lock\n45s hold · no flip"]
        N[Trade Intent\nUP / DOWN / WAIT]
    end

    feeds -->|OHLCV candles| B
    B --> C
    B --> D
    C --> F
    D --> F
    E --> F
    F --> G
    kalshi --> G
    G --> H
    H --> I
    I --> J --> N
    I --> L --> N
    I --> M --> N
```

---

## Orbital Model

Each coin is assigned an **orbital profile** that weights signal packets before fusion. Based on atomic shell physics — stable nuclei vs reactive outer shells.

| Coin | Profile | Benchmark | Momentum | Timing | Risk Tolerance |
|------|---------|-----------|----------|--------|----------------|
| BTC  | `core`      | ×1.10 | ×0.96 | ×0.78 | Conservative |
| ETH  | `core`      | ×1.10 | ×0.96 | ×0.78 | Conservative |
| BNB  | `core`      | ×1.10 | ×0.96 | ×0.78 | Conservative |
| XRP  | `core`      | ×1.10 | ×0.96 | ×0.78 | Conservative |
| SOL  | `momentum`  | ×0.98 | ×1.08 | ×1.12 | Aggressive   |
| HYPE | `momentum`  | ×0.98 | ×1.08 | ×1.12 | Aggressive   |
| DOGE | `highBeta`  | ×0.98 | ×1.10 | ×1.02 | High-Risk    |

**Shell Router** — when one coin's shell ionises (sell threshold crossed), a signal packet propagates to correlated coins after a configured delay. Momentum coins (SOL/HYPE) amplify shell events ×1.12; core coins (BTC/ETH) absorb them quietly at ×0.78.

---

## Signal Flow

```mermaid
flowchart LR
    subgraph layers["Signal Layers"]
        L1[Benchmark\nBTC dominance · macro]
        L2[Trend\nEMA cross · price structure]
        L3[Momentum\nRSI · rate-of-change]
        L4[Microstructure\nOBV · CVD · trade flow]
        L5[Timing\nSession · volatility regime]
        L6[Derivatives\nfunding · OI]
        L7[History\nbacktest regime fit]
    end

    subgraph fusion["Orbital Fusion"]
        R[Orbital Router\nweight × profile]
        S[Score  −1 → +1]
        P[modelProbUp\nclamp 0.02–0.98]
    end

    subgraph kalshi_ev["EV Calculation"]
        KP[kalshiYesPrice]
        EV["EV = modelProbUp − kalshiYesPrice\nedgeCents = EV × 100"]
        KF[Kelly fraction\ncapped 25%]
    end

    layers --> R --> S --> P
    P --> EV
    KP --> EV
    EV --> KF
```

---

## 3-Tier Decision Engine

```mermaid
flowchart TD
    START([New contract tick]) --> CHK{edgeCents\n≥ 8c?}
    CHK -- No --> WATCH[WATCH / SKIP]
    CHK -- Yes --> LOCK{Signal\nlocked 45s?}
    LOCK -- Yes --> HOLD[🔒 HOLD previous]
    LOCK -- No --> T1{Tier 1\n3–6 min left\npayout ≥1.65x?}
    T1 -- Yes --> SWEET[⭐ PRIME ENTRY\nlog sweet-spot alert]
    T1 -- No --> T2{Tier 2\nlast 90s AND\ncrowd ≥80%?}
    T2 -- Yes --> FADE[🔄 FADE CROWD\nreverse direction]
    T2 -- No --> NORMAL[TRADE\nnormal signal]
    SWEET --> OUT([Trade Intent\nside · direction · confidence · Kelly%])
    FADE  --> OUT
    NORMAL --> OUT
```

| Tier | Trigger | Logic |
|------|---------|-------|
| 1 — Sweet Spot | 3–6 min left, payout ≥ 1.65× | Model and Kalshi aligned, good odds, time to fill |
| 2 — Crowd Fade | Last 90s, crowd ≥ 80% one side | Extreme crowd bias → fade (house pricing is wrong) |
| Lock | Signal committed | Hold 45s — prevents signal flip in final minutes |

---

## Alignment States

| State | Meaning | Action |
|-------|---------|--------|
| `ALIGNED` | Model + Kalshi agree direction | Trade if edge ≥ 8¢ |
| `DIVERGENT` | Model disagrees with Kalshi | Inversion — buy cheap side, house mispriced |
| `MODEL_LEADS` | Kalshi ~50/50, model has conviction | Trade if edge ≥ 8¢ |
| `MODEL_ONLY` | No Kalshi data | Trade on model alone |
| `KALSHI_ONLY` | Model below threshold | Watch only |
| `SHELL_EVAL` | Shell wall evaluating (3 ticks) | Hold — collecting data |

---

## Coins

`BTC · ETH · SOL · XRP · DOGE · BNB · HYPE`

All served by Kalshi 15-minute UP/DOWN binary contracts (`KXBTC15M`, `KXETH15M`, etc.).
Price feeds: Coinbase Exchange (BTC/ETH/SOL/XRP/DOGE) · CoinGecko (BNB/HYPE).

---

## API Routing

```mermaid
graph LR
    APP[Electron App]

    subgraph direct["Direct  no proxy"]
        D1[Kalshi\nelections.kalshi.com]
        D2[Coinbase Exchange]
        D3[Binance · Kraken]
    end

    subgraph proxied["Via local proxy  rate-limited"]
        P1[CoinGecko]
        P2[Bybit · OKX]
        P3[Bitfinex · KuCoin · MEXC]
    end

    APP -->|Bucket C| direct
    APP -->|throttledFetch| proxied
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| App shell | Electron 37 — portable `.exe`, no install required |
| UI renderer | Vanilla JS + Canvas (no framework) |
| Signal engine | `predictions.js` — RSI, EMA, VWAP, OBV, CVD, order book |
| Orchestrator | `floating-orchestrator.js` — EV engine, Kelly sizing |
| Market data | `prediction-markets.js` — Kalshi 15M + 5M feeds |
| Cross-coin | `shell-router.js` — orbital propagation |
| API proxy | `proxy-fetch.js` + `throttled-fetch.js` |

---

## Build

```bash
npm install
npm run build
# → dist/WECRYPTO-PATCH-2.1.1.exe   (portable, no install)
```

Kill any running instance before rebuilding — the exe locks the output file.

---

## Docs

| Doc | Contents |
|-----|---------|
| [Architecture](docs/architecture.md) | Full system component map |
| [Orbital Model](docs/orbital-model.md) | Shell physics, profiles, propagation |
| [Signal Engine](docs/signal-engine.md) | EV math, Kelly criterion, alignment states |

---

## Disclaimer

Not financial advice. These UP/DOWN calls are algorithmic signals based on market data. Binary contracts carry full risk of loss. Always size positions appropriately and never trade more than you can afford to lose.

---

## CFM Benchmarks Contract Rules

CFM BENCHMARKS
CRYPTO
Scope: These rules shall apply to this contract.
Underlying: The Underlying for this Contract is the spot price of one <cryptocurrency> in
U.S. dollars at <time>, according to a simple average of the CF <cryptocurrency> <index>
for the 60 seconds prior to <time>, after Issuance and before <date>. Revisions to the
Underlying made after Expiration will not be accounted for in determining the Expiration Value.
Source Agency: The Source Agency is CF Benchmarks.
Type: The type of Contract is an Event Contract.
Issuance: The Contract is based on the outcome of a recurrent data release. Thus, Contract
iterations will be issued on a recurring basis, and future Contract iterations will generally
correspond to the next hour, day, and year.
<price>: Kalshi may list iterations of the Contract with <price> levels that fall within an
inclusive range between 0 and 100,000,000 USD at consecutive increments of <0.01>. Due to
the potential for variability in the Underlying, the Exchange may modify <price> levels in
response to suggestions by Members.
<cryptocurrency>: <cryptocurrency> refers to a specific digital asset specified by the
Exchange. For cryptocurrencies with multiple versions the Exchange will explicitly specify the
version (or ticker).
<index>: <index> refers to a specific CF Benchmarks Index (e.g. “Bitcoin Real-Time Index”)
specified by the Exchange.
<above/below/between/exactly/at least>: <above/below/between/exactly/at least>
refers to comparative thresholds used in numerical or rank-based conditions as specified by
the Exchange. “Above X” means strictly greater than X, while “below X” means strictly less
than X. “Exactly X” means equal to X, to the number of decimal places specified, and “at least
X” means X or greater. “Between X and Y” means greater or equal to X and less than or equal
to Y.
<date>: <date> refers to a calendar date specified by the Exchange. The Exchange may list
iterations of the Contract corresponding to variations of <date>.
<time>: <time> refers to a time on a calendar date specified by Kalshi. Kalshi may list
iterations
of the Contract corresponding to different statistical periods of <time>.
Payout Criterion: The Payout Criterion for the Contract encompasses the Expiration Values
that the index is <above/below/between/exactly/at least> <price> on <date> at <time>. If
no data is available or incomplete on the Expiration Date at the Expiration Time, then affected
strikes resolve to No.
Minimum Tick: The Minimum Tick size for the Contract shall be $0.001.
Position Accountability Level: The Position Accountability Level for the Contract shall be
$25,000 per strike, per Member.
Last Trading Date: The Last Trading Date and Time of the Contract will be <time> on
<date>.
Settlement Date: The Settlement Date of the Contract shall be no later than the day after
the Expiration Date, unless the Market Outcome is under review pursuant to Rule 7.1.
Expiration Date: The latest Expiration Date of the Contract shall be one week after <date>.
If an event described in the Payout Criterion occurs, expiration will be moved to an earlier date
and time in accordance with Rule 7.2.
Expiration Time: The Expiration time of the Contract shall be 10:00 AM ET.
Settlement Value: The Settlement Value for this Contract is $1.00.
Expiration Value: The Expiration Value is the value of the Underlying as documented by the
Source Agency on the Expiration Date at the Expiration time.
Contingencies: Before Settlement, Kalshi may, at its sole discretion, initiate the Market
Outcome Review Process pursuant to Rule 6.3(d) of the Rulebook. If an Expiration Value
cannot be determined on the Expiration Date, Kalshi has the right to determine payouts
pursuant to Rule 6.3(b) in the Rulebook.
