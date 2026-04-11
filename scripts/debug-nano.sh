#!/bin/bash
SERVER="$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"
KEY="${LANAGENT_API_KEY:-your-api-key}"
SRC="/media/veracrypt1/NodeJS/LANAgent"
DST="$PRODUCTION_PATH"

ssh_cmd() {
  sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no root@$SERVER "$1" 2>/dev/null
}

scp_file() {
  sshpass -p "$PASS" scp -o StrictHostKeyChecking=no "$1" "root@$SERVER:$2" 2>/dev/null
}

get_token() {
  curl -s -X POST "http://$SERVER/api/auth/login" -H 'Content-Type: application/json' -d '{"password": "lanagent"}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))' 2>/dev/null
}

CMD="${1:-help}"

case "$CMD" in
  deploy)
    echo "=== Deploy nanoService.js ==="
    scp_file "$SRC/src/services/crypto/nanoService.js" "$DST/src/services/crypto/nanoService.js"
    echo "Done."
    echo ""
    echo "=== Restart PM2 ==="
    ssh_cmd "cd $DST && pm2 restart ecosystem.config.cjs"
    ;;
  deploy-app)
    echo "=== Deploy app.js ==="
    scp_file "$SRC/src/interfaces/web/public/app.js" "$DST/src/interfaces/web/public/app.js"
    echo "Done."
    echo ""
    echo "=== Restart PM2 ==="
    ssh_cmd "cd $DST && pm2 restart ecosystem.config.cjs"
    ;;
  deploy-css)
    echo "=== Deploy styles.css ==="
    scp_file "$SRC/src/interfaces/web/public/styles.css" "$DST/src/interfaces/web/public/styles.css"
    echo "Done (no restart needed for static files)."
    ;;
  deploy-all)
    echo "=== Deploy all changed files ==="
    scp_file "$SRC/src/services/crypto/nanoService.js" "$DST/src/services/crypto/nanoService.js"
    scp_file "$SRC/src/services/crypto/nanoButtonFaucet.js" "$DST/src/services/crypto/nanoButtonFaucet.js"
    scp_file "$SRC/src/services/crypto/faucetService.js" "$DST/src/services/crypto/faucetService.js"
    scp_file "$SRC/src/services/crypto/revenueService.js" "$DST/src/services/crypto/revenueService.js"
    scp_file "$SRC/src/api/faucets.js" "$DST/src/api/faucets.js"
    scp_file "$SRC/src/api/revenue.js" "$DST/src/api/revenue.js"
    scp_file "$SRC/src/interfaces/web/public/app.js" "$DST/src/interfaces/web/public/app.js"
    scp_file "$SRC/src/interfaces/web/public/styles.css" "$DST/src/interfaces/web/public/styles.css"
    echo "Files deployed."
    echo ""
    echo "=== Restart PM2 ==="
    ssh_cmd "cd $DST && pm2 restart ecosystem.config.cjs"
    ;;
  restart)
    echo "=== Restart PM2 ==="
    ssh_cmd "cd $DST && pm2 restart ecosystem.config.cjs"
    ;;
  test-crypto)
    echo "=== Crypto Status (nano balance) ==="
    curl -s "http://$SERVER/api/crypto/status" -H "x-api-key: $KEY" | python3 -c "
import json,sys
data = json.load(sys.stdin)
print('Initialized:', data.get('initialized'))
for addr in data.get('addresses', []):
    if addr.get('chain') == 'nano':
        print('Nano address:', addr.get('address'))
balances = data.get('balances', {})
print('Balances:', json.dumps(balances, indent=2))
" 2>/dev/null
    ;;
  nano-receive)
    echo "=== Pocket Receivable ==="
    TOKEN=$(get_token)
    curl -s -X POST "http://$SERVER/api/crypto/nano/receive" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' | python3 -m json.tool 2>/dev/null
    ;;
  nano-receivable)
    echo "=== Check Receivable ==="
    TOKEN=$(get_token)
    curl -s "http://$SERVER/api/crypto/nano/receivable" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null
    ;;
  transactions)
    echo "=== Recent Transactions ==="
    TOKEN=$(get_token)
    curl -s "http://$SERVER/api/crypto/transactions" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
data = json.load(sys.stdin)
txs = data.get('transactions', data) if isinstance(data, dict) else data
if isinstance(txs, list):
    for tx in txs[:10]:
        print(f\"type={tx.get('type')} chain={tx.get('chain')} tokenIn={tx.get('tokenIn','N/A')} symbolIn={tx.get('symbolIn','N/A')} tokenOut={tx.get('tokenOut','N/A')} symbolOut={tx.get('symbolOut','N/A')}\")
else:
    print(json.dumps(data, indent=2)[:500])
" 2>/dev/null
    ;;
  transactions-raw)
    echo "=== Raw Transactions (first 3) ==="
    TOKEN=$(get_token)
    curl -s "http://$SERVER/api/crypto/transactions" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
data = json.load(sys.stdin)
txs = data.get('transactions', data) if isinstance(data, dict) else data
if isinstance(txs, list):
    for tx in txs[:3]:
        print(json.dumps(tx, indent=2))
        print('---')
" 2>/dev/null
    ;;
  logs)
    echo "=== Recent Error Logs ==="
    ssh_cmd "tail -30 $DST/logs/errors.log"
    ;;
  logs-crypto)
    echo "=== Crypto Logs ==="
    ssh_cmd "tail -50 $DST/logs/crypto.log"
    ;;
  faucet-status)
    echo "=== Nano Faucet Status ==="
    curl -s "http://$SERVER/api/faucets/nano/status" -H "x-api-key: $KEY" | python3 -m json.tool 2>/dev/null
    ;;
  faucet-claim)
    echo "=== Claim Nano Faucet ==="
    TOKEN=$(get_token)
    curl -s -X POST "http://$SERVER/api/faucets/claim/nano" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' | python3 -m json.tool 2>/dev/null
    ;;
  revenue-records)
    echo "=== Revenue Records ==="
    TOKEN=$(get_token)
    curl -s "http://$SERVER/api/revenue/records" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
data = json.load(sys.stdin)
records = data.get('data', [])
if isinstance(records, list):
    for r in records[:10]:
        print(f\"type={r.get('type')} category={r.get('category','N/A')} amount={r.get('amount','N/A')} network={r.get('network','N/A')} description={r.get('description','N/A')[:60]}\")
    print(f'Total records: {len(records)}')
else:
    print(json.dumps(data, indent=2)[:500])
" 2>/dev/null
    ;;
  nano-check-tx)
    echo "=== Check Nano TX Hash ==="
    HASH="${2:-}"
    if [ -z "$HASH" ]; then
      echo "Usage: $0 nano-check-tx <BLOCK_HASH>"
      exit 1
    fi
    ssh_cmd "curl -s -d '{\"action\":\"block_info\",\"json_block\":\"true\",\"hash\":\"$HASH\"}' https://rainstorm.city/api" | python3 -m json.tool 2>/dev/null
    ;;
  nano-receivable-rpc)
    echo "=== Nano Receivable (direct RPC) ==="
    ADDR="nano_3tapbs5faoktmcdo4uxfdqm7e48bumpbw5ymoebcs4sgja8wqtrur6zphg5q"
    ssh_cmd "curl -s -d '{\"action\":\"receivable\",\"account\":\"$ADDR\",\"count\":\"10\",\"threshold\":\"1\"}' https://rainstorm.city/api" | python3 -m json.tool 2>/dev/null
    ;;
  nano-balance-rpc)
    echo "=== Nano Balance (direct RPC, uncached) ==="
    ADDR="nano_3tapbs5faoktmcdo4uxfdqm7e48bumpbw5ymoebcs4sgja8wqtrur6zphg5q"
    ssh_cmd "curl -s -d '{\"action\":\"account_balance\",\"account\":\"$ADDR\"}' https://rainstorm.city/api" | python3 -m json.tool 2>/dev/null
    ;;
  nano-account-history)
    echo "=== Nano Account History ==="
    ADDR="nano_3tapbs5faoktmcdo4uxfdqm7e48bumpbw5ymoebcs4sgja8wqtrur6zphg5q"
    ssh_cmd "curl -s -d '{\"action\":\"account_history\",\"account\":\"$ADDR\",\"count\":\"10\"}' https://rainstorm.city/api" | python3 -m json.tool 2>/dev/null
    ;;
  check-all)
    echo "=== Balance ==="
    curl -s "http://$SERVER/api/crypto/status" -H "x-api-key: $KEY" | python3 -c "
import json,sys
data = json.load(sys.stdin)
balances = data.get('balances', {})
for chain, bal in balances.items():
    print(f'  {chain}: {bal}')
" 2>/dev/null
    echo ""
    echo "=== Nano Receivable ==="
    TOKEN=$(get_token)
    curl -s "http://$SERVER/api/crypto/nano/receivable" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null
    echo ""
    echo "=== Faucet Status ==="
    curl -s "http://$SERVER/api/faucets/nano/status" -H "x-api-key: $KEY" | python3 -m json.tool 2>/dev/null
    ;;
  *)
    echo "Usage: $0 {deploy|deploy-app|deploy-css|deploy-all|restart|test-crypto|nano-receive|nano-receivable|transactions|transactions-raw|revenue-records|logs|logs-crypto|faucet-status|faucet-claim|check-all}"
    ;;
esac
