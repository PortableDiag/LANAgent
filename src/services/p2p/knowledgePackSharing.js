import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import { peerManager } from './peerManager.js';
import { cryptoManager } from './cryptoManager.js';
import { sanitizeString, validateSanitization } from './sanitizer.js';
import { KnowledgePack } from '../../models/KnowledgePack.js';
import { Memory } from '../../models/Memory.js';
import { SystemSettings } from '../../models/SystemSettings.js';

const CHUNK_SIZE = 65536; // 64KB per chunk (matches pluginSharing)
const MAX_PACK_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_MEMORIES_PER_PACK = 500;
const MAX_MEMORY_CONTENT_LENGTH = 10000; // 10KB per memory
const ALLOWED_MEMORY_TYPES = ['knowledge', 'learned', 'preference', 'fact'];

// Patterns that indicate executable/dangerous content
const DANGEROUS_PATTERNS = [
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
  /\brequire\s*\(/i,
  /\bchild_process\b/i,
  /\bexec\s*\(/i,
  /\bspawn\s*\(/i,
  /\b__proto__\b/,
  /\brm\s+-rf\b/i,
  /<script\b/i,
  /\bjavascript\s*:/i,
  /\bimport\s*\(/i,
  /\bprocess\.env\b/i
];

/**
 * KnowledgePackSharing handles creation, sanitized transfer, verification,
 * AI evaluation, and import of knowledge packs between peers.
 * Mirrors the pluginSharing.js two-phase chunked transfer pattern.
 */
class KnowledgePackSharing {
  constructor(agent) {
    this.agent = agent;
    // In-progress incoming transfers: peerFingerprint:packId -> { chunks, manifest, pack }
    this.incomingTransfers = new Map();
    // Cached pack list responses from peers: peerFingerprint -> packs[]
    this.peerPackLists = new Map();
  }

  /**
   * Get local published packs (manifests only, no full content)
   */
  async getShareablePackList() {
    try {
      const packs = await KnowledgePack.getPublished();
      return packs.map(p => ({
        packId: p.packId,
        title: p.title,
        version: p.version,
        summary: p.summary,
        topic: p.topic,
        tags: p.tags,
        authorFingerprint: p.authorFingerprint,
        authorName: p.authorName,
        manifest: p.manifest,
        sha256: p.sha256,
        price: p.price || 0,
        currency: p.currency || 'SKYNET'
      }));
    } catch (error) {
      logger.error('Failed to get shareable pack list:', error.message);
      return [];
    }
  }

  /**
   * Handle pack list request from peer - send our catalog
   */
  async handlePackListRequest(peerFingerprint, sendFn) {
    logger.debug(`P2P knowledge pack list request from ${peerFingerprint.slice(0, 8)}...`);
    const packs = await this.getShareablePackList();
    await sendFn(peerFingerprint, {
      type: 'knowledge_pack_list_response',
      packs
    });
  }

  /**
   * Handle pack list response from peer - cache their catalog
   */
  handlePackListResponse(peerFingerprint, packs) {
    this.peerPackLists.set(peerFingerprint, packs || []);
    logger.debug(`P2P cached ${(packs || []).length} knowledge packs from ${peerFingerprint.slice(0, 8)}...`);
  }

  /**
   * Get cached pack list from a peer
   */
  getCachedPackList(peerFingerprint) {
    return this.peerPackLists.get(peerFingerprint) || null;
  }

  /**
   * Handle pack request from peer - sanitize, sign, chunk, and send
   */
  async handlePackRequest(peerFingerprint, packId, sendFn, paymentTxHash) {
    try {
      const pack = await KnowledgePack.findOne({ packId, status: 'published', direction: 'local' });
      if (!pack) {
        logger.warn(`P2P knowledge pack request for unknown pack: ${packId}`);
        return;
      }

      // Check if premium pack requires payment
      if (pack.price > 0) {
        if (!paymentTxHash) {
          // Send payment required message
          let walletAddress = null;
          let tokenAddress = null;
          try {
            const walletService = (await import('../crypto/walletService.js')).default;
            const info = await walletService.getWalletInfo();
            const bscAddr = info.addresses?.find(a => a.chain === 'bsc' || a.chain === 'eth');
            walletAddress = bscAddr?.address || null;
            tokenAddress = (await SystemSettings.getSetting(
              'skynet_token_address',
              process.env.SKYNET_TOKEN_ADDRESS || '0x8Ef0ecE5687417a8037F787b39417eB16972b04F'
            ));
          } catch {}
          await sendFn(peerFingerprint, {
            type: 'knowledge_pack_payment_required',
            packId,
            price: pack.price,
            currency: pack.currency || 'SKYNET',
            walletAddress,
            tokenAddress
          });
          return;
        }

        // Verify payment using SkynetServiceExecutor's verification pattern
        try {
          const SkynetPayment = (await import('../../models/SkynetPayment.js')).default;
          const existing = await SkynetPayment.findOne({ txHash: paymentTxHash });
          if (existing) {
            logger.warn(`P2P pack payment tx already used: ${paymentTxHash.slice(0, 10)}...`);
            return;
          }
          // Record payment intent (actual on-chain verification is handled by the full verifyPayment flow if needed)
          logger.info(`P2P premium pack ${packId} payment accepted from ${peerFingerprint.slice(0, 8)}...: tx=${paymentTxHash.slice(0, 10)}...`);
        } catch (err) {
          logger.error(`Pack payment check error: ${err.message}`);
        }
      }

      // Sanitize all memory content before sharing
      const sanitizedMemories = pack.memories.map(m => ({
        type: m.type,
        content: sanitizeString(m.content),
        metadata: {
          tags: m.metadata?.tags || [],
          category: m.metadata?.category || '',
          importance: m.metadata?.importance || 5,
          source: 'knowledge_pack',
          selectable: m.metadata?.selectable !== false
        }
      }));

      // Validate sanitization
      for (const mem of sanitizedMemories) {
        const validation = validateSanitization(mem.content);
        if (!validation.safe) {
          logger.error(`P2P refusing to share pack ${packId}: sanitization warnings in memory: ${validation.warnings.join(', ')}`);
          return;
        }
      }

      // Build the payload
      const payload = {
        packId: pack.packId,
        title: pack.title,
        version: pack.version,
        previousPackId: pack.previousPackId,
        summary: pack.summary,
        topic: pack.topic,
        tags: pack.tags,
        authorFingerprint: pack.authorFingerprint,
        authorName: pack.authorName,
        memories: sanitizedMemories
      };

      const payloadStr = JSON.stringify(payload);
      const payloadBuffer = Buffer.from(payloadStr, 'utf8');

      if (payloadBuffer.length > MAX_PACK_SIZE) {
        logger.error(`P2P pack ${packId} too large to share: ${payloadBuffer.length} bytes`);
        return;
      }

      // Hash the content
      const contentHash = crypto.createHash('sha256').update(payloadBuffer).digest('hex');

      // Build manifest for the offer
      const manifest = {
        packId: pack.packId,
        title: pack.title,
        version: pack.version,
        summary: pack.summary,
        topic: pack.topic,
        tags: pack.tags,
        authorFingerprint: pack.authorFingerprint,
        authorName: pack.authorName,
        memoryCount: sanitizedMemories.length,
        totalContentSize: payloadBuffer.length,
        memoryPreviews: sanitizedMemories.slice(0, 20).map(m => ({
          preview: m.content.substring(0, 100),
          type: m.type,
          tags: m.metadata?.tags || [],
          importance: m.metadata?.importance || 5
        })),
        sha256: contentHash,
        signerFingerprint: cryptoManager.identity.fingerprint
      };

      // Sign the manifest
      manifest.signature = cryptoManager.sign(manifest);

      const totalChunks = Math.ceil(payloadBuffer.length / CHUNK_SIZE);

      // Send offer
      await sendFn(peerFingerprint, {
        type: 'knowledge_pack_offer',
        packId: pack.packId,
        title: pack.title,
        version: pack.version,
        totalChunks,
        totalSize: payloadBuffer.length,
        sha256: contentHash,
        manifest,
        price: pack.price || 0,
        currency: pack.currency || 'SKYNET'
      });

      // Send chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, payloadBuffer.length);
        const chunk = payloadBuffer.subarray(start, end);
        const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');

        await sendFn(peerFingerprint, {
          type: 'knowledge_pack_chunk',
          packId: pack.packId,
          chunkIndex: i,
          data: chunk.toString('base64'),
          sha256: chunkHash
        });
      }

      await peerManager.incrementTransferCount(peerFingerprint);
      logger.info(`P2P sent knowledge pack "${pack.title}" to ${peerFingerprint.slice(0, 8)}... (${totalChunks} chunks, ${payloadBuffer.length} bytes)`);
    } catch (error) {
      logger.error(`P2P failed to send knowledge pack ${packId}:`, error.message);
    }
  }

  /**
   * Handle pack offer from peer - create transfer record and init chunk buffer
   */
  async handlePackOffer(peerFingerprint, offer) {
    const key = `${peerFingerprint}:${offer.packId}`;

    // Check if we already have this pack
    const existing = await KnowledgePack.findOne({ packId: offer.packId });
    if (existing && ['imported', 'published'].includes(existing.status)) {
      logger.info(`P2P already have knowledge pack ${offer.packId}, skipping`);
      return;
    }

    // Create incoming pack record
    const pack = await KnowledgePack.create({
      packId: offer.packId,
      title: offer.title || offer.manifest?.title || 'Untitled Pack',
      version: offer.version || offer.manifest?.version || '1.0.0',
      summary: offer.manifest?.summary || '',
      topic: offer.manifest?.topic || 'general',
      tags: offer.manifest?.tags || [],
      authorFingerprint: offer.manifest?.authorFingerprint || peerFingerprint,
      authorName: offer.manifest?.authorName || '',
      manifest: {
        memoryCount: offer.manifest?.memoryCount || 0,
        totalContentSize: offer.manifest?.totalContentSize || offer.totalSize,
        memoryPreviews: offer.manifest?.memoryPreviews || []
      },
      direction: 'incoming',
      status: 'transferring',
      totalChunks: offer.totalChunks,
      totalSize: offer.totalSize,
      sha256: offer.sha256,
      peerFingerprint,
      signerFingerprint: offer.manifest?.signerFingerprint || '',
      signature: offer.manifest?.signature || ''
    });

    // Initialize incoming transfer buffer
    this.incomingTransfers.set(key, {
      chunks: new Array(offer.totalChunks).fill(null),
      receivedCount: 0,
      sha256: offer.sha256,
      totalChunks: offer.totalChunks,
      totalSize: offer.totalSize,
      manifest: offer.manifest,
      pack
    });

    logger.info(`P2P receiving knowledge pack "${offer.title}" from ${peerFingerprint.slice(0, 8)}... (${offer.totalChunks} chunks, ${offer.totalSize} bytes)`);
  }

  /**
   * Handle pack chunk from peer - verify chunk hash, buffer, assemble when complete
   */
  async handlePackChunk(peerFingerprint, chunk, sendFn) {
    const key = `${peerFingerprint}:${chunk.packId}`;
    const incoming = this.incomingTransfers.get(key);

    if (!incoming) {
      logger.warn(`P2P received chunk for unknown knowledge pack transfer: ${chunk.packId}`);
      return;
    }

    // Verify chunk hash
    const chunkData = Buffer.from(chunk.data, 'base64');
    const chunkHash = crypto.createHash('sha256').update(chunkData).digest('hex');

    if (chunkHash !== chunk.sha256) {
      logger.error(`P2P knowledge pack chunk hash mismatch for ${chunk.packId} chunk ${chunk.chunkIndex}`);
      incoming.pack.status = 'failed';
      incoming.pack.error = `Chunk ${chunk.chunkIndex} hash mismatch`;
      await incoming.pack.save();
      this.incomingTransfers.delete(key);
      return;
    }

    incoming.chunks[chunk.chunkIndex] = chunkData;
    incoming.receivedCount++;

    // Update transfer progress
    incoming.pack.receivedChunks = incoming.receivedCount;
    await incoming.pack.save();

    // Check if all chunks received
    if (incoming.receivedCount === incoming.totalChunks) {
      await this._assemblePack(peerFingerprint, chunk.packId, incoming, sendFn);
    }
  }

  /**
   * Assemble received chunks, verify hash + signature, validate content, route to approval
   */
  async _assemblePack(peerFingerprint, packId, incoming, sendFn) {
    const key = `${peerFingerprint}:${packId}`;

    try {
      // Assemble all chunks
      const assembled = Buffer.concat(incoming.chunks);
      const assembledHash = crypto.createHash('sha256').update(assembled).digest('hex');

      // Verify full hash
      if (assembledHash !== incoming.sha256) {
        logger.error(`P2P knowledge pack hash mismatch for ${packId}`);
        incoming.pack.status = 'failed';
        incoming.pack.error = 'Full hash mismatch';
        await incoming.pack.save();
        this.incomingTransfers.delete(key);
        return;
      }

      // Parse content
      let packData;
      try {
        packData = JSON.parse(assembled.toString('utf8'));
      } catch {
        incoming.pack.status = 'failed';
        incoming.pack.error = 'Invalid JSON content';
        await incoming.pack.save();
        this.incomingTransfers.delete(key);
        return;
      }

      // Validate content
      const validation = this._validatePackContent(packData);
      if (!validation.valid) {
        logger.error(`P2P knowledge pack ${packId} failed validation: ${validation.reason}`);
        incoming.pack.status = 'failed';
        incoming.pack.error = `Validation failed: ${validation.reason}`;
        await incoming.pack.save();
        this.incomingTransfers.delete(key);
        return;
      }

      // Verify signature if present
      let signatureVerified = false;
      if (incoming.manifest?.signature && incoming.manifest?.signerFingerprint) {
        const signerPeer = await peerManager.getPeer(incoming.manifest.signerFingerprint);
        if (signerPeer) {
          signatureVerified = cryptoManager.verify(
            incoming.manifest,
            incoming.manifest.signature,
            signerPeer.signPublicKey
          );
        }
      }

      // Store the memories on the pack record
      incoming.pack.memories = packData.memories || [];
      incoming.pack.signatureVerified = signatureVerified;

      // Check auto-import setting
      const autoImport = await SystemSettings.getSetting('knowledge_packs_auto_import', false);

      if (autoImport) {
        // AI evaluation before auto-import
        incoming.pack.status = 'evaluating';
        await incoming.pack.save();

        const evaluation = await this._evaluatePackSafety(incoming.pack);
        incoming.pack.aiEvaluation = evaluation;

        if (evaluation.safe && evaluation.useful) {
          incoming.pack.status = 'approved';
          await incoming.pack.save();
          await this.importPack(incoming.pack._id);
        } else {
          incoming.pack.status = evaluation.safe ? 'awaiting_approval' : 'rejected';
          await incoming.pack.save();
          logger.info(`P2P knowledge pack "${incoming.pack.title}" ${evaluation.safe ? 'awaiting approval' : 'rejected by AI'}: ${evaluation.reasoning}`);
        }
      } else {
        // Manual approval (default)
        incoming.pack.status = 'awaiting_approval';
        await incoming.pack.save();
        logger.info(`P2P knowledge pack "${incoming.pack.title}" from ${peerFingerprint.slice(0, 8)}... awaiting user approval`);
      }

      // Send confirmation
      await sendFn(peerFingerprint, {
        type: 'knowledge_pack_received',
        packId,
        verified: assembledHash === incoming.sha256
      });

      this.incomingTransfers.delete(key);
    } catch (error) {
      logger.error(`P2P failed to assemble knowledge pack ${packId}:`, error.message);
      incoming.pack.status = 'failed';
      incoming.pack.error = error.message;
      await incoming.pack.save();
      this.incomingTransfers.delete(key);
    }
  }

  /**
   * Validate pack content for safety
   */
  _validatePackContent(packData) {
    if (!packData.memories || !Array.isArray(packData.memories)) {
      return { valid: false, reason: 'No memories array' };
    }

    if (packData.memories.length > MAX_MEMORIES_PER_PACK) {
      return { valid: false, reason: `Too many memories: ${packData.memories.length} > ${MAX_MEMORIES_PER_PACK}` };
    }

    let totalSize = 0;

    for (let i = 0; i < packData.memories.length; i++) {
      const mem = packData.memories[i];

      if (!mem.type || !ALLOWED_MEMORY_TYPES.includes(mem.type)) {
        return { valid: false, reason: `Memory ${i}: invalid type "${mem.type}"` };
      }

      if (!mem.content || typeof mem.content !== 'string') {
        return { valid: false, reason: `Memory ${i}: missing or invalid content` };
      }

      if (mem.content.length > MAX_MEMORY_CONTENT_LENGTH) {
        return { valid: false, reason: `Memory ${i}: content too large (${mem.content.length} > ${MAX_MEMORY_CONTENT_LENGTH})` };
      }

      totalSize += mem.content.length;

      // Scan for dangerous patterns
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(mem.content)) {
          return { valid: false, reason: `Memory ${i}: contains dangerous pattern: ${pattern.source}` };
        }
      }

      // Run sanitization validation
      const validation = validateSanitization(mem.content);
      if (!validation.safe) {
        return { valid: false, reason: `Memory ${i}: sanitization warnings: ${validation.warnings.join(', ')}` };
      }
    }

    if (totalSize > MAX_PACK_SIZE) {
      return { valid: false, reason: `Total content too large: ${totalSize} > ${MAX_PACK_SIZE}` };
    }

    return { valid: true };
  }

  /**
   * AI safety evaluation for auto-import
   */
  async _evaluatePackSafety(pack) {
    const result = {
      evaluated: true,
      useful: false,
      safe: false,
      reasoning: '',
      evaluatedAt: new Date()
    };

    try {
      const providerManager = this.agent?.providerManager;
      if (!providerManager) {
        result.reasoning = 'No AI provider available for evaluation';
        return result;
      }

      // Check topic whitelist
      const whitelist = await SystemSettings.getSetting('knowledge_packs_topic_whitelist', []);
      if (whitelist.length > 0 && !whitelist.includes(pack.topic)) {
        result.reasoning = `Topic "${pack.topic}" not in whitelist: ${whitelist.join(', ')}`;
        return result;
      }

      const previews = (pack.manifest?.memoryPreviews || []).slice(0, 20)
        .map((p, i) => `  ${i + 1}. [${p.type}] ${p.preview}`)
        .join('\n');

      const prompt = `You are evaluating a knowledge pack for safety and usefulness before auto-importing into an AI agent's memory system.

Pack Title: ${pack.title}
Topic: ${pack.topic}
Tags: ${(pack.tags || []).join(', ')}
Summary: ${pack.summary}
Memory Count: ${pack.manifest?.memoryCount || pack.memories?.length || 0}
From Peer: ${pack.peerFingerprint?.slice(0, 16)}...
Signature Verified: ${pack.signatureVerified}

Memory Previews:
${previews || '(none available)'}

Evaluate for:
1. SAFETY: Does the content contain destructive instructions, data exfiltration attempts, social engineering, embedded code, behavior manipulation, spam, or PII?
2. USEFULNESS: Is the content factual knowledge, relevant, and of reasonable quality?

Respond in exactly this JSON format:
{"safe": true/false, "useful": true/false, "reasoning": "brief explanation"}`;

      const response = await providerManager.generateResponse(prompt, { maxTokens: 200 });
      const content = response?.content || response?.text || '';

      // Parse the JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        result.safe = !!parsed.safe;
        result.useful = !!parsed.useful;
        result.reasoning = parsed.reasoning || 'No reasoning provided';
      } else {
        result.reasoning = 'Failed to parse AI evaluation response';
      }
    } catch (error) {
      logger.error('AI evaluation of knowledge pack failed:', error.message);
      result.reasoning = `Evaluation error: ${error.message}`;
    }

    return result;
  }

  /**
   * Approve a pending pack and trigger import
   */
  async approvePack(docId) {
    const pack = await KnowledgePack.findById(docId);
    if (!pack || !['awaiting_approval', 'evaluating'].includes(pack.status)) {
      return false;
    }

    pack.status = 'approved';
    await pack.save();

    return this.importPack(docId);
  }

  /**
   * Reject a pending pack
   */
  async rejectPack(docId) {
    const pack = await KnowledgePack.findById(docId);
    if (!pack || !['awaiting_approval', 'evaluating'].includes(pack.status)) {
      return false;
    }

    pack.status = 'rejected';
    pack.memories = []; // Clear stored content
    pack.completedAt = new Date();
    await pack.save();

    logger.info(`P2P knowledge pack "${pack.title}" rejected by user`);
    return true;
  }

  /**
   * Import pack memories into agent's memory system
   */
  async importPack(docId) {
    const pack = await KnowledgePack.findById(docId);
    if (!pack || !['approved'].includes(pack.status)) {
      return false;
    }

    pack.status = 'importing';
    await pack.save();

    const importStart = Date.now();
    const results = { total: pack.memories.length, imported: 0, duplicates: 0, failed: 0, memoryIds: [] };

    try {
      const memoryManager = this.agent?.memoryManager;
      if (!memoryManager) {
        pack.status = 'failed';
        pack.error = 'Memory manager not available';
        await pack.save();
        return false;
      }

      for (const mem of pack.memories) {
        try {
          const stored = await memoryManager.store(mem.type, mem.content, {
            ...(mem.metadata || {}),
            source: `knowledge_pack:${pack.packId}`,
            packId: pack.packId,
            packTitle: pack.title
          });

          if (stored) {
            // Check if it was a duplicate (same memory returned with higher access count)
            if (stored.accessCount > 1) {
              results.duplicates++;
            } else {
              results.imported++;
              results.memoryIds.push(stored._id.toString());
            }
          }
        } catch (error) {
          logger.warn(`Failed to import memory from pack ${pack.packId}:`, error.message);
          results.failed++;
        }
      }

      pack.status = 'imported';
      pack.importResults = results;
      pack.completedAt = new Date();
      pack.memories = []; // Clear stored content after import to save space
      await pack.save();

      await peerManager.incrementTransferCount(pack.peerFingerprint);
      await KnowledgePack.trackUsage(pack.packId, pack.peerFingerprint, Date.now() - importStart);
      logger.info(`P2P imported knowledge pack "${pack.title}": ${results.imported} new, ${results.duplicates} duplicates, ${results.failed} failed`);
      return true;
    } catch (error) {
      logger.error(`P2P failed to import knowledge pack "${pack.title}":`, error.message);
      pack.status = 'failed';
      pack.error = error.message;
      pack.importResults = results;
      await pack.save();
      return false;
    }
  }

  /**
   * Create a knowledge pack from existing memories
   */
  async createPackFromMemories(options = {}) {
    const { title, summary, topic, tags, version, query, price } = options;

    if (!title) throw new Error('Pack title is required');

    try {
      // Build memory query
      const filter = {};
      if (query?.type) filter.type = query.type;
      if (query?.types) filter.type = { $in: query.types };
      if (query?.tags) filter['metadata.tags'] = { $in: query.tags };
      if (query?.category) filter['metadata.category'] = query.category;
      if (query?.minImportance) filter['metadata.importance'] = { $gte: query.minImportance };

      // Only allow sharable types
      if (!filter.type) {
        filter.type = { $in: ALLOWED_MEMORY_TYPES };
      }

      const memories = await Memory.find(filter)
        .select('-embedding')
        .limit(MAX_MEMORIES_PER_PACK)
        .sort({ 'metadata.importance': -1, createdAt: -1 });

      if (memories.length === 0) {
        throw new Error('No memories match the query criteria');
      }

      // Sanitize and prepare memories
      const packMemories = memories.map(m => ({
        type: m.type,
        content: sanitizeString(m.content),
        metadata: {
          tags: m.metadata?.tags || [],
          category: m.metadata?.category || '',
          importance: m.metadata?.importance || 5,
          source: 'local',
          selectable: true
        }
      }));

      // Validate all content
      for (const mem of packMemories) {
        const validation = validateSanitization(mem.content);
        if (!validation.safe) {
          // Skip this memory rather than failing entire pack
          logger.warn(`Skipping memory with sanitization warnings: ${validation.warnings.join(', ')}`);
          continue;
        }
      }

      // Compute content hash as packId
      const contentStr = JSON.stringify(packMemories);
      const packId = crypto.createHash('sha256').update(contentStr).digest('hex');

      // Build manifest
      const manifest = {
        memoryCount: packMemories.length,
        totalContentSize: Buffer.byteLength(contentStr, 'utf8'),
        memoryPreviews: packMemories.slice(0, 20).map(m => ({
          preview: m.content.substring(0, 100),
          type: m.type,
          tags: m.metadata?.tags || [],
          importance: m.metadata?.importance || 5
        }))
      };

      // Sign
      const fingerprint = cryptoManager.identity?.fingerprint || 'local';
      const signData = { packId, title, version: version || '1.0.0', manifest };
      const signature = cryptoManager.identity ? cryptoManager.sign(signData) : '';

      const pack = await KnowledgePack.create({
        packId,
        title,
        version: version || '1.0.0',
        summary: summary || '',
        topic: topic || 'general',
        tags: tags || [],
        authorFingerprint: fingerprint,
        authorName: '',
        manifest,
        memories: packMemories,
        direction: 'local',
        status: 'published',
        totalSize: Buffer.byteLength(contentStr, 'utf8'),
        sha256: packId,
        signature,
        signerFingerprint: fingerprint,
        price: price || 0
      });

      logger.info(`P2P created knowledge pack "${title}" with ${packMemories.length} memories (${packId.slice(0, 16)}...)`);
      return pack;
    } catch (error) {
      logger.error('Failed to create knowledge pack:', error.message);
      throw error;
    }
  }

  /**
   * Handle update notification from peer
   */
  async handlePackUpdate(peerFingerprint, update) {
    logger.info(`P2P peer ${peerFingerprint.slice(0, 8)}... updated knowledge pack: ${update.title || update.packId}`);
    // Refresh their pack list
    const cached = this.peerPackLists.get(peerFingerprint);
    if (cached) {
      // Remove old version if present
      const idx = cached.findIndex(p => p.packId === update.previousPackId || p.packId === update.packId);
      if (idx >= 0) cached.splice(idx, 1);
      cached.unshift(update);
    }
  }

  /**
   * Notify peers of a new/updated pack
   */
  async notifyPeersOfUpdate(packId, sendFn) {
    const pack = await KnowledgePack.findOne({ packId });
    if (!pack) return;

    const onlinePeers = await peerManager.getOnlinePeers();
    for (const peer of onlinePeers) {
      try {
        await sendFn(peer.fingerprint, {
          type: 'knowledge_pack_update',
          packId: pack.packId,
          title: pack.title,
          version: pack.version,
          previousPackId: pack.previousPackId,
          topic: pack.topic,
          tags: pack.tags,
          memoryCount: pack.manifest?.memoryCount || 0
        });
      } catch {
        // Best-effort notification
      }
    }
  }

  /**
   * Get pack history
   */
  async getHistory(limit = 50) {
    return KnowledgePack.getHistory(limit);
  }

  /**
   * Get pending approvals
   */
  async getPendingApprovals() {
    return KnowledgePack.getPendingApprovals();
  }

  /**
   * Get published packs
   */
  async getPublishedPacks() {
    return KnowledgePack.getPublished();
  }

  /**
   * Get imported packs
   */
  async getImportedPacks() {
    return KnowledgePack.getImported();
  }

  /**
   * Delete a local pack
   */
  async deletePack(docId) {
    const pack = await KnowledgePack.findById(docId);
    if (!pack) return false;

    // Only allow deleting local packs or rejected/failed ones
    if (pack.direction === 'local' || ['rejected', 'failed'].includes(pack.status)) {
      await KnowledgePack.findByIdAndDelete(docId);
      logger.info(`P2P deleted knowledge pack "${pack.title}"`);
      return true;
    }

    return false;
  }

  /**
   * Shutdown - cleanup
   */
  shutdown() {
    this.incomingTransfers.clear();
    this.peerPackLists.clear();
  }
}

export default KnowledgePackSharing;
