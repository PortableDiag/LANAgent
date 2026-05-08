import express from 'express';
import crypto from 'crypto';
import walletService from '../services/crypto/walletService.js';
import { tokenScanner } from '../services/crypto/tokenScanner.js';
import { cryptoLogger as logger } from '../utils/logger.js';
import { authenticateToken as authMiddleware } from '../interfaces/web/auth.js';
import NodeCache from 'node-cache';
import SubAgent from '../models/SubAgent.js';
import strategyExporter from '../services/crypto/strategyExporter.js';

const router = express.Router();

// Initialize node-cache with 5-minute TTL
const cache = new NodeCache({ 
    stdTTL: 300, // 5 minutes
    checkperiod: 60, // Check for expired entries every 60 seconds
    useClones: false // Don't clone objects for better performance
});

// Log cache statistics periodically
cache.on('expired', (key, value) => {
    logger.debug(`Cache expired for key: ${key}`);
});

cache.on('set', (key, value) => {
    logger.debug(`Cache set for key: ${key}`);
});

// Helper function to get cached data
function getCachedData(key) {
    try {
        const value = cache.get(key);
        if (value !== undefined) {
            logger.debug(`Cache hit for ${key}`);
            return value;
        }
    } catch (error) {
        logger.error('Cache get error:', error);
    }
    return null;
}

// Helper function to set cached data
function setCachedData(key, data) {
    try {
        cache.set(key, data);
    } catch (error) {
        logger.error('Cache set error:', error);
    }
}

// Apply auth middleware to all routes
router.use(authMiddleware);

// Get wallet status
router.get('/status', async (req, res) => {
    try {
        const cacheKey = 'wallet:status';
        const cachedData = getCachedData(cacheKey);
        
        if (cachedData) {
            return res.json(cachedData);
        }
        
        const walletInfo = await walletService.getWalletInfo();
        setCachedData(cacheKey, walletInfo);
        res.json(walletInfo);
    } catch (error) {
        logger.error('Failed to get wallet status:', error);
        res.status(500).json({ error: 'Failed to get wallet status' });
    }
});

// Portfolio overview for visualization (combines balances + positions + prices)
router.get('/portfolio', async (req, res) => {
    try {
        if (!walletService.isInitialized()) {
            return res.json({ success: true, tokens: [] });
        }

        const tokens = [];
        const handler = await getCryptoHandler();
        const status = handler ? handler.getStatus() : null;
        const positions = status?.state?.positions || {};
        const baselines = status?.state?.priceBaselines || {};

        // Get mainnet balances
        let balances = {};
        try {
            balances = await walletService.getMainnetBalances();
        } catch { /* proceed with empty */ }

        // Native tokens from wallet balances
        const nativeTokens = {
            eth: { symbol: 'ETH', name: 'Ethereum', network: 'ethereum' },
            bsc: { symbol: 'BNB', name: 'BNB', network: 'bsc' },
            polygon: { symbol: 'MATIC', name: 'Polygon', network: 'polygon' },
            nano: { symbol: 'XNO', name: 'Nano', network: 'nano' }
        };

        for (const [chain, info] of Object.entries(nativeTokens)) {
            const bal = balances[chain];
            const rawBal = parseFloat(bal?.balance || bal || 0);
            if (rawBal <= 0 && !positions[info.network]) continue;

            // Get price from baselines or positions
            let price = 0;
            let change24h = 0;
            const baselineKey = `${info.symbol}/USD`;
            if (baselines[baselineKey]?.price) {
                price = baselines[baselineKey].price;
            } else if (positions[info.network]?.entryPrice) {
                price = positions[info.network].entryPrice;
            }

            // Try to get 24h change from position data
            const pos = positions[info.network];
            if (pos?.entryPrice && price > 0) {
                change24h = ((price - pos.entryPrice) / pos.entryPrice) * 100;
            }

            const value = rawBal * price;
            tokens.push({
                symbol: info.symbol,
                name: info.name,
                balance: rawBal,
                price,
                value: Math.round(value * 100) / 100,
                change24h: Math.round(change24h * 100) / 100,
                volatility: Math.abs(change24h) / 10 || 0.2,
                network: info.network,
                type: 'native'
            });
        }

        // Stablecoin positions
        for (const [network, pos] of Object.entries(positions)) {
            if (pos?.stablecoinAmount > 0) {
                const stableName = network === 'ethereum' ? 'USDC' : 'USDT';
                tokens.push({
                    symbol: stableName,
                    name: `${stableName} (${network})`,
                    balance: pos.stablecoinAmount,
                    price: 1,
                    value: Math.round(pos.stablecoinAmount * 100) / 100,
                    change24h: 0,
                    volatility: 0.01,
                    network,
                    type: 'stablecoin'
                });
            }
        }

        // Token trader positions
        if (handler) {
            try {
                const strategyState = handler.getState();
                const tokenTraders = strategyState?.strategyRegistry?.tokenTraders;
                if (tokenTraders) {
                    for (const [address, trader] of Object.entries(tokenTraders)) {
                        const cfg = trader.config || {};
                        const st = trader.state || {};
                        if (st.tokenBalance > 0 && cfg.tokenSymbol) {
                            const tokenPrice = st.lastPrice || cfg.entryPrice || 0;
                            const entryPrice = cfg.entryPrice || tokenPrice;
                            const pctChange = entryPrice > 0 ? ((tokenPrice - entryPrice) / entryPrice) * 100 : 0;
                            tokens.push({
                                symbol: cfg.tokenSymbol,
                                name: cfg.tokenSymbol,
                                balance: st.tokenBalance,
                                price: tokenPrice,
                                value: Math.round(st.tokenBalance * tokenPrice * 100) / 100,
                                change24h: Math.round(pctChange * 100) / 100,
                                volatility: Math.abs(pctChange) / 10 || 0.3,
                                network: cfg.network || 'bsc',
                                type: 'token',
                                address
                            });
                        }
                    }
                }
            } catch { /* token traders not available */ }
        }

        res.json({ success: true, tokens });
    } catch (error) {
        logger.error('Failed to get portfolio:', error);
        res.status(500).json({ success: false, error: error.message, tokens: [] });
    }
});

// Initialize wallet (kept for compatibility but auto-initializes anyway)
router.post('/initialize', async (req, res) => {
    try {
        // Wallet auto-initializes, so just get the info
        const walletInfo = await walletService.getWalletInfo();
        
        logger.info('Wallet initialization requested');
        res.json({ 
            success: true,
            ...walletInfo 
        });
    } catch (error) {
        logger.error('Failed to initialize wallet:', error);
        res.status(500).json({ 
            error: error.message || 'Failed to initialize wallet',
            success: false 
        });
    }
});

// Set network mode (testnet/mainnet)
router.post('/network-mode', async (req, res) => {
    try {
        const { mode } = req.body;
        if (!mode || !['testnet', 'mainnet'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode. Use "testnet" or "mainnet"' });
        }

        // Set the network mode in walletService
        walletService.setNetworkMode(mode);

        // Update crypto SubAgent via handler
        const handler = await getCryptoHandler();
        if (handler) {
            await handler.setNetworkMode(mode);
        } else {
            // Fallback: update SubAgent directly if handler not available
            await SubAgent.updateOne(
                { domain: 'crypto' },
                { $set: { 'config.domainConfig.networkMode': mode } }
            );
        }

        // Invalidate cache to force fresh balance fetch
        cache.del('wallet:status');

        logger.info(`Network mode set to: ${mode} (walletService, SubAgent)`);
        res.json({
            success: true,
            mode,
            message: `Switched to ${mode} mode`
        });
    } catch (error) {
        logger.error('Failed to set network mode:', error);
        res.status(500).json({ error: 'Failed to set network mode' });
    }
});

// Get current network mode
router.get('/network-mode', async (req, res) => {
    try {
        const mode = walletService.getNetworkMode();
        res.json({ success: true, mode });
    } catch (error) {
        logger.error('Failed to get network mode:', error);
        res.status(500).json({ error: 'Failed to get network mode' });
    }
});

// Get mainnet balances (bypasses network mode - for verification before switching)
router.get('/mainnet-balances', async (req, res) => {
    try {
        if (!walletService.isInitialized()) {
            return res.status(400).json({ error: 'Wallet not initialized' });
        }

        const balances = await walletService.getMainnetBalances();

        logger.info('Mainnet balances fetched for verification');
        res.json({
            success: true,
            note: 'These are MAINNET balances, fetched directly regardless of current network mode',
            currentNetworkMode: walletService.getNetworkMode(),
            balances
        });
    } catch (error) {
        logger.error('Failed to get mainnet balances:', error);
        res.status(500).json({ error: 'Failed to get mainnet balances' });
    }
});

// Refresh balances
router.post('/refresh-balances', async (req, res) => {
    try {
        if (!walletService.isInitialized()) {
            return res.status(400).json({ error: 'Wallet not initialized' });
        }

        const balances = await walletService.getBalances();

        // Invalidate cache when balances are refreshed
        try {
            cache.del('wallet:status');
            logger.debug('Cache invalidated after balance refresh');
        } catch (error) {
            logger.error('Failed to invalidate cache:', error);
        }

        logger.info('Balances refreshed');
        res.json({
            success: true,
            balances
        });
    } catch (error) {
        logger.error('Failed to refresh balances:', error);
        res.status(500).json({
            error: 'Failed to refresh balances',
            success: false
        });
    }
});

// Get transactions
router.get('/transactions', async (req, res) => {
    try {
        const cacheKey = 'wallet:transactions';
        const cachedData = getCachedData(cacheKey);
        
        if (cachedData) {
            return res.json(cachedData);
        }
        
        const transactions = await walletService.getTransactions();
        setCachedData(cacheKey, transactions);
        res.json(transactions);
    } catch (error) {
        logger.error('Failed to get transactions:', error);
        res.status(500).json({ error: 'Failed to get transactions' });
    }
});

// Get wallet interaction graph data for visualization
router.get('/interactions', async (req, res) => {
    try {
        const cacheKey = 'wallet:interactions';
        const cachedData = getCachedData(cacheKey);
        if (cachedData) return res.json(cachedData);

        if (!walletService.isInitialized()) {
            return res.json({ success: true, wallet: null, interactions: [] });
        }

        const addresses = walletService.getAddresses();
        const bscAddr = addresses.find(a => a.chain === 'bsc')?.address;
        const ethAddr = addresses.find(a => a.chain === 'eth')?.address;
        const walletAddr = bscAddr || ethAddr;
        if (!walletAddr) return res.json({ success: true, wallet: null, interactions: [] });

        // Get ENS name — check subnames first, then registered names
        let ensName = null;
        try {
            const { SystemSettings } = await import('../models/SystemSettings.js');
            // Check ens.mySubname first
            const mySub = await SystemSettings.findOne({ key: 'ens.mySubname' });
            if (mySub) {
                ensName = mySub.value;
            } else {
                // Check ens.subnames for agent's own subname
                const subnames = await SystemSettings.findOne({ key: 'ens.subnames' });
                if (subnames?.value) {
                    const entries = Object.values(subnames.value);
                    const own = entries.find(e => e.owner?.toLowerCase() === walletAddr.toLowerCase());
                    if (own) ensName = own.fullName;
                }
                // Fallback to registered base name
                if (!ensName) {
                    const baseName = await SystemSettings.findOne({ key: { $regex: /^ens\.registered\./ } });
                    if (baseName?.value?.name) ensName = baseName.value.name;
                }
            }
        } catch {}

        // Fetch on-chain transactions from BSCScan (V2 API via tokenScanner key)
        const interactions = new Map(); // address -> { txCount, totalValue, lastSeen, isContract, types }

        if (bscAddr) {
            // Get API key: try tokenScanner first, then load from DB directly
            let apiKey = tokenScanner.getExplorerApiKey('bsc') || process.env.BSCSCAN_API_KEY || '';
            if (!apiKey) {
                try {
                    const { PluginSettings } = await import('../models/PluginSettings.js');
                    const { decrypt } = await import('../utils/encryption.js');
                    const stored = await PluginSettings.getCached('crypto', 'explorer_api_keys');
                    if (stored?.bsc) apiKey = decrypt(stored.bsc);
                } catch (e) {
                    logger.debug('Failed to load explorer API key from DB:', e.message);
                }
            }
            // BSCScan V2 API (requires paid plan for BSC chain — may fail on free tier)
            const baseUrl = 'https://api.etherscan.io/v2/api';
            const chainParam = '&chainid=56';
            const keyParam = apiKey ? `&apikey=${apiKey}` : '';

            // Normal transactions
            try {
                const url = `${baseUrl}?module=account&action=txlist&address=${bscAddr}&startblock=0&endblock=99999999&sort=desc&page=1&offset=200${chainParam}${keyParam}`;
                const resp = await fetch(url);
                const data = await resp.json();
                if (data.status === '1' && Array.isArray(data.result)) {
                    for (const tx of data.result) {
                        if (tx.isError === '1') continue;
                        const counterparty = tx.from.toLowerCase() === bscAddr.toLowerCase() ? tx.to : tx.from;
                        if (!counterparty) continue;
                        const cp = counterparty.toLowerCase();
                        if (!interactions.has(cp)) {
                            interactions.set(cp, { address: counterparty, txCount: 0, totalValueWei: BigInt(0), totalValueUsd: 0, lastSeen: 0, isContract: false, types: new Set(), networks: new Set() });
                        }
                        const entry = interactions.get(cp);
                        entry.txCount++;
                        entry.totalValueWei += BigInt(tx.value || '0');
                        entry.lastSeen = Math.max(entry.lastSeen, parseInt(tx.timeStamp) * 1000);
                        entry.types.add(tx.from.toLowerCase() === bscAddr.toLowerCase() ? 'sent' : 'received');
                        entry.networks.add('bsc');
                        if (tx.to && tx.input && tx.input !== '0x' && tx.to.toLowerCase() === cp) {
                            entry.isContract = true;
                        }
                    }
                } else {
                    logger.warn(`BSCScan txlist failed: ${data.message} — ${typeof data.result === 'string' ? data.result : JSON.stringify(data.result).slice(0, 200)}`);
                }
            } catch (e) {
                logger.warn('BSCScan fetch failed:', e.message);
            }

            // Internal transactions (contract calls)
            try {
                const url = `${baseUrl}?module=account&action=txlistinternal&address=${bscAddr}&startblock=0&endblock=99999999&sort=desc&page=1&offset=100${chainParam}${keyParam}`;
                const resp = await fetch(url);
                const data = await resp.json();
                if (data.status === '1' && Array.isArray(data.result)) {
                    for (const tx of data.result) {
                        if (tx.isError === '1') continue;
                        const counterparty = tx.from.toLowerCase() === bscAddr.toLowerCase() ? tx.to : tx.from;
                        if (!counterparty) continue;
                        const cp = counterparty.toLowerCase();
                        if (!interactions.has(cp)) {
                            interactions.set(cp, { address: counterparty, txCount: 0, totalValueWei: BigInt(0), totalValueUsd: 0, lastSeen: 0, isContract: true, types: new Set(), networks: new Set() });
                        }
                        const entry = interactions.get(cp);
                        entry.txCount++;
                        entry.totalValueWei += BigInt(tx.value || '0');
                        entry.lastSeen = Math.max(entry.lastSeen, parseInt(tx.timeStamp) * 1000);
                        entry.isContract = true;
                        entry.networks.add('bsc');
                    }
                }
            } catch {}
        }

        // Pull local wallet transactions (swaps have tokenIn/tokenOut instead of to)
        try {
            const localTx = await walletService.getTransactions();
            for (const tx of localTx) {
                // For swap transactions, use token contract addresses as counterparties
                const counterparties = [];
                if (tx.to && tx.to.toLowerCase() !== walletAddr.toLowerCase()) {
                    counterparties.push({ addr: tx.to, isContract: ['swap', 'contract_write', 'approval'].includes(tx.type) });
                }
                if (tx.tokenIn && tx.tokenIn.toLowerCase() !== walletAddr.toLowerCase()) {
                    counterparties.push({ addr: tx.tokenIn, isContract: true });
                }
                if (tx.tokenOut && tx.tokenOut.toLowerCase() !== walletAddr.toLowerCase()) {
                    counterparties.push({ addr: tx.tokenOut, isContract: true });
                }
                for (const { addr: cpAddr, isContract } of counterparties) {
                    if (!cpAddr || !cpAddr.startsWith('0x') || cpAddr.length < 42) continue; // skip invalid addresses like "NATIVE"
                    const cp = cpAddr.toLowerCase();
                    if (!interactions.has(cp)) {
                        interactions.set(cp, { address: cpAddr, txCount: 0, totalValueWei: BigInt(0), totalValueUsd: 0, lastSeen: 0, isContract, types: new Set(), networks: new Set() });
                    }
                    const entry = interactions.get(cp);
                    entry.txCount++;
                    entry.lastSeen = Math.max(entry.lastSeen, new Date(tx.timestamp).getTime() || 0);
                    entry.types.add(tx.type || 'unknown');
                    entry.networks.add(tx.chain || 'bsc');
                    if (isContract) entry.isContract = true;
                    // Add USD value from amountIn if available (USDT swaps)
                    if (tx.amountIn && tx.tokenIn?.toLowerCase() === '0x55d398326f99059ff775485246999027b3197955') {
                        entry.totalValueUsd = (entry.totalValueUsd || 0) + parseFloat(tx.amountIn);
                    }
                }
            }
            logger.info(`Wallet interactions: ${localTx.length} local txs processed, ${interactions.size} unique counterparties`);
        } catch (e) {
            logger.debug('Local tx processing error:', e.message);
        }

        // Check scammer registry for all addresses
        let scammerAddresses = new Set();
        try {
            const { default: scammerRegistryService } = await import('../services/crypto/scammerRegistryService.js');
            if (scammerRegistryService.isAvailable()) {
                const list = await scammerRegistryService.listScammers(1000);
                if (list && list.length) {
                    scammerAddresses = new Set(list.map(s => (s.address || s).toLowerCase()));
                }
            }
        } catch {}

        // Convert to array with USD values
        const bnbPrice = 600; // rough estimate, could fetch live
        const result = [];
        for (const [addr, entry] of interactions) {
            if (addr === walletAddr.toLowerCase()) continue; // skip self
            const valueEth = Number(entry.totalValueWei) / 1e18;
            const usdFromBnb = valueEth * bnbPrice;
            result.push({
                address: entry.address,
                txCount: entry.txCount,
                totalValueBnb: valueEth,
                totalValueUsd: (entry.totalValueUsd || 0) + usdFromBnb,
                lastSeen: entry.lastSeen,
                isContract: entry.isContract,
                isScammer: scammerAddresses.has(addr),
                types: Array.from(entry.types),
                networks: Array.from(entry.networks)
            });
        }

        // Sort by txCount descending
        result.sort((a, b) => b.txCount - a.txCount);

        const response = { success: true, wallet: { address: walletAddr, ensName }, interactions: result.slice(0, 100) };
        setCachedData(cacheKey, response); // uses default 5 min cache
        res.json(response);
    } catch (error) {
        logger.error('Failed to get wallet interactions:', error);
        res.status(500).json({ success: false, error: 'Failed to get interactions' });
    }
});

// Send transaction (placeholder for now)
router.post('/send', async (req, res) => {
    try {
        const { chain, toAddress, amount, token } = req.body;

        if (!chain || !toAddress || !amount) {
            return res.status(400).json({ error: 'Missing required fields: chain, toAddress, amount' });
        }

        const network = chain.toLowerCase() === 'bnb' ? 'bsc' : chain.toLowerCase();
        logger.info(`Send request: ${amount} ${token || 'native'} on ${network} to ${toAddress}`);

        const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
        const signer = await contractService.getSigner(network);
        const { ethers } = await import('ethers');

        let txHash, receipt;

        if (token && token !== 'native') {
            // ERC-20 token transfer
            const tokenContract = new ethers.Contract(token, [
                'function transfer(address to, uint256 amount) returns (bool)',
                'function decimals() view returns (uint8)'
            ], signer);
            let decimals = 18;
            try { decimals = await tokenContract.decimals(); } catch {}
            const amountWei = ethers.parseUnits(String(amount), decimals);
            const tx = await tokenContract.transfer(toAddress, amountWei);
            receipt = await tx.wait();
            txHash = receipt.hash;
            logger.info(`Token sent: ${amount} to ${toAddress} tx=${txHash}`);
        } else {
            // Native transfer (ETH/BNB/MATIC)
            const tx = await signer.sendTransaction({
                to: toAddress,
                value: ethers.parseEther(String(amount))
            });
            receipt = await tx.wait();
            txHash = receipt.hash;
            logger.info(`Native sent: ${amount} ${chain} to ${toAddress} tx=${txHash}`);
        }

        // Record transaction
        try {
            await walletService.addTransaction({
                chain: network,
                type: 'sent',
                hash: txHash,
                to: toAddress,
                amount,
                token: token || 'native',
                status: 'confirmed'
            });
            cache.del('wallet:transactions');
        } catch {}

        res.json({
            success: true,
            hash: txHash,
            block: receipt.blockNumber,
            gasUsed: receipt.gasUsed?.toString()
        });
    } catch (error) {
        logger.error('Failed to send transaction:', error);
        res.status(500).json({ 
            error: 'Failed to send transaction',
            success: false 
        });
    }
});

// Get SIWE message
router.get('/siwe-message', async (req, res) => {
    try {
        const addresses = walletService.getAddresses();
        const ethAddress = addresses.find(a => a.chain === 'eth')?.address;
        
        if (!ethAddress) {
            return res.status(400).json({ error: 'No Ethereum address found' });
        }
        
        const message = `LANAgent wants you to sign in with your Ethereum account:
${ethAddress}

Sign this message to authenticate with LANAgent.

URI: http://localhost
Version: 1
Chain ID: 1
Nonce: ${Math.random().toString(36).substring(2)}
Issued At: ${new Date().toISOString()}`;
        
        res.json({ message });
    } catch (error) {
        logger.error('Failed to generate SIWE message:', error);
        res.status(500).json({ error: 'Failed to generate SIWE message' });
    }
});

// Sign message
router.post('/sign-message', async (req, res) => {
    try {
        const { message, chain = 'eth' } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        const signature = await walletService.signMessage(message, chain);
        
        res.json({ signature });
    } catch (error) {
        logger.error('Failed to sign message:', error);
        res.status(500).json({ error: 'Failed to sign message' });
    }
});

// Export encrypted seed
router.get('/export-seed', async (req, res) => {
    try {
        const encryptedSeed = await walletService.exportEncryptedSeed();

        logger.info('Encrypted seed exported');
        res.json({
            success: true,
            encryptedSeed
        });
    } catch (error) {
        logger.error('Failed to export seed:', error);
        res.status(500).json({
            error: 'Failed to export seed',
            success: false
        });
    }
});

// ============ SWAP ENDPOINTS ============

// Get swap quote
router.post('/swap/quote', async (req, res) => {
    try {
        const swapService = (await import('../services/crypto/swapService.js')).default;
        const { tokenIn, tokenOut, amountIn, network, routerType } = req.body;

        if (!tokenIn || !tokenOut || !amountIn || !network) {
            return res.status(400).json({ error: 'Missing required fields: tokenIn, tokenOut, amountIn, network' });
        }

        const quote = await swapService.getQuote(tokenIn, tokenOut, amountIn, network, routerType);
        res.json({ success: true, quote });
    } catch (error) {
        logger.error('Failed to get swap quote:', error);
        res.status(500).json({ error: error.message });
    }
});

// Execute swap
router.post('/swap/execute', async (req, res) => {
    try {
        const swapService = (await import('../services/crypto/swapService.js')).default;
        const { tokenIn, tokenOut, amountIn, slippageTolerance, network } = req.body;

        if (!tokenIn || !tokenOut || !amountIn || !network) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const result = await swapService.swap(tokenIn, tokenOut, amountIn, slippageTolerance || 0.5, network);
        res.json(result);
    } catch (error) {
        logger.error('Failed to execute swap:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Unwrap WETH/WBNB to native ETH/BNB
router.post('/swap/unwrap', async (req, res) => {
    try {
        const swapService = (await import('../services/crypto/swapService.js')).default;
        const contractServiceWrapper = (await import('../services/crypto/contractServiceWrapper.js')).default;
        const ethers = (await import('ethers'));
        const { amount, network } = req.body;

        if (!amount || !network) {
            return res.status(400).json({ error: 'Missing required fields: amount, network' });
        }

        const wrappedNative = swapService.getWrappedNative(network);
        if (!wrappedNative) {
            return res.status(400).json({ error: `No wrapped native token for ${network}` });
        }

        const signer = await contractServiceWrapper.getSigner(network);
        const WETH_ABI = ['function withdraw(uint256 wad)', 'function balanceOf(address) view returns (uint256)'];
        const wethContract = new ethers.Contract(wrappedNative, WETH_ABI, signer);

        const amountWei = ethers.parseEther(amount.toString());
        const balance = await wethContract.balanceOf(signer.address);

        if (balance < amountWei) {
            return res.status(400).json({
                error: `Insufficient wrapped balance. Have ${ethers.formatEther(balance)}, need ${amount}`,
                balance: ethers.formatEther(balance)
            });
        }

        const tx = await wethContract.withdraw(amountWei);
        const receipt = await tx.wait();

        res.json({
            success: true,
            hash: receipt.hash,
            amount,
            network,
            token: wrappedNative,
            message: `Unwrapped ${amount} to native on ${network}`
        });
    } catch (error) {
        logger.error('Failed to unwrap:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get supported swap networks
router.get('/swap/networks', async (req, res) => {
    try {
        const swapService = (await import('../services/crypto/swapService.js')).default;
        const networks = swapService.getSupportedNetworks();
        res.json({ success: true, networks });
    } catch (error) {
        logger.error('Failed to get swap networks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get pending swaps
router.get('/swap/pending', async (req, res) => {
    try {
        const swapService = (await import('../services/crypto/swapService.js')).default;
        const pending = swapService.getPendingSwaps();
        res.json({ success: true, pending });
    } catch (error) {
        logger.error('Failed to get pending swaps:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ NETWORK SETTINGS ============

// Get disabled networks
router.get('/settings/disabled-networks', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const disabledNetworks = await SystemSettings.getSetting('crypto.disabledNetworks', []);
        res.json({ success: true, disabledNetworks });
    } catch (error) {
        logger.error('Failed to get disabled networks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Set disabled networks
router.post('/settings/disabled-networks', async (req, res) => {
    try {
        const { disabledNetworks } = req.body;
        if (!Array.isArray(disabledNetworks)) {
            return res.status(400).json({ error: 'disabledNetworks must be an array' });
        }
        const validNetworks = ['ethereum', 'bsc', 'polygon', 'base'];
        const filtered = disabledNetworks.filter(n => validNetworks.includes(n));
        const { SystemSettings } = await import('../models/SystemSettings.js');
        await SystemSettings.setSetting('crypto.disabledNetworks', filtered, 'Networks disabled for dollar maximizer trading', 'crypto');
        logger.info(`Disabled networks updated: ${filtered.length > 0 ? filtered.join(', ') : 'none (all enabled)'}`);
        res.json({ success: true, disabledNetworks: filtered });
    } catch (error) {
        logger.error('Failed to set disabled networks:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ SCAM AUTO-REPORT SETTINGS ============

// Get scam auto-report setting
router.get('/settings/auto-report-scams', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const enabled = await SystemSettings.getSetting('crypto.autoReportScams', true);
        res.json({ success: true, enabled });
    } catch (error) {
        logger.error('Failed to get auto-report setting:', error);
        res.status(500).json({ error: error.message });
    }
});

// Set scam auto-report setting
router.post('/settings/auto-report-scams', async (req, res) => {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean' });
        }
        const { SystemSettings } = await import('../models/SystemSettings.js');
        await SystemSettings.setSetting('crypto.autoReportScams', enabled, 'Auto-report confirmed scam tokens to on-chain scammer registry', 'crypto');
        logger.info(`Scam auto-report ${enabled ? 'enabled' : 'disabled'}`);
        res.json({ success: true, enabled });
    } catch (error) {
        logger.error('Failed to set auto-report setting:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ STRATEGY ENDPOINTS ============

// Main agent reference (set by agent.js)
let mainAgent = null;

export function setCryptoAgent(agent) {
    mainAgent = agent;
}

/**
 * Get the CryptoStrategyAgent handler from SubAgent orchestrator
 */
async function getCryptoHandler() {
    if (!mainAgent?.subAgentOrchestrator) {
        return null;
    }

    // Find the crypto strategy agent
    const agents = await SubAgent.find({ domain: 'crypto', type: 'domain' });
    if (!agents || agents.length === 0) {
        return null;
    }

    const agentId = agents[0]._id.toString();
    return mainAgent.subAgentOrchestrator.agentHandlers.get(agentId);
}

// Get strategy status
router.get('/strategy/status', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const status = handler.getStatus();
        // Map isActive to 'running' for API consumers (isRunning = mid-cycle, isActive = responding to heartbeats)
        res.json({ success: true, ...status, running: status.isActive ?? status.isRunning });
    } catch (error) {
        logger.error('Failed to get strategy status:', error);
        res.status(500).json({ error: error.message });
    }
});

// Enable strategy agent
router.post('/strategy/enable', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const result = await handler.enable();
        res.json(result);
    } catch (error) {
        logger.error('Failed to enable strategy:', error);
        res.status(500).json({ error: error.message });
    }
});

// Disable strategy agent
router.post('/strategy/disable', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const result = await handler.disable();
        res.json(result);
    } catch (error) {
        logger.error('Failed to disable strategy:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get strategy configuration
router.get('/strategy/config', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const config = handler.getConfig();
        res.json({ success: true, config });
    } catch (error) {
        logger.error('Failed to get strategy config:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update strategy configuration
router.post('/strategy/config', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const result = await handler.updateConfig(req.body);
        res.json(result);
    } catch (error) {
        logger.error('Failed to update strategy config:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get stablecoin balances
router.get('/stablecoin-balances', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const balances = await handler.getStablecoinBalances();
        res.json({ success: true, balances });
    } catch (error) {
        logger.error('Failed to get stablecoin balances:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get balance of a specific token
router.get('/token-balance', async (req, res) => {
    try {
        const { token, network } = req.query;
        if (!token || !network) {
            return res.status(400).json({ error: 'token and network query params required' });
        }
        const { default: contractServiceWrapper } = await import('../services/crypto/contractServiceWrapper.js');
        const { default: walletService } = await import('../services/crypto/walletService.js');
        const addrs = walletService.getAddresses?.() || [];
        const ethEntry = addrs.find(a => a.chain === 'eth');
        if (!ethEntry?.address) {
            return res.json({ success: false, error: 'Wallet not initialized' });
        }
        const result = await contractServiceWrapper.getTokenBalance(token, ethEntry.address, network);
        res.json({ success: true, balance: result?.formatted || '0', raw: result?.raw || '0', decimals: result?.decimals || 18, token, network });
    } catch (error) {
        logger.error('Failed to get token balance:', error);
        res.status(500).json({ error: error.message });
    }
});

// Trigger manual strategy run
router.post('/strategy/trigger', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const result = await handler.triggerRun();
        res.json(result);
    } catch (error) {
        logger.error('Failed to trigger strategy:', error);
        res.status(500).json({ error: error.message });
    }
});

// Set network mode (testnet/mainnet)
router.post('/strategy/network-mode', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const { mode } = req.body;
        if (!mode) {
            return res.status(400).json({ error: 'Missing mode parameter' });
        }
        const result = await handler.setNetworkMode(mode);
        res.json(result);
    } catch (error) {
        logger.error('Failed to set network mode:', error);
        res.status(500).json({ error: error.message });
    }
});

// Emergency stop
router.post('/strategy/emergency-stop', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const result = await handler.emergencyStop();
        res.json(result);
    } catch (error) {
        logger.error('Failed to emergency stop:', error);
        res.status(500).json({ error: error.message });
    }
});

// Clear emergency stop
router.post('/strategy/clear-emergency', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const result = await handler.clearEmergencyStop();
        res.json(result);
    } catch (error) {
        logger.error('Failed to clear emergency:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get decision journal
router.get('/strategy/journal', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const limit = parseInt(req.query.limit) || 20;
        const journal = handler.getJournal(limit);
        res.json({ success: true, entries: journal });
    } catch (error) {
        logger.error('Failed to get journal:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update position state for a network
router.post('/strategy/position', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const { network, inStablecoin, entryPrice, stablecoinAmount } = req.body;
        if (!network) {
            return res.status(400).json({ error: 'Missing network parameter' });
        }
        const result = await handler.updatePosition(network, {
            inStablecoin,
            entryPrice,
            stablecoinAmount
        });
        res.json(result);
    } catch (error) {
        logger.error('Failed to update position:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all positions
router.get('/strategy/positions', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const positions = handler.getPositions();
        res.json({ success: true, positions });
    } catch (error) {
        logger.error('Failed to get positions:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== STRATEGY MANAGEMENT ENDPOINTS ====================

// List all available strategies
router.get('/strategy/list', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const strategies = handler.listStrategies();
        res.json({ success: true, strategies });
    } catch (error) {
        logger.error('Failed to list strategies:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get active strategy
router.get('/strategy/active', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const strategy = handler.getActiveStrategy();
        res.json({ success: true, strategy });
    } catch (error) {
        logger.error('Failed to get active strategy:', error);
        res.status(500).json({ error: error.message });
    }
});

// Switch to a different strategy
router.post('/strategy/switch', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const { strategy } = req.body;
        if (!strategy) {
            return res.status(400).json({ error: 'Missing strategy name' });
        }
        const result = await handler.switchStrategy(strategy);
        res.json(result);
    } catch (error) {
        logger.error('Failed to switch strategy:', error);
        res.status(500).json({ error: error.message });
    }
});

// Seed price history from CoinGecko for volatility-based strategies
router.post('/strategy/seed-history', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const { strategy } = req.body;
        const result = await handler.seedPriceHistory(strategy || 'volatility_adjusted');
        res.json(result);
    } catch (error) {
        logger.error('Failed to seed price history:', error);
        res.status(500).json({ error: error.message });
    }
});

// Dynamically adjust config parameters based on current market volatility
router.post('/strategy/adjust-volatility', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const result = await handler.adjustConfigForVolatility();
        res.json(result);
    } catch (error) {
        logger.error('Failed to adjust config for volatility:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get specific strategy info
router.get('/strategy/info/:name', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const info = handler.getStrategyInfo(req.params.name);
        res.json({ success: true, strategy: info });
    } catch (error) {
        logger.error('Failed to get strategy info:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update specific strategy config
router.post('/strategy/config/:name', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const result = await handler.updateStrategyConfig(req.params.name, req.body);
        res.json(result);
    } catch (error) {
        logger.error('Failed to update strategy config:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get performance comparison across all strategies
router.get('/strategy/performance', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const performance = handler.getStrategyPerformance();
        res.json({ success: true, performance });
    } catch (error) {
        logger.error('Failed to get strategy performance:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== SCHEDULING ENDPOINTS ====================

// Set schedule interval
router.post('/strategy/schedule', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const { intervalMinutes } = req.body;
        if (!intervalMinutes || intervalMinutes < 1) {
            return res.status(400).json({ error: 'Invalid intervalMinutes (minimum: 1)' });
        }
        const result = await handler.setScheduleInterval(intervalMinutes);
        res.json(result);
    } catch (error) {
        logger.error('Failed to set schedule interval:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get schedule info
router.get('/strategy/schedule', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }
        const info = handler.getScheduleInfo();
        res.json({ success: true, ...info });
    } catch (error) {
        logger.error('Failed to get schedule info:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== STRATEGY EVOLUTION ENDPOINTS ====================

// Analyze strategy performance and get recommendations
router.get('/strategy/evolution/analyze', async (req, res) => {
    try {
        const { strategyEvolution } = await import('../services/crypto/strategyEvolution.js');
        const analysis = await strategyEvolution.analyzePerformance();
        res.json({ success: true, analysis });
    } catch (error) {
        logger.error('Failed to analyze strategy performance:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get evolution service status
router.get('/strategy/evolution/status', async (req, res) => {
    try {
        const { strategyEvolution } = await import('../services/crypto/strategyEvolution.js');
        const status = strategyEvolution.getStatus();
        res.json({ success: true, status });
    } catch (error) {
        logger.error('Failed to get evolution status:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get detailed evolution report
router.get('/strategy/evolution/report', async (req, res) => {
    try {
        const { strategyEvolution } = await import('../services/crypto/strategyEvolution.js');
        const report = strategyEvolution.getDetailedReport();
        res.json({ success: true, report });
    } catch (error) {
        logger.error('Failed to get evolution report:', error);
        res.status(500).json({ error: error.message });
    }
});

// Apply a recommended improvement
router.post('/strategy/evolution/apply', async (req, res) => {
    try {
        const { recommendation } = req.body;
        if (!recommendation) {
            return res.status(400).json({ error: 'Missing recommendation object' });
        }

        const { strategyEvolution } = await import('../services/crypto/strategyEvolution.js');
        const result = await strategyEvolution.applyImprovement(recommendation);

        // Save config after applying improvement (via SubAgent)
        const handler = await getCryptoHandler();
        if (handler) {
            await handler.agentDoc.save();
        }

        res.json({ success: true, improvement: result });
    } catch (error) {
        logger.error('Failed to apply improvement:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create feature request from recommendation (integrates with self-mod)
router.post('/strategy/evolution/feature-request', async (req, res) => {
    try {
        const { recommendation } = req.body;
        if (!recommendation) {
            return res.status(400).json({ error: 'Missing recommendation object' });
        }

        const { strategyEvolution } = await import('../services/crypto/strategyEvolution.js');
        const featureRequest = await strategyEvolution.createFeatureRequest(recommendation);

        if (featureRequest) {
            res.json({ success: true, featureRequest });
        } else {
            res.status(500).json({ error: 'Failed to create feature request' });
        }
    } catch (error) {
        logger.error('Failed to create feature request:', error);
        res.status(500).json({ error: error.message });
    }
});

// Evaluate impact of applied improvements
router.get('/strategy/evolution/evaluate', async (req, res) => {
    try {
        const { strategyEvolution } = await import('../services/crypto/strategyEvolution.js');
        const evaluations = await strategyEvolution.evaluateImprovements();
        res.json({ success: true, evaluations });
    } catch (error) {
        logger.error('Failed to evaluate improvements:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== TOKEN TRADER ENDPOINTS ====================

// Configure token trader - validate token, get metadata, set as secondary, trigger auto-buy
router.post('/strategy/token-trader/configure', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }

        const { tokenAddress, tokenNetwork, capitalAllocationPercent, dumpThreshold, maxSlippage, tokenTaxPercent } = req.body;
        if (!tokenAddress || !tokenNetwork) {
            return res.status(400).json({ error: 'tokenAddress and tokenNetwork are required' });
        }

        // Validate network
        const validNetworks = ['ethereum', 'bsc', 'polygon', 'base'];
        if (!validNetworks.includes(tokenNetwork)) {
            return res.status(400).json({ error: `Invalid network. Must be one of: ${validNetworks.join(', ')}` });
        }

        // Get token metadata (name, symbol, decimals, tax)
        const metadata = await handler.getTokenMetadata(tokenAddress, tokenNetwork);
        if (metadata.symbol === '???' && metadata.name === 'Unknown') {
            return res.status(400).json({ error: 'Could not read token contract. Verify address and network.' });
        }

        // Safety check: warn about high-tax tokens (likely honeypots or scams)
        const effectiveTax = tokenTaxPercent !== undefined ? tokenTaxPercent : metadata.tax;
        if (effectiveTax > 25) {
            return res.status(400).json({
                error: `Token has ${effectiveTax.toFixed(1)}% detected tax (round-trip). Tokens with >25% tax are likely honeypots or scams. ` +
                       `If you're sure, manually set the tax field to a value <= 25 to override.`,
                detectedTax: effectiveTax,
                token: metadata,
                blocked: true
            });
        } else if (effectiveTax > 10) {
            // Allow but warn
            logger.warn(`TokenTrader WARNING: ${metadata.symbol} has ${effectiveTax.toFixed(1)}% detected tax. Proceed with caution.`);
        }

        // Get strategy registry and add/update token trader instance
        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');

        const instanceConfig = {
            tokenAddress,
            tokenNetwork,
            tokenSymbol: metadata.symbol,
            tokenDecimals: metadata.decimals,
            tokenTaxPercent: tokenTaxPercent !== undefined ? tokenTaxPercent : metadata.tax,
            capitalAllocationPercent: capitalAllocationPercent || 20,
            dumpThreshold,
            maxSlippage,
            userConfigured: true  // Prevents watchlist rotation — user explicitly added this token
        };

        // Add or update instance in multi-token map
        const tokenStrategy = strategyRegistry.addTokenTrader(tokenAddress, instanceConfig);

        // Set as secondary strategy (enables token_trader execution in heartbeat)
        strategyRegistry.setSecondary('token_trader');

        // Calculate total capital allocation across all token trader instances
        const allTraders = strategyRegistry.getAllTokenTraders();
        let totalSecAlloc = 0;
        for (const [, instance] of allTraders) {
            totalSecAlloc += instance.config.capitalAllocationPercent || 20;
        }
        await handler.updateConfig({
            capitalAllocation: { primary: 100 - totalSecAlloc, secondary: totalSecAlloc }
        });

        logger.info(`TokenTrader configured: ${metadata.symbol} (${tokenAddress}) on ${tokenNetwork} [${allTraders.size} active instance(s), total alloc: ${totalSecAlloc}%]`);

        // Persist registry state to DB immediately so the token survives restarts
        if (handler.persistRegistryState) {
            await handler.persistRegistryState();
        }

        // Start independent heartbeat for this token if manager is available.
        // If the manager was never started (registry was empty at agent init),
        // bring it up now — startAll() picks up the newly registered instance.
        if (handler.tokenHeartbeatManager) {
            if (!handler.tokenHeartbeatManager.started) {
                handler.tokenHeartbeatManager.startAll();
            } else {
                handler.tokenHeartbeatManager.startToken(tokenAddress);
            }
        }

        res.json({
            success: true,
            token: metadata,
            regime: tokenStrategy.state.regime,
            capitalAllocation: { primary: 100 - totalSecAlloc, secondary: totalSecAlloc },
            activeInstances: allTraders.size,
            message: `Token trader configured for ${metadata.symbol}. Will auto-buy on next strategy execution.`
        });
    } catch (error) {
        logger.error('Failed to configure token trader:', error);
        res.status(500).json({ error: error.message });
    }
});

// Detect token tax
router.post('/strategy/token-trader/detect-tax', async (req, res) => {
    try {
        const { tokenAddress, network } = req.body;
        if (!tokenAddress || !network) {
            return res.status(400).json({ error: 'tokenAddress and network are required' });
        }

        const swapService = (await import('../services/crypto/swapService.js')).default;
        const tax = await swapService.detectTokenTax(tokenAddress, network);

        // Also resolve symbol/decimals for watchlist add flow
        let symbol = null, decimals = 18;
        try {
            const metadata = await swapService.getTokenMetadata(tokenAddress, network);
            symbol = metadata.symbol;
            decimals = metadata.decimals;
        } catch (_) { /* non-critical */ }

        res.json({
            success: true,
            tokenAddress,
            network,
            symbol,
            decimals,
            estimatedTaxPercent: tax,
            isTaxToken: tax > 0.5,
            recommendation: tax > 10 ? 'High tax token - proceed with caution' :
                           tax > 0.5 ? 'Tax token detected - slippage will be adjusted automatically' :
                           'No significant tax detected'
        });
    } catch (error) {
        logger.error('Failed to detect token tax:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get token trader status - supports ?token=ADDRESS for specific instance, or returns all
router.get('/strategy/token-trader/status', async (req, res) => {
    try {
        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');
        const handler = await getCryptoHandler();
        const state = handler?.getState?.();
        const tokenFilter = req.query.token;

        const allTraders = strategyRegistry.getAllTokenTraders();
        const baseTrader = strategyRegistry.get('token_trader');
        const watchlist = baseTrader?.config?.tokenWatchlist || [];
        const isSecondary = strategyRegistry.getSecondary()?.name === 'token_trader';

        // Helper to build status for one instance
        const buildStatus = (instance, address) => {
            const ttStatus = instance.getTokenTraderStatus();
            const addrKey = address.toLowerCase();
            const instanceState = state?.tokenTraderStatus?.[addrKey] || {};
            return {
                ...ttStatus,
                currentPrice: instanceState.lastPrice || null,
                tokenSymbol: ttStatus.token?.symbol || null,
                tokenNetwork: ttStatus.token?.network || null,
                tokenBalance: ttStatus.position?.tokenBalance || 0,
                averageEntryPrice: ttStatus.position?.averageEntryPrice || 0,
                peakPrice: ttStatus.tracking?.peakPrice || 0,
                trailingStopPrice: ttStatus.tracking?.trailingStopPrice || 0,
                stablecoinReserve: ttStatus.position?.stablecoinReserve || 0,
                lastPrice: instanceState.lastPrice || null,
                lastPriceSource: instanceState.lastPriceSource || null,
                lastAnalysis: instanceState.lastAnalysis || null
            };
        };

        if (tokenFilter) {
            // Return specific instance
            const instance = strategyRegistry.getTokenTrader(tokenFilter);
            if (!instance) {
                return res.status(404).json({ error: `No token trader instance for ${tokenFilter}` });
            }
            return res.json({
                success: true,
                ...buildStatus(instance, tokenFilter),
                isSecondary,
                watchlist
            });
        }

        // Return all instances
        const instances = {};
        for (const [address, instance] of allTraders) {
            instances[address] = buildStatus(instance, address);
        }

        // Include heartbeat status if available
        const heartbeats = handler?.tokenHeartbeatManager?.getStatus() || null;

        res.json({
            success: true,
            activeInstances: allTraders.size,
            instances,
            isSecondary,
            watchlist,
            heartbeats
        });
    } catch (error) {
        logger.error('Failed to get token trader status:', error);
        res.status(500).json({ error: error.message });
    }
});

// Restore token trader state from cached agent state (for accidental resets)
router.post('/strategy/token-trader/restore-state', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }

        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');

        // Identify which instance: ?token= query param or tokenAddress in body
        const tokenAddr = req.query.token || req.body.tokenAddress;
        if (!tokenAddr) {
            return res.status(400).json({ error: 'Token address required: use ?token=ADDRESS query param or tokenAddress in body' });
        }

        const tokenStrategy = strategyRegistry.getTokenTrader(tokenAddr);
        if (!tokenStrategy) {
            return res.status(404).json({ error: `No token trader instance for ${tokenAddr}` });
        }

        const { position, pnl, tracking, regime } = req.body;

        if (!position || position.tokenBalance === undefined) {
            return res.status(400).json({ error: 'Position data required: tokenBalance, stablecoinReserve, averageEntryPrice, totalInvested, totalReceived' });
        }

        // Restore state
        tokenStrategy.state.tokenBalance = position.tokenBalance || 0;
        tokenStrategy.state.stablecoinReserve = position.stablecoinReserve || 0;
        tokenStrategy.state.averageEntryPrice = position.averageEntryPrice || 0;
        tokenStrategy.state.totalInvested = position.totalInvested || 0;
        tokenStrategy.state.totalReceived = position.totalReceived || 0;

        if (pnl) {
            tokenStrategy.state.realizedPnL = pnl.realized || 0;
            tokenStrategy.state.unrealizedPnL = pnl.unrealized || 0;
            if (pnl.lifetimeRealized !== undefined) {
                tokenStrategy.state.lifetimeRealizedPnL = pnl.lifetimeRealized;
            }
        }

        if (tracking) {
            tokenStrategy.state.peakPrice = tracking.peakPrice || 0;
            tokenStrategy.state.trailingStopPrice = tracking.trailingStopPrice || 0;
            tokenStrategy.state.scaleOutLevelsHit = tracking.scaleOutLevelsHit || [];
        }

        const { circuitBreaker } = req.body;
        if (circuitBreaker) {
            if (circuitBreaker.consecutiveStopLosses !== undefined) tokenStrategy.state.consecutiveStopLosses = circuitBreaker.consecutiveStopLosses;
            if (circuitBreaker.tripped !== undefined) {
                tokenStrategy.state.circuitBreakerTripped = circuitBreaker.tripped;
                tokenStrategy.state.circuitBreakerTrippedAt = circuitBreaker.tripped ? (tokenStrategy.state.circuitBreakerTrippedAt || new Date().toISOString()) : null;
            }
            if (circuitBreaker.lastDumpSell !== undefined) tokenStrategy.state.lastDumpSell = circuitBreaker.lastDumpSell;
            if (circuitBreaker.lastDumpSellPrice !== undefined) tokenStrategy.state.lastDumpSellPrice = circuitBreaker.lastDumpSellPrice;
        }

        if (regime) {
            tokenStrategy.state.regime = regime;
        } else if (position.tokenBalance > 0) {
            tokenStrategy.state.regime = 'SIDEWAYS';
        }

        logger.info(`TokenTrader state restored for ${tokenStrategy.config.tokenSymbol}: balance=${position.tokenBalance}, regime=${tokenStrategy.state.regime}`);

        // Persist registry so the restored cost basis / PnL / tracking survive a restart
        if (handler.persistRegistryState) {
            await handler.persistRegistryState();
        }

        res.json({
            success: true,
            message: `Token trader state restored for ${tokenStrategy.config.tokenSymbol}`,
            state: tokenStrategy.getTokenTraderStatus()
        });
    } catch (error) {
        logger.error('Failed to restore token trader state:', error);
        res.status(500).json({ error: error.message });
    }
});

// Exit token trader position - sell all tokens immediately
// ?token=ADDRESS exits specific instance; no param exits all
router.post('/strategy/token-trader/exit', async (req, res) => {
    try {
        const handler = await getCryptoHandler();
        if (!handler) {
            return res.status(503).json({ error: 'Crypto strategy agent not initialized' });
        }

        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');
        const tokenFilter = req.query.token || req.body.tokenAddress;
        const allTraders = strategyRegistry.getAllTokenTraders();

        if (allTraders.size === 0) {
            return res.status(400).json({ error: 'No token trader instances configured' });
        }

        // Build list of instances to exit
        const toExit = [];
        if (tokenFilter) {
            const instance = strategyRegistry.getTokenTrader(tokenFilter);
            if (!instance) {
                return res.status(404).json({ error: `No token trader instance for ${tokenFilter}` });
            }
            toExit.push({ address: tokenFilter.toLowerCase(), instance });
        } else {
            for (const [address, instance] of allTraders) {
                toExit.push({ address, instance });
            }
        }

        const results = [];
        const marketData = await handler.gatherMarketData();

        for (const { address, instance } of toExit) {
            const symbol = instance.config.tokenSymbol || address;
            if (!instance.isConfigured()) {
                results.push({ token: symbol, success: true, message: 'Not configured' });
                strategyRegistry.removeTokenTrader(address);
                continue;
            }
            if (instance.state.tokenBalance <= 0) {
                results.push({ token: symbol, success: true, message: 'No position to exit' });
                strategyRegistry.removeTokenTrader(address);
                continue;
            }

            // Trigger manual exit via the executor
            instance.state.pendingManualExit = true;
            try {
                const result = await handler.executeTokenTrader(
                    { strategy: 'token_trader', tokenAddress: address, confidence: 1.0, tradeParams: { direction: 'analyze' } },
                    marketData
                );
                results.push({ token: symbol, success: result.success, result });
            } catch (err) {
                results.push({ token: symbol, success: false, error: err.message });
            }

            // Stop heartbeat and remove instance after exit
            if (instance.state.tokenBalance <= 0) {
                if (handler.tokenHeartbeatManager) {
                    await handler.tokenHeartbeatManager.stopToken(address);
                }
                strategyRegistry.removeTokenTrader(address);
            }
        }

        // Clean up tokenTraderStatus in agent state for removed instances
        try {
            const agentState = handler.getState?.() || {};
            const ttStatus = agentState.tokenTraderStatus || {};
            const activeAddrs = new Set([...strategyRegistry.getAllTokenTraders().keys()]);
            const cleanedStatus = {};
            for (const [k, v] of Object.entries(ttStatus)) {
                if (k.startsWith('0x') && activeAddrs.has(k)) cleanedStatus[k] = v;
                else if (!k.startsWith('0x')) continue; // drop stale flat fields
            }
            await handler.updateState({ tokenTraderStatus: cleanedStatus });
        } catch (cleanErr) {
            logger.warn('Failed to clean up tokenTraderStatus:', cleanErr.message);
        }

        // If no instances remain, clear secondary strategy
        if (strategyRegistry.getAllTokenTraders().size === 0) {
            strategyRegistry.setSecondary(null);
        }

        // Persist registry state after exit so removed tokens don't reappear on restart
        if (handler.persistRegistryState) {
            await handler.persistRegistryState();
        }

        res.json({
            success: true,
            results,
            remainingInstances: strategyRegistry.getAllTokenTraders().size,
            message: `Exited ${results.length} token trader position(s)`
        });
    } catch (error) {
        logger.error('Failed to exit token trader position:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== TOKEN SCANNER ENDPOINTS ====================

// Helper: ensure token scanner has wallet address
async function ensureScannerInit() {
    if (!tokenScanner.walletAddress) {
        const wallet = await walletService.getWalletInfo();
        if (!wallet || !wallet.addresses?.length) throw new Error('Wallet not initialized');
        const address = wallet.addresses.find(a => a.chain === 'bsc' || a.chain === 'eth')?.address;
        if (!address) throw new Error('No EVM address found');
        await tokenScanner.initialize(address, { autoStart: true });
    }
}

// Initialize token scanner
router.post('/tokens/scanner/init', async (req, res) => {
    try {
        await ensureScannerInit();
        res.json({ success: true, address: tokenScanner.walletAddress, message: 'Token scanner initialized and started' });
    } catch (error) {
        logger.error('Failed to init token scanner:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start token scanning
router.post('/tokens/scanner/start', async (req, res) => {
    try {
        await ensureScannerInit();
        const { intervalMs } = req.body;
        tokenScanner.startScanning(intervalMs || 300000);
        res.json({ success: true, message: 'Token scanning started' });
    } catch (error) {
        logger.error('Failed to start scanning:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stop token scanning
router.post('/tokens/scanner/stop', async (req, res) => {
    try {
        tokenScanner.stopScanning();
        res.json({ success: true, message: 'Token scanning stopped' });
    } catch (error) {
        logger.error('Failed to stop scanning:', error);
        res.status(500).json({ error: error.message });
    }
});

// Trigger manual scan (auto-inits if needed)
router.post('/tokens/scan', async (req, res) => {
    try {
        await ensureScannerInit();
        const deep = req.body?.deep === true;
        let results;
        if (deep) {
            // Full deep scan — RPC deep scan + block explorer API fallback
            await tokenScanner.runDeepScanAll(['bsc', 'ethereum']);
            // Return whatever was found
            const detected = tokenScanner.getDetectedTokens();
            results = {
                newTokens: detected,
                safeTokens: detected.filter(t => t.isSafe),
                scamTokens: detected.filter(t => t.isScam)
            };
        } else {
            results = await tokenScanner.scanAllNetworks();
        }
        res.json({ success: true, deep, ...results });
    } catch (error) {
        logger.error('Failed to scan tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get scanner status
router.get('/tokens/scanner/status', async (req, res) => {
    try {
        const status = tokenScanner.getStatus();
        res.json({ success: true, ...status });
    } catch (error) {
        logger.error('Failed to get scanner status:', error);
        res.status(500).json({ error: error.message });
    }
});

// Set explorer API key (etherscan/bscscan) — stored encrypted in DB
router.post('/tokens/scanner/api-key', async (req, res) => {
    try {
        const { apiKey, networks } = req.body;
        if (!apiKey) {
            return res.status(400).json({ error: 'apiKey is required' });
        }
        const result = await tokenScanner.setExplorerApiKey(apiKey, networks);
        res.json({ success: true, message: 'Explorer API key stored (encrypted)', ...result });
    } catch (error) {
        logger.error('Failed to set explorer API key:', error);
        res.status(500).json({ error: error.message });
    }
});

// Set Moralis API key (encrypted, stored in DB)
router.post('/tokens/moralis/api-key', async (req, res) => {
    try {
        const { apiKey } = req.body;
        if (!apiKey) {
            return res.status(400).json({ error: 'apiKey is required' });
        }
        const result = await tokenScanner.setMoralisApiKey(apiKey);
        res.json({ success: true, message: 'Moralis API key stored (encrypted)', ...result });
    } catch (error) {
        logger.error('Failed to set Moralis API key:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get Moralis API key status
router.get('/tokens/moralis/status', async (req, res) => {
    res.json({ success: true, ...tokenScanner.getMoralisApiKeyStatus() });
});

// Get all detected tokens
router.get('/tokens/detected', async (req, res) => {
    try {
        const tokens = tokenScanner.getDetectedTokens();
        res.json({ success: true, tokens, count: tokens.length });
    } catch (error) {
        logger.error('Failed to get detected tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get safe/sellable tokens
router.get('/tokens/sellable', async (req, res) => {
    try {
        const tokens = tokenScanner.getSellableTokens();
        res.json({ success: true, tokens, count: tokens.length });
    } catch (error) {
        logger.error('Failed to get sellable tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sell all safe non-stablecoin tokens (manual trigger for deposit auto-sell)
router.post('/tokens/sell-safe', async (req, res) => {
    try {
        await ensureScannerInit();
        const swapService = (await import('../services/crypto/swapService.js')).default;
        const tokens = tokenScanner.getSellableTokens();

        const stablecoins = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'BTCB']);
        const exclude = req.body?.exclude || []; // allow excluding specific symbols
        const excludeSet = new Set([...exclude.map(s => s.toUpperCase())]);

        const stablecoinAddrs = {
            bsc: '0x55d398326f99059fF775485246999027B3197955',
            ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
        };
        const wrappedNative = {
            bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
            ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
        };

        const sellable = tokens.filter(t =>
            !stablecoins.has(t.symbol?.toUpperCase()) &&
            !excludeSet.has(t.symbol?.toUpperCase()) &&
            parseFloat(t.balance) > 0 &&
            t.network && stablecoinAddrs[t.network]
        );

        logger.info(`[sell-safe] Starting sell of ${sellable.length} token(s): ${sellable.map(t => t.symbol).join(', ')}`);
        const results = [];

        for (const token of sellable) {
            const network = token.network;
            const fullAmount = parseFloat(token.balance);
            const sellPercentages = [1.0, 0.5, 0.25, 0.10, 0.05, 0.01];
            let sold = false;

            for (const pct of sellPercentages) {
                const sellAmount = (fullAmount * pct).toString();
                const pctLabel = `${(pct * 100).toFixed(0)}%`;

                // Use SupportingFeeOnTransfer variant with extreme slippage —
                // airdropped tokens often have 50-99% hidden transfer fees
                const swapOpts = { gasCheck: true, tokenTaxPercent: 50, slippageTolerance: 99 };

                // Try stablecoin route
                try {
                    const swapResult = await swapService.swap(
                        token.address, stablecoinAddrs[network], sellAmount, 99, network, swapOpts
                    );
                    if (swapResult?.hash) {
                        const received = parseFloat(swapResult.expectedOut || swapResult.amountOut || '0');
                        logger.info(`[sell-safe] Sold ${pctLabel} of ${token.symbol} → ${received.toFixed(4)} stablecoin (tx: ${swapResult.hash})`);
                        results.push({ symbol: token.symbol, amount: sellAmount, pct: pctLabel, hash: swapResult.hash, route: 'stablecoin', received });
                        sold = true;
                        break;
                    }
                } catch (err) {
                    const isPoolError = err.message?.includes('Pancake: K') || err.message?.includes('INSUFFICIENT_OUTPUT') || err.message?.includes('ds-math-sub-underflow');
                    if (isPoolError && pct > 0.01) {
                        logger.info(`[sell-safe] ${token.symbol} at ${pctLabel} too large for pool, reducing...`);
                        continue;
                    }
                    if (!isPoolError) {
                        logger.warn(`[sell-safe] ${token.symbol} stablecoin sell failed: ${err.message}`);
                    }
                }

                // Fallback: native route
                if (wrappedNative[network]) {
                    try {
                        const swapResult = await swapService.swap(
                            token.address, wrappedNative[network], sellAmount, 99, network, swapOpts
                        );
                        if (swapResult?.hash) {
                            const received = parseFloat(swapResult.expectedOut || swapResult.amountOut || '0');
                            logger.info(`[sell-safe] Sold ${pctLabel} of ${token.symbol} → ${received.toFixed(6)} native (tx: ${swapResult.hash})`);
                            results.push({ symbol: token.symbol, amount: sellAmount, pct: pctLabel, hash: swapResult.hash, route: 'native', received });
                            sold = true;
                            break;
                        }
                    } catch (err) {
                        const isPoolError = err.message?.includes('Pancake: K') || err.message?.includes('INSUFFICIENT_OUTPUT') || err.message?.includes('ds-math-sub-underflow');
                        if (isPoolError && pct > 0.01) {
                            logger.info(`[sell-safe] ${token.symbol} native at ${pctLabel} too large, reducing...`);
                            continue;
                        }
                    }
                }
            }

            if (!sold) {
                logger.warn(`[sell-safe] All sell attempts failed for ${token.symbol}`);
                results.push({ symbol: token.symbol, error: 'All sell attempts failed (100% → 1%)' });
            }
        }

        res.json({ success: true, sellable: sellable.length, results });
    } catch (error) {
        logger.error('Failed to sell safe tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get scam tokens
router.get('/tokens/scam', async (req, res) => {
    try {
        const tokens = tokenScanner.getScamTokens();
        res.json({ success: true, tokens, count: tokens.length });
    } catch (error) {
        logger.error('Failed to get scam tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

// Check if specific token is safe
router.get('/tokens/check/:network/:address', async (req, res) => {
    try {
        const { network, address } = req.params;
        const result = await tokenScanner.isTokenSafe(address, network);
        res.json({ success: true, token: result });
    } catch (error) {
        logger.error('Failed to check token:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== STRATEGY IMPORT/EXPORT ENDPOINTS ====================

// Get platform capabilities for compatibility checking
router.get('/strategy/capabilities', async (req, res) => {
    try {
        const capabilities = strategyExporter.getPlatformCapabilities();
        res.json({ success: true, ...capabilities });
    } catch (error) {
        logger.error('Failed to get capabilities:', error);
        res.status(500).json({ error: error.message });
    }
});

// Export a single strategy
router.get('/strategy/export/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const { type = 'config', download = 'true' } = req.query;

        const exported = strategyExporter.exportStrategy(name, { type });

        if (download === 'true') {
            const filename = `${name}.strategy.json`;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(JSON.stringify(exported, null, 2));
        } else {
            res.json({ success: true, data: exported });
        }
    } catch (error) {
        logger.error('Failed to export strategy:', error);
        res.status(500).json({ error: error.message });
    }
});

// Export all strategies as a bundle
router.get('/strategy/export-all', async (req, res) => {
    try {
        const { type = 'config', download = 'true' } = req.query;

        const exported = strategyExporter.exportAllStrategies({ type });

        if (download === 'true') {
            const date = new Date().toISOString().split('T')[0];
            const filename = `lanagent-strategies-${date}.strategies.json`;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(JSON.stringify(exported, null, 2));
        } else {
            res.json({ success: true, data: exported });
        }
    } catch (error) {
        logger.error('Failed to export all strategies:', error);
        res.status(500).json({ error: error.message });
    }
});

// Validate a strategy file (dry run)
router.post('/strategy/validate', async (req, res) => {
    try {
        const { strategy } = req.body;

        if (!strategy) {
            return res.status(400).json({ error: 'Missing strategy data in request body' });
        }

        const result = strategyExporter.validateStrategy(strategy);
        res.json({
            success: true,
            valid: result.valid,
            errors: result.errors,
            warnings: result.warnings,
            normalized: result.valid ? result.normalized : null
        });
    } catch (error) {
        logger.error('Failed to validate strategy:', error);
        res.status(500).json({ error: error.message });
    }
});

// Import a strategy
router.post('/strategy/import', async (req, res) => {
    try {
        const { strategy, options = {} } = req.body;

        if (!strategy) {
            return res.status(400).json({ error: 'Missing strategy data in request body' });
        }

        const { mode = 'merge', activate = false, validateOnly = false } = options;

        // Validate first
        if (validateOnly) {
            const validation = strategyExporter.validateStrategy(strategy);
            return res.json({
                success: true,
                validated: true,
                valid: validation.valid,
                errors: validation.errors,
                warnings: validation.warnings
            });
        }

        // Import the strategy
        const result = strategyExporter.importStrategy(strategy, { mode, activate });

        res.json({
            success: result.success,
            imported: result.imported,
            warnings: result.warnings,
            activationRequired: result.activationRequired,
            activateCommand: result.activationRequired && result.imported.length > 0
                ? `POST /api/crypto/strategy/switch with body { "strategy": "${result.imported[0]?.type}" }`
                : null
        });
    } catch (error) {
        logger.error('Failed to import strategy:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== ARBITRAGE TOKEN MANAGEMENT ====================

// Get arbitrage scan tokens and status
router.get('/strategy/arbitrage/tokens', async (req, res) => {
    try {
        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');
        const arbStrategy = strategyRegistry.get('arbitrage');
        if (!arbStrategy) {
            return res.status(404).json({ error: 'Arbitrage strategy not found' });
        }

        const network = req.query.network || 'bsc';
        const defaultTokens = arbStrategy.getDefaultTokens(network).map(t => ({ ...t, removable: false, source: 'default' }));

        // Token trader tokens (all active instances)
        const tokenTraderTokens = [];
        try {
            for (const [, ttInstance] of strategyRegistry.getAllTokenTraders()) {
                if (ttInstance?.isConfigured?.() && ttInstance.config.tokenAddress) {
                    const addr = ttInstance.config.tokenAddress.toLowerCase();
                    const alreadyDefault = defaultTokens.some(t => t.address.toLowerCase() === addr);
                    const alreadyAdded = tokenTraderTokens.some(t => t.address.toLowerCase() === addr);
                    if (!alreadyDefault && !alreadyAdded) {
                        tokenTraderTokens.push({
                            address: ttInstance.config.tokenAddress,
                            symbol: ttInstance.config.tokenSymbol || 'TOKEN',
                            decimals: ttInstance.config.tokenDecimals || 18,
                            removable: false,
                            source: 'tokenTrader',
                        });
                    }
                }
            }
        } catch { /* ignore */ }

        const customTokens = (arbStrategy.config.customScanTokens || []).map(t => ({ ...t, removable: true, source: 'custom' }));

        res.json({
            success: true,
            enabled: arbStrategy.enabled,
            tokens: {
                default: defaultTokens,
                tokenTrader: tokenTraderTokens,
                custom: customTokens,
            },
            config: {
                minSpreadPercent: arbStrategy.config.minSpreadPercent,
                minProfitUsd: arbStrategy.config.minProfitUsd,
                maxTradeUsd: arbStrategy.config.maxTradeUsd,
                cooldownMs: arbStrategy.config.cooldownMs,
                scanDelayMs: arbStrategy.config.scanDelayMs,
            },
            status: arbStrategy.getArbStatus(),
        });
    } catch (error) {
        logger.error('Failed to get arb tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add custom arbitrage scan token
router.post('/strategy/arbitrage/tokens', async (req, res) => {
    try {
        const { address } = req.body;

        if (!address) {
            return res.status(400).json({ error: 'address is required' });
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            return res.status(400).json({ error: 'Invalid token address format' });
        }

        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');
        const arbStrategy = strategyRegistry.get('arbitrage');
        if (!arbStrategy) {
            return res.status(404).json({ error: 'Arbitrage strategy not found' });
        }

        // Check for duplicates against defaults + custom
        const network = req.body.network || 'bsc';
        const allTokens = arbStrategy.getScanTokens(network, []);
        const duplicate = allTokens.some(t => t.address.toLowerCase() === address.toLowerCase());
        if (duplicate) {
            return res.status(409).json({ error: `Token ${address} is already in the scan list` });
        }

        // Auto-resolve symbol and decimals from on-chain ERC20 metadata
        let symbol = req.body.symbol;
        let decimals = req.body.decimals;
        if (!symbol || decimals === undefined) {
            try {
                const { default: swapService } = await import('../services/crypto/swapService.js');
                const metadata = await swapService.getTokenMetadata(address, network);
                if (!symbol) symbol = metadata.symbol;
                if (decimals === undefined) decimals = metadata.decimals;
            } catch (metaErr) {
                if (!symbol) {
                    return res.status(400).json({ error: `Could not resolve token metadata: ${metaErr.message}. Provide symbol and decimals manually.` });
                }
                if (decimals === undefined) decimals = 18;
            }
        }

        if (!Array.isArray(arbStrategy.config.customScanTokens)) {
            arbStrategy.config.customScanTokens = [];
        }
        arbStrategy.config.customScanTokens.push({
            address,
            symbol: String(symbol).toUpperCase(),
            decimals: parseInt(decimals) || 18,
        });

        // Persist: export strategy state and save to MongoDB via handler
        try {
            const handler = await getCryptoHandler();
            if (handler) {
                const registryState = strategyRegistry.exportState();
                await handler.updateState({ strategyRegistry: registryState });
            }
        } catch (persistErr) {
            logger.warn('Failed to persist arb token addition:', persistErr.message);
        }

        res.json({
            success: true,
            message: `Added ${String(symbol).toUpperCase()} (${decimals} decimals) to arbitrage scan list`,
            customTokens: arbStrategy.config.customScanTokens,
        });
    } catch (error) {
        logger.error('Failed to add arb token:', error);
        res.status(500).json({ error: error.message });
    }
});

// Remove custom arbitrage scan token
router.delete('/strategy/arbitrage/tokens/:address', async (req, res) => {
    try {
        const { address } = req.params;

        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');
        const arbStrategy = strategyRegistry.get('arbitrage');
        if (!arbStrategy) {
            return res.status(404).json({ error: 'Arbitrage strategy not found' });
        }

        if (!Array.isArray(arbStrategy.config.customScanTokens)) {
            return res.status(404).json({ error: 'Token not found in custom list' });
        }

        const idx = arbStrategy.config.customScanTokens.findIndex(
            t => t.address.toLowerCase() === address.toLowerCase()
        );
        if (idx === -1) {
            return res.status(404).json({ error: 'Token not found in custom list (only custom tokens can be removed)' });
        }

        const removed = arbStrategy.config.customScanTokens.splice(idx, 1)[0];

        // Persist
        try {
            const handler = await getCryptoHandler();
            if (handler) {
                const registryState = strategyRegistry.exportState();
                await handler.updateState({ strategyRegistry: registryState });
            }
        } catch (persistErr) {
            logger.warn('Failed to persist arb token removal:', persistErr.message);
        }

        res.json({
            success: true,
            message: `Removed ${removed.symbol} from arbitrage scan list`,
            customTokens: arbStrategy.config.customScanTokens,
        });
    } catch (error) {
        logger.error('Failed to remove arb token:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get arbitrage scan status
router.get('/strategy/arbitrage/status', async (req, res) => {
    try {
        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');
        const arbStrategy = strategyRegistry.get('arbitrage');
        if (!arbStrategy) {
            return res.status(404).json({ error: 'Arbitrage strategy not found' });
        }

        res.json({
            success: true,
            enabled: arbStrategy.enabled,
            status: arbStrategy.getArbStatus(),
            config: {
                minSpreadPercent: arbStrategy.config.minSpreadPercent,
                minProfitUsd: arbStrategy.config.minProfitUsd,
                maxTradeUsd: arbStrategy.config.maxTradeUsd,
                estimatedGasPerSwap: arbStrategy.config.estimatedGasPerSwap,
                scanNetworks: arbStrategy.config.scanNetworks,
                scanDelayMs: arbStrategy.config.scanDelayMs,
                _configVersion: arbStrategy.config._configVersion,
            },
        });
    } catch (error) {
        logger.error('Failed to get arb status:', error);
        res.status(500).json({ error: error.message });
    }
});

// Toggle arbitrage scanner enabled/disabled
router.post('/strategy/arbitrage/toggle', async (req, res) => {
    try {
        const { strategyRegistry } = await import('../services/crypto/strategies/StrategyRegistry.js');
        const arbStrategy = strategyRegistry.get('arbitrage');
        if (!arbStrategy) {
            return res.status(404).json({ error: 'Arbitrage strategy not found' });
        }

        const newState = !arbStrategy.enabled;
        arbStrategy.enabled = newState;

        // Persist
        try {
            const handler = await getCryptoHandler();
            if (handler) {
                const registryState = strategyRegistry.exportState();
                await handler.updateState({ strategyRegistry: registryState });
            }
        } catch (persistErr) {
            logger.warn('Failed to persist arb toggle:', persistErr.message);
        }

        logger.info(`Arbitrage scanner ${newState ? 'enabled' : 'disabled'} via API`);
        res.json({ success: true, enabled: newState });
    } catch (error) {
        logger.error('Failed to toggle arb scanner:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== Nano (XNO) Endpoints ====================

router.get('/nano/balance', async (req, res) => {
    try {
        const nanoService = (await import('../services/crypto/nanoService.js')).default;
        const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
        if (!nanoAddr) return res.status(404).json({ error: 'No Nano address found' });

        const balance = await nanoService.getBalance(nanoAddr.address);
        res.json({ address: nanoAddr.address, balance, symbol: 'XNO' });
    } catch (error) {
        logger.error('Nano balance error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/nano/account-info', async (req, res) => {
    try {
        const nanoService = (await import('../services/crypto/nanoService.js')).default;
        const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
        if (!nanoAddr) return res.status(404).json({ error: 'No Nano address found' });

        const info = await nanoService.getAccountInfo(nanoAddr.address);
        res.json({ address: nanoAddr.address, ...info });
    } catch (error) {
        logger.error('Nano account-info error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/nano/send', async (req, res) => {
    try {
        const { toAddress, amount } = req.body;
        if (!toAddress || !amount) {
            return res.status(400).json({ error: 'toAddress and amount are required' });
        }
        if (!toAddress.startsWith('nano_')) {
            return res.status(400).json({ error: 'Invalid Nano address (must start with nano_)' });
        }

        const nanoService = (await import('../services/crypto/nanoService.js')).default;
        const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
        if (!nanoAddr) return res.status(404).json({ error: 'No Nano address found' });

        const result = await nanoService.send(nanoAddr.address, toAddress, amount);

        // Record transaction
        await walletService.addTransaction({
            chain: 'nano',
            type: 'sent',
            hash: result.hash,
            from: result.from,
            to: result.to,
            amount: result.amount.toString(),
            status: 'confirmed'
        });

        cache.del('walletInfo');
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('Nano send error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/nano/receive', async (req, res) => {
    try {
        const nanoService = (await import('../services/crypto/nanoService.js')).default;
        const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
        if (!nanoAddr) return res.status(404).json({ error: 'No Nano address found' });

        const result = await nanoService.receiveAll(nanoAddr.address);

        // Record received transactions
        for (const block of result.blocks) {
            if (block.hash) {
                await walletService.addTransaction({
                    chain: 'nano',
                    type: 'received',
                    hash: block.hash,
                    to: nanoAddr.address,
                    amount: block.amount,
                    status: 'confirmed'
                });
            }
        }

        cache.del('walletInfo');
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('Nano receive error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/nano/receivable', async (req, res) => {
    try {
        const nanoService = (await import('../services/crypto/nanoService.js')).default;
        const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
        if (!nanoAddr) return res.status(404).json({ error: 'No Nano address found' });

        const receivable = await nanoService.getReceivable(nanoAddr.address);
        res.json({ address: nanoAddr.address, ...receivable });
    } catch (error) {
        logger.error('Nano receivable error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/nano/status', async (req, res) => {
    try {
        const nanoService = (await import('../services/crypto/nanoService.js')).default;
        const nanoAddr = walletService.getAddresses().find(a => a.chain === 'nano');
        const status = nanoService.getStatus();
        status.address = nanoAddr?.address || null;
        res.json(status);
    } catch (error) {
        logger.error('Nano status error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== Liquidity Management ====================

router.get('/lp/positions', authMiddleware, async (req, res) => {
    try {
        const lpManager = (await import('../services/crypto/lpManager.js')).default;
        const stats = await lpManager.getStats();
        res.json({ success: true, ...stats });
    } catch (error) {
        logger.error('LP positions error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/lp/positions/:pairAddress', authMiddleware, async (req, res) => {
    try {
        const lpManager = (await import('../services/crypto/lpManager.js')).default;
        const position = await lpManager.refreshPosition(req.params.pairAddress, req.query.network || 'bsc');
        if (!position) return res.status(404).json({ success: false, error: 'Position not found' });
        res.json({ success: true, position });
    } catch (error) {
        logger.error('LP position detail error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/lp/positions/refresh', authMiddleware, async (req, res) => {
    try {
        const lpManager = (await import('../services/crypto/lpManager.js')).default;
        const positions = await lpManager.refreshAll();
        res.json({ success: true, refreshed: positions.length });
    } catch (error) {
        logger.error('LP refresh error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/lp/add', authMiddleware, async (req, res) => {
    try {
        const { tokenA, tokenB, amountA, amountB, slippage, network } = req.body;
        if (!tokenA || !tokenB || !amountA || !amountB) {
            return res.status(400).json({ success: false, error: 'tokenA, tokenB, amountA, amountB required' });
        }
        const lpManager = (await import('../services/crypto/lpManager.js')).default;
        const result = await lpManager.addLiquidity(tokenA, tokenB, amountA, amountB, slippage || 1, network || 'bsc');
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('LP add liquidity error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/lp/remove', authMiddleware, async (req, res) => {
    try {
        const { tokenA, tokenB, lpAmount, slippage, network } = req.body;
        if (!tokenA || !tokenB || !lpAmount) {
            return res.status(400).json({ success: false, error: 'tokenA, tokenB, lpAmount required' });
        }
        const lpManager = (await import('../services/crypto/lpManager.js')).default;
        const result = await lpManager.removeLiquidity(tokenA, tokenB, lpAmount, slippage || 1, network || 'bsc');
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('LP remove liquidity error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/lp/info', authMiddleware, async (req, res) => {
    try {
        const { tokenA, tokenB, network } = req.query;
        if (!tokenA || !tokenB) {
            return res.status(400).json({ success: false, error: 'tokenA and tokenB required' });
        }
        const swapSvc = (await import('../services/crypto/swapService.js')).default;
        const info = await swapSvc.getLPInfo(tokenA, tokenB, network || 'bsc');
        res.json({ success: true, info });
    } catch (error) {
        logger.error('LP info error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;