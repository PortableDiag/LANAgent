#!/bin/bash
# Crypto debug script - reusable for all remote operations
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deployment/deploy.config"

TOKEN=$(curl -s -X POST http://$PRODUCTION_SERVER/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "lanagent"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

echo "--- Token Trader Status ---"
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://$PRODUCTION_SERVER/api/crypto/strategy/token-trader/status" | python3 -m json.tool 2>/dev/null

echo ""
echo "--- Recent token_trader activity ---"
sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" \
  "grep -ia 'TokenTrader\|token_trader' $PRODUCTION_PATH/logs/all-activity.log | tail -15"
