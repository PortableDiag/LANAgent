#!/bin/bash
SERVER="$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"
KEY="${LANAGENT_API_KEY:-your-api-key}"

api_get() { curl -s "http://$SERVER$1" -H "x-api-key: $KEY" 2>/dev/null; }
ssh_cmd() { sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no root@$SERVER "$1" 2>/dev/null; }

echo "========================================="
echo "  TOKEN COMPARISON: Cake vs SIREN"
echo "  $(date '+%Y-%m-%d %H:%M')"
echo "========================================="

# Cake price + 24h history
echo ""
echo "--- CAKE (PancakeSwap) ---"
echo "Address: 0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"
api_get "/api/crypto/swap/quote" -X POST -d '{"tokenIn":"0x55d398326f99059fF775485246999027B3197955","tokenOut":"0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82","amountIn":"100","network":"bsc"}' | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    q = d.get("quote", {})
    out = float(q.get("amountOut", 0))
    price = 100 / out if out > 0 else 0
    print(f"  Current price: ${price:.4f}")
    print(f"  100 USDT buys: {out:.2f} Cake")
    print(f"  Protocol: {q.get(\"protocolVersion\", \"?\")}")
except Exception as e:
    print(f"  Quote error: {e}")
' 2>/dev/null

# SIREN price
echo ""
echo "--- SIREN ---"
echo "Address: 0x997a58129890bbda032231a52ed1ddc845fc18e1"
api_get "/api/crypto/swap/quote" -X POST -d '{"tokenIn":"0x55d398326f99059fF775485246999027B3197955","tokenOut":"0x997a58129890bbda032231a52ed1ddc845fc18e1","amountIn":"100","network":"bsc"}' | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    q = d.get("quote", {})
    out = float(q.get("amountOut", 0))
    price = 100 / out if out > 0 else 0
    print(f"  Current price: ${price:.4f}")
    print(f"  100 USDT buys: {out:.2f} SIREN")
    print(f"  Protocol: {q.get(\"protocolVersion\", \"?\")}")
except Exception as e:
    print(f"  Quote error: {e}")
' 2>/dev/null

# Liquidity check - how much slippage on $500 trade
echo ""
echo "--- LIQUIDITY DEPTH ($500 trade) ---"

echo "  Cake:"
api_get "/api/crypto/swap/quote" -X POST -d '{"tokenIn":"0x55d398326f99059fF775485246999027B3197955","tokenOut":"0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82","amountIn":"500","network":"bsc"}' | python3 -c '
import sys, json
d = json.load(sys.stdin)
q = d.get("quote", {})
out500 = float(q.get("amountOut", 0))
price500 = 500 / out500 if out500 > 0 else 0
print(f"    $500 price: ${price500:.4f}/token")
' 2>/dev/null
api_get "/api/crypto/swap/quote" -X POST -d '{"tokenIn":"0x55d398326f99059fF775485246999027B3197955","tokenOut":"0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82","amountIn":"10","network":"bsc"}' | python3 -c '
import sys, json
d = json.load(sys.stdin)
q = d.get("quote", {})
out10 = float(q.get("amountOut", 0))
price10 = 10 / out10 if out10 > 0 else 0
print(f"    $10 price:  ${price10:.4f}/token")
impact = ((price500 - price10) / price10 * 100) if price10 > 0 else 0
print(f"    Price impact ($10 vs $500): {impact:.3f}%")
' 2>/dev/null

echo "  SIREN:"
api_get "/api/crypto/swap/quote" -X POST -d '{"tokenIn":"0x55d398326f99059fF775485246999027B3197955","tokenOut":"0x997a58129890bbda032231a52ed1ddc845fc18e1","amountIn":"500","network":"bsc"}' | python3 -c '
import sys, json
d = json.load(sys.stdin)
q = d.get("quote", {})
out500 = float(q.get("amountOut", 0))
price500 = 500 / out500 if out500 > 0 else 0
print(f"    $500 price: ${price500:.6f}/token")
' 2>/dev/null
api_get "/api/crypto/swap/quote" -X POST -d '{"tokenIn":"0x55d398326f99059fF775485246999027B3197955","tokenOut":"0x997a58129890bbda032231a52ed1ddc845fc18e1","amountIn":"10","network":"bsc"}' | python3 -c '
import sys, json
d = json.load(sys.stdin)
q = d.get("quote", {})
out10 = float(q.get("amountOut", 0))
price10 = 10 / out10 if out10 > 0 else 0
print(f"    $10 price:  ${price10:.6f}/token")
impact = ((price500 - price10) / price10 * 100) if price10 > 0 else 0
print(f"    Price impact ($10 vs $500): {impact:.3f}%")
' 2>/dev/null

# Token tax check
echo ""
echo "--- TOKEN TAX ---"
ssh_cmd "grep -a 'Token tax for Cake\|Token tax for SIREN' $PRODUCTION_PATH/logs/all-activity.log | tail -4"

# Recent trading history for both
echo ""
echo "--- RECENT TRADE HISTORY ---"
echo "  Cake trades:"
ssh_cmd "grep -a 'TokenTrader.*Cake' $PRODUCTION_PATH/logs/all-activity.log | tail -5"
echo ""
echo "  SIREN trades:"
ssh_cmd "grep -a 'TokenTrader.*SIREN' $PRODUCTION_PATH/logs/all-activity.log | tail -5"

# Circuit breaker history
echo ""
echo "--- CIRCUIT BREAKER HISTORY ---"
echo "  SIREN stops:"
ssh_cmd "grep -ac 'Stop-loss.*SIREN\|SIREN.*STOP-LOSS' $PRODUCTION_PATH/logs/all-activity.log"
echo "  Cake stops:"
ssh_cmd "grep -ac 'Stop-loss.*Cake\|Cake.*STOP-LOSS' $PRODUCTION_PATH/logs/all-activity.log"

# Volatility - price mentions
echo ""
echo "--- RECENT PRICE ACTION ---"
echo "  Cake prices (last 6 readings):"
ssh_cmd "grep -a 'bsc-cake=\|Cake=$' $PRODUCTION_PATH/logs/all-activity.log | tail -6" | sed 's/.*\(Cake=\$[0-9.]*\|bsc-cake=\$[0-9.]*\).*/  \1/'
echo ""
echo "  SIREN prices (last 6 readings):"
ssh_cmd "grep -a 'bsc-siren=\|SIREN.*@' $PRODUCTION_PATH/logs/all-activity.log | tail -6"

echo ""
echo "========================================="
echo "  COMPARISON COMPLETE"
echo "========================================="
