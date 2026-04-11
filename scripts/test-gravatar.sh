#!/bin/bash
# Test Gravatar API key and endpoints
# Usage: ./scripts/test-gravatar.sh

REMOTE="$PRODUCTION_USER@$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"

echo "=== Gravatar API Key Test ==="

# Test directly on the server to avoid shell escaping issues
sshpass -p "$PASS" ssh $REMOTE 'bash -s' << 'REMOTE_SCRIPT'
GKEY=$(grep "^GRAVATAR_API_KEY=" $PRODUCTION_PATH/.env | cut -d= -f2-)
echo "Key prefix: ${GKEY:0:12}..."
echo "Key length: ${#GKEY}"
echo ""

echo "--- Test 1: /me/profile ---"
curl -s -w '\nHTTP: %{http_code}\n' \
  "https://api.gravatar.com/v3/me/profile" \
  -H "Authorization: Bearer ${GKEY}"

echo ""
echo "--- Test 2: /me/avatars ---"
curl -s -w '\nHTTP: %{http_code}\n' \
  "https://api.gravatar.com/v3/me/avatars" \
  -H "Authorization: Bearer ${GKEY}"

echo ""
echo "--- Test 3: Public profile (should work) ---"
HASH=$(echo -n 'alice@lanagent.net' | sha256sum | cut -d' ' -f1)
curl -s -w '\nHTTP: %{http_code}\n' \
  "https://api.gravatar.com/v3/profiles/${HASH}" \
  -H "Authorization: Bearer ${GKEY}" | head -c 200

echo ""
REMOTE_SCRIPT

echo ""
echo "=== Done ==="
