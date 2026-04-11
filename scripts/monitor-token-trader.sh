#!/bin/bash
SERVER="$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"

echo "=== DEPLOYING app.js ==="
sshpass -p "$PASS" scp /media/veracrypt1/NodeJS/LANAgent/src/interfaces/web/public/app.js root@$SERVER:$PRODUCTION_PATH/src/interfaces/web/public/app.js
REMOTE=$(sshpass -p "$PASS" ssh root@$SERVER "wc -l < $PRODUCTION_PATH/src/interfaces/web/public/app.js" 2>/dev/null)
LOCAL=$(wc -l < /media/veracrypt1/NodeJS/LANAgent/src/interfaces/web/public/app.js)
echo "Local: $LOCAL lines, Remote: $REMOTE lines"
if [ "$REMOTE" -lt 100 ]; then echo "ERROR: Remote file too small!"; exit 1; fi
echo "Deployed. Refresh browser to see changes (no restart needed for static files)."
