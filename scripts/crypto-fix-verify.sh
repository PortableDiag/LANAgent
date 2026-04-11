#!/bin/bash
# Crypto trading fix verification script
# Reusable for deploy + verify operations

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deployment/deploy.config"

API_KEY="${LANAGENT_API_KEY:-your-api-key}"
BASE_URL="http://$PRODUCTION_SERVER"

CMD="${1:-help}"

case "$CMD" in
  syntax)
    echo "=== Syntax Check ==="
    node --check src/services/crypto/strategies/TokenTraderStrategy.js && echo "✓ TokenTraderStrategy.js OK"
    node --check src/services/subagents/CryptoStrategyAgent.js && echo "✓ CryptoStrategyAgent.js OK"
    ;;

  deploy)
    echo "=== Deploying crypto files ==="
    bash "$SCRIPT_DIR/deployment/deploy-files.sh" \
      src/services/crypto/strategies/TokenTraderStrategy.js \
      src/services/subagents/CryptoStrategyAgent.js \
      --no-restart
    ;;

  restart)
    echo "=== Restarting PM2 ==="
    remote_exec "cd $PRODUCTION_PATH && pm2 restart ecosystem.config.cjs --update-env"
    echo "Waiting 15s for startup..."
    sleep 15
    remote_exec "pm2 status lan-agent"
    ;;

  status)
    echo "=== Token Trader Status ==="
    curl -s -H "x-api-key: $API_KEY" "$BASE_URL/api/strategy/token-trader/status" | python3 -m json.tool 2>/dev/null || echo "Failed to reach API"
    ;;

  trigger)
    echo "=== Triggering Strategy ==="
    curl -s -X POST -H "x-api-key: $API_KEY" "$BASE_URL/api/strategy/trigger" | python3 -m json.tool 2>/dev/null || echo "Failed to trigger"
    ;;

  logs)
    echo "=== Recent Crypto Logs ==="
    remote_exec "tail -60 $PRODUCTION_PATH/logs/crypto1.log 2>/dev/null || tail -60 $PRODUCTION_PATH/logs/crypto.log"
    ;;

  errors)
    echo "=== Recent Errors ==="
    remote_exec "tail -30 $PRODUCTION_PATH/logs/errors.log"
    ;;

  portfolio)
    echo "=== Portfolio ==="
    curl -s -H "x-api-key: $API_KEY" "$BASE_URL/api/crypto/portfolio" | python3 -m json.tool 2>/dev/null || echo "Failed to reach API"
    ;;

  full)
    echo "=== Full Deploy + Verify ==="
    bash "$0" syntax && \
    bash "$0" deploy && \
    bash "$0" restart && \
    echo "" && echo "=== Verifying ===" && \
    bash "$0" status && \
    echo "" && \
    bash "$0" logs
    ;;

  help|*)
    echo "Usage: $0 {syntax|deploy|restart|status|trigger|logs|errors|portfolio|full}"
    echo ""
    echo "  syntax    - Check JS syntax"
    echo "  deploy    - Deploy crypto files (no restart)"
    echo "  restart   - Restart PM2 and verify"
    echo "  status    - Get token trader status"
    echo "  trigger   - Trigger strategy cycle"
    echo "  logs      - Show recent crypto logs"
    echo "  errors    - Show recent error logs"
    echo "  portfolio - Show portfolio"
    echo "  full      - Syntax + deploy + restart + verify"
    ;;
esac
