"""
WE-CRYPTO Python API Client

Drop-in client library for integrating WE-CRYPTO predictions into Python apps

Usage:
    from wecrypto_client import WECryptoClient
    
    client = WECryptoClient('http://localhost:3000')
    prediction = client.predict('BTC')
    accuracy = client.get_accuracy('BTC')
    weights = client.get_weights('BTC')
"""

import requests
import json
import time
from datetime import datetime
from typing import Dict, Any, Optional, List
from dataclasses import dataclass
from threading import Thread
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class Prediction:
    """Prediction data class"""
    coin: str
    direction: str
    confidence: float
    timestamp: int
    weights: Dict[str, float]
    status: str
    error: Optional[str] = None


@dataclass
class AccuracyMetrics:
    """Accuracy metrics data class"""
    coin: str
    accuracy: float
    wins: int
    total: int
    win_rate: str
    timestamp: int
    status: str
    error: Optional[str] = None


class WECryptoClient:
    """Client for WE-CRYPTO API"""
    
    def __init__(self, base_url: str = 'http://localhost:3000', timeout: int = 10):
        """
        Initialize WE-CRYPTO client
        
        Args:
            base_url: Base URL of WE-CRYPTO instance
            timeout: Request timeout in seconds
        """
        self.base_url = base_url
        self.api_endpoint = f'{base_url}/api'
        self.timeout = timeout
        self.cache = {}
        self.polling_thread = None
        self.polling_active = False
        
        logger.info(f'[WECryptoClient] Initialized with base: {base_url}')
    
    def _make_request(self, endpoint: str, method: str = 'GET', data: Optional[Dict] = None) -> Dict[str, Any]:
        """Make API request"""
        url = f'{self.api_endpoint}{endpoint}' if endpoint.startswith('/') else f'{self.api_endpoint}/{endpoint}'
        
        try:
            if method == 'GET':
                response = requests.get(url, timeout=self.timeout)
            elif method == 'POST':
                response = requests.post(url, json=data, timeout=self.timeout)
            else:
                raise ValueError(f'Unsupported method: {method}')
            
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f'API request error: {e}')
            return {'status': 'error', 'error': str(e)}
    
    def predict(self, coin: str) -> Prediction:
        """
        Get current prediction for a coin
        
        Args:
            coin: Coin symbol (BTC, ETH, SOL, etc.)
        
        Returns:
            Prediction object
        """
        try:
            endpoint = f'/predict/{coin}'
            result = self._make_request(endpoint)
            
            if result.get('status') == 'error':
                return Prediction(
                    coin=coin,
                    direction='UNKNOWN',
                    confidence=0,
                    timestamp=int(time.time() * 1000),
                    weights={},
                    status='error',
                    error=result.get('error')
                )
            
            return Prediction(
                coin=coin,
                direction=result.get('direction', 'UNKNOWN'),
                confidence=result.get('confidence', 0),
                timestamp=result.get('timestamp', int(time.time() * 1000)),
                weights=result.get('weights', {}),
                status='success'
            )
        except Exception as e:
            logger.error(f'Prediction error for {coin}: {e}')
            return Prediction(
                coin=coin,
                direction='UNKNOWN',
                confidence=0,
                timestamp=int(time.time() * 1000),
                weights={},
                status='error',
                error=str(e)
            )
    
    def get_accuracy(self, coin: str) -> AccuracyMetrics:
        """
        Get historical accuracy for a coin
        
        Args:
            coin: Coin symbol
        
        Returns:
            AccuracyMetrics object
        """
        try:
            endpoint = f'/accuracy/{coin}'
            result = self._make_request(endpoint)
            
            if result.get('status') == 'error':
                return AccuracyMetrics(
                    coin=coin,
                    accuracy=0,
                    wins=0,
                    total=0,
                    win_rate='0%',
                    timestamp=int(time.time() * 1000),
                    status='error',
                    error=result.get('error')
                )
            
            accuracy = result.get('accuracy', 0)
            wins = result.get('wins', 0)
            total = result.get('total', 0)
            
            return AccuracyMetrics(
                coin=coin,
                accuracy=accuracy,
                wins=wins,
                total=total,
                win_rate=f'{accuracy*100:.1f}%',
                timestamp=result.get('timestamp', int(time.time() * 1000)),
                status='success'
            )
        except Exception as e:
            logger.error(f'Accuracy error for {coin}: {e}')
            return AccuracyMetrics(
                coin=coin,
                accuracy=0,
                wins=0,
                total=0,
                win_rate='0%',
                timestamp=int(time.time() * 1000),
                status='error',
                error=str(e)
            )
    
    def get_weights(self, coin: str) -> Dict[str, float]:
        """
        Get adaptive signal weights for a coin
        
        Args:
            coin: Coin symbol
        
        Returns:
            Dictionary of signal weights
        """
        try:
            endpoint = f'/weights/{coin}'
            result = self._make_request(endpoint)
            
            if result.get('status') == 'error':
                logger.warning(f'Could not fetch weights for {coin}')
                return {}
            
            return result.get('weights', {})
        except Exception as e:
            logger.error(f'Weights error for {coin}: {e}')
            return {}
    
    def get_scorecard(self) -> Dict[str, Any]:
        """
        Get historical accuracy scorecard for all coins
        
        Returns:
            Dictionary with accuracy per coin
        """
        try:
            result = self._make_request('/scorecard')
            
            if result.get('status') == 'error':
                return {}
            
            return result.get('scorecard', {})
        except Exception as e:
            logger.error(f'Scorecard error: {e}')
            return {}
    
    def get_diagnostics(self) -> Dict[str, Any]:
        """
        Get full learning engine diagnostics
        
        Returns:
            Complete diagnostics dictionary
        """
        try:
            result = self._make_request('/diagnostics')
            
            if result.get('status') == 'error':
                return {}
            
            return result
        except Exception as e:
            logger.error(f'Diagnostics error: {e}')
            return {}
    
    def trigger_tuning(self) -> Dict[str, Any]:
        """
        Trigger manual weight tuning cycle
        
        Returns:
            Tuning result
        """
        try:
            result = self._make_request('/tuning', method='POST')
            return result
        except Exception as e:
            logger.error(f'Tuning trigger error: {e}')
            return {'status': 'error', 'error': str(e)}
    
    def reset(self) -> Dict[str, Any]:
        """
        Reset learning engine
        
        Returns:
            Reset status
        """
        try:
            result = self._make_request('/reset', method='POST')
            return result
        except Exception as e:
            logger.error(f'Reset error: {e}')
            return {'status': 'error', 'error': str(e)}
    
    def set_weight(self, coin: str, signal: str, weight: float) -> Dict[str, Any]:
        """
        Set custom weight for a signal
        
        Args:
            coin: Coin symbol
            signal: Signal name
            weight: New weight multiplier
        
        Returns:
            Result dictionary
        """
        try:
            data = {'coin': coin, 'signal': signal, 'weight': weight}
            result = self._make_request('/weight', method='POST', data=data)
            return result
        except Exception as e:
            logger.error(f'Set weight error: {e}')
            return {'status': 'error', 'error': str(e)}
    
    def export_csv(self) -> str:
        """
        Export accuracy data as CSV
        
        Returns:
            CSV string
        """
        try:
            scorecard = self.get_scorecard()
            
            rows = [['Coin', 'Accuracy', 'Wins', 'Total']]
            
            for coin, data in scorecard.items():
                rows.append([
                    coin,
                    f"{data.get('accuracy', 0):.2f}",
                    data.get('wins', 0),
                    data.get('total', 0)
                ])
            
            return '\n'.join([','.join(map(str, row)) for row in rows])
        except Exception as e:
            logger.error(f'CSV export error: {e}')
            return ''
    
    def export_json(self) -> Dict[str, Any]:
        """
        Export full state as JSON
        
        Returns:
            Complete state dictionary
        """
        return {
            'timestamp': int(time.time() * 1000),
            'scorecard': self.get_scorecard(),
            'weights': {coin: self.get_weights(coin) for coin in ['BTC', 'ETH', 'SOL']},
            'diagnostics': self.get_diagnostics()
        }
    
    def start_polling(self, callback, interval: int = 30):
        """
        Start polling for updates
        
        Args:
            callback: Function to call with updates
            interval: Poll interval in seconds
        """
        def poll():
            while self.polling_active:
                try:
                    data = self.get_diagnostics()
                    callback(data)
                    time.sleep(interval)
                except Exception as e:
                    logger.error(f'Polling error: {e}')
                    time.sleep(interval)
        
        self.polling_active = True
        self.polling_thread = Thread(target=poll, daemon=True)
        self.polling_thread.start()
        logger.info(f'Started polling every {interval}s')
    
    def stop_polling(self):
        """Stop polling"""
        self.polling_active = False
        if self.polling_thread:
            self.polling_thread.join(timeout=5)
        logger.info('Stopped polling')


# Example usage
if __name__ == '__main__':
    client = WECryptoClient('http://localhost:3000')
    
    # Get predictions
    print('Getting predictions...')
    for coin in ['BTC', 'ETH', 'SOL']:
        pred = client.predict(coin)
        print(f'{coin}: {pred.direction} ({pred.confidence}%)')
    
    # Get accuracy
    print('\nGetting accuracy...')
    acc = client.get_accuracy('BTC')
    print(f'BTC: {acc.win_rate} ({acc.wins}/{acc.total})')
    
    # Get weights
    print('\nGetting weights...')
    weights = client.get_weights('BTC')
    print(f'BTC weights: {weights}')
    
    # Export
    print('\nExporting data...')
    csv = client.export_csv()
    print(f'CSV:\n{csv}')
