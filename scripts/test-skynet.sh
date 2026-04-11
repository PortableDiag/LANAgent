#!/bin/bash
# SKYNET Token Economy - Production Verification Script
# Tests all new API endpoints and features

SERVER="http://$PRODUCTION_SERVER"
PASS="lanagent"

# Get JWT token
TOKEN=$(curl -s -X POST "$SERVER/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\": \"$PASS\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

if [ -z "$TOKEN" ]; then
  echo "FAIL: Could not get auth token"
  exit 1
fi

API="curl -s -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json'"
PASS_COUNT=0
FAIL_COUNT=0

check() {
  local label="$1"
  local result="$2"
  local check="$3"

  if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); $check" 2>/dev/null; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label"
    echo "        Response: $(echo "$result" | head -c 200)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

echo "========================================"
echo "  SKYNET Production Verification"
echo "========================================"
echo ""

# ---------- P2P & Skynet Core ----------
echo "--- P2P & Skynet Core ---"

R=$(eval $API "$SERVER/p2p/api/status")
check "P2P status returns success" "$R" "assert d['success'] == True"
check "P2P wallet address present" "$R" "assert d.get('walletAddress','').startswith('0x')"
check "P2P connected to registry" "$R" "assert d['connection']['connected'] == True"

R=$(eval $API "$SERVER/p2p/api/skynet/stats")
check "Skynet stats endpoint works" "$R" "assert d['success'] == True"
check "Stats has totalRevenue field" "$R" "assert 'totalRevenue' in d"

R=$(eval $API "$SERVER/p2p/api/skynet/services")
check "Skynet services list works" "$R" "assert d['success'] == True"

R=$(eval $API "$SERVER/p2p/api/skynet/payments")
check "Skynet payments list works" "$R" "assert d['success'] == True"

# ---------- Service Sync (discover plugins) ----------
echo ""
echo "--- Service Sync ---"

R=$(curl -s -X POST "$SERVER/p2p/api/skynet/services/sync" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}')
check "Service sync endpoint works" "$R" "assert d['success'] == True"
SYNCED=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('synced',0))" 2>/dev/null)
echo "  INFO: Synced $SYNCED new services"

R=$(eval $API "$SERVER/p2p/api/skynet/services")
SVC_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('services',[])))" 2>/dev/null)
check "Services discovered after sync" "$R" "assert len(d.get('services',[])) > 0"
echo "  INFO: $SVC_COUNT services available"

# ---------- Service Enable/Disable ----------
echo ""
echo "--- Service Toggle ---"

FIRST_SVC=$(echo "$R" | python3 -c "import sys,json; svcs=json.load(sys.stdin).get('services',[]); print(svcs[0]['serviceId'] if svcs else '')" 2>/dev/null)
if [ -n "$FIRST_SVC" ]; then
  R2=$(curl -s -X PUT "$SERVER/p2p/api/skynet/services/$FIRST_SVC" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"skynetEnabled": true, "skynetPrice": 0.5}')
  check "Enable service $FIRST_SVC" "$R2" "assert d['success'] == True"
  check "Price set to 0.5" "$R2" "assert d['service']['skynetPrice'] == 0.5"

  # Disable it back
  R3=$(curl -s -X PUT "$SERVER/p2p/api/skynet/services/$FIRST_SVC" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"skynetEnabled": false, "skynetPrice": 0}')
  check "Disable service back" "$R3" "assert d['success'] == True"
fi

# Bulk toggle
R=$(curl -s -X POST "$SERVER/p2p/api/skynet/services/bulk" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"skynetEnabled": false}')
check "Bulk disable works" "$R" "assert d['success'] == True"

# ---------- LP Management ----------
echo ""
echo "--- LP Management ---"

R=$(eval $API "$SERVER/api/crypto/lp/positions")
check "LP positions endpoint works" "$R" "assert d['success'] == True"

R=$(curl -s -H "Authorization: Bearer $TOKEN" "$SERVER/api/crypto/lp/info?tokenA=0x8Ef0ecE5687417a8037F787b39417eB16972b04F&tokenB=native&network=bsc")
check "LP info for SKYNET/BNB pair" "$R" "assert d['success'] == True"
if echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('info') is not None" 2>/dev/null; then
  PAIR=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['pairAddress'])" 2>/dev/null)
  LP_BAL=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['lpBalance'])" 2>/dev/null)
  echo "  INFO: Pair=$PAIR, LP Balance=$LP_BAL"
fi

# ---------- Economy (Bounties & Governance) ----------
echo ""
echo "--- Economy ---"

R=$(eval $API "$SERVER/p2p/api/skynet/economy")
check "Economy stats endpoint works" "$R" "assert d['success'] == True"
check "Has bounties stats" "$R" "assert 'bounties' in d"
check "Has governance stats" "$R" "assert 'governance' in d"

R=$(eval $API "$SERVER/p2p/api/skynet/bounties")
check "Bounties list endpoint works" "$R" "assert d['success'] == True"

R=$(eval $API "$SERVER/p2p/api/skynet/proposals")
check "Proposals list endpoint works" "$R" "assert d['success'] == True"

# Create a test bounty
R=$(curl -s -X POST "$SERVER/p2p/api/skynet/bounties" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Test bounty","description":"Verification test","category":"test","reward":1}')
check "Create bounty works" "$R" "assert d['success'] == True"

# Create a test proposal
R=$(curl -s -X POST "$SERVER/p2p/api/skynet/proposals" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Test proposal","description":"Verification test","category":"protocol","votingDays":1}')
check "Create proposal works" "$R" "assert d['success'] == True"
PROP_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('proposal',{}).get('proposalId',''))" 2>/dev/null)

# Vote on proposal
if [ -n "$PROP_ID" ]; then
  R=$(curl -s -X POST "$SERVER/p2p/api/skynet/proposals/$PROP_ID/vote" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"vote":"for"}')
  check "Vote on proposal works" "$R" "assert d['success'] == True"
fi

# ---------- Peers & Trust Score ----------
echo ""
echo "--- Peers & Trust Scores ---"

R=$(eval $API "$SERVER/p2p/api/peers")
check "Peers list with trust scores" "$R" "assert d['success'] == True"
PEER_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('peers',[])))" 2>/dev/null)
echo "  INFO: $PEER_COUNT peers known"
# Check first peer has trustScore field
if [ "$PEER_COUNT" -gt "0" ]; then
  check "Peer has trustScore field" "$R" "assert 'trustScore' in d['peers'][0]"
  check "Peer has skynetBalance field" "$R" "assert 'skynetBalance' in d['peers'][0]"
fi

# ---------- Token Trader / SIREN Check ----------
echo ""
echo "--- Token Trader & SIREN ---"

R=$(eval $API "$SERVER/api/crypto/strategy/status")
check "Strategy status endpoint works" "$R" "assert d.get('success',True)"
echo "  INFO: Strategy response keys: $(echo "$R" | python3 -c "import sys,json; print(list(json.load(sys.stdin).keys())[:10])" 2>/dev/null)"

R=$(eval $API "$SERVER/api/crypto/strategy/token-trader/status")
check "Token trader status works" "$R" "assert d.get('success',True)"
echo "  INFO: Token trader: $(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"active={d.get('active','?')}, token={d.get('tokenSymbol','?')}, watchlist={len(d.get('watchlist',[]))} tokens\")" 2>/dev/null)"

# Watchlist is part of token-trader status response
echo "  INFO: Watchlist: $(echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
wl = d.get('watchlist', [])
for t in wl:
    name = t.get('symbol', t.get('name', '?'))
    s = ' [SYSTEM]' if t.get('system') else ''
    print(f'  {name}{s}', end='')
print()
" 2>/dev/null)"
check "Watchlist has entries" "$R" "assert len(d.get('watchlist',[])) > 0"
check "SKYNET system token in watchlist" "$R" "assert any(t.get('system') and 'SKYNET' in t.get('symbol','').upper() for t in d.get('watchlist',[]))"

# ---------- SKYNET Token Ledger ----------
echo ""
echo "--- SKYNET Token Ledger ---"

R=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source /root/.nvm/nvm.sh && nvm use 20 > /dev/null 2>&1 && node -e \"
import('mongoose').then(async m => {
  await m.default.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent');
  const SkynetTokenLedger = (await import('./src/models/SkynetTokenLedger.js')).default;
  const summary = await SkynetTokenLedger.getSummary();
  console.log(JSON.stringify(summary));
  process.exit(0);
}).catch(e => { console.log(JSON.stringify({error: e.message})); process.exit(1); });
\" 2>/dev/null")
echo "  INFO: Token Ledger: $R"

# Fix ERC-8004 status from 'minted' to 'active' if needed
R=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source /root/.nvm/nvm.sh && nvm use 20 > /dev/null 2>&1 && node -e \"
import('mongoose').then(async m => {
  await m.default.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent');
  const db = m.default.connection.db;
  const result = await db.collection('agents').findOneAndUpdate(
    { name: 'LANAgent', 'erc8004.status': 'minted' },
    { \\\\\$set: { 'erc8004.status': 'active' } },
    { returnDocument: 'after' }
  );
  if (result) {
    console.log(JSON.stringify({fixed: true, status: 'active'}));
  } else {
    const agent = await db.collection('agents').findOne({ name: 'LANAgent' });
    console.log(JSON.stringify({fixed: false, status: agent?.erc8004?.status || 'none'}));
  }
  process.exit(0);
}).catch(e => { console.log(JSON.stringify({error: e.message})); process.exit(1); });
\" 2>/dev/null")
echo "  INFO: ERC-8004 status fix: $R"

echo ""
echo "========================================"
echo "  Results: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "========================================"
