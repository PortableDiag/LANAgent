#!/bin/bash
# Reusable script for remote DB operations
# Edit scripts/db-op.js for the operation, then run this script
sshpass -p "$PRODUCTION_PASS" scp scripts/db-op.js $PRODUCTION_USER@$PRODUCTION_SERVER:$PRODUCTION_PATH/db-op.js 2>/dev/null
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source ~/.nvm/nvm.sh && nvm use 20 > /dev/null 2>&1 && node db-op.js && rm -f db-op.js" 2>&1
