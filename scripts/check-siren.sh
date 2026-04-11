#!/bin/bash
# Check SIREN token trader state - quick snapshot
SERVER="http://$PRODUCTION_SERVER"
API_KEY="${LANAGENT_API_KEY:-your-api-key}"
H="X-API-Key: $API_KEY"

echo "=== SIREN Token Trader State ==="
echo ""

# Token trader full status
R=$(curl -s -H "$H" "$SERVER/api/crypto/strategy/token-trader/status")
echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"Token: {d.get('tokenSymbol','?')}\")
print(f\"Network: {d.get('network','?')}\")
print(f\"Balance: {d.get('balance','?')}\")
print(f\"Avg Entry: {d.get('avgEntry','?')}\")
print(f\"Stable Reserve: {d.get('stableReserve','?')}\")
print(f\"Peak Price: {d.get('peakPrice','?')}\")
print(f\"Trailing Stop: {d.get('trailingStop','?')}\")
print(f\"Regime: {d.get('regime','?')}\")
print(f\"Pump Entered: {d.get('pumpEnteredAt','?')}\")
print(f\"Scale Outs Done: {d.get('scaleOutsDone','?')}\")
print()
print('--- Watchlist ---')
for t in d.get('watchlist', []):
    sys = ' [SYSTEM]' if t.get('system') else ''
    print(f\"  {t.get('symbol','?')} ({t.get('network','?')}) addr={t.get('address','?')[:20]}...{sys}\")
print()
print('--- Full JSON ---')
print(json.dumps(d, indent=2))
" 2>/dev/null

echo ""
echo "=== SIREN Trade History (DB) ==="
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source /root/.nvm/nvm.sh && nvm use 20 > /dev/null 2>&1 && node -e \"
import('mongoose').then(async m => {
  await m.default.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent');
  const db = m.default.connection.db;

  // Get strategy config (has token trader state)
  const config = await db.collection('strategyconfigs').findOne({ name: 'token_trader' });
  if (config) {
    console.log('Strategy Config found, token:', config.config?.tokenAddress || 'none');
    console.log('Total trades in journal:', config.state?.journal?.length || 0);
  }

  // Get crypto positions
  const positions = await db.collection('cryptopositions').find({
    strategy: { \\\\\$regex: /token/i }
  }).toArray();
  console.log('CryptoPositions matching token:', positions.length);

  // Get recent trade history
  const trades = await db.collection('cryptotrades').find({}).sort({timestamp: -1}).limit(10).toArray();
  console.log('Recent trades (last 10):');
  for (const t of trades) {
    console.log('  ' + (t.timestamp || t.createdAt) + ' ' + t.type + ' ' + (t.amount || '') + ' ' + (t.symbol || t.token || '') + ' @ ' + (t.price || ''));
  }

  // Get strategy journal entries
  const journal = await db.collection('strategyconfigs').findOne(
    { name: 'token_trader' },
    { projection: { 'state.journal': { \\\\\$slice: -10 } } }
  );
  if (journal?.state?.journal) {
    console.log('\\nRecent journal entries:');
    for (const j of journal.state.journal) {
      console.log('  ' + j.timestamp + ' ' + j.action + ' ' + (j.reason || ''));
    }
  }

  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
\" 2>/dev/null
