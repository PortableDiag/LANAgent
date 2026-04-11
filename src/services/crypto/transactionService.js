import { logger } from '../../utils/logger.js';
import walletService from './walletService.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import { decrypt } from '../../utils/encryption.js';
import { retryOperation } from '../../utils/retryUtils.js';

// Lazy load ethers
let ethersLib = null;

async function getEthers() {
    if (!ethersLib) {
        const ethers = await import('ethers');
        ethersLib = ethers;
    }
    return ethersLib;
}

class TransactionService {
    constructor() {
        this.pendingTxs = new Map();
    }

    /**
     * Get wallet signer for a network
     */
    async getWalletSigner(network) {
        const ethers = await getEthers();
        
        // Get wallet info
        const wallet = await walletService.getWallet();
        if (!wallet) {
            throw new Error('Wallet not initialized');
        }

        // Determine which address to use based on network
        let addressInfo;
        if (network.includes('bsc')) {
            addressInfo = wallet.addresses.find(a => a.chain === 'bsc');
        } else if (network.includes('polygon') || network.includes('mumbai')) {
            addressInfo = wallet.addresses.find(a => a.chain === 'polygon');
        } else {
            addressInfo = wallet.addresses.find(a => a.chain === 'eth');
        }

        if (!addressInfo) {
            throw new Error(`No address found for network: ${network}`);
        }

        // Get the encrypted seed phrase
        if (!wallet.encryptedSeed) {
            throw new Error('No seed phrase found in wallet');
        }

        // Decrypt seed and create signer (same approach as swapService)
        const mnemonic = decrypt(wallet.encryptedSeed);
        const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);

        // Get provider and connect
        const provider = await contractServiceWrapper.getProvider(network);
        return derivedWallet.connect(provider);
    }

    /**
     * Get derivation path for network
     */
    getDerivationPath(chain) {
        switch (chain) {
            case 'btc':
                return "m/44'/0'/0'/0/0";
            case 'eth':
            case 'bsc':
            case 'polygon':
                return "m/44'/60'/0'/0/0";
            default:
                return "m/44'/60'/0'/0/0";
        }
    }

    /**
     * Estimate gas for a transaction
     */
    async estimateGas(to, data, value = '0', network) {
        try {
            const provider = await contractServiceWrapper.getProvider(network);
            const ethers = await getEthers();
            
            const transaction = {
                to,
                data,
                value: ethers.parseEther(value.toString())
            };

            const gasLimit = await provider.estimateGas(transaction);
            const gasPrice = await provider.getFeeData();
            
            return {
                gasLimit: gasLimit.toString(),
                gasPrice: gasPrice.gasPrice ? gasPrice.gasPrice.toString() : null,
                maxFeePerGas: gasPrice.maxFeePerGas ? gasPrice.maxFeePerGas.toString() : null,
                maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas ? gasPrice.maxPriorityFeePerGas.toString() : null,
                estimatedCost: ethers.formatEther(
                    gasLimit * (gasPrice.gasPrice || gasPrice.maxFeePerGas)
                )
            };
        } catch (error) {
            logger.error('Gas estimation failed:', error);
            throw error;
        }
    }

    /**
     * Write to a contract (send transaction)
     */
    async writeContract(address, network, functionName, params = [], options = {}) {
        try {
            // Check scammer registry — refuse to interact with flagged contracts
            try {
                const scammerRegistry = (await import('./scammerRegistryService.js')).default;
                if (scammerRegistry.isAddressFlagged(address)) {
                    throw new Error(`Contract interaction blocked: ${address} is flagged in scammer registry`);
                }
            } catch (e) {
                if (e.message.startsWith('Contract interaction blocked')) throw e;
            }

            const ethers = await getEthers();

            // Get contract instance
            const contract = await contractServiceWrapper.getContract(address, network);
            
            // Get signer
            const signer = await this.getWalletSigner(network);
            
            // Connect contract to signer
            const contractWithSigner = contract.connect(signer);
            
            // Validate function exists
            if (!contractWithSigner[functionName]) {
                throw new Error(`Function ${functionName} not found in contract`);
            }

            // Prepare transaction options
            const txOptions = {};
            if (options.value) {
                txOptions.value = ethers.parseEther(options.value.toString());
            }
            if (options.gasLimit) {
                txOptions.gasLimit = BigInt(options.gasLimit);
            }
            if (options.gasPrice) {
                txOptions.gasPrice = BigInt(options.gasPrice);
            }

            // Call the function with retry logic for transient network errors
            logger.info(`Calling ${functionName} on ${address} (${network})`);
            const tx = await retryOperation(
                () => contractWithSigner[functionName](...params, txOptions),
                { retries: 3, context: `contract call ${functionName}` }
            );
            
            // Store pending transaction
            this.pendingTxs.set(tx.hash, {
                hash: tx.hash,
                network,
                contract: address,
                function: functionName,
                params,
                timestamp: new Date(),
                status: 'pending'
            });

            // Wait for confirmation in background
            this.waitForTransaction(tx, network);

            // Add to wallet transaction history
            await walletService.addTransaction({
                type: 'contract_write',
                chain: network,
                hash: tx.hash,
                from: signer.address,
                to: address,
                value: options.value || '0',
                status: 'pending',
                function: functionName,
                params
            });

            return {
                hash: tx.hash,
                from: signer.address,
                to: address,
                nonce: tx.nonce,
                gasLimit: tx.gasLimit?.toString(),
                gasPrice: tx.gasPrice?.toString(),
                data: tx.data,
                value: tx.value?.toString(),
                chainId: tx.chainId
            };
        } catch (error) {
            logger.error(`Contract write failed:`, error);
            throw error;
        }
    }

    /**
     * Send native currency (ETH, BNB, MATIC)
     */
    async sendNative(to, amount, network) {
        try {
            // Check scammer registry — refuse to send to flagged addresses
            try {
                const scammerRegistry = (await import('./scammerRegistryService.js')).default;
                if (scammerRegistry.isAddressFlagged(to)) {
                    throw new Error(`Send blocked: recipient ${to} is flagged in scammer registry`);
                }
            } catch (e) {
                if (e.message.startsWith('Send blocked')) throw e;
            }

            const ethers = await getEthers();

            // Get signer
            const signer = await this.getWalletSigner(network);
            
            // Create transaction with retry logic for transient network errors
            const tx = await retryOperation(
                () => signer.sendTransaction({
                    to,
                    value: ethers.parseEther(amount.toString())
                }),
                { retries: 3, context: 'sendNative transaction' }
            );

            // Store pending transaction
            this.pendingTxs.set(tx.hash, {
                hash: tx.hash,
                network,
                type: 'native_transfer',
                from: signer.address,
                to,
                value: amount,
                timestamp: new Date(),
                status: 'pending'
            });

            // Wait for confirmation in background
            this.waitForTransaction(tx, network);

            // Add to wallet transaction history
            await walletService.addTransaction({
                type: 'sent',
                chain: network,
                hash: tx.hash,
                from: signer.address,
                to,
                value: amount,
                status: 'pending'
            });

            return {
                hash: tx.hash,
                from: signer.address,
                to,
                value: amount,
                network
            };
        } catch (error) {
            logger.error('Native send failed:', error);
            throw error;
        }
    }

    /**
     * Wait for transaction confirmation
     */
    async waitForTransaction(tx, network) {
        try {
            const provider = await contractServiceWrapper.getProvider(network);
            const receipt = await tx.wait();
            
            // Update pending transaction
            const pendingTx = this.pendingTxs.get(tx.hash);
            if (pendingTx) {
                pendingTx.status = receipt.status === 1 ? 'confirmed' : 'failed';
                pendingTx.blockNumber = receipt.blockNumber;
                pendingTx.gasUsed = receipt.gasUsed.toString();
                
                // Remove from pending after 5 minutes
                setTimeout(() => {
                    this.pendingTxs.delete(tx.hash);
                }, 5 * 60 * 1000);
            }

            // Update wallet transaction
            const wallet = await walletService.getWallet();
            const walletTx = wallet.transactions.find(t => t.hash === tx.hash);
            if (walletTx) {
                walletTx.status = receipt.status === 1 ? 'confirmed' : 'failed';
                walletTx.blockNumber = receipt.blockNumber;
                walletTx.gasUsed = receipt.gasUsed?.toString();
                await wallet.save();
            }

            logger.info(`Transaction ${tx.hash} ${receipt.status === 1 ? 'confirmed' : 'failed'}`);
            
            return receipt;
        } catch (error) {
            logger.error('Transaction wait failed:', error);
            
            // Update status to failed
            const pendingTx = this.pendingTxs.get(tx.hash);
            if (pendingTx) {
                pendingTx.status = 'failed';
                pendingTx.error = error.message;
            }
        }
    }

    /**
     * Wait for multiple transaction confirmations in batch.
     * Uses Promise.allSettled to handle individual failures without
     * incorrectly marking successful transactions as failed.
     */
    async waitForTransactions(txs) {
        const results = await Promise.allSettled(txs.map(tx => tx.wait()));
        const receipts = [];

        results.forEach((result, index) => {
            const tx = txs[index];
            const pendingTx = this.pendingTxs.get(tx.hash);

            if (result.status === 'fulfilled') {
                const receipt = result.value;
                receipts.push(receipt);
                if (pendingTx) {
                    pendingTx.status = receipt.status === 1 ? 'confirmed' : 'failed';
                    pendingTx.blockNumber = receipt.blockNumber;
                    pendingTx.gasUsed = receipt.gasUsed.toString();
                    setTimeout(() => this.pendingTxs.delete(tx.hash), 5 * 60 * 1000);
                }
            } else {
                logger.error(`Transaction ${tx.hash} failed:`, result.reason);
                if (pendingTx) {
                    pendingTx.status = 'failed';
                    pendingTx.error = result.reason?.message || 'Unknown error';
                }
            }
        });

        const failed = results.filter(r => r.status === 'rejected').length;
        logger.info(`Batch: ${receipts.length}/${txs.length} confirmed, ${failed} failed`);
        return receipts;
    }

    /**
     * Get transaction status
     */
    async getTransactionStatus(txHash, network) {
        try {
            // Check pending transactions first
            const pendingTx = this.pendingTxs.get(txHash);
            if (pendingTx) {
                return pendingTx;
            }

            // Check blockchain
            const provider = await contractServiceWrapper.getProvider(network);
            const tx = await provider.getTransaction(txHash);
            
            if (!tx) {
                return { status: 'not_found' };
            }

            const receipt = await provider.getTransactionReceipt(txHash);
            
            return {
                hash: txHash,
                status: receipt ? (receipt.status === 1 ? 'confirmed' : 'failed') : 'pending',
                blockNumber: receipt?.blockNumber,
                gasUsed: receipt?.gasUsed?.toString(),
                from: tx.from,
                to: tx.to,
                value: tx.value?.toString(),
                network
            };
        } catch (error) {
            logger.error('Failed to get transaction status:', error);
            throw error;
        }
    }

    /**
     * Get pending transactions
     */
    getPendingTransactions() {
        return Array.from(this.pendingTxs.values())
            .filter(tx => tx.status === 'pending')
            .sort((a, b) => b.timestamp - a.timestamp);
    }
}

export default new TransactionService();