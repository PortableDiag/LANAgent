#!/bin/bash
# Crypto strategy diagnostic script - reusable for investigation
SERVER="$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"
KEY="${LANAGENT_API_KEY:-your-api-key}"
# Log dirs on production - check both locations
LOGDIR="$PRODUCTION_PATH/logs"
LOGDIR2="/logs"

ssh_cmd() {
  sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no root@$SERVER "$1" 2>/dev/null
}

api_call() {
  curl -s "http://$SERVER$1" -H "x-api-key: $KEY" | python3 -m json.tool 2>/dev/null
}

# Find the freshest log file across both dirs
fresh_log() {
  local name="$1"
  ssh_cmd "ls -t $LOGDIR/$name $LOGDIR2/$name 2>/dev/null | head -1"
}

# Grep across both log dirs for a given filename pattern
grep_logs() {
  local pattern="$1"
  local file="$2"
  local count="${3:-30}"
  # Also check rotated logs (e.g. crypto1.log alongside crypto.log)
  local base="${file%.log}"
  ssh_cmd "cat $LOGDIR/${base}1.log $LOGDIR/${base}.log $LOGDIR2/${base}1.log $LOGDIR2/${base}.log 2>/dev/null | grep -a '$pattern' | tail -$count"
}

CMD="${1:-health}"

case "$CMD" in
  health)
    echo "=== CRYPTO AGENT HEALTH CHECK ==="
    echo ""
    echo "--- Process ---"
    ssh_cmd "pm2 list 2>/dev/null | grep lan-agent"
    echo ""
    echo "--- Server Time & Log Freshness ---"
    ssh_cmd "date; echo '---'; ls -lt $LOGDIR/all-activity.log $LOGDIR/crypto.log $LOGDIR/errors.log 2>/dev/null | head -5"
    echo ""
    echo "--- Token Trader Status (API) ---"
    api_call "/api/crypto/strategy/token-trader/status"
    echo ""
    echo "--- Latest Errors (last 10) ---"
    ssh_cmd "cat $LOGDIR/errors.log $LOGDIR2/errors.log 2>/dev/null | tail -10"
    echo ""
    echo "--- Recent Strategy Cycles ---"
    grep_logs "Strategy.*result\|token_trader result\|TokenTrader BUY\|TokenTrader SELL\|STOP-LOSS\|bearish trend\|Skipping DCA" "all-activity.log" 15
    echo ""
    echo "--- Price Monitor (alive check) ---"
    grep_logs "price monitor" "all-activity.log" 3
    ;;
  status)
    echo "=== Token Trader Status ==="
    api_call "/api/crypto/strategy/token-trader/status"
    echo ""
    echo "=== Strategy Status ==="
    api_call "/api/crypto/strategy/status"
    ;;
  trades)
    echo "=== Recent Trades ==="
    grep_logs "TokenTrader SELL\|TokenTrader BUY\|STOP-LOSS\|Swap confirmed" "crypto.log" "${2:-50}"
    ;;
  errors)
    echo "=== Recent Errors ==="
    ssh_cmd "cat $LOGDIR/errors.log $LOGDIR2/errors.log 2>/dev/null | tail -${2:-30}"
    ;;
  sanity)
    echo "=== Sanity Check & V3 Routing ==="
    grep_logs "sanity\|forceV3\|V3 wins\|V2 wins\|refusing V2\|expectedOutputUsd" "all-activity.log" "${2:-30}"
    ;;
  regime)
    echo "=== Token Trader Regime & Actions ==="
    grep_logs "TokenTrader\|regime\|token_trader result" "all-activity.log" "${2:-30}"
    ;;
  balances)
    echo "=== Wallet Balances ==="
    api_call "/api/crypto/balances"
    ;;
  config)
    echo "=== Strategy Config ==="
    api_call "/api/crypto/strategy/config"
    ;;
  pnl)
    echo "=== PnL History ==="
    grep_logs "PnL\|P&L\|realized\|unrealized" "crypto.log" "${2:-30}"
    ;;
  activity)
    echo "=== Recent Activity ==="
    ssh_cmd "cat $LOGDIR/all-activity.log $LOGDIR2/all-activity.log 2>/dev/null | tail -${2:-50}"
    ;;
  grep)
    echo "=== Custom grep: $2 ==="
    grep_logs "$2" "${4:-all-activity.log}" "${3:-30}"
    ;;
  cat-file)
    echo "=== Remote file: $2 ==="
    ssh_cmd "cat $PRODUCTION_PATH/$2"
    ;;
  *)
    echo "Usage: $0 {health|status|trades|errors|sanity|regime|balances|config|pnl|activity|grep <pattern> [n] [file]|cat-file <path>}"
    ;;
esac
