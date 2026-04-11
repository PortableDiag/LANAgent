#!/bin/bash
# LP Fee Collection Investigation Script
# Usage: ./scripts/diag-lp-fees.sh

cd $PRODUCTION_PATH
source ~/.nvm/nvm.sh && nvm use 20 > /dev/null 2>&1

# Count total fee collections and check last 5
TOTAL=$(strings logs/all-activity.log logs/all-activity1.log logs/all-activity2.log logs/all-activity3.log logs/all-activity4.log 2>/dev/null | grep -c 'V3 fees collected')
echo "=== Total fee collection txs found: $TOTAL ==="
echo ""
echo "=== Last 5 Fee Collection Transactions ==="
TXHASHES=$(strings logs/all-activity.log logs/all-activity1.log 2>/dev/null | grep 'V3 fees collected' | tail -5 | grep -oP '0x[a-f0-9]{64}' | tr '\n' ',' | sed 's/,$//')

node --input-type=module -e "
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');
const txHashes = '${TXHASHES}'.split(',').filter(Boolean);
const BNB_PRICE = 617;
const SKYNET = '0x8Ef0ecE5687417a8037F787b39417eB16972b04F'.toLowerCase();
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'.toLowerCase();

let totalGas = 0;
let totalFees = 0;

for (const txHash of txHashes) {
  try {
    const r = await provider.getTransactionReceipt(txHash);
    const gas = Number(r.gasUsed);
    const price = Number(r.gasPrice);
    const costBnb = gas * price / 1e18;
    const costUsd = costBnb * BNB_PRICE;
    totalGas += costUsd;

    let feesUsd = 0;
    let feeDetails = [];
    for (const log of r.logs) {
      if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
        const val = BigInt(log.data);
        const token = log.address.toLowerCase();
        if (token === WBNB) {
          const bnbAmt = Number(val) / 1e18;
          feesUsd += bnbAmt * BNB_PRICE;
          feeDetails.push(bnbAmt.toFixed(8) + ' WBNB (\$' + (bnbAmt * BNB_PRICE).toFixed(4) + ')');
        } else if (token === SKYNET) {
          // SKYNET is essentially worthless for fee purposes
          const skyAmt = Number(val) / 1e18;
          feeDetails.push(Math.round(skyAmt) + ' SKYNET');
        } else {
          feeDetails.push('unknown token ' + log.address.slice(0,10));
        }
      }
    }
    totalFees += feesUsd;

    const block = await provider.getBlock(r.blockNumber);
    const date = new Date(block.timestamp * 1000).toISOString().slice(0,19);
    const feeStr = feeDetails.length > 0 ? feeDetails.join(', ') : 'ZERO fees';
    const verdict = feesUsd > costUsd ? 'PROFITABLE' : feesUsd === 0 ? 'WASTED' : 'UNPROFITABLE';
    console.log(date + ' | gas: \$' + costUsd.toFixed(4) + ' | fees: ' + feeStr + ' | ' + verdict);
  } catch (e) {
    console.log(txHash.slice(0,12) + '... ERROR: ' + e.message);
  }
}

console.log('');
console.log('=== Summary ===');
console.log('Total gas spent: \$' + totalGas.toFixed(4));
console.log('Total fees received: \$' + totalFees.toFixed(4));
console.log('Net: \$' + (totalFees - totalGas).toFixed(4));
if (totalFees < totalGas) {
  console.log('VERDICT: Fee collections are costing more in gas than they earn!');
}
" 2>&1 | grep -v MONGOOSE | grep -v Warning | grep -v 'node:'
