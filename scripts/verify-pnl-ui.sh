#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""
API="curl -s -H X-API-Key:${LANAGENT_API_KEY:-your-api-key}"

echo "=== 1. RAW API RESPONSE (strategy/status) ==="
$SSH "$API http://localhost/api/crypto/strategy/status" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('success:', d.get('success'))
    print('strategy:', d.get('strategy'))
    s=d.get('state',{})
    print('state.totalPnL:', s.get('totalPnL'))
    print('state.dailyPnL:', s.get('dailyPnL'))
    print('state.tradesExecuted:', s.get('tradesExecuted'))
    print('state.tradesProposed:', s.get('tradesProposed'))
    print('state.positions:', json.dumps(s.get('positions',{}))[:300])
    print('state.priceBaselines:', json.dumps(s.get('priceBaselines',{}))[:200])
    c=d.get('config',{})
    print('config.dailyPnLReport:', c.get('dailyPnLReport'))
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 2. AUTH TEST (with JWT token) ==="
TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "Token obtained: $(echo $TOKEN | head -c 20)..."
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/strategy/status" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('With JWT - success:', d.get('success'))
    print('With JWT - state.totalPnL:', d.get('state',{}).get('totalPnL'))
    print('With JWT - state.tradesExecuted:', d.get('state',{}).get('tradesExecuted'))
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 3. STABLECOIN BALANCES API ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/stablecoin-balances" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 4. NO-AUTH TEST (what browser gets without token) ==="
$SSH "curl -s http://localhost/api/crypto/strategy/status" 2>/dev/null | head -c 200
echo ""

echo ""
echo "=== 5. SEARCH FOR REVENUE TRACKING SECTION ==="
grep -n -i 'revenue\|Revenue Tracking\|revenueData\|loadRevenue' /media/veracrypt1/NodeJS/LANAgent/src/interfaces/web/public/index.html | head -15
echo "---"
grep -n -i 'revenue\|loadRevenue\|revenueData\|Revenue Tracking' /media/veracrypt1/NodeJS/LANAgent/src/interfaces/web/public/app.js | head -15
