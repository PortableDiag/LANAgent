#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""
TOKEN=$($SSH "curl -s -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{\"password\": \"lanagent\"}'" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

START="2025-01-01T00:00:00.000Z"
END="2027-01-01T00:00:00.000Z"

echo "=== Revenue breakdown structure ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/revenue?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
data=d.get('data',{})
print('Keys:', list(data.keys()))
print('totalUSD:', data.get('totalUSD'))
print('count:', data.get('count'))
breakdown = data.get('breakdown',[])
print('breakdown length:', len(breakdown))
for b in breakdown:
    print('  breakdown item keys:', list(b.keys()))
    print('  values:', {k:v for k,v in b.items() if k != 'records'})
" 2>/dev/null

echo ""
echo "=== Expense breakdown structure ==="
$SSH "curl -s -H 'Authorization: Bearer $TOKEN' 'http://localhost/api/revenue/summary/expense?startDate=${START}&endDate=${END}&groupBy=category'" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
data=d.get('data',{})
print('Keys:', list(data.keys()))
print('totalUSD:', data.get('totalUSD'))
breakdown = data.get('breakdown',[])
print('breakdown length:', len(breakdown))
for b in breakdown:
    print('  breakdown item keys:', list(b.keys()))
    print('  values:', {k:v for k,v in b.items() if k != 'records'})
" 2>/dev/null
