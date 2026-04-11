#!/bin/bash
# Run on production server via SSH
SERVER="http://$PRODUCTION_SERVER"
SSH_CMD="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

# Write the audit script to production and run it there
$SSH_CMD 'cat > /tmp/crypto-audit.sh << '"'"'SCRIPTEOF'"'"'
#!/bin/bash
cd $PRODUCTION_PATH
source /root/.nvm/nvm.sh && nvm use 20 > /dev/null 2>&1
SERVER="http://localhost"
API_KEY="${LANAGENT_API_KEY:-your-api-key}"

echo "============================================"
echo "  CRYPTO FULL AUDIT (on-server)"
echo "============================================"
echo ""

# --- 1. API PnL ---
echo "=== 1. TOKEN TRADER PnL ==="
TT=$(curl -s -H "X-API-Key: $API_KEY" "$SERVER/api/crypto/strategy/token-trader/status" 2>/dev/null)
echo "$TT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
pos = d.get('"'"'position'"'"', {})
pnl = d.get('"'"'pnl'"'"', {})
tr = d.get('"'"'tracking'"'"', {})
rp = pnl.get('"'"'realized'"'"', 0)
up = pnl.get('"'"'unrealized'"'"', 0)
tp = pnl.get('"'"'total'"'"', 0)
print(f'"'"'Realized: \${rp:.4f}  Unrealized: \${up:.4f}  Total: \${tp:.4f}'"'"')
print(f'"'"'Check r+u = {rp+up:.4f} vs reported {tp:.4f} -> {\"MATCH\" if abs(rp+up-tp)<0.01 else \"MISMATCH\"}'"'"')
bal = pos.get('"'"'tokenBalance'"'"', 0)
entry = pos.get('"'"'averageEntryPrice'"'"', 0)
lp = d.get('"'"'currentPrice'"'"', d.get('"'"'lastPrice'"'"', 0))
ucalc = (lp - entry) * bal
print(f'"'"'Unrealized check: ({lp:.6f} - {entry:.6f}) x {bal:.2f} = \${ucalc:.4f} vs \${up:.4f} -> {\"MATCH\" if abs(ucalc-up)<1 else \"MISMATCH\"}'"'"')
print(f'"'"'Position: {bal:.2f} SIREN @ \${entry:.6f}, peak \${tr.get(\"peakPrice\",0):.6f}, regime {d.get(\"regime\",\"?\")}'"'"')
print(f'"'"'Reserve: \${pos.get(\"stablecoinReserve\",0):.2f}, Gas: \${pnl.get(\"totalGasCost\",0):.4f}'"'"')
print(f'"'"'Scale-outs: {tr.get(\"scaleOutLevelsHit\",[])}'"'"')
print(f'"'"'Config: scaleOut={d.get(\"settings\",{}).get(\"scaleOutPercentByLevel\",{})}'"'"')
"

echo ""

# --- 2. Trade log verification ---
echo "=== 2. TRADE LOG PnL VERIFICATION ==="
python3 -c "
import re

fhe_pnl = siren_pnl = 0
fhe_sells = siren_sells = fhe_buys = siren_buys = 0
siren_spent = siren_received = 0
fhe_spent = fhe_received = 0

sell_re = re.compile(r'TokenTrader SELL: ([\d.]+) (\w+) @ \\\$([\d.]+) \(received \\\$([\d.]+), PnL: \\\$([-\d.]+), gas: \\\$([\d.]+)\)')
buy_re = re.compile(r'TokenTrader BUY: ([\d.]+) (\w+) @ \\\$([\d.]+) \(spent \\\$([\d.]+), gas: \\\$([\d.]+)\)')

for logfile in ['logs/crypto.log', 'logs/all-activity1.log', 'logs/all-activity2.log']:
    try:
        with open(logfile) as f:
            for line in f:
                m = sell_re.search(line)
                if m:
                    token = m.group(2)
                    rcvd = float(m.group(4))
                    pnl = float(m.group(5))
                    if token == 'FHE':
                        fhe_pnl += pnl; fhe_sells += 1; fhe_received += rcvd
                    elif token == 'SIREN':
                        siren_pnl += pnl; siren_sells += 1; siren_received += rcvd
                    continue
                m = buy_re.search(line)
                if m:
                    token = m.group(2)
                    spent = float(m.group(4))
                    if token == 'FHE':
                        fhe_buys += 1; fhe_spent += spent
                    elif token == 'SIREN':
                        siren_buys += 1; siren_spent += spent
    except FileNotFoundError:
        pass

print(f'FHE:   {fhe_buys} buys (spent \${fhe_spent:.2f}), {fhe_sells} sells (rcvd \${fhe_received:.2f}), PnL sum: \${fhe_pnl:.4f}')
print(f'SIREN: {siren_buys} buys (spent \${siren_spent:.2f}), {siren_sells} sells (rcvd \${siren_received:.2f}), PnL sum: \${siren_pnl:.4f}')
print(f'Combined sell PnL: \${fhe_pnl + siren_pnl:.4f}')
print(f'(This should match reported realized PnL)')
"

echo ""

# --- 3. Dollar Maximizer ---
echo "=== 3. DOLLAR MAXIMIZER ==="
STRAT=$(curl -s -H "X-API-Key: $API_KEY" "$SERVER/api/crypto/strategy/status" 2>/dev/null)
echo "$STRAT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
si = d.get('strategyInfo', {})
st = si.get('state', {})
print(f'PnL: \${st.get(\"totalPnL\",0):.4f}, Trades: {st.get(\"tradesExecuted\",0)} exec / {st.get(\"tradesProposed\",0)} proposed')
for net, pos in st.get('positions', {}).items():
    print(f'  {net}: stablecoin=\${pos.get(\"stablecoinAmount\",0):.2f}, native={pos.get(\"nativeAmount\",0):.6f}, entry=\${pos.get(\"entryPrice\",0):.2f}')
"

echo ""

# --- 4. On-chain vs State balances ---
echo "=== 4. ON-CHAIN vs STATE BALANCES ==="
STABLES=$(curl -s -H "X-API-Key: $API_KEY" "$SERVER/api/crypto/stablecoin-balances" 2>/dev/null)
WALLET=$(curl -s -H "X-API-Key: $API_KEY" "$SERVER/api/crypto/status" 2>/dev/null)

echo "$STABLES" | python3 -c "
import sys, json
d = json.load(sys.stdin)
b = d.get('balances', {})
for net, tokens in b.items():
    for tok, amt in tokens.items():
        print(f'  On-chain {net} {tok}: {amt}')
"

echo "$WALLET" | python3 -c "
import sys, json
d = json.load(sys.stdin)
b = d.get('balances', {})
for net, amt in b.items():
    if float(amt) > 0:
        print(f'  On-chain {net} native: {amt}')
"

echo ""
echo "State comparison:"
echo "$STRAT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
si = d.get('strategyInfo', {})
st = si.get('state', {})
tt = d.get('tokenTraderStatus', {})
pos = tt.get('position', {})

# DM state
for net, p in st.get('positions', {}).items():
    print(f'  DM state {net}: \${p.get(\"stablecoinAmount\",0):.2f} stablecoin, {p.get(\"nativeAmount\",0):.6f} native')

# TT state
print(f'  TT state: \${pos.get(\"stablecoinReserve\",0):.2f} stablecoin reserve')
print(f'  TT state: {pos.get(\"tokenBalance\",0):.2f} SIREN tokens')
print()

# Capital allocation check
dm_bsc = st.get('positions',{}).get('bsc',{}).get('stablecoinAmount', 0)
tt_reserve = pos.get('stablecoinReserve', 0)
print(f'  DM BSC stablecoin: \${dm_bsc:.2f}')
print(f'  TT stablecoin reserve: \${tt_reserve:.2f}')
print(f'  Sum: \${dm_bsc + tt_reserve:.2f}')
print(f'  NOTE: On-chain BSC USDT may differ from state due to token purchases')
"

echo ""

# --- 5. All web UI endpoints ---
echo "=== 5. WEB UI ENDPOINTS STATUS ==="
JWT=$(curl -s -X POST "$SERVER/api/auth/login" -H 'Content-Type: application/json' -d '{"password": "lanagent"}' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

for EP in \
    "/api/crypto/status" \
    "/api/crypto/strategy/status" \
    "/api/crypto/strategy/token-trader/status" \
    "/api/crypto/stablecoin-balances" \
    "/api/crypto/network-mode" \
    "/api/crypto/transactions" \
    "/api/crypto/strategy/config" \
    "/api/crypto/settings/disabled-networks" \
    "/api/crypto/refresh-balances" \
    "/api/subagents/crypto/status" \
; do
    RESP=$(curl -s -H "Authorization: Bearer $JWT" "$SERVER$EP" 2>/dev/null)
    SIZE=${#RESP}
    SUCCESS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','?'))" 2>/dev/null)
    ERROR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)
    if [ "$SUCCESS" = "True" ] || [ "$SUCCESS" = "true" ]; then
        echo "  OK   $EP (${SIZE}B)"
    elif [ -n "$ERROR" ] && [ "$ERROR" != "" ] && [ "$ERROR" != "None" ]; then
        echo "  FAIL $EP -> $ERROR"
    elif [ "$SIZE" -gt 20 ]; then
        echo "  OK?  $EP (${SIZE}B, no success field)"
    else
        echo "  ???  $EP (${SIZE}B)"
    fi
done

echo ""

# --- 6. Transactions check ---
echo "=== 6. TRANSACTIONS ENDPOINT ==="
curl -s -H "Authorization: Bearer $JWT" "$SERVER/api/crypto/transactions" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
if isinstance(d, dict):
    if d.get('success') == False:
        print(f'ERROR: {d.get(\"error\")}')
    elif 'transactions' in d or 'data' in d:
        txs = d.get('transactions', d.get('data', []))
        if isinstance(txs, list):
            print(f'Total: {len(txs)} transactions')
            buys = [t for t in txs if t.get('type','').lower() in ('buy','buy_token')]
            sells = [t for t in txs if t.get('type','').lower() in ('sell','sell_token')]
            print(f'  Buys: {len(buys)}, Sells: {len(sells)}')
            if txs:
                last = txs[-1]
                print(f'  Last: {last.get(\"timestamp\",\"?\")} {last.get(\"type\",\"?\")} {last.get(\"amount\",\"?\")} {last.get(\"symbol\",last.get(\"token\",\"?\"))} @ \${last.get(\"price\",\"?\")}')
        else:
            print(f'Type: {type(txs).__name__}, keys: {list(txs.keys()) if isinstance(txs, dict) else \"?\"}')
    else:
        print(f'Keys: {list(d.keys())}')
        for k in list(d.keys())[:5]:
            v = d[k]
            if isinstance(v, list):
                print(f'  {k}: list[{len(v)}]')
            elif isinstance(v, (str,int,float,bool)):
                print(f'  {k}: {v}')
elif isinstance(d, list):
    print(f'Array of {len(d)} items')
" 2>/dev/null

echo ""
echo "============================================"
echo "  AUDIT COMPLETE"
echo "============================================"
SCRIPTEOF
chmod +x /tmp/crypto-audit.sh && bash /tmp/crypto-audit.sh'

