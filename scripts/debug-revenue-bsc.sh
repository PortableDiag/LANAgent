#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

echo "=== 1. Revenue API raw response (full) ==="
START="2025-01-01T00:00:00.000Z"
END="2027-01-01T00:00:00.000Z"
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/revenue?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null
echo ""

echo ""
echo "=== 2. Revenue records raw ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/records'" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'success={d.get(\"success\")}, records={len(d.get(\"data\",[]))}')
" 2>/dev/null

echo ""
echo "=== 3. Check if auto-sync ran (look for log) ==="
$SSH "grep -i 'auto-sync\|Revenue auto' $PRODUCTION_PATH/logs/all-activity.log 2>/dev/null | tail -5"
echo "(checking api-web log too)"
$SSH "grep -i 'auto-sync\|Revenue auto' $PRODUCTION_PATH/logs/api-web.log 2>/dev/null | tail -5"

echo ""
echo "=== 4. Check for revenue errors ==="
$SSH "grep -i 'revenue\|revenueService' $PRODUCTION_PATH/logs/errors.log 2>/dev/null | tail -5"
echo "(empty = no errors)"

echo ""
echo "=== 5. BSC position entry price from strategy status ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/strategy/status" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('state',{})
pos=s.get('positions',{})
baselines=s.get('priceBaselines',{})
for net in ['ethereum','bsc']:
    p=pos.get(net,{})
    b=baselines.get(net,{})
    print(f'{net}: entryPrice={p.get(\"entryPrice\")}, inStable={p.get(\"inStablecoin\")}, stableAmt={p.get(\"stablecoinAmount\")}')
    print(f'  baseline: price={b.get(\"price\")}, timestamp={b.get(\"timestamp\")}')
" 2>/dev/null

echo ""
echo "=== 6. Verify deployed revenueService has syncFromCryptoTransactions ==="
$SSH "grep -c 'syncFromCryptoTransactions' $PRODUCTION_PATH/src/services/crypto/revenueService.js" 2>/dev/null
echo "occurrences (should be 5+)"

echo ""
echo "=== 7. Verify deployed app.js loadRevenueData references ==="
$SSH "grep -n 'loadRevenueData' $PRODUCTION_PATH/src/interfaces/web/public/app.js" 2>/dev/null | head -5

echo ""
echo "=== 8. Test what the browser's loadRevenueData would get ==="
NOW_MONTH_START=$(date -d "$(date +%Y-%m-01)" -Iseconds 2>/dev/null)
NOW=$(date -Iseconds 2>/dev/null)
echo "Date range: $NOW_MONTH_START to $NOW"
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/revenue?startDate=${NOW_MONTH_START}&endDate=${NOW}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('success:', d.get('success'))
data=d.get('data',{})
print('totalUSD:', data.get('totalUSD'))
print('count:', data.get('count'))
" 2>/dev/null
