import { cryptoLogger as logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import walletService from './walletService.js';
import { decrypt } from '../../utils/encryption.js';
import AgenticCommerceJob from '../../models/AgenticCommerceJob.js';

// Minimal ABI for the AgenticCommerceJob contract
// ABI for SkynetDiamond CommerceFacet
const JOB_CONTRACT_ABI = [
    'function createJob(address provider, address evaluator, uint256 expiredAt, string description, address paymentToken) external returns (uint256)',
    'function fundJob(uint256 jobId, uint256 budget) external payable',
    'function submitJob(uint256 jobId, bytes32 deliverable) external',
    'function completeJob(uint256 jobId, bytes32 reason) external',
    'function rejectJob(uint256 jobId, bytes32 reason) external',
    'function claimRefund(uint256 jobId) external',
    'function getJob(uint256 jobId) external view returns (address client, address provider, address evaluator, address paymentToken, uint256 budget, uint256 expiredAt, string description, bytes32 deliverable, uint8 status)',
    'function getJobsByProvider(address provider) external view returns (uint256[])',
    'function getJobsByClient(address client) external view returns (uint256[])',
    'function getJobCount() external view returns (uint256)',
    'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, uint256 budget, string description)',
    'event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)',
    'event JobSubmitted(uint256 indexed jobId, bytes32 deliverable)',
    'event JobCompleted(uint256 indexed jobId, bytes32 reason)',
    'event JobRejected(uint256 indexed jobId, bytes32 reason)',
    'event RefundClaimed(uint256 indexed jobId, address indexed client, uint256 amount)'
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
];

// Status enum matching the Solidity contract
const STATUS_MAP = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];

// Service pricing (BNB)
const SERVICE_PRICING = {
    'youtube-video': { price: '0.001', evaluator: 'self', delivery: 'file' },
    'youtube-audio': { price: '0.0008', evaluator: 'self', delivery: 'file' },
    'transcode': { price: '0.002', evaluator: 'self', delivery: 'file' },
    'image-gen': { price: '0.003', evaluator: 'self', delivery: 'file' },
    'web-scrape': { price: '0.0005', evaluator: 'self', delivery: 'json' },
    'document-process': { price: '0.001', evaluator: 'self', delivery: 'json' }
};

class AgenticCommerceService {
    constructor() {
        this.contractAddress = null;
        this.network = 'bsc';
        this.providerAddress = null;
        this._eventListener = null;
        this._initialized = false;
    }

    async initialize() {
        try {
            const { SystemSettings } = await import('../../models/SystemSettings.js');
            this.contractAddress = await SystemSettings.getSetting(
                'agentic_commerce_address',
                process.env.AGENTIC_COMMERCE_ADDRESS || ''
            );

            if (!this.contractAddress) {
                logger.info('AgenticCommerceService: No contract address configured — service disabled');
                return;
            }

            // Get our wallet address as provider identity
            const wallet = await walletService.getWallet();
            if (wallet?.addresses?.evm) {
                this.providerAddress = wallet.addresses.evm;
            }

            this._initialized = true;
            logger.info(`AgenticCommerceService initialized: contract=${this.contractAddress}, provider=${this.providerAddress}`);

            // Start event listener for Mode B (contract-initiated jobs)
            this.startEventListener().catch(err =>
                logger.error(`Failed to start event listener: ${err.message}`)
            );
        } catch (err) {
            logger.error(`AgenticCommerceService init failed: ${err.message}`);
        }
    }

    async _getContract(signerOrProvider) {
        const ethers = await import('ethers');
        return new ethers.Contract(this.contractAddress, JOB_CONTRACT_ABI, signerOrProvider);
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

    // --- Service Catalog ---

    getAvailableServices() {
        return Object.entries(SERVICE_PRICING).map(([type, config]) => ({
            serviceType: type,
            price: config.price,
            currency: 'BNB',
            evaluator: config.evaluator,
            deliveryType: config.delivery
        }));
    }

    getServicePrice(serviceType) {
        return SERVICE_PRICING[serviceType] || null;
    }

    // --- Provider Operations (this agent as service provider) ---

    /**
     * Create a job on-chain (Mode A — API-initiated by external agent)
     */
    async createJobForClient(clientAddress, serviceType, serviceParams, expiryHours = 24) {
        if (!this._initialized) throw new Error('Service not initialized');

        const pricing = this.getServicePrice(serviceType);
        if (!pricing) throw new Error(`Unknown service type: ${serviceType}`);

        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const expiredAt = Math.floor(Date.now() / 1000) + (expiryHours * 3600);
        const description = `${serviceType}:${ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(serviceParams)))}`;

        // Self-evaluation for Phase 1
        const evaluator = this.providerAddress;
        const paymentToken = ethers.ZeroAddress; // address(0) = BNB payment

        const tx = await contract.createJob(
            this.providerAddress,
            evaluator,
            expiredAt,
            description,
            paymentToken
        );
        const receipt = await tx.wait();

        // Parse JobCreated event to get jobId
        const event = receipt.logs.find(log => {
            try {
                const parsed = contract.interface.parseLog(log);
                return parsed?.name === 'JobCreated';
            } catch { return false; }
        });

        const parsedEvent = contract.interface.parseLog(event);
        const jobId = Number(parsedEvent.args[0]);

        // Save to MongoDB
        const job = await AgenticCommerceJob.create({
            jobId,
            txHash: receipt.hash,
            client: clientAddress,
            provider: this.providerAddress,
            evaluator,
            serviceType,
            serviceParams,
            paymentToken: 'BNB',
            budget: ethers.parseEther(pricing.price).toString(),
            budgetFormatted: parseFloat(pricing.price),
            expiredAt: new Date(expiredAt * 1000),
            status: 'Open',
            mode: 'A'
        });

        logger.info(`Job #${jobId} created for client ${clientAddress}: ${serviceType} (${pricing.price} BNB)`);

        return {
            jobId,
            txHash: receipt.hash,
            budget: pricing.price,
            currency: 'BNB',
            serviceType,
            expiredAt: new Date(expiredAt * 1000),
            fundingInstructions: `Call fund(${jobId}, ${ethers.parseEther(pricing.price)}, "0x") on contract ${this.contractAddress} with ${pricing.price} BNB`
        };
    }

    /**
     * Handle job funding confirmation — triggers execution
     */
    async handleJobFunded(jobId) {
        const job = await AgenticCommerceJob.findOne({ jobId });
        if (!job) {
            logger.warn(`Funded event for unknown job #${jobId}`);
            return;
        }

        job.status = 'Funded';
        job.executionStarted = new Date();
        await job.save();

        logger.info(`Job #${jobId} funded — executing ${job.serviceType}`);

        // Execute the service
        try {
            const result = await this.executeJob(jobId);
            return result;
        } catch (err) {
            logger.error(`Job #${jobId} execution failed: ${err.message}`);
            job.status = 'Funded'; // keep funded, can retry
            job.errorMessage = err.message;
            await job.save();

            // Track failure for trust downgrade
            await this._updateTrustForJob(job, false);
            throw err;
        }
    }

    /**
     * Execute a job — route to the appropriate service handler
     */
    async executeJob(jobId) {
        const job = await AgenticCommerceJob.findOne({ jobId });
        if (!job) throw new Error(`Job #${jobId} not found`);

        logger.info(`Executing job #${jobId}: ${job.serviceType}`);

        let result;
        try {
            // Route to existing plugin/service handlers
            switch (job.serviceType) {
                case 'youtube-video':
                case 'youtube-audio':
                    result = await this._executeYoutubeJob(job);
                    break;
                case 'web-scrape':
                    result = await this._executeScrapeJob(job);
                    break;
                case 'transcode':
                    result = await this._executeTranscodeJob(job);
                    break;
                case 'image-gen':
                    result = await this._executeImageGenJob(job);
                    break;
                case 'document-process':
                    result = await this._executeDocumentJob(job);
                    break;
                default:
                    throw new Error(`No handler for service type: ${job.serviceType}`);
            }
        } catch (err) {
            job.errorMessage = err.message;
            await job.save();
            throw err;
        }

        // Submit deliverable on-chain
        const ethers = await import('ethers');
        const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(result)));
        await this.submitDeliverable(jobId, deliverableHash);

        // Update job record
        job.deliverableHash = deliverableHash;
        job.deliverableType = result.type || 'json';
        job.deliverableData = result;
        job.executionCompleted = new Date();
        await job.save();

        // Self-evaluate and complete (Phase 1)
        await this.selfEvaluateAndComplete(jobId);

        return result;
    }

    /**
     * Submit deliverable hash on-chain
     */
    async submitDeliverable(jobId, deliverableHash) {
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const tx = await contract.submitJob(jobId, deliverableHash);
        await tx.wait();

        await AgenticCommerceJob.updateOne({ jobId }, { status: 'Submitted', deliverableHash });
        logger.info(`Job #${jobId} deliverable submitted: ${deliverableHash}`);
    }

    /**
     * Self-evaluate and complete job (for instant services in Phase 1)
     */
    async selfEvaluateAndComplete(jobId) {
        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const reason = ethers.keccak256(ethers.toUtf8Bytes('self-evaluation:success'));
        const tx = await contract.completeJob(jobId, reason);
        await tx.wait();

        const job = await AgenticCommerceJob.findOne({ jobId });
        if (job) {
            job.status = 'Completed';
            job.reason = 'self-evaluation:success';
            await job.save();

            // Track revenue
            await this._trackRevenue(job);

            // Update trust for the counterparty after successful job completion
            await this._updateTrustForJob(job, true);
        }

        logger.info(`Job #${jobId} completed (self-evaluated)`);
    }

    /**
     * Update trust registry after job completion or failure
     */
    async _updateTrustForJob(job, success) {
        try {
            const trustRegistry = (await import('./trustRegistryService.js')).default;
            if (!trustRegistry._initialized) return;

            // Determine counterparty ENS — use client address as pseudo-ENS if no ENS name known
            const agentName = process.env.AGENT_NAME || 'LANAgent';
            const counterpartyAddress = job.client;
            // Convention: address-based pseudo-ENS for agents without registered names
            const counterpartyENS = job.clientENS || `${counterpartyAddress.toLowerCase()}.addr.lanagent.eth`;

            await trustRegistry.updateTrustFromJobCompletion(counterpartyENS, success);
            logger.info(`Trust updated for ${counterpartyENS} after job #${job.jobId} (success=${success})`);
        } catch (err) {
            logger.warn(`Trust update failed for job #${job.jobId}: ${err.message}`);
        }
    }

    // --- Client Operations (this agent hiring other agents) ---

    async createJob(providerAddress, evaluatorAddress, description, budget, expiryHours = 24) {
        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const expiredAt = Math.floor(Date.now() / 1000) + (expiryHours * 3600);

        const tx = await contract.createJob(
            providerAddress,
            evaluatorAddress || ethers.ZeroAddress,
            expiredAt,
            description,
            ethers.ZeroAddress
        );
        const receipt = await tx.wait();

        const event = receipt.logs.find(log => {
            try {
                return contract.interface.parseLog(log)?.name === 'JobCreated';
            } catch { return false; }
        });
        const parsedEvent = contract.interface.parseLog(event);
        const jobId = Number(parsedEvent.args[0]);

        logger.info(`Created job #${jobId} as client: provider=${providerAddress}, budget=${budget}`);
        return { jobId, txHash: receipt.hash };
    }

    async fundJob(jobId, amount) {
        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const amountWei = ethers.parseEther(amount.toString());
        const tx = await contract.fundJob(jobId, amountWei, { value: amountWei });
        await tx.wait();

        logger.info(`Funded job #${jobId} with ${amount} BNB`);
        return { jobId, txHash: tx.hash };
    }

    // --- Event Monitoring (Mode B) ---

    async startEventListener() {
        if (!this._initialized || !this.contractAddress) return;

        try {
            const provider = await contractServiceWrapper.getProvider(this.network);
            const ethers = await import('ethers');
            const contract = new ethers.Contract(this.contractAddress, JOB_CONTRACT_ABI, provider);

            // Listen for jobs where we're the provider
            contract.on('JobFunded', async (jobId, client, amount) => {
                try {
                    const id = Number(jobId);
                    const onChainJob = await contract.getJob(id);
                    if (onChainJob.provider.toLowerCase() === this.providerAddress?.toLowerCase()) {
                        logger.info(`Event: Job #${id} funded by ${client} (${ethers.formatEther(amount)} BNB)`);
                        await this.handleJobFunded(id);
                    }
                } catch (err) {
                    logger.error(`Error handling JobFunded event: ${err.message}`);
                }
            });

            // Listen for new jobs targeting us (Mode B — contract-initiated)
            contract.on('JobCreated', async (jobId, client, provider, budget, description) => {
                try {
                    if (provider.toLowerCase() === this.providerAddress?.toLowerCase()) {
                        const id = Number(jobId);
                        logger.info(`Event: New job #${id} created for us by ${client}: ${description}`);
                        await this._handleModeB_JobCreated(id, client, description);
                    }
                } catch (err) {
                    logger.error(`Error handling JobCreated event: ${err.message}`);
                }
            });

            this._eventListener = contract;
            logger.info('AgenticCommerce event listener started');
        } catch (err) {
            logger.error(`Event listener failed: ${err.message}`);
        }
    }

    async _handleModeB_JobCreated(jobId, clientAddress, description) {
        // Parse service type from description (format: "serviceType:paramsHash")
        const [serviceType, paramsHash] = description.split(':');
        const pricing = this.getServicePrice(serviceType);

        if (!pricing) {
            logger.warn(`Mode B: Unknown service type "${serviceType}" in job #${jobId} — ignoring`);
            return;
        }

        // Check scammer registry
        try {
            const scammerRegistry = (await import('./scammerRegistryService.js')).default;
            if (scammerRegistry.isAddressFlagged(clientAddress)) {
                logger.warn(`Mode B: Rejecting job #${jobId} — client ${clientAddress} is flagged`);
                return;
            }
        } catch { /* registry not available */ }

        // Save job to DB for tracking
        await AgenticCommerceJob.create({
            jobId,
            client: clientAddress,
            provider: this.providerAddress,
            serviceType,
            serviceParams: { paramsHash },
            status: 'Open',
            mode: 'B'
        });

        logger.info(`Mode B: Accepted job #${jobId} (${serviceType}) — awaiting funding`);
    }

    // --- Service Execution Handlers ---

    async _executeYoutubeJob(job) {
        // Delegate to existing youtube/ytdlp plugin
        const pluginManager = (await import('../../api/pluginManager.js')).default;
        const action = job.serviceType === 'youtube-audio' ? 'audio' : 'video';
        const result = await pluginManager.executePlugin('ytdlp', action, job.serviceParams);
        return { type: 'file', ...result };
    }

    async _executeScrapeJob(job) {
        const pluginManager = (await import('../../api/pluginManager.js')).default;
        const result = await pluginManager.executePlugin('scraper', 'scrape', job.serviceParams);
        return { type: 'json', ...result };
    }

    async _executeTranscodeJob(job) {
        const pluginManager = (await import('../../api/pluginManager.js')).default;
        const result = await pluginManager.executePlugin('ffmpeg', 'transcode', job.serviceParams);
        return { type: 'file', ...result };
    }

    async _executeImageGenJob(job) {
        const pluginManager = (await import('../../api/pluginManager.js')).default;
        const result = await pluginManager.executePlugin('image-generation', 'generate', job.serviceParams);
        return { type: 'file', ...result };
    }

    async _executeDocumentJob(job) {
        const pluginManager = (await import('../../api/pluginManager.js')).default;
        const result = await pluginManager.executePlugin('document-intelligence', 'process', job.serviceParams);
        return { type: 'json', ...result };
    }

    // --- Revenue Tracking ---

    async _trackRevenue(job) {
        try {
            const revenueService = (await import('./revenueService.js')).default;
            await revenueService.trackRevenue({
                source: 'erc8183-job',
                amount: job.budgetFormatted,
                currency: job.paymentToken,
                serviceType: job.serviceType,
                jobId: job.jobId,
                client: job.client
            });
            job.revenueTracked = true;
            await job.save();
        } catch (err) {
            logger.error(`Revenue tracking failed for job #${job.jobId}: ${err.message}`);
        }
    }

    // --- Query Methods ---

    async getActiveJobs() {
        return AgenticCommerceJob.getActiveJobs();
    }

    async getJobHistory(filters = {}) {
        return AgenticCommerceJob.getJobHistory(filters);
    }

    async getRevenueStats(days = 30) {
        const since = new Date(Date.now() - days * 86400000);
        return AgenticCommerceJob.getRevenueStats(since);
    }

    async getJobStatus(jobId) {
        const job = await AgenticCommerceJob.findOne({ jobId });
        if (!job) {
            // Try on-chain
            if (this._initialized) {
                const provider = await contractServiceWrapper.getProvider(this.network);
                const contract = await this._getContract(provider);
                const onChain = await contract.getJob(jobId);
                return {
                    jobId,
                    status: STATUS_MAP[Number(onChain.status)] || 'Unknown',
                    client: onChain.client,
                    provider: onChain.provider,
                    source: 'on-chain'
                };
            }
            return null;
        }
        return job;
    }
}

export default new AgenticCommerceService();
