import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import walletService from '../../services/crypto/walletService.js';
import contractService from '../../services/crypto/contractService.js';
import axios from 'axios';

let ethersLib = null;
async function getEthers() {
    if (!ethersLib) {
        ethersLib = await import('ethers');
    }
    return ethersLib;
}

export default class CryptoMonitorPlugin extends BasePlugin {
    constructor(agent) {
        super(agent);
        this.name = 'cryptoMonitor';
        this.version = '1.0.0';
        this.description = 'Monitor cryptocurrency prices, wallets, and transactions';

        this.commands = [
            {
                command: 'getPrice',
                description: 'Get current cryptocurrency price',
                usage: 'getPrice({ symbol: "BTC", currency: "USD" })',
                examples: [
                    'what is the price of bitcoin',
                    'how much is ETH worth',
                    'check BNB price',
                    'get current price of solana'
                ]
            },
            {
                command: 'monitorWallet',
                description: 'Start, stop, or check wallet monitoring status',
                usage: 'monitorWallet({ action: "start", address: "0x..." })',
                examples: [
                    'start monitoring my wallet',
                    'stop wallet monitoring',
                    'monitoring status',
                    'watch address 0x...'
                ]
            },
            {
                command: 'setAlert',
                description: 'Set up price or balance alerts',
                usage: 'setAlert({ type: "price", asset: "BTC", condition: "above", value: 50000 })',
                examples: [
                    'alert me when bitcoin goes above 50000',
                    'set price alert for ETH below 2000',
                    'notify when my balance drops below 1 ETH',
                    'create alert for BNB above 400'
                ]
            },
            {
                command: 'getPortfolio',
                description: 'Get portfolio overview with balances and values',
                usage: 'getPortfolio({ detailed: true })',
                examples: [
                    'show my crypto portfolio',
                    'what are my holdings worth',
                    'portfolio overview',
                    'detailed portfolio breakdown'
                ]
            },
            {
                command: 'getGasPrices',
                description: 'Get current gas prices for a network',
                usage: 'getGasPrices({ network: "ethereum" })',
                examples: [
                    'what are gas prices right now',
                    'check ethereum gas fees',
                    'bsc gas prices',
                    'how much is gas on polygon'
                ]
            },
            {
                command: 'checkDeFi',
                description: 'Check DeFi positions and protocols',
                usage: 'checkDeFi({ protocol: "uniswap" })',
                examples: [
                    'check my defi positions',
                    'what defi protocols am I using',
                    'show uniswap positions',
                    'defi overview'
                ]
            }
        ];

        this.config = {
            priceCheckInterval: 300000,
            balanceCheckInterval: 600000,
            priceAlerts: [],
            balanceAlerts: [],
            watchedAddresses: [],
            enableNotifications: true
        };

        this.initialized = false;
        this.priceCache = new Map();
        this.balanceCache = new Map();
        this.monitoringIntervals = new Map();
    }

    async initialize() {
        this.logger.info(`Initializing ${this.name} plugin...`);

        try {
            const savedConfig = await PluginSettings.getCached(this.name, 'config');
            if (savedConfig) {
                Object.assign(this.config, savedConfig);
                this.logger.info('Loaded cached configuration');
            }

            this.startMonitoring();

            this.initialized = true;
            this.logger.info(`${this.name} plugin initialized successfully`);
        } catch (error) {
            this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
            throw error;
        }
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

        if (params.needsParameterExtraction && this.agent.providerManager) {
            const extracted = await this.extractParameters(params.originalInput || params.input, action);
            Object.assign(data, extracted);
        }

        try {
            switch (action) {
                case 'getPrice':
                    return await this.getPrice(data);
                case 'monitorWallet':
                    return await this.monitorWallet(data);
                case 'setAlert':
                    return await this.setAlert(data);
                case 'getPortfolio':
                    return await this.getPortfolio(data);
                case 'getGasPrices':
                    return await this.getGasPrices(data);
                case 'checkDeFi':
                    return await this.checkDeFi(data);
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        } catch (error) {
            this.logger.error(`${action} failed:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    startMonitoring() {
        if (this.config.priceCheckInterval > 0) {
            const priceInterval = setInterval(
                () => this.checkPrices(),
                this.config.priceCheckInterval
            );
            this.monitoringIntervals.set('prices', priceInterval);
        }

        if (this.config.balanceCheckInterval > 0) {
            const balanceInterval = setInterval(
                () => this.checkBalances(),
                this.config.balanceCheckInterval
            );
            this.monitoringIntervals.set('balances', balanceInterval);
        }
    }

    async checkPrices() {
        try {
            const symbols = [...new Set(
                this.config.priceAlerts.map(alert => alert.asset)
            )];

            for (const symbol of symbols) {
                const price = await this.fetchPrice(symbol);
                if (price) {
                    this.priceCache.set(symbol, {
                        price,
                        timestamp: Date.now()
                    });

                    await this.checkPriceAlerts(symbol, price);
                }
            }
        } catch (error) {
            this.logger.error('Price check error:', error);
        }
    }

    async checkBalances() {
        try {
            const ethers = await getEthers();
            const wallet = await walletService.getWallet();
            if (!wallet) return;

            for (const addr of wallet.addresses) {
                // Skip non-EVM chains that contractService can't handle
                if (['btc', 'nano'].includes(addr.chain)) continue;

                // Map wallet chain names to NETWORKS keys (wallet uses 'eth', NETWORKS uses 'ethereum')
                const network = addr.chain === 'eth' ? 'ethereum' : addr.chain;
                const balance = await this.getAddressBalance(addr.address, network);

                const cacheKey = `${network}:${addr.address}`;
                const previousBalance = this.balanceCache.get(cacheKey);

                this.balanceCache.set(cacheKey, {
                    balance,
                    timestamp: Date.now()
                });

                if (previousBalance && previousBalance.balance !== balance) {
                    await this.notifyBalanceChange(
                        addr.address,
                        network,
                        previousBalance.balance,
                        balance
                    );
                }

                await this.checkBalanceAlerts(addr.address, network, balance);
            }
        } catch (error) {
            this.logger.error('Balance check error:', error);
        }
    }

    async fetchPrice(symbol, currency = 'USD') {
        try {
            const response = await axios.get(
                `https://api.coingecko.com/api/v3/simple/price`,
                {
                    params: {
                        ids: this.symbolToId(symbol),
                        vs_currencies: currency.toLowerCase()
                    },
                    timeout: 10000
                }
            );

            const id = this.symbolToId(symbol);
            return response.data[id]?.[currency.toLowerCase()];
        } catch (error) {
            this.logger.error(`Failed to fetch price for ${symbol}:`, error);
            return null;
        }
    }

    symbolToId(symbol) {
        const mapping = {
            'BTC': 'bitcoin',
            'ETH': 'ethereum',
            'BNB': 'binancecoin',
            'MATIC': 'matic-network',
            'SOL': 'solana',
            'USDT': 'tether',
            'USDC': 'usd-coin',
            'DAI': 'dai',
            'LINK': 'chainlink',
            'UNI': 'uniswap',
            'AAVE': 'aave',
            'CAKE': 'pancakeswap-token'
        };

        return mapping[symbol.toUpperCase()] || symbol.toLowerCase();
    }

    async getAddressBalance(address, network) {
        try {
            // withRpcFallback rotates through the configured RPC list when the
            // current one is rate-limited, auth-gated (e.g. Ankr free tier), or
            // returns "missing response". Without it a single bad RPC produced
            // a stream of error logs every poll cycle.
            const ethers = await getEthers();
            return await contractService.withRpcFallback(network, async () => {
                const provider = await contractService.getProvider(network);
                const balance = await provider.getBalance(address);
                return ethers.formatEther(balance);
            });
        } catch (error) {
            this.logger.warn(`Failed to get balance for ${address} on ${network} after RPC fallback: ${error.message}`);
            return '0';
        }
    }

    async checkPriceAlerts(symbol, currentPrice) {
        const alerts = this.config.priceAlerts.filter(a => a.asset === symbol);

        for (const alert of alerts) {
            const triggered = alert.condition === 'above'
                ? currentPrice > alert.value
                : currentPrice < alert.value;

            if (triggered && !alert.triggered) {
                alert.triggered = true;
                await this.sendAlert('price', {
                    symbol,
                    condition: alert.condition,
                    threshold: alert.value,
                    currentPrice
                });
            } else if (!triggered) {
                alert.triggered = false;
            }
        }
    }

    async checkBalanceAlerts(address, network, balance) {
        const alerts = this.config.balanceAlerts.filter(
            a => a.address === address && a.network === network
        );

        for (const alert of alerts) {
            const balanceNum = parseFloat(balance);
            const triggered = alert.condition === 'above'
                ? balanceNum > alert.value
                : balanceNum < alert.value;

            if (triggered && !alert.triggered) {
                alert.triggered = true;
                await this.sendAlert('balance', {
                    address,
                    network,
                    condition: alert.condition,
                    threshold: alert.value,
                    currentBalance: balance
                });
            } else if (!triggered) {
                alert.triggered = false;
            }
        }
    }

    async notifyBalanceChange(address, network, oldBalance, newBalance) {
        const change = parseFloat(newBalance) - parseFloat(oldBalance);

        if (Math.abs(change) > 0.0001) {
            this.logger.info(
                `Balance changed on ${network}: ${address.substring(0, 10)}... ` +
                `Old: ${oldBalance} New: ${newBalance} Change: ${change > 0 ? '+' : ''}${change.toFixed(6)}`
            );

            if (this.config.enableNotifications && this.agent.notify) {
                await this.agent.notify(
                    `💰 Balance changed on ${network}\n` +
                    `Address: ${address.substring(0, 10)}...\n` +
                    `Old: ${oldBalance}\nNew: ${newBalance}\n` +
                    `Change: ${change > 0 ? '+' : ''}${change.toFixed(6)}`
                );
            }
        }
    }

    async sendAlert(type, data) {
        const messages = {
            price: `Price Alert: ${data.symbol} is ${data.condition} $${data.threshold} (Current: $${data.currentPrice})`,
            balance: `Balance Alert: ${data.address.substring(0, 10)}... on ${data.network} is ${data.condition} ${data.threshold} (Current: ${data.currentBalance})`
        };

        this.logger.info(`Crypto alert: ${messages[type]}`);

        if (this.config.enableNotifications && this.agent.notify) {
            await this.agent.notify(`🚨 Crypto Alert: ${messages[type]}`);
        }
    }

    async getPrice(params) {
        const { symbol, currency = 'USD' } = params;
        if (!symbol) throw new Error('Symbol is required (e.g., BTC, ETH)');

        const price = await this.fetchPrice(symbol, currency);

        if (!price) {
            return {
                success: false,
                error: `Could not fetch price for ${symbol}`
            };
        }

        return {
            success: true,
            data: {
                symbol: symbol.toUpperCase(),
                price,
                currency: currency.toUpperCase(),
                timestamp: new Date().toISOString()
            }
        };
    }

    async monitorWallet(params) {
        const { action: monitorAction, address } = params;
        if (!monitorAction) throw new Error('Action is required (start, stop, or status)');

        switch (monitorAction) {
            case 'start':
                if (address) {
                    this.config.watchedAddresses.push({
                        address,
                        network: 'ethereum'
                    });
                    await PluginSettings.setCached(this.name, 'config', this.config);
                }
                this.startMonitoring();
                return {
                    success: true,
                    data: {
                        message: 'Monitoring started',
                        watchedAddresses: this.config.watchedAddresses
                    }
                };

            case 'stop':
                this.monitoringIntervals.forEach(interval => clearInterval(interval));
                this.monitoringIntervals.clear();
                return {
                    success: true,
                    data: { message: 'Monitoring stopped' }
                };

            case 'status':
                return {
                    success: true,
                    data: {
                        monitoring: this.monitoringIntervals.size > 0,
                        intervals: {
                            prices: this.config.priceCheckInterval,
                            balances: this.config.balanceCheckInterval
                        },
                        watchedAddresses: this.config.watchedAddresses,
                        alerts: {
                            price: this.config.priceAlerts.length,
                            balance: this.config.balanceAlerts.length
                        }
                    }
                };

            default:
                throw new Error('Invalid action. Use: start, stop, or status');
        }
    }

    async setAlert(params) {
        const { type, asset, condition, value } = params;
        if (!type) throw new Error('Alert type is required (price or balance)');
        if (!asset) throw new Error('Asset is required');
        if (!condition) throw new Error('Condition is required (above or below)');
        if (!value) throw new Error('Value is required');

        const alert = {
            asset,
            condition,
            value: parseFloat(value),
            triggered: false,
            createdAt: Date.now()
        };

        if (type === 'price') {
            this.config.priceAlerts.push(alert);
        } else if (type === 'balance') {
            alert.address = asset;
            alert.network = 'ethereum';
            this.config.balanceAlerts.push(alert);
        } else {
            throw new Error('Invalid alert type. Use: price or balance');
        }

        await PluginSettings.setCached(this.name, 'config', this.config);

        return {
            success: true,
            data: {
                message: `${type} alert created`,
                alert
            }
        };
    }

    async getPortfolio() {
        const wallet = await walletService.getWallet();
        if (!wallet) {
            throw new Error('Wallet not initialized');
        }

        const portfolio = {
            totalValue: 0,
            assets: []
        };

        for (const addr of wallet.addresses) {
            const balance = await this.getAddressBalance(addr.address, addr.network);
            const symbol = this.getNetworkSymbol(addr.network);
            const price = await this.fetchPrice(symbol);

            const value = parseFloat(balance) * (price || 0);

            portfolio.assets.push({
                type: 'native',
                network: addr.network,
                symbol,
                balance,
                price,
                value
            });

            portfolio.totalValue += value;
        }

        portfolio.assets.sort((a, b) => b.value - a.value);

        return {
            success: true,
            data: portfolio
        };
    }

    async getGasPrices(params) {
        const ethers = await getEthers();
        const { network = 'ethereum' } = params;

        const provider = contractService.getProvider(network);
        const feeData = await provider.getFeeData();
        const block = await provider.getBlock('latest');

        const gasPrice = feeData.gasPrice;
        const slow = gasPrice * 90n / 100n;
        const fast = gasPrice * 110n / 100n;

        return {
            success: true,
            data: {
                network,
                gasPrice: {
                    slow: ethers.formatUnits(slow, 'gwei') + ' Gwei',
                    standard: ethers.formatUnits(gasPrice, 'gwei') + ' Gwei',
                    fast: ethers.formatUnits(fast, 'gwei') + ' Gwei'
                },
                baseFee: block.baseFeePerGas
                    ? ethers.formatUnits(block.baseFeePerGas, 'gwei') + ' Gwei'
                    : 'N/A',
                blockNumber: block.number
            }
        };
    }

    async checkDeFi() {
        return {
            success: true,
            data: {
                message: 'DeFi integration coming soon',
                protocols: ['Uniswap', 'Aave', 'Compound', 'MakerDAO', 'PancakeSwap']
            }
        };
    }

    getNetworkSymbol(network) {
        const symbols = {
            'ethereum': 'ETH',
            'bsc': 'BNB',
            'polygon': 'MATIC',
            'base': 'ETH',
            'bitcoin': 'BTC'
        };
        return symbols[network] || 'ETH';
    }

    async extractParameters(input, action) {
        const prompt = `Extract parameters from: "${input}"
        For cryptoMonitor plugin action: ${action}

        Based on the action type:
        - getPrice: extract symbol (crypto ticker like BTC, ETH), currency (fiat like USD, EUR)
        - monitorWallet: extract action (start/stop/status), address (hex, optional)
        - setAlert: extract type (price/balance), asset (symbol or address), condition (above/below), value (number)
        - getPortfolio: extract detailed (boolean, optional)
        - getGasPrices: extract network (ethereum/bsc/polygon)
        - checkDeFi: extract protocol (string, optional)

        Return JSON with appropriate parameters.`;

        const response = await this.agent.providerManager.generateResponse(prompt, {
            temperature: 0.3,
            maxTokens: 200
        });

        try {
            return JSON.parse(response.content);
        } catch (error) {
            this.logger.warn('Failed to parse AI parameters:', error);
            return {};
        }
    }

    async getAICapabilities() {
        return {
            enabled: true,
            examples: this.commands.flatMap(cmd => cmd.examples || [])
        };
    }

    async cleanup() {
        this.logger.info(`Cleaning up ${this.name} plugin...`);

        this.monitoringIntervals.forEach(interval => clearInterval(interval));
        this.monitoringIntervals.clear();

        this.priceCache.clear();
        this.balanceCache.clear();
        await PluginSettings.clearCache(this.name);
        this.initialized = false;
    }

    getCommands() {
        return this.commands.reduce((acc, cmd) => {
            acc[cmd.command] = cmd.description;
            return acc;
        }, {});
    }
}
