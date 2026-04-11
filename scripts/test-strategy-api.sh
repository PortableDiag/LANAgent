#!/bin/bash
# Test strategy import/export API endpoints on production

HOST="$PRODUCTION_SERVER"
PASSWORD="lanagent"

echo "=== Getting auth token ==="
TOKEN=$(curl -s -X POST "http://$HOST/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\": \"$PASSWORD\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get auth token"
  exit 1
fi
echo "Token obtained: ${TOKEN:0:30}..."

echo ""
echo "=== Test 1: /strategy/capabilities ==="
curl -s -X GET "http://$HOST/api/crypto/strategy/capabilities" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null | head -20

echo ""
echo "=== Test 2: /strategy/export/dollar_maximizer ==="
EXPORT_RESULT=$(curl -s -X GET "http://$HOST/api/crypto/strategy/export/dollar_maximizer?download=false" \
  -H "Authorization: Bearer $TOKEN")
echo "$EXPORT_RESULT" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print('Success:', d.get('success'))
  data = d.get('data', {})
  print('Format Version:', data.get('formatVersion'))
  print('Strategy Type:', data.get('strategy',{}).get('type'))
  print('Metadata Name:', data.get('metadata',{}).get('name'))
except Exception as e:
  print('Parse error:', e)
"

echo ""
echo "=== Test 3: /strategy/list (verify rule_based registered) ==="
curl -s -X GET "http://$HOST/api/crypto/strategy/list" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  strategies = d.get('strategies', [])
  print('Total strategies:', len(strategies))
  for s in strategies:
    name = s.get('name', 'unknown')
    source = s.get('source', '?')
    print(f'  - {name} ({source})')
except Exception as e:
  print('Parse error:', e)
"

echo ""
echo "=== Test 4: /strategy/validate (test validation) ==="
curl -s -X POST "http://$HOST/api/crypto/strategy/validate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "strategy": {
      "formatVersion": "1.0.0",
      "metadata": {"name": "test_rule_strategy"},
      "strategy": {
        "type": "rule_based",
        "config": {
          "rules": [
            {
              "id": "test_rule",
              "name": "Test Rule",
              "conditions": {"indicator": "price_change_24h", "lessThan": -5},
              "action": {"type": "buy", "amount": {"percent": 10}}
            }
          ]
        }
      }
    }
  }' | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print('Valid:', d.get('valid'))
  print('Errors:', d.get('errors', []))
  print('Warnings:', d.get('warnings', [])[:3])
except Exception as e:
  print('Parse error:', e)
"

echo ""
echo "=== Test 5: Check positions unchanged ==="
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "mongosh lanagent --quiet --eval '
const doc = db.subagents.findOne({domain: \"crypto\"});
const reg = doc.state?.domainState?.strategyRegistry;
const dm = reg?.strategies?.dollar_maximizer;
const tt = reg?.strategies?.token_trader;
printjson({
  activeStrategy: reg?.activeStrategy,
  secondaryStrategy: reg?.secondaryStrategy,
  dollarMaximizer: {
    bscStablecoin: dm?.state?.positions?.bsc?.stablecoinAmount,
    ethStablecoin: dm?.state?.positions?.ethereum?.stablecoinAmount
  },
  tokenTrader: {
    tokenBalance: tt?.state?.tokenBalance,
    realizedPnL: tt?.state?.realizedPnL
  }
});
'"

echo ""
echo "=== All tests complete ==="
