#!/bin/bash

echo "Running simple bug scan test..."

# Create a minimal script to just get the final result
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cat > /tmp/simple-bug-scan.mjs << 'EOF'
import { Agent } from '$PRODUCTION_PATH/src/core/agent.js';

async function testBugScan() {
  try {
    const agent = new Agent();
    await agent.initialize();
    
    const plugin = agent.apiManager.getPlugin('bugDetector');
    if (!plugin) {
      console.log('ERROR: Bug detector plugin not found');
      process.exit(1);
    }
    
    console.log('===== STARTING BUG SCAN =====');
    const result = await plugin.execute({ action: 'scanDaily' });
    console.log('===== BUG SCAN RESULT =====');
    
    if (result.success) {
      console.log('SUCCESS: Scan completed');
      console.log('Bugs found:', result.bugsFound?.length || 0);
      console.log('Scan duration:', result.scanDuration);
      console.log('Summary:', JSON.stringify(result.summary, null, 2));
      
      if (result.bugsFound && result.bugsFound.length > 0) {
        console.log('First bug:', JSON.stringify(result.bugsFound[0], null, 2));
      }
    } else {
      console.log('FAILED:', result.error || 'Unknown error');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('EXCEPTION:', error.message);
    process.exit(1);
  }
}

testBugScan();
EOF"

echo "Executing simple bug scan..."
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source .env && export \$(cat .env | grep -v '^#' | xargs) && timeout 60 node /tmp/simple-bug-scan.mjs"

echo "Simple bug scan completed."