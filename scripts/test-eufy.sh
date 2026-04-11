#!/bin/bash
# Eufy plugin testing script
# Usage: ./scripts/test-eufy.sh

HOST="$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"
SSH="sshpass -p $PASS ssh root@$HOST"

# Get JWT token
TOKEN=$(curl -s -X POST http://$HOST/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "lanagent"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "FAIL: Could not get auth token"
  exit 1
fi
echo "Auth token acquired"

nl_cmd() {
  local cmd="$1"
  echo ""
  echo "========================================="
  echo "TEST: $cmd"
  echo "========================================="
  curl -s -X POST "http://$HOST/api/command/execute" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"command\": \"$cmd\"}" | python3 -m json.tool 2>/dev/null
}

check_logs() {
  echo ""
  echo "===== Recent eufy logs ====="
  $SSH "tail -20 $PRODUCTION_PATH/logs/eufy.log 2>/dev/null || echo 'no eufy log yet'"
  echo ""
  echo "===== Recent errors ====="
  $SSH "tail -5 $PRODUCTION_PATH/logs/errors.log 2>/dev/null | grep -i eufy || echo 'no eufy errors'"
}

# --- Tests ---
# Verify metadata propagation in setup response
echo ""
echo "========================================="
echo "TEST: setup eufy (checking for metadata)"
echo "========================================="
RESPONSE=$(curl -s -X POST "http://$HOST/api/command/execute" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"command": "setup eufy"}')
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null

# Check if metadata.setOperation is present
echo ""
echo "--- Metadata check ---"
echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); m=d.get('data',{}).get('metadata',{}); print('setOperation:', m.get('setOperation','NOT FOUND'))" 2>/dev/null

sleep 2
check_logs
