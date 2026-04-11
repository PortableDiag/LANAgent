#!/bin/bash
# Reusable crypto debug/verify script
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""
APIKEY="${LANAGENT_API_KEY:-your-api-key}"

echo "=== Trigger manual strategy run ==="
curl -s -X POST -H "X-API-Key: $APIKEY" http://$PRODUCTION_SERVER/api/crypto/strategy/trigger 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(json.dumps(d, indent=2, default=str)[:500])
except:
    print('(no valid JSON)')
" 2>/dev/null

echo ""
echo "=== Wait 30s for strategy execution ==="
sleep 30

echo ""
echo "=== Strategy logs (last 5min) ==="
eval $SSH "grep -E 'Executing dedicated|Strategy.*result|dollar.max|regime|DollarMax|Holding|trend|regime filter|price=|baseline|priceChange|opportunity' $PRODUCTION_PATH/logs/structured.json 2>/dev/null" | python3 -c "
import sys, json
from datetime import datetime, timedelta, timezone
cutoff = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
count = 0
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        ts = d.get('timestamp','')
        if ts > cutoff:
            tshort = ts[11:19]
            svc = d.get('service','')[:20]
            msg = d.get('message','')[:250]
            print(f'{tshort} [{svc}] {msg}')
            count += 1
    except:
        pass
if count == 0:
    print('(no strategy logs in last 5 min)')
" 2>/dev/null

echo ""
echo "=== Strategy status after run ==="
curl -s -H "X-API-Key: $APIKEY" http://$PRODUCTION_SERVER/api/crypto/strategy/status 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    s = d.get('data', d)
    si = s.get('strategyInfo', {})
    state = si.get('state', {})
    print(f'Strategy: {s.get(\"strategy\", \"?\")}, Mode: {s.get(\"networkMode\", \"?\")}')
    print(f'Trades proposed: {state.get(\"tradesProposed\", 0)}, executed: {state.get(\"tradesExecuted\", 0)}')
    print(f'Last run: {s.get(\"schedule\", {}).get(\"lastRunAt\", \"?\")}')
    # Show positions
    positions = state.get('positions', {})
    for net, pos in positions.items():
        inStable = pos.get('inStablecoin', False)
        stable = pos.get('stablecoinAmount', 0)
        native = pos.get('nativeAmount', 0)
        print(f'  {net}: {\"stablecoin\" if inStable else \"native\"} (stable=${stable:.2f}, native={native:.6f})')
    # Check trendHistory and marketRegime
    th = state.get('trendHistory', {})
    mr = state.get('marketRegime', {})
    if th:
        for k, v in th.items():
            print(f'  TrendHistory[{k}]: {len(v)} points')
    if mr:
        for k, v in mr.items():
            print(f'  Regime[{k}]: {v.get(\"regime\",\"?\")} (score={v.get(\"score\",\"?\")}, conf={v.get(\"confidence\",\"?\")}%)')
    else:
        print('  (no marketRegime in state - may need strategy.getDollarMaxStats())')
except Exception as e:
    print(f'Parse error: {e}')
" 2>/dev/null
