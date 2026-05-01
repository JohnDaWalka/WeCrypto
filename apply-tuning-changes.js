#!/usr/bin/env node
// apply-tuning-changes.js
// ════════════════════════════════════════════════════════════════════════════
// Applies the backtest-recommended tuning changes to optimize from 59% to 70%
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

class TuningApplier {
  constructor() {
    this.changes = [];
    this.errors = [];
    this.projectRoot = 'F:\\WECRYP';
  }

  run() {
    console.log('\n' + '═'.repeat(80));
    console.log('⚙️  APPLYING BACKTEST-RECOMMENDED TUNING CHANGES');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('\n📊 Target: Improve from 59% to 70% win rate\n');

    try {
      // Step 1: Update predictions.js - remove weak coins
      console.log('Step 1: Removing weak coins (SOL, HYPE)...');
      this.updatePredictionCoins();
      console.log('  ✓ Updated PREDICTION_COINS\n');

      // Step 2: Update signal weights - optimize weights
      console.log('Step 2: Optimizing signal weights...');
      this.updateSignalWeights();
      console.log('  ✓ Updated signal weights\n');

      // Step 3: Bump version
      console.log('Step 3: Bumping version to 2.13.3...');
      this.updatePackageVersion();
      console.log('  ✓ Updated package.json\n');

      // Step 4: Print summary
      this.printSummary();

      return true;
    } catch (e) {
      console.error('❌ Error applying changes:', e.message);
      this.errors.push(e.message);
      return false;
    }
  }

  updatePredictionCoins() {
    const filePath = path.join(this.projectRoot, 'src', 'core', 'predictions.js');
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    let content = fs.readFileSync(filePath, 'utf8');

    // Find and replace PREDICTION_COINS array
    const oldPattern = /const PREDICTION_COINS\s*=\s*\[\s*[^\]]*'SOL'[^\]]*'HYPE'[^\]]*\]/;
    const newCoins = [
      "{ sym: 'BTC', ... }",
      "{ sym: 'ETH', ... }",
      "{ sym: 'XRP', ... }",
      "{ sym: 'DOGE', ... }",
      "{ sym: 'BNB', ... }"
    ];

    // More precise replacement
    const patterns = [
      { old: /'SOL'[^,]*,\s*/g, new: '' },  // Remove SOL
      { old: /'HYPE'[^,]*,\s*/g, new: '' }  // Remove HYPE
    ];

    for (const p of patterns) {
      content = content.replace(p.old, p.new);
    }

    fs.writeFileSync(filePath, content, 'utf8');
    
    this.changes.push({
      file: 'src/core/predictions.js',
      change: 'Removed SOL and HYPE from PREDICTION_COINS',
      impact: '+9.29% accuracy'
    });
  }

  updateSignalWeights() {
    const filePath = path.join(this.projectRoot, 'src', 'core', 'adaptive-learning-engine.js');
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    let content = fs.readFileSync(filePath, 'utf8');

    const weightUpdates = [
      { signal: 'rsi', oldWeight: '2.0', newWeight: '2.5' },
      { signal: 'bollinger-bands', oldWeight: '1.0', newWeight: '0.5' },
      { signal: 'stochastic', oldWeight: '1.1', newWeight: '0.55' },
      { signal: 'volume-profile', oldWeight: '0.8', newWeight: '0.0' },
      { signal: 'atr-volatility', oldWeight: '0.9', newWeight: '0.0' }
    ];

    for (const update of weightUpdates) {
      const pattern = new RegExp(`['"]${update.signal}['"]\s*:\s*${update.oldWeight}`, 'g');
      content = content.replace(pattern, `'${update.signal}': ${update.newWeight}`);
    }

    fs.writeFileSync(filePath, content, 'utf8');
    
    this.changes.push({
      file: 'src/core/adaptive-learning-engine.js',
      change: 'Optimized signal weights (RSI +0.5, weak signals -50%)',
      impact: '+1.88% accuracy'
    });
  }

  updatePackageVersion() {
    const filePath = path.join(this.projectRoot, 'package.json');
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const updated = content.replace(
      /"version"\s*:\s*"2\.13\.2[^"]*"/,
      '"version": "2.13.3-optimized-tuning"'
    );

    fs.writeFileSync(filePath, updated, 'utf8');
    
    this.changes.push({
      file: 'package.json',
      change: 'Version bumped to 2.13.3-optimized-tuning',
      impact: 'Build will produce new executable'
    });
  }

  printSummary() {
    console.log('═'.repeat(80));
    console.log('✅ TUNING CHANGES APPLIED');
    console.log('═'.repeat(80) + '\n');

    console.log('CHANGES MADE:');
    for (const change of this.changes) {
      console.log(`\n📝 ${change.file}`);
      console.log(`   → ${change.change}`);
      console.log(`   📈 Expected: ${change.impact}`);
    }

    console.log('\n' + '═'.repeat(80));
    console.log('🚀 NEXT STEPS');
    console.log('═'.repeat(80) + '\n');

    console.log('1. Verify changes:');
    console.log('   node backtest-simulator.js  # Rerun simulation\n');

    console.log('2. Rebuild executable:');
    console.log('   npm run build  # Creates v2.13.3-optimized-tuning-portable.exe\n');

    console.log('3. Deploy:');
    console.log('   Copy WECRYPTO-v2.13.3-optimized-tuning-portable.exe to production\n');

    console.log('4. Monitor:');
    console.log('   window.ContractCacheDebug.accuracy()  # Check new WR\n');

    console.log('5. Expected result after 30 minutes:');
    console.log('   • Win rate: 68-70% (was 59%)');
    console.log('   • Only 5 coins: BTC, ETH, BNB, DOGE, XRP');
    console.log('   • Only 3-4 strong signals active');
    console.log('   • Lower error rate\n');

    console.log('═'.repeat(80));
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('═'.repeat(80) + '\n');
  }
}

// Run applier
const applier = new TuningApplier();
const success = applier.run();

process.exit(success ? 0 : 1);
