#!/bin/bash
# Run work.sh on the production server
# Configure credentials via environment or deploy.config
_RR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_RR_DIR/deployment/deploy.config" ] && source "$_RR_DIR/deployment/deploy.config" --no-validate

if [ -z "$PRODUCTION_PASS" ] || [ -z "$PRODUCTION_SERVER" ]; then
  echo "Error: Set PRODUCTION_SERVER and PRODUCTION_PASS (via env or scripts/deployment/deploy.local)"
  exit 1
fi

sshpass -p "$PRODUCTION_PASS" ssh -o StrictHostKeyChecking=no "${PRODUCTION_USER:-root}@$PRODUCTION_SERVER" "bash -s" < "$_RR_DIR/work.sh" 2>&1
