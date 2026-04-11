#!/bin/bash
cd /media/veracrypt1/NodeJS/LANAgent
HOST="http://$PRODUCTION_SERVER"
EXT="https://api.lanagent.net"
PASS=0
FAIL=0

check() {
  if eval "$1"; then
    echo "  [PASS] $2"
    PASS=$((PASS+1))
  else
    echo "  [FAIL] $2"
    FAIL=$((FAIL+1))
  fi
}

# Deploy (skip if SKIP_DEPLOY=1)
if [ "${SKIP_DEPLOY}" != "1" ]; then
  echo "=== Deploying ==="
  ./scripts/deployment/deploy-quick.sh 2>&1 | tail -5
fi

# Wait for server
echo ""
echo "=== Waiting for server ==="
for i in $(seq 1 12); do
  TOKEN=$(curl -s --max-time 5 -X POST "$HOST/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"password": "lanagent"}' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("token",""))' 2>/dev/null)
  if [ -n "$TOKEN" ] && [ "$TOKEN" != "" ]; then
    echo "  Server ready (attempt $i)"
    break
  fi
  echo "  Waiting... (attempt $i)"
  sleep 15
done
if [ -z "$TOKEN" ]; then
  echo "  ERROR: Server not responding"
  exit 1
fi

# 1. Catalog via VPS (HTTPS)
echo ""
echo "=== 1. Catalog via VPS (HTTPS) ==="
CATALOG=$(curl -s "$EXT/api/external/catalog")
NSVC=$(echo "$CATALOG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('services',[])))" 2>/dev/null)
AID=$(echo "$CATALOG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('agent',{}).get('agentId',''))" 2>/dev/null)
check "[ '$NSVC' = '6' ]" "Catalog returns 6 services (got $NSVC)"
check "[ '$AID' = '2930' ]" "Agent ID is 2930 (got $AID)"

# 2. Catalog via LAN (direct)
echo ""
echo "=== 2. Catalog via LAN (direct) ==="
NSVC_LAN=$(curl -s "$HOST/api/external/catalog" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('services',[])))" 2>/dev/null)
check "[ '$NSVC_LAN' = '6' ]" "LAN catalog returns 6 services (got $NSVC_LAN)"

# 3. 402 Payment Required
echo ""
echo "=== 3. Payment Flow (402) ==="
PAY_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$EXT/api/external/youtube/download" \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Id: 2930' \
  -H 'X-Agent-Chain: bsc' \
  -d '{"url": "https://youtube.com/watch?v=test", "format": "mp3"}')
check "[ '$PAY_RESP' = '402' ]" "YouTube MP3 returns 402 (got $PAY_RESP)"

# 4. Auth required (missing headers)
echo ""
echo "=== 4. Auth Required (401) ==="
AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$EXT/api/external/youtube/download" \
  -H 'Content-Type: application/json' \
  -d '{"url": "test", "format": "mp3"}')
check "[ '$AUTH_CODE' = '401' ]" "Missing agent headers returns 401 (got $AUTH_CODE)"

# 5. Admin Dashboard
echo ""
echo "=== 5. Admin Dashboard ==="
DASH=$(curl -s "$HOST/api/external/admin/dashboard" -H "Authorization: Bearer $TOKEN")
DASH_OK=$(echo "$DASH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success',''))" 2>/dev/null)
check "[ '$DASH_OK' = 'True' ]" "Dashboard success (got $DASH_OK)"

# 6. Kill Switch
echo ""
echo "=== 6. Kill Switch ==="
curl -s -X POST "$HOST/api/external/admin/kill-switch" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"active": true}' > /dev/null
KS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$EXT/api/external/catalog")
check "[ '$KS_CODE' = '503' ]" "Kill switch blocks catalog with 503 (got $KS_CODE)"
curl -s -X POST "$HOST/api/external/admin/kill-switch" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"active": false}' > /dev/null
sleep 1
KS_OFF=$(curl -s -o /dev/null -w "%{http_code}" "$EXT/api/external/catalog")
check "[ '$KS_OFF' = '200' ]" "Kill switch off restores catalog (got $KS_OFF)"

# 7. Route isolation — dashboard leak tests
echo ""
echo "=== 7. Dashboard Leak Tests ==="
is_json_not_html() {
  echo "$1" | head -c 1 | grep -q '{'
}

L1=$(curl -s "$EXT/api/external/anything")
L1_OK=$(echo "$L1" | head -c 1)
check "[ '$L1_OK' != '<' ]" "/api/external/anything is not HTML"

L2=$(curl -s "$EXT/api/external/?")
L2_OK=$(echo "$L2" | head -c 1)
check "[ '$L2_OK' != '<' ]" "/api/external/? is not HTML"

L3=$(curl -s "$EXT/api/external/catalog.")
L3_OK=$(echo "$L3" | head -c 1)
check "[ '$L3_OK' != '<' ]" "/api/external/catalog. is not HTML"

L4=$(curl -s "$EXT/api/external/../api/auth/login")
L4_OK=$(echo "$L4" | head -c 1)
check "[ '$L4_OK' != '<' ]" "/api/external/../api/auth/login is not HTML"

L5=$(curl -s -o /dev/null -w "%{http_code}" "$EXT/api/auth/login")
check "[ '$L5' = '404' ]" "Non-external /api/auth/login returns 404 (got $L5)"

L6=$(curl -s -o /dev/null -w "%{http_code}" "$EXT/")
check "[ '$L6' = '404' ]" "Root / returns 404 (got $L6)"

# 8. HTTPS redirect
echo ""
echo "=== 8. HTTPS Redirect ==="
REDIR=$(curl -s -o /dev/null -w "%{http_code}" "http://api.lanagent.net/api/external/catalog")
check "[ '$REDIR' = '301' ]" "HTTP redirects to HTTPS with 301 (got $REDIR)"

# 9. Response Sanitizer
echo ""
echo "=== 9. Response Sanitizer ==="
BODY=$(curl -s "$EXT/api/external/catalog")
HAS_IP=$(echo "$BODY" | python3 -c "import sys,re; b=sys.stdin.read(); print('LEAK' if re.search(r'192\.168\.\d+\.\d+|10\.8\.\d+', b) else 'CLEAN')" 2>/dev/null)
HAS_PATH=$(echo "$BODY" | python3 -c "import sys,re; b=sys.stdin.read(); print('LEAK' if re.search(r'/root/|/home/|/media/', b) else 'CLEAN')" 2>/dev/null)
check "[ '$HAS_IP' = 'CLEAN' ]" "No internal IPs in response"
check "[ '$HAS_PATH' = 'CLEAN' ]" "No internal paths in response"

# 10. VPS Headers
echo ""
echo "=== 10. VPS Headers ==="
SVR_HDR=$(curl -sI "$EXT/api/external/catalog" | grep -i "^server:" | tr -d '\r')
check "[ '$SVR_HDR' = 'Server: nginx' ]" "Server header hides version ($SVR_HDR)"
NO_POWERED=$(curl -sI "$EXT/api/external/catalog" | grep -ci "x-powered-by")
check "[ '$NO_POWERED' = '0' ]" "No X-Powered-By header"

# 11. Registration File
echo ""
echo "=== 11. Registration File ==="
REG=$(curl -s -X POST "$HOST/api/agent/erc8004/registration" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json')
REG_ACTIVE=$(echo "$REG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('active',''))" 2>/dev/null)
REG_SVCS=$(echo "$REG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',{}).get('services',[])))" 2>/dev/null)
check "[ '$REG_ACTIVE' = 'True' ]" "Registration file active (got $REG_ACTIVE)"
check "[ '$REG_SVCS' = '6' ]" "Registration has 6 services (got $REG_SVCS)"

# 12. Errors
echo ""
echo "=== 12. Error Log ==="
ERRS=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "tail -5 $PRODUCTION_PATH/logs/errors.log 2>/dev/null" | strings)
HAS_WHOIS_ERR=$(echo "$ERRS" | grep -c "WHOISJSON_API_KEY")
check "[ '$HAS_WHOIS_ERR' = '0' ]" "Whois API key error no longer in recent logs"
echo "  Last errors:"
echo "$ERRS" | tail -3 | sed 's/^/    /'

# Summary
echo ""
echo "==============================="
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "==============================="
