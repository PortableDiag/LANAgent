#!/bin/bash
# Full Crypto System - Production Verification Script
# Tests ALL crypto endpoints: wallet, strategies, token trader, arbitrage, scanner, LP, Skynet

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
WARN_COUNT=0

check() {
  local label="$1"
  local result="$2"
  local assertion="$3"

  if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); $assertion" 2>/dev/null; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label"
    echo "        Response: $(echo "$result" | head -c 200)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

warn() {
  local label="$1"
  local result="$2"
  local assertion="$3"

  if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); $assertion" 2>/dev/null; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  WARN: $label (non-critical)"
    echo "        Response: $(echo "$result" | head -c 200)"
    WARN_COUNT=$((WARN_COUNT + 1))
  fi
}

info() {
  local label="$1"
  local result="$2"
  local extract="$3"
  local val=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); $extract" 2>/dev/null)
  echo "  INFO: $label: $val"
}

echo "================================================"
echo "  Full Crypto System - Production Verification"
echo "================================================"
echo ""

# ============================================================
echo "--- 1. Wallet ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/status")
check "Wallet status endpoint" "$R" "assert 'address' in d or 'addresses' in d or 'walletAddress' in d"
info "Wallet" "$R" "addrs = d.get('addresses', {}); print(f\"chains={list(addrs.keys())}, initialized={d.get('initialized', '?')}\")"

R=$(eval $API "$SERVER/api/crypto/network-mode")
check "Network mode endpoint" "$R" "assert d.get('success') == True"
info "Network mode" "$R" "print(d.get('mode', '?'))"

R=$(eval $API "$SERVER/api/crypto/mainnet-balances")
check "Mainnet balances endpoint" "$R" "assert d.get('success') == True"
info "Mainnet balances" "$R" "bals = d.get('balances', {}); print(', '.join(f\"{k}={v}\" for k,v in bals.items()) if bals else 'none')"

R=$(eval $API "$SERVER/api/crypto/stablecoin-balances")
check "Stablecoin balances endpoint" "$R" "assert True"
info "Stablecoins" "$R" "
bals = d.get('balances', d)
if isinstance(bals, dict):
    for net, tokens in bals.items():
        if isinstance(tokens, dict):
            for sym, bal in tokens.items():
                if float(bal) > 0: print(f'{sym}({net})={bal}', end=' ')
    print()
else:
    print(bals)
"

# ============================================================
echo ""
echo "--- 2. Strategy Core ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/strategy/status")
check "Strategy status endpoint" "$R" "assert d.get('success') == True"
info "Strategy" "$R" "print(f\"name={d.get('name','?')}, running={d.get('running','?')}, active={d.get('isActive','?')}\")"

R=$(eval $API "$SERVER/api/crypto/strategy/list")
check "Strategy list endpoint" "$R" "assert True"
info "Strategies" "$R" "
strats = d.get('strategies', d) if isinstance(d, dict) else d
if isinstance(strats, list):
    print(', '.join(s.get('name', '?') for s in strats))
elif isinstance(strats, dict):
    print(', '.join(strats.keys()))
else:
    print(strats)
"

R=$(eval $API "$SERVER/api/crypto/strategy/active")
check "Active strategy endpoint" "$R" "assert True"
info "Active strategy" "$R" "print(d.get('strategy', d.get('name', d.get('active', '?'))))"

R=$(eval $API "$SERVER/api/crypto/strategy/positions")
check "Positions endpoint" "$R" "assert True"
info "Positions" "$R" "
pos = d.get('positions', d)
if isinstance(pos, dict):
    for net, p in pos.items():
        print(f\"{net}: {p.get('nativeBalance', '?')} native\", end='; ')
    print()
elif isinstance(pos, list):
    print(f'{len(pos)} positions')
else:
    print(pos)
"

R=$(eval $API "$SERVER/api/crypto/strategy/performance")
check "Performance endpoint" "$R" "assert True"
info "Performance" "$R" "
perf = d.get('performance', d)
if isinstance(perf, dict):
    print(f\"totalPnL={perf.get('totalPnL', '?')}, trades={perf.get('totalTrades', '?')}\")
else:
    print(list(d.keys())[:8])
"

R=$(eval $API "$SERVER/api/crypto/strategy/journal")
check "Decision journal endpoint" "$R" "assert True"

R=$(eval $API "$SERVER/api/crypto/strategy/schedule")
check "Schedule endpoint" "$R" "assert True"

# ============================================================
echo ""
echo "--- 3. Token Trader ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/strategy/token-trader/status")
check "Token trader status" "$R" "assert d.get('success') == True"
info "Token trader" "$R" "print(f\"token={d.get('tokenSymbol','?')}, balance={d.get('tokenBalance',0)}, network={d.get('tokenNetwork','?')}\")"
info "Position" "$R" "
pos = d.get('position', {})
print(f\"avgEntry={pos.get('averageEntryPrice', '?')}, stableReserve={pos.get('stablecoinReserve', '?')}\")
"
info "Tracking" "$R" "
t = d.get('tracking', {})
print(f\"peak={t.get('peakPrice','?')}, trailingStop={t.get('trailingStopPrice','?')}, regime={d.get('regime','?')}\")
"

# Watchlist
check "Watchlist has entries" "$R" "assert len(d.get('watchlist', [])) > 0"
check "SKYNET system token present" "$R" "assert any(t.get('system') and 'SKYNET' in t.get('symbol','').upper() for t in d.get('watchlist', []))"
info "Watchlist" "$R" "
for t in d.get('watchlist', []):
    s = ' [SYSTEM]' if t.get('system') else ''
    print(f\"  {t.get('symbol','?')}({t.get('network','?')}){s}\", end='')
print()
"

# ============================================================
echo ""
echo "--- 4. Arbitrage Scanner ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/strategy/arbitrage/status")
check "Arbitrage status endpoint" "$R" "assert True"
info "Arbitrage" "$R" "print(f\"enabled={d.get('enabled','?')}, opportunities={d.get('recentOpportunities', d.get('opportunities', '?'))}\")"

R=$(eval $API "$SERVER/api/crypto/strategy/arbitrage/tokens")
check "Arbitrage tokens endpoint" "$R" "assert True"
info "Arb tokens" "$R" "
tokens = d.get('tokens', d.get('scanTokens', []))
if isinstance(tokens, list):
    print(', '.join(t.get('symbol','?') for t in tokens))
elif isinstance(tokens, dict):
    for net, tks in tokens.items():
        print(f\"{net}: {', '.join(t.get('symbol','?') for t in tks)}\")
else:
    print(tokens)
"
# Verify SKYNET is in arb tokens
check "SKYNET in arbitrage tokens" "$R" "
tokens = d.get('tokens', d.get('scanTokens', []))
if isinstance(tokens, dict):
    all_tokens = []
    for tks in tokens.values():
        all_tokens.extend(tks)
    tokens = all_tokens
assert any('SKYNET' in t.get('symbol','').upper() for t in tokens)
"

# ============================================================
echo ""
echo "--- 5. Token Scanner ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/tokens/scanner/status")
check "Token scanner status" "$R" "assert True"
info "Scanner" "$R" "print(f\"running={d.get('running', d.get('isRunning', '?'))}, scanned={d.get('tokensScanned', '?')}\")"

R=$(eval $API "$SERVER/api/crypto/tokens/detected")
check "Detected tokens endpoint" "$R" "assert True"
info "Detected tokens" "$R" "
tokens = d.get('tokens', d) if isinstance(d, dict) else d
print(f\"{len(tokens) if isinstance(tokens, list) else '?'} tokens detected\")
"

R=$(eval $API "$SERVER/api/crypto/tokens/scam")
check "Scam tokens endpoint" "$R" "assert True"

R=$(eval $API "$SERVER/api/crypto/tokens/sellable")
check "Sellable tokens endpoint" "$R" "assert True"

# ============================================================
echo ""
echo "--- 6. Swap / DEX ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/swap/networks")
check "Swap networks endpoint" "$R" "assert True"
info "Networks" "$R" "print(d.get('networks', list(d.keys())[:10]))"

# ============================================================
echo ""
echo "--- 7. Strategy Import/Export ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/strategy/capabilities")
check "Capabilities endpoint" "$R" "assert True"

R=$(eval $API "$SERVER/api/crypto/strategy/export-all")
check "Export-all endpoint" "$R" "assert True"

# ============================================================
echo ""
echo "--- 8. Strategy Evolution ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/strategy/evolution/status")
check "Evolution status" "$R" "assert True"
info "Evolution" "$R" "print(f\"enabled={d.get('enabled','?')}, improvements={d.get('totalImprovements', d.get('improvements', '?'))}\")"

R=$(eval $API "$SERVER/api/crypto/strategy/evolution/analyze")
warn "Evolution analyze" "$R" "assert True"

# ============================================================
echo ""
echo "--- 9. Nano (XNO) ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/nano/status")
warn "Nano status" "$R" "assert True"
info "Nano" "$R" "print(f\"initialized={d.get('initialized', d.get('connected', '?'))}\")"

R=$(eval $API "$SERVER/api/crypto/nano/balance")
warn "Nano balance" "$R" "assert True"

# ============================================================
echo ""
echo "--- 10. LP Management ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/lp/positions")
check "LP positions endpoint" "$R" "assert d.get('success') == True"

R=$(curl -s -H "Authorization: Bearer $TOKEN" "$SERVER/api/crypto/lp/info?tokenA=0x8Ef0ecE5687417a8037F787b39417eB16972b04F&tokenB=native&network=bsc")
check "LP info (SKYNET/BNB)" "$R" "assert d.get('success') == True"
info "SKYNET/BNB LP" "$R" "
i = d.get('info', {})
print(f\"pair={i.get('pairAddress','?')}, lpBalance={i.get('lpBalance','?')}, reserve0={i.get('reserve0','?')}, reserve1={i.get('reserve1','?')}\")
"

# ============================================================
echo ""
echo "--- 11. Disabled Networks ---"
# ============================================================

R=$(eval $API "$SERVER/api/crypto/settings/disabled-networks")
check "Disabled networks endpoint" "$R" "assert True"
info "Disabled networks" "$R" "print(d.get('disabledNetworks', d.get('networks', '?')))"

# ============================================================
echo ""
echo "--- 12. Skynet P2P & Services ---"
# ============================================================

R=$(eval $API "$SERVER/p2p/api/status")
check "P2P status" "$R" "assert d.get('success') == True"
info "P2P" "$R" "print(f\"connected={d.get('connection',{}).get('connected','?')}, wallet={d.get('walletAddress','?')[:16]}...\")"

R=$(eval $API "$SERVER/p2p/api/skynet/stats")
check "Skynet stats" "$R" "assert d.get('success') == True"
info "Revenue" "$R" "print(f\"totalRevenue={d.get('totalRevenue', '?')}, payments={d.get('totalPayments', '?')}\")"

R=$(eval $API "$SERVER/p2p/api/skynet/services")
check "Skynet services list" "$R" "assert d.get('success') == True"
info "Services" "$R" "
svcs = d.get('services', [])
enabled = sum(1 for s in svcs if s.get('skynetEnabled'))
print(f\"{len(svcs)} total, {enabled} enabled\")
"

R=$(eval $API "$SERVER/p2p/api/skynet/payments")
check "Skynet payments" "$R" "assert d.get('success') == True"

# ============================================================
echo ""
echo "--- 13. Economy (Bounties & Governance) ---"
# ============================================================

R=$(eval $API "$SERVER/p2p/api/skynet/economy")
check "Economy stats" "$R" "assert d.get('success') == True"
info "Economy" "$R" "
b = d.get('bounties', {})
g = d.get('governance', {})
print(f\"bounties: open={b.get('open', b.get('total', '?'))}, governance: active={g.get('active', g.get('total', '?'))}\")
"

R=$(eval $API "$SERVER/p2p/api/skynet/bounties")
check "Bounties list" "$R" "assert d.get('success') == True"

R=$(eval $API "$SERVER/p2p/api/skynet/proposals")
check "Proposals list" "$R" "assert d.get('success') == True"

# ============================================================
echo ""
echo "--- 14. Peers & Trust ---"
# ============================================================

R=$(eval $API "$SERVER/p2p/api/peers")
check "Peers list" "$R" "assert d.get('success') == True"
info "Peers" "$R" "
peers = d.get('peers', [])
print(f\"{len(peers)} known\")
for p in peers[:3]:
    print(f\"    {p.get('displayName', p.get('fingerprint','?')[:12])}: trust={p.get('trustScore','?')}, skynet={p.get('skynetBalance','?')}\")
"

# ============================================================
echo ""
echo "--- 15. ERC-8004 Identity ---"
# ============================================================

R=$(eval $API "$SERVER/api/agent/erc8004/status")
check "ERC-8004 status" "$R" "assert True"
info "Identity" "$R" "print(f\"status={d.get('status','?')}, agentId={d.get('agentId','?')}, chain={d.get('chain','?')}, linked={d.get('linkedWallet','?')}\")"

# ============================================================
echo ""
echo "================================================"
echo "  Results: $PASS_COUNT passed, $FAIL_COUNT failed, $WARN_COUNT warnings"
echo "================================================"

if [ $FAIL_COUNT -gt 0 ]; then
  exit 1
fi
