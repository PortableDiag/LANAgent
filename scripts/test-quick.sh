#!/bin/bash
# Quick API test script - reusable for debugging
HOST="$PRODUCTION_SERVER"
API_KEY="${LANAGENT_API_KEY:-your-api-key}"

echo "=== Triggering fresh report ==="
curl -s --max-time 60 -X POST "http://$HOST/api/background/trigger-weekly-report" \
  -H "X-API-Key: $API_KEY" \
  -H 'Content-Type: application/json' | python3 -m json.tool 2>/dev/null

echo ""
echo "=== Latest report ==="
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" 'mongosh --quiet lanagent --eval "
  const report = db.systemreports.find().sort({createdAt: -1}).limit(1).toArray()[0];
  if (report && report.content) {
    print(report.content.raw);
  } else {
    print(\"No reports found\");
  }
"'
