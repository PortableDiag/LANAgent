#!/bin/bash
# Deploy Chainlink price routes to the api.lanagent.net gateway
# Self-contained script — copies the patch script to VPS and runs it

set -e

VPS="root@137.184.2.62"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_FILE="$SCRIPT_DIR/contracts/skynet-diamond/scripts/add-price-routes.mjs"

echo "=== Deploying Chainlink price routes to gateway ==="
echo "VPS: $VPS"
echo "Patch: $PATCH_FILE"

# Copy patch script to VPS
scp "$PATCH_FILE" "$VPS:/tmp/add-price-routes.mjs"

# Run the patch and restart
ssh "$VPS" "cd /opt/scrape-gateway && node /tmp/add-price-routes.mjs && pm2 restart scrape-gateway && echo 'Gateway restarted' && rm /tmp/add-price-routes.mjs"

echo "=== Done ==="
