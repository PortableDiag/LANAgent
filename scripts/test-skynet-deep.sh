#!/bin/bash
# SKYNET & P2P Deep Verification - Tests actual functionality, not just endpoints
SERVER="http://$PRODUCTION_SERVER"
API_KEY="${LANAGENT_API_KEY:-your-api-key}"
H="X-API-Key: $API_KEY"
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

check() {
  local label="$1" result="$2" assertion="$3"
  if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); $assertion" 2>/dev/null; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label"
    echo "        Response: $(echo "$result" | head -c 300)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

warn() {
  local label="$1" detail="$2"
  echo "  WARN: $label"
  [ -n "$detail" ] && echo "        $detail"
  WARN_COUNT=$((WARN_COUNT + 1))
}

info() {
  echo "  INFO: $1"
}

echo "=============================================="
echo "  SKYNET & P2P Deep Feature Verification"
echo "=============================================="
echo ""

# ===== 1. P2P Core Health =====
echo "--- 1. P2P Core Health ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/status")
check "P2P enabled and connected" "$R" "assert d['success'] and d['connection']['connected']"
UPTIME=$(echo "$R" | python3 -c "import sys,json; u=json.load(sys.stdin)['connection']['uptime']; print(f'{u//3600}h {(u%3600)//60}m')" 2>/dev/null)
MSGS_SENT=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['connection']['stats']['messagesSent'])" 2>/dev/null)
MSGS_RECV=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['connection']['stats']['messagesReceived'])" 2>/dev/null)
WALLET=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('walletAddress','none'))" 2>/dev/null)
info "Uptime: $UPTIME, Messages: sent=$MSGS_SENT recv=$MSGS_RECV"
info "Wallet: $WALLET"
check "Wallet address is valid ETH format" "$R" "assert d.get('walletAddress','').startswith('0x') and len(d['walletAddress']) == 42"
check "No reconnects (stable connection)" "$R" "assert d['connection']['stats']['reconnectCount'] == 0"

# ===== 2. P2P Settings =====
echo ""
echo "--- 2. P2P Settings ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/settings")
check "Settings endpoint works" "$R" "assert d.get('success', True)"
info "Settings: $(echo "$R" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f\"enabled={d.get('enabled','?')}, displayName={d.get('displayName','?')}, autoShare={d.get('autoSharePlugins','?')}, autoInstall={d.get('autoInstallPlugins','?')}\")
" 2>/dev/null)"

# ===== 3. SKYNET Service Discovery & Catalog =====
echo ""
echo "--- 3. SKYNET Service Catalog ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/skynet/services")
SVC_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('services',[])))" 2>/dev/null)
ENABLED_COUNT=$(echo "$R" | python3 -c "import sys,json; print(sum(1 for s in json.load(sys.stdin).get('services',[]) if s.get('skynetEnabled')))" 2>/dev/null)
check "Services catalog populated" "$R" "assert len(d.get('services',[])) > 0"
info "Total services: $SVC_COUNT, Enabled: $ENABLED_COUNT"

# Check service data integrity
check "Services have required fields" "$R" "assert all(s.get('serviceId') and s.get('pluginName') and s.get('action') for s in d['services'][:10])"
check "Services have pricing fields" "$R" "assert all('skynetPrice' in s and 'skynetEnabled' in s for s in d['services'][:10])"
check "Services have rate limit config" "$R" "assert all('rateLimit' in s for s in d['services'][:10])"

# Check categories are diverse (not all same plugin)
CATEGORIES=$(echo "$R" | python3 -c "
import sys,json
cats = set(s.get('category','') for s in json.load(sys.stdin).get('services',[]))
print(f'{len(cats)} categories: {sorted(list(cats))[:15]}...')
" 2>/dev/null)
info "Service categories: $CATEGORIES"

# ===== 4. Service Enable/Disable/Pricing =====
echo ""
echo "--- 4. Service Toggle & Pricing ---"

# Pick a service to test with
SVC_ID=$(echo "$R" | python3 -c "import sys,json; svcs=json.load(sys.stdin).get('services',[]); print(svcs[5]['serviceId'] if len(svcs)>5 else '')" 2>/dev/null)
if [ -n "$SVC_ID" ]; then
  # Enable with price
  R2=$(curl -s -X PUT "$SERVER/p2p/api/skynet/services/$SVC_ID" \
    -H "$H" -H 'Content-Type: application/json' \
    -d '{"skynetEnabled": true, "skynetPrice": 2.5}')
  check "Enable service with price 2.5 SKYNET" "$R2" "assert d['success'] and d['service']['skynetPrice'] == 2.5 and d['service']['skynetEnabled'] == True"

  # Update price only
  R3=$(curl -s -X PUT "$SERVER/p2p/api/skynet/services/$SVC_ID" \
    -H "$H" -H 'Content-Type: application/json' \
    -d '{"skynetPrice": 0.1}')
  check "Update price to 0.1" "$R3" "assert d['success'] and d['service']['skynetPrice'] == 0.1"

  # Update rate limit
  R4=$(curl -s -X PUT "$SERVER/p2p/api/skynet/services/$SVC_ID" \
    -H "$H" -H 'Content-Type: application/json' \
    -d '{"rateLimit": {"maxPerPeer": 10, "windowMinutes": 30}}')
  check "Update rate limit" "$R4" "assert d['success'] and d['service']['rateLimit']['maxPerPeer'] == 10"

  # Disable back
  R5=$(curl -s -X PUT "$SERVER/p2p/api/skynet/services/$SVC_ID" \
    -H "$H" -H 'Content-Type: application/json' \
    -d '{"skynetEnabled": false, "skynetPrice": 0}')
  check "Disable service back" "$R5" "assert d['success'] and d['service']['skynetEnabled'] == False"
fi

# Bulk enable some services
R=$(curl -s -X POST "$SERVER/p2p/api/skynet/services/bulk" \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{"skynetEnabled": true, "category": "system"}')
check "Bulk enable by category" "$R" "assert d['success']"
BULK_COUNT=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('modified', json.load(sys.stdin) if isinstance(json.load(sys.stdin), int) else '?'))" 2>/dev/null)
info "Bulk enabled: $BULK_COUNT services in 'system' category"

# Bulk disable all back
R=$(curl -s -X POST "$SERVER/p2p/api/skynet/services/bulk" \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{"skynetEnabled": false}')
check "Bulk disable all" "$R" "assert d['success']"

# ===== 5. SKYNET Stats & Revenue =====
echo ""
echo "--- 5. SKYNET Revenue & Stats ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/skynet/stats")
check "Stats endpoint returns all fields" "$R" "assert all(k in d for k in ['totalRevenue','totalRequests','enabledServices','totalServices'])"
info "Revenue: $(echo "$R" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f\"totalRevenue={d.get('totalRevenue',0)} SKYNET, requests={d.get('totalRequests',0)}, enabled={d.get('enabledServices',0)}/{d.get('totalServices',0)}\")
" 2>/dev/null)"

R=$(curl -s -H "$H" "$SERVER/p2p/api/skynet/payments")
check "Payments endpoint works" "$R" "assert d['success']"
PAY_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('payments',[])))" 2>/dev/null)
info "Payment history: $PAY_COUNT records"

# ===== 6. Bounty System =====
echo ""
echo "--- 6. Bounty System ---"

# List existing
R=$(curl -s -H "$H" "$SERVER/p2p/api/skynet/bounties")
check "Bounties list works" "$R" "assert d['success']"
BOUNTY_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('bounties',[])))" 2>/dev/null)
info "Existing bounties: $BOUNTY_COUNT"

# Create a real bounty with meaningful data
R=$(curl -s -X POST "$SERVER/p2p/api/skynet/bounties" \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{"title":"Deep test: Network scan optimization","description":"Optimize nmap scan for large subnets","category":"development","reward":5}')
check "Create bounty with 5 SKYNET reward" "$R" "assert d['success']"
NEW_BOUNTY_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('bounty',{}).get('bountyId',''))" 2>/dev/null)
check "Bounty has valid ID" "$R" "assert d.get('bounty',{}).get('bountyId','').startswith('bounty_')"
check "Bounty reward is 5" "$R" "assert d.get('bounty',{}).get('reward') == 5"
check "Bounty category is development" "$R" "assert d.get('bounty',{}).get('category') == 'development'"
check "Bounty status is open" "$R" "assert d.get('bounty',{}).get('status') == 'open'"
check "Bounty has expiry date" "$R" "assert d.get('bounty',{}).get('expiresAt') is not None"

# Verify it shows in list
R=$(curl -s -H "$H" "$SERVER/p2p/api/skynet/bounties")
check "New bounty appears in list" "$R" "assert any(b.get('bountyId') == '$NEW_BOUNTY_ID' for b in d.get('bounties',[]))"

# ===== 7. Governance Proposals & Voting =====
echo ""
echo "--- 7. Governance Proposals & Voting ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/skynet/proposals")
check "Proposals list works" "$R" "assert d['success']"
PROP_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('proposals',[])))" 2>/dev/null)
info "Existing proposals: $PROP_COUNT"

# Create a governance proposal
R=$(curl -s -X POST "$SERVER/p2p/api/skynet/proposals" \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{"title":"Deep test: Increase default rate limit","description":"Proposal to increase default maxPerPeer from 5 to 10 for all services","category":"protocol","votingDays":2}')
check "Create governance proposal" "$R" "assert d['success']"
PROP_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('proposal',{}).get('proposalId',''))" 2>/dev/null)
check "Proposal has valid ID" "$R" "assert d.get('proposal',{}).get('proposalId','').startswith('prop_')"
check "Proposal status is active" "$R" "assert d.get('proposal',{}).get('status') == 'active'"
check "Proposal has voting end date" "$R" "assert d.get('proposal',{}).get('votingEndsAt') is not None"

# Vote FOR
if [ -n "$PROP_ID" ]; then
  R=$(curl -s -X POST "$SERVER/p2p/api/skynet/proposals/$PROP_ID/vote" \
    -H "$H" -H 'Content-Type: application/json' \
    -d '{"vote":"for"}')
  check "Vote FOR proposal" "$R" "assert d['success']"

  # Check vote was recorded
  R=$(curl -s -H "$H" "$SERVER/p2p/api/skynet/proposals")
  check "Vote count updated" "$R" "
prop = next((p for p in d['proposals'] if p['proposalId'] == '$PROP_ID'), None)
assert prop is not None and prop['votesFor'] >= 1
"
fi

# ===== 8. Economy Overview =====
echo ""
echo "--- 8. Economy Overview ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/skynet/economy")
check "Economy stats has bounties section" "$R" "assert 'bounties' in d and 'open' in d['bounties']"
check "Economy stats has governance section" "$R" "assert 'governance' in d and 'active' in d['governance']"
OPEN_BOUNTIES=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['bounties']['open'])" 2>/dev/null)
ACTIVE_PROPS=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['governance']['active'])" 2>/dev/null)
info "Economy: $OPEN_BOUNTIES open bounties, $ACTIVE_PROPS active proposals"

# ===== 9. LP Management Deep Check =====
echo ""
echo "--- 9. LP Management ---"

R=$(curl -s -H "$H" "$SERVER/api/crypto/lp/positions")
check "LP positions endpoint" "$R" "assert d['success']"
LP_COUNT=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalPositions',0))" 2>/dev/null)
info "Tracked LP positions: $LP_COUNT"

# SKYNET/BNB LP info
R=$(curl -s -H "$H" "$SERVER/api/crypto/lp/info?tokenA=0x8Ef0ecE5687417a8037F787b39417eB16972b04F&tokenB=native&network=bsc")
check "SKYNET/BNB LP pair info" "$R" "assert d['success']"
LP_INFO=$(echo "$R" | python3 -c "
import sys,json; d=json.load(sys.stdin).get('info',{})
print(f\"pair={d.get('pairAddress','?')[:20]}..., lpBalance={d.get('lpBalance','?')}, reserves: {d.get('reserve0','?')}/{d.get('reserve1','?')}\")
" 2>/dev/null)
info "SKYNET/BNB LP: $LP_INFO"
check "LP pair address matches expected" "$R" "assert '0xF3dEF3534EEC' in d.get('info',{}).get('pairAddress','')"
check "LP has non-zero balance" "$R" "assert float(d.get('info',{}).get('lpBalance','0')) > 0"
check "LP has non-zero reserves" "$R" "assert float(d.get('info',{}).get('reserve0','0')) > 0"

# Refresh positions
R=$(curl -s -X POST "$SERVER/api/crypto/lp/positions/refresh" -H "$H" -H 'Content-Type: application/json')
check "LP positions refresh" "$R" "assert d.get('success', True)"

# ===== 10. SKYNET Token Ledger =====
echo ""
echo "--- 10. SKYNET Token Ledger (DB) ---"

R=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source /root/.nvm/nvm.sh && nvm use 20 > /dev/null 2>&1 && node -e \"
import('mongoose').then(async m => {
  await m.default.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent');
  const SkynetTokenLedger = (await import('./src/models/SkynetTokenLedger.js')).default;
  const summary = await SkynetTokenLedger.getSummary();
  console.log(JSON.stringify({success:true,...summary}));
  process.exit(0);
}).catch(e => { console.log(JSON.stringify({success:false,error:e.message})); process.exit(0); });
\"" 2>/dev/null)
check "Token ledger accessible" "$R" "assert d['success']"
check "Total minted is 100M" "$R" "assert d.get('totalMinted') == 100000000"
check "LP allocation is 50M" "$R" "assert any(e['category']=='lp' and e['amount']==50000000 for e in d.get('entries',[]))"
check "Staking allocation is 20M" "$R" "assert any(e['category']=='staking' and e['amount']==20000000 for e in d.get('entries',[]))"
check "Bounty allocation is 10M" "$R" "assert any(e['category']=='bounty' and e['amount']==10000000 for e in d.get('entries',[]))"
check "Treasury allocation is 10M" "$R" "assert any(e['category']=='treasury' and e['amount']==10000000 for e in d.get('entries',[]))"
check "Reserve allocation is 10M" "$R" "assert any(e['category']=='reserve' and e['amount']==10000000 for e in d.get('entries',[]))"
info "Ledger: $(echo "$R" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f\"minted={d.get('totalMinted',0)/1e6}M, bought={d.get('totalBought',0)}, tradeable={d.get('totalTradeable',0)}\")
" 2>/dev/null)"

# ===== 11. P2P Capability Exchange (wallet/SKYNET in announcements) =====
echo ""
echo "--- 11. P2P Capability Exchange ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/status")
check "P2P announces wallet address" "$R" "assert d.get('walletAddress','').startswith('0x')"
# The fingerprint is our P2P identity
FP=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('identity',{}).get('fingerprint',''))" 2>/dev/null)
info "Our fingerprint: $FP"
check "Fingerprint is valid" "$R" "assert len(d.get('identity',{}).get('fingerprint','')) == 32"

# ===== 12. Trust Score System =====
echo ""
echo "--- 12. Trust Score System ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/peers")
PEER_COUNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('peers',[])))" 2>/dev/null)
info "Known peers: $PEER_COUNT"
if [ "$PEER_COUNT" -gt "0" ]; then
  check "Peers have trustScore field" "$R" "assert all('trustScore' in p for p in d['peers'])"
  check "Peers have skynetBalance field" "$R" "assert all('skynetBalance' in p for p in d['peers'])"
  check "Peers have skynetBalanceVerified field" "$R" "assert all('skynetBalanceVerified' in p for p in d['peers'])"
  FIRST_PEER=$(echo "$R" | python3 -c "
import sys,json; p=json.load(sys.stdin)['peers'][0]
print(f\"fingerprint={p.get('fingerprint','?')[:16]}..., trust={p.get('trustScore','?')}, skynetBal={p.get('skynetBalance','?')}\")
" 2>/dev/null)
  info "First peer: $FIRST_PEER"
else
  info "No peers connected - trust score verification skipped (expected if solo instance)"
fi

# ===== 13. SKYNET on Arbitrage Scanner =====
echo ""
echo "--- 13. SKYNET in Arbitrage Scanner ---"

R=$(curl -s -H "$H" "$SERVER/api/crypto/strategy/arbitrage/tokens")
check "Arbitrage tokens endpoint works" "$R" "assert d.get('success')"
check "SKYNET in default arb tokens" "$R" "assert any(t.get('symbol')=='SKYNET' for t in d.get('tokens',{}).get('default',[]))"
ARB_TOKENS=$(echo "$R" | python3 -c "import sys,json; print(', '.join(t.get('symbol','?') for t in json.load(sys.stdin).get('tokens',{}).get('default',[])))" 2>/dev/null)
info "Default arb tokens: $ARB_TOKENS"

# ===== 14. Message Handler Types =====
echo ""
echo "--- 14. P2P Message Types Check ---"

# Verify the service-related message types are registered by checking logs
R=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -c 'service_catalog_request\|service_catalog_response\|service_request\|service_result\|service_error\|payment_required\|tip_received' $PRODUCTION_PATH/src/services/p2p/messageHandler.js" 2>/dev/null)
check "Service message handlers exist in code" "\"$R\"" "assert int(d.strip('\"')) >= 7" 2>/dev/null || {
  # Fallback check
  R2=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -c 'service_catalog\|service_request\|service_result\|service_error\|payment_required\|tip_received' $PRODUCTION_PATH/src/services/p2p/messageHandler.js" 2>/dev/null)
  info "Message type handlers found: $R2"
}

# ===== 15. Error Log Check for SKYNET/P2P =====
echo ""
echo "--- 15. Error Log Analysis ---"

SKYNET_ERRORS=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -i 'skynet\|p2p.*error\|service_catalog\|service_request' $PRODUCTION_PATH/logs/errors.log 2>/dev/null | tail -10" 2>/dev/null)
if [ -z "$SKYNET_ERRORS" ]; then
  echo "  PASS: No SKYNET/P2P errors in error log"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  WARN: SKYNET/P2P related entries in error log:"
  echo "$SKYNET_ERRORS" | head -5 | while read line; do echo "        $line"; done
  WARN_COUNT=$((WARN_COUNT + 1))
fi

# Check for any P2P-specific crashes
P2P_CRASHES=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -i 'p2p.*crash\|skynet.*crash\|skynetServiceExecutor.*error\|skynetEconomy.*error' $PRODUCTION_PATH/logs/errors.log 2>/dev/null | wc -l" 2>/dev/null)
if [ "$P2P_CRASHES" -eq "0" ] 2>/dev/null; then
  echo "  PASS: No P2P/SKYNET crashes found"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  WARN: $P2P_CRASHES P2P/SKYNET crash entries found"
  WARN_COUNT=$((WARN_COUNT + 1))
fi

# Check recent P2P activity in all-activity log
P2P_ACTIVITY=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -i 'p2p\|skynet\|service_catalog' $PRODUCTION_PATH/logs/all-activity.log 2>/dev/null | tail -5" 2>/dev/null)
if [ -n "$P2P_ACTIVITY" ]; then
  info "Recent P2P activity:"
  echo "$P2P_ACTIVITY" | while read line; do echo "        $line"; done
fi

# ===== 16. SKYNET Contract Verification =====
echo ""
echo "--- 16. SKYNET On-Chain Verification ---"

# Check the SKYNET contract address is configured
R=$(curl -s -H "$H" "$SERVER/api/crypto/strategy/token-trader/status")
SKYNET_ADDR=$(echo "$R" | python3 -c "
import sys,json
wl = json.load(sys.stdin).get('watchlist',[])
sky = next((t for t in wl if t.get('symbol')=='SKYNET'), None)
print(sky.get('address','') if sky else '')
" 2>/dev/null)
if [ "$SKYNET_ADDR" = "0x8Ef0ecE5687417a8037F787b39417eB16972b04F" ]; then
  echo "  PASS: SKYNET contract address correct"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: SKYNET contract address mismatch: $SKYNET_ADDR"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Verify SKYNET is a system token (locked)
check "SKYNET is system token (locked)" "$R" "assert any(t.get('system')==True and t.get('symbol')=='SKYNET' for t in d.get('watchlist',[]))"

# ===== 17. Knowledge Packs (P2P sharing) =====
echo ""
echo "--- 17. Knowledge Packs ---"

R=$(curl -s -H "$H" "$SERVER/p2p/api/knowledge-packs")
check "Knowledge packs endpoint works" "$R" "assert d.get('success', True)"
KP_COUNT=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('packs', d.get('knowledgePacks', []))))" 2>/dev/null)
info "Knowledge packs: $KP_COUNT"

# ===== 18. ERC-8004 Identity Status =====
echo ""
echo "--- 18. ERC-8004 Identity ---"

R=$(curl -s -H "$H" "$SERVER/api/agent/erc8004/status")
check "ERC-8004 status endpoint works" "$R" "assert d.get('success', True)"
ERC_STATUS=$(echo "$R" | python3 -c "
import sys,json; d=json.load(sys.stdin)
data = d.get('data', d)
status = data.get('status', '?')
chain = data.get('chain', '?')
linked = data.get('walletLinked', '?')
agent_id = data.get('agentId', '?')
print(f'status={status}, chain={chain}, walletLinked={linked}, agentId={agent_id}')
" 2>/dev/null)
info "ERC-8004: $ERC_STATUS"

echo ""
echo "=============================================="
printf "  Results: %d passed, %d failed, %d warnings\n" $PASS_COUNT $FAIL_COUNT $WARN_COUNT
echo "=============================================="
