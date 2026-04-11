#!/usr/bin/env node
// Comprehensive crypto PnL audit - runs on production server
import fs from 'fs';
import http from 'http';

const API_KEY = '${LANAGENT_API_KEY:-your-api-key}';

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost${path}`, { headers: { 'X-API-Key': API_KEY } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', 'Content-Length': postData.length }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('============================================');
  console.log('  CRYPTO FULL AUDIT');
  console.log('============================================\n');

  // 1. Token Trader PnL
  console.log('=== 1. TOKEN TRADER PnL ===');
  const tt = await apiGet('/api/crypto/strategy/token-trader/status');
  const pos = tt.position || {};
  const pnl = tt.pnl || {};
  const tracking = tt.tracking || {};
  const rp = pnl.realized || 0;
  const up = pnl.unrealized || 0;
  const tp = pnl.total || 0;

  console.log(`  Realized: $${rp.toFixed(4)}  Unrealized: $${up.toFixed(4)}  Total: $${tp.toFixed(4)}`);
  console.log(`  Check r+u: ${(rp+up).toFixed(4)} vs ${tp.toFixed(4)} -> ${Math.abs(rp+up-tp) < 0.01 ? 'MATCH' : 'MISMATCH!'}`);

  const bal = pos.tokenBalance || 0;
  const entry = pos.averageEntryPrice || 0;
  const lp = tt.currentPrice || tt.lastPrice || 0;
  const ucalc = (lp - entry) * bal;
  console.log(`  Unrealized check: (${lp.toFixed(6)} - ${entry.toFixed(6)}) x ${bal.toFixed(2)} = $${ucalc.toFixed(4)} vs $${up.toFixed(4)} -> ${Math.abs(ucalc-up) < 1 ? 'MATCH' : 'MISMATCH!'}`);
  console.log(`  Position: ${bal.toFixed(2)} SIREN @ $${entry.toFixed(6)}, peak $${(tracking.peakPrice||0).toFixed(6)}, regime ${tt.regime}`);
  console.log(`  Reserve: $${(pos.stablecoinReserve||0).toFixed(2)}, Gas: $${(pnl.totalGasCost||0).toFixed(4)}`);
  console.log(`  Scale-outs: ${JSON.stringify(tracking.scaleOutLevelsHit)}`);
  console.log(`  TotalInvested: $${(pos.totalInvested||0).toFixed(2)}, TotalReceived: $${(pos.totalReceived||0).toFixed(2)}`);
  console.log(`  Cash flow diff: $${((pos.totalReceived||0)-(pos.totalInvested||0)).toFixed(2)}`);

  // Token value
  const tokenVal = bal * lp;
  const totalVal = (pos.stablecoinReserve||0) + tokenVal;
  console.log(`  Token value: $${tokenVal.toFixed(2)}, Total position value: $${totalVal.toFixed(2)}`);
  console.log();

  // 2. Trade log verification
  console.log('=== 2. TRADE LOG PnL VERIFICATION ===');
  const sellRe = /TokenTrader SELL: ([\d.]+) (\w+) @ \$([\d.]+) \(received \$([\d.]+), PnL: \$([-\d.]+), gas: \$([\d.]+)\)/;
  const buyRe = /TokenTrader BUY: ([\d.]+) (\w+) @ \$([\d.]+) \(spent \$([\d.]+), gas: \$([\d.]+)\)/;

  const stats = { FHE: { buys: 0, sells: 0, spent: 0, received: 0, pnl: 0, gas: 0 },
                  SIREN: { buys: 0, sells: 0, spent: 0, received: 0, pnl: 0, gas: 0 } };

  const logFiles = ['logs/crypto.log', 'logs/all-activity1.log', 'logs/all-activity2.log', 'logs/all-activity.log'];
  const seenLines = new Set(); // dedupe across log files

  for (const logFile of logFiles) {
    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      for (const line of content.split('\n')) {
        if (seenLines.has(line)) continue;

        let m = line.match(sellRe);
        if (m) {
          seenLines.add(line);
          const token = m[2];
          if (stats[token]) {
            stats[token].sells++;
            stats[token].received += parseFloat(m[4]);
            stats[token].pnl += parseFloat(m[5]);
            stats[token].gas += parseFloat(m[6]);
          }
          continue;
        }

        m = line.match(buyRe);
        if (m) {
          seenLines.add(line);
          const token = m[2];
          if (stats[token]) {
            stats[token].buys++;
            stats[token].spent += parseFloat(m[4]);
            stats[token].gas += parseFloat(m[6]);
          }
        }
      }
    } catch(e) { /* file not found, skip */ }
  }

  for (const [token, s] of Object.entries(stats)) {
    console.log(`  ${token}: ${s.buys} buys ($${s.spent.toFixed(2)} spent), ${s.sells} sells ($${s.received.toFixed(2)} rcvd), PnL sum: $${s.pnl.toFixed(4)}, gas: $${s.gas.toFixed(4)}`);
  }
  const combinedPnl = stats.FHE.pnl + stats.SIREN.pnl;
  console.log(`  Combined PnL from logs: $${combinedPnl.toFixed(4)}`);
  console.log(`  Reported realized PnL:  $${rp.toFixed(4)}`);
  console.log(`  Difference: $${Math.abs(combinedPnl - rp).toFixed(4)} ${Math.abs(combinedPnl - rp) < 1 ? '-> MATCH' : '-> CHECK'}`);
  console.log();

  // 3. Dollar Maximizer
  console.log('=== 3. DOLLAR MAXIMIZER ===');
  const strat = await apiGet('/api/crypto/strategy/status');
  const si = strat.strategyInfo || {};
  const dmState = si.state || {};
  console.log(`  PnL: $${(dmState.totalPnL||0).toFixed(4)}, Trades: ${dmState.tradesExecuted||0} executed / ${dmState.tradesProposed||0} proposed`);
  for (const [net, p] of Object.entries(dmState.positions || {})) {
    console.log(`  ${net}: $${(p.stablecoinAmount||0).toFixed(2)} stablecoin, ${(p.nativeAmount||0).toFixed(6)} native, entry $${(p.entryPrice||0).toFixed(2)}`);
  }
  console.log();

  // 4. On-chain vs state
  console.log('=== 4. ON-CHAIN vs STATE BALANCES ===');
  const stables = await apiGet('/api/crypto/stablecoin-balances');
  const wallet = await apiGet('/api/crypto/status');

  console.log('  On-chain:');
  for (const [net, tokens] of Object.entries(stables.balances || {})) {
    for (const [tok, amt] of Object.entries(tokens)) {
      console.log(`    ${net} ${tok}: ${parseFloat(amt).toFixed(2)}`);
    }
  }
  for (const [net, amt] of Object.entries(wallet.balances || {})) {
    if (parseFloat(amt) > 0) console.log(`    ${net} native: ${amt}`);
  }

  console.log('  State:');
  const dmBsc = (dmState.positions?.bsc?.stablecoinAmount || 0);
  const ttReserve = pos.stablecoinReserve || 0;
  console.log(`    DM BSC stablecoin state: $${dmBsc.toFixed(2)}`);
  console.log(`    TT stablecoin reserve:   $${ttReserve.toFixed(2)}`);
  const onChainBsc = parseFloat(Object.values(stables.balances?.bsc || {})[0] || 0);
  console.log(`    On-chain BSC stablecoin:  $${onChainBsc.toFixed(2)}`);
  const diff = dmBsc + ttReserve - onChainBsc;
  console.log(`    DM + TT state sum:        $${(dmBsc + ttReserve).toFixed(2)}`);
  if (Math.abs(diff) > 1) {
    console.log(`    DISCREPANCY: $${diff.toFixed(2)} (state shows more than on-chain)`);
  } else {
    console.log(`    MATCH (within $1)`);
  }
  console.log();

  // 5. Web UI endpoints
  console.log('=== 5. WEB UI ENDPOINTS ===');
  const loginResp = await apiPost('/api/auth/login', { password: 'lanagent' });
  const jwt = loginResp.token;

  const endpoints = [
    '/api/crypto/status',
    '/api/crypto/strategy/status',
    '/api/crypto/strategy/token-trader/status',
    '/api/crypto/stablecoin-balances',
    '/api/crypto/network-mode',
    '/api/crypto/transactions',
    '/api/crypto/strategy/config',
    '/api/crypto/settings/disabled-networks',
    '/api/subagents/crypto/status',
  ];

  for (const ep of endpoints) {
    try {
      const resp = await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost${ep}`, {
          headers: { 'Authorization': `Bearer ${jwt}`, 'X-API-Key': API_KEY }
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => { resolve({ status: res.statusCode, size: data.length, data: data }); });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      let parsed;
      try { parsed = JSON.parse(resp.data); } catch(e) { parsed = {}; }
      const success = parsed.success;
      const error = parsed.error;
      if (success === true) {
        console.log(`  OK   ${ep} (${resp.size}B)`);
      } else if (error) {
        console.log(`  FAIL ${ep} -> ${error}`);
      } else {
        console.log(`  ${resp.status === 200 ? 'OK?' : '???'}  ${ep} (${resp.size}B, status=${resp.status})`);
      }
    } catch(e) {
      console.log(`  ERR  ${ep} -> ${e.message}`);
    }
  }
  console.log();

  // 6. Transactions
  console.log('=== 6. TRANSACTIONS ===');
  try {
    const txResp = await new Promise((resolve, reject) => {
      const req = http.get('http://localhost/api/crypto/transactions', {
        headers: { 'Authorization': `Bearer ${jwt}`, 'X-API-Key': API_KEY }
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { resolve(JSON.parse(data)); });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    if (Array.isArray(txResp)) {
      console.log(`  Total: ${txResp.length} transactions`);
      const buys = txResp.filter(t => (t.type||'').includes('buy'));
      const sells = txResp.filter(t => (t.type||'').includes('sell'));
      console.log(`  Buys: ${buys.length}, Sells: ${sells.length}`);
      if (txResp.length > 0) {
        const last = txResp[txResp.length - 1];
        console.log(`  Last: ${last.timestamp||'?'} ${last.type||'?'} ${last.amount||'?'} ${last.symbol||last.token||'?'}`);
      }
    } else if (txResp.transactions || txResp.data) {
      const txs = txResp.transactions || txResp.data;
      console.log(`  Total: ${Array.isArray(txs) ? txs.length : 'non-array'} transactions`);
    } else {
      console.log(`  Response keys: ${Object.keys(txResp)}`);
    }
  } catch(e) {
    console.log(`  Error: ${e.message}`);
  }

  console.log();
  console.log('============================================');
  console.log('  AUDIT COMPLETE');
  console.log('============================================');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
