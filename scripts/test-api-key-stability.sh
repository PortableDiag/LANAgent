#!/bin/bash

API_KEY="${LANAGENT_API_KEY:-your-api-key}"
URL="http://$PRODUCTION_SERVER/api/system/status"

echo "Testing API key stability..."
echo "API Key: $API_KEY"
echo "Testing every 5 seconds for 2 minutes"
echo "=================================="

success=0
failed=0

for i in {1..24}; do
    echo -n "Test $i at $(date '+%H:%M:%S'): "
    
    response=$(curl -s -w "\n%{http_code}" -X GET "$URL" \
        -H "X-API-Key: $API_KEY" \
        -H "Content-Type: application/json" \
        --connect-timeout 5)
    
    http_code=$(echo "$response" | tail -n1)
    
    if [ "$http_code" = "200" ]; then
        echo "✅ SUCCESS (HTTP 200)"
        ((success++))
    else
        echo "❌ FAILED (HTTP $http_code)"
        ((failed++))
        
        # Show response body on failure
        echo "Response: $(echo "$response" | head -n-1)"
    fi
    
    if [ $i -lt 24 ]; then
        sleep 5
    fi
done

echo ""
echo "=================================="
echo "Test Summary:"
echo "Total tests: $((success + failed))"
echo "Successful: $success"
echo "Failed: $failed"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", $success/($success+$failed)*100}")%"