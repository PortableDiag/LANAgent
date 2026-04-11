#!/usr/bin/env node
/**
 * Clear 'ignored_scam' flags from processedDeposits so tokens get reclassified.
 * Usage: node scripts/crypto/clear-scam-flags.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Find the CryptoStrategyAgent state
    const col = mongoose.connection.collection('agentstates');
    const doc = await col.findOne({ agentId: /crypto/i });
    if (!doc) {
        console.log('No crypto agent state found');
        await mongoose.disconnect();
        return;
    }

    const tracking = doc.state?.depositTracking || {};
    const processed = tracking.processedDeposits || {};

    let cleared = 0;
    const toClear = [];

    for (const [key, val] of Object.entries(processed)) {
        if (val?.action === 'ignored_scam') {
            toClear.push({ key, symbol: val.symbol, timestamp: val.timestamp });
            delete processed[key];
            cleared++;
        }
    }

    if (cleared === 0) {
        console.log('No ignored_scam entries found');
        await mongoose.disconnect();
        return;
    }

    console.log(`Clearing ${cleared} ignored_scam entries:`);
    for (const item of toClear) {
        console.log(`  ${item.key} — ${item.symbol} (flagged at ${item.timestamp})`);
    }

    await col.updateOne(
        { _id: doc._id },
        { $set: { 'state.depositTracking.processedDeposits': processed } }
    );

    console.log(`Done — ${cleared} entries cleared. Tokens will be reclassified on next sweep cycle.`);
    await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
