import { cryptoLogger as logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import walletService from './walletService.js';
import { decrypt } from '../../utils/encryption.js';
import TrustAttestation from '../../models/TrustAttestation.js';

// Minimal ABI for ENSTrustRegistry contract
// ABI for SkynetDiamond TrustFacet
const TRUST_REGISTRY_ABI = [
    'function registerNode(bytes32 node) external',
    'function setNodeOwner(bytes32 node, address newOwner) external',
    'function setTrust(bytes32 trustorNode, bytes32 trusteeNode, uint8 level, bytes32 scope, uint64 expiry) external',
    'function revokeTrust(bytes32 trustorNode, bytes32 trusteeNode, bytes32 scope, bytes32 reasonCode) external',
    'function getTrust(bytes32 trustorNode, bytes32 trusteeNode, bytes32 scope) external view returns (uint8 level, uint64 expiry)',
    'function getEffectiveTrust(bytes32 trustorNode, bytes32 trusteeNode, bytes32 scope, address trusteeAddress) external view returns (uint8 level)',
    'function verifyTrustPath(bytes32[] path, bytes32 scope, uint8 minEdgeTrust) external view returns (bool valid)',
    'function setIdentityGate(bytes32 coordinationType, bytes32 gatekeeperNode, uint8 maxPathLength, uint8 minEdgeTrust, bytes32 scope) external',
    'function removeIdentityGate(bytes32 coordinationType) external',
    'function getIdentityGate(bytes32 coordinationType) external view returns (bytes32 gatekeeperNode, uint8 maxPathLength, uint8 minEdgeTrust, bytes32 scope, bool enabled)',
    'function getTrustees(bytes32 trustorNode, bytes32 scope) external view returns (bytes32[])',
    'function getTrustors(bytes32 trusteeNode, bytes32 scope) external view returns (bytes32[])',
    'function getNodeOwner(bytes32 node) external view returns (address)',
    'event TrustSet(bytes32 indexed trustorNode, bytes32 indexed trusteeNode, uint8 level, bytes32 scope, uint64 expiry)',
    'event TrustRevoked(bytes32 indexed trustorNode, bytes32 indexed trusteeNode, bytes32 scope, bytes32 reasonCode)'
];

// Trust level enum
const TrustLevel = { Unknown: 0, None: 1, Marginal: 2, Full: 3 };
const TrustLevelNames = ['Unknown', 'None', 'Marginal', 'Full'];

// Well-known scopes
const SCOPES = {
    UNIVERSAL: '0x0000000000000000000000000000000000000000000000000000000000000000',
    COMMERCE: null,  // computed at init
    P2P: null,
    ORACLE: null,
    NETWORK: null
};

// Trust accumulation thresholds
const TRUST_THRESHOLDS = {
    MARGINAL_JOBS: 3,   // 3 successful jobs → Marginal trust
    FULL_JOBS: 10,      // 10 successful jobs → Full trust
    DISTRUST_FAILURES: 2 // 2 failures → None trust
};

class TrustRegistryService {
    constructor() {
        this.contractAddress = null;
        this.network = 'bsc';
        this.ourNode = null;       // namehash of our ENS name (e.g., alice.lanagent.eth)
        this.anchorNode = null;    // namehash of lanagent.eth
        this._initialized = false;
        this._lastScammerSyncTime = 0;
    }

    async initialize() {
        try {
            const ethers = await import('ethers');

            // Compute scope hashes
            SCOPES.COMMERCE = ethers.keccak256(ethers.toUtf8Bytes('COMMERCE'));
            SCOPES.P2P = ethers.keccak256(ethers.toUtf8Bytes('P2P'));
            SCOPES.ORACLE = ethers.keccak256(ethers.toUtf8Bytes('ORACLE'));
            SCOPES.NETWORK = ethers.keccak256(ethers.toUtf8Bytes('NETWORK'));

            const { SystemSettings } = await import('../../models/SystemSettings.js');
            this.contractAddress = await SystemSettings.getSetting(
                'trust_registry_address',
                process.env.TRUST_REGISTRY_ADDRESS || ''
            );

            if (!this.contractAddress) {
                logger.info('TrustRegistryService: No contract address configured — service disabled');
                return;
            }

            // Compute our ENS namehash
            const agentName = process.env.AGENT_NAME || 'lanagent';
            const ensName = `${agentName.toLowerCase()}.lanagent.eth`;
            this.ourNode = ethers.namehash(ensName);
            this.anchorNode = ethers.namehash('lanagent.eth');

            this._initialized = true;
            logger.info(`TrustRegistryService initialized: contract=${this.contractAddress}, node=${ensName} (${this.ourNode.slice(0, 10)}...)`);
        } catch (err) {
            logger.error(`TrustRegistryService init failed: ${err.message}`);
        }
    }

    async _getContract(signerOrProvider) {
        const ethers = await import('ethers');
        return new ethers.Contract(this.contractAddress, TRUST_REGISTRY_ABI, signerOrProvider);
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

    // --- Trust Operations ---

    /**
     * Set trust level for an agent (by ENS name)
     */
    async setTrust(trusteeENS, level, scopeName = 'universal', expiryDays = 0) {
        if (!this._initialized) throw new Error('Service not initialized');

        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const trusteeNode = ethers.namehash(trusteeENS);
        const scope = SCOPES[scopeName.toUpperCase()] || SCOPES.UNIVERSAL;
        const expiry = expiryDays > 0 ? Math.floor(Date.now() / 1000) + (expiryDays * 86400) : 0;
        const trustLevel = typeof level === 'number' ? level : TrustLevel[level] ?? TrustLevel.Unknown;

        // Diamond TrustFacet uses flat params (no struct, no signature, enforced via onlyNodeOwner)
        const tx = await contract.setTrust(this.ourNode, trusteeNode, trustLevel, scope, expiry);
        await tx.wait();

        // Save to MongoDB
        await TrustAttestation.findOneAndUpdate(
            { trustorNode: this.ourNode, trusteeNode, scope },
            {
                trustorName: `${process.env.AGENT_NAME || 'lanagent'}.lanagent.eth`,
                trusteeName: trusteeENS,
                level: TrustLevelNames[trustLevel],
                scopeName,
                expiry: expiryDays > 0 ? new Date(expiry * 1000) : null,
                nonce: Number(nonce),
                txHash: tx.hash,
                source: 'manual'
            },
            { upsert: true, new: true }
        );

        logger.info(`Trust set: ${TrustLevelNames[trustLevel]} → ${trusteeENS} (scope: ${scopeName})`);
        return { txHash: tx.hash, trusteeENS, level: TrustLevelNames[trustLevel] };
    }

    /**
     * Revoke trust (set to None with reason)
     */
    async revokeTrust(trusteeENS, scopeName = 'universal', reason = 'manual') {
        if (!this._initialized) throw new Error('Service not initialized');

        const ethers = await import('ethers');
        const signer = await this._getSigner();
        const contract = await this._getContract(signer);

        const trusteeNode = ethers.namehash(trusteeENS);
        const scope = SCOPES[scopeName.toUpperCase()] || SCOPES.UNIVERSAL;
        const reasonCode = ethers.keccak256(ethers.toUtf8Bytes(reason));

        const tx = await contract.revokeTrust(this.ourNode, trusteeNode, scope, reasonCode);
        await tx.wait();

        await TrustAttestation.findOneAndUpdate(
            { trustorNode: this.ourNode, trusteeNode, scope },
            {
                level: 'None',
                reasonCode: reason,
                source: 'manual'
            },
            { upsert: true }
        );

        logger.info(`Trust revoked: ${trusteeENS} (scope: ${scopeName}, reason: ${reason})`);
        return { txHash: tx.hash };
    }

    /**
     * Query trust level for an agent
     */
    async getTrust(trustorENS, trusteeENS, scopeName = 'universal') {
        if (!this._initialized) throw new Error('Service not initialized');

        const ethers = await import('ethers');
        const provider = await contractServiceWrapper.getProvider(this.network);
        const contract = await this._getContract(provider);

        const trustorNode = ethers.namehash(trustorENS);
        const trusteeNode = ethers.namehash(trusteeENS);
        const scope = SCOPES[scopeName.toUpperCase()] || SCOPES.UNIVERSAL;

        const [level, expiry] = await contract.getTrust(trustorNode, trusteeNode, scope);
        return {
            level: TrustLevelNames[Number(level)],
            expiry: Number(expiry) > 0 ? new Date(Number(expiry) * 1000) : null
        };
    }

    /**
     * Quick check: is this agent at least at minLevel?
     */
    async isMinimallyTrusted(agentENS, minLevel = 'Marginal', scopeName = 'universal') {
        const ourENS = `${(process.env.AGENT_NAME || 'lanagent').toLowerCase()}.lanagent.eth`;
        const result = await this.getTrust(ourENS, agentENS, scopeName);
        const numLevel = TrustLevel[result.level] ?? 0;
        const numMin = TrustLevel[minLevel] ?? 2;
        return numLevel >= numMin;
    }

    /**
     * Get simplified trust level for an agent (from our perspective)
     */
    async getTrustLevel(agentENS) {
        try {
            const ourENS = `${(process.env.AGENT_NAME || 'lanagent').toLowerCase()}.lanagent.eth`;
            const result = await this.getTrust(ourENS, agentENS);
            return result.level;
        } catch {
            return 'Unknown';
        }
    }

    // --- Path Verification ---

    /**
     * Find trust path between two agents (off-chain BFS)
     */
    async findTrustPath(fromENS, toENS, maxDepth = 5, scopeName = 'universal') {
        if (!this._initialized) throw new Error('Service not initialized');

        const ethers = await import('ethers');
        const provider = await contractServiceWrapper.getProvider(this.network);
        const contract = await this._getContract(provider);

        const fromNode = ethers.namehash(fromENS);
        const toNode = ethers.namehash(toENS);
        const scope = SCOPES[scopeName.toUpperCase()] || SCOPES.UNIVERSAL;

        // BFS from source to target
        const queue = [[fromNode]];
        const visited = new Set([fromNode]);

        while (queue.length > 0) {
            const path = queue.shift();
            const current = path[path.length - 1];

            if (path.length > maxDepth + 1) break;

            // Get trustees of current node
            try {
                const [trustees] = await contract.getTrustees(current, scope);
                for (const trustee of trustees) {
                    if (trustee === toNode) {
                        return { found: true, path: [...path, trustee] };
                    }
                    if (!visited.has(trustee) && path.length < maxDepth) {
                        visited.add(trustee);
                        queue.push([...path, trustee]);
                    }
                }
            } catch {
                // Node might not have trustees
            }
        }

        return { found: false, path: [] };
    }

    /**
     * Verify a trust path on-chain
     */
    async verifyTrustPath(pathNodes, params) {
        if (!this._initialized) throw new Error('Service not initialized');

        const provider = await contractServiceWrapper.getProvider(this.network);
        const contract = await this._getContract(provider);

        // Diamond TrustFacet uses flat params
        const valid = await contract.verifyTrustPath(
            pathNodes,
            params.scope || ethers.ZeroHash,
            params.minEdgeTrust || 2
        );

        return { valid, anchorSatisfied: true };
    }

    // --- Automated Trust Management ---

    /**
     * Auto-trust a P2P fork (Full trust, universal scope)
     */
    async autoTrustFork(forkENS) {
        logger.info(`Auto-trusting P2P fork: ${forkENS}`);
        const result = await this.setTrust(forkENS, 'Full', 'universal', 0);

        // Update source to p2p-auto
        await TrustAttestation.updateOne(
            { trustorNode: this.ourNode, trusteeName: forkENS },
            { source: 'p2p-auto' }
        );

        return result;
    }

    /**
     * Sync a single scammer registry entry as None trust
     */
    async syncScammerAsDistrust(scammerENS) {
        logger.info(`Syncing scammer as distrust: ${scammerENS}`);

        const result = await this.setTrust(scammerENS, 'None', 'universal', 0);

        await TrustAttestation.updateOne(
            { trustorNode: this.ourNode, trusteeName: scammerENS },
            { source: 'scammer-sync', reasonCode: 'Misbehavior' }
        );

        return result;
    }

    /**
     * Bulk-sync all registered scammers from the scammer registry to trust registry.
     * Sets trust level None for each scammer in both COMMERCE and P2P scopes.
     */
    async syncAllScammersAsDistrust() {
        if (!this._initialized) {
            logger.debug('TrustRegistry not initialized — skipping scammer sync');
            return { synced: 0 };
        }

        try {
            const scammerRegistry = (await import('./scammerRegistryService.js')).default;
            if (!scammerRegistry.isAvailable()) {
                logger.debug('Scammer registry not available — skipping sync');
                return { synced: 0 };
            }

            const { total, addresses } = await scammerRegistry.listScammers(200);
            logger.info(`Scammer sync: ${addresses.length} of ${total} scammers to sync`);

            let synced = 0;
            let errors = 0;

            for (const address of addresses) {
                // Use address-based pseudo-ENS for scammers without registered names
                const scammerENS = `${address.toLowerCase()}.addr.lanagent.eth`;

                try {
                    // Check if already synced with None trust in COMMERCE scope
                    const existing = await TrustAttestation.findOne({
                        trustorNode: this.ourNode,
                        trusteeName: scammerENS,
                        scope: SCOPES.COMMERCE,
                        level: 'None',
                        source: 'scammer-sync'
                    });

                    if (existing) continue; // Already synced

                    // Set None trust in COMMERCE scope
                    await this.setTrust(scammerENS, 'None', 'commerce', 0);
                    await TrustAttestation.updateOne(
                        { trustorNode: this.ourNode, trusteeName: scammerENS, scope: SCOPES.COMMERCE },
                        { source: 'scammer-sync', reasonCode: 'Misbehavior' }
                    );

                    // Set None trust in P2P scope
                    await this.setTrust(scammerENS, 'None', 'p2p', 0);
                    await TrustAttestation.updateOne(
                        { trustorNode: this.ourNode, trusteeName: scammerENS, scope: SCOPES.P2P },
                        { source: 'scammer-sync', reasonCode: 'Misbehavior' }
                    );

                    synced++;
                } catch (err) {
                    errors++;
                    logger.warn(`Failed to sync scammer ${address}: ${err.message}`);
                }
            }

            this._lastScammerSyncTime = Date.now();
            logger.info(`Scammer sync complete: ${synced} synced, ${errors} errors (of ${addresses.length} total)`);
            return { synced, errors, total: addresses.length };
        } catch (err) {
            logger.error(`Scammer bulk sync failed: ${err.message}`);
            return { synced: 0, error: err.message };
        }
    }

    /**
     * Check if a scammer sync is needed (runs every 6 hours)
     */
    isScammerSyncNeeded() {
        const SYNC_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
        return !this._lastScammerSyncTime || (Date.now() - this._lastScammerSyncTime) > SYNC_INTERVAL;
    }

    /**
     * Run scammer sync if interval has elapsed
     */
    async runScammerSyncIfNeeded() {
        if (!this.isScammerSyncNeeded()) return null;
        return this.syncAllScammersAsDistrust();
    }

    /**
     * Update trust based on ERC-8183 job completion
     */
    async updateTrustFromJobCompletion(clientENS, success) {
        const ethers = await import('ethers');
        const trusteeNode = ethers.namehash(clientENS);

        // Get or create attestation record
        let attestation = await TrustAttestation.findOne({
            trustorNode: this.ourNode,
            trusteeNode,
            scope: SCOPES.COMMERCE
        });

        if (!attestation) {
            attestation = new TrustAttestation({
                trustorNode: this.ourNode,
                trustorName: `${(process.env.AGENT_NAME || 'lanagent').toLowerCase()}.lanagent.eth`,
                trusteeNode,
                trusteeName: clientENS,
                level: 'Unknown',
                scope: SCOPES.COMMERCE,
                scopeName: 'commerce',
                source: 'job-completion',
                jobCount: 0,
                failureCount: 0
            });
        }

        if (success) {
            attestation.jobCount++;
            attestation.source = 'job-completion';

            // Upgrade trust based on thresholds
            if (attestation.jobCount >= TRUST_THRESHOLDS.FULL_JOBS && attestation.level !== 'Full') {
                await this.setTrust(clientENS, 'Full', 'commerce');
                attestation.level = 'Full';
                logger.info(`Trust upgraded to Full for ${clientENS} (${attestation.jobCount} jobs)`);
            } else if (attestation.jobCount >= TRUST_THRESHOLDS.MARGINAL_JOBS && attestation.level === 'Unknown') {
                await this.setTrust(clientENS, 'Marginal', 'commerce');
                attestation.level = 'Marginal';
                logger.info(`Trust upgraded to Marginal for ${clientENS} (${attestation.jobCount} jobs)`);
            }
        } else {
            attestation.failureCount++;

            // Downgrade on repeated failures
            if (attestation.failureCount >= TRUST_THRESHOLDS.DISTRUST_FAILURES) {
                await this.revokeTrust(clientENS, 'commerce', 'Misbehavior');
                attestation.level = 'None';
                logger.warn(`Trust downgraded to None for ${clientENS} (${attestation.failureCount} failures)`);
            }
        }

        await attestation.save();
    }

    // --- Query ---

    async getTrustGraph() {
        return TrustAttestation.getTrustGraph();
    }

    async getTrustStats() {
        const total = await TrustAttestation.countDocuments();
        const byLevel = await TrustAttestation.aggregate([
            { $group: { _id: '$level', count: { $sum: 1 } } }
        ]);
        const bySource = await TrustAttestation.aggregate([
            { $group: { _id: '$source', count: { $sum: 1 } } }
        ]);
        return { total, byLevel, bySource };
    }

    // --- Exports ---
    get SCOPES() { return SCOPES; }
    get TrustLevel() { return TrustLevel; }
    get TrustLevelNames() { return TrustLevelNames; }
}

export default new TrustRegistryService();
