#!/bin/bash
# LP Market Maker API test script
# Usage: ./scripts/test-lp-mm.sh [test_name]
# Tests: status, enable, open, status2, collect, rebalance, close, disable, errors, heartbeat

HOST="http://$PRODUCTION_SERVER"
TOKEN=$(curl -s -X POST $HOST/api/auth/login -H 'Content-Type: application/json' -d '{"password": "lanagent"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
    echo "ERROR: Failed to get JWT token"
    exit 1
fi

AUTH="Authorization: Bearer $TOKEN"
CT="Content-Type: application/json"

api_get() {
    curl -s "$HOST$1" -H "$AUTH" | python3 -m json.tool
}

api_post() {
    local resp
    local body="${2:-{}}"
    resp=$(curl -s -X POST "$HOST$1" -H "$AUTH" -H "$CT" -d "$body")
    if [ -z "$resp" ]; then
        echo '{"error": "empty response"}'
    else
        echo "$resp" | python3 -m json.tool 2>/dev/null || echo "$resp"
    fi
}

TEST="${1:-status}"

case $TEST in
    status)
        echo "=== GET /api/crypto/lp/mm/status ==="
        api_get "/api/crypto/lp/mm/status"
        ;;
    enable)
        echo "=== POST /api/crypto/lp/mm/enable ==="
        curl -s -X POST "$HOST/api/crypto/lp/mm/enable" -H "$AUTH" -H "$CT" \
          -d '{"allocationBNB":0.01,"allocationSKYNET":500000,"rangePercent":20}' | python3 -m json.tool
        ;;
    disable)
        echo "=== POST /api/crypto/lp/mm/disable ==="
        api_post "/api/crypto/lp/mm/disable"
        ;;
    open)
        echo "=== POST /api/crypto/lp/mm/open ==="
        api_post "/api/crypto/lp/mm/open"
        ;;
    close)
        echo "=== POST /api/crypto/lp/mm/close ==="
        api_post "/api/crypto/lp/mm/close"
        ;;
    rebalance)
        echo "=== POST /api/crypto/lp/mm/rebalance ==="
        api_post "/api/crypto/lp/mm/rebalance"
        ;;
    collect)
        echo "=== POST /api/crypto/lp/mm/collect ==="
        api_post "/api/crypto/lp/mm/collect"
        ;;
    errors)
        echo "=== Error handling tests ==="
        echo "--- Collect with no position ---"
        api_post "/api/crypto/lp/mm/collect"
        echo ""
        echo "--- Close with no position ---"
        api_post "/api/crypto/lp/mm/close"
        echo ""
        echo "--- Rebalance with no position ---"
        api_post "/api/crypto/lp/mm/rebalance"
        ;;
    heartbeat)
        echo "=== Check production logs for MM heartbeat ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -i 'LP MM\|market maker' $PRODUCTION_PATH/logs/all-activity.log 2>/dev/null | tail -20"
        echo ""
        echo "=== PM2 logs ==="
        sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -i 'LP MM\|market maker' /root/.pm2/logs/lan-agent-out.log 2>/dev/null | tail -20"
        ;;
    all)
        echo "=== FULL TEST SEQUENCE ==="
        echo ""; echo ">>> status"; api_get "/api/crypto/lp/mm/status"; sleep 1
        echo ""; echo ">>> enable"
        curl -s -X POST "$HOST/api/crypto/lp/mm/enable" -H "$AUTH" -H "$CT" \
          -d '{"allocationBNB":0.01,"allocationSKYNET":500000,"rangePercent":20}' | python3 -m json.tool
        sleep 1
        echo ""; echo ">>> status (after enable)"; api_get "/api/crypto/lp/mm/status"; sleep 1
        echo ""; echo ">>> errors: collect"; api_post "/api/crypto/lp/mm/collect"
        echo ">>> errors: close"; api_post "/api/crypto/lp/mm/close"
        echo ">>> errors: rebalance"; api_post "/api/crypto/lp/mm/rebalance"; sleep 1
        echo ""; echo ">>> disable"; api_post "/api/crypto/lp/mm/disable"; sleep 1
        echo ""; echo ">>> status (after disable)"; api_get "/api/crypto/lp/mm/status"
        ;;
    *)
        echo "Usage: $0 {status|enable|disable|open|close|rebalance|collect|errors|heartbeat|all}"
        ;;
esac
