import { cryptoLogger as logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import walletService from './walletService.js';
import { decrypt } from '../../utils/encryption.js';
import AgentCoordination from '../../models/AgentCoordination.js';

// ERC-8001 Agent Coordination contract ABI
// ABI for SkynetDiamond CoordinationFacet
const COORDINATION_ABI = [
    'function proposeCoordination(bytes32 payloadHash, uint64 expiry, bytes32 coordinationType, uint256 coordinationValue, address[] participants, bool bondRequired, uint256 bondAmount, address bondToken) external returns (bytes32 intentHash)',
    'function acceptCoordination(bytes32 intentHash) external payable',
    'function executeCoordination(bytes32 intentHash) external',
    'function cancelCoordination(bytes32 intentHash, bytes32 reason) external',
    'function expireCoordination(bytes32 intentHash) external',
    'function getCoordinationStatus(bytes32 intentHash) external view returns (uint8 status)',
    'function getCoordinationParticipants(bytes32 intentHash) external view returns (address[])',
    'function getCoordinationNonce(address agent) external view returns (uint64)',
    'event CoordinationProposed(bytes32 indexed intentHash, address indexed proposer, bytes32 coordinationType)',
    'event CoordinationAccepted(bytes32 indexed intentHash, address indexed participant)',
    'event CoordinationReady(bytes32 indexed intentHash)',
    'event CoordinationFullyExecuted(bytes32 indexed intentHash)',
    'event CoordinationCancelled(bytes32 indexed intentHash, bytes32 reason, address indexed cancelledBy)'
];

// Coordination type hashes
const COORDINATION_TYPES = {
    JOINT_MONITORING: null,
    COORDINATED_TRADE: null,
    SHARED_COST: null,
    CODE_UPGRADE: null,
    ORACLE_CONSENSUS: null,
    COLLECTIVE_STAKE: null
};

// Auto-accept rules
const AUTO_ACCEPT_RULES = {
    JOINT_MONITORING: { requireTrust: 'Full', maxValue: '0.05' },
    CODE_UPGRADE: { requireTrust: 'Full', maxValue: '0' },
    COLLECTIVE_STAKE: { requireTrust: 'Full', maxValue: '1' },
    COORDINATED_TRADE: { requireTrust: null, maxValue: '0' }, // always manual
    SHARED_COST: { requireTrust: 'Full', maxValue: '0.1' },
    ORACLE_CONSENSUS: { requireTrust: 'Marginal', maxValue: '0.01' }
};

class AgentCoordinationService {
    constructor() {
        this.contractAddress = null;
        this.network = 'bsc';
        this._initialized = false;
        this._eventListener = null;
    }

    async initialize() {
        try {
            const ethers = await import('ethers');

            // Compute type hashes
            for (const type of Object.keys(COORDINATION_TYPES)) {
                COORDINATION_TYPES[type] = ethers.keccak256(ethers.toUtf8Bytes(type));
            }

            const { SystemSettings } = await import('../../models/SystemSettings.js');
            this.contractAddress = await SystemSettings.getSetting(
                'coordination_contract_address',
                process.env.COORDINATION_CONTRACT_ADDRESS || ''
            );

            if (!this.contractAddress) {
                logger.info('AgentCoordinationService: No contract address configured — service disabled');
                return;
            }

            this._initialized = true;
            logger.info(`AgentCoordinationService initialized: contract=${this.contractAddress}`);

            this.startEventListener().catch(err =>
                logger.error(`Coordination event listener failed: ${err.message}`)
            );
        } catch (err) {
            logger.error(`AgentCoordinationService init failed: ${err.message}`);
        }
    }

    async _getContract(signerOrProvider) {
        const ethers = await import('ethers');
        return new ethers.Contract(this.contractAddress, COORDINATION_ABI, signerOrProvider);
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

    // --- Proposer Operations ---

    async proposeCoordination(typeName, participantAddresses, payloadData, expiryHours = 1) {
        if (!this._initialized) throw new Error('Service not initialized');

        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const coordinationType = COORDINATION_TYPES[typeName];
        if (!coordinationType) throw new Error(`Unknown coordination type: ${typeName}`);

        const nonce = await contract.getCoordinationNonce(signer.address);
        const expiry = Math.floor(Date.now() / 1000) + (expiryHours * 3600);

        // All participants must be sorted ascending and include proposer
        const allParticipants = [...new Set([signer.address, ...participantAddresses])]
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        // Create payload
        const payload = {
            version: ethers.keccak256(ethers.toUtf8Bytes('v1')),
            coordinationType,
            coordinationData: ethers.toUtf8Bytes(JSON.stringify(payloadData)),
            conditionsHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payloadData))),
            timestamp: Math.floor(Date.now() / 1000),
            metadata: '0x'
        };

        const payloadHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['bytes32', 'bytes32', 'bytes', 'bytes32', 'uint256'],
                [payload.version, payload.coordinationType, payload.coordinationData, payload.conditionsHash, payload.timestamp]
            )
        );

        const coordinationValue = ethers.parseEther(payloadData.totalBudget?.toString() || '0');

        // Diamond CoordinationFacet uses flat params (no struct, no signature)
        const tx = await contract.proposeCoordination(
            payloadHash,
            expiry,
            coordinationType,
            coordinationValue,
            allParticipants,
            false,  // bondRequired
            0,      // bondAmount
            ethers.ZeroAddress  // bondToken (no bonds for Phase 1)
        );
        const receipt = await tx.wait();

        // Parse event for intentHash
        const event = receipt.logs.find(log => {
            try {
                return contract.interface.parseLog(log)?.name === 'CoordinationProposed';
            } catch { return false; }
        });
        const parsedEvent = contract.interface.parseLog(event);
        const intentHash = parsedEvent.args[0];

        // Save to MongoDB
        await AgentCoordination.create({
            intentHash,
            proposer: signer.address,
            coordinationType,
            coordinationTypeName: typeName,
            participants: allParticipants.map(addr => ({
                address: addr,
                accepted: addr.toLowerCase() === signer.address.toLowerCase()
            })),
            payload: {
                version: 'v1',
                coordinationData: payloadData,
                conditionsHash: payload.conditionsHash
            },
            coordinationValue: coordinationValue.toString(),
            expiry: new Date(expiry * 1000),
            status: 'Proposed',
            role: 'proposer',
            proposeTxHash: receipt.hash
        });

        logger.info(`Coordination proposed: ${typeName} (${intentHash.slice(0, 10)}...) with ${allParticipants.length} participants`);

        // Broadcast to P2P network
        await this._broadcastIntent(intentHash, typeName, payloadData, allParticipants);

        return { intentHash, txHash: receipt.hash, participants: allParticipants };
    }

    async cancelCoordination(intentHash, reason = 'cancelled') {
        if (!this._initialized) throw new Error('Service not initialized');

        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(reason));
        const tx = await contract.cancelCoordination(intentHash, reasonHash);
        await tx.wait();

        await AgentCoordination.updateOne({ intentHash }, { status: 'Cancelled' });
        logger.info(`Coordination cancelled: ${intentHash.slice(0, 10)}...`);

        return { intentHash, txHash: tx.hash };
    }

    // --- Participant Operations ---

    async acceptCoordination(intentHash, conditions = '') {
        if (!this._initialized) throw new Error('Service not initialized');

        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        // Diamond CoordinationFacet only needs intentHash (bond amount from storage)
        const tx = await contract.acceptCoordination(intentHash);
        await tx.wait();

        // Update local record
        const coord = await AgentCoordination.findOne({ intentHash });
        if (coord) {
            const participant = coord.participants.find(
                p => p.address.toLowerCase() === signer.address.toLowerCase()
            );
            if (participant) {
                participant.accepted = true;
                participant.acceptedAt = new Date();
                participant.acceptanceTxHash = tx.hash;
            }
            await coord.save();
        }

        logger.info(`Accepted coordination: ${intentHash.slice(0, 10)}...`);
        return { intentHash, txHash: tx.hash };
    }

    // --- Execution ---

    async executeCoordination(intentHash) {
        if (!this._initialized) throw new Error('Service not initialized');

        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const tx = await contract.executeCoordination(intentHash, '0x');
        await tx.wait();

        await AgentCoordination.updateOne({ intentHash }, {
            status: 'Executed',
            executeTxHash: tx.hash
        });

        logger.info(`Coordination executed: ${intentHash.slice(0, 10)}...`);

        // Trigger local execution handler
        const coord = await AgentCoordination.findOne({ intentHash });
        if (coord) {
            await this._handleExecution(coord);
        }

        return { intentHash, txHash: tx.hash };
    }

    async _handleExecution(coordination) {
        const typeName = coordination.coordinationTypeName;
        const payload = coordination.payload?.coordinationData || {};
        let result;

        try {
            switch (typeName) {
                case 'JOINT_MONITORING':
                    result = await this._executeJointMonitoring(coordination, payload);
                    break;
                case 'COORDINATED_TRADE':
                    result = await this._executeCoordinatedTrade(coordination, payload);
                    break;
                case 'SHARED_COST':
                    result = await this._executeSharedCost(coordination, payload);
                    break;
                case 'CODE_UPGRADE':
                    result = await this._executeCodeUpgrade(coordination, payload);
                    break;
                case 'ORACLE_CONSENSUS':
                    result = await this._executeOracleConsensus(coordination, payload);
                    break;
                case 'COLLECTIVE_STAKE':
                    result = await this._executeCollectiveStake(coordination, payload);
                    break;
                default:
                    logger.info(`No handler for coordination type: ${typeName}`);
                    return;
            }

            // Persist execution result
            await AgentCoordination.updateOne(
                { intentHash: coordination.intentHash },
                { executionResult: result }
            );

            logger.info(`Coordination handler completed: ${typeName} — ${result?.status || 'done'}`);
        } catch (err) {
            logger.error(`Coordination handler failed (${typeName}): ${err.message}`);
            await AgentCoordination.updateOne(
                { intentHash: coordination.intentHash },
                { executionResult: { status: 'failed', error: err.message } }
            );
        }
    }

    /**
     * JOINT_MONITORING — split network/token monitoring windows across participants.
     * Payload: { target, intervalMinutes, durationHours }
     */
    async _executeJointMonitoring(coordination, payload) {
        const { target, intervalMinutes = 5, durationHours = 24 } = payload;
        if (!target) throw new Error('JOINT_MONITORING requires a target in payload');

        const wallet = await walletService.getWallet();
        const ourAddr = wallet?.addresses?.evm?.toLowerCase();
        const participants = coordination.participants
            .filter(p => p.accepted)
            .map(p => p.address.toLowerCase())
            .sort();

        const ourIndex = participants.indexOf(ourAddr);
        if (ourIndex === -1) throw new Error('We are not an accepted participant');

        // Each participant takes an equal time window in a round-robin
        const windowMinutes = intervalMinutes * participants.length;
        const ourOffsetMinutes = intervalMinutes * ourIndex;

        // Schedule monitoring via tokenScanner (for token targets) or generic interval
        const tokenScanner = (await import('./tokenScanner.js')).default;
        const endTime = Date.now() + durationHours * 3600 * 1000;

        // Start a recurring check at our assigned window offset
        const timerId = setInterval(async () => {
            if (Date.now() > endTime) {
                clearInterval(timerId);
                logger.info(`JOINT_MONITORING completed for ${target}`);
                return;
            }
            try {
                const scanResult = await tokenScanner.scanNetwork('bsc');
                logger.info(`JOINT_MONITORING scan for ${target}: ${scanResult?.tokens?.length || 0} tokens found`);
            } catch (err) {
                logger.error(`JOINT_MONITORING scan error: ${err.message}`);
            }
        }, windowMinutes * 60 * 1000);

        // Fire the first scan after our offset
        setTimeout(async () => {
            try {
                await tokenScanner.scanNetwork('bsc');
            } catch { /* first scan best-effort */ }
        }, ourOffsetMinutes * 60 * 1000);

        logger.info(`JOINT_MONITORING started: target=${target}, window=${ourOffsetMinutes}-${ourOffsetMinutes + intervalMinutes}min every ${windowMinutes}min, duration=${durationHours}h`);

        return {
            status: 'monitoring_started',
            target,
            ourIndex,
            windowOffsetMinutes: ourOffsetMinutes,
            cycleLengthMinutes: windowMinutes,
            endsAt: new Date(endTime).toISOString()
        };
    }

    /**
     * COORDINATED_TRADE — synchronized DEX swap across participants.
     * Payload: { tokenIn, tokenOut, amount, slippage, network, executeAfterTimestamp }
     */
    async _executeCoordinatedTrade(coordination, payload) {
        const { tokenIn, tokenOut, amount, slippage = 0.5, network = 'bsc', executeAfterTimestamp } = payload;
        if (!tokenIn || !tokenOut || !amount) {
            throw new Error('COORDINATED_TRADE requires tokenIn, tokenOut, and amount');
        }

        // Wait until the agreed execution time if specified
        if (executeAfterTimestamp) {
            const waitMs = (executeAfterTimestamp * 1000) - Date.now();
            if (waitMs > 0 && waitMs < 60000) {
                await new Promise(resolve => setTimeout(resolve, waitMs));
            } else if (waitMs > 60000) {
                throw new Error(`Execution time too far in the future: ${waitMs}ms`);
            }
        }

        const swapService = (await import('./swapService.js')).default;
        const swapResult = await swapService.swap(tokenIn, tokenOut, amount, slippage, network);

        logger.info(`COORDINATED_TRADE executed: ${amount} ${tokenIn} -> ${tokenOut} on ${network}, txHash=${swapResult?.txHash || 'unknown'}`);

        return {
            status: 'trade_executed',
            tokenIn,
            tokenOut,
            amount,
            network,
            txHash: swapResult?.txHash,
            amountOut: swapResult?.amountOut
        };
    }

    /**
     * SHARED_COST — send proportional BNB payment for shared infrastructure.
     * Payload: { totalCost, recipient, description }
     */
    async _executeSharedCost(coordination, payload) {
        const { totalCost, recipient, description } = payload;
        if (!totalCost || !recipient) {
            throw new Error('SHARED_COST requires totalCost and recipient');
        }

        const acceptedCount = coordination.participants.filter(p => p.accepted).length;
        if (acceptedCount === 0) throw new Error('No accepted participants for cost split');

        const ethers = await import('ethers');
        const ourShare = parseFloat(totalCost) / acceptedCount;
        const ourShareWei = ethers.parseEther(ourShare.toFixed(18));

        const transactionService = (await import('./transactionService.js')).default;
        const txResult = await transactionService.sendNative(recipient, ourShareWei.toString(), 'bsc');

        logger.info(`SHARED_COST payment sent: ${ourShare} BNB to ${recipient} (${description || 'shared cost'}) — split ${acceptedCount} ways`);

        return {
            status: 'payment_sent',
            totalCost,
            ourShare: ourShare.toFixed(18),
            splitWays: acceptedCount,
            recipient,
            description,
            txHash: txResult?.hash || txResult?.txHash
        };
    }

    /**
     * CODE_UPGRADE — pull a git branch/commit and restart the agent.
     * Payload: { branch, commit, repoPath }
     */
    async _executeCodeUpgrade(coordination, payload) {
        const { branch, commit, repoPath } = payload;
        if (!branch && !commit) {
            throw new Error('CODE_UPGRADE requires branch or commit');
        }

        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        const targetPath = repoPath || process.env.AGENT_REPO_PATH || process.cwd();

        // Fetch latest
        const fetchResult = await execAsync(`git -C "${targetPath}" fetch origin`);
        logger.info(`CODE_UPGRADE git fetch: ${fetchResult.stdout || 'ok'}`);

        // Checkout the specified branch or commit
        const target = commit || `origin/${branch}`;
        const checkoutResult = await execAsync(`git -C "${targetPath}" checkout ${target}`);
        logger.info(`CODE_UPGRADE checkout ${target}: ${checkoutResult.stdout || 'ok'}`);

        // If branch specified, pull latest
        if (branch && !commit) {
            const pullResult = await execAsync(`git -C "${targetPath}" pull origin ${branch}`);
            logger.info(`CODE_UPGRADE pull: ${pullResult.stdout || 'ok'}`);
        }

        // Install dependencies if package.json changed
        try {
            const diffResult = await execAsync(`git -C "${targetPath}" diff HEAD~1 --name-only`);
            if (diffResult.stdout.includes('package.json')) {
                await execAsync(`cd "${targetPath}" && npm install --production`);
                logger.info('CODE_UPGRADE: npm install completed');
            }
        } catch { /* diff check is best-effort */ }

        logger.info(`CODE_UPGRADE completed: ${target} at ${targetPath}`);

        // Schedule restart via PM2 after a short delay
        setTimeout(async () => {
            try {
                await execAsync('pm2 restart ecosystem.config.cjs');
                logger.info('CODE_UPGRADE: PM2 restart initiated');
            } catch (err) {
                logger.error(`CODE_UPGRADE restart failed: ${err.message}`);
            }
        }, 3000);

        return {
            status: 'upgrade_applied',
            target,
            repoPath: targetPath,
            restartScheduled: true
        };
    }

    /**
     * ORACLE_CONSENSUS — pre-agree on approach for oracle request answers.
     * Payload: { requestId, query, answerApproach, consensusMethod }
     */
    async _executeOracleConsensus(coordination, payload) {
        const { requestId, query, answerApproach, consensusMethod = 'majority' } = payload;
        if (!requestId) {
            throw new Error('ORACLE_CONSENSUS requires requestId');
        }

        const oracleService = (await import('./oracleAgentService.js')).default;

        // Generate our answer using the agreed approach
        const answer = await oracleService.generateAnswer(requestId, query, {
            approach: answerApproach,
            consensusMethod
        });

        // Store pre-agreement record so the oracle service uses aligned methodology
        const preAgreement = {
            requestId,
            coordinationIntentHash: coordination.intentHash,
            agreedApproach: answerApproach,
            consensusMethod,
            participantCount: coordination.participants.filter(p => p.accepted).length,
            generatedAnswer: answer
        };

        // Broadcast our pre-computed answer hash to other participants for verification
        try {
            const ethers = await import('ethers');
            const answerHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(answer)));
            await this._broadcastIntent(
                coordination.intentHash,
                'ORACLE_CONSENSUS_ANSWER',
                { requestId, answerHash },
                coordination.participants.map(p => p.address)
            );
        } catch { /* P2P broadcast is best-effort */ }

        logger.info(`ORACLE_CONSENSUS prepared: requestId=${requestId}, approach=${answerApproach}, method=${consensusMethod}`);

        return {
            status: 'consensus_prepared',
            requestId,
            answerApproach,
            consensusMethod,
            answerGenerated: !!answer
        };
    }

    /**
     * COLLECTIVE_STAKE — pool staking across agents into a shared validator/pool.
     * Payload: { stakingTarget, amount, token, lockDuration }
     */
    async _executeCollectiveStake(coordination, payload) {
        const { stakingTarget, amount, token, lockDuration } = payload;
        if (!amount) {
            throw new Error('COLLECTIVE_STAKE requires amount');
        }

        const stakingService = (await import('./skynetStakingService.js')).default;
        const stakeResult = await stakingService.stake(amount);

        logger.info(`COLLECTIVE_STAKE executed: ${amount} ${token || 'native'} to ${stakingTarget || 'default pool'}, lockDuration=${lockDuration || 'none'}`);

        return {
            status: 'stake_executed',
            stakingTarget,
            amount,
            token: token || 'native',
            lockDuration,
            txHash: stakeResult?.txHash || stakeResult?.hash,
            participantCount: coordination.participants.filter(p => p.accepted).length
        };
    }

    // --- Auto-Accept Logic ---

    async shouldAutoAccept(intent) {
        const typeName = Object.entries(COORDINATION_TYPES)
            .find(([, hash]) => hash === intent.coordinationType)?.[0];

        const rule = AUTO_ACCEPT_RULES[typeName];
        if (!rule || !rule.requireTrust) return false;

        // Check trust level via trust registry
        try {
            const trustRegistryService = (await import('./trustRegistryService.js')).default;

            // Get proposer's ENS name (would come from P2P message or on-chain lookup)
            const proposerENS = intent.proposerENS;
            if (!proposerENS) return false;

            const trustLevel = await trustRegistryService.getTrustLevel(proposerENS);

            // Map trust levels to numeric for comparison
            const levels = { Unknown: 0, None: 1, Marginal: 2, Full: 3 };
            if (levels[trustLevel] < levels[rule.requireTrust]) return false;

            // Check value limit
            const ethers = await import('ethers');
            if (rule.maxValue !== '0') {
                const value = parseFloat(ethers.formatEther(intent.coordinationValue || '0'));
                if (value > parseFloat(rule.maxValue)) return false;
            } else if (rule.maxValue === '0' && typeName !== 'CODE_UPGRADE') {
                // maxValue 0 means always manual (except CODE_UPGRADE from genesis)
                return false;
            }

            logger.info(`Auto-accepting ${typeName} from ${proposerENS} (trust: ${trustLevel})`);
            return true;
        } catch {
            return false;
        }
    }

    // --- Event Monitoring ---

    async startEventListener() {
        if (!this._initialized || !this.contractAddress) return;

        try {
            const provider = await contractServiceWrapper.getProvider(this.network);
            const ethers = await import('ethers');
            const contract = new ethers.Contract(this.contractAddress, COORDINATION_ABI, provider);
            const wallet = await walletService.getWallet();
            const ourAddr = wallet?.addresses?.evm?.toLowerCase();

            contract.on('CoordinationProposed', async (intentHash, proposer, coordinationType, value) => {
                try {
                    if (proposer.toLowerCase() === ourAddr) return; // we proposed it

                    // Check if we're a participant
                    const [participants] = await contract.getCoordinationParticipants(intentHash);
                    const isParticipant = participants.some(p => p.toLowerCase() === ourAddr);

                    if (isParticipant) {
                        logger.info(`Coordination proposed involving us: ${intentHash.slice(0, 10)}...`);
                        // TODO: auto-accept check
                    }
                } catch (err) {
                    logger.error(`Error handling CoordinationProposed: ${err.message}`);
                }
            });

            contract.on('CoordinationReady', async (intentHash) => {
                try {
                    const coord = await AgentCoordination.findOne({ intentHash });
                    if (coord && coord.role === 'proposer') {
                        logger.info(`Coordination ready for execution: ${intentHash.slice(0, 10)}...`);
                        coord.status = 'Ready';
                        await coord.save();
                    }
                } catch (err) {
                    logger.error(`Error handling CoordinationReady: ${err.message}`);
                }
            });

            this._eventListener = contract;
            logger.info('Coordination event listener started');
        } catch (err) {
            logger.error(`Coordination event listener failed: ${err.message}`);
        }
    }

    // --- P2P Integration ---

    async _broadcastIntent(intentHash, typeName, payloadData, participants) {
        try {
            const p2pService = (await import('../p2p/p2pService.js')).default;
            if (p2pService && p2pService.broadcast) {
                await p2pService.broadcast({
                    type: 'coordination:propose',
                    intentHash,
                    coordinationType: typeName,
                    payload: payloadData,
                    participants
                });
            }
        } catch {
            // P2P not available
        }
    }

    // --- Query Methods ---

    async getActiveIntents() {
        return AgentCoordination.getActive();
    }

    async getHistory(filters = {}) {
        return AgentCoordination.getHistory(filters);
    }

    async getStats() {
        const [active, total, byType] = await Promise.all([
            AgentCoordination.countDocuments({ status: { $in: ['Proposed', 'Ready'] } }),
            AgentCoordination.countDocuments(),
            AgentCoordination.aggregate([
                { $group: { _id: '$coordinationTypeName', count: { $sum: 1 } } }
            ])
        ]);
        return { active, total, byType };
    }

    getCoordinationTypes() {
        return Object.keys(COORDINATION_TYPES);
    }
}

export default new AgentCoordinationService();
