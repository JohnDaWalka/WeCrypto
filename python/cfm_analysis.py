"""
CFM signal analysis utilities.

Provides momentum computation, composite CFM scoring, coin ranking,
and directional prediction helpers.
"""

from __future__ import annotations

import math
from typing import Any


class CFMAnalyzer:
    """Collection of CFM signal analysis methods."""

    # ------------------------------------------------------------------
    # Momentum
    # ------------------------------------------------------------------

    @staticmethod
    def compute_momentum(prices: list[float], window: int = 14) -> float:
        """
        Compute RSI-style momentum from a price series.

        Args:
            prices: Ordered list of closing prices (oldest first).
            window: Lookback window (default 14).

        Returns:
            Momentum value in [0.0, 1.0] (0 = fully oversold, 1 = fully overbought).
            Returns 0.5 if the price series is too short or has no movement.
        """
        if len(prices) < window + 1:
            return 0.5

        deltas = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
        recent = deltas[-window:]

        gains = [d for d in recent if d > 0]
        losses = [-d for d in recent if d < 0]

        avg_gain = sum(gains) / window
        avg_loss = sum(losses) / window

        if avg_loss == 0:
            return 1.0 if avg_gain > 0 else 0.5

        rs = avg_gain / avg_loss
        rsi = 1.0 - (1.0 / (1.0 + rs))
        return round(rsi, 6)

    # ------------------------------------------------------------------
    # Composite CFM score
    # ------------------------------------------------------------------

    @staticmethod
    def compute_cfm_score(coin_data: dict[str, Any]) -> float:
        """
        Compute a weighted composite CFM score for a single coin.

        Expected keys in coin_data:
            volume (float)    — 24h traded volume in USD
            momentum (float)  — value in [0, 1] (e.g. from compute_momentum)
            spread (float)    — bid/ask spread as a fraction (0.01 = 1%)

        Returns:
            A score in [0.0, 1.0] where higher is better.
        """
        volume = float(coin_data.get("volume", 0))
        momentum = float(coin_data.get("momentum", 0.5))
        spread = float(coin_data.get("spread", 0.01))

        # Normalise volume with a soft log cap (1B USD ≈ score 1.0)
        volume_score = min(math.log1p(volume) / math.log1p(1e9), 1.0)

        # Spread penalty: tighter spread → higher score
        spread_score = max(0.0, 1.0 - spread * 100)

        # Weighted average: volume 40%, momentum 40%, spread 20%
        score = 0.40 * volume_score + 0.40 * momentum + 0.20 * spread_score
        return round(score, 6)

    # ------------------------------------------------------------------
    # Ranking
    # ------------------------------------------------------------------

    @staticmethod
    def rank_coins(coin_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Sort a list of coin data dicts by CFM score descending.

        Each dict should contain the keys expected by compute_cfm_score.
        A 'cfm_score' key is added to each dict.

        Returns:
            The same list sorted by cfm_score descending (highest first).
        """
        for coin in coin_list:
            coin["cfm_score"] = CFMAnalyzer.compute_cfm_score(coin)
        return sorted(coin_list, key=lambda c: c["cfm_score"], reverse=True)

    # ------------------------------------------------------------------
    # Direction prediction
    # ------------------------------------------------------------------

    @staticmethod
    def predict_direction(cfm_score: float, threshold: float = 0.55) -> str:
        """
        Predict market direction from a CFM score.

        Args:
            cfm_score: Composite score in [0, 1].
            threshold: Minimum score to produce a directional signal (default 0.55).

        Returns:
            "UP" if cfm_score >= threshold,
            "DOWN" if cfm_score <= (1 - threshold),
            "NEUTRAL" otherwise.
        """
        if cfm_score >= threshold:
            return "UP"
        if cfm_score <= 1.0 - threshold:
            return "DOWN"
        return "NEUTRAL"
