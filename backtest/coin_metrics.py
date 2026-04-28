"""
Coin fundamentals metrics for intelligent threshold tuning.
Uses supply distribution, volume, volatility, and market cap to inform per-coin parameters.
"""

import json
from datetime import datetime

# Coin fundamental metrics (as of 2026-04-27)
# Source: CoinGecko, on-chain data, market caps
COIN_METRICS = {
    'BTC': {
        'symbol': 'BTC',
        'max_supply': 21_000_000,
        'circulating_supply': 21_000_000,  # Fully distributed
        'supply_ratio': 1.0,  # 100% distributed
        'market_cap_usd': 95_000 * 21_000_000 / 1e9,  # ~95B
        'avg_daily_volume': 35_000_000_000,  # $35B
        'volatility_30d': 0.42,  # 42% annualized
        'confidence': 'HIGH',  # Most stable, most liquid
        'characteristics': ['fully_distributed', 'highly_liquid', 'low_volatility'],
    },
    'ETH': {
        'symbol': 'ETH',
        'max_supply': float('inf'),  # No cap
        'circulating_supply': 120_000_000,
        'supply_ratio': 1.0,  # Staking/burning mechanism
        'market_cap_usd': 3_800 * 120_000_000 / 1e9,  # ~456B
        'avg_daily_volume': 18_000_000_000,  # $18B
        'volatility_30d': 0.48,  # 48% annualized
        'confidence': 'HIGH',  # Stable, highly liquid
        'characteristics': ['inflationary', 'highly_liquid', 'moderate_volatility'],
    },
    'XRP': {
        'symbol': 'XRP',
        'max_supply': 100_000_000_000,
        'circulating_supply': 52_500_000_000,
        'supply_ratio': 0.525,  # 52.5% distributed (escrowed)
        'market_cap_usd': 2.0 * 52_500_000_000 / 1e9,  # ~105B
        'avg_daily_volume': 2_200_000_000,  # $2.2B
        'volatility_30d': 0.65,  # 65% annualized
        'confidence': 'MEDIUM',  # Moderate liquidity, higher volatility
        'characteristics': ['partially_escrowed', 'moderate_liquid', 'high_volatility'],
    },
    'SOL': {
        'symbol': 'SOL',
        'max_supply': float('inf'),
        'circulating_supply': 570_000_000,
        'supply_ratio': 0.85,  # ~85% of reasonable cap
        'market_cap_usd': 140 * 570_000_000 / 1e9,  # ~80B
        'avg_daily_volume': 800_000_000,  # $800M
        'volatility_30d': 0.72,  # 72% annualized
        'confidence': 'MEDIUM-LOW',  # Lower liquidity, high volatility
        'characteristics': ['inflationary', 'lower_liquidity', 'high_volatility'],
    },
    'BNB': {
        'symbol': 'BNB',
        'max_supply': 200_000_000,
        'circulating_supply': 168_000_000,
        'supply_ratio': 0.84,  # 84% distributed
        'market_cap_usd': 615 * 168_000_000 / 1e9,  # ~103B
        'avg_daily_volume': 2_100_000_000,  # $2.1B
        'volatility_30d': 0.68,  # 68% annualized
        'confidence': 'MEDIUM',  # Moderate, but exchange-bound
        'characteristics': ['exchange_token', 'moderate_liquid', 'high_volatility'],
    },
}

def compute_tuning_factors():
    """
    Compute per-coin tuning factors based on metrics.
    
    Higher metrics -> lower thresholds (wider net, more signals)
    Lower metrics -> higher thresholds (tighter net, fewer signals)
    
    Returns dict of coin -> {threshold_multiplier, signal_gate_params}
    """
    factors = {}
    
    for coin_sym, metrics in COIN_METRICS.items():
        # Normalize metrics to 0-1 scale
        volume_score = min(1.0, metrics['avg_daily_volume'] / 35_000_000_000)  # BTC volume = 1.0
        liquidity_score = volume_score * (1 if metrics['confidence'] != 'LOW' else 0.5)
        volatility_factor = 1 - min(1.0, metrics['volatility_30d'] / 1.0)  # Lower vol = higher score
        supply_health = metrics['supply_ratio']  # Fully distributed = 1.0
        
        # Composite health score (0-1)
        health_score = (liquidity_score * 0.4 + volatility_factor * 0.3 + supply_health * 0.3)
        
        # Gate thresholds inversely proportional to health
        # Healthy coins (BTC/ETH) → lower thresholds (easier to trigger)
        # Weak coins (SOL/BNB) → higher thresholds (harder to trigger, fewer false positives)
        
        if health_score > 0.75:  # BTC, ETH
            abs_score_multiplier = 0.85  # Lower minAbsScore → 0.22 * 0.85 = 0.19
            agreement_multiplier = 0.90  # Lower minAgreement
            confidence_multiplier = 0.95
            signal_bias = 1.3  # Accept more signals
        elif health_score > 0.55:  # XRP, medium
            abs_score_multiplier = 1.0
            agreement_multiplier = 1.0
            confidence_multiplier = 1.0
            signal_bias = 1.0
        elif health_score > 0.35:  # SOL, BNB
            abs_score_multiplier = 1.4  # Raise minAbsScore
            agreement_multiplier = 1.15  # Raise minAgreement
            confidence_multiplier = 1.2
            signal_bias = 0.75  # Suppress weak signals
        else:  # Very weak
            abs_score_multiplier = 1.8
            agreement_multiplier = 1.3
            confidence_multiplier = 1.4
            signal_bias = 0.5
        
        factors[coin_sym] = {
            'health_score': round(health_score, 3),
            'liquidity_score': round(liquidity_score, 3),
            'volatility_factor': round(volatility_factor, 3),
            'supply_health': round(supply_health, 3),
            'recommended_strategy': 'AGGRESSIVE' if health_score > 0.75 else ('MODERATE' if health_score > 0.55 else 'CONSERVATIVE'),
            'abs_score_multiplier': round(abs_score_multiplier, 2),
            'agreement_multiplier': round(agreement_multiplier, 2),
            'confidence_multiplier': round(confidence_multiplier, 2),
            'signal_bias': round(signal_bias, 2),
        }
    
    return factors

def recommend_gates():
    """
    Generate recommended per-coin SIGNAL_GATE_OVERRIDES based on metrics.
    """
    DEFAULT_GATE = {
        'minAbsScore': 0.22,
        'minAgreement': 0.54,
        'minConfidence': 42,
    }
    
    factors = compute_tuning_factors()
    recommendations = {}
    
    for coin_sym, factor in factors.items():
        # Apply multipliers to default gates
        recommendations[coin_sym] = {
            'minAbsScore': round(DEFAULT_GATE['minAbsScore'] * factor['abs_score_multiplier'], 2),
            'minAgreement': round(DEFAULT_GATE['minAgreement'] * factor['agreement_multiplier'], 2),
            'minConfidence': max(40, int(DEFAULT_GATE['minConfidence'] * factor['confidence_multiplier'])),
            'signal_bias': factor['signal_bias'],
            'strategy': factor['recommended_strategy'],
        }
    
    return recommendations

if __name__ == '__main__':
    print("=" * 80)
    print("COIN METRICS ANALYSIS & RECOMMENDED GATE THRESHOLDS")
    print("=" * 80)
    print()
    
    factors = compute_tuning_factors()
    recommendations = recommend_gates()
    
    # Print detailed factors
    print("COIN HEALTH SCORES:")
    print("-" * 80)
    for coin_sym in ['BTC', 'ETH', 'XRP', 'SOL', 'BNB']:
        f = factors[coin_sym]
        print(f"{coin_sym:5} | Health: {f['health_score']:.2f} | Strategy: {f['recommended_strategy']:12} | "
              f"Liquidity: {f['liquidity_score']:.2f} | Volatility: {f['volatility_factor']:.2f}")
    
    print()
    print("RECOMMENDED SIGNAL_GATE_OVERRIDES:")
    print("-" * 80)
    for coin_sym in ['BTC', 'ETH', 'XRP', 'SOL', 'BNB']:
        rec = recommendations[coin_sym]
        print(f"{coin_sym}: {{")
        print(f"  minAbsScore:   {rec['minAbsScore']},")
        print(f"  minAgreement:  {rec['minAgreement']},")
        print(f"  minConfidence: {rec['minConfidence']},  // Signal bias: {rec['signal_bias']}")
        print(f"}},")
    
    print()
    print("RATIONALE:")
    print("-" * 80)
    print("BTC/ETH (HIGH health): Lower thresholds → wider net, aggressive on strong signals")
    print("XRP (MEDIUM health): Default thresholds → balanced approach")
    print("SOL/BNB (MEDIUM-LOW health): Higher thresholds → tight gate, only on high confidence")
    print()
    print("Metrics considered:")
    print("  - Supply distribution (fully distributed > partially escrowed)")
    print("  - Daily volume (higher = more liquid = lower threshold)")
    print("  - Volatility (lower vol = higher reliability = lower threshold)")
    print("  - Confidence rating (fundamental market position)")
