import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import NodeCache from 'node-cache';

let ethersLib = null;
async function getEthers() {
    if (!ethersLib) {
        ethersLib = await import('ethers');
    }
    return ethersLib;
}

const profileCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

const NETWORK_CONFIG = {
    bsc: {
        rpcUrl: 'https://bsc-dataseed.binance.org',
        chainId: 56,
        nativeSymbol: 'BNB',
        explorerApi: 'https://api.bscscan.com/api',
        explorerKeyEnv: 'BSCSCAN_API_KEY',
        goPlusChainId: '56'
    },
    ethereum: {
        rpcUrl: 'https://eth.llamarpc.com',
        chainId: 1,
        nativeSymbol: 'ETH',
        explorerApi: 'https://api.etherscan.io/api',
        explorerKeyEnv: 'ETHERSCAN_API_KEY',
        goPlusChainId: '1'
    }
};

export default class WalletProfilerPlugin extends BasePlugin {
    constructor(agent) {
        super(agent);
        this.name = 'walletProfiler';
        this.version = '1.0.0';
        this.description = 'Profile crypto wallet addresses — balance, token holdings, transaction history, and risk assessment';

        this.commands = [
            {
                command: 'profile',
                description: 'Full wallet profile including balance, tx history, wallet age, and risk flags',
                usage: 'profile({ address: "0x...", network: "bsc" })',
                examples: [
                    'profile wallet 0xABC on BSC',
                    'get wallet profile for 0x123 on ethereum',
                    'analyze address 0xDEF'
                ]
            },
            {
                command: 'tokens',
                description: 'List token holdings for a wallet address',
                usage: 'tokens({ address: "0x...", network: "bsc" })',
                examples: [
                    'show tokens for 0xABC on BSC',
                    'list token holdings for 0x123',
                    'what tokens does 0xDEF hold'
                ]
            },
            {
                command: 'riskScore',
                description: 'Risk assessment score (0-100) for a wallet address',
                usage: 'riskScore({ address: "0x...", network: "bsc" })',
                examples: [
                    'risk score for 0xABC',
                    'is wallet 0x123 risky',
                    'assess risk of address 0xDEF on ethereum'
                ]
            }
        ];
    }

    async execute(params) {
        const { action, ...data } = params;

        this.validateParams(params, {
            action: {
                required: true,
                type: 'string',
                enum: this.commands.map(c => c.command)
            }
        });

        try {
            switch (action) {
                case 'profile':
                    return await this.profile(data);
                case 'tokens':
                    return await this.tokens(data);
                case 'riskScore':
                    return await this.riskScore(data);
                default:
                    return { success: false, error: `Unknown action: ${action}` };
            }
        } catch (error) {
            this.logger.error(`walletProfiler ${action} error: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────

    _validateAddressAndNetwork(data) {
        this.validateParams(data, {
            address: { required: true, type: 'string' },
            network: { required: true, type: 'string', enum: ['bsc', 'ethereum'] }
        });
        // Normalize address to proper checksum to avoid ethers INVALID_ARGUMENT errors
        if (ethersLib?.ethers) {
            data.address = ethersLib.ethers.getAddress(data.address.toLowerCase());
        }
        return NETWORK_CONFIG[data.network];
    }

    _getProvider(networkCfg) {
        const { ethers } = ethersLib || {};
        if (!ethers) throw new Error('ethers not loaded');
        return new ethers.JsonRpcProvider(networkCfg.rpcUrl);
    }

    _getExplorerKey(networkCfg) {
        return process.env[networkCfg.explorerKeyEnv] || '';
    }

    async _explorerGet(networkCfg, queryParams) {
        const apiKey = this._getExplorerKey(networkCfg);
        const params = { ...queryParams };
        if (apiKey) params.apikey = apiKey;

        try {
            const { data } = await axios.get(networkCfg.explorerApi, { params, timeout: 15000 });
            if (data.status === '1' || data.result) return data;
            return data;
        } catch (error) {
            this.logger.warn(`Explorer API request failed: ${error.message}`);
            return null;
        }
    }

    async _getNativeBalanceUSD(balanceEth, networkCfg) {
        const cacheKey = `price_${networkCfg.nativeSymbol}`;
        let price = profileCache.get(cacheKey);
        if (!price) {
            try {
                const { data } = await axios.get(
                    `https://api.coingecko.com/api/v3/simple/price?ids=${networkCfg.nativeSymbol === 'BNB' ? 'binancecoin' : 'ethereum'}&vs_currencies=usd`,
                    { timeout: 10000 }
                );
                price = data[networkCfg.nativeSymbol === 'BNB' ? 'binancecoin' : 'ethereum']?.usd || 0;
                profileCache.set(cacheKey, price);
            } catch {
                price = 0;
            }
        }
        return { price, usdValue: parseFloat((balanceEth * price).toFixed(2)) };
    }

    async _isContract(provider, address) {
        try {
            const code = await provider.getCode(address);
            return code !== '0x';
        } catch {
            return false;
        }
    }

    async _getTransactionHistory(networkCfg, address) {
        const data = await this._explorerGet(networkCfg, {
            module: 'account',
            action: 'txlist',
            address,
            startblock: 0,
            endblock: 99999999,
            page: 1,
            offset: 100,
            sort: 'asc'
        });

        if (!data || !Array.isArray(data.result)) return { txs: [], totalCount: 0 };

        // Get total tx count from a separate call (the list is capped at offset)
        let totalCount = data.result.length;
        const countData = await this._explorerGet(networkCfg, {
            module: 'proxy',
            action: 'eth_getTransactionCount',
            address,
            tag: 'latest'
        });
        if (countData?.result) {
            const parsed = parseInt(countData.result, 16);
            if (!isNaN(parsed)) totalCount = parsed;
        }

        return { txs: data.result, totalCount };
    }

    // ── Commands ───────────────────────────────────────────────────────

    async profile(data) {
        const networkCfg = this._validateAddressAndNetwork(data);
        const { address, network } = data;

        const cacheKey = `profile_${network}_${address.toLowerCase()}`;
        const cached = profileCache.get(cacheKey);
        if (cached) return cached;

        await getEthers();
        const { ethers } = ethersLib;
        const provider = this._getProvider(networkCfg);

        // Fetch in parallel
        const [balanceWei, isContract, txHistory, goPlusData] = await Promise.all([
            provider.getBalance(address),
            this._isContract(provider, address),
            this._getTransactionHistory(networkCfg, address),
            this._getGoPlusSecurity(networkCfg, address)
        ]);

        const balanceNative = parseFloat(ethers.formatEther(balanceWei));
        const { price, usdValue } = await this._getNativeBalanceUSD(balanceNative, networkCfg);

        // Wallet age from tx history
        let firstTxDate = null;
        let lastTxDate = null;
        let walletAgeDays = null;
        if (txHistory.txs.length > 0) {
            firstTxDate = new Date(parseInt(txHistory.txs[0].timeStamp) * 1000).toISOString();
            const lastTx = txHistory.txs[txHistory.txs.length - 1];
            lastTxDate = new Date(parseInt(lastTx.timeStamp) * 1000).toISOString();
            walletAgeDays = Math.floor((Date.now() - parseInt(txHistory.txs[0].timeStamp) * 1000) / 86400000);
        }

        // Token count from explorer
        let tokenCount = 0;
        const tokenData = await this._explorerGet(networkCfg, {
            module: 'account',
            action: 'tokentx',
            address,
            startblock: 0,
            endblock: 99999999,
            page: 1,
            offset: 1000,
            sort: 'desc'
        });
        if (tokenData && Array.isArray(tokenData.result)) {
            const uniqueTokens = new Set(tokenData.result.map(t => t.contractAddress.toLowerCase()));
            tokenCount = uniqueTokens.size;
        }

        // Risk flags
        const riskFlags = this._computeRiskFlags(walletAgeDays, txHistory, isContract, goPlusData);

        const result = {
            success: true,
            address,
            network,
            balance: {
                native: balanceNative,
                symbol: networkCfg.nativeSymbol,
                usd: usdValue,
                nativePrice: price
            },
            tokenCount,
            transactions: {
                total: txHistory.totalCount,
                firstTxDate,
                lastTxDate,
                walletAgeDays
            },
            isContract,
            riskFlags
        };

        profileCache.set(cacheKey, result);
        this.logger.info(`Profiled wallet ${address} on ${network}: ${balanceNative} ${networkCfg.nativeSymbol}, ${txHistory.totalCount} txs, age ${walletAgeDays ?? 'unknown'} days`);
        return result;
    }

    async tokens(data) {
        const networkCfg = this._validateAddressAndNetwork(data);
        const { address, network } = data;

        const cacheKey = `tokens_${network}_${address.toLowerCase()}`;
        const cached = profileCache.get(cacheKey);
        if (cached) return cached;

        await getEthers();

        // Get token transfer events to find which tokens this wallet interacted with
        const tokenData = await this._explorerGet(networkCfg, {
            module: 'account',
            action: 'tokentx',
            address,
            startblock: 0,
            endblock: 99999999,
            page: 1,
            offset: 1000,
            sort: 'desc'
        });

        if (!tokenData || !Array.isArray(tokenData.result) || tokenData.result.length === 0) {
            const result = { success: true, address, network, tokens: [], message: 'No token transfers found' };
            profileCache.set(cacheKey, result);
            return result;
        }

        // Aggregate unique tokens and their last known transfer amounts
        const tokenMap = new Map();
        for (const tx of tokenData.result) {
            const contract = tx.contractAddress.toLowerCase();
            if (!tokenMap.has(contract)) {
                tokenMap.set(contract, {
                    contractAddress: tx.contractAddress,
                    symbol: tx.tokenSymbol || 'UNKNOWN',
                    name: tx.tokenName || 'Unknown Token',
                    decimals: parseInt(tx.tokenDecimal) || 18,
                    lastTransfer: new Date(parseInt(tx.timeStamp) * 1000).toISOString()
                });
            }
        }

        // Query on-chain balances for top tokens (limit to 20 to avoid rate limits)
        const { ethers } = ethersLib;
        const provider = this._getProvider(networkCfg);
        const erc20Abi = ['function balanceOf(address) view returns (uint256)'];

        const tokenEntries = Array.from(tokenMap.values()).slice(0, 20);
        const balanceResults = await Promise.allSettled(
            tokenEntries.map(async (token) => {
                try {
                    const contract = new ethers.Contract(token.contractAddress, erc20Abi, provider);
                    const balance = await contract.balanceOf(address);
                    const formatted = parseFloat(ethers.formatUnits(balance, token.decimals));
                    return { ...token, balance: formatted };
                } catch {
                    return { ...token, balance: null };
                }
            })
        );

        const tokens = balanceResults
            .filter(r => r.status === 'fulfilled' && r.value.balance !== null && r.value.balance > 0)
            .map(r => r.value)
            .sort((a, b) => b.balance - a.balance);

        const result = {
            success: true,
            address,
            network,
            tokenCount: tokens.length,
            tokens
        };

        profileCache.set(cacheKey, result);
        this.logger.info(`Found ${tokens.length} tokens with balance for ${address} on ${network}`);
        return result;
    }

    async riskScore(data) {
        const networkCfg = this._validateAddressAndNetwork(data);
        const { address, network } = data;

        const cacheKey = `risk_${network}_${address.toLowerCase()}`;
        const cached = profileCache.get(cacheKey);
        if (cached) return cached;

        await getEthers();
        const { ethers } = ethersLib;
        const provider = this._getProvider(networkCfg);

        const [isContract, txHistory, goPlusData] = await Promise.all([
            this._isContract(provider, address),
            this._getTransactionHistory(networkCfg, address),
            this._getGoPlusSecurity(networkCfg, address)
        ]);

        let walletAgeDays = null;
        if (txHistory.txs.length > 0) {
            walletAgeDays = Math.floor((Date.now() - parseInt(txHistory.txs[0].timeStamp) * 1000) / 86400000);
        }

        const flags = this._computeRiskFlags(walletAgeDays, txHistory, isContract, goPlusData);

        // Score calculation: start at 0 (safe), add points for each flag
        let score = 0;
        const scoring = {
            newWallet: 20,
            highValueTransfers: 15,
            isContract: 10,
            scamInteraction: 30,
            maliciousAddress: 40,
            honeypotInteraction: 25,
            mixerInteraction: 20,
            phishingActivity: 35,
            lowTxCount: 10,
            noTxHistory: 15
        };

        const activeFlags = [];
        for (const flag of flags) {
            if (scoring[flag.id] !== undefined) {
                score += scoring[flag.id];
                activeFlags.push({ ...flag, points: scoring[flag.id] });
            }
        }

        score = Math.min(score, 100);

        let riskLevel;
        if (score <= 20) riskLevel = 'low';
        else if (score <= 50) riskLevel = 'medium';
        else if (score <= 75) riskLevel = 'high';
        else riskLevel = 'critical';

        const result = {
            success: true,
            address,
            network,
            riskScore: score,
            riskLevel,
            isContract,
            flags: activeFlags,
            walletAgeDays
        };

        profileCache.set(cacheKey, result);
        this.logger.info(`Risk score for ${address} on ${network}: ${score}/100 (${riskLevel})`);
        return result;
    }

    // ── GoPlus Security API ───────────────────────────────────────────

    async _getGoPlusSecurity(networkCfg, address) {
        const cacheKey = `goplus_${networkCfg.goPlusChainId}_${address.toLowerCase()}`;
        const cached = profileCache.get(cacheKey);
        if (cached) return cached;

        try {
            const { data } = await axios.get(
                `https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=${networkCfg.goPlusChainId}`,
                { timeout: 10000 }
            );

            if (data?.code === 1 && data.result) {
                profileCache.set(cacheKey, data.result);
                return data.result;
            }
            return null;
        } catch (error) {
            this.logger.warn(`GoPlus API failed for ${address}: ${error.message}`);
            return null;
        }
    }

    // ── Risk Flag Computation ─────────────────────────────────────────

    _computeRiskFlags(walletAgeDays, txHistory, isContract, goPlusData) {
        const flags = [];

        // New wallet (< 7 days)
        if (walletAgeDays !== null && walletAgeDays < 7) {
            flags.push({ id: 'newWallet', label: 'New wallet', detail: `Wallet is only ${walletAgeDays} day(s) old` });
        }

        // No transaction history at all
        if (txHistory.txs.length === 0) {
            flags.push({ id: 'noTxHistory', label: 'No transaction history', detail: 'Address has no recorded transactions' });
        } else if (txHistory.totalCount < 5) {
            flags.push({ id: 'lowTxCount', label: 'Low transaction count', detail: `Only ${txHistory.totalCount} transactions` });
        }

        // High-value transfers (> 10 ETH/BNB in a single tx)
        const highValueThreshold = 10n * (10n ** 18n); // 10 native tokens in wei
        const hasHighValue = txHistory.txs.some(tx => {
            try { return BigInt(tx.value) >= highValueThreshold; } catch { return false; }
        });
        if (hasHighValue) {
            flags.push({ id: 'highValueTransfers', label: 'High-value transfers detected', detail: 'At least one transaction >= 10 native tokens' });
        }

        // Contract address
        if (isContract) {
            flags.push({ id: 'isContract', label: 'Address is a contract', detail: 'This is a smart contract, not an EOA' });
        }

        // GoPlus flags
        if (goPlusData) {
            if (goPlusData.malicious_address === '1') {
                flags.push({ id: 'maliciousAddress', label: 'Known malicious address', detail: 'Flagged by GoPlus as malicious' });
            }
            if (goPlusData.honeypot_related_address === '1') {
                flags.push({ id: 'honeypotInteraction', label: 'Honeypot interaction', detail: 'Associated with honeypot contracts' });
            }
            if (goPlusData.phishing_activities === '1') {
                flags.push({ id: 'phishingActivity', label: 'Phishing activity', detail: 'Flagged for phishing activity' });
            }
            if (goPlusData.blackmail_activities === '1') {
                flags.push({ id: 'scamInteraction', label: 'Blackmail/scam activity', detail: 'Flagged for blackmail or scam activity' });
            }
            if (goPlusData.mixing_activities === '1') {
                flags.push({ id: 'mixerInteraction', label: 'Mixer usage', detail: 'Associated with mixing/tumbling services' });
            }
        }

        return flags;
    }
}
