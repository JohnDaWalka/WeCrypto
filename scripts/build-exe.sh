#!/usr/bin/env bash
# Build WeCrypto Regime Backtest as Windows .exe
# Prerequisites: Rust, Node.js, npm, Python 3.11+

set -e

echo "🔨 Building WeCrypto Regime Backtest Tauri App..."
echo

cd "$(dirname "$0")/we-crypto-cfm-tauri" || exit 1

# Install dependencies
echo "📦 Installing Tauri dependencies..."
npm install

# Copy Python backtest script to accessible location
echo "🐍 Preparing Python backtest engine..."
cp ../backtest-regime.py src-tauri/resources/backtest-regime.py 2>/dev/null || mkdir -p src-tauri/resources && cp ../backtest-regime.py src-tauri/resources/

# Build Tauri app
echo "🏗️  Building Tauri bundle (this may take 2-5 minutes)..."
npm run build

echo
echo "✅ Build complete!"
echo "📂 Output: ./src-tauri/target/release/"
echo
echo "To run the app:"
echo "  • Windows: ./src-tauri/target/release/we-crypto-cfm.exe"
echo "  • Or use: npm run dev"
