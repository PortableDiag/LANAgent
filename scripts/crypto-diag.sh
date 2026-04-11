#!/bin/bash
# Crypto strategy diagnostic - check ETH sell details and gas costs
PASS="$PRODUCTION_PASS"
HOST="$PRODUCTION_SERVER"
DEPLOY="$PRODUCTION_PATH"

run_ssh() {
  sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no root@$HOST "$1"
}

echo "===== LAST ETH SELL TX DETAILS ====="
run_ssh "grep -a 'sell_native\|Profit selling\|sold_to_stablecoin\|Swap confirmed\|gas\|gasUsed\|receipt' $DEPLOY/logs/all-activity.log | tail -10"

echo ""
echo "===== DOLLAR MAXIMIZER TRADE HISTORY ====="
run_ssh "grep -a 'Dollar profit\|trade.*executed\|Swapping\|Best swap\|Output sanity\|V3 selected' $DEPLOY/logs/all-activity.log | tail -10"

echo ""
echo "===== LATEST STRATEGY DECISIONS ====="
run_ssh "grep -a 'Strategy.*result\|trade decision\|TokenTrader.*SIDEWAYS\|TokenTrader.*regime' $DEPLOY/logs/all-activity.log | tail -10"

echo ""
echo "===== TOKEN TRADER POSITION VALUE ====="
run_ssh "grep -a 'price monitor\|FHE' $DEPLOY/logs/crypto.log | tail -5"

echo "====="
