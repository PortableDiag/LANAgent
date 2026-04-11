#!/bin/bash
# Test ERC-8004 Agent Identity endpoints
# Usage: ./scripts/test-erc8004.sh

HOST="http://$PRODUCTION_SERVER"

# Get JWT token
TOKEN=$(curl -s -X POST "$HOST/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"password": "lanagent"}' | jq -r '.token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: Failed to get auth token"
  exit 1
fi

echo "=== ERC-8004 Agent Identity Tests ==="
echo ""

echo "--- 1. GET /api/agent/erc8004/status ---"
curl -s "$HOST/api/agent/erc8004/status" \
  -H "Authorization: Bearer $TOKEN" | jq .
echo ""

echo "--- 2. POST /api/agent/erc8004/registration (preview) ---"
curl -s -X POST "$HOST/api/agent/erc8004/registration" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq '{
    success: .success,
    name: .data.name,
    version: .data.version,
    chain: .data.chain,
    capabilitiesCount: (.data.capabilities | length),
    enabledCount: ([.data.capabilities[] | select(.enabled == true)] | length),
    interfaces: .data.interfaces,
    hash: .data.capabilitiesHash
  }'
echo ""

echo "--- 3. GET /api/agent/erc8004/pinata-key ---"
curl -s "$HOST/api/agent/erc8004/pinata-key" \
  -H "Authorization: Bearer $TOKEN" | jq .
echo ""

echo "--- 4. Re-check status (should be 'local' after registration) ---"
curl -s "$HOST/api/agent/erc8004/status" \
  -H "Authorization: Bearer $TOKEN" | jq '{
    status: .data.status,
    chain: .data.chain,
    agentId: .data.agentId,
    isStale: .data.isStale,
    registryAddress: .data.registryAddress,
    gasEstimate: .data.gasEstimate
  }'
echo ""

echo "--- 5. Overview identity status in agent info ---"
curl -s "$HOST/api/agent/identity" \
  -H "Authorization: Bearer $TOKEN" | jq '{
    name: .data.name,
    version: .data.version,
    pluginCount: .data.pluginCount,
    interfaces: .data.interfaces
  }'
echo ""

echo "=== Done ==="
