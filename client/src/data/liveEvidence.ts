/*
 * Swiss editorial forensic style: treat live evidence as exhibits, not as a full ledger.
 * The purpose of this module is to keep screenshot claims explicit, bounded, and readable.
 */
export const liveEvidence = {
  framing: {
    title: "Live futures-prediction exhibits",
    summary:
      "The user supplied screenshots that appear to show real target-price prediction contracts and payout activity. These exhibits materially strengthen the claim that the system is being used for live futures-direction prediction outcomes, but they remain screenshot-based evidence rather than a complete exportable trade ledger.",
    boundary:
      "The site should present these exhibits as corroborating live proof while keeping a clear distinction between screenshot evidence, backtest evidence, predictive hit rate, and a full independently auditable contract record.",
  },
  claims: [
    {
      label: "Observed live payout card",
      detail:
        "A BTC 15-minute target contract is shown with an original cost of $179.17 and a payout of $233.94, presented as an UP prediction that paid out.",
      imageSrc: "/manus-storage/IMG_0670_465fd358.png",
      imageAlt: "Kalshi payout card showing a BTC 15-minute target contract with original cost and paid out values.",
    },
    {
      label: "Transaction history exhibit A",
      detail:
        "A transaction list shows multiple target-price prediction entries across assets including ETH, SOL, BTC, and XRP with both bought and payout rows visible.",
      imageSrc: "/manus-storage/IMG_1870_33f1691a.jpeg",
      imageAlt: "Mobile transaction history screenshot showing multiple bought, sold, and payout entries across assets.",
    },
    {
      label: "Transaction history exhibit B",
      detail:
        "A second transaction list shows additional same-day activity with repeated target-price prediction contracts and positive payouts across multiple assets.",
      imageSrc: "/manus-storage/IMG_1869_37d9f1e2.jpeg",
      imageAlt: "Second mobile transaction history screenshot showing same-day bought and payout entries across assets.",
    },
  ],
  interpretation: [
    "These exhibits support the claim that the system has been used in live futures-prediction contract contexts.",
    "These exhibits do not, by themselves, establish a complete win rate, sample size, or audited P&L history for every contract taken.",
    "The website should therefore compare the attached backtest evidence against the live exhibits instead of flattening both into one undifferentiated claim.",
  ],
} as const;
