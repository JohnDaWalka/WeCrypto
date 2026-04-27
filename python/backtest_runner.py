"""
Historical backtest harness for CFM strategies.

Usage (CLI):
    python backtest_runner.py --file candles.csv --window 14
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable

import pandas as pd


class BacktestRunner:
    """Run a strategy function over a candle DataFrame and compute performance stats."""

    # ------------------------------------------------------------------
    # Data loading
    # ------------------------------------------------------------------

    @staticmethod
    def load_candles(filepath: str) -> pd.DataFrame:
        """
        Load OHLCV candles from a CSV file.

        Expected columns (case-insensitive): timestamp, open, high, low, close, volume.
        The timestamp column is parsed as datetime and set as the index.

        Returns:
            DataFrame with columns [open, high, low, close, volume].
        """
        df = pd.read_csv(filepath)
        df.columns = [c.lower() for c in df.columns]

        if "timestamp" in df.columns:
            df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
            df = df.set_index("timestamp").sort_index()

        required = {"open", "high", "low", "close", "volume"}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f"Missing required columns: {missing}")

        return df[list(required - {"timestamp"})].astype(float)

    # ------------------------------------------------------------------
    # Strategy runner
    # ------------------------------------------------------------------

    def run(
        self,
        df: pd.DataFrame,
        strategy_fn: Callable[[pd.DataFrame, int], str],
    ) -> dict:
        """
        Run a strategy over the provided candle DataFrame.

        The strategy function receives:
            df    — the full DataFrame (so it can look back as far as it needs)
            i     — the current bar index

        It must return one of: "buy", "sell", or "hold".

        Returns a dict with performance metrics:
            {
                "win_rate":      float,   # fraction of winning trades (0–1)
                "total_trades":  int,
                "profit_factor": float,   # gross_profit / gross_loss
                "max_drawdown":  float,   # maximum peak-to-trough equity decline (0–1)
            }
        """
        closes = df["close"].to_numpy()
        n = len(closes)

        position = None  # None | {"entry_price": float, "direction": str}
        equity = 1.0
        peak_equity = 1.0
        max_drawdown = 0.0
        gross_profit = 0.0
        gross_loss = 0.0
        wins = 0
        total_trades = 0

        for i in range(1, n):
            signal = strategy_fn(df, i)

            # --- Close open position on opposite signal ---
            if position is not None:
                pnl = 0.0
                if position["direction"] == "buy" and signal == "sell":
                    pnl = (closes[i] - position["entry_price"]) / position["entry_price"]
                elif position["direction"] == "sell" and signal == "buy":
                    pnl = (position["entry_price"] - closes[i]) / position["entry_price"]
                else:
                    continue  # hold

                equity *= 1.0 + pnl
                total_trades += 1
                if pnl > 0:
                    gross_profit += pnl
                    wins += 1
                else:
                    gross_loss += abs(pnl)

                peak_equity = max(peak_equity, equity)
                drawdown = (peak_equity - equity) / peak_equity
                max_drawdown = max(max_drawdown, drawdown)
                position = None

            # --- Open new position ---
            if signal in ("buy", "sell") and position is None:
                position = {"entry_price": closes[i], "direction": signal}

        win_rate = wins / total_trades if total_trades > 0 else 0.0
        profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else float("inf")

        return {
            "win_rate": round(win_rate, 4),
            "total_trades": total_trades,
            "profit_factor": round(profit_factor, 4),
            "max_drawdown": round(max_drawdown, 4),
        }


# ---------------------------------------------------------------------------
# Default strategy: momentum crossover using CFMAnalyzer
# ---------------------------------------------------------------------------

def _momentum_strategy(window: int) -> Callable[[pd.DataFrame, int], str]:
    """Return a simple momentum crossover strategy for the given window."""
    from cfm_analysis import CFMAnalyzer

    def _strategy(df: pd.DataFrame, i: int) -> str:
        start = max(0, i - window - 1)
        prices = df["close"].iloc[start : i + 1].tolist()
        mom = CFMAnalyzer.compute_momentum(prices, window=window)
        if mom >= 0.60:
            return "buy"
        if mom <= 0.40:
            return "sell"
        return "hold"

    return _strategy


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _main() -> None:
    parser = argparse.ArgumentParser(description="CFM backtest runner")
    parser.add_argument("--file", required=True, help="Path to OHLCV CSV file")
    parser.add_argument(
        "--window",
        type=int,
        default=14,
        help="Momentum window (default: 14)",
    )
    args = parser.parse_args()

    filepath = Path(args.file)
    if not filepath.exists():
        print(f"ERROR: file not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    runner = BacktestRunner()
    df = runner.load_candles(str(filepath))
    print(f"Loaded {len(df)} candles from {filepath}")

    strategy = _momentum_strategy(args.window)
    results = runner.run(df, strategy)

    print("\n── Backtest Results ──────────────────────────────────")
    print(f"  Total trades  : {results['total_trades']}")
    print(f"  Win rate      : {results['win_rate']:.1%}")
    print(f"  Profit factor : {results['profit_factor']:.2f}")
    print(f"  Max drawdown  : {results['max_drawdown']:.1%}")
    print("──────────────────────────────────────────────────────")


if __name__ == "__main__":
    _main()
