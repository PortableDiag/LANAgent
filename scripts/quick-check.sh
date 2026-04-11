#!/bin/bash
# Reusable quick-check script — edit the command below as needed
SSH_CMD="sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "$PRODUCTION_USER@$PRODUCTION_SERVER""
API="http://$PRODUCTION_SERVER/api"
KEY="${LANAGENT_API_KEY:-your-api-key}"

# --- Edit below this line ---
# Check SIREN trading status
echo "=== Recent SIREN activity ==="
# Full PNL breakdown
curl -s "$API/crypto/strategy/status" -H "X-API-Key: $KEY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d.get('state',{})
si=d.get('strategyInfo',{}).get('state',{})
tt=d.get('tokenTraderStatus',{})
ttp=tt.get('pnl',{})
print('=== Dollar Maximizer ===')
print(f'  Total PnL: \${s.get(\"totalPnL\",0):.4f}')
print(f'  Daily PnL: \${s.get(\"dailyPnL\",0):.4f}')
print(f'  Trades: {si.get(\"tradesExecuted\",0)} exec / {si.get(\"tradesProposed\",0)} proposed')
print()
print('=== Token Trader ===')
print(f'  Current realized: \${ttp.get(\"realized\",0):.2f}')
print(f'  Current unrealized: \${ttp.get(\"unrealized\",0):.2f}')
print(f'  Current total: \${ttp.get(\"total\",0):.2f}')
print(f'  Lifetime realized: \${ttp.get(\"lifetimeRealized\",0):.2f}')
print(f'  Lifetime gas: \${ttp.get(\"lifetimeGasCost\",0):.2f}')
print()
print('=== Overall ===')
overall = s.get('totalPnL',0) + ttp.get('lifetimeRealized',0)
print(f'  Combined PnL: \${overall:.2f}')
print(f'  Trades executed (global): {s.get(\"tradesExecuted\",0)}')
"
echo ""
echo "=== Token Trader Status ==="
curl -s "$API/crypto/strategy/token-trader/status" -H "X-API-Key: $KEY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'Token: {d.get(\"tokenSymbol\",\"?\")}')
print(f'Regime: {d.get(\"regime\")}')
print(f'Price: \${d.get(\"currentPrice\",d.get(\"lastPrice\",0)):.6f}')
print(f'Entry: \${d.get(\"averageEntryPrice\",0):.6f}')
print(f'Balance: {d.get(\"tokenBalance\",0):.4f}')
print(f'Reserve: \${d.get(\"stablecoinReserve\",0):.2f}')
print(f'CB: tripped={d.get(\"circuitBreaker\",{}).get(\"tripped\")}, stops={d.get(\"circuitBreaker\",{}).get(\"consecutiveStopLosses\")}')
"
