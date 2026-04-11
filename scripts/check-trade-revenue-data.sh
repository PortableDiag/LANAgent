#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

echo "=== 1. Transaction history (what the strategy has executed) ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/transactions" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    if isinstance(d, list):
        print(f'Total transactions: {len(d)}')
        for tx in d[:5]:
            print(f'  type={tx.get(\"type\")}, chain={tx.get(\"chain\")}, amount={tx.get(\"amount\")}, hash={str(tx.get(\"hash\",\"\"))[:20]}..., status={tx.get(\"status\")}')
        if len(d) > 5:
            print(f'  ... and {len(d)-5} more')
    else:
        print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 2. Revenue records in DB ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/revenue/records" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(f'success: {d.get(\"success\")}')
    data = d.get('data', [])
    print(f'records: {len(data)}')
    for r in data[:3]:
        print(f'  type={r.get(\"type\")}, cat={r.get(\"category\")}, amt={r.get(\"amount\")}, usd={r.get(\"usdValue\")}')
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 3. Revenue import endpoint test (ethereum) ==="
$SSH "curl -s -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"network\":\"ethereum\"}' http://localhost/api/revenue/import/wallet" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 4. Check what trade data the strategy stores ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/strategy/status" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    s=d.get('state',{})
    print('tradesExecuted:', s.get('tradesExecuted'))
    print('tradesProposed:', s.get('tradesProposed'))
    print('totalPnL:', s.get('totalPnL'))
    print('dailyPnL:', s.get('dailyPnL'))
    trades = s.get('tradeHistory', s.get('recentTrades', s.get('trades', [])))
    print(f'tradeHistory/recentTrades: {len(trades) if isinstance(trades, list) else trades}')
    if isinstance(trades, list) and len(trades) > 0:
        print('  sample:', json.dumps(trades[0])[:200])
    # Check all state keys
    print('state keys:', list(s.keys()))
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 5. Check revenue API routes ==="
$SSH "grep -n 'router\.\(get\|post\).*revenue\|import.*wallet' $PRODUCTION_PATH/src/api/revenue.js 2>/dev/null || echo 'No revenue.js found'" 2>/dev/null | head -20

echo ""
echo "=== 6. Check if revenue service exists and what it does for import ==="
$SSH "grep -rn 'import.*wallet\|importWallet\|importTransactions' $PRODUCTION_PATH/src/services/revenue/ 2>/dev/null || echo 'No revenue service found'" 2>/dev/null | head -10
