"""
Live signal evaluation loop.

Polls Kalshi every 60 seconds, runs CFMAnalyzer.predict_direction()
on fetched market data, and prints color-coded UP/DOWN/NEUTRAL signals.

Usage:
    python signal_evaluator.py
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# ANSI colour helpers
# ---------------------------------------------------------------------------

_RESET = "\033[0m"
_GREEN = "\033[92m"
_RED = "\033[91m"
_YELLOW = "\033[93m"
_BOLD = "\033[1m"


def _color(text: str, color: str) -> str:
    if sys.stdout.isatty():
        return f"{color}{text}{_RESET}"
    return text


def _direction_str(direction: str) -> str:
    if direction == "UP":
        return _color("▲ UP    ", _GREEN + _BOLD)
    if direction == "DOWN":
        return _color("▼ DOWN  ", _RED + _BOLD)
    return _color("● NEUTRAL", _YELLOW)


# ---------------------------------------------------------------------------
# Signal evaluation
# ---------------------------------------------------------------------------

def evaluate_once(client, analyzer_cls, series_ticker: str = "KXBTCD") -> None:
    """
    Fetch markets for series_ticker, compute CFM scores, and print signals.
    """
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    try:
        data = client.get_markets(series_ticker)
    except Exception as exc:
        print(f"[{ts}] ERROR fetching markets: {exc}", file=sys.stderr)
        return

    markets = data.get("markets", [])
    if not markets:
        print(f"[{ts}] No markets found for series '{series_ticker}'")
        return

    print(f"\n[{ts}] {len(markets)} market(s) — series {series_ticker}")
    print("─" * 60)

    for market in markets:
        ticker = market.get("ticker", "?")
        yes_bid = market.get("yes_bid", 50)
        yes_ask = market.get("yes_ask", 50)
        volume = market.get("volume", 0)

        mid = (yes_bid + yes_ask) / 2.0
        spread_frac = (yes_ask - yes_bid) / 100.0 if yes_ask > yes_bid else 0.01
        momentum = mid / 100.0  # proxy: market-implied probability as momentum

        coin_data = {
            "volume": float(volume),
            "momentum": momentum,
            "spread": spread_frac,
        }

        score = analyzer_cls.compute_cfm_score(coin_data)
        direction = analyzer_cls.predict_direction(score)

        print(
            f"  {_direction_str(direction)}  {ticker:<30}  "
            f"score={score:.3f}  mid={mid:.1f}¢  vol={volume}"
        )

    print("─" * 60)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main(poll_interval: int = 60, series_ticker: str = "KXBTCD") -> None:
    """Poll Kalshi and evaluate signals until interrupted."""
    from kalshi_api import client_from_key_file
    from cfm_analysis import CFMAnalyzer

    key_file = Path(__file__).parent.parent / "KALSHI-API-KEY.txt"
    if not key_file.exists():
        print(
            f"ERROR: credential file not found: {key_file}\n"
            "Create KALSHI-API-KEY.txt with your API key ID on line 0 "
            "and PEM private key from line 4 onward.",
            file=sys.stderr,
        )
        sys.exit(1)

    client = client_from_key_file(key_file)
    print(f"Signal evaluator started — polling every {poll_interval}s")
    print(f"Series: {series_ticker} | Press Ctrl-C to stop\n")

    try:
        while True:
            evaluate_once(client, CFMAnalyzer, series_ticker)
            time.sleep(poll_interval)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
