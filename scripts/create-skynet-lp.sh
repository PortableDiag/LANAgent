#!/bin/bash
# Create SKYNET/BNB liquidity pool on PancakeSwap
# Uses V2 Router addLiquidityETH for initial pair creation
set -e

DEPLOY_DIR="$PRODUCTION_PATH"

echo "=== SKYNET/BNB Liquidity Pool Creation ==="
echo ""

source ~/.nvm/nvm.sh
nvm use 20

cd "$DEPLOY_DIR"

# Source environment for encryption key
export $(grep -v '^#' .env | xargs)

node -e '
async function main() {
  const mongoose = (await import("mongoose")).default;
  const { decrypt } = await import("./src/utils/encryption.js");
  const CryptoWallet = (await import("./src/models/CryptoWallet.js")).default;
  const { ethers } = await import("ethers");

  await mongoose.connect("mongodb://localhost:27017/lanagent");

  // Get wallet
  const wallet = await CryptoWallet.findOne({});
  if (!wallet) throw new Error("No wallet found");
  const mnemonic = decrypt(wallet.encryptedSeed);
  const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);

  // Connect to BSC
  const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org");
  const signer = derivedWallet.connect(provider);
  console.log("Wallet:", signer.address);

  // Token details
  const SKYNET_ADDRESS = "0x8Ef0ecE5687417a8037F787b39417eB16972b04F";
  const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
  const LP_TOKEN_AMOUNT = ethers.parseUnits("50000000", 18);  // 50M SKYNET
  const LP_BNB_AMOUNT = ethers.parseEther("0.5");             // 0.5 BNB

  // Check BNB balance
  const bnbBalance = await provider.getBalance(signer.address);
  console.log("BNB Balance:", ethers.formatEther(bnbBalance), "BNB");
  if (bnbBalance < LP_BNB_AMOUNT + ethers.parseEther("0.01")) {
    throw new Error("Insufficient BNB for LP + gas");
  }

  // Check SKYNET balance
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
  ];
  const skynetToken = new ethers.Contract(SKYNET_ADDRESS, ERC20_ABI, signer);
  const tokenBalance = await skynetToken.balanceOf(signer.address);
  console.log("SKYNET Balance:", ethers.formatUnits(tokenBalance, 18));
  if (tokenBalance < LP_TOKEN_AMOUNT) {
    throw new Error("Insufficient SKYNET tokens");
  }

  // Step 1: Approve router to spend SKYNET
  console.log("\\nStep 1: Approving PancakeSwap router...");
  const currentAllowance = await skynetToken.allowance(signer.address, PANCAKE_V2_ROUTER);
  if (currentAllowance < LP_TOKEN_AMOUNT) {
    const approveTx = await skynetToken.approve(PANCAKE_V2_ROUTER, ethers.MaxUint256);
    console.log("Approve tx:", approveTx.hash);
    await approveTx.wait();
    console.log("Approved!");
  } else {
    console.log("Already approved");
  }

  // Step 2: Add liquidity via PancakeSwap V2 Router
  console.log("\\nStep 2: Adding liquidity (50M SKYNET + 0.5 BNB)...");
  const ROUTER_ABI = [
    "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)"
  ];
  const router = new ethers.Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, signer);

  const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes
  const amountTokenMin = LP_TOKEN_AMOUNT * 95n / 100n;   // 5% slippage tolerance
  const amountETHMin = LP_BNB_AMOUNT * 95n / 100n;

  const tx = await router.addLiquidityETH(
    SKYNET_ADDRESS,
    LP_TOKEN_AMOUNT,
    amountTokenMin,
    amountETHMin,
    signer.address,    // LP tokens go to deployer
    deadline,
    { value: LP_BNB_AMOUNT }
  );

  console.log("LP tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("LP created! Gas used:", receipt.gasUsed.toString());

  // Check remaining balances
  const remainingBnb = await provider.getBalance(signer.address);
  const remainingTokens = await skynetToken.balanceOf(signer.address);
  console.log("\\n=== Post-LP Balances ===");
  console.log("BNB:", ethers.formatEther(remainingBnb));
  console.log("SKYNET:", ethers.formatUnits(remainingTokens, 18));

  // Output structured info
  const lpInfo = {
    txHash: tx.hash,
    tokenAmount: "50000000",
    bnbAmount: "0.5",
    router: PANCAKE_V2_ROUTER,
    tokenAddress: SKYNET_ADDRESS,
    deployer: signer.address,
    timestamp: new Date().toISOString()
  };
  console.log("\\nLP_INFO:" + JSON.stringify(lpInfo));

  await mongoose.disconnect();
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
' 2>&1