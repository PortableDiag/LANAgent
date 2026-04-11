#!/bin/bash
# Deploy SKYNET BEP-20 token to BSC mainnet
# This script runs on the production server
set -e

DEPLOY_DIR="$PRODUCTION_PATH"
CONTRACT_DIR="$DEPLOY_DIR/contracts/skynet-token"

echo "=== SKYNET Token Deployment ==="
echo ""

# Source environment
source ~/.nvm/nvm.sh
nvm use 20

# Extract private key from ALICE's wallet
echo "[1/5] Extracting deployment wallet..."
cd "$DEPLOY_DIR"

PRIVATE_KEY=$(node -e '
async function main() {
  const mongoose = (await import("mongoose")).default;
  const { decrypt } = await import("./src/utils/encryption.js");
  const CryptoWallet = (await import("./src/models/CryptoWallet.js")).default;
  const { ethers } = await import("ethers");

  await mongoose.connect("mongodb://localhost:27017/lanagent");
  const wallet = await CryptoWallet.findOne({});
  if (!wallet) { console.error("No wallet found"); process.exit(1); }

  const mnemonic = decrypt(wallet.encryptedSeed);
  const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);
  // Output only the private key
  process.stdout.write(derivedWallet.privateKey);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
' 2>/dev/null)

if [ -z "$PRIVATE_KEY" ]; then
    echo "ERROR: Failed to extract private key"
    exit 1
fi
echo "Wallet key extracted successfully"

# Install dependencies
echo "[2/5] Installing Hardhat dependencies..."
cd "$CONTRACT_DIR"
npm install 2>&1 | tail -3

# Compile contract
echo "[3/5] Compiling SkynetToken..."
npx hardhat compile --config hardhat.config.cjs 2>&1

# Run tests
echo "[4/5] Running tests..."
npx hardhat test --config hardhat.config.cjs 2>&1

# Deploy to BSC mainnet
echo "[5/5] Deploying to BSC mainnet..."
export PRIVATE_KEY
DEPLOY_OUTPUT=$(npx hardhat run scripts/deploy.cjs --network bsc --config hardhat.config.cjs 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract and save deployment info
DEPLOYMENT_INFO=$(echo "$DEPLOY_OUTPUT" | grep "DEPLOYMENT_INFO:" | sed 's/DEPLOYMENT_INFO://')
if [ -n "$DEPLOYMENT_INFO" ]; then
    echo "$DEPLOYMENT_INFO" > "$CONTRACT_DIR/deployment.json"
    echo ""
    echo "=== Deployment Successful ==="
    echo "Deployment info saved to: $CONTRACT_DIR/deployment.json"
    CONTRACT_ADDRESS=$(echo "$DEPLOYMENT_INFO" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).address))')
    echo "Contract Address: $CONTRACT_ADDRESS"
    echo ""
    echo "Verify on BscScan: https://bscscan.com/address/$CONTRACT_ADDRESS"
else
    echo "ERROR: Could not parse deployment info"
    exit 1
fi

# Unset private key from environment
unset PRIVATE_KEY
echo ""
echo "Done! Private key cleared from environment."
