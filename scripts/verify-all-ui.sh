#!/bin/bash
# Comprehensive verification: P&L dashboard, stablecoin balances, revenue tracking, daily report
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

echo "=== Waiting for web server ==="
for i in $(seq 1 30); do
    STATUS=$($SSH "curl -s -o /dev/null -w '%{http_code}' http://localhost/" 2>/dev/null)
    if [ "$STATUS" = "200" ]; then
        echo "Web server ready (attempt $i)"
        break
    fi
    echo "Waiting... ($i/30, status=$STATUS)"
    sleep 5
done

# Get JWT token
TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then
    echo "FAIL: Could not get JWT token"
    exit 1
fi
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== 1. STRATEGY STATUS (P&L Dashboard data) ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/strategy/status" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('success:', d.get('success'))
    print('strategy:', d.get('strategy'))
    s=d.get('state',{})
    print('totalPnL:', s.get('totalPnL'))
    print('dailyPnL:', s.get('dailyPnL'))
    print('tradesExecuted:', s.get('tradesExecuted'))
    print('tradesProposed:', s.get('tradesProposed'))
    p=s.get('positions',{})
    for net,pos in p.items():
        print(f'  position[{net}]: inStable={pos.get(\"inStablecoin\")}, entry=\${pos.get(\"entryPrice\")}')
    c=d.get('config',{})
    print('config.dailyPnLReport:', c.get('dailyPnLReport'))
    print('config.dailyReportTime:', c.get('dailyReportTime'))
except Exception as e:
    print(f'Error: {e}')
    print(sys.stdin.read()[:200] if hasattr(sys.stdin, 'read') else '')
" 2>/dev/null

echo ""
echo "=== 2. STABLECOIN BALANCES API ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/stablecoin-balances" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 3. REVENUE API (summary/revenue) ==="
START=$(date -d '30 days ago' -Iseconds 2>/dev/null || date -v-30d +%Y-%m-%dT%H:%M:%S 2>/dev/null)
END=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S 2>/dev/null)
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/revenue?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 4. REVENUE API (profit-loss report) ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/report/profit-loss?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 5. STRATEGY CONFIG API (PUT test - read only) ==="
echo "(Testing that the config endpoint exists)"
$SSH "curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"dailyPnLReport\":false}' http://localhost/api/crypto/strategy/config" 2>/dev/null
echo ""

echo ""
echo "=== 6. CHECK app.js HAS REVENUE METHODS IN DOMCONTENTLOADED BRANCH ==="
grep -c 'loadRevenueData:' /media/veracrypt1/NodeJS/LANAgent/src/interfaces/web/public/app.js
echo "loadRevenueData count (should be 2 - one in each branch)"
grep -c 'toggleDailyReport:' /media/veracrypt1/NodeJS/LANAgent/src/interfaces/web/public/app.js
echo "toggleDailyReport count (should be 2)"
grep -c 'showAddRevenueDialog:' /media/veracrypt1/NodeJS/LANAgent/src/interfaces/web/public/app.js
echo "showAddRevenueDialog count (should be 2)"

echo ""
echo "=== 7. PM2 STATUS ==="
$SSH "pm2 list --no-color" 2>/dev/null | grep lan-agent

echo ""
echo "=== 8. RECENT ERRORS ==="
$SSH "tail -5 $PRODUCTION_PATH/logs/errors.log" 2>/dev/null
