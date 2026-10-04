import { cryptoLogger as logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import walletService from './walletService.js';
import { decrypt } from '../../utils/encryption.js';
import AgenticCommerceJob from '../../models/AgenticCommerceJob.js';
import AgenticCommerceQuote from '../../models/AgenticCommerceQuote.js';

/**
 * Paid on-chain jobs (ERC-8183 style) on the SkynetDiamond CommerceFacet. This agent is the
 * PROVIDER and EVALUATOR: a client creates and funds a job naming us, we do the work, submit a
 * deliverable hash and complete the job, which pays us the budget minus the commerce fee.
 *
 * Money safety. Nothing here can move funds OUT of the wallet:
 *   - The signing contract object knows only submitJob and completeJob. Both are non-payable
 *     (ethers refuses to attach value), need no token approval, and the facet pays the
 *     provider, never the other way round. The old client-side createJob/fundJob, which spent
 *     BNB, are gone.
 *   - The agent never pays gas before it is paid: it no longer creates jobs for callers (the
 *     client does, from its own wallet). Gas is spent only on a job that is verified ON-CHAIN
 *     as funded, in BNB, to us as provider AND evaluator, at or above our price, with time to
 *     finish before the client could refund, and whose fee-net budget covers the gas at least
 *     twice. A daily job cap bounds the rest.
 *   - Work that fails spends no gas (execution happens before the submit transaction).
 */

// The live commerce contract: the SkynetDiamond (CommerceFacet)
export const DEFAULT_COMMERCE_CONTRACT = '0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7';

const VIEW_ABI = [
    'function getJob(uint256 jobId) external view returns (address client, address provider, address evaluator, address paymentToken, uint256 budget, uint256 expiredAt, string description, bytes32 deliverable, uint8 status)',
    'function getJobsByProvider(address provider) external view returns (uint256[])',
    'function getJobCount() external view returns (uint256)',
    'function commerceFeeBps() external view returns (uint256)'
];
// The ONLY functions this agent signs. Both non-payable.
const SIGN_ABI = [
    'function submitJob(uint256 jobId, bytes32 deliverable) external',
    'function completeJob(uint256 jobId, bytes32 reason) external'
];

const STATUS_MAP = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];
const ST = { OPEN: 0, FUNDED: 1, SUBMITTED: 2, COMPLETED: 3 };

// Service pricing (BNB)
const SERVICE_PRICING = {
    'youtube-video': { price: '0.001', evaluator: 'self', delivery: 'file' },
    'youtube-audio': { price: '0.0008', evaluator: 'self', delivery: 'file' },
    'transcode': { price: '0.002', evaluator: 'self', delivery: 'file' },
    'image-gen': { price: '0.003', evaluator: 'self', delivery: 'file' },
    'web-scrape': { price: '0.0005', evaluator: 'self', delivery: 'json' },
    'document-process': { price: '0.001', evaluator: 'self', delivery: 'json' }
};

const GAS_LIMIT_SUBMIT = 250000;
const GAS_LIMIT_COMPLETE = 600000;          // completeJob swaps the fee to SKYNET
const GAS_ALLOWANCE = GAS_LIMIT_SUBMIT + GAS_LIMIT_COMPLETE;
const MIN_TIME_LEFT_S = 30 * 60;            // a client can refund a FUNDED job once it expires
const MAX_ATTEMPTS = 2;
const POLL_MS = 60 * 1000;
const POLL_BATCH = 50;
const MAX_INLINE_BASE64 = 256 * 1024;       // quotes are stored; larger files go by fileUrl
const MAX_STORED_QUOTES = 2000;             // unfunded quotes expire after 48 h

/** JSON with sorted keys, so the same params always hash the same. */
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}

/** A deliverable as returned to the client: no local paths. */
function publicResult(value, depth = 0) {
    if (depth > 6 || value == null) return value;
    if (Array.isArray(value)) return value.map(v => publicResult(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (/^(path|filePath|localPath|outputPath|tmpPath|dir)$/i.test(k)) continue;
            if (typeof v === 'string' && /^\/(root|home|tmp|var|opt|media)\//.test(v)) continue;
            out[k] = publicResult(v, depth + 1);
        }
        return out;
    }
    return value;
}

class AgenticCommerceService {
    constructor() {
        this.contractAddress = null;
        this.network = 'bsc';
        this.providerAddress = null;
        this._initialized = false;
        this._pollTimer = null;
        this._processing = new Set();
        this._terminal = new Set();
        this._feeBps = null;
        this._feeReadAt = 0;
        this.agent = null;
    }

    /** The agent, for its plugins. */
    setAgent(agent) {
        if (agent) this.agent = agent;
    }

    async initialize() {
        try {
            const { SystemSettings } = await import('../../models/SystemSettings.js');
            const enabled = await SystemSettings.getSetting('agentic_commerce.enabled', true);
            if (enabled === false || String(process.env.AGENTIC_COMMERCE_ENABLED || '').toLowerCase() === 'false') {
                logger.info('AgenticCommerce: disabled (agentic_commerce.enabled / AGENTIC_COMMERCE_ENABLED)');
                return false;
            }

            // The configured contract must answer the CommerceFacet views; a stale address (an
            // older standalone contract sat in this setting on ALICE) falls back to the diamond.
            const configured = await SystemSettings.getSetting('agentic_commerce_address', process.env.AGENTIC_COMMERCE_ADDRESS || '');
            this.contractAddress = DEFAULT_COMMERCE_CONTRACT;
            if (configured && configured.toLowerCase() !== DEFAULT_COMMERCE_CONTRACT.toLowerCase()) {
                if (await this._isCommerceContract(configured)) this.contractAddress = configured;
                else logger.warn(`AgenticCommerce: ${configured} does not answer the CommerceFacet views; using the SkynetDiamond`);
            }

            const wallet = await walletService.getWallet();
            const addr = (wallet?.addresses || []).find?.(a => a.chain === 'bsc' || a.chain === 'eth')?.address;
            if (!addr) {
                logger.info('AgenticCommerce: no agent wallet — service disabled');
                return false;
            }
            this.providerAddress = addr;
            this._initialized = true;
            logger.info(`AgenticCommerce ready: contract=${this.contractAddress}, provider=${addr}`);

            this._pollTimer = setInterval(() => this.pollJobs().catch(err =>
                logger.warn(`AgenticCommerce poll failed: ${err.message}`)), POLL_MS);
            this._pollTimer.unref?.();
            setTimeout(() => this.pollJobs().catch(() => {}), 15000).unref?.();
            return true;
        } catch (err) {
            logger.error(`AgenticCommerceService init failed: ${err.message}`);
            return false;
        }
    }

    shutdown() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;
    }

    async _provider() {
        return contractServiceWrapper.getProvider(this.network);
    }

    async _view(address = this.contractAddress) {
        const { ethers } = await import('ethers');
        return new ethers.Contract(address, VIEW_ABI, await this._provider());
    }

    async _isCommerceContract(address) {
        try {
            await (await this._view(address)).getJobCount();
            return true;
        } catch {
            return false;
        }
    }

    /** A signer bound to SIGN_ABI only: this service cannot call anything that pays out. */
    async _signingContract() {
        const { ethers } = await import('ethers');
        const wallet = await walletService.getWallet();
        if (!wallet) throw new Error('Wallet not initialized');
        const signer = ethers.Wallet.fromPhrase(decrypt(wallet.encryptedSeed), "m/44'/60'/0'/0/0").connect(await this._provider());
        if (signer.address.toLowerCase() !== this.providerAddress.toLowerCase()) throw new Error('Signer is not the provider wallet');
        return new ethers.Contract(this.contractAddress, SIGN_ABI, signer);
    }

    async _feeBpsNow() {
        if (this._feeBps !== null && Date.now() - this._feeReadAt < 10 * 60 * 1000) return this._feeBps;
        this._feeBps = Number(await (await this._view()).commerceFeeBps());
        this._feeReadAt = Date.now();
        return this._feeBps;
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

    /**
     * Validate and keep only the parameters a service uses. URLs must be public (no LAN, no
     * credentials); files come as a public fileUrl or small fileBase64, never a server path.
     */
    async _cleanParams(serviceType, params = {}) {
        const { assertPublicUrl } = await import('../../utils/publicUrl.js');
        const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);
        const file = async () => {
            if (params.fileUrl) return { fileUrl: await assertPublicUrl(params.fileUrl, 'fileUrl'), fileExtension: str(params.fileExtension, 10) };
            if (params.fileBase64) {
                if (typeof params.fileBase64 !== 'string' || params.fileBase64.length > MAX_INLINE_BASE64) throw new Error('fileBase64 is limited to 256 KB here; use fileUrl for larger files');
                return { fileBase64: params.fileBase64, fileExtension: str(params.fileExtension, 10) };
            }
            throw new Error('Provide the input as fileUrl (public http/https) or fileBase64');
        };
        let out;
        switch (serviceType) {
            case 'youtube-video':
            case 'youtube-audio':
                out = { url: await assertPublicUrl(params.url, 'url'), format: str(params.format, 10), quality: str(params.quality, 20) };
                break;
            case 'web-scrape':
                out = { url: await assertPublicUrl(params.url, 'url') };
                break;
            case 'transcode':
                out = { ...(await file()), format: str(params.format, 5) || 'mp4' };
                break;
            case 'image-gen':
                if (!str(params.prompt, 4000) || !params.prompt.trim()) throw new Error('prompt is required (up to 4000 characters)');
                out = { prompt: params.prompt, size: str(params.size, 20), style: str(params.style, 40) };
                break;
            case 'document-process':
                out = { ...(await file()), operation: str(params.operation, 20), language: str(params.language, 20), outputFormat: str(params.outputFormat, 20) };
                break;
            default:
                throw new Error(`Unknown service type: ${serviceType}`);
        }
        return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
    }

    /**
     * Quote a job. Stores the parameters and returns exactly what the client submits on-chain.
     * Costs this agent nothing: the client creates and funds the job from its own wallet.
     */
    async quoteJob(serviceType, serviceParams, clientAddress = '') {
        if (!this._initialized) throw new Error('Paid jobs are not enabled on this agent');
        const pricing = this.getServicePrice(serviceType);
        if (!pricing) throw new Error(`Unknown service type: ${serviceType}`);
        const { ethers } = await import('ethers');
        const params = await this._cleanParams(serviceType, serviceParams || {});
        const paramsHash = ethers.keccak256(ethers.toUtf8Bytes(canonical({ serviceType, params })));
        if (!(await AgenticCommerceQuote.exists({ paramsHash })) && (await AgenticCommerceQuote.estimatedDocumentCount()) >= MAX_STORED_QUOTES) {
            throw new Error('Too many open quotes right now; try again later');
        }
        await AgenticCommerceQuote.updateOne(
            { paramsHash },
            { $setOnInsert: { paramsHash, serviceType, serviceParams: params, clientAddress: String(clientAddress || '').slice(0, 42) } },
            { upsert: true }
        );
        const budgetWei = ethers.parseEther(pricing.price).toString();
        const description = `${serviceType}:${paramsHash}`;
        const expiresAfter = Math.floor(Date.now() / 1000) + 2 * 3600;
        return {
            serviceType,
            price: pricing.price,
            currency: 'BNB',
            contract: this.contractAddress,
            chainId: 56,
            steps: [
                { call: 'createJob(address provider, address evaluator, uint256 expiredAt, string description, address paymentToken)',
                  args: [this.providerAddress, this.providerAddress, `a unix time at least 1 hour ahead, e.g. ${expiresAfter}`, description, ethers.ZeroAddress],
                  note: 'provider and evaluator must both be this agent; paymentToken must be BNB (the zero address)' },
                { call: 'fundJob(uint256 jobId, uint256 budget)', args: ['<jobId from the JobCreated event>', budgetWei], value: budgetWei,
                  note: `send exactly ${pricing.price} BNB as value` },
                { call: 'POST /api/external/jobs/<jobId>/fund', note: 'optional: starts the work at once instead of at the next check (about a minute)' }
            ],
            description,
            paramsHash,
            deliverable: 'GET /api/external/jobs/<jobId>/deliverable?signature=<EIP-191 signature by the client wallet of "LANAgent job <jobId> deliverable">'
        };
    }

    // --- Provider flow ---

    /** Check every job naming us as provider; process the funded ones. View calls only. */
    async pollJobs() {
        if (!this._initialized) return 0;
        const ids = (await (await this._view()).getJobsByProvider(this.providerAddress)).map(Number);
        const candidates = ids.filter(id => !this._terminal.has(id)).sort((a, b) => b - a).slice(0, POLL_BATCH);
        let processed = 0;
        for (const id of candidates) {
            const r = await this.processFundedJob(id, { source: 'poll' }).catch(err => ({ status: 'error', reason: err.message }));
            if (r?.status === 'completed') processed++;
        }
        return processed;
    }

    /**
     * Verify a job on-chain and, only if it pays and can be finished, do it. Safe to call from
     * anywhere (the poller, a client's POST /jobs/:id/fund): nothing is taken on trust.
     * @returns {Promise<{status: string, reason?: string}>}
     */
    async processFundedJob(jobId, { source = 'api' } = {}) {
        if (!this._initialized) return { status: 'disabled' };
        jobId = Number(jobId);
        if (!Number.isInteger(jobId) || jobId <= 0) return { status: 'rejected', reason: 'invalid job id' };
        if (this._processing.has(jobId)) return { status: 'in-progress' };
        this._processing.add(jobId);
        try {
            return await this._process(jobId, source);
        } finally {
            this._processing.delete(jobId);
        }
    }

    async _process(jobId, source) {
        const { ethers } = await import('ethers');
        const view = await this._view();
        const j = await view.getJob(jobId);
        const status = Number(j.status);
        const me = this.providerAddress.toLowerCase();
        const done = (why) => { this._terminal.add(jobId); return { status: 'ignored', reason: why }; };

        if (j.provider.toLowerCase() !== me) return done('not our job');
        if (status >= ST.COMPLETED) {
            await AgenticCommerceJob.updateOne({ jobId }, { status: STATUS_MAP[status] || 'Completed', executing: false });
            return done(`job is ${STATUS_MAP[status]}`);
        }
        if (j.evaluator.toLowerCase() !== me) return done('we must be the evaluator, or a third party could reject our work');
        if (j.paymentToken !== ethers.ZeroAddress) return done('only BNB-paid jobs are accepted');
        if (status === ST.OPEN) return { status: 'waiting', reason: 'not funded yet' };

        const [serviceType, paramsHash] = String(j.description).split(':');
        const pricing = this.getServicePrice(serviceType);
        if (!pricing || !/^0x[0-9a-f]{64}$/i.test(paramsHash || '')) return done('description is not "<service>:<paramsHash>"');

        const doc = await AgenticCommerceJob.findOne({ jobId }).select('+deliverableFiles');

        // Resume: our deliverable is on-chain, the job only needs completing
        if (status === ST.SUBMITTED) {
            if (!doc?.deliverableHash || doc.deliverableHash.toLowerCase() !== String(j.deliverable).toLowerCase()) return done('submitted by someone else');
            return this._complete(jobId, doc, ethers);
        }

        // status === FUNDED
        if (j.budget < ethers.parseEther(pricing.price)) return done(`budget ${ethers.formatEther(j.budget)} BNB is below the ${pricing.price} BNB price`);
        if (Number(j.expiredAt) - Math.floor(Date.now() / 1000) < MIN_TIME_LEFT_S) return { status: 'skipped', reason: 'too close to expiry: the client could refund before we are paid' };
        if (doc && doc.attempts >= MAX_ATTEMPTS) return done(`failed ${doc.attempts} times: ${doc.errorMessage}`);

        try {
            const scammerRegistry = (await import('./scammerRegistryService.js')).default;
            if (scammerRegistry.isAddressFlagged(j.client)) return done('client is in the scammer registry');
        } catch { /* registry unavailable */ }

        const quote = await AgenticCommerceQuote.findOne({ paramsHash: paramsHash.toLowerCase() }) || await AgenticCommerceQuote.findOne({ paramsHash });
        if (!quote || quote.serviceType !== serviceType) return { status: 'waiting', reason: 'no quote for these parameters (POST /api/external/jobs/create first)' };

        // Only work that pays for its own gas, twice over, and only while the wallet can pay it
        const provider = await this._provider();
        const feeBps = await this._feeBpsNow();
        const net = (j.budget * BigInt(10000 - feeBps)) / 10000n;
        const gasPrice = (await provider.getFeeData()).gasPrice || ethers.parseUnits('1', 'gwei');
        const gasCost = gasPrice * BigInt(GAS_ALLOWANCE);
        if (net < gasCost * 2n) return { status: 'skipped', reason: `net payment ${ethers.formatEther(net)} BNB does not cover gas ${ethers.formatEther(gasCost)} BNB twice` };
        if ((await provider.getBalance(this.providerAddress)) < gasCost * 3n) return { status: 'skipped', reason: 'wallet BNB too low for the gas' };

        const { SystemSettings } = await import('../../models/SystemSettings.js');
        const maxPerDay = Number(await SystemSettings.getSetting('agentic_commerce.maxJobsPerDay', 100));
        const today = await AgenticCommerceJob.countDocuments({ executionStarted: { $gte: new Date(Date.now() - 86400000) } });
        if (today >= maxPerDay) return { status: 'skipped', reason: `daily job cap (${maxPerDay}) reached` };

        // Claim the job (one executor, even across the poller and the API)
        await AgenticCommerceJob.updateOne(
            { jobId },
            { $setOnInsert: { jobId, client: j.client, provider: j.provider, evaluator: j.evaluator, serviceType, paramsHash, mode: 'B', status: 'Funded' } },
            { upsert: true }
        );
        const claimed = await AgenticCommerceJob.findOneAndUpdate(
            { jobId, executing: { $ne: true }, status: { $in: ['Open', 'Funded'] } },
            { $set: { executing: true, status: 'Funded', executionStarted: new Date(), serviceParams: quote.serviceParams,
                budget: j.budget.toString(), budgetFormatted: parseFloat(ethers.formatEther(j.budget)), paymentToken: 'BNB',
                expiredAt: new Date(Number(j.expiredAt) * 1000) }, $inc: { attempts: 1 } },
            { new: true }
        );
        if (!claimed) return { status: 'in-progress' };
        logger.info(`Job #${jobId} verified (${source}): ${serviceType}, ${ethers.formatEther(j.budget)} BNB from ${j.client} — executing`);

        // The work. A failure here spends no gas.
        let result;
        try {
            result = await this._run(claimed);
        } catch (err) {
            await AgenticCommerceJob.updateOne({ jobId }, { executing: false, errorMessage: String(err.message).slice(0, 500) });
            logger.warn(`Job #${jobId} execution failed (attempt ${claimed.attempts}/${MAX_ATTEMPTS}): ${err.message}`);
            return { status: 'failed', reason: err.message };
        }

        const files = this._files(result);
        const shown = publicResult(result);
        if (files.length) shown.files = files.map((f, i) => ({ index: i, name: f.name, download: `/api/external/jobs/${jobId}/file/${i}` }));
        // Unique per job: the facet refuses a deliverable hash it has seen before
        const deliverable = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
            ['uint256', 'bytes32'], [jobId, ethers.keccak256(ethers.toUtf8Bytes(canonical(shown)))]));

        const signed = await this._signingContract();
        // Rehearse first (free): a call that would revert is never sent, so a paused facet or a
        // job changed under us costs nothing instead of a failed transaction every poll.
        try {
            await signed.submitJob.staticCall(jobId, deliverable);
        } catch (err) {
            await AgenticCommerceJob.updateOne({ jobId }, { executing: false, errorMessage: `submit would revert: ${String(err.shortMessage || err.message).slice(0, 300)}` });
            return { status: 'skipped', reason: `submit would revert: ${err.shortMessage || err.message}` };
        }
        const tx = await signed.submitJob(jobId, deliverable, { gasLimit: GAS_LIMIT_SUBMIT });
        await tx.wait();
        claimed.status = 'Submitted';
        claimed.deliverableHash = deliverable;
        claimed.deliverableType = result?.type === 'file' ? 'file' : 'json';
        claimed.deliverableData = shown;
        claimed.deliverableFiles = files;
        claimed.executionCompleted = new Date();
        claimed.txHash = tx.hash;
        await claimed.save();
        logger.info(`Job #${jobId} deliverable submitted: ${tx.hash}`);

        return this._complete(jobId, claimed, ethers);
    }

    async _complete(jobId, doc, ethers) {
        const signed = await this._signingContract();
        const reason = ethers.keccak256(ethers.toUtf8Bytes('self-evaluation:success'));
        try {
            await signed.completeJob.staticCall(jobId, reason);
        } catch (err) {
            logger.warn(`Job #${jobId} complete would revert (${err.shortMessage || err.message}); retrying next poll, nothing sent`);
            return { status: 'skipped', reason: `complete would revert: ${err.shortMessage || err.message}` };
        }
        const tx = await signed.completeJob(jobId, reason, { gasLimit: GAS_LIMIT_COMPLETE });
        await tx.wait();
        doc.status = 'Completed';
        doc.reason = 'self-evaluation:success';
        doc.executing = false;
        await doc.save();
        this._terminal.add(jobId);
        await this._trackRevenue(doc);
        logger.info(`Job #${jobId} completed and paid: ${tx.hash}`);
        return { status: 'completed' };
    }

    async _run(job) {
        switch (job.serviceType) {
            case 'youtube-video':
            case 'youtube-audio': return this._executeYoutubeJob(job);
            case 'web-scrape': return this._executeScrapeJob(job);
            case 'transcode': return this._executeTranscodeJob(job);
            case 'image-gen': return this._executeImageGenJob(job);
            case 'document-process': return this._executeDocumentJob(job);
            default: throw new Error(`No handler for service type: ${job.serviceType}`);
        }
    }

    /** Local files a result points at (kept private; clients download by index). */
    _files(result) {
        const found = [];
        const add = (p, name) => {
            if (typeof p === 'string' && p.startsWith('/') && !found.some(f => f.path === p)) {
                found.push({ path: p, name: name || p.split('/').pop() });
            }
        };
        add(result?.file?.path, result?.file?.name || result?.file?.filename);
        for (const img of result?.images || []) add(img?.path || img?.filePath, img?.filename);
        add(result?.outputPath);
        return found;
    }

    /**
     * The client proves it is the job's client (the on-chain `client`) by signing
     * "LANAgent job <jobId> deliverable" with its wallet.
     */
    async verifyClientSignature(jobId, signature) {
        if (!this._initialized || typeof signature !== 'string') return false;
        const { ethers } = await import('ethers');
        try {
            const j = await (await this._view()).getJob(Number(jobId));
            const signer = ethers.verifyMessage(`LANAgent job ${Number(jobId)} deliverable`, signature);
            return signer.toLowerCase() === j.client.toLowerCase();
        } catch {
            return false;
        }
    }

    async getDeliverableFile(jobId, index) {
        const doc = await AgenticCommerceJob.findOne({ jobId: Number(jobId) }).select('+deliverableFiles');
        return doc?.status === 'Completed' ? (doc.deliverableFiles || [])[Number(index)] || null : null;
    }

    // --- Service Execution Handlers ---

    /**
     * A loaded, enabled plugin instance. Until 2026-09-27 every job handler imported
     * `../../api/pluginManager.js`, which does not exist, so every paid job failed on execution.
     */
    _plugin(name) {
        const apis = this.agent?.apiManager?.apis || this.agent?.services?.get?.('apiManager')?.apis;
        const entry = apis?.get(name);
        const plugin = entry?.instance || entry;
        if (!plugin || entry?.enabled === false || typeof plugin.execute !== 'function') {
            throw new Error(`${name} is not available on this agent`);
        }
        return plugin;
    }

    static _ok(result, what) {
        if (!result?.success) throw new Error(result?.error || `${what} failed`);
        return result;
    }

    /**
     * A job's input file. Job parameters come from a paying CLIENT, so a local path is never
     * accepted (a client could name the agent's .env); only fileBase64 or a public fileUrl,
     * fetched without redirects, as the paid document route does.
     */
    async _jobInputFile(params = {}) {
        const fs = await import('fs/promises');
        const path = await import('path');
        const os = await import('os');
        const crypto = await import('crypto');
        const safeExt = (e) => (/^\.[A-Za-z0-9]{1,8}$/.test(String(e || '')) ? String(e) : '');
        let ext = safeExt(params.fileExtension);
        let data;
        if (params.fileBase64) {
            data = Buffer.from(String(params.fileBase64), 'base64');
        } else if (params.fileUrl) {
            const { assertPublicUrl } = await import('../../utils/publicUrl.js');
            const url = await assertPublicUrl(params.fileUrl, 'fileUrl');
            if (!ext) ext = safeExt(path.extname(new URL(url).pathname));
            const axios = (await import('axios')).default;
            const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 50 * 1024 * 1024, maxRedirects: 0 });
            data = Buffer.from(resp.data);
        } else {
            throw new Error('Provide the input as fileUrl (public http/https) or fileBase64');
        }
        if (data.length > 50 * 1024 * 1024) throw new Error('Input file is over 50 MB');
        const file = path.join(os.tmpdir(), `job-${crypto.randomBytes(8).toString('hex')}${ext}`);
        await fs.writeFile(file, data);
        return file;
    }

    async _executeYoutubeJob(job) {
        const p = job.serviceParams || {};
        const { assertPublicUrl } = await import('../../utils/publicUrl.js');
        const url = await assertPublicUrl(p.url, 'url');
        const audio = job.serviceType === 'youtube-audio';
        const result = await this._plugin('ytdlp').execute(audio
            ? { action: 'audio', url, format: 'mp3' }
            : { action: 'download', url, ...(p.format ? { format: p.format } : {}), ...(p.quality ? { quality: p.quality } : {}) });
        return { type: 'file', ...AgenticCommerceService._ok(result, 'Download') };
    }

    async _executeScrapeJob(job) {
        const p = job.serviceParams || {};
        const { assertPublicUrl } = await import('../../utils/publicUrl.js');
        const url = await assertPublicUrl(p.url, 'url');
        const result = await this._plugin('scraper').execute({ action: 'scrape', url });
        return { type: 'json', ...AgenticCommerceService._ok(result, 'Scrape') };
    }

    async _executeTranscodeJob(job) {
        const p = job.serviceParams || {};
        const format = String(p.format || p.targetFormat || 'mp4').toLowerCase();
        if (!/^[a-z0-9]{2,5}$/.test(format)) throw new Error(`Unsupported format "${format}"`);
        const input = await this._jobInputFile(p);
        const path = await import('path');
        const output = input.replace(/(\.[A-Za-z0-9]+)?$/, `-out.${format}`);
        const result = await this._plugin('ffmpeg').execute({ action: 'convert', input, output, format, options: {} });
        return { type: 'file', ...AgenticCommerceService._ok(result, 'Transcode'), file: { path: output, name: path.basename(output) } };
    }

    async _executeImageGenJob(job) {
        const p = job.serviceParams || {};
        if (!p.prompt || typeof p.prompt !== 'string') throw new Error('prompt is required');
        const imageService = (await import('../media/imageGenerationService.js')).default;
        if (!imageService.initialized) {
            if (!this.agent?.providerManager) throw new Error('Image generation is not available yet');
            await imageService.initialize(this.agent.providerManager);
        }
        const result = await imageService.generate(p.prompt.substring(0, 4000), {
            ...(p.size ? { size: p.size } : {}), ...(p.style ? { style: p.style } : {})
        });
        return { type: 'file', ...AgenticCommerceService._ok(result, 'Image generation') };
    }

    async _executeDocumentJob(job) {
        const p = job.serviceParams || {};
        const filePath = await this._jobInputFile(p);
        const action = p.operation === 'extract' ? 'extractStructuredData' : 'processDocument';
        const result = await this._plugin('documentIntelligence').execute({
            action, filePath, ...(p.language ? { language: p.language } : {}), ...(p.outputFormat ? { outputFormat: p.outputFormat } : {})
        });
        return { type: 'json', ...AgenticCommerceService._ok(result, 'Document processing') };
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

    async getExecutionPerformanceStats() {
        return AgenticCommerceJob.getExecutionPerformanceStats();
    }

    async getCompletionTrends(days = 30) {
        return AgenticCommerceJob.getCompletionTrends({ days });
    }

    /** Public status: never the deliverable itself. */
    async getJobStatus(jobId) {
        const job = await AgenticCommerceJob.findOne({ jobId: Number(jobId) });
        if (job) return publicStatus(job);
        if (!this._initialized) return null;
        try {
            const onChain = await (await this._view()).getJob(Number(jobId));
            return { jobId: Number(jobId), status: STATUS_MAP[Number(onChain.status)] || 'Unknown', client: onChain.client, provider: onChain.provider, source: 'on-chain' };
        } catch {
            return null;
        }
    }

    /**
     * Status of many jobs in ONE database read, never the chain. A batch that fell back to an
     * RPC call per unknown id would turn one rate-limited request into 50 chain reads, and job
     * ids are sequential, so it would also scan every job's client address. Unknown ids are
     * simply absent; the single-job route still has the on-chain fallback.
     */
    async getJobStatuses(jobIds) {
        const ids = [...new Set(jobIds.map(Number))];
        const jobs = await AgenticCommerceJob.find({ jobId: { $in: ids } }).lean();
        return new Map(jobs.map(j => [j.jobId, publicStatus(j)]));
    }

    async getDeliverable(jobId) {
        const job = await AgenticCommerceJob.findOne({ jobId: Number(jobId) });
        if (!job || job.status !== 'Completed') return null;
        return { jobId: job.jobId, deliverableHash: job.deliverableHash, deliverableType: job.deliverableType, deliverableData: job.deliverableData };
    }
}

/** The public fields of a job this agent holds (shared by single and batch status). */
function publicStatus(job) {
    return {
        jobId: job.jobId, status: job.status, serviceType: job.serviceType, client: job.client,
        budget: job.budgetFormatted, currency: job.paymentToken, expiredAt: job.expiredAt,
        executionStarted: job.executionStarted, executionCompleted: job.executionCompleted,
        deliverableHash: job.deliverableHash || null, error: job.errorMessage || null
    };
}

export const _internals = { canonical, publicResult, SIGN_ABI, publicStatus };
export default new AgenticCommerceService();
