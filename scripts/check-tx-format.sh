#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""
TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

echo "=== Full transaction data (first 3) ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/transactions" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    if isinstance(d, list):
        for tx in d[:3]:
            print(json.dumps(tx, indent=2, default=str))
            print('---')
        print(f'Total: {len(d)} transactions')
    else:
        print(json.dumps(d, indent=2)[:1000])
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null

echo ""
echo "=== Wallet addresses stored ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost/api/crypto/status" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    for a in d.get('addresses',[]):
        print(f\"  chain={a.get('chain')}, name={a.get('name')}, addr={a.get('address','')[:20]}...\")
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null
