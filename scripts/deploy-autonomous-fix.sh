#!/bin/bash
# Deploy autonomous services fixes to production

echo "🚀 Deploying autonomous services fixes to production..."

# Files to deploy
FILES_TO_DEPLOY=(
    "src/services/selfModification.js"
    "src/services/pluginDevelopment.js" 
    "src/services/bugFixing.js"
)

# Create timestamp
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
echo "📅 Deployment timestamp: $TIMESTAMP"

# Deploy each file to production
for file in "${FILES_TO_DEPLOY[@]}"; do
    echo "📤 Deploying $file..."
    scp "$file" root@$PRODUCTION_SERVER:$PRODUCTION_PATH/$file
    if [ $? -eq 0 ]; then
        echo "   ✅ $file deployed successfully"
    else
        echo "   ❌ Failed to deploy $file"
        exit 1
    fi
done

echo ""
echo "🔄 Restarting production service..."
ssh root@$PRODUCTION_SERVER 'cd $PRODUCTION_PATH && pm2 restart ecosystem.config.cjs'

if [ $? -eq 0 ]; then
    echo "   ✅ Service restarted successfully"
else
    echo "   ❌ Failed to restart service"
    exit 1
fi

echo ""
echo "🩺 Checking service status..."
ssh root@$PRODUCTION_SERVER 'pm2 status lan-agent'

echo ""
echo "📊 Recent logs:"
ssh root@$PRODUCTION_SERVER 'pm2 logs lan-agent --lines 10 --nostream'

echo ""
echo "🎉 Deployment complete!"
echo ""
echo "What was fixed:"
echo "1. ✅ Self-Modification Service: ENABLED (was disabled)"
echo "2. ✅ Self-Modification Service: Analysis-only mode DISABLED (can make changes now)"
echo "3. ✅ Plugin Development Service: Fixed import statement bug"
echo "4. ✅ Bug Fixing Service: Already properly configured"
echo ""
echo "Next scheduled runs:"
echo "• Plugin Development: Next 24h cycle"
echo "• Bug Fixing: 10 AM & 10 PM daily"
echo "• Self-Modification: Hourly scans (when idle)"