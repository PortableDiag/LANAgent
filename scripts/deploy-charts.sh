#!/bin/bash
SSH="sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER""

echo "=== Deploying app.js, index.html, styles.css ==="
sshpass -p "$PRODUCTION_PASS" scp src/interfaces/web/public/app.js $PRODUCTION_USER@$PRODUCTION_SERVER:$PRODUCTION_PATH/src/interfaces/web/public/app.js
sshpass -p "$PRODUCTION_PASS" scp src/interfaces/web/public/index.html $PRODUCTION_USER@$PRODUCTION_SERVER:$PRODUCTION_PATH/src/interfaces/web/public/index.html
sshpass -p "$PRODUCTION_PASS" scp src/interfaces/web/public/styles.css $PRODUCTION_USER@$PRODUCTION_SERVER:$PRODUCTION_PATH/src/interfaces/web/public/styles.css

echo "=== Static files deployed (no restart needed) ==="
echo ""

echo "=== Verify deployment ==="
$SSH "grep -c 'renderBreakdownChart' $PRODUCTION_PATH/src/interfaces/web/public/app.js" 2>/dev/null
echo "renderBreakdownChart occurrences (should be 3+)"
$SSH "grep -c 'renderProfitOverviewChart' $PRODUCTION_PATH/src/interfaces/web/public/app.js" 2>/dev/null
echo "renderProfitOverviewChart occurrences (should be 2+)"
$SSH "grep 'id=\"revenueChart\"' $PRODUCTION_PATH/src/interfaces/web/public/index.html" 2>/dev/null
echo "(should be div, not canvas)"
