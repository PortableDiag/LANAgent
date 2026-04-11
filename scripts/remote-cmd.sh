#!/bin/bash
SERVER="$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"
API_KEY="${LANAGENT_API_KEY:-your-api-key}"

CMD=$(cat <<'REMOTECMD'
API="http://localhost"
KEY="${LANAGENT_API_KEY:-your-api-key}"

echo "Waiting for server to be ready..."
for i in $(seq 1 30); do
  RESP=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/auth/login" -X POST -H "Content-Type: application/json" -d '{"password": "lanagent"}' 2>/dev/null)
  if [ "$RESP" = "200" ]; then
    echo "Server is ready (attempt $i)"
    break
  fi
  sleep 5
done

TOKEN=$(curl -s -X POST "$API/api/auth/login" -H "Content-Type: application/json" -d '{"password": "lanagent"}' | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))")

echo "=== Re-index intents ==="
curl -s -X POST "$API/api/vector-intent/index" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('Indexed:', d.get('totalIndexed'))"
sleep 10

echo ""
echo "=== TEST 1: List Readarr Authors ==="
echo "Query: 'what authors do I have in readarr'"
RESULT=$(curl -s --max-time 60 -X POST "$API/api/command/execute" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"command": "what authors do I have in readarr"}' 2>/dev/null)
echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); data=d.get('data',{}); c=data.get('content','') if isinstance(data,dict) else str(data); print('Result:', c[:300])"

sleep 5

echo ""
echo "=== TEST 2: Search for Andy Weir ==="
echo "Query: 'search readarr for Andy Weir'"
RESULT=$(curl -s --max-time 60 -X POST "$API/api/command/execute" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"command": "search readarr for Andy Weir"}' 2>/dev/null)
echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); data=d.get('data',{}); c=data.get('content','') if isinstance(data,dict) else str(data); print('Result:', c[:300])"

sleep 5

echo ""
echo "=== TEST 3: Add Andy Weir to readarr ==="
echo "Query: 'add Andy Weir to readarr'"
RESULT=$(curl -s --max-time 60 -X POST "$API/api/command/execute" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"command": "add Andy Weir to readarr"}' 2>/dev/null)
echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); data=d.get('data',{}); c=data.get('content','') if isinstance(data,dict) else str(data); print('Result:', c[:300])"

sleep 5

echo ""
echo "=== TEST 4: Delete Andy Weir from readarr ==="
echo "Query: 'remove Andy Weir from readarr'"
RESULT=$(curl -s --max-time 60 -X POST "$API/api/command/execute" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"command": "remove Andy Weir from readarr"}' 2>/dev/null)
echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); data=d.get('data',{}); c=data.get('content','') if isinstance(data,dict) else str(data); print('Result:', c[:300])"

sleep 3

echo ""
echo "=== TEST 5: Radarr Health ==="
echo "Query: 'is radarr healthy'"
RESULT=$(curl -s --max-time 60 -X POST "$API/api/command/execute" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"command": "is radarr healthy"}' 2>/dev/null)
echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); data=d.get('data',{}); c=data.get('content','') if isinstance(data,dict) else str(data); print('Result:', c[:300])"

echo ""
echo "=== LATEST INTENT LOG ==="
grep -iE 'Disambiguating|Vector match|Executing plugin.*(readarr|radarr)|get_authors|add_author|search_author|delete_author' $PRODUCTION_PATH/logs/all-activity.log 2>/dev/null | tail -20

REMOTECMD
)

sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no root@$SERVER "$CMD"
