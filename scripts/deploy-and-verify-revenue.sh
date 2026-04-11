#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

echo "=== Deploying revenueService.js ==="
sshpass -p "$PRODUCTION_PASS" scp src/services/crypto/revenueService.js $PRODUCTION_USER@$PRODUCTION_SERVER:$PRODUCTION_PATH/src/services/crypto/revenueService.js

echo "=== Restarting PM2 ==="
$SSH "source ~/.nvm/nvm.sh && nvm use 20 && cd $PRODUCTION_PATH && pm2 restart ecosystem.config.cjs" 2>/dev/null

echo "=== Waiting for web server ==="
for i in $(seq 1 30); do
    STATUS=$($SSH "curl -s -o /dev/null -w '%{http_code}' http://localhost/" 2>/dev/null)
    if [ "$STATUS" = "200" ]; then
        echo "Web server ready (attempt $i)"
        break
    fi
    echo "Waiting... ($i/30)"
    sleep 5
done

TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== Revenue Summary (should auto-sync from crypto transactions) ==="
START=$(date -d '365 days ago' -Iseconds 2>/dev/null)
END=$(date -Iseconds 2>/dev/null)
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/revenue?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:600])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== Expense Summary ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/expense?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:600])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== Profit-Loss Report ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/report/profit-loss?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    data = d.get('data', {})
    print(f'Revenue: \${data.get(\"revenue\",{}).get(\"total\",0):.4f} ({data.get(\"revenue\",{}).get(\"count\",0)} records)')
    print(f'Expenses: \${data.get(\"expenses\",{}).get(\"total\",0):.4f} ({data.get(\"expenses\",{}).get(\"count\",0)} records)')
    print(f'Net Profit: \${data.get(\"netProfit\",0):.4f}')
    print(f'Margin: {data.get(\"profitMargin\",\"?\")}')
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== Revenue Records ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/records'" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    data = d.get('data', [])
    print(f'Total records: {len(data)}')
    for r in data[:5]:
        print(f'  {r.get(\"type\")}: {r.get(\"category\")} | {r.get(\"amount\")} {r.get(\"tokenSymbol\",\"\")} | \${r.get(\"usdValue\",0):.4f} | {r.get(\"network\")} | {r.get(\"description\",\"\")[:50]}')
    if len(data) > 5:
        print(f'  ... and {len(data)-5} more')
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== Recent logs (auto-sync) ==="
$SSH "grep -i 'auto-sync\|revenue.*sync' $PRODUCTION_PATH/logs/all-activity.log 2>/dev/null | tail -5"
$SSH "grep -i 'revenue' $PRODUCTION_PATH/logs/errors.log 2>/dev/null | tail -3"

echo ""
echo "=== PM2 Status ==="
$SSH "pm2 list --no-color" 2>/dev/null | grep lan-agent
