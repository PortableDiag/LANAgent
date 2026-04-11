#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== 1. Revenue Summary (revenue) ==="
START=$(date -d '30 days ago' -Iseconds 2>/dev/null)
END=$(date -Iseconds 2>/dev/null)
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/revenue?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print('Parse error:', e)
    print(sys.stdin.read()[:200])
" 2>/dev/null

echo ""
echo "=== 2. Revenue Summary (expense) ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/expense?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print('Parse error:', e)
    print(sys.stdin.read()[:200])
" 2>/dev/null

echo ""
echo "=== 3. Profit-Loss Report ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/report/profit-loss?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print('Parse error:', e)
    print(sys.stdin.read()[:200])
" 2>/dev/null

echo ""
echo "=== 4. Revenue Records ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/records'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print('Parse error:', e)
    print(sys.stdin.read()[:200])
" 2>/dev/null

echo ""
echo "=== 5. Revenue Categories (revenue) ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/categories/revenue'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print('Parse error:', e)
    print(sys.stdin.read()[:200])
" 2>/dev/null

echo ""
echo "=== 6. Revenue Categories (expense) ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/categories/expense'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:500])
except Exception as e:
    print('Parse error:', e)
    print(sys.stdin.read()[:200])
" 2>/dev/null

echo ""
echo "=== 7. Check all /api/revenue routes exist ==="
for route in "summary/revenue" "summary/expense" "report/profit-loss" "records" "categories/revenue" "categories/expense"; do
    STATUS=$($SSH "curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/${route}?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null)
    echo "  /api/revenue/${route} => ${STATUS}"
done

echo ""
echo "=== 8. Check JS console errors (loadRevenueData in deployed app.js) ==="
$SSH "grep -n 'loadRevenueData' $PRODUCTION_PATH/src/interfaces/web/public/app.js" 2>/dev/null | head -10

echo ""
echo "=== 9. Check HTML onclick handlers ==="
$SSH "grep -n 'cryptoManager\.\(showAdd\|importWallet\|exportRevenue\|updateRevenue\|applyCustom\|filterRevenue\)' $PRODUCTION_PATH/src/interfaces/web/public/index.html" 2>/dev/null

echo ""
echo "=== 10. Verify those methods exist in DOMContentLoaded branch ==="
for method in showAddRevenueDialog showAddExpenseDialog importWalletTransactions exportRevenueCSV updateRevenuePeriod applyCustomDateRange filterRevenueTransactions updateRevenueGrouping; do
    COUNT=$($SSH "grep -c '${method}:' $PRODUCTION_PATH/src/interfaces/web/public/app.js" 2>/dev/null)
    echo "  ${method}: ${COUNT} definitions (need 2 = both branches)"
done

echo ""
echo "=== 11. Recent errors since last restart ==="
$SSH "grep -i 'revenue\|error.*revenue' $PRODUCTION_PATH/logs/errors.log 2>/dev/null | tail -5"
$SSH "grep -i 'revenue\|error.*revenue' $PRODUCTION_PATH/logs/api-web.log 2>/dev/null | tail -5"
echo "(empty = no revenue errors)"
