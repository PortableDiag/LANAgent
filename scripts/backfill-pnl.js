#!/usr/bin/env node
/**
 * Backfill DailyPnL collection from log files.
 * Parses TokenTrader BUY/SELL lines from all log files,
 * computes daily realized P&L + gas, and stores in MongoDB.
 *
 * Usage: node scripts/backfill-pnl.js [--dry-run]
 *
 * Adjusts cumulative totals to match the actual token trader P&L
 * (which includes lifetime losses from token switches not in logs).
 */
import mongoose from 'mongoose';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
const LOG_DIRS = [
    join(__dirname, '..', 'logs'),
    '/root/lanagent-deploy/logs',
    process.env.HOME + '/.pm2/logs'
];

const dryRun = process.argv.includes('--dry-run');

// Parse trade lines from logs
function parseTradeLine(line) {
    let timestamp, msg;

    // JSON structured log
    if (line.trim().startsWith('{')) {
        try {
            const obj = JSON.parse(line);
            msg = obj.message || '';
            timestamp = obj.timestamp || '';
        } catch { return null; }
    } else {
        // Plain text: 2026-03-11 16:22:02 [INFO] TokenTrader ...
        const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (!m) return null;
        timestamp = m[1].replace(' ', 'T') + 'Z';
        msg = line;
    }

    if (!msg.includes('TokenTrader BUY') && !msg.includes('TokenTrader SELL')) return null;

    // SELL: TokenTrader SELL: 89.5303 SIREN @ $0.503836 (received $45.11, PnL: $1.93, gas: $0.0072)
    const sellMatch = msg.match(/TokenTrader SELL: ([\d.]+) (\S+) @ \$([\d.]+) \(received \$([\d.]+), PnL: \$([-\d.]+).*gas: \$([\d.]+)/);
    if (sellMatch) {
        return {
            timestamp,
            side: 'SELL',
            token: sellMatch[2].replace(/^\$/, ''),
            amount: parseFloat(sellMatch[1]),
            price: parseFloat(sellMatch[3]),
            usd: parseFloat(sellMatch[4]),
            pnl: parseFloat(sellMatch[5]),
            gas: parseFloat(sellMatch[6])
        };
    }

    // BUY: TokenTrader BUY: 75.7292 BTW @ $0.018355 (spent $1.39, gas: $0.0109). Avg entry: ...
    const buyMatch = msg.match(/TokenTrader BUY: ([\d.]+) (\S+) @ \$([\d.]+) \(spent \$([\d.]+), gas: \$([\d.]+)/);
    if (buyMatch) {
        return {
            timestamp,
            side: 'BUY',
            token: buyMatch[2].replace(/^\$/, ''),
            amount: parseFloat(buyMatch[1]),
            price: parseFloat(buyMatch[3]),
            usd: parseFloat(buyMatch[4]),
            pnl: 0,
            gas: parseFloat(buyMatch[5])
        };
    }

    return null;
}

function scanLogFiles() {
    const trades = [];
    const seen = new Set();

    for (const dir of LOG_DIRS) {
        let files;
        try { files = readdirSync(dir); } catch { continue; }

        for (const file of files) {
            const fullPath = join(dir, file);
            try {
                const stat = statSync(fullPath);
                if (!stat.isFile() || stat.size > 100 * 1024 * 1024) continue; // skip >100MB
            } catch { continue; }

            let content;
            try { content = readFileSync(fullPath, 'utf-8'); } catch { continue; }

            // Only process files that contain trade lines
            if (!content.includes('TokenTrader BUY') && !content.includes('TokenTrader SELL')) continue;

            const lines = content.split('\n');
            for (const line of lines) {
                const trade = parseTradeLine(line);
                if (!trade) continue;

                // Dedup by key
                const key = `${trade.timestamp}:${trade.side}:${trade.token}:${trade.usd}`;
                if (seen.has(key)) continue;
                seen.add(key);
                trades.push(trade);
            }
        }
    }

    trades.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return trades;
}

async function getActualTokenTraderPnL() {
    // Fetch from the running app's API
    const port = process.env.AGENT_PORT || 80;
    try {
        // Login to get token
        const loginResp = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: process.env.WEB_PASSWORD || 'lanagent' })
        });
        const loginData = await loginResp.json();
        if (!loginData.token) throw new Error('No token');

        // Get strategy status
        const statusResp = await fetch(`http://127.0.0.1:${port}/api/crypto/strategy/status`, {
            headers: { 'Authorization': `Bearer ${loginData.token}` }
        });
        const statusData = await statusResp.json();

        // Compute same way as populatePnLDashboard
        const state = statusData.state || {};
        const stratPnL = state.totalPnL || 0;
        let ttPnL = 0;
        const ttStatus = statusData.tokenTraderStatus || {};
        for (const [key, val] of Object.entries(ttStatus)) {
            if (key.startsWith('0x') && val && val.pnl) {
                const lr = val.pnl.lifetimeRealized != null ? val.pnl.lifetimeRealized : (val.pnl.realized || 0);
                ttPnL += lr + (val.pnl.unrealized || 0);
            }
        }
        return stratPnL + ttPnL;
    } catch (err) {
        console.warn('Could not fetch actual P&L from running app:', err.message);
        return null;
    }
}

async function main() {
    console.log('Scanning log files for trades...');
    const trades = scanLogFiles();
    console.log(`Found ${trades.length} unique trades`);

    if (trades.length === 0) {
        console.log('No trades found in logs. Nothing to backfill.');
        process.exit(0);
    }

    console.log(`Date range: ${trades[0].timestamp.slice(0, 10)} to ${trades[trades.length - 1].timestamp.slice(0, 10)}`);
    console.log(`BUYs: ${trades.filter(t => t.side === 'BUY').length}, SELLs: ${trades.filter(t => t.side === 'SELL').length}`);

    // Aggregate by day
    const dailyMap = new Map();
    for (const t of trades) {
        const day = t.timestamp.slice(0, 10);
        if (!dailyMap.has(day)) {
            dailyMap.set(day, { realizedPnL: 0, gasCost: 0, buyCount: 0, sellCount: 0, buyVolume: 0, sellVolume: 0 });
        }
        const d = dailyMap.get(day);
        d.gasCost += t.gas;
        if (t.side === 'SELL') {
            d.realizedPnL += t.pnl;
            d.sellCount++;
            d.sellVolume += t.usd;
        } else {
            d.buyCount++;
            d.buyVolume += t.usd;
        }
    }

    // Sort days and compute cumulative
    const days = Array.from(dailyMap.entries()).sort(([a], [b]) => a.localeCompare(b));

    // Get actual token trader P&L for calibration
    const actualPnL = await getActualTokenTraderPnL();

    // Raw cumulative from logs
    let rawCumulative = 0;
    for (const [, d] of days) {
        rawCumulative += d.realizedPnL - d.gasCost;
    }

    // Pre-log offset: difference between actual and what logs account for
    // This represents losses from before the log period (token switches, etc.)
    const offset = actualPnL !== null ? actualPnL - rawCumulative : 0;

    console.log(`\nRaw cumulative from logs: $${rawCumulative.toFixed(2)}`);
    if (actualPnL !== null) {
        console.log(`Actual token trader P&L: $${actualPnL.toFixed(2)}`);
        console.log(`Pre-log offset: $${offset.toFixed(2)}`);
    }

    // Build records with offset applied to first day
    const records = [];
    let cumulative = offset; // Start from the offset
    for (const [date, d] of days) {
        const dailyNet = d.realizedPnL - d.gasCost;
        cumulative += dailyNet;
        records.push({
            date,
            realizedPnL: d.realizedPnL,
            gasCost: d.gasCost,
            dailyNet,
            cumulativePnL: cumulative,
            buyCount: d.buyCount,
            sellCount: d.sellCount,
            buyVolume: d.buyVolume,
            sellVolume: d.sellVolume,
            source: 'backfill'
        });
    }

    console.log('\nDaily P&L:');
    for (const r of records) {
        console.log(`  ${r.date}: realized=$${r.realizedPnL.toFixed(2)} gas=-$${r.gasCost.toFixed(2)} net=$${r.dailyNet.toFixed(2)} cumulative=$${r.cumulativePnL.toFixed(2)} (${r.buyCount}B/${r.sellCount}S)`);
    }

    if (dryRun) {
        console.log('\n--dry-run: no changes written to database');
        process.exit(0);
    }

    // Write to MongoDB
    console.log(`\nConnecting to MongoDB...`);
    await mongoose.connect(MONGODB_URI);

    const { default: DailyPnL } = await import('../src/models/DailyPnL.js');

    let inserted = 0, updated = 0;
    for (const r of records) {
        const existing = await DailyPnL.findOne({ date: r.date });
        if (existing) {
            // Only update backfill records, don't overwrite live data
            if (existing.source === 'backfill' || existing.source === undefined) {
                await DailyPnL.updateOne({ date: r.date }, r);
                updated++;
            }
        } else {
            await DailyPnL.create(r);
            inserted++;
        }
    }

    console.log(`\nBackfill complete: ${inserted} inserted, ${updated} updated`);
    await mongoose.disconnect();
}

main().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
