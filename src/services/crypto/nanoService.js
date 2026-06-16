import { cryptoLogger as logger } from '../../utils/logger.js';
import { decrypt } from '../../utils/encryption.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';

const RPC_ENDPOINTS = [
    'https://rainstorm.city/api',
    'https://node.somenano.com/proxy',
    'https://rpc.nano.to'
];

const DEFAULT_REPRESENTATIVE = 'nano_1banexkcfuieufzxksfrxqf6xy8e57ry1zdtq9yn7jntzhpwu4pg4hajojmq';

const balanceCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });

class NanoService {
    constructor() {
        this.nanoLib = null;
        this.rpcIndex = 0;
        this.receivableMonitor = null;
        this.monitorAddress = null;
    }

    async loadLibrary() {
        if (this.nanoLib) return this.nanoLib;
        this.nanoLib = await import('nanocurrency-web');
        logger.info('nanocurrency-web loaded');
        return this.nanoLib;
    }

    async rpcCall(action, params = {}) {
        const body = JSON.stringify({ action, ...params });
        let lastError;

        // These are valid Nano RPC errors, not network failures - don't failover
        const KNOWN_RPC_ERRORS = ['Account not found', 'Account not opened', 'Block not found'];

        for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt++) {
            const url = RPC_ENDPOINTS[(this.rpcIndex + attempt) % RPC_ENDPOINTS.length];
            try {
                // Custom retry with exponential backoff for 429 rate limits
                const MAX_RETRIES = 4;
                let retryDelay = 2000; // start at 2s
                for (let retry = 0; retry <= MAX_RETRIES; retry++) {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body,
                        signal: AbortSignal.timeout(30000)
                    });

                    // Handle 429 rate limiting with exponential backoff
                    if (res.status === 429) {
                        if (retry < MAX_RETRIES) {
                            const retryAfter = res.headers.get('retry-after');
                            const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay;
                            logger.warn(`Nano RPC ${url} rate limited (429) for ${action}, waiting ${waitMs}ms (retry ${retry + 1}/${MAX_RETRIES})`);
                            await new Promise(r => setTimeout(r, waitMs));
                            retryDelay *= 2; // exponential backoff
                            continue;
                        }
                        throw new Error(`RPC HTTP 429 - rate limited after ${MAX_RETRIES} retries`);
                    }

                    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
                    const data = await res.json();
                    if (data.error) {
                        // Handle numeric error codes (e.g., rpc.nano.to returns {error:429, message:"..."})
                        const errMsg = typeof data.error === 'number' ? (data.message || `Error ${data.error}`) : data.error;
                        const err = new Error(errMsg);
                        err.isRpcError = true;
                        // Rate limit errors from the RPC body should failover to next endpoint
                        if (data.error === 429 || errMsg.includes('API key required')) {
                            throw err; // will be caught and failover
                        }
                        throw err;
                    }

                    this.rpcIndex = (this.rpcIndex + attempt) % RPC_ENDPOINTS.length;
                    return data;
                }
            } catch (err) {
                // Known RPC errors are valid responses - propagate immediately
                if (err.isRpcError && KNOWN_RPC_ERRORS.some(e => err.message.includes(e))) {
                    throw err;
                }
                lastError = err;
                logger.warn(`Nano RPC ${url} failed for ${action}: ${err.message}`);
            }
        }
        throw new Error(`All Nano RPC endpoints failed for ${action}: ${lastError?.message}`);
    }

    async getBalance(address) {
        const cached = balanceCache.get(`balance:${address}`);
        if (cached !== undefined) return cached;

        try {
            const data = await this.rpcCall('account_balance', { account: address });
            const lib = await this.loadLibrary();
            const balance = lib.tools.convert(data.balance, 'RAW', 'NANO');
            balanceCache.set(`balance:${address}`, balance);
            return balance;
        } catch (err) {
            if (err.message.includes('Account not found')) return '0';
            throw err;
        }
    }

    async getAccountInfo(address) {
        try {
            const data = await this.rpcCall('account_info', {
                account: address,
                representative: 'true',
                weight: 'true',
                pending: 'true'
            });
            const lib = await this.loadLibrary();
            return {
                frontier: data.frontier,
                balance: lib.tools.convert(data.balance, 'RAW', 'NANO'),
                balanceRaw: data.balance,
                representative: data.representative,
                blockCount: data.block_count,
                pending: data.pending,
                opened: true
            };
        } catch (err) {
            if (err.message.includes('Account not found')) {
                return { opened: false, balance: '0', balanceRaw: '0', blockCount: '0' };
            }
            throw err;
        }
    }

    async generateWork(hash) {
        const data = await this.rpcCall('work_generate', {
            hash,
            difficulty: 'fffffff800000000'
        });
        return data.work;
    }

    async getPrivateKey() {
        const CryptoWallet = (await import('../../models/CryptoWallet.js')).default;
        const wallet = await CryptoWallet.findOne();
        if (!wallet || !wallet.encryptedSeed) throw new Error('No wallet found');

        const mnemonic = decrypt(wallet.encryptedSeed);
        const lib = await this.loadLibrary();
        const nanoWallet = lib.wallet.fromMnemonic(mnemonic);
        return nanoWallet.accounts[0].privateKey;
    }

    async send(fromAddress, toAddress, amountNano) {
        const lib = await this.loadLibrary();

        if (!lib.tools.validateAddress(toAddress)) {
            throw new Error('Invalid Nano destination address');
        }

        const accountInfo = await this.getAccountInfo(fromAddress);
        if (!accountInfo.opened) throw new Error('Account not opened yet (no balance)');

        const amountRaw = lib.tools.convert(amountNano.toString(), 'NANO', 'RAW');
        const balanceRaw = accountInfo.balanceRaw;

        if (BigInt(amountRaw) > BigInt(balanceRaw)) {
            throw new Error(`Insufficient balance: have ${accountInfo.balance} NANO, trying to send ${amountNano} NANO`);
        }

        const work = await this.generateWork(accountInfo.frontier);
        const privateKey = await this.getPrivateKey();

        const signed = lib.block.send({
            walletBalanceRaw: balanceRaw,
            fromAddress,
            toAddress,
            representativeAddress: accountInfo.representative || DEFAULT_REPRESENTATIVE,
            frontier: accountInfo.frontier,
            amountRaw,
            work
        }, privateKey);

        const result = await this.rpcCall('process', {
            json_block: 'true',
            subtype: 'send',
            block: signed
        });

        balanceCache.del(`balance:${fromAddress}`);
        logger.info(`Nano send: ${amountNano} XNO to ${toAddress}, hash: ${result.hash}`);

        return {
            hash: result.hash,
            amount: amountNano,
            to: toAddress,
            from: fromAddress
        };
    }

    async receiveAll(address) {
        const receivable = await this.getReceivable(address);
        if (!receivable.blocks || receivable.blocks.length === 0) {
            return { received: 0, blocks: [] };
        }

        const lib = await this.loadLibrary();
        const privateKey = await this.getPrivateKey();
        const results = [];

        for (const pending of receivable.blocks) {
            try {
                let accountInfo = await this.getAccountInfo(address);
                let workHash;

                if (!accountInfo.opened) {
                    // First block on unopened account: work on public key
                    workHash = lib.tools.addressToPublicKey(address);
                    accountInfo.frontier = '0'.repeat(64);
                    accountInfo.balanceRaw = '0';
                } else {
                    workHash = accountInfo.frontier;
                }

                const work = await this.generateWork(workHash);

                const signed = lib.block.receive({
                    walletBalanceRaw: accountInfo.balanceRaw,
                    toAddress: address,
                    transactionHash: pending.hash,
                    frontier: accountInfo.frontier,
                    representativeAddress: accountInfo.representative || DEFAULT_REPRESENTATIVE,
                    amountRaw: pending.amountRaw,
                    work
                }, privateKey);

                const result = await this.rpcCall('process', {
                    json_block: 'true',
                    subtype: 'receive',
                    block: signed
                });

                results.push({ hash: result.hash, amount: pending.amount, sourceHash: pending.hash });
                logger.info(`Nano received: ${pending.amount} XNO, hash: ${result.hash}`);
            } catch (err) {
                logger.error(`Failed to receive block ${pending.hash}: ${err.message}`);
                results.push({ error: err.message, sourceHash: pending.hash });
            }
        }

        balanceCache.del(`balance:${address}`);
        return { received: results.filter(r => r.hash).length, blocks: results };
    }

    async getReceivable(address) {
        try {
            const data = await this.rpcCall('receivable', {
                account: address,
                count: '20',
                threshold: '1',
                source: 'true'
            });

            if (!data.blocks || typeof data.blocks !== 'object' || Object.keys(data.blocks).length === 0) {
                return { blocks: [], count: 0 };
            }

            const lib = await this.loadLibrary();
            const blocks = Object.entries(data.blocks).map(([hash, info]) => {
                const amountRaw = typeof info === 'string' ? info : info.amount;
                return {
                    hash,
                    amountRaw,
                    amount: lib.tools.convert(amountRaw, 'RAW', 'NANO'),
                    source: typeof info === 'object' ? info.source : null
                };
            });

            return { blocks, count: blocks.length };
        } catch (err) {
            if (err.message.includes('Account not found')) return { blocks: [], count: 0 };
            throw err;
        }
    }

    startReceivableMonitor(address) {
        if (this.receivableMonitor) return;
        this.monitorAddress = address;

        logger.info(`Starting Nano receivable monitor for ${address}`);

        this.receivableMonitor = setInterval(async () => {
            try {
                const receivable = await this.getReceivable(address);
                if (receivable.count > 0) {
                    logger.info(`Found ${receivable.count} receivable Nano blocks, pocketing...`);
                    await this.receiveAll(address);
                }
            } catch (err) {
                logger.error('Nano receivable monitor error:', err.message);
            }
        }, 5 * 60 * 1000); // 5 minutes
    }

    stopReceivableMonitor() {
        if (this.receivableMonitor) {
            clearInterval(this.receivableMonitor);
            this.receivableMonitor = null;
            logger.info('Nano receivable monitor stopped');
        }
    }

    getStatus() {
        return {
            rpcEndpoints: RPC_ENDPOINTS,
            currentRpc: RPC_ENDPOINTS[this.rpcIndex],
            monitorRunning: !!this.receivableMonitor,
            monitorAddress: this.monitorAddress,
            representative: DEFAULT_REPRESENTATIVE
        };
    }
}

export default new NanoService();
