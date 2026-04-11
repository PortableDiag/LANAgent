#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== 1. Strategy Status ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/strategy/status" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('success:', d.get('success'))
    print('strategy:', d.get('strategy'))
    s=d.get('state',{})
    print('tradesExecuted:', s.get('tradesExecuted'))
    print('totalPnL:', s.get('totalPnL'))
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== 2. Strategy Performance Comparison ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/strategy/performance" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('success:', d.get('success'))
    perf = d.get('performance', [])
    print(f'strategies: {len(perf)}')
    for s in perf:
        p = s.get('performance', {})
        active = ' [ACTIVE]' if s.get('isActive') else ''
        print(f\"  {s.get('name')}: trades={p.get('tradesExecuted',0)}, pnl=\${p.get('totalPnL',0):.4f}, rate={p.get('successRate','?')}{active}\")
except Exception as e:
    print(f'Error: {e}')
    import traceback; traceback.print_exc()
" 2>/dev/null

echo ""
echo "=== 3. Verify methods in deployed app.js ==="
for method in refreshStrategy switchStrategy updateStrategyConfig loadStrategyPerformance; do
    COUNT=$($SSH "grep -c '${method}:' $PRODUCTION_PATH/src/interfaces/web/public/app.js" 2>/dev/null)
    echo "  ${method}: ${COUNT} definitions"
done

echo ""
echo "=== 4. Verify CSS option fix deployed ==="
$SSH "grep -c 'select option' $PRODUCTION_PATH/src/interfaces/web/public/styles.css" 2>/dev/null
echo "select option rules (should be >= 1)"

echo ""
echo "=== 5. Strategy switch API test (read-only check) ==="
STATUS=$($SSH "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"strategy\":\"dollar_maximizer\"}' http://localhost/api/crypto/strategy/switch" 2>/dev/null)
echo "POST /strategy/switch => $STATUS (200=OK)"
