import { cryptoLogger as logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import walletService from './walletService.js';
import { decrypt } from '../../utils/encryption.js';
import OracleParticipation from '../../models/OracleParticipation.js';
import crypto from 'crypto';

// Minimal ABI for ERC-8033 Agent Council Oracle contract
// ABI for SkynetDiamond OracleFacet
const ORACLE_CONTRACT_ABI = [
    'function oracleCommit(uint256 requestId, bytes32 commitHash) external payable',
    'function oracleReveal(uint256 requestId, bytes answer, uint256 nonce) external',
    'function oracleResolve(uint256 requestId, address[] winners, bytes finalAnswer, bytes reasoning) external',
    'function createOracleRequest(string query, string[] domains, uint256 numInfoAgents, uint256 bondAmount, address paymentToken, uint256 commitDuration, uint256 revealDuration, uint256 judgeDuration, address judge) external payable returns (uint256)',
    'function getOracleRequestCount() external view returns (uint256)',
    'function getOraclePhase(uint256 requestId) external view returns (uint8)',
    'function setOracleJudge(uint256 requestId, address newJudge) external',
    'event OracleRequestCreated(uint256 indexed requestId, address requester, string query, uint256 rewardAmount, uint256 bondAmount)',
    'event OracleCommitted(uint256 indexed requestId, address indexed agent)',
    'event OracleRevealed(uint256 indexed requestId, address indexed agent)',
    'event OracleResolved(uint256 indexed requestId, bytes finalAnswer)'
];

// Agent oracle capabilities (applies to any LANAgent instance)
const AGENT_CAPABILITIES = {
    capabilities: ['text', 'code', 'data-analysis', 'web-scraping'],
    domains: [
        'crypto-security',
        'defi-protocols',
        'token-analysis',
        'web-intelligence',
        'network-security',
        'document-processing'
    ]
};

// Risk management defaults
const DEFAULT_CONFIG = {
    maxBondPerRequest: '0.01',       // BNB
    maxTotalExposure: '0.1',         // BNB
    minRewardRatio: 2,               // reward must be >= 2x bond
    maxConcurrentRequests: 5,
    minConfidenceThreshold: 0.7,
    skipDomains: [],
    enabled: true
};

class OracleAgentService {
    constructor() {
        this.contractAddress = null;
        this.network = 'bsc';
        this._initialized = false;
        this._eventListener = null;
        this.config = { ...DEFAULT_CONFIG };
    }

    async initialize() {
        try {
            const { SystemSettings } = await import('../../models/SystemSettings.js');
            this.contractAddress = await SystemSettings.getSetting(
                'oracle_contract_address',
                process.env.ORACLE_CONTRACT_ADDRESS || ''
            );

            if (!this.contractAddress) {
                logger.info('OracleAgentService: No contract address configured — service disabled');
                return;
            }

            // Load config overrides
            const savedConfig = await SystemSettings.getSetting('oracle_config', null);
            if (savedConfig) {
                this.config = { ...DEFAULT_CONFIG, ...JSON.parse(savedConfig) };
            }

            this._initialized = true;
            logger.info(`OracleAgentService initialized: contract=${this.contractAddress}`);

            if (this.config.enabled) {
                this.startEventListener().catch(err =>
                    logger.error(`Oracle event listener failed: ${err.message}`)
                );
            }
        } catch (err) {
            logger.error(`OracleAgentService init failed: ${err.message}`);
        }
    }

    async _getContract(signerOrProvider) {
        const ethers = await import('ethers');
        return new ethers.Contract(this.contractAddress, ORACLE_CONTRACT_ABI, signerOrProvider);
    }

    async _getSigner() {
        const ethers = await import('ethers');
        const wallet = await walletService.getWallet();
        if (!wallet) throw new Error('Wallet not initialized');
        const mnemonic = decrypt(wallet.encryptedSeed);
        const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);
        const provider = await contractServiceWrapper.getProvider(this.network);
        return derivedWallet.connect(provider);
    }

    // --- Event Monitoring ---

    async startEventListener() {
        if (!this._initialized || !this.contractAddress) return;

        try {
            const provider = await contractServiceWrapper.getProvider(this.network);
            const ethers = await import('ethers');
            const contract = new ethers.Contract(this.contractAddress, ORACLE_CONTRACT_ABI, provider);

            contract.on('RequestCreated', async (requestId, requester, query, rewardAmount, numInfoAgents, bondAmount) => {
                try {
                    const id = Number(requestId);
                    logger.info(`Oracle: New request #${id}: "${query.slice(0, 100)}..." (reward: ${ethers.formatEther(rewardAmount)} BNB)`);

                    // Fetch full request details from split view functions
                    const [reqCore, reqTimings, reqDomains] = await Promise.all([
                        contract.getRequest(id),
                        contract.getRequestTimings(id),
                        contract.getRequestDomains(id)
                    ]);
                    const request = {
                        requester: reqCore.requester,
                        query: reqCore.query,
                        rewardAmount: reqCore.rewardAmount,
                        numInfoAgents: reqCore.numInfoAgents,
                        bondAmount: reqCore.bondAmount,
                        phase: reqCore.phase,
                        judge: reqCore.judge,
                        commitDeadline: reqTimings.commitDeadline,
                        revealDeadline: reqTimings.revealDeadline,
                        judgeDeadline: reqTimings.judgeDeadline,
                        requiredCapabilities: { domains: reqDomains }
                    };
                    const shouldParticipate = await this.evaluateRequest(request, id);

                    if (shouldParticipate) {
                        await this._participateInRequest(id, request);
                    }
                } catch (err) {
                    logger.error(`Error handling RequestCreated: ${err.message}`);
                }
            });

            // Listen for judge selection
            contract.on('JudgeSelected', async (requestId, judge) => {
                try {
                    const wallet = await walletService.getWallet();
                    if (wallet?.addresses?.evm?.toLowerCase() === judge.toLowerCase()) {
                        const id = Number(requestId);
                        logger.info(`Oracle: Selected as judge for request #${id}`);
                        // Judge handling will be Phase 2
                    }
                } catch (err) {
                    logger.error(`Error handling JudgeSelected: ${err.message}`);
                }
            });

            // Listen for reward distribution
            contract.on('RewardsDistributed', async (requestId, winners, amounts) => {
                try {
                    const id = Number(requestId);
                    const wallet = await walletService.getWallet();
                    const ourAddr = wallet?.addresses?.evm?.toLowerCase();

                    const participation = await OracleParticipation.findOne({ requestId: id });
                    if (!participation) return;

                    const winnerAddrs = winners.map(w => w.toLowerCase());
                    const winIndex = winnerAddrs.indexOf(ourAddr);

                    if (winIndex >= 0) {
                        participation.status = 'won';
                        participation.rewardEarned = amounts[winIndex].toString();
                        logger.info(`Oracle: Won request #${id}! Reward: ${ethers.formatEther(amounts[winIndex])} BNB`);
                    } else {
                        participation.status = 'lost';
                        logger.info(`Oracle: Lost request #${id} (bond forfeited)`);
                    }

                    await participation.save();
                    await this._trackRevenue(participation);
                } catch (err) {
                    logger.error(`Error handling RewardsDistributed: ${err.message}`);
                }
            });

            this._eventListener = contract;
            logger.info('Oracle event listener started');
        } catch (err) {
            logger.error(`Oracle event listener failed: ${err.message}`);
        }
    }

    // --- Request Evaluation ---

    async evaluateRequest(request, requestId) {
        if (!this.config.enabled) return false;

        // Check domain match
        const reqDomains = request.requiredCapabilities?.domains || [];
        const reqCaps = request.requiredCapabilities?.capabilities || [];

        const domainMatch = reqDomains.length === 0 ||
            reqDomains.some(d => AGENT_CAPABILITIES.domains.includes(d));
        const capMatch = reqCaps.length === 0 ||
            reqCaps.some(c => AGENT_CAPABILITIES.capabilities.includes(c));

        if (!domainMatch || !capMatch) {
            logger.debug(`Oracle: Skipping request #${requestId} — domain/capability mismatch`);
            return false;
        }

        // Check skip domains
        if (this.config.skipDomains.some(d => reqDomains.includes(d))) {
            logger.debug(`Oracle: Skipping request #${requestId} — domain in skip list`);
            return false;
        }

        // Check bond affordability
        const ethers = await import('ethers');
        const bondAmount = parseFloat(ethers.formatEther(request.bondAmount));
        const rewardAmount = parseFloat(ethers.formatEther(request.rewardAmount));

        if (bondAmount > parseFloat(this.config.maxBondPerRequest)) {
            logger.debug(`Oracle: Skipping request #${requestId} — bond too high (${bondAmount} BNB)`);
            return false;
        }

        if (rewardAmount < bondAmount * this.config.minRewardRatio) {
            logger.debug(`Oracle: Skipping request #${requestId} — reward/bond ratio too low`);
            return false;
        }

        // Check total exposure
        const currentExposure = await this.getBondExposure();
        if (currentExposure + bondAmount > parseFloat(this.config.maxTotalExposure)) {
            logger.debug(`Oracle: Skipping request #${requestId} — would exceed exposure limit`);
            return false;
        }

        // Check concurrent limit
        const active = await OracleParticipation.getActive();
        if (active.length >= this.config.maxConcurrentRequests) {
            logger.debug(`Oracle: Skipping request #${requestId} — max concurrent reached`);
            return false;
        }

        // Check deadline
        const deadline = Number(request.deadline);
        const minTimeBuffer = 300; // 5 minutes minimum
        if (deadline < Math.floor(Date.now() / 1000) + minTimeBuffer) {
            logger.debug(`Oracle: Skipping request #${requestId} — deadline too close`);
            return false;
        }

        return true;
    }

    // --- Answer Generation ---

    async generateAnswer(requestId, query, specifications) {
        // Route to appropriate service based on detected domain
        const domain = this._detectDomain(query);
        let answer, source, confidence;

        try {
            switch (domain) {
                case 'crypto-security': {
                    // Use scammer registry + token analysis
                    const scammerRegistry = (await import('./scammerRegistryService.js')).default;
                    answer = await this._generateCryptoSecurityAnswer(query, scammerRegistry);
                    source = 'scammer-registry';
                    confidence = 0.85;
                    break;
                }
                case 'defi-protocols':
                case 'token-analysis': {
                    // Use existing crypto services
                    answer = await this._generateDeFiAnswer(query);
                    source = 'crypto-services';
                    confidence = 0.75;
                    break;
                }
                case 'web-intelligence': {
                    // Use scraper plugin
                    answer = await this._generateWebAnswer(query);
                    source = 'scraper';
                    confidence = 0.7;
                    break;
                }
                default: {
                    // Use Claude AI for general queries
                    answer = await this._generateAIAnswer(query, specifications);
                    source = 'claude-ai';
                    confidence = 0.65;
                    break;
                }
            }
        } catch (err) {
            logger.error(`Answer generation failed for request #${requestId}: ${err.message}`);
            answer = null;
            confidence = 0;
        }

        return { answer, source, confidence, domain };
    }

    _detectDomain(query) {
        const q = query.toLowerCase();
        if (q.includes('scam') || q.includes('honeypot') || q.includes('rug pull') || q.includes('phishing')) {
            return 'crypto-security';
        }
        if (q.includes('swap') || q.includes('liquidity') || q.includes('dex') || q.includes('defi') || q.includes('pancakeswap') || q.includes('uniswap')) {
            return 'defi-protocols';
        }
        if (q.includes('token') || q.includes('contract') || q.includes('0x')) {
            return 'token-analysis';
        }
        if (q.includes('scrape') || q.includes('website') || q.includes('url') || q.includes('http')) {
            return 'web-intelligence';
        }
        return 'general';
    }

    async _generateCryptoSecurityAnswer(query, scammerRegistry) {
        // Extract addresses from query and check registry
        const addressRegex = /0x[a-fA-F0-9]{40}/g;
        const addresses = query.match(addressRegex) || [];
        const results = addresses.map(addr => ({
            address: addr,
            flagged: scammerRegistry.isAddressFlagged(addr)
        }));
        return JSON.stringify({ analysis: 'crypto-security-check', addresses: results });
    }

    async _generateDeFiAnswer(query) {
        // Placeholder — will integrate with swapService for protocol-specific queries
        return JSON.stringify({ analysis: 'defi-query', query, note: 'Detailed analysis pending service integration' });
    }

    async _generateWebAnswer(query) {
        // Placeholder — will integrate with scraper plugin
        return JSON.stringify({ analysis: 'web-intelligence', query, note: 'Scraping pending plugin integration' });
    }

    async _generateAIAnswer(query, specifications) {
        // Use the NL endpoint to generate an AI answer
        try {
            const { default: agent } = await import('../../core/agent.js');
            const result = await agent.processNaturalLanguage(`Answer this oracle query concisely: ${query}. Specifications: ${specifications || 'none'}`);
            return typeof result === 'string' ? result : JSON.stringify(result);
        } catch {
            return JSON.stringify({ error: 'AI answer generation unavailable' });
        }
    }

    // --- Commit-Reveal Flow ---

    async _participateInRequest(requestId, request) {
        const ethers = await import('ethers');

        // Generate answer
        const { answer, source, confidence, domain } = await this.generateAnswer(
            requestId, request.query, request.specifications
        );

        if (!answer || confidence < this.config.minConfidenceThreshold) {
            logger.info(`Oracle: Skipping request #${requestId} — confidence too low (${confidence})`);
            return;
        }

        // Generate nonce
        const nonce = BigInt('0x' + crypto.randomBytes(32).toString('hex'));

        // Create commitment: keccak256(abi.encode(answer, nonce))
        const answerBytes = ethers.toUtf8Bytes(answer);
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes', 'uint256'],
            [answerBytes, nonce]
        );
        const commitment = ethers.keccak256(encoded);

        // Submit commitment on-chain
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const tx = await contract.oracleCommit(requestId, commitment);
        await tx.wait();

        // Save participation
        await OracleParticipation.create({
            requestId,
            role: 'info',
            query: request.query,
            domain,
            status: 'committed',
            answer,
            commitment,
            nonce: nonce.toString(),
            bondAmount: request.bondAmount.toString(),
            bondToken: request.bondToken,
            rewardAmount: request.rewardAmount.toString(),
            rewardToken: request.rewardToken,
            deadline: new Date(Number(request.deadline) * 1000),
            requester: request.requester,
            numInfoAgents: Number(request.numInfoAgents),
            commitTxHash: tx.hash,
            confidence,
            answerSource: source
        });

        logger.info(`Oracle: Committed to request #${requestId} (domain: ${domain}, confidence: ${confidence}, source: ${source})`);

        // Schedule reveal (after commit phase ends)
        // For now, we'll reveal after a delay — in production this would watch for phase transition
        this._scheduleReveal(requestId);
    }

    async _scheduleReveal(requestId) {
        // Simple approach: try to reveal after 60 seconds
        // In production, would monitor commit phase end event
        setTimeout(async () => {
            try {
                await this.revealAnswer(requestId);
            } catch (err) {
                logger.error(`Oracle: Failed to reveal for request #${requestId}: ${err.message}`);
            }
        }, 60000);
    }

    async revealAnswer(requestId) {
        const participation = await OracleParticipation.findOne({ requestId, role: 'info' });
        if (!participation || participation.status !== 'committed') return;

        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const answerBytes = ethers.toUtf8Bytes(participation.answer);
        const nonce = BigInt(participation.nonce);

        const tx = await contract.oracleReveal(requestId, answerBytes, nonce);
        await tx.wait();

        participation.status = 'revealed';
        participation.revealTxHash = tx.hash;
        await participation.save();

        logger.info(`Oracle: Revealed answer for request #${requestId}`);
    }

    // --- Bond Management ---

    async getBondExposure() {
        const ethers = await import('ethers');
        const active = await OracleParticipation.find({
            status: { $in: ['committed', 'revealed'] }
        });
        return active.reduce((sum, p) => sum + parseFloat(ethers.formatEther(p.bondAmount || '0')), 0);
    }

    // --- Revenue Tracking ---

    async _trackRevenue(participation) {
        if (participation.status !== 'won' || participation.revenueTracked) return;

        try {
            const revenueService = (await import('./revenueService.js')).default;
            const ethers = await import('ethers');
            await revenueService.trackRevenue({
                source: 'erc8033-oracle',
                amount: parseFloat(ethers.formatEther(participation.rewardEarned || '0')),
                currency: 'BNB',
                role: participation.role,
                requestId: participation.requestId,
                domain: participation.domain
            });
            participation.revenueTracked = true;
            await participation.save();
        } catch (err) {
            logger.error(`Oracle revenue tracking failed: ${err.message}`);
        }
    }

    // --- Query Methods ---

    async getActiveParticipations() {
        return OracleParticipation.getActive();
    }

    async getHistory(limit = 50) {
        return OracleParticipation.find().sort({ createdAt: -1 }).limit(limit);
    }

    async getWinRate() {
        const result = await OracleParticipation.getWinRate();
        return result[0] || { total: 0, wins: 0, winRate: 0 };
    }

    async getEarningsStats(days = 30) {
        const since = new Date(Date.now() - days * 86400000);
        return OracleParticipation.getEarningsStats(since);
    }

    getCapabilities() {
        return AGENT_CAPABILITIES;
    }

    async getStats() {
        const [winRate, exposure, active, earnings] = await Promise.all([
            this.getWinRate(),
            this.getBondExposure(),
            OracleParticipation.getActive(),
            this.getEarningsStats()
        ]);
        return {
            winRate,
            currentExposure: exposure,
            activeCount: active.length,
            earnings,
            config: this.config
        };
    }

    // --- Config ---

    async updateConfig(updates) {
        this.config = { ...this.config, ...updates };
        try {
            const { SystemSettings } = await import('../../models/SystemSettings.js');
            await SystemSettings.setSetting('oracle_config', JSON.stringify(this.config));
        } catch (err) {
            logger.error(`Failed to save oracle config: ${err.message}`);
        }
        return this.config;
    }

    async pause() { return this.updateConfig({ enabled: false }); }
    async resume() { return this.updateConfig({ enabled: true }); }
}

export default new OracleAgentService();
