"""
Kalshi REST API client with RSA-signed request authentication.

Credentials are loaded from KALSHI-API-KEY.txt (same format as the JS client):
  Line 0: API Key ID
  Lines 4+: PEM private key
"""

import base64
import hashlib
import hmac
import os
import time
from pathlib import Path

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


BASE_URL = "https://api.elections.kalshi.com"
KEY_FILE_DEFAULT = Path(__file__).parent.parent / "KALSHI-API-KEY.txt"


def load_credentials(key_file: str | Path = KEY_FILE_DEFAULT) -> tuple[str, str]:
    """
    Load API credentials from a KALSHI-API-KEY.txt file.

    Returns:
        (api_key_id, private_key_pem) as strings.
    """
    lines = Path(key_file).read_text(encoding="utf-8").splitlines()
    lines = [l.strip() for l in lines if l.strip()]
    if len(lines) < 5:
        raise ValueError(
            "Invalid KALSHI-API-KEY.txt: expected at least 5 lines "
            "(key ID at line 0, PEM key from line 4 onward)."
        )
    api_key_id = lines[0]
    private_key_pem = "\n".join(lines[4:])
    return api_key_id, private_key_pem


class KalshiClient:
    """
    Minimal Kalshi REST client with RSA-PS256 request signing.

    Args:
        api_key_id:      Kalshi API key UUID.
        private_key_pem: RSA private key in PEM format (PKCS#8 or PKCS#1).
        base_url:        Base URL (default: production endpoint).
    """

    def __init__(
        self,
        api_key_id: str,
        private_key_pem: str,
        base_url: str = BASE_URL,
    ) -> None:
        self.api_key_id = api_key_id
        self.base_url = base_url.rstrip("/")
        self._private_key = serialization.load_pem_private_key(
            private_key_pem.encode(), password=None
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _sign(self, timestamp_ms: int, method: str, path: str) -> str:
        """Return the base64url-encoded RSA-PS256 signature for Kalshi auth."""
        message = f"{timestamp_ms}{method}{path}".encode()
        signature = self._private_key.sign(
            message,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        return base64.b64encode(signature).decode()

    def _headers(self, method: str, path: str) -> dict:
        ts = int(time.time() * 1000)
        return {
            "Content-Type": "application/json",
            "KALSHI-ACCESS-KEY": self.api_key_id,
            "KALSHI-ACCESS-TIMESTAMP": str(ts),
            "KALSHI-ACCESS-SIGNATURE": self._sign(ts, method.upper(), path),
        }

    def _get(self, path: str, params: dict | None = None) -> dict:
        resp = requests.get(
            self.base_url + path,
            headers=self._headers("GET", path),
            params=params,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def _post(self, path: str, body: dict) -> dict:
        resp = requests.post(
            self.base_url + path,
            headers=self._headers("POST", path),
            json=body,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Public API methods
    # ------------------------------------------------------------------

    def get_balance(self) -> dict:
        """Return the authenticated user's current balance."""
        return self._get("/trade-api/v2/portfolio/balance")

    def get_markets(self, series_ticker: str) -> dict:
        """Fetch all markets for a given series ticker."""
        return self._get(
            "/trade-api/v2/markets",
            params={"series_ticker": series_ticker},
        )

    def get_market(self, ticker: str) -> dict:
        """Fetch a single market by ticker."""
        return self._get(f"/trade-api/v2/markets/{ticker}")

    def get_orderbook(self, ticker: str, depth: int = 10) -> dict:
        """Fetch the order book for a market."""
        return self._get(
            f"/trade-api/v2/markets/{ticker}/orderbook",
            params={"depth": depth},
        )

    def place_order(
        self,
        ticker: str,
        side: str,
        count: int,
        price: int,
        action: str = "buy",
        order_type: str = "limit",
    ) -> dict:
        """
        Place a limit order.

        Args:
            ticker:     Market ticker symbol.
            side:       "yes" or "no".
            count:      Number of contracts.
            price:      Limit price in cents (1–99).
            action:     "buy" or "sell".
            order_type: "limit" (default) or "market".
        """
        return self._post(
            "/trade-api/v2/portfolio/orders",
            {
                "ticker": ticker,
                "action": action,
                "side": side,
                "count": count,
                "type": order_type,
                "yes_price": price if side == "yes" else 100 - price,
            },
        )

    def get_positions(self) -> dict:
        """Return all open positions for the authenticated user."""
        return self._get("/trade-api/v2/portfolio/positions")


# ---------------------------------------------------------------------------
# Convenience factory: load from default key file
# ---------------------------------------------------------------------------

def client_from_key_file(key_file: str | Path = KEY_FILE_DEFAULT) -> KalshiClient:
    """Create a KalshiClient by reading credentials from a key file."""
    api_key_id, private_key_pem = load_credentials(key_file)
    return KalshiClient(api_key_id, private_key_pem)
