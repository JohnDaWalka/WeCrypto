# WeCrypto Kalshi Prediction Markets Audit Site

This repository contains a React + Vite site that presents an evidence-first audit of a futures-direction / target-price prediction workflow associated with Kalshi-style prediction contracts.

The site is designed to separate:

- **Raw observations** (total sampled market observations)
- **Filtered actionable signals** (entries that pass model thresholds)
- **Directional hit rate** (UP/DOWN prediction correctness)
- **Live screenshot exhibits** (proof of real contract activity, but not a full ledger export)

---

## What this project does

The app renders a forensic-style report focused on a narrow question:

> Do filtered predictions clear a realistic contract viability hurdle (modeled as a break-even hit-rate threshold)?

Current report configuration (from `client/src/data/reportData.ts`):

- Break-even hurdle: **54%**
- Lookback window: **7 days**
- Candles per coin: **1000**
- Total observations analyzed: **26,495**
- Active signals: **5,172**
- Overall directional hit rate: **33.49%**

---

## Key concepts used in the report

- **Selection ratio**: Percentage of observations that become active signals
- **Directional hit rate**: Percentage of active predictions that match later direction
- **Clearance vs 54%**: Hit rate minus the modeled contract hurdle
- **Confidence/session distributions**: Weighted behavior across confidence buckets and sessions

---

## Evidence model and boundaries

Data is intentionally split into two sources:

1. **Backtest-derived report data** (`client/src/data/reportData.ts`)
2. **Live screenshot exhibits** (`client/src/data/liveEvidence.ts`)

This keeps interpretation honest:

- Screenshots strengthen the claim that live contracts were taken
- Screenshots **do not** replace a full audited trade ledger
- Backtest stats and live exhibits are shown together, but not conflated

---

## Tech stack

- **Frontend**: React 19, TypeScript, Vite 7
- **UI/Charts**: Tailwind CSS 4, Radix UI, Recharts, Lucide icons
- **Routing**: Wouter
- **Server build target**: Express (bundled via esbuild for production)
- **Package manager**: pnpm

---

## Project structure

```text
client/
  src/
    data/
      reportData.ts       # Backtest-derived audit dataset shown in UI
      liveEvidence.ts     # Screenshot-based live evidence claims
    pages/
      Home.tsx            # Main audit report page
scripts/
  build-report-data.mjs   # Script to transform raw backtest JSON -> reportData.ts
server/
  index.ts                # Production server entry
```

---

## Local development

### 1) Install dependencies

```bash
corepack enable
corepack prepare pnpm@10.4.1 --activate
pnpm install --frozen-lockfile
```

### 2) Run development server

```bash
pnpm run dev
```

### 3) Type-check

```bash
pnpm run check
```

### 4) Production build

```bash
pnpm run build
```

### 5) Run production bundle

```bash
pnpm run start
```

---

## Updating the report dataset

The transformation script is:

`scripts/build-report-data.mjs`

It reads a backtest JSON report and writes the processed output to:

- `client/src/data/reportData.ts`

Important notes:

- The script currently uses hardcoded input/output paths and a fixed break-even rate (`54`)
- If you run it in a different environment, update those paths first
- Keep the resulting TypeScript export shape stable so UI components continue to render correctly

---

## Analytics environment variables

`client/index.html` references:

- `VITE_ANALYTICS_ENDPOINT`
- `VITE_ANALYTICS_WEBSITE_ID`

Set these in your environment for production analytics integration.

---

## Disclaimer

This repository is an audit/reporting interface for prediction-market analysis and evidence presentation. It is **not** financial advice, trading advice, or a guarantee of future performance.
