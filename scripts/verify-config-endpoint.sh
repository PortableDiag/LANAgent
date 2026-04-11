#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== 1. POST /strategy/config (dailyPnLReport=false) ==="
$SSH "curl -s -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"dailyPnLReport\":false}' http://localhost/api/crypto/strategy/config" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:300])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 2. POST /strategy/config (dailyReportTime=08:00) ==="
$SSH "curl -s -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"dailyReportTime\":\"08:00\"}' http://localhost/api/crypto/strategy/config" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:300])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 3. Verify config persisted ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/strategy/status" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    c=d.get('config',{})
    print('dailyPnLReport:', c.get('dailyPnLReport'))
    print('dailyReportTime:', c.get('dailyReportTime'))
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 4. Check app.js deployed correctly (grep for POST in toggleDailyReport) ==="
$SSH "grep -A2 'toggleDailyReport' $PRODUCTION_PATH/src/interfaces/web/public/app.js | head -10" 2>/dev/null
