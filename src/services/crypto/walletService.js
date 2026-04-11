import crypto from 'crypto';
import { cryptoLogger as logger } from '../../utils/logger.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import CryptoWallet from '../../models/CryptoWallet.js';
import faucetService from './faucetService.js';

class WalletService {
    constructor() {
        this.logger = logger;
        this.initialized = false;
        this.wallet = null;

        // Network mode: 'testnet' or 'mainnet' (default from env or testnet)
        this.networkMode = process.env.CRYPTO_TESTNET === 'false' ? 'mainnet' : 'testnet';

        // We'll dynamically import crypto libraries when needed
        this.ethers = null;
        this.bitcoin = null;
        this.bip39 = null;
        this.hdkey = null;
        this.siwe = null;
        this.nanoLib = null;

        // Auto-initialize on service creation
        this.autoInit();
    }

    /**
     * Set the network mode (testnet/mainnet)
     */
    setNetworkMode(mode) {
        if (mode !== 'testnet' && mode !== 'mainnet') {
            throw new Error('Invalid network mode. Use "testnet" or "mainnet"');
        }
        this.networkMode = mode;
        this.logger.info(`Network mode set to: ${mode}`);
    }

    /**
     * Get the current network mode
     */
    getNetworkMode() {
        return this.networkMode;
    }

    /**
     * Check if currently in testnet mode
     */
    isTestnet() {
        return this.networkMode === 'testnet';
    }
    
    async autoInit() {
        try {
            await this.initialize();
            this.logger.info('Wallet auto-initialized successfully');
        } catch (error) {
            this.logger.warn('Wallet auto-initialization deferred:', error.message);
            // Will retry on first API call
        }
    }

    async loadLibraries() {
        // Load each library independently so one missing package doesn't break the rest
        const loaded = [];
        const failed = [];

        const tryLoad = async (name, importFn, assignFn) => {
            try {
                const mod = await importFn();
                assignFn(mod);
                loaded.push(name);
            } catch (error) {
                failed.push(name);
                this.logger.warn(`Optional crypto library '${name}' not available: ${error.message}`);
            }
        };

        await Promise.all([
            tryLoad('ethers', () => import('ethers'), (m) => { this.ethers = m; }),
            tryLoad('bitcoinjs-lib', () => import('bitcoinjs-lib'), (m) => { this.bitcoin = m; }),
            tryLoad('bip39', () => import('bip39'), (m) => { this.bip39 = m.default; }),
            tryLoad('hdkey', () => import('hdkey'), (m) => { this.hdkey = m.default; }),
            tryLoad('siwe', () => import('siwe'), (m) => { this.siwe = m; }),
            tryLoad('nanocurrency-web', () => import('nanocurrency-web'), (m) => { this.nanoLib = m; })
        ]);

        if (loaded.length > 0) {
            this.logger.info(`Crypto libraries loaded: ${loaded.join(', ')}` +
                (failed.length > 0 ? ` (unavailable: ${failed.join(', ')})` : ''));
        }
        return loaded.length > 0;
    }

    async initialize() {
        try {
            // Load network mode from CryptoStrategy config (source of truth)
            try {
                const CryptoStrategy = (await import('../../models/CryptoStrategy.js')).default;
                const savedConfig = await CryptoStrategy.findOne({ type: 'config' });
                if (savedConfig && savedConfig.networkMode) {
                    this.networkMode = savedConfig.networkMode;
                    this.logger.info(`Loaded network mode from database: ${this.networkMode}`);
                }
            } catch (err) {
                this.logger.warn('Could not load network mode from database:', err.message);
            }

            // Check if wallet already exists
            const existingWallet = await CryptoWallet.findOne();
            if (existingWallet) {
                this.wallet = existingWallet;
                this.initialized = true;

                // Start auto-claim service for testnet tokens
                faucetService.startAutoClaim();

                // Migrate existing wallet: add Nano address if missing
                const hasNano = this.wallet.addresses.some(a => a.chain === 'nano');
                if (!hasNano) {
                    try {
                        const mnemonic = decrypt(this.wallet.encryptedSeed);
                        const nanoAddress = await this.deriveNanoAddress(mnemonic);
                        this.wallet.addresses.push({
                            chain: 'nano',
                            name: 'Nano',
                            address: nanoAddress,
                            path: "m/44'/165'/0'"
                        });
                        await this.wallet.save();
                        this.logger.info(`Nano address migrated: ${nanoAddress}`);
                    } catch (err) {
                        this.logger.warn('Nano address migration deferred:', err.message);
                    }
                }

                // Start Nano receivable monitor
                const nanoAddr = this.wallet.addresses.find(a => a.chain === 'nano');
                if (nanoAddr) {
                    try {
                        const nanoService = (await import('./nanoService.js')).default;
                        nanoService.startReceivableMonitor(nanoAddr.address);
                    } catch (err) {
                        this.logger.warn('Nano monitor start deferred:', err.message);
                    }
                }

                this.logger.info('Existing wallet loaded');
                return this.getWalletInfo();
            }

            // Load crypto libraries
            const librariesLoaded = await this.loadLibraries();
            if (!librariesLoaded) {
                throw new Error('Crypto libraries not installed. Run: npm install ethers bitcoinjs-lib bip39 hdkey siwe');
            }

            // Generate new wallet
            const walletData = await this.generateWallet();
            
            // Save to database
            this.wallet = new CryptoWallet({
                encryptedSeed: walletData.encryptedSeed,
                addresses: walletData.addresses,
                createdAt: new Date(),
                lastActive: new Date()
            });
            
            await this.wallet.save();
            this.initialized = true;
            
            // Start auto-claim service for testnet tokens
            faucetService.startAutoClaim();

            // Start Nano receivable monitor for new wallet
            const nanoAddr = this.wallet.addresses.find(a => a.chain === 'nano');
            if (nanoAddr) {
                try {
                    const nanoService = (await import('./nanoService.js')).default;
                    nanoService.startReceivableMonitor(nanoAddr.address);
                } catch (err) {
                    this.logger.warn('Nano monitor start deferred:', err.message);
                }
            }

            // Schedule ENS subname request from genesis (non-blocking, delayed)
            this._scheduleENSSubnameRequest();

            this.logger.info('New wallet initialized successfully');
            return this.getWalletInfo();
        } catch (error) {
            this.logger.error('Failed to initialize wallet:', error);
            throw error;
        }
    }

    /**
     * Schedule an ENS subname request from the genesis instance.
     * Runs after a delay to allow P2P connections to establish.
     * Only runs on forked instances (non-genesis).
     */
    _scheduleENSSubnameRequest() {
        // Delay 5 minutes to allow P2P to connect and exchange capabilities
        setTimeout(async () => {
            try {
                const ensService = (await import('./ensService.js')).default;
                if (!ensService.isAvailable()) await ensService.initialize();

                // If this instance already has an ENS name, skip
                if (ensService.isGenesisENS()) return;
                const { SystemSettings } = await import('../../models/SystemSettings.js');
                const existing = await SystemSettings.getSetting('ens.mySubname', null);
                if (existing) {
                    this.logger.debug(`ENS subname already assigned: ${existing.name}`);
                    return;
                }

                // Find a genesis peer that provides ENS subnames
                const genesisPeer = await ensService.findGenesisENSProvider(null);
                if (!genesisPeer) {
                    this.logger.debug('No ENS provider peer found — will retry on next startup');
                    return;
                }

                // Get our wallet address and agent name for the subname label
                const ethAddr = this.wallet.addresses.find(a => a.chain === 'eth');
                if (!ethAddr) return;

                const agentName = (process.env.AGENT_NAME || 'agent').toLowerCase().replace(/[^a-z0-9-]/g, '');

                this.logger.info(`Requesting ENS subname "${agentName}" from genesis peer ${genesisPeer.fingerprint.slice(0, 8)}...`);
                await ensService.requestSubnameFromGenesis(
                    // Get P2P service — it should be available by now
                    await this._getP2PService(),
                    genesisPeer.fingerprint,
                    agentName,
                    ethAddr.address
                );
            } catch (err) {
                this.logger.debug(`ENS subname request deferred: ${err.message}`);
            }
        }, 5 * 60 * 1000); // 5 minute delay
    }

    async _getP2PService() {
        // Try to find the P2P service through various paths
        try {
            const { default: agent } = await import('../../core/agent.js');
            if (agent?.services?.get('p2p')) return agent.services.get('p2p');
        } catch {}
        throw new Error('P2P service not available');
    }

    async generateWallet() {
        // Ensure crypto libraries are loaded
        if (!this.bip39) {
            await this.loadLibraries();
            if (!this.bip39) {
                throw new Error('Crypto libraries not available. Run: npm install ethers bitcoinjs-lib bip39 hdkey siwe');
            }
        }

        // Generate mnemonic seed phrase
        const mnemonic = this.bip39.generateMnemonic(256); // 24 words
        
        // Encrypt the seed phrase
        const encryptedSeed = encrypt(mnemonic);
        
        // Derive addresses for different chains
        const addresses = await this.deriveAddresses(mnemonic);
        
        return {
            encryptedSeed,
            addresses
        };
    }

    async deriveAddresses(mnemonic) {
        const addresses = [];
        
        // Generate seed from mnemonic
        const seed = await this.bip39.mnemonicToSeed(mnemonic);
        
        // Bitcoin address (BIP44: m/44'/0'/0'/0/0)
        const btcAddress = await this.deriveBitcoinAddress(seed);
        addresses.push({
            chain: 'btc',
            name: 'Bitcoin',
            address: btcAddress,
            path: "m/44'/0'/0'/0/0"
        });
        
        // Ethereum address (BIP44: m/44'/60'/0'/0/0)
        const ethAddress = await this.deriveEthereumAddress(seed);
        addresses.push({
            chain: 'eth',
            name: 'Ethereum',
            address: ethAddress,
            path: "m/44'/60'/0'/0/0"
        });
        
        // BSC uses same derivation as Ethereum
        addresses.push({
            chain: 'bsc',
            name: 'BNB Smart Chain',
            address: ethAddress,
            path: "m/44'/60'/0'/0/0"
        });
        
        // Polygon uses same derivation as Ethereum
        addresses.push({
            chain: 'polygon',
            name: 'Polygon',
            address: ethAddress,
            path: "m/44'/60'/0'/0/0"
        });

        // Nano address (BIP44: m/44'/165'/0')
        try {
            const nanoAddress = await this.deriveNanoAddress(mnemonic);
            addresses.push({
                chain: 'nano',
                name: 'Nano',
                address: nanoAddress,
                path: "m/44'/165'/0'"
            });
        } catch (error) {
            this.logger.error('Failed to derive Nano address:', error);
        }

        return addresses;
    }

    async deriveBitcoinAddress(seed) {
        try {
            // Load additional bitcoin modules if needed
            const ecc = await import('tiny-secp256k1');
            const { ECPairFactory } = await import('ecpair');
            const ECPair = ECPairFactory(ecc.default || ecc);
            
            const network = this.bitcoin.networks.bitcoin;
            const root = this.hdkey.fromMasterSeed(seed);
            
            // Derive path step by step for Bitcoin
            const childKey = root
                .deriveChild(44 + 0x80000000) // 44' - Purpose (BIP44)
                .deriveChild(0 + 0x80000000)  // 0'  - Coin type (Bitcoin)
                .deriveChild(0 + 0x80000000)  // 0'  - Account
                .deriveChild(0)               // 0   - External chain
                .deriveChild(0);              // 0   - First address
            
            // Create key pair from private key
            const keyPair = ECPair.fromPrivateKey(childKey.privateKey, { network });
            
            // Generate P2PKH address (legacy)
            const { address } = this.bitcoin.payments.p2pkh({ 
                pubkey: keyPair.publicKey, 
                network 
            });
            
            return address;
        } catch (error) {
            this.logger.error('Failed to derive Bitcoin address:', error);
            // Return a placeholder if full BTC support not available
            return 'btc_address_pending';
        }
    }

    async deriveNanoAddress(mnemonic) {
        if (!this.nanoLib) {
            try {
                this.nanoLib = await import('nanocurrency-web');
            } catch (err) {
                this.logger.error('Failed to load nanocurrency-web:', err);
                throw err;
            }
        }
        const nanoWallet = this.nanoLib.wallet.fromMnemonic(mnemonic);
        return nanoWallet.accounts[0].address;
    }

    async deriveEthereumAddress(seed) {
        try {
            const hdNode = this.ethers.HDNodeWallet.fromSeed(seed);
            const childNode = hdNode.derivePath("m/44'/60'/0'/0/0");
            return childNode.address;
        } catch (error) {
            this.logger.error('Failed to derive Ethereum address:', error);
            return '0x' + '0'.repeat(40);
        }
    }

    async getWalletInfo() {
        if (!this.initialized) {
            // Auto-initialize wallet on first access
            try {
                await this.initialize();
            } catch (error) {
                this.logger.error('Auto-initialization failed:', error);
                return { initialized: false, error: error.message };
            }
        }
        
        if (!this.wallet) {
            return { initialized: false };
        }
        
        // Get current balances
        const balances = await this.getBalances();
        
        return {
            initialized: true,
            addresses: this.wallet.addresses,
            balances,
            createdAt: this.wallet.createdAt,
            lastActive: this.wallet.lastActive
        };
    }

    async getBalances() {
        const balances = {};
        
        for (const addr of this.wallet.addresses) {
            try {
                const balance = await this.getChainBalance(addr.chain, addr.address);
                balances[addr.chain] = balance;
            } catch (error) {
                this.logger.error(`Failed to get balance for ${addr.chain}:`, error);
                balances[addr.chain] = '0';
            }
        }
        
        return balances;
    }

    async getChainBalance(chain, address) {
        try {
            // Nano is mainnet-only, uses its own RPC
            if (chain === 'nano') {
                const nanoService = (await import('./nanoService.js')).default;
                return await nanoService.getBalance(address);
            }

            // Map chain names to network identifiers based on current network mode
            const isTestnet = this.isTestnet();
            const networkMap = {
                'btc': null, // BTC not supported via EVM
                'eth': isTestnet ? 'sepolia' : 'ethereum',
                'bsc': isTestnet ? 'bsc-testnet' : 'bsc',
                'polygon': isTestnet ? 'amoy' : 'polygon'
            };

            const network = networkMap[chain];
            if (!network) {
                this.logger.debug(`Balance checking not supported for chain: ${chain}`);
                return '0';
            }

            // Dynamically import contractServiceWrapper to avoid circular dependency
            const contractService = (await import('./contractServiceWrapper.js')).default;
            const balance = await contractService.getNativeBalance(address, network);

            return balance.formatted;
        } catch (error) {
            this.logger.warn(`Failed to get balance for ${chain}:`, error.message);
            return '0';
        }
    }

    /**
     * Get balance for a specific network directly (bypasses network mode)
     * @param {string} network - Network identifier (e.g., 'bsc', 'ethereum', 'bsc-testnet')
     * @param {string} address - Wallet address
     * @returns {object} Balance with raw, formatted, symbol, and network
     */
    async getBalanceForNetwork(network, address) {
        try {
            const contractService = (await import('./contractServiceWrapper.js')).default;
            const balance = await contractService.getNativeBalance(address, network);
            return balance;
        } catch (error) {
            this.logger.warn(`Failed to get balance for network ${network}:`, error.message);
            return { raw: '0', formatted: '0', symbol: 'UNKNOWN', network };
        }
    }

    /**
     * Get mainnet balances for all supported chains (bypasses network mode)
     * Useful for verifying mainnet holdings before switching from testnet
     */
    async getMainnetBalances() {
        const mainnetNetworks = {
            'eth': 'ethereum',
            'bsc': 'bsc',
            'polygon': 'polygon'
        };

        const balances = {};

        // Nano is always mainnet
        for (const addr of this.wallet.addresses) {
            if (addr.chain === 'nano') {
                try {
                    const nanoService = (await import('./nanoService.js')).default;
                    const balance = await nanoService.getBalance(addr.address);
                    balances.nano = {
                        network: 'nano',
                        balance,
                        symbol: 'XNO',
                        raw: balance,
                        address: addr.address
                    };
                } catch (error) {
                    this.logger.error('Failed to get Nano mainnet balance:', error);
                    balances.nano = { network: 'nano', balance: '0', symbol: 'XNO', error: error.message };
                }
                continue;
            }
        }

        for (const addr of this.wallet.addresses) {
            const mainnetNetwork = mainnetNetworks[addr.chain];
            if (!mainnetNetwork) continue;

            try {
                const balance = await this.getBalanceForNetwork(mainnetNetwork, addr.address);
                balances[addr.chain] = {
                    network: mainnetNetwork,
                    balance: balance.formatted,
                    symbol: balance.symbol,
                    raw: balance.raw,
                    address: addr.address
                };
            } catch (error) {
                this.logger.error(`Failed to get mainnet balance for ${addr.chain}:`, error);
                balances[addr.chain] = { network: mainnetNetwork, balance: '0', symbol: 'UNKNOWN', error: error.message };
            }
        }

        return balances;
    }

    async signMessage(message, chain = 'eth') {
        if (!this.initialized || !this.wallet) {
            throw new Error('Wallet not initialized');
        }
        
        // Load libraries if needed
        if (!this.ethers) {
            await this.loadLibraries();
        }
        
        try {
            // Decrypt seed phrase
            const mnemonic = decrypt(this.wallet.encryptedSeed);
            
            // Create wallet directly from mnemonic
            const wallet = this.ethers.Wallet.fromPhrase(mnemonic, "m/44'/60'/0'/0/0");
            
            // Sign the message
            const signature = await wallet.signMessage(message);
            
            this.logger.info(`Message signed for ${chain}`);
            return signature;
        } catch (error) {
            this.logger.error('Failed to sign message:', error);
            throw error;
        }
    }

    async exportEncryptedSeed() {
        if (!this.initialized || !this.wallet) {
            throw new Error('Wallet not initialized');
        }
        
        return this.wallet.encryptedSeed;
    }

    async addTransaction(txData) {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }
        
        // Add transaction to wallet history
        if (!this.wallet.transactions) {
            this.wallet.transactions = [];
        }
        
        this.wallet.transactions.push({
            ...txData,
            timestamp: new Date()
        });
        
        // Keep only last 100 transactions
        if (this.wallet.transactions.length > 100) {
            this.wallet.transactions = this.wallet.transactions.slice(-100);
        }
        
        this.wallet.lastActive = new Date();
        await this.wallet.save();
        
        this.logger.info(`Transaction added: ${txData.type} on ${txData.chain}`);
    }

    async getTransactions() {
        if (!this.wallet) {
            return [];
        }
        
        return this.wallet.transactions || [];
    }

    isInitialized() {
        return this.initialized;
    }

    getAddresses() {
        if (!this.wallet) {
            return [];
        }
        
        return this.wallet.addresses;
    }

    async getWallet() {
        if (!this.initialized) {
            // Try to auto-initialize
            try {
                await this.initialize();
            } catch (error) {
                this.logger.error('Failed to auto-initialize wallet:', error);
                return null;
            }
        }
        
        return this.wallet;
    }
}

// Export singleton instance
export default new WalletService();