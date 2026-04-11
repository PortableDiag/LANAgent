#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

echo "=== Deploying 3 files ==="
sshpass -p "$PRODUCTION_PASS" scp src/interfaces/web/public/app.js $PRODUCTION_USER@$PRODUCTION_SERVER:$PRODUCTION_PATH/src/interfaces/web/public/app.js
sshpass -p "$PRODUCTION_PASS" scp src/services/subagents/CryptoStrategyAgent.js $PRODUCTION_USER@$PRODUCTION_SERVER:$PRODUCTION_PATH/src/services/subagents/CryptoStrategyAgent.js
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

echo ""
echo "=== 1. Revenue data (auto-synced from transactions) ==="
START="2025-01-01T00:00:00.000Z"
END="2027-01-01T00:00:00.000Z"
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/report/profit-loss?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
data=d.get('data',{})
print(f'Revenue: \${data.get(\"revenue\",{}).get(\"total\",0):.2f} ({data.get(\"revenue\",{}).get(\"count\",0)} records)')
print(f'Expenses: \${data.get(\"expenses\",{}).get(\"total\",0):.2f} ({data.get(\"expenses\",{}).get(\"count\",0)} records)')
print(f'Net Profit: \${data.get(\"netProfit\",0):.2f}')
print(f'Margin: {data.get(\"profitMargin\",\"?\")}%')
" 2>/dev/null

echo ""
echo "=== 2. BSC position entry price ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/strategy/status" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
for net in ['ethereum','bsc']:
    pos=d.get('state',{}).get('positions',{}).get(net,{})
    bl=d.get('state',{}).get('priceBaselines',{}).get(net,{})
    print(f'{net}: entryPrice={pos.get(\"entryPrice\")}, baseline={bl.get(\"price\")}')
" 2>/dev/null

echo ""
echo "=== 3. Verify loadRevenueDataForDashboard in deployed app.js ==="
$SSH "grep -c 'loadRevenueDataForDashboard' $PRODUCTION_PATH/src/interfaces/web/public/app.js" 2>/dev/null
echo "occurrences (should be 2+: definition + call)"

echo ""
echo "=== 4. Check for null entryPrice fix log ==="
$SSH "grep 'Fixed null entryPrice' $PRODUCTION_PATH/logs/all-activity.log 2>/dev/null | tail -3"
echo "(may not appear until next heartbeat cycle)"

echo ""
echo "=== 5. PM2 status ==="
$SSH "pm2 list --no-color" 2>/dev/null | grep lan-agent

echo ""
echo "=== 6. Recent errors ==="
$SSH "tail -3 $PRODUCTION_PATH/logs/errors.log" 2>/dev/null
