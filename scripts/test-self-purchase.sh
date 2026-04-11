#!/bin/bash
# Self-purchase test: ALICE pays herself to execute code in the sandbox
cd /media/veracrypt1/NodeJS/LANAgent
HOST="http://$PRODUCTION_SERVER"
EXT="https://api.lanagent.net"

echo "=== Step 1: Get auth token ==="
TOKEN=$(curl -s -X POST "$HOST/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"password": "lanagent"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "Token: ${TOKEN:0:30}..."

echo ""
echo "=== Step 2: Send 0.002 BNB to self ==="
# Write script INTO the deploy dir so it resolves node_modules + uses actual decrypt
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cat > $PRODUCTION_PATH/send-bnb.mjs << 'SCRIPT'
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import crypto from 'crypto';

// Replicate src/utils/encryption.js decrypt (aes-256-gcm + PBKDF2)
function decryptSeed(encryptedData) {
  const encKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const combined = Buffer.from(encryptedData, 'base64');
  const salt = combined.slice(0, 32);
  const iv = combined.slice(32, 48);
  const tag = combined.slice(48, 64);
  const encrypted = combined.slice(64);
  const key = crypto.pbkdf2Sync(encKey, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
await mongoose.connect(MONGODB_URI);

const wallet = await mongoose.connection.db.collection('cryptowallets').findOne({});
if (!wallet || !wallet.encryptedSeed) {
  console.error('ERROR: No wallet found');
  process.exit(1);
}

const mnemonic = decryptSeed(wallet.encryptedSeed);
const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');
const signer = ethers.Wallet.fromPhrase(mnemonic, provider);

console.error('Sending 0.002 BNB from ' + signer.address);
const tx = await signer.sendTransaction({
  to: '0xc0C0D080650C941D8901889248c6eD4C31Ef08F4',
  value: ethers.parseEther('0.002')
});
console.log(tx.hash);
await mongoose.disconnect();
SCRIPT
"

TX_HASH=$(sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source ~/.nvm/nvm.sh && nvm use 20 2>&1 >/dev/null && node send-bnb.mjs 2>&1 | grep '^0x'")

echo "TX Hash: $TX_HASH"

if [ -z "$TX_HASH" ]; then
  echo "Debug:"
  sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "cd $PRODUCTION_PATH && source ~/.nvm/nvm.sh && nvm use 20 2>/dev/null >/dev/null && node send-bnb.mjs 2>&1"
  exit 1
fi

echo ""
echo "=== Step 3: Wait for 3+ confirmations (~18s on BSC) ==="
sleep 18

echo ""
echo "=== Step 4: Execute Python code in sandbox with REAL payment ==="
EXEC_RESULT=$(curl -s --max-time 60 -X POST "$EXT/api/external/sandbox/execute" \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Id: 2930' \
  -H 'X-Agent-Chain: bsc' \
  -H "X-Payment-Tx: $TX_HASH" \
  -d '{
    "language": "python",
    "code": "import sys, platform\nprint(\"Hello from ALICE Code Sandbox!\")\nprint(f\"Python {sys.version}\")\nprint(f\"Platform: {platform.platform()}\")\nprint(f\"Sum of 1-100: {sum(range(1, 101))}\")\nprint(\"First customer: Agent #2930 (self-test)\")",
    "timeout": 15
  }')

echo "Sandbox response:"
echo "$EXEC_RESULT" | python3 -m json.tool 2>/dev/null

SUCCESS=$(echo "$EXEC_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success',''))" 2>/dev/null)
EXIT_CODE=$(echo "$EXEC_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('exitCode',''))" 2>/dev/null)

echo ""
if [ "$SUCCESS" = "True" ] && [ "$EXIT_CODE" = "0" ]; then
  echo "✅ SANDBOX EXECUTION SUCCESSFUL!"
else
  echo "❌ Execution failed — success=$SUCCESS exitCode=$EXIT_CODE"
fi

echo ""
echo "=== Step 5: Test REPLAY PROTECTION (reuse same tx hash) ==="
REPLAY_RESULT=$(curl -s -X POST "$EXT/api/external/sandbox/execute" \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Id: 2930' \
  -H 'X-Agent-Chain: bsc' \
  -H "X-Payment-Tx: $TX_HASH" \
  -d '{"language": "python", "code": "print(\"should not run\")", "timeout": 5}')
REPLAY_ERR=$(echo "$REPLAY_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)
echo "Replay attempt: $REPLAY_ERR"
if echo "$REPLAY_ERR" | grep -qi "already used"; then
  echo "✅ Double-spend protection works!"
else
  echo "❌ Double-spend NOT detected"
fi

echo ""
echo "=== Step 6: Test FAKE TX (spoofed hash) ==="
FAKE_RESULT=$(curl -s -X POST "$EXT/api/external/sandbox/execute" \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Id: 2930' \
  -H 'X-Agent-Chain: bsc' \
  -H 'X-Payment-Tx: 0xdeadbeef0000000000000000000000000000000000000000000000000000dead' \
  -d '{"language": "python", "code": "print(\"should not run\")", "timeout": 5}')
FAKE_ERR=$(echo "$FAKE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)
echo "Fake TX attempt: $FAKE_ERR"
if echo "$FAKE_ERR" | grep -qi "not found\|failed\|verification"; then
  echo "✅ Fake TX rejected!"
else
  echo "❌ Fake TX not properly rejected"
fi

echo ""
echo "=== Step 7: Verify payment recorded ==="
curl -s "$HOST/api/external/admin/payments?limit=1" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
payments = d.get('payments',[])
if payments:
    p = payments[0]
    print(f'Latest payment: {p[\"amount\"]} BNB from agent {p[\"callerAgentId\"]} for {p[\"serviceId\"]}')
    print(f'TX: {p[\"txHash\"]}')
    print(f'Block: {p.get(\"blockNumber\",\"?\")} | Confirmations: {p.get(\"confirmations\",\"?\")}')
else:
    print('No payments recorded')
" 2>/dev/null

echo ""
echo "=== Step 8: ALICE reports her stats ==="
curl -s -X POST "$HOST/api/command/execute" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"command": "show external service stats"}' | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('data',{}).get('content','No response'))
" 2>/dev/null

# Cleanup
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "rm -f $PRODUCTION_PATH/send-bnb.mjs" 2>/dev/null

echo ""
echo "=== Done ==="
