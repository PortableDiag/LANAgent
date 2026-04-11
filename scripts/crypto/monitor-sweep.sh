#!/bin/bash
# Monitor token sweep and sell activity on production
# Usage: ./scripts/crypto/monitor-sweep.sh [action]
# Actions: status (default), sweep, deposits, scans, tokens

LOG="$PRODUCTION_PATH/logs/all-activity.log"
ACTION="${1:-status}"

case "$ACTION" in
    status)
        echo "=== Recent sweep activity ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -iE 'residual|sweep' $LOG | tail -15"
        echo ""
        echo "=== Recent deposit processing ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -iE 'Processing deposit|auto.sell|auto_sold' $LOG | tail -10"
        ;;
    sweep)
        echo "=== All sweep actions ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -i 'residual sweep:' $LOG | tail -30"
        ;;
    deposits)
        echo "=== Recent deposits ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -iE 'deposit scan:.*deposit' $LOG | tail -15"
        ;;
    scans)
        echo "=== Token scanner activity ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -iE 'deep scan|explorer.*scan|scan.*complete|scan.*pipeline' $LOG | tail -20"
        ;;
    tokens)
        echo "=== Token classification ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -iE 'analyzed:.*safe.*scam|safe_unknown|Processing deposit' $LOG | tail -20"
        ;;
    errors)
        echo "=== Recent errors ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -iE 'swap failed|sell failed|auto_sell_failed|no viable' $LOG | tail -15"
        ;;
    watch)
        echo "=== Watching live activity (Ctrl+C to stop) ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "tail -f $LOG | grep -iE 'sweep|residual|sell|deposit|deep scan|FHE|BKN|DOLO|SXT|BCUT|TRUF|FOLKS'"
        ;;
    api)
        # Generic API query: ./monitor-sweep.sh api /api/crypto/strategy/token-trader/status
        ENDPOINT="${2:-/api/crypto/strategy/status}"
        TOKEN=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "curl -s --max-time 10 http://127.0.0.1:80/api/auth/login -X POST -H 'Content-Type: application/json' -d '{\"password\":\"lanagent\"}'" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "curl -s --max-time 15 http://127.0.0.1:80${ENDPOINT} -H 'Authorization: Bearer ${TOKEN}'" | python3 -m json.tool 2>/dev/null || echo "Failed or no JSON"
        ;;
    dashboard)
        # Quick dashboard view: token trader instances + watchlist
        TOKEN=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "curl -s --max-time 10 http://127.0.0.1:80/api/auth/login -X POST -H 'Content-Type: application/json' -d '{\"password\":\"lanagent\"}'" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
        echo "=== Token Trader Status ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "curl -s --max-time 15 http://127.0.0.1:80/api/crypto/strategy/token-trader/status -H 'Authorization: Bearer ${TOKEN}'" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
print('Active instances:', d.get('activeInstances',0))
for k,v in d.get('instances',{}).items():
    t=v.get('token',{})
    p=v.get('position',{})
    pnl=v.get('pnl',{})
    lt=(pnl.get('lifetimeRealized') or pnl.get('realized',0))+(pnl.get('unrealized',0))
    print(f'  {t.get(\"symbol\",\"?\")} ({t.get(\"network\",\"?\")}) regime={v.get(\"regime\",\"?\")} bal={p.get(\"tokenBalance\",0):.4f} pnl=\${lt:.2f} alloc={v.get(\"settings\",{}).get(\"capitalAllocationPercent\",\"?\")}%')
wl=d.get('watchlist',[])
if wl: print('Watchlist:', ', '.join([w.get('symbol','?') for w in wl]))
" 2>/dev/null
        echo ""
        echo "=== Main Crypto Status ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "curl -s --max-time 15 http://127.0.0.1:80/api/crypto/strategy/status -H 'Authorization: Bearer ${TOKEN}'" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
tts=d.get('tokenTraderStatus',{})
print('tokenTraderStatus entries:', len([k for k in tts if k.startswith('0x')]))
for k,v in tts.items():
    if k.startswith('0x') and v and 'token' in v:
        print(f'  {v[\"token\"][\"symbol\"]} ({v[\"token\"][\"network\"]})')
" 2>/dev/null
        ;;
    *)
        echo "Usage: $0 [status|sweep|deposits|scans|tokens|errors|watch|api|dashboard]"
        ;;
esac
