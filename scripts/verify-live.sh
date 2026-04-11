#!/bin/bash
cd /media/veracrypt1/NodeJS/LANAgent
EXT="https://api.lanagent.net"
HOST="http://$PRODUCTION_SERVER"
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

echo "=== 1. Catalog ==="
CATALOG=$(curl -s "$EXT/api/external/catalog")
NSVC=$(echo "$CATALOG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('services',[])))" 2>/dev/null)
AID=$(echo "$CATALOG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('agent',{}).get('agentId',''))" 2>/dev/null)
CHAIN=$(echo "$CATALOG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('payment',{}).get('chainId',''))" 2>/dev/null)
ADDR=$(echo "$CATALOG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('payment',{}).get('address',''))" 2>/dev/null)
check "[ '$NSVC' = '8' ]" "Catalog returns 8 services (got $NSVC)"
check "[ '$AID' = '2930' ]" "Agent ID is 2930 (got $AID)"
check "[ '$CHAIN' = '56' ]" "Chain ID is 56 / BSC Mainnet (got $CHAIN)"
check "[ -n '$ADDR' ] && [ '$ADDR' != 'None' ]" "Payment address present ($ADDR)"

echo ""
echo "=== 2. Service Listing ==="
echo "$CATALOG" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d.get('services',[]):
    print(f'  {s[\"serviceId\"]:25s} {s[\"price\"]:>8s} BNB  rate: {s[\"rateLimit\"][\"maxPerAgent\"]}/{s[\"rateLimit\"][\"windowMinutes\"]}min')
" 2>/dev/null

echo ""
echo "=== 3. Auth Flow ==="
A1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$EXT/api/external/sandbox/execute" \
  -H 'Content-Type: application/json' -d '{"language":"python","code":"print(1)"}')
check "[ '$A1' = '401' ]" "No agent headers → 401 (got $A1)"

echo ""
echo "=== 4. Payment Flow (402) ==="
S1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$EXT/api/external/sandbox/execute" \
  -H 'Content-Type: application/json' -H 'X-Agent-Id: 2930' -H 'X-Agent-Chain: bsc' \
  -d '{"language":"python","code":"print(1)","timeout":5}')
check "[ '$S1' = '402' ]" "Sandbox → 402 Payment Required (got $S1)"

P1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$EXT/api/external/pdf/extract" \
  -H 'X-Agent-Id: 2930' -H 'X-Agent-Chain: bsc' -F 'file=@/dev/null')
check "[ '$P1' = '402' ]" "PDF extract → 402 Payment Required (got $P1)"

P2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$EXT/api/external/pdf/merge" \
  -H 'X-Agent-Id: 2930' -H 'X-Agent-Chain: bsc' -F 'files=@/dev/null')
check "[ '$P2' = '402' ]" "PDF merge → 402 Payment Required (got $P2)"

echo ""
echo "=== 5. HTTPS + Routing ==="
R1=$(curl -s -o /dev/null -w "%{http_code}" "http://api.lanagent.net/api/external/catalog")
check "[ '$R1' = '301' ]" "HTTP → HTTPS redirect 301 (got $R1)"

R2=$(curl -s -o /dev/null -w "%{http_code}" "$EXT/")
check "[ '$R2' = '404' ]" "Root path → 404 (got $R2)"

R3=$(curl -s -o /dev/null -w "%{http_code}" "$EXT/api/auth/login")
check "[ '$R3' = '404' ]" "Non-external path → 404 (got $R3)"

echo ""
echo "=== 6. Response Sanitizer ==="
BODY=$(curl -s "$EXT/api/external/catalog")
HAS_IP=$(echo "$BODY" | python3 -c "import sys,re; b=sys.stdin.read(); print('LEAK' if re.search(r'192\.168\.\d+\.\d+|10\.8\.\d+', b) else 'CLEAN')" 2>/dev/null)
HAS_PATH=$(echo "$BODY" | python3 -c "import sys,re; b=sys.stdin.read(); print('LEAK' if re.search(r'/root/|/home/|/media/', b) else 'CLEAN')" 2>/dev/null)
check "[ '$HAS_IP' = 'CLEAN' ]" "No internal IPs leaked"
check "[ '$HAS_PATH' = 'CLEAN' ]" "No internal paths leaked"

echo ""
echo "=== 7. On-Chain Identity ==="
OWNER=$(sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source ~/.nvm/nvm.sh && nvm use 20 2>/dev/null >/dev/null && node -e \"
const{ethers}=require('ethers');
const p=new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');
const r=new ethers.Contract('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',['function ownerOf(uint256) view returns (address)'],p);
r.ownerOf(2930).then(o=>console.log(o)).catch(e=>console.log('ERROR:'+e.message));
\"" 2>/dev/null)
check "echo '$OWNER' | grep -q '^0x'" "Agent #2930 registered on BSC (owner: $OWNER)"

echo ""
echo "=== 8. Docker Sandbox Images ==="
IMGS=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'python:3.12-alpine|node:20-alpine|alpine:3.19|ruby:3.3-alpine|golang:1.22-alpine' | wc -l" 2>/dev/null)
check "[ '$IMGS' = '5' ]" "All 5 Docker sandbox images pre-pulled ($IMGS/5)"

echo ""
echo "=== 9. Ghostscript ==="
GS=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "gs --version" 2>/dev/null)
check "[ -n '$GS' ]" "Ghostscript installed (v$GS)"

echo ""
echo "==============================="
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "==============================="
