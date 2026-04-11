#!/usr/bin/env node

/**
 * Migration Script: Crypto Strategy Consolidation
 *
 * Migrates configuration and state from the legacy cryptostrategies collection
 * to the SubAgent model (subagents collection).
 *
 * Usage: node scripts/migrate-crypto-strategy.js [--dry-run]
 */

import mongoose from 'mongoose';
import SubAgent from '../src/models/SubAgent.js';
import CryptoStrategy from '../src/models/CryptoStrategy.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function migrateCryptoStrategy() {
  try {
    console.log('=== Crypto Strategy Consolidation Migration ===');
    console.log(DRY_RUN ? '(DRY RUN - no changes will be saved)\n' : '\n');

    // Connect to MongoDB
    await mongoose.connect('mongodb://localhost:27017/lanagent');
    console.log('Connected to MongoDB');

    // Step 1: Load legacy config
    console.log('\n--- Step 1: Loading legacy configuration ---');
    const legacyConfig = await CryptoStrategy.findOne({ type: 'config' });

    if (!legacyConfig) {
      console.log('No legacy crypto strategy config found. Nothing to migrate.');
      await mongoose.disconnect();
      return;
    }

    console.log('Found legacy config:');
    console.log(`  - Network Mode: ${legacyConfig.networkMode}`);
    console.log(`  - Enabled: ${legacyConfig.config?.enabled}`);
    console.log(`  - Interval: ${legacyConfig.config?.intervalMinutes} minutes`);
    console.log(`  - Active Strategy: ${legacyConfig.strategyRegistry?.activeStrategy || 'default'}`);
    console.log(`  - Positions: ${Object.keys(legacyConfig.state?.positions || {}).length} networks`);
    console.log(`  - Price Baselines: ${Object.keys(legacyConfig.state?.priceBaselines || {}).length} assets`);
    console.log(`  - Total PnL: ${legacyConfig.state?.totalPnL || 0}`);
    console.log(`  - Trades Executed: ${legacyConfig.state?.tradesExecuted || 0}`);

    // Step 2: Find SubAgent
    console.log('\n--- Step 2: Finding Crypto Strategy SubAgent ---');
    const subAgent = await SubAgent.findOne({
      domain: 'crypto',
      type: 'domain'
    });

    if (!subAgent) {
      console.log('ERROR: Crypto Strategy SubAgent not found!');
      console.log('Please ensure the SubAgent exists before running migration.');
      await mongoose.disconnect();
      process.exit(1);
    }

    console.log(`Found SubAgent: ${subAgent.name} (ID: ${subAgent._id})`);
    console.log(`  - Current status: ${subAgent.status}`);
    console.log(`  - Enabled: ${subAgent.enabled}`);

    // Step 3: Build domainConfig from legacy
    console.log('\n--- Step 3: Mapping configuration ---');

    const domainConfig = {
      // Core settings from legacy config
      networkMode: legacyConfig.networkMode || 'testnet',
      intervalMinutes: legacyConfig.config?.intervalMinutes || 60,
      maxTradePercentage: legacyConfig.config?.maxTradePercentage || 10,
      dailyLossLimit: legacyConfig.config?.dailyLossLimit || 5,
      slippageTolerance: legacyConfig.config?.slippageTolerance || 1,
      minTradeValueUSD: legacyConfig.config?.minTradeValueUSD || 1,

      // Strategy settings
      activeStrategy: legacyConfig.strategyRegistry?.activeStrategy || 'volatility_adjusted',
      strategies: legacyConfig.config?.strategies || [],
      strategyConfigs: legacyConfig.strategyRegistry?.strategies || {},

      // Trading settings
      targetAllocations: legacyConfig.config?.targetAllocations || {},
      watchlist: legacyConfig.config?.watchlist || ['ETH', 'BNB', 'MATIC'],
      autoExecute: legacyConfig.config?.autoExecute !== false,
      emergencyStop: legacyConfig.config?.emergencyStop || false,

      // Preserve any existing domainConfig values
      ...subAgent.config?.domainConfig,

      // Override with legacy values (they take precedence)
      networkMode: legacyConfig.networkMode || subAgent.config?.domainConfig?.networkMode || 'testnet',
      activeStrategy: legacyConfig.strategyRegistry?.activeStrategy || subAgent.config?.domainConfig?.activeStrategy || 'volatility_adjusted'
    };

    console.log('Built domainConfig:');
    console.log(`  - networkMode: ${domainConfig.networkMode}`);
    console.log(`  - intervalMinutes: ${domainConfig.intervalMinutes}`);
    console.log(`  - activeStrategy: ${domainConfig.activeStrategy}`);
    console.log(`  - autoExecute: ${domainConfig.autoExecute}`);
    console.log(`  - emergencyStop: ${domainConfig.emergencyStop}`);

    // Step 4: Build domainState from legacy
    console.log('\n--- Step 4: Mapping state ---');

    const domainState = {
      // Performance tracking
      dailyPnL: legacyConfig.state?.dailyPnL || 0,
      totalPnL: legacyConfig.state?.totalPnL || 0,
      tradesExecuted: legacyConfig.state?.tradesExecuted || 0,
      tradesProposed: legacyConfig.state?.tradesProposed || 0,

      // Position and price tracking (CRITICAL)
      positions: legacyConfig.state?.positions || {},
      priceBaselines: legacyConfig.state?.priceBaselines || {},

      // Decision history
      lastDecision: legacyConfig.state?.lastDecision || null,
      lastExecution: legacyConfig.state?.lastExecution || null,
      performanceHistory: legacyConfig.state?.performanceHistory || [],

      // Decision journal (empty if not present)
      decisionJournal: [],

      // Preserve any existing domainState
      ...subAgent.state?.domainState
    };

    // Merge positions - legacy takes precedence but preserve SubAgent positions
    if (subAgent.state?.domainState?.positions) {
      domainState.positions = {
        ...subAgent.state.domainState.positions,
        ...legacyConfig.state?.positions
      };
    }

    // Merge priceBaselines similarly
    if (subAgent.state?.domainState?.priceBaselines) {
      domainState.priceBaselines = {
        ...subAgent.state.domainState.priceBaselines,
        ...legacyConfig.state?.priceBaselines
      };
    }

    console.log('Built domainState:');
    console.log(`  - positions: ${JSON.stringify(Object.keys(domainState.positions))}`);
    console.log(`  - priceBaselines: ${Object.keys(domainState.priceBaselines).length} assets`);
    console.log(`  - totalPnL: ${domainState.totalPnL}`);
    console.log(`  - tradesExecuted: ${domainState.tradesExecuted}`);

    // Step 5: Update SubAgent
    console.log('\n--- Step 5: Updating SubAgent ---');

    // Calculate schedule pattern
    const intervalMinutes = domainConfig.intervalMinutes || 60;
    const runPattern = `${intervalMinutes} minutes`;

    const updates = {
      'config.domainConfig': domainConfig,
      'state.domainState': domainState,
      'schedule.runPattern': runPattern,
      'enabled': legacyConfig.config?.enabled !== false
    };

    console.log('Updates to apply:');
    console.log(`  - schedule.runPattern: "${runPattern}"`);
    console.log(`  - enabled: ${updates.enabled}`);

    if (!DRY_RUN) {
      await SubAgent.updateOne(
        { _id: subAgent._id },
        { $set: updates }
      );
      console.log('\nSubAgent updated successfully!');

      // Add migration history entry
      await SubAgent.updateOne(
        { _id: subAgent._id },
        {
          $push: {
            history: {
              timestamp: new Date(),
              event: 'config_migrated',
              details: {
                source: 'cryptostrategies_collection',
                migratedAt: new Date().toISOString(),
                configFields: Object.keys(domainConfig),
                stateFields: Object.keys(domainState)
              }
            }
          }
        }
      );
      console.log('Migration history entry added.');
    } else {
      console.log('\n(DRY RUN - no changes made)');
    }

    // Step 6: Verify migration
    console.log('\n--- Step 6: Verification ---');

    const verifyAgent = await SubAgent.findById(subAgent._id);
    console.log('SubAgent after migration:');
    console.log(`  - domainConfig.networkMode: ${verifyAgent.config?.domainConfig?.networkMode}`);
    console.log(`  - domainConfig.activeStrategy: ${verifyAgent.config?.domainConfig?.activeStrategy}`);
    console.log(`  - domainConfig.intervalMinutes: ${verifyAgent.config?.domainConfig?.intervalMinutes}`);
    console.log(`  - domainState.positions: ${JSON.stringify(Object.keys(verifyAgent.state?.domainState?.positions || {}))}`);
    console.log(`  - schedule.runPattern: ${verifyAgent.schedule?.runPattern}`);

    // Step 7: Summary
    console.log('\n=== Migration Summary ===');
    console.log(`Legacy config document ID: ${legacyConfig._id}`);
    console.log(`SubAgent ID: ${subAgent._id}`);
    console.log(`SubAgent name: ${subAgent.name}`);

    if (!DRY_RUN) {
      console.log('\nMigration completed successfully!');
      console.log('\nNext steps:');
      console.log('1. Verify the SubAgent works correctly via API');
      console.log('2. Test: curl http://localhost/api/crypto/strategy/status');
      console.log('3. If everything works, you can archive the legacy service:');
      console.log('   - Delete src/services/crypto/cryptoStrategyService.js');
      console.log('   - Optionally archive src/models/CryptoStrategy.js');
    } else {
      console.log('\nDry run completed. Run without --dry-run to apply changes.');
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');

  } catch (error) {
    console.error('\nMigration error:', error);
    process.exit(1);
  }
}

// Run migration
migrateCryptoStrategy();
