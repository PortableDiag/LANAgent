#!/bin/bash
# Deploy SKYNET Staking Contract to BSC mainnet
# Follows the deploy-skynet-token.sh pattern
set -e

DEPLOY_DIR="$PRODUCTION_PATH"
CONTRACT_DIR="$DEPLOY_DIR/contracts/skynet-token"

echo "=== SKYNET Staking Contract Deployment ==="
echo ""

# Source environment
source ~/.nvm/nvm.sh
nvm use 20

# Step 1: Extract private key from ALICE's wallet
echo "[1/8] Extracting deployment wallet..."
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

# Step 2: Get SKYNET token address from deployment.json or SystemSettings
echo "[2/8] Getting SKYNET token address..."
TOKEN_ADDRESS=""
if [ -f "$CONTRACT_DIR/deployment.json" ]; then
    TOKEN_ADDRESS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONTRACT_DIR/deployment.json','utf8')).address)")
fi
if [ -z "$TOKEN_ADDRESS" ]; then
    TOKEN_ADDRESS=$(node -e '
async function main() {
  const mongoose = (await import("mongoose")).default;
  const { SystemSettings } = await import("./src/models/SystemSettings.js");
  await mongoose.connect("mongodb://localhost:27017/lanagent");
  const addr = await SystemSettings.getSetting("skynet_token_address", "");
  process.stdout.write(addr);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
' 2>/dev/null)
fi
if [ -z "$TOKEN_ADDRESS" ]; then
    echo "ERROR: Could not determine SKYNET token address"
    exit 1
fi
echo "SKYNET Token: $TOKEN_ADDRESS"

# Step 3: Install dependencies
echo "[3/8] Installing Hardhat dependencies..."
cd "$CONTRACT_DIR"
npm install 2>&1 | tail -3

# Step 4: Compile contracts
echo "[4/8] Compiling SkynetStaking..."
npx hardhat compile --config hardhat.config.cjs 2>&1

# Step 5: Run tests
echo "[5/8] Running tests..."
npx hardhat test --config hardhat.config.cjs 2>&1

# Step 6: Deploy to BSC mainnet
echo "[6/8] Deploying SkynetStaking to BSC mainnet..."
export PRIVATE_KEY
export SKYNET_TOKEN_ADDRESS="$TOKEN_ADDRESS"
DEPLOY_OUTPUT=$(npx hardhat run scripts/deploy-staking.cjs --network bsc --config hardhat.config.cjs 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract deployment info
DEPLOYMENT_INFO=$(echo "$DEPLOY_OUTPUT" | grep "DEPLOYMENT_INFO:" | sed 's/DEPLOYMENT_INFO://')
if [ -z "$DEPLOYMENT_INFO" ]; then
    echo "ERROR: Could not parse deployment info"
    exit 1
fi

STAKING_ADDRESS=$(echo "$DEPLOYMENT_INFO" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).address))')
echo "Staking Contract: $STAKING_ADDRESS"

# Step 7: Approve and fund reward pool (20M SKYNET)
echo "[7/8] Approving and funding 20M SKYNET reward pool..."
cd "$DEPLOY_DIR"
node -e '
async function main() {
  const { ethers } = await import("ethers");

  const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  const tokenABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
  ];
  const stakingABI = [
    "function notifyRewardAmount(uint256 reward) external"
  ];

  const tokenAddress = process.env.SKYNET_TOKEN_ADDRESS;
  const stakingAddress = process.env.STAKING_ADDRESS;
  const rewardAmount = ethers.parseUnits("20000000", 18); // 20M SKYNET

  const token = new ethers.Contract(tokenAddress, tokenABI, wallet);
  const staking = new ethers.Contract(stakingAddress, stakingABI, wallet);

  // Approve staking contract to spend reward tokens
  console.log("Approving SKYNET spend...");
  const approveTx = await token.approve(stakingAddress, rewardAmount);
  await approveTx.wait();
  console.log("Approval tx:", approveTx.hash);

  // Fund the reward pool
  console.log("Funding reward pool with 20M SKYNET...");
  const fundTx = await staking.notifyRewardAmount(rewardAmount);
  await fundTx.wait();
  console.log("Fund tx:", fundTx.hash);

  console.log("Reward pool funded successfully!");
}
main().catch(e => { console.error("Fund error:", e.message); process.exit(1); });
' 2>&1
export STAKING_ADDRESS

# Step 8: Save deployment info and store in SystemSettings
echo "[8/8] Saving deployment info..."
echo "$DEPLOYMENT_INFO" > "$CONTRACT_DIR/staking-deployment.json"

cd "$DEPLOY_DIR"
node -e '
async function main() {
  const mongoose = (await import("mongoose")).default;
  const { SystemSettings } = await import("./src/models/SystemSettings.js");
  await mongoose.connect("mongodb://localhost:27017/lanagent");
  await SystemSettings.setSetting("skynet_staking_address", process.env.STAKING_ADDRESS);
  console.log("Staking address saved to SystemSettings");
  await mongoose.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
' 2>/dev/null

# Cleanup
unset PRIVATE_KEY

echo ""
echo "=== Deployment Successful ==="
echo "Staking Contract: $STAKING_ADDRESS"
echo "Deployment info: $CONTRACT_DIR/staking-deployment.json"
echo "Verify on BscScan: https://bscscan.com/address/$STAKING_ADDRESS"
echo ""
echo "Done! Private key cleared from environment."
