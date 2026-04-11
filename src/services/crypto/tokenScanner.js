/**
 * Token Scanner Service
 * Detects new tokens, checks for honeypots/scams, and monitors incoming transfers
 */
import { ethers } from 'ethers';
import axios from 'axios';
import { logger as baseLogger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import swapService from './swapService.js';
import { strategyRegistry } from './strategies/StrategyRegistry.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

const logger = baseLogger.child({ service: 'token-scanner' });

// Known scam indicators
const SCAM_INDICATORS = {
    // Function selectors that indicate potential honeypot
    honeypotFunctions: [
        '0x23b872dd', // transferFrom with hidden fees
    ],
    // Known scam token name patterns
    scamNamePatterns: [
        /airdrop/i,
        /claim/i,
        /free.*token/i,
        /visit.*website/i,
        /\.com$/i,
        /\.io$/i,
        /reward/i
    ],
    // Minimum liquidity in USD to consider token tradeable
    minLiquidity: 1000,
    // Maximum tax percentage to consider safe
    maxTaxPercent: 15
};

// ERC20 ABI for token interactions
const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'
];

// Router ABI for swap simulation
const ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)'
];

// Known safe tokens (whitelisted)
const SAFE_TOKENS = {
    ethereum: {
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': { symbol: 'USDC', verified: true },
        '0xdAC17F958D2ee523a2206206994597C13D831ec7': { symbol: 'USDT', verified: true },
        '0x6B175474E89094C44Da98b954EescdeCB5BE93D21': { symbol: 'DAI', verified: true },
        '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': { symbol: 'WBTC', verified: true },
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': { symbol: 'WETH', verified: true }
    },
    bsc: {
        '0x55d398326f99059fF775485246999027B3197955': { symbol: 'USDT', verified: true },
        '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56': { symbol: 'BUSD', verified: true },
        '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d': { symbol: 'USDC', verified: true },
        '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c': { symbol: 'WBNB', verified: true },
        // Skynet ecosystem tokens (not tradeable — soulbound badges + project token)
        '0x8Ef0ecE5687417a8037F787b39417eB16972b04F': { symbol: 'SKYNET', verified: true },
        '0xAE1908C7d64562732A25E7B55980556514d46C35': { symbol: 'SENTINEL', verified: true, soulbound: true },
        '0xB752e44E1E67E657Cf0553993B4552644ce2C352': { symbol: 'SCAMTOKEN', verified: true, soulbound: true }
    },
    polygon: {
        '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': { symbol: 'USDC', verified: true },
        '0xc2132D05D31c914a87C6611C10748AEb04B58e8F': { symbol: 'USDT', verified: true },
        '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270': { symbol: 'WMATIC', verified: true }
    }
};

// Stablecoin addresses by network (for deposit classification)
const STABLECOIN_ADDRESSES = {
    ethereum: new Set([
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
        '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
        '0x6b175474e89094c44da98b954eesdecb5be93d21', // DAI
    ]),
    bsc: new Set([
        '0x55d398326f99059ff775485246999027b3197955', // USDT
        '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
        '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
    ]),
    polygon: new Set([
        '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC
        '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
    ])
};

// Known scam tokens (blacklisted)
const BLACKLISTED_TOKENS = new Set([
    // Add known scam token addresses here
]);

// DEX Router addresses for swap simulation
const DEX_ROUTERS = {
    ethereum: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2
    bsc: '0x10ED43C718714eb63d5aA57B78B54704E256024E', // PancakeSwap
    polygon: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff' // QuickSwap
};

// Wrapped native token addresses
const WRAPPED_NATIVE = {
    ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    polygon: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'
};

// Block explorer API V2 (unified Etherscan V2 endpoint for all chains)
const EXPLORER_API_V2 = {
    bsc: { chainId: 56, apiKeyEnv: 'BSCSCAN_API_KEY' },
    ethereum: { chainId: 1, apiKeyEnv: 'ETHERSCAN_API_KEY' },
    polygon: { chainId: 137, apiKeyEnv: 'POLYGONSCAN_API_KEY' }
};
const EXPLORER_V2_BASE = 'https://api.etherscan.io/v2/api';

// Block explorer API URLs (legacy V1 fallback — deprecated but kept for reference)
const EXPLORER_API = {
    bsc: 'https://api.bscscan.com/api',
    ethereum: 'https://api.etherscan.io/api',
    polygon: 'https://api.polygonscan.com/api'
};

// Popular tokens to probe balances for (beyond the whitelist)
// These are frequently airdropped, traded, or held on each network
const POPULAR_TOKENS = {
    bsc: [
        '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // CAKE
        '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // ETH (BSC)
        '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', // BTCB
        '0x1D2F0da169ceB9fC7B3144828DB6a2DcA5951e4a', // XRP (BSC)
        '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', // ADA (BSC)
        '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', // LINK (BSC)
        '0x4338665CBB7B2485A8855A139b75D5e34AB0DB94', // LTC (BSC)
        '0x1CE0c2827e2eF14D5C4f29a091d735A204794041', // AVAX (BSC)
        '0xBf5140A22578168FD562DCcF235E5D43A02ce9B1', // UNI (BSC)
        '0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153', // FIL (BSC)
        '0xCE7de646e7208a4Ef112cb6ed5038FA6cC6b12e3', // TRX (BSC)
        '0x85EAC5Ac2F758618dFa09bDbe0cf174e7d574D5B', // TRX (BSC alt)
        '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', // DOT (BSC)
        '0xCC42724C6683B7E57334c4E856f4c9965ED682bD', // MATIC (BSC)
        '0x570A5D26f7765Ecb712C0924E4De545B89fD43dF', // SOL (BSC)
        '0xd55c9fb62e176a8eb6968f32958fefdd0962727e', // FHE
        '0x07587a6b3d73b9c393934bb73a1df24ff6827aed', // User-tracked token
        '0xf1d6c42a9c6fbfbe9e082844c485dada00587ecb', // User-tracked token
        '0x436E29d38F81AfafA08903c5dC268B6be5722e1b', // User-tracked token
        '0x0b1d2bfa36447340fca02a82fb13426acdd34b32', // User-tracked token
        '0x3f8d1a1c568ba520e05a35ac31040976828aa5a1', // User-tracked token
        '0x9A0Ee07f1412E46ff12d22f4380Ff2F823D5eB23', // User-tracked token
        '0x97439478b92F6d8D59C2081deC9E6eAC587dabC0', // User-tracked token
        '0x6bda49b226509889f6bf5f86dda791dc09c4b681', // User-tracked token
        '0x894d305d1a010c88ed4c3F885969d192d81816B0', // User-tracked token
    ],
    ethereum: [
        '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK
        '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI
        '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', // AAVE
        '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', // MKR
        '0xD533a949740bb3306d119CC777fa900bA034cd52', // CRV
        '0x6B3595068778DD592e39A122f4f5a5cF09C90fE2', // SUSHI
        '0x4d224452801ACEd8B2F0aebE155379bb5D594381', // APE
        '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', // SHIB
    ],
    polygon: [
        '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', // LINK
        '0xb33EaAd8d922B1083446DC23f610c2567fB5180f', // UNI
        '0x831753DD7087CaC61aB5644b308642cc1c33Dc13', // QUICK
        '0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b', // AVAX
    ]
};

class TokenScanner {
    constructor() {
        this.knownTokens = new Map(); // address -> token info
        this.lastBalances = new Map(); // network:address -> balance
        this.scanInterval = null;
        this.transferListeners = new Map();
        this.isScanning = false;
        this.deepScanDone = new Set(); // networks that completed initial deep scan
        this.deepScanRunning = new Set(); // networks currently running deep scan
        this.explorerApiKeys = {}; // cached API keys from DB
        this.moralisApiKey = null; // optional Moralis key for enhanced token discovery
    }

    /**
     * Initialize the token scanner and optionally auto-start
     */
    async initialize(walletAddress, { autoStart = false } = {}) {
        this.walletAddress = walletAddress;

        // Load API keys from DB
        await this.loadExplorerApiKeys();
        await this.loadMoralisApiKey();

        logger.info('Token scanner initialized', { walletAddress, autoStart, hasApiKeys: Object.keys(this.explorerApiKeys).length > 0, hasMoralis: !!this.moralisApiKey });

        if (autoStart && !this.scanInterval) {
            this.startScanning();
        }
    }

    /**
     * Load explorer API keys from encrypted DB storage.
     * Uses PluginSettings with pluginName='crypto' settingsKey='explorer_api_keys'.
     * Falls back to environment variables.
     */
    async loadExplorerApiKeys() {
        try {
            const stored = await PluginSettings.getCached('crypto', 'explorer_api_keys');
            if (stored) {
                for (const [network, encryptedKey] of Object.entries(stored)) {
                    try {
                        this.explorerApiKeys[network] = decrypt(encryptedKey);
                    } catch (err) {
                        logger.warn(`Failed to decrypt explorer API key for ${network}`);
                    }
                }
                logger.info(`Loaded explorer API keys from DB for: ${Object.keys(this.explorerApiKeys).join(', ')}`);
            }
        } catch (err) {
            logger.warn(`Failed to load explorer API keys from DB: ${err.message}`);
        }

        // Fall back to env vars for any networks not loaded from DB
        for (const [network, config] of Object.entries(EXPLORER_API_V2)) {
            if (!this.explorerApiKeys[network] && process.env[config.apiKeyEnv]) {
                this.explorerApiKeys[network] = process.env[config.apiKeyEnv];
            }
        }
    }

    /**
     * Store an explorer API key in the encrypted DB.
     * The same key works for both etherscan V2 and bscscan (unified API).
     * @param {string} apiKey - The API key
     * @param {string[]} networks - Networks this key applies to (default: all)
     */
    async setExplorerApiKey(apiKey, networks = ['bsc', 'ethereum', 'polygon']) {
        // Load existing keys first
        let stored = {};
        try {
            stored = await PluginSettings.getCached('crypto', 'explorer_api_keys') || {};
        } catch (_) {}

        // Encrypt and store for each network
        const encryptedKey = encrypt(apiKey);
        for (const network of networks) {
            stored[network] = encryptedKey;
            this.explorerApiKeys[network] = apiKey; // cache in memory too
        }

        await PluginSettings.setCached('crypto', 'explorer_api_keys', stored);
        logger.info(`Stored explorer API key for networks: ${networks.join(', ')}`);

        // Reset deep scan state so next cycle uses the new key
        this.deepScanDone.clear();

        return { success: true, networks };
    }

    /**
     * Get the explorer API key for a network.
     * Checks in-memory cache first, then DB, then env vars.
     */
    getExplorerApiKey(network) {
        return this.explorerApiKeys[network] || null;
    }

    /**
     * Load Moralis API key from encrypted DB storage.
     * Falls back to MORALIS_API_KEY env var.
     */
    async loadMoralisApiKey() {
        try {
            const stored = await PluginSettings.getCached('crypto', 'moralis_api_key');
            if (stored) {
                this.moralisApiKey = decrypt(stored);
                logger.info('Loaded Moralis API key from DB');
            }
        } catch (err) {
            logger.debug(`Failed to load Moralis API key: ${err.message}`);
        }
        // Env var fallback
        if (!this.moralisApiKey && process.env.MORALIS_API_KEY) {
            this.moralisApiKey = process.env.MORALIS_API_KEY;
        }
    }

    /**
     * Store Moralis API key in encrypted DB.
     */
    async setMoralisApiKey(apiKey) {
        const encryptedKey = encrypt(apiKey);
        await PluginSettings.setCached('crypto', 'moralis_api_key', encryptedKey);
        this.moralisApiKey = apiKey;
        this.deepScanDone.clear(); // Re-scan with new key
        logger.info('Moralis API key stored (encrypted)');
        return { success: true };
    }

    /**
     * Get Moralis API key status (has key, not the key itself).
     */
    getMoralisApiKeyStatus() {
        return { configured: !!this.moralisApiKey };
    }

    /**
     * Scan token balances via Moralis API (optional enhancement).
     * Returns all ERC-20 tokens held by the wallet on the given network.
     * Moralis also flags possible_spam tokens — great for scam detection.
     */
    async scanViaMoralis(network) {
        if (!this.moralisApiKey || !this.walletAddress) return { tokens: [], scamTokens: [] };

        const chainMap = { bsc: 'bsc', ethereum: 'eth', polygon: 'polygon' };
        const chain = chainMap[network];
        if (!chain) return { tokens: [], scamTokens: [] };

        try {
            logger.info(`[TokenScanner] Moralis scan starting for ${network}`);
            const response = await axios.get(
                `https://deep-index.moralis.io/api/v2.2/wallets/${this.walletAddress}/tokens`,
                {
                    params: { chain },
                    headers: { 'X-API-Key': this.moralisApiKey },
                    timeout: 30000
                }
            );

            const results = response.data?.result || [];
            const tokens = [];
            const scamTokens = [];

            for (const token of results) {
                if (token.native_token) continue; // Skip native (BNB/ETH)

                const addr = token.token_address?.toLowerCase();
                if (!addr) continue;

                const balance = parseFloat(token.balance_formatted || '0');
                if (balance <= 0) continue;

                const tokenKey = `${network}:${addr}`;
                const isSpam = token.possible_spam === true;
                const usdValue = parseFloat(token.usd_value || '0');

                const tokenData = {
                    address: addr,
                    symbol: token.symbol || '???',
                    name: token.name || 'Unknown',
                    decimals: token.decimals || 18,
                    balance,
                    usdValue,
                    verified: token.verified_contract || false,
                    possibleSpam: isSpam,
                    source: 'moralis'
                };

                if (isSpam) {
                    scamTokens.push(tokenData);
                } else {
                    tokens.push(tokenData);
                }

                // Add to known tokens map if not already there
                if (!this.knownTokens.has(tokenKey)) {
                    this.knownTokens.set(tokenKey, {
                        address: addr,
                        symbol: token.symbol,
                        name: token.name,
                        decimals: token.decimals || 18,
                        balance,
                        network,
                        classification: isSpam ? 'scam' : (usdValue > 0.5 ? 'safe_unknown' : 'dust'),
                        scamConfidence: isSpam ? 80 : 0,
                        source: 'moralis',
                        firstSeen: new Date()
                    });
                }
            }

            logger.info(`[TokenScanner] Moralis scan ${network}: ${results.length} tokens found (${tokens.length} safe, ${scamTokens.length} spam)`);
            return { tokens, scamTokens };
        } catch (err) {
            logger.warn(`[TokenScanner] Moralis scan failed for ${network}: ${err.message}`);
            return { tokens: [], scamTokens: [] };
        }
    }

    /**
     * Start periodic token scanning
     */
    startScanning(intervalMs = 300000) { // Default 5 minutes
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }

        this.scanInterval = setInterval(async () => {
            await this.scanAllNetworks();
        }, intervalMs);

        // Run initial scan
        this.scanAllNetworks();

        logger.info('Token scanning started', { intervalMs });
    }

    /**
     * Stop periodic scanning
     */
    stopScanning() {
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
        logger.info('Token scanning stopped');
    }

    /**
     * Scan all active networks for new tokens
     */
    async scanAllNetworks() {
        if (this.isScanning) {
            logger.debug('Scan already in progress, skipping');
            return;
        }

        this.isScanning = true;
        const results = { newTokens: [], scamTokens: [], safeTokens: [] };

        try {
            const networks = ['ethereum', 'bsc', 'polygon'];

            for (const network of networks) {
                try {
                    const networkResults = await this.scanNetwork(network);
                    results.newTokens.push(...networkResults.newTokens);
                    results.scamTokens.push(...networkResults.scamTokens);
                    results.safeTokens.push(...networkResults.safeTokens);
                } catch (error) {
                    logger.warn(`Failed to scan ${network}:`, error.message);
                }
            }

            if (results.newTokens.length > 0) {
                logger.info('New tokens detected', {
                    total: results.newTokens.length,
                    safe: results.safeTokens.length,
                    scam: results.scamTokens.length
                });
            }
        } finally {
            this.isScanning = false;
        }

        return results;
    }

    /**
     * Scan a single network for tokens (recent window — used for ongoing monitoring)
     */
    async scanNetwork(network) {
        const results = { newTokens: [], scamTokens: [], safeTokens: [] };

        if (!this.walletAddress) {
            return results;
        }

        try {
            const provider = await contractServiceWrapper.getProvider(network);
            if (!provider) return results;

            // Use 5000 blocks for regular scans (~4h BSC, ~17h ETH)
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - 5000);

            // ERC20 Transfer event topic
            const transferTopic = ethers.id('Transfer(address,address,uint256)');
            const toAddressPadded = ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32);

            const logs = await provider.getLogs({
                fromBlock,
                toBlock: currentBlock,
                topics: [
                    transferTopic,
                    null, // from (any)
                    toAddressPadded // to (our address)
                ]
            });

            // Filter out tokens sent by flagged scammer addresses
            let scammerRegistry = null;
            try {
                scammerRegistry = (await import('./scammerRegistryService.js')).default;
            } catch (e) { /* registry not available */ }

            // Build token set, excluding tokens only sent by scammers
            const tokenAddressSet = new Set();
            for (const log of logs) {
                const tokenAddr = log.address.toLowerCase();
                // Check if sender is a flagged scammer
                if (scammerRegistry && log.topics[1]) {
                    const sender = '0x' + log.topics[1].slice(26).toLowerCase();
                    if (scammerRegistry.isAddressFlagged(sender)) {
                        logger.info(`[TokenScanner] Ignoring token ${tokenAddr} from flagged sender ${sender}`);
                        continue;
                    }
                }
                tokenAddressSet.add(tokenAddr);
            }
            const tokenAddresses = [...tokenAddressSet];

            for (const tokenAddress of tokenAddresses) {
                try {
                    const tokenInfo = await this.analyzeToken(tokenAddress, network, provider);

                    if (tokenInfo) {
                        results.newTokens.push(tokenInfo);

                        if (tokenInfo.isSafe) {
                            results.safeTokens.push(tokenInfo);
                        } else if (tokenInfo.isScam) {
                            results.scamTokens.push(tokenInfo);
                        }
                    }
                } catch (error) {
                    logger.debug(`Failed to analyze token ${tokenAddress}:`, error.message);
                }
            }
        } catch (error) {
            logger.warn(`Network scan failed for ${network}: ${error.message || error.code || JSON.stringify(error).slice(0, 200)}`);
        }

        return results;
    }

    /**
     * Deep scan — searches a large block range in chunks to find historical token transfers.
     * Runs once per network on first startup to catch tokens sent before the scanner was active.
     * Uses dedicated scan RPCs with better getLogs support (e.g., dRPC for BSC).
     */
    async scanNetworkDeep(network, maxBlocks = 5000000) {
        if (this.deepScanDone.has(network) || this.deepScanRunning.has(network)) {
            return { newTokens: [], scamTokens: [], safeTokens: [] };
        }

        this.deepScanRunning.add(network);
        const results = { newTokens: [], scamTokens: [], safeTokens: [] };
        const discoveredAddresses = new Set();

        if (!this.walletAddress) {
            this.deepScanRunning.delete(network);
            return results;
        }

        try {
            const provider = await contractServiceWrapper.getProvider(network);
            if (!provider) {
                this.deepScanRunning.delete(network);
                return results;
            }

            // Use a dedicated scan RPC with better getLogs range support
            // Public BSC RPCs return 0 for getLogs; dRPC supports 9999-block ranges
            const scanRpcs = {
                bsc: ['https://bsc.drpc.org', 'https://bsc-pokt.nodies.app', 'https://bsc-mainnet.public.blastapi.io'],
                ethereum: [] // Default provider works for ETH
            };
            const scanChunkLimits = { bsc: 9999, ethereum: 2000 };

            let scanProvider = provider;
            const candidateRpcs = scanRpcs[network] || [];
            for (const rpcUrl of candidateRpcs) {
                try {
                    const testProvider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
                    await testProvider.getBlockNumber();
                    scanProvider = testProvider;
                    logger.info(`[TokenScanner] Deep scan using dedicated RPC for ${network}: ${rpcUrl}`);
                    break;
                } catch (e) {
                    logger.debug(`Deep scan RPC ${rpcUrl} unavailable: ${e.message}`);
                }
            }

            const currentBlock = await scanProvider.getBlockNumber();
            const startBlock = Math.max(0, currentBlock - maxBlocks);
            const chunkSize = scanChunkLimits[network] || 2000;
            const totalChunks = Math.ceil(maxBlocks / chunkSize);
            const transferTopic = ethers.id('Transfer(address,address,uint256)');
            const toAddressPadded = ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32);
            const fromAddressPadded = ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32);

            logger.info(`[TokenScanner] Deep scan starting for ${network}: blocks ${startBlock}→${currentBlock} (${maxBlocks} blocks in ${totalChunks} chunks of ${chunkSize})`);

            let chunksScanned = 0;
            let totalLogs = 0;
            let errors = 0;

            for (let from = startBlock; from < currentBlock; from += chunkSize) {
                const to = Math.min(from + chunkSize - 1, currentBlock);
                try {
                    // Transfers TO wallet
                    const logsTo = await scanProvider.getLogs({
                        fromBlock: from,
                        toBlock: to,
                        topics: [transferTopic, null, toAddressPadded]
                    });
                    totalLogs += logsTo.length;
                    for (const log of logsTo) {
                        discoveredAddresses.add(log.address.toLowerCase());
                    }

                    // Also check transfers FROM wallet (tokens we traded/sent)
                    const logsFrom = await scanProvider.getLogs({
                        fromBlock: from,
                        toBlock: to,
                        topics: [transferTopic, fromAddressPadded]
                    });
                    totalLogs += logsFrom.length;
                    for (const log of logsFrom) {
                        discoveredAddresses.add(log.address.toLowerCase());
                    }
                } catch (err) {
                    errors++;
                    // Only log first few errors to avoid spam
                    if (errors <= 3) {
                        logger.debug(`Deep scan chunk ${from}-${to} failed on ${network}: ${err.message}`);
                    }
                }

                chunksScanned++;
                // Log progress every ~10% or 50 chunks
                if (chunksScanned % Math.max(50, Math.floor(totalChunks / 10)) === 0) {
                    const pct = ((from - startBlock) / maxBlocks * 100).toFixed(0);
                    logger.info(`[TokenScanner] Deep scan ${network}: ${pct}% (${discoveredAddresses.size} tokens, ${errors} errors)`);
                }

                // Early abort: if >90% of chunks are failing after 50+ attempts, RPC can't handle it
                if (chunksScanned >= 50 && errors / chunksScanned > 0.9) {
                    logger.warn(`[TokenScanner] Deep scan ${network}: aborting RPC scan — ${errors}/${chunksScanned} chunks failed (${(errors/chunksScanned*100).toFixed(0)}% error rate). Explorer API results will be used.`);
                    break;
                }

                // Rate limit delay
                await new Promise(r => setTimeout(r, 200));
            }

            logger.info(`[TokenScanner] Deep scan ${network} complete: ${totalLogs} transfer events, ${discoveredAddresses.size} unique tokens`);

            // Now analyze each discovered token
            for (const tokenAddress of discoveredAddresses) {
                // Skip if already known
                if (this.knownTokens.has(`${network}:${tokenAddress}`)) continue;

                try {
                    const tokenInfo = await this.analyzeToken(tokenAddress, network, provider);
                    if (tokenInfo) {
                        results.newTokens.push(tokenInfo);
                        if (tokenInfo.isSafe) results.safeTokens.push(tokenInfo);
                        else if (tokenInfo.isScam) results.scamTokens.push(tokenInfo);
                    }
                } catch (err) {
                    logger.debug(`Deep scan: failed to analyze ${tokenAddress}: ${err.message}`);
                }
            }

            // Don't mark deepScanDone here — let runDeepScanAll handle it after explorer fallback
            logger.info(`[TokenScanner] Deep scan ${network} analyzed: ${results.newTokens.length} tokens (${results.safeTokens.length} safe, ${results.scamTokens.length} scam)`);

        } catch (error) {
            logger.warn(`Deep scan failed for ${network}: ${error.message}`);
        } finally {
            this.deepScanRunning.delete(network);
        }

        return results;
    }

    /**
     * Run deep scan on all active networks (non-blocking, runs in background).
     * Pipeline: RPC deep scan → Explorer API → Balance probe (most reliable).
     * Only marks deepScanDone after all methods have been tried.
     */
    async runDeepScanAll(networks = ['bsc', 'ethereum']) {
        for (const network of networks) {
            if (this.deepScanDone.has(network)) continue;

            let foundTokens = 0;

            // Step 0: Moralis API — fastest and most comprehensive if key is configured
            // Returns ALL token balances with spam detection in a single call
            if (this.moralisApiKey) {
                try {
                    const moralisResults = await this.scanViaMoralis(network);
                    foundTokens += moralisResults.tokens.length + moralisResults.scamTokens.length;
                } catch (err) {
                    logger.warn(`Deep scan: Moralis scan failed for ${network}: ${err.message}`);
                }
            }

            // Step 1: Explorer API — fetch ALL tokens ever sent to wallet (most comprehensive)
            // This is the primary discovery method since it finds every token regardless of whitelist
            try {
                const explorerResults = await this.scanViaExplorerAPI(network);
                if (explorerResults) foundTokens += explorerResults.newTokens.length;
            } catch (err) {
                logger.warn(`Deep scan: Explorer API failed for ${network}: ${err.message}`);
            }

            // Step 2: RPC-based deep scan (catches recent transfers the explorer might lag on)
            try {
                const rpcResults = await this.scanNetworkDeep(network);
                foundTokens += rpcResults.newTokens.length;
            } catch (err) {
                logger.warn(`Deep scan: RPC scan failed for ${network}: ${err.message}`);
            }

            // Step 3: Transaction receipt scan — extracts token addresses from wallet's own tx history
            // This is the most reliable no-API-key method for discovering tokens the wallet has interacted with
            try {
                const receiptResults = await this.scanTransactionReceipts(network);
                foundTokens += receiptResults.newTokens.length;
            } catch (err) {
                logger.warn(`Deep scan: Transaction receipt scan failed for ${network}: ${err.message}`);
            }

            // Step 4: Always run balance probe — checks known + popular token balances via RPC
            // This is the most reliable method since balanceOf() works on all RPCs
            try {
                const probeResults = await this.probeTokenBalances(network);
                foundTokens += probeResults.newTokens.length;
            } catch (err) {
                logger.warn(`Deep scan: Balance probe failed for ${network}: ${err.message}`);
            }

            // Mark as done after all methods have been tried
            this.deepScanDone.add(network);
            logger.info(`[TokenScanner] Deep scan pipeline complete for ${network}: ${foundTokens} tokens found, ${this.knownTokens.size} total known`);
        }
    }

    /**
     * Scan via block explorer API (BSCScan/Etherscan/Polygonscan).
     * Uses free tokentx endpoint to get ALL ERC20 transfers to our wallet.
     * No API key needed (rate limited to ~1 req/5 sec).
     */
    async scanViaExplorerAPI(network) {
        if (!this.walletAddress) return { newTokens: [], scamTokens: [], safeTokens: [] };

        const results = { newTokens: [], scamTokens: [], safeTokens: [] };

        // Determine which API to use: V2 with API key (preferred) or V1 legacy fallback
        const v2Config = EXPLORER_API_V2[network];
        const apiKey = this.getExplorerApiKey(network) || (v2Config ? process.env[v2Config.apiKeyEnv] : null);
        const explorerUrl = apiKey ? EXPLORER_V2_BASE : EXPLORER_API[network];

        if (!explorerUrl) return results;

        try {
            logger.info(`[TokenScanner] Explorer API scan starting for ${network} (${apiKey ? 'V2 with key' : 'V1 legacy'})`);

            // Build request params based on API version
            const params = {
                module: 'account',
                action: 'tokentx',
                address: this.walletAddress,
                startblock: 0,
                endblock: 99999999,
                page: 1,
                offset: 10000,
                sort: 'desc'
            };

            if (apiKey) {
                params.chainid = v2Config.chainId;
                params.apikey = apiKey;
            }

            const response = await axios.get(explorerUrl, {
                params,
                timeout: 30000
            });

            if (response.data?.status !== '1' || !Array.isArray(response.data.result)) {
                logger.warn(`[TokenScanner] Explorer API returned no results for ${network}: ${response.data?.message || 'unknown'}`);
                return results;
            }

            const transfers = response.data.result;
            // Extract ALL unique token addresses from transfers (not just incoming)
            // We check balanceOf() anyway, so include tokens we may have bought too
            const allTokenAddresses = new Set();
            for (const tx of transfers) {
                if (tx.contractAddress) {
                    allTokenAddresses.add(tx.contractAddress.toLowerCase());
                }
            }

            logger.info(`[TokenScanner] Explorer API found ${allTokenAddresses.size} unique token contracts on ${network} (from ${transfers.length} transfers)`);

            // Analyze each token that we don't already know about
            const provider = await contractServiceWrapper.getProvider(network);
            if (!provider) return results;

            let analyzed = 0;
            for (const tokenAddress of allTokenAddresses) {
                if (this.knownTokens.has(`${network}:${tokenAddress}`)) continue;

                try {
                    const tokenInfo = await this.analyzeToken(tokenAddress, network, provider);
                    if (tokenInfo) {
                        // Only report tokens with non-zero balance
                        if (parseFloat(tokenInfo.balance || '0') > 0) {
                            results.newTokens.push(tokenInfo);
                            if (tokenInfo.isSafe) results.safeTokens.push(tokenInfo);
                            else if (tokenInfo.isScam) results.scamTokens.push(tokenInfo);
                        }
                        analyzed++;
                    }
                } catch (err) {
                    logger.debug(`Explorer scan: failed to analyze ${tokenAddress}: ${err.message}`);
                }

                // Rate limit: explorer API free tier allows ~5 req/sec without key
                await new Promise(r => setTimeout(r, 200));
            }

            // Don't mark deepScanDone here — let runDeepScanAll handle it
            logger.info(`[TokenScanner] Explorer API scan ${network} complete: analyzed ${analyzed}, ${results.newTokens.length} with balance (${results.safeTokens.length} safe, ${results.scamTokens.length} scam)`);

        } catch (error) {
            logger.warn(`[TokenScanner] Explorer API scan failed for ${network}: ${error.message}`);
        }

        return results;
    }

    /**
     * Scan wallet's own transaction receipts to discover token addresses.
     * Examines the most recent N transactions from this wallet and extracts
     * token contract addresses from Transfer events in the receipts.
     * Works without any API keys — pure RPC calls.
     */
    async scanTransactionReceipts(network) {
        const results = { newTokens: [], scamTokens: [], safeTokens: [] };
        if (!this.walletAddress) return results;

        try {
            const provider = await contractServiceWrapper.getProvider(network);
            if (!provider) return results;

            const txCount = await provider.getTransactionCount(this.walletAddress);
            if (txCount === 0) return results;

            // Scan the most recent transactions (up to 200) to find token addresses
            const maxTxToScan = Math.min(txCount, 200);
            const transferTopic = ethers.id('Transfer(address,address,uint256)');
            const walletLower = this.walletAddress.toLowerCase();
            const discoveredAddresses = new Set();

            logger.info(`[TokenScanner] Transaction receipt scan starting for ${network}: ${txCount} total txs, scanning latest ${maxTxToScan}`);

            // Get recent blocks to find our transactions
            const currentBlock = await provider.getBlockNumber();
            // Scan a wide range to find our txs — BSC: 500K blocks (~17 days), ETH: 100K (~2 weeks)
            const blocksToScan = network === 'bsc' ? 500000 : 100000;
            const startBlock = Math.max(0, currentBlock - blocksToScan);

            // Use getLogs with from-address topic to find our outgoing tx tokens
            // Transfer events FROM our wallet tell us which tokens we've interacted with
            const fromAddressPadded = ethers.zeroPadValue(walletLower, 32);
            const toAddressPadded = ethers.zeroPadValue(walletLower, 32);
            const chunkSize = network === 'bsc' ? 10000 : 5000;

            for (let from = startBlock; from < currentBlock; from += chunkSize) {
                const to = Math.min(from + chunkSize - 1, currentBlock);
                try {
                    // Transfers FROM our wallet (tokens we've sent/sold/approved)
                    const fromLogs = await provider.getLogs({
                        fromBlock: from,
                        toBlock: to,
                        topics: [transferTopic, fromAddressPadded]
                    }).catch(() => []);

                    for (const log of fromLogs) {
                        discoveredAddresses.add(log.address.toLowerCase());
                    }

                    // Transfers TO our wallet (tokens we've received/bought)
                    const toLogs = await provider.getLogs({
                        fromBlock: from,
                        toBlock: to,
                        topics: [transferTopic, null, toAddressPadded]
                    }).catch(() => []);

                    for (const log of toLogs) {
                        discoveredAddresses.add(log.address.toLowerCase());
                    }
                } catch (err) {
                    logger.debug(`Receipt scan chunk ${from}-${to} failed on ${network}: ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 50));
            }

            logger.info(`[TokenScanner] Receipt scan ${network}: discovered ${discoveredAddresses.size} token addresses from Transfer events`);

            // Now analyze each discovered token that we don't already know about
            let analyzed = 0;
            for (const tokenAddress of discoveredAddresses) {
                if (this.knownTokens.has(`${network}:${tokenAddress}`)) continue;

                try {
                    const tokenInfo = await this.analyzeToken(tokenAddress, network, provider);
                    if (tokenInfo && parseFloat(tokenInfo.balance || '0') > 0) {
                        results.newTokens.push(tokenInfo);
                        if (tokenInfo.isSafe) results.safeTokens.push(tokenInfo);
                        else if (tokenInfo.isScam) results.scamTokens.push(tokenInfo);
                        analyzed++;
                    }
                } catch (err) {
                    logger.debug(`Receipt scan: failed to analyze ${tokenAddress}: ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 100));
            }

            logger.info(`[TokenScanner] Receipt scan ${network} complete: ${analyzed} tokens with balance (${results.safeTokens.length} safe, ${results.scamTokens.length} scam)`);

        } catch (error) {
            logger.warn(`[TokenScanner] Transaction receipt scan failed for ${network}: ${error.message}`);
        }

        return results;
    }

    /**
     * Probe wallet balances for a list of known + popular token addresses.
     * Unlike event-based scanning, this uses direct balanceOf() RPC calls
     * which reliably work on all public RPCs regardless of getLogs limits.
     * Discovers any token with non-zero balance in the wallet.
     */
    async probeTokenBalances(network) {
        const results = { newTokens: [], scamTokens: [], safeTokens: [] };
        if (!this.walletAddress) return results;

        try {
            const provider = await contractServiceWrapper.getProvider(network);
            if (!provider) return results;

            // Combine whitelisted tokens + popular tokens on this network
            const tokensToCheck = new Set();

            // Add all whitelisted tokens
            const safes = SAFE_TOKENS[network] || {};
            for (const addr of Object.keys(safes)) {
                tokensToCheck.add(addr.toLowerCase());
            }

            // Add popular tokens per network
            const popularTokens = POPULAR_TOKENS[network] || [];
            for (const addr of popularTokens) {
                tokensToCheck.add(addr.toLowerCase());
            }

            // Add any externally provided addresses (from trade journals, etc.)
            if (this._extraTokenAddresses) {
                for (const addr of this._extraTokenAddresses) {
                    tokensToCheck.add(addr.toLowerCase());
                }
            }

            // Pull managed token addresses from active strategies
            try {
                // Check all token trader instances
                for (const [ttAddr, ttInstance] of strategyRegistry.getAllTokenTraders()) {
                    tokensToCheck.add(ttAddr.toLowerCase());
                    if (ttInstance?.getManagedTokenAddresses) {
                        for (const addr of ttInstance.getManagedTokenAddresses()) {
                            tokensToCheck.add(addr.toLowerCase());
                        }
                    }
                    if (ttInstance?.config?.tokenAddress) {
                        tokensToCheck.add(ttInstance.config.tokenAddress.toLowerCase());
                    }
                }
            } catch (err) {
                // Strategy registry may not be ready yet
            }

            logger.info(`[TokenScanner] Balance probe starting for ${network}: checking ${tokensToCheck.size} token addresses`);

            let withBalance = 0;
            for (const tokenAddress of tokensToCheck) {
                if (this.knownTokens.has(`${network}:${tokenAddress}`)) continue;

                try {
                    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
                    const balance = await contract.balanceOf(this.walletAddress).catch(() => 0n);

                    if (balance > 0n) {
                        // Non-zero balance — analyze this token
                        const tokenInfo = await this.analyzeToken(tokenAddress, network, provider);
                        if (tokenInfo) {
                            results.newTokens.push(tokenInfo);
                            if (tokenInfo.isSafe) results.safeTokens.push(tokenInfo);
                            else if (tokenInfo.isScam) results.scamTokens.push(tokenInfo);
                            withBalance++;
                        }
                    }
                } catch (err) {
                    // Token contract may not exist or may revert — skip
                }

                // Small delay to avoid rate limiting
                await new Promise(r => setTimeout(r, 50));
            }

            logger.info(`[TokenScanner] Balance probe ${network} complete: ${withBalance} tokens with balance found (${results.safeTokens.length} safe, ${results.scamTokens.length} scam)`);

        } catch (error) {
            logger.warn(`[TokenScanner] Balance probe failed for ${network}: ${error.message}`);
        }

        return results;
    }

    /**
     * Register additional token addresses to check during balance probes.
     * Used by CryptoStrategyAgent to feed trade journal addresses.
     */
    addExtraTokenAddresses(addresses) {
        if (!this._extraTokenAddresses) this._extraTokenAddresses = new Set();
        for (const addr of addresses) {
            if (addr) this._extraTokenAddresses.add(addr.toLowerCase());
        }
    }

    /**
     * Analyze a token for safety
     */
    async analyzeToken(tokenAddress, network, provider) {
        const addressLower = tokenAddress.toLowerCase();

        // Check blacklist first
        if (BLACKLISTED_TOKENS.has(addressLower)) {
            return {
                address: tokenAddress,
                network,
                isScam: true,
                isSafe: false,
                reason: 'Blacklisted token'
            };
        }

        // Check on-chain scammer registry (local cache, no RPC call)
        try {
            const scammerRegistry = (await import('./scammerRegistryService.js')).default;
            if (scammerRegistry.isAddressFlagged(tokenAddress)) {
                logger.info(`[TokenScanner] Token ${tokenAddress} flagged in scammer registry, ignoring`);
                return {
                    address: tokenAddress,
                    network,
                    isScam: true,
                    isSafe: false,
                    reason: 'Flagged in on-chain scammer registry'
                };
            }
        } catch (e) {
            // Registry not available — continue without it
        }

        // Check whitelist - still get balance for whitelisted tokens
        const safeToken = SAFE_TOKENS[network]?.[tokenAddress];
        if (safeToken) {
            try {
                const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
                const [balance, decimalsRaw] = await Promise.all([
                    contract.balanceOf(this.walletAddress).catch(() => 0n),
                    contract.decimals().catch(() => 18)
                ]);
                const decimals = Number(decimalsRaw);
                return {
                    address: tokenAddress,
                    network,
                    symbol: safeToken.symbol,
                    decimals,
                    balance: ethers.formatUnits(balance, decimals),
                    balanceRaw: balance.toString(),
                    isScam: false,
                    isSafe: true,
                    verified: true,
                    reason: 'Whitelisted token'
                };
            } catch (error) {
                return {
                    address: tokenAddress,
                    network,
                    symbol: safeToken.symbol,
                    isScam: false,
                    isSafe: true,
                    verified: true,
                    reason: 'Whitelisted token'
                };
            }
        }

        // Get token info
        try {
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

            const [name, symbol, decimalsRaw, totalSupply, balance] = await Promise.all([
                contract.name().catch(() => 'Unknown'),
                contract.symbol().catch(() => '???'),
                contract.decimals().catch(() => 18),
                contract.totalSupply().catch(() => 0n),
                contract.balanceOf(this.walletAddress).catch(() => 0n)
            ]);

            // Convert decimals to number (ethers v6 returns BigInt)
            const decimals = Number(decimalsRaw);

            const tokenInfo = {
                address: tokenAddress,
                network,
                name,
                symbol,
                decimals,
                totalSupply: totalSupply.toString(),
                balance: ethers.formatUnits(balance, decimals),
                balanceRaw: balance.toString(),
                isScam: false,
                isSafe: false,
                warnings: [],
                checks: {}
            };

            // Run safety checks
            await this.runSafetyChecks(tokenInfo, contract, provider, network);

            // Determine final status
            tokenInfo.isScam = tokenInfo.warnings.length >= 3 ||
                              tokenInfo.checks.isHoneypot ||
                              tokenInfo.checks.hasScamName;

            // Compute scam confidence score and registry category for on-chain reporting.
            // Only tokens with HIGH confidence (2+ strong signals) should be auto-reported.
            // "No swap path" alone is NOT a scam signal — many legit tokens lack DEX pairs.
            tokenInfo.scamConfidence = 0;
            tokenInfo.scamCategory = null;
            if (tokenInfo.checks.isHoneypot) {
                tokenInfo.scamConfidence += 50;     // Definitive: transfer actively blocked
                tokenInfo.scamCategory = 3;          // Honeypot
            }
            if (tokenInfo.checks.hasScamName) {
                tokenInfo.scamConfidence += 40;      // URL or spam pattern in name
                tokenInfo.scamCategory = tokenInfo.scamCategory || 2; // Phishing
            }
            if (tokenInfo.checks.isDust) {
                tokenInfo.scamConfidence += 15;      // Dust amount reinforces other signals
                if (!tokenInfo.scamCategory) tokenInfo.scamCategory = 6; // Dust Attack
            }
            if (tokenInfo.checks.noCode) {
                tokenInfo.scamConfidence += 20;      // No contract code = suspicious
                if (!tokenInfo.scamCategory) tokenInfo.scamCategory = 5; // Fake Contract
            }
            // 3+ warnings without a specific strong signal
            if (tokenInfo.warnings.length >= 3 && tokenInfo.scamConfidence < 50) {
                tokenInfo.scamConfidence += 30;
                if (!tokenInfo.scamCategory) tokenInfo.scamCategory = 7; // Other
            }

            // Token is safe if not scam and either sellable or simply no route found
            // (no route ≠ scam — many legit tokens lack direct V2/V3 pairs)
            tokenInfo.isSafe = !tokenInfo.isScam && tokenInfo.warnings.length === 0;

            // Mark as safe_unknown if we can't confirm sellability but it's not scam
            if (tokenInfo.isSafe && !tokenInfo.checks.canSell) {
                tokenInfo.safeUnknown = true;
            }

            this.knownTokens.set(`${network}:${addressLower}`, tokenInfo);

            return tokenInfo;
        } catch (error) {
            logger.debug(`Token analysis failed for ${tokenAddress}:`, error.message);
            return {
                address: tokenAddress,
                network,
                isScam: true,
                isSafe: false,
                reason: `Failed to read token: ${error.message}`
            };
        }
    }

    /**
     * Run safety checks on a token
     */
    async runSafetyChecks(tokenInfo, contract, provider, network) {
        // Check 1: Scam name patterns
        tokenInfo.checks.hasScamName = SCAM_INDICATORS.scamNamePatterns.some(
            pattern => pattern.test(tokenInfo.name) || pattern.test(tokenInfo.symbol)
        );
        if (tokenInfo.checks.hasScamName) {
            tokenInfo.warnings.push('Token name/symbol matches scam patterns');
        }

        // Check 2: Can we sell? (Honeypot detection via simulation)
        try {
            const sellResult = await this.simulateSell(
                tokenInfo.address,
                tokenInfo.balance,
                network,
                provider
            );
            tokenInfo.checks.canSell = sellResult === 'sellable';
            if (sellResult === 'honeypot') {
                tokenInfo.checks.isHoneypot = true;
                tokenInfo.warnings.push('Token sell actively blocked (honeypot)');
            } else if (sellResult === 'no_route') {
                // No swap route found — NOT a scam signal, just no liquidity on checked DEXes
                tokenInfo.checks.noRoute = true;
                logger.debug(`No swap route for ${tokenInfo.symbol} (${tokenInfo.address}) — not flagging as scam`);
            }
        } catch (error) {
            tokenInfo.checks.canSell = false;
            tokenInfo.warnings.push(`Sell simulation failed: ${error.message}`);
        }

        // Check 3: Very low balance (dust attack)
        const balanceNum = parseFloat(tokenInfo.balance);
        if (balanceNum > 0 && balanceNum < 0.0001) {
            tokenInfo.warnings.push('Very small balance (possible dust attack)');
            tokenInfo.checks.isDust = true;
        }

        // Check 4: Contract code check (basic)
        try {
            const code = await provider.getCode(tokenInfo.address);
            if (code === '0x') {
                tokenInfo.warnings.push('No contract code found');
                tokenInfo.checks.noCode = true;
            }
        } catch (error) {
            tokenInfo.warnings.push('Could not verify contract code');
        }
    }

    /**
     * Simulate a sell to check for honeypot.
     * Returns: 'sellable' | 'no_route' | 'honeypot'
     *  - 'sellable': a swap quote succeeded (token can be sold)
     *  - 'no_route': no liquidity/pair found (not necessarily a scam)
     *  - 'honeypot': sell actively reverted with transfer restriction
     */
    async simulateSell(tokenAddress, amount, network, provider) {
        const wrappedNative = WRAPPED_NATIVE[network];

        if (!wrappedNative || parseFloat(amount) === 0) {
            return 'no_route';
        }

        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const decimals = await tokenContract.decimals().catch(() => 18);
        const amountIn = ethers.parseUnits(
            Math.min(parseFloat(amount), 1).toString(),
            Number(decimals)
        );

        // Try V3 quote first via swapService (better liquidity)
        try {
            const v3Quote = await swapService._getV3Quote(tokenAddress, wrappedNative, amountIn, network);
            if (v3Quote && v3Quote.amountOut > 0n) {
                return 'sellable';
            }
        } catch (err) {
            logger.debug(`V3 sell simulation failed for ${tokenAddress}: ${err.message}`);
        }

        // Stablecoins to try as intermediate hops
        const intermediaries = {
            ethereum: [
                '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
                '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
            ],
            bsc: [
                '0x55d398326f99059fF775485246999027B3197955', // USDT
                '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
            ],
            polygon: [
                '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC
                '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
            ]
        };

        const router = DEX_ROUTERS[network];
        if (!router) return 'no_route';

        const routerContract = new ethers.Contract(router, ROUTER_ABI, provider);
        const addrLower = tokenAddress.toLowerCase();
        let sawRevert = false;

        // Try direct path: token → WETH
        try {
            const path = [tokenAddress, wrappedNative];
            const amounts = await routerContract.getAmountsOut(amountIn, path);
            if (amounts[1] > 0n) return 'sellable';
        } catch (error) {
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('transfer') || msg.includes('blacklist') || msg.includes('forbidden') || msg.includes('locked')) {
                sawRevert = true;
            }
            logger.debug(`V2 direct sell simulation failed for ${tokenAddress}: ${error.message}`);
        }

        // Try multi-hop paths: token → stablecoin → WETH
        const hops = intermediaries[network] || [];
        for (const mid of hops) {
            if (mid.toLowerCase() === addrLower) continue;
            try {
                const path = [tokenAddress, mid, wrappedNative];
                const amounts = await routerContract.getAmountsOut(amountIn, path);
                if (amounts[2] > 0n) return 'sellable';
            } catch (error) {
                const msg = (error.message || '').toLowerCase();
                if (msg.includes('transfer') || msg.includes('blacklist') || msg.includes('forbidden') || msg.includes('locked')) {
                    sawRevert = true;
                }
            }
        }

        // Try V3 via stablecoins too
        for (const mid of hops) {
            if (mid.toLowerCase() === addrLower) continue;
            try {
                const v3Quote = await swapService._getV3Quote(tokenAddress, mid, amountIn, network);
                if (v3Quote && v3Quote.amountOut > 0n) return 'sellable';
            } catch (err) {
                // ignore
            }
        }

        return sawRevert ? 'honeypot' : 'no_route';
    }

    /**
     * Check if a specific token is safe
     */
    async isTokenSafe(tokenAddress, network) {
        const key = `${network}:${tokenAddress.toLowerCase()}`;

        // Check cache first
        if (this.knownTokens.has(key)) {
            return this.knownTokens.get(key);
        }

        // Analyze token
        try {
            const provider = await contractServiceWrapper.getProvider(network);
            const tokenInfo = await this.analyzeToken(tokenAddress, network, provider);
            return tokenInfo;
        } catch (error) {
            logger.error(`Failed to check token safety:`, error);
            return { isScam: true, isSafe: false, reason: error.message };
        }
    }

    /**
     * Get all detected tokens
     */
    getDetectedTokens() {
        const tokens = [];
        for (const [key, info] of this.knownTokens) {
            tokens.push(info);
        }
        return tokens;
    }

    /**
     * Get safe tokens that can be sold
     */
    getSellableTokens() {
        return this.getDetectedTokens().filter(t => t.isSafe && parseFloat(t.balance) > 0);
    }

    /**
     * Get scam/suspicious tokens
     */
    getScamTokens() {
        return this.getDetectedTokens().filter(t => t.isScam);
    }

    /**
     * Monitor for incoming native token transfers
     */
    async monitorNativeTransfers(network, callback) {
        try {
            const provider = await contractServiceWrapper.getProvider(network);
            if (!provider) return;

            // Store last known balance
            const key = `${network}:native`;
            const currentBalance = await provider.getBalance(this.walletAddress);
            const lastBalance = this.lastBalances.get(key) || 0n;

            if (currentBalance > lastBalance && lastBalance > 0n) {
                const received = currentBalance - lastBalance;
                callback({
                    network,
                    type: 'native',
                    amount: ethers.formatEther(received),
                    newBalance: ethers.formatEther(currentBalance)
                });
            }

            this.lastBalances.set(key, currentBalance);
        } catch (error) {
            logger.warn(`Failed to monitor ${network}:`, error.message);
        }
    }

    /**
     * Classify a token for deposit handling
     * @param {string} tokenAddress
     * @param {string} network
     * @param {Set<string>} managedTokenAddresses - lowercased addresses managed by strategies
     * @returns {Promise<string>} 'stablecoin' | 'strategy_managed' | 'safe_unknown' | 'scam' | 'dust'
     */
    async classifyToken(tokenAddress, network, managedTokenAddresses = new Set()) {
        const addrLower = tokenAddress.toLowerCase();

        // Check stablecoins first
        if (STABLECOIN_ADDRESSES[network]?.has(addrLower)) {
            return 'stablecoin';
        }

        // Check if a strategy is actively managing this token
        if (managedTokenAddresses.has(addrLower)) {
            return 'strategy_managed';
        }

        // Check whitelist
        if (SAFE_TOKENS[network]?.[tokenAddress]) {
            return 'safe_unknown'; // Known token but not managed — could be sold
        }

        // Run full safety analysis
        try {
            const provider = await contractServiceWrapper.getProvider(network);
            if (!provider) return 'scam';

            const tokenInfo = await this.analyzeToken(tokenAddress, network, provider);
            if (!tokenInfo) return 'scam';

            if (tokenInfo.checks?.isDust) return 'dust';
            if (tokenInfo.isScam) return 'scam';
            if (tokenInfo.isSafe) return 'safe_unknown';

            // Has 1-2 warnings but not definitively scam — still attempt sell
            return 'safe_unknown';
        } catch (error) {
            logger.warn(`classifyToken failed for ${tokenAddress} on ${network}: ${error.message}`);
            // RPC errors (timeouts, rate limits) should NOT condemn a token as scam.
            // Return safe_unknown so auto-sell is attempted — if it's truly unsellable, the swap will fail gracefully.
            return 'safe_unknown';
        }
    }

    /**
     * Detect new deposits by comparing current balances against last known
     * @param {string} network
     * @param {object} lastKnownBalances - { 'native': '1.5', '0xaddr...': '100.0', ... }
     * @param {Set<string>} managedTokenAddresses - lowercased addresses managed by strategies
     * @returns {Promise<Array>} Array of deposit objects
     */
    async detectNewDeposits(network, lastKnownBalances = {}, managedTokenAddresses = new Set()) {
        const deposits = [];

        if (!this.walletAddress) {
            return deposits;
        }

        try {
            const provider = await contractServiceWrapper.getProvider(network);
            if (!provider) return deposits;

            // Check native balance
            const currentNativeBalance = await provider.getBalance(this.walletAddress);
            const currentNativeStr = ethers.formatEther(currentNativeBalance);
            const lastNative = parseFloat(lastKnownBalances.native || '0');
            const currentNative = parseFloat(currentNativeStr);

            if (currentNative > lastNative && lastNative > 0) {
                const received = currentNative - lastNative;
                if (received > 0.0001) { // ignore dust
                    deposits.push({
                        type: 'native',
                        network,
                        tokenAddress: null,
                        symbol: network === 'bsc' ? 'BNB' : network === 'polygon' ? 'MATIC' : 'ETH',
                        amount: received.toString(),
                        amountFormatted: received.toFixed(6),
                        classification: 'native',
                        currentBalance: currentNativeStr
                    });
                }
            }

            // Scan ERC20 transfers (recent events)
            const networkResults = await this.scanNetwork(network);
            const eventTokens = [...networkResults.newTokens, ...networkResults.safeTokens];

            // Also include all known tokens for this network from balance probe / deep scan
            // This catches tokens that were received before the event window
            const knownNetworkTokens = [];
            for (const [key, info] of this.knownTokens) {
                if (key.startsWith(`${network}:`) && info.balance && parseFloat(info.balance) > 0) {
                    knownNetworkTokens.push(info);
                }
            }

            // Merge: event-found tokens + known tokens (deduplicate by address)
            const seen = new Set();
            const allTokens = [];
            for (const token of [...eventTokens, ...knownNetworkTokens]) {
                const addr = token.address?.toLowerCase();
                if (addr && !seen.has(addr)) {
                    seen.add(addr);
                    allTokens.push(token);
                }
            }

            logger.info(`detectNewDeposits [${network}]: events=${eventTokens.length}, knownTokens=${knownNetworkTokens.length}, merged=${allTokens.length}, totalKnownMap=${this.knownTokens.size}`);

            for (const token of allTokens) {
                if (!token.address || !token.balance) continue;
                const addrLower = token.address.toLowerCase();
                const currentBal = parseFloat(token.balance);
                const lastBal = parseFloat(lastKnownBalances[addrLower] || '0');

                if (currentBal > lastBal && currentBal > 0) {
                    const received = currentBal - lastBal;
                    // Skip tiny dust amounts (< $0.001 worth roughly)
                    if (received < 0.000001) continue;

                    // Throttle between classifications to avoid RPC rate limiting (each classification makes ~20+ RPC calls)
                    if (deposits.length > 0) await new Promise(r => setTimeout(r, 2000));

                    const classification = await this.classifyToken(token.address, network, managedTokenAddresses);

                    deposits.push({
                        type: 'erc20',
                        network,
                        tokenAddress: token.address,
                        symbol: token.symbol || '???',
                        decimals: token.decimals || 18,
                        amount: received.toString(),
                        amountFormatted: received.toFixed(6),
                        classification,
                        currentBalance: token.balance
                    });
                }
            }

            if (deposits.length > 0) {
                logger.info(`Deposit scan: ${deposits.length} new deposit(s) on ${network}`, {
                    deposits: deposits.map(d => `${d.symbol}: +${d.amountFormatted} (${d.classification})`)
                });
            }
        } catch (error) {
            logger.warn(`detectNewDeposits failed for ${network}: ${error.message}`);
        }

        return deposits;
    }

    /**
     * Get scanner status
     */
    getStatus() {
        return {
            initialized: !!this.walletAddress,
            walletAddress: this.walletAddress,
            isScanning: this.isScanning,
            periodicScanActive: !!this.scanInterval,
            deepScanCompleted: [...this.deepScanDone],
            deepScanRunning: [...this.deepScanRunning],
            knownTokensCount: this.knownTokens.size,
            safeTokens: this.getSellableTokens().length,
            scamTokens: this.getScamTokens().length
        };
    }
}

// Export singleton
export const tokenScanner = new TokenScanner();
export default tokenScanner;
