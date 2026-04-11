#!/bin/bash
# Phase 9: Verify EXPIRED fix works - check ETH position and trigger
API="${LANAGENT_API_KEY:-your-api-key}"
HOST="http://$PRODUCTION_SERVER"
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

echo "=== 1. App status ==="
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HOST/" 2>/dev/null)
echo "HTTP: $HTTP_CODE"
if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "302" ]; then
    echo "Waiting for app..."
    for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
        sleep 15
        HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HOST/" 2>/dev/null)
        echo "  HTTP $HTTP_CODE ($(date +%H:%M:%S))"
        if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ]; then break; fi
    done
fi

echo ""
echo "=== 2. Verify EXPIRED fix deployed ==="
echo -n "2hr deadline: "
$SSH "grep -c 'deadlineMinutes' $PRODUCTION_PATH/src/services/crypto/swapService.js" 2>/dev/null
echo -n "TX confirm wait: "
$SSH "grep -c 'confirmation_timeout' $PRODUCTION_PATH/src/services/crypto/swapService.js" 2>/dev/null
echo -n "Received fix: "
$SSH "grep -c 'Only use on-chain balance' $PRODUCTION_PATH/src/services/subagents/CryptoStrategyAgent.js" 2>/dev/null

echo ""
echo "=== 3. Current prices + ETH position ==="
$SSH "grep 'price monitor' $PRODUCTION_PATH/logs/all-activity.log | tail -1" 2>/dev/null

echo ""
echo "=== 4. Current ETH wallet balance ==="
curl -s -X POST https://rpc.ankr.com/eth -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xc0C0D080650C941D8901889248c6eD4C31Ef08F4","latest"],"id":1}' 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
bal_hex = d.get('result', '0x0')
bal_wei = int(bal_hex, 16)
bal_eth = bal_wei / 1e18
print(f'ETH balance: {bal_eth:.6f} ETH')
" 2>/dev/null

echo ""
echo "=== 5. Trigger strategy (will wait for TX confirmation, up to 5 min) ==="
echo "Triggering at $(date)..."
RESULT=$(curl -s --max-time 360 -H "X-API-Key: $API" -H "Content-Type: application/json" -X POST "$HOST/api/crypto/strategy/trigger" -d '{}' 2>&1)
echo "$RESULT" | python3 -c "
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    print(json.dumps(d, indent=2)[:5000])
except:
    print(raw[:5000])
" 2>/dev/null
echo ""
echo "Trigger completed at $(date)"

echo ""
echo "=== 6. Check last 20 strategy lines ==="
$SSH "grep -ia 'dollar.max\|stop.loss\|swap\|sell\|buy\|confirm\|revert\|expired\|timeout\|baseline\|stablecoin\|expectedOut\|On-chain\|position' $PRODUCTION_PATH/logs/all-activity.log | grep -iv 'error-scanner\|revenue\|self-mod\|capability\|upgrade\|analyzing\|ErrorLogScanner' | tail -20" 2>/dev/null

echo ""
echo "=== 7. Check for any new swap TXs ==="
$SSH "grep -ia 'Swap 0x\|Transaction added.*swap\|confirmed\|reverted\|failed' $PRODUCTION_PATH/logs/all-activity.log | tail -10" 2>/dev/null

echo ""
echo "=== 8. Errors ==="
$SSH "tail -5 $PRODUCTION_PATH/logs/errors.log" 2>/dev/null

echo ""
echo "=== Done at $(date) ==="
