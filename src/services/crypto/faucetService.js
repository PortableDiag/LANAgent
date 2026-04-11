import { logger } from '../../utils/logger.js';
import walletService from './walletService.js';
import { retryOperation } from '../../utils/retryUtils.js';

// Known testnet faucets
const FAUCETS = {
    sepolia: [
        {
            name: 'Alchemy Sepolia Faucet',
            url: 'https://sepoliafaucet.com',
            description: 'Get 0.5 ETH every 24 hours',
            requiresAuth: true,
            automated: false
        },
        {
            name: 'Infura Sepolia Faucet',
            url: 'https://www.infura.io/faucet/sepolia',
            description: 'Get testnet ETH',
            requiresAuth: true,
            automated: false
        }
    ],
    amoy: [
        {
            name: 'Polygon Amoy Faucet',
            url: 'https://faucet.polygon.technology',
            description: 'Get 0.5 MATIC every 24 hours',
            requiresAuth: false,
            automated: false,  // No automated API available for Amoy
            api: null
        }
    ],
    'bsc-testnet': [
        {
            name: 'BSC Testnet Faucet',
            url: 'https://testnet.bnbchain.org/faucet-smart',
            description: 'Get 0.2 BNB every 24 hours',
            requiresAuth: false,
            automated: false
        }
    ],
    'base-sepolia': [
        {
            name: 'Base Sepolia Faucet',
            url: 'https://docs.base.org/tools/network-faucets',
            description: 'Bridge from Sepolia ETH',
            requiresAuth: false,
            automated: false
        }
    ],
    'nano': [
        {
            name: 'The Nano Button',
            url: 'https://thenanobutton.com',
            description: 'Click the button to earn Nyano, then withdraw to your Nano address',
            requiresAuth: false,
            automated: true,
            browser: true
        },
        {
            name: 'FreeNanoFaucet',
            url: 'https://freenanofaucet.com',
            description: 'Free Nano faucet',
            requiresAuth: false,
            automated: false
        }
    ]
};

// Additional API-based faucets
const API_FAUCETS = {
    multi: [
        {
            name: 'Chainlink Faucets',
            url: 'https://faucets.chain.link',
            api: 'https://faucets.chain.link/api',
            networks: ['sepolia', 'amoy', 'bsc-testnet'],
            description: 'Multi-network faucet for LINK and native tokens'
        }
    ]
};

// Testnet token contracts (for checking balances)
const TESTNET_TOKENS = {
    sepolia: {
        USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        LINK: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
        WETH: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9'
    },
    amoy: {
        USDC: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
        LINK: '0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904',
        WMATIC: '0x360ad4f9a9A8EFe9A8DCB5f461c4Cc1047E1Dcf9'
    },
    'bsc-testnet': {
        BUSD: '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee',
        USDT: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
        WBNB: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd'
    }
};

class FaucetService {
    constructor() {
        this.claimHistory = new Map(); // Track claims to avoid rate limits
        this.autoClaimInterval = null;
        this.autoClaimEnabled = false;
    }

    /**
     * Get available faucets for a network
     */
    getFaucetsForNetwork(network) {
        const networkFaucets = FAUCETS[network] || [];
        const multiFaucets = API_FAUCETS.multi.filter(f => 
            f.networks.includes(network)
        );
        
        return {
            network,
            faucets: [...networkFaucets, ...multiFaucets],
            tokens: TESTNET_TOKENS[network] || {}
        };
    }

    /**
     * Get all available faucets
     */
    getAllFaucets() {
        const allFaucets = [];
        
        // Network-specific faucets
        for (const [network, faucets] of Object.entries(FAUCETS)) {
            allFaucets.push({
                network,
                faucets,
                tokens: TESTNET_TOKENS[network] || {}
            });
        }
        
        // Multi-network faucets
        allFaucets.push({
            network: 'multi',
            faucets: API_FAUCETS.multi
        });
        
        return allFaucets;
    }

    /**
     * Check if can claim from faucet (rate limiting)
     */
    canClaim(faucetUrl, address) {
        const key = `${faucetUrl}:${address}`;
        const lastClaim = this.claimHistory.get(key);
        
        if (!lastClaim) return true;
        
        // Most faucets have 24 hour cooldown
        const cooldownHours = 24;
        const cooldownMs = cooldownHours * 60 * 60 * 1000;
        
        return Date.now() - lastClaim > cooldownMs;
    }

    /**
     * Note: Amoy faucet does not provide an automated API
     * Users must manually claim from https://faucet.polygon.technology
     * This function is kept as a placeholder for future automated faucets
     */
    async claimFromAmoyFaucet(address) {
        logger.info(`Manual claim required for Amoy faucet at https://faucet.polygon.technology`);
        return {
            success: false,
            error: 'Amoy faucet requires manual claiming through web interface',
            faucet: 'Polygon Amoy Faucet',
            url: 'https://faucet.polygon.technology'
        };
    }

    /**
     * Get wallet addresses for faucet claims
     */
    async getWalletAddresses() {
        const walletInfo = await walletService.getWalletInfo();
        if (!walletInfo || !walletInfo.initialized) {
            throw new Error('Wallet not initialized');
        }

        const addresses = {};
        
        // Map wallet addresses to networks
        walletInfo.addresses.forEach(addr => {
            switch(addr.chain) {
                case 'eth':
                    addresses.sepolia = addr.address;
                    addresses['base-sepolia'] = addr.address;
                    break;
                case 'bsc':
                    addresses['bsc-testnet'] = addr.address;
                    break;
                case 'polygon':
                    addresses.amoy = addr.address;
                    break;
                case 'nano':
                    addresses.nano = addr.address;
                    break;
            }
        });
        
        return addresses;
    }

    /**
     * Generate faucet instructions
     */
    async generateFaucetInstructions(network) {
        const addresses = await this.getWalletAddresses();
        const address = addresses[network];
        
        if (!address) {
            throw new Error(`No wallet address for network: ${network}`);
        }

        const faucetInfo = this.getFaucetsForNetwork(network);
        
        const instructions = [];
        
        faucetInfo.faucets.forEach(faucet => {
            const canClaim = this.canClaim(faucet.url || faucet.api, address);
            
            instructions.push({
                name: faucet.name,
                url: faucet.url,
                description: faucet.description,
                address: address,
                canClaim: canClaim,
                automated: faucet.automated || false,
                requiresAuth: faucet.requiresAuth || false,
                instructions: this.getFaucetSpecificInstructions(faucet, address)
            });
        });
        
        return {
            network,
            address,
            faucets: instructions,
            tokens: faucetInfo.tokens
        };
    }

    /**
     * Get faucet-specific instructions
     */
    getFaucetSpecificInstructions(faucet, address) {
        const steps = [];
        
        steps.push(`1. Visit ${faucet.url}`);
        
        if (faucet.requiresAuth) {
            steps.push('2. Sign in with your account (GitHub, Google, etc.)');
            steps.push(`3. Enter your wallet address: ${address}`);
            steps.push('4. Complete any required verification');
            steps.push('5. Click claim/request tokens');
        } else {
            steps.push(`2. Enter your wallet address: ${address}`);
            steps.push('3. Complete CAPTCHA if required');
            steps.push('4. Click claim/request tokens');
        }
        
        return steps;
    }

    /**
     * Start auto-claiming from available faucets
     */
    startAutoClaim() {
        if (this.autoClaimInterval) {
            logger.info('Auto-claim already running');
            return;
        }

        this.autoClaimEnabled = true;
        logger.info('Starting auto-claim service');
        
        // Run immediately
        this.runAutoClaim();
        
        // Then run every hour to check if we can claim
        this.autoClaimInterval = setInterval(() => {
            this.runAutoClaim();
        }, 60 * 60 * 1000); // 1 hour
    }

    /**
     * Stop auto-claiming
     */
    stopAutoClaim() {
        this.autoClaimEnabled = false;
        if (this.autoClaimInterval) {
            clearInterval(this.autoClaimInterval);
            this.autoClaimInterval = null;
        }
        logger.info('Stopped auto-claim service');
    }

    /**
     * Run auto-claim for all available automated faucets
     */
    async runAutoClaim() {
        if (!this.autoClaimEnabled) return;
        
        logger.info('Running auto-claim check...');
        
        try {
            const walletInfo = await walletService.getWalletInfo();
            if (!walletInfo || !walletInfo.initialized) {
                logger.warn('Wallet not initialized, skipping auto-claim');
                return;
            }

            const addresses = await this.getWalletAddresses();
            
            // Nano faucet claim (uses dedicated method)
            if (addresses.nano) {
                try {
                    await this.claimFromNanoFaucet(addresses.nano);
                } catch (error) {
                    logger.error('Nano auto-claim error:', error.message);
                }
            }

            // Check all networks for automated faucets
            for (const [network, faucets] of Object.entries(FAUCETS)) {
                if (network === 'nano') continue; // Handled above
                const automatedFaucets = faucets.filter(f => f.automated);
                const address = addresses[network];
                
                if (!address) continue;
                
                for (const faucet of automatedFaucets) {
                    if (this.canClaim(faucet.api || faucet.url, address)) {
                        logger.info(`Attempting auto-claim from ${faucet.name} for ${network}`);

                        try {
                            if (faucet.api) {
                                await this.claimFromApiFaucet(faucet.api, address, network);
                            } else {
                                logger.warn(`No automated claim implementation for ${faucet.name}`);
                            }
                        } catch (error) {
                            logger.error(`Auto-claim failed for ${faucet.name}:`, error.message);
                        }
                    } else {
                        const key = `${faucet.api || faucet.url}:${address}`;
                        const lastClaim = this.claimHistory.get(key);
                        const hoursUntilNext = Math.ceil((lastClaim + 24 * 60 * 60 * 1000 - Date.now()) / (60 * 60 * 1000));
                        logger.info(`${faucet.name} on cooldown. Can claim in ${hoursUntilNext} hours`);
                    }
                }
            }

            // Check multi-network API faucets
            for (const faucet of API_FAUCETS.multi) {
                if (!faucet.api) continue;

                for (const network of faucet.networks) {
                    const address = addresses[network];
                    if (!address) continue;

                    if (this.canClaim(faucet.api, address)) {
                        logger.info(`Attempting auto-claim from ${faucet.name} for ${network}`);
                        try {
                            await this.claimFromApiFaucet(faucet.api, address, network);
                        } catch (error) {
                            logger.error(`Auto-claim failed for ${faucet.name} on ${network}:`, error.message);
                        }
                    } else {
                        const key = `${faucet.api}:${address}`;
                        const lastClaim = this.claimHistory.get(key);
                        if (lastClaim) {
                            const hoursUntilNext = Math.ceil((lastClaim + 24 * 60 * 60 * 1000 - Date.now()) / (60 * 60 * 1000));
                            logger.debug(`${faucet.name} (${network}) on cooldown. Can claim in ${hoursUntilNext} hours`);
                        }
                    }
                }
            }
        } catch (error) {
            logger.error('Auto-claim error:', error);
        }
    }

    /**
     * Claim from Nano faucet using browser automation (thenanobutton.com)
     */
    async claimFromNanoFaucet(address) {
        try {
            const nanoButtonFaucet = (await import('./nanoButtonFaucet.js')).default;
            const check = nanoButtonFaucet.canClaim();
            if (!check.can) {
                return { success: false, error: check.reason };
            }

            const result = await nanoButtonFaucet.claim(address);

            if (result.success) {
                const key = `thenanobutton.com:${address}`;
                this.claimHistory.set(key, Date.now());
            }

            return { ...result, faucet: 'The Nano Button' };
        } catch (error) {
            logger.error('Nano faucet claim error:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Attempt to claim from an API-based faucet
     * @param {string} apiUrl - The faucet API URL
     * @param {string} address - Wallet address to claim for
     * @param {string} network - Network name
     * @returns {Object} - Claim result
     */
    async claimFromApiFaucet(apiUrl, address, network) {
        try {
            const response = await retryOperation(async () => {
                const res = await fetch(`${apiUrl}/claim`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address, network })
                });
                return res;
            }, { retries: 3, context: `claimFromApiFaucet-${network}` });

            const data = await response.json();

            if (response.ok && data.success) {
                const key = `${apiUrl}:${address}`;
                this.claimHistory.set(key, Date.now());
                logger.info(`Successfully claimed from API faucet for ${network}`);
                return { success: true, data };
            } else {
                throw new Error(data.error || data.message || 'Failed to claim from API faucet');
            }
        } catch (error) {
            logger.error(`API faucet claim failed for ${network}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get auto-claim status
     */
    getAutoClaimStatus() {
        return {
            enabled: this.autoClaimEnabled,
            running: !!this.autoClaimInterval,
            claimHistory: Array.from(this.claimHistory.entries()).map(([key, timestamp]) => ({
                faucet: key.split(':')[0],
                address: key.split(':')[1],
                lastClaim: new Date(timestamp).toISOString(),
                canClaimAt: new Date(timestamp + 24 * 60 * 60 * 1000).toISOString()
            }))
        };
    }

    /**
     * Check testnet token balances
     */
    async checkTestnetBalances(network) {
        const tokens = TESTNET_TOKENS[network];
        if (!tokens) {
            return { network, tokens: [] };
        }

        const addresses = await this.getWalletAddresses();
        const address = addresses[network];
        
        if (!address) {
            return { network, tokens: [] };
        }

        // This would integrate with contractService to check balances
        // For now, return token list
        return {
            network,
            address,
            tokens: Object.entries(tokens).map(([symbol, contractAddress]) => ({
                symbol,
                contractAddress,
                balance: '0' // Would be populated by actual balance check
            }))
        };
    }

    /**
     * Get claim history
     */
    getClaimHistory() {
        const history = [];
        
        for (const [key, timestamp] of this.claimHistory.entries()) {
            const [faucetUrl, address] = key.split(':');
            history.push({
                faucet: faucetUrl,
                address,
                timestamp,
                nextClaim: timestamp + (24 * 60 * 60 * 1000)
            });
        }
        
        return history.sort((a, b) => b.timestamp - a.timestamp);
    }
}

export default new FaucetService();