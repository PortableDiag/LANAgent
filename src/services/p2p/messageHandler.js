import { logger } from '../../utils/logger.js';
import { cryptoManager } from './cryptoManager.js';
import { peerManager } from './peerManager.js';

/**
 * MessageHandler handles incoming decrypted messages by routing them to the appropriate handler
 * Works with: capabilities exchange, plugin sharing, knowledge pack sharing, ping/pong
 */
class MessageHandler {
  constructor() {
    this.pluginSharing = null; // Set after pluginSharing is initialized
    this.knowledgePackSharing = null; // Set after knowledgePackSharing is initialized
    this.skynetServiceExecutor = null; // Set after skynetServiceExecutor is initialized
    this.skynetEconomy = null; // Set after skynetEconomy is initialized
    this.handlers = new Map();
    this._registerHandlers();
  }

  /**
   * Register all message type handlers
   */
  _registerHandlers() {
    this.handlers.set('capabilities_request', this._handleCapabilitiesRequest.bind(this));
    this.handlers.set('capabilities_response', this._handleCapabilitiesResponse.bind(this));
    this.handlers.set('plugin_list_request', this._handlePluginListRequest.bind(this));
    this.handlers.set('plugin_list_response', this._handlePluginListResponse.bind(this));
    this.handlers.set('plugin_request', this._handlePluginRequest.bind(this));
    this.handlers.set('plugin_offer', this._handlePluginOffer.bind(this));
    this.handlers.set('plugin_chunk', this._handlePluginChunk.bind(this));
    this.handlers.set('plugin_received', this._handlePluginReceived.bind(this));
    this.handlers.set('knowledge_pack_list_request', this._handleKnowledgePackListRequest.bind(this));
    this.handlers.set('knowledge_pack_list_response', this._handleKnowledgePackListResponse.bind(this));
    this.handlers.set('knowledge_pack_request', this._handleKnowledgePackRequest.bind(this));
    this.handlers.set('knowledge_pack_offer', this._handleKnowledgePackOffer.bind(this));
    this.handlers.set('knowledge_pack_chunk', this._handleKnowledgePackChunk.bind(this));
    this.handlers.set('knowledge_pack_received', this._handleKnowledgePackReceived.bind(this));
    this.handlers.set('knowledge_pack_update', this._handleKnowledgePackUpdate.bind(this));
    this.handlers.set('knowledge_pack_payment_required', this._handleKnowledgePackPaymentRequired.bind(this));
    this.handlers.set('ping', this._handlePing.bind(this));
    this.handlers.set('pong', this._handlePong.bind(this));

    // Skynet paid service handlers
    this.handlers.set('service_catalog_request', this._handleServiceCatalogRequest.bind(this));
    this.handlers.set('service_catalog_response', this._handleServiceCatalogResponse.bind(this));
    this.handlers.set('service_request', this._handleServiceRequest.bind(this));
    this.handlers.set('service_result', this._handleServiceResult.bind(this));
    this.handlers.set('service_error', this._handleServiceError.bind(this));
    this.handlers.set('payment_required', this._handlePaymentRequired.bind(this));

    // Skynet economy handlers (bounties, governance, tipping)
    this.handlers.set('bounty_post', this._handleBountyPost.bind(this));
    this.handlers.set('bounty_claim', this._handleBountyClaim.bind(this));
    this.handlers.set('bounty_claim_response', this._handleBountyClaimResponse.bind(this));
    this.handlers.set('governance_proposal', this._handleGovernanceProposal.bind(this));
    this.handlers.set('governance_vote', this._handleGovernanceVote.bind(this));
    this.handlers.set('tip_received', this._handleTipReceived.bind(this));

    // Data marketplace handlers
    this.handlers.set('data_listing_post', this._handleDataListingPost.bind(this));
    this.handlers.set('data_purchase_request', this._handleDataPurchaseRequest.bind(this));
    this.handlers.set('data_purchase_response', this._handleDataPurchaseResponse.bind(this));

    // Referral & arbitrage handlers
    this.handlers.set('referral_reward', this._handleReferralReward.bind(this));
    this.handlers.set('arb_signal', this._handleArbSignal.bind(this));

    // ENS subname handlers
    this.handlers.set('ens_subname_request', this._handleENSSubnameRequest.bind(this));
    this.handlers.set('ens_subname_response', this._handleENSSubnameResponse.bind(this));
    this.handlers.set('ens_subname_payment_required', this._handleENSSubnamePaymentRequired.bind(this));

    // Compute rental handlers
    this.handlers.set('compute_request', this._handleComputeRequest.bind(this));
    this.handlers.set('compute_response', this._handleComputeResponse.bind(this));
    this.handlers.set('compute_payment_required', this._handleComputePaymentRequired.bind(this));

    // Email lease handlers
    this.handlers.set('email_lease_request', this._handleEmailLeaseRequest.bind(this));
    this.handlers.set('email_lease_response', this._handleEmailLeaseResponse.bind(this));
    this.handlers.set('email_lease_payment_required', this._handleEmailLeasePaymentRequired.bind(this));
    this.handlers.set('email_lease_renew', this._handleEmailLeaseRenew.bind(this));
    this.handlers.set('email_lease_revoke', this._handleEmailLeaseRevoke.bind(this));

    // Welcome package handlers
    this.handlers.set('welcome_package_request', this._handleWelcomePackageRequest.bind(this));
    this.handlers.set('welcome_package_response', this._handleWelcomePackageResponse.bind(this));
  }

  /**
   * Set the plugin sharing module reference
   * @param {object} pluginSharing
   */
  setPluginSharing(pluginSharing) {
    this.pluginSharing = pluginSharing;
  }

  /**
   * Set the knowledge pack sharing module reference
   * @param {object} knowledgePackSharing
   */
  setKnowledgePackSharing(knowledgePackSharing) {
    this.knowledgePackSharing = knowledgePackSharing;
  }

  /**
   * Set the Skynet service executor reference
   * @param {object} skynetServiceExecutor
   */
  setSkynetServiceExecutor(skynetServiceExecutor) {
    this.skynetServiceExecutor = skynetServiceExecutor;
  }

  /**
   * Set the Skynet economy module reference
   * @param {object} skynetEconomy
   */
  setSkynetEconomy(skynetEconomy) {
    this.skynetEconomy = skynetEconomy;
  }

  /**
   * Handle an incoming encrypted message from a peer
   * @param {string} fromFingerprint - Sender's fingerprint
   * @param {string} encryptedPayload - Base64 encoded encrypted envelope
   * @param {Function} sendFn - Function to send a reply: sendFn(fingerprint, message)
   * @returns {Promise<boolean>} Whether the message was handled successfully
   */
  async handleMessage(fromFingerprint, encryptedPayload, sendFn) {
    try {
      // Get the peer's public key
      const peer = await peerManager.getPeer(fromFingerprint);
      if (!peer) {
        logger.warn(`P2P message from unknown peer: ${fromFingerprint.slice(0, 8)}...`);
        return false;
      }

      // Decrypt the envelope using peer's DH key
      const envelope = JSON.parse(encryptedPayload);
      const decrypted = cryptoManager.decrypt(envelope, peer.dhPublicKey, fromFingerprint);
      const message = JSON.parse(decrypted);

      // Verify signature using peer's signing key
      if (!message.sig) {
        logger.warn(`P2P message from ${fromFingerprint.slice(0, 8)}... has no signature`);
        return false;
      }

      const isValid = cryptoManager.verify(message, message.sig, peer.signPublicKey);
      if (!isValid) {
        logger.error(`P2P SECURITY: Invalid signature from ${fromFingerprint.slice(0, 8)}...`);
        return false;
      }

      // Check sequence number for replay protection
      if (message.seq !== undefined) {
        if (!cryptoManager.checkSequence(fromFingerprint, message.seq)) {
          logger.warn(`P2P replay detected from ${fromFingerprint.slice(0, 8)}...: seq=${message.seq}`);
          return false;
        }
      }

      // Update last seen
      await peerManager.updateLastSeen(fromFingerprint);

      // Route to handler
      const handler = this.handlers.get(message.type);
      if (!handler) {
        logger.warn(`P2P unknown message type from ${fromFingerprint.slice(0, 8)}...: ${message.type}`);
        return false;
      }

      await handler(fromFingerprint, message, sendFn);
      return true;
    } catch (error) {
      logger.error(`P2P message handling error from ${fromFingerprint.slice(0, 8)}...:`, error.message);
      return false;
    }
  }

  /**
   * Handle capabilities request - send our capabilities
   */
  async _handleCapabilitiesRequest(fromFingerprint, message, sendFn) {
    logger.debug(`P2P capabilities request from ${fromFingerprint.slice(0, 8)}...`);

    const capabilities = this.pluginSharing ?
      await this.pluginSharing.getLocalCapabilities() : [];

    // Include wallet, token address, and SKYNET balance for reputation staking
    let walletAddress = null;
    let skynetTokenAddress = null;
    let skynetBalance = 0;
    if (this.skynetServiceExecutor) {
      walletAddress = await this.skynetServiceExecutor.getRecipientAddress();
      skynetTokenAddress = await this.skynetServiceExecutor.getSkynetTokenAddress();
      // Get our SKYNET balance for reputation announcement
      try {
        if (walletAddress && skynetTokenAddress) {
          const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
          const provider = await contractService.getProvider('bsc');
          const { ethers } = await import('ethers');
          const token = new ethers.Contract(skynetTokenAddress, [
            'function balanceOf(address) view returns (uint256)'
          ], provider);
          const bal = await token.balanceOf(walletAddress);
          skynetBalance = parseFloat(ethers.formatUnits(bal, 18));
        }
      } catch {}
    }

    // Include ENS provider capability if this instance manages ENS names
    let ensProvider = null;
    try {
      const ensService = (await import('../crypto/ensService.js')).default;
      if (!ensService.isAvailable()) await ensService.initialize();
      if (ensService.isGenesisENS()) {
        ensProvider = { baseName: `${ensService.baseName}.eth`, price: await ensService.getSubnamePrice() };
        capabilities.push({ name: 'ens_provider', version: '1.0', description: `ENS subname provider: *.${ensService.baseName}.eth` });
      }
    } catch {}

    // Include email provider capability if this instance manages email leases
    try {
      const emailLeaseService = (await import('../email/emailLeaseService.js')).default;
      if (!emailLeaseService.initialized) await emailLeaseService.initialize();
      if (emailLeaseService.isGenesisEmailProvider()) {
        const price = await emailLeaseService.getLeasePrice();
        capabilities.push({
          name: 'email_provider', version: '1.0',
          description: `Email lease: *@lanagent.net (${price} SKYNET/year)`
        });
      }
    } catch {}

    // Include ERC-8004 identity info if minted
    let erc8004 = null;
    try {
      const Agent = (await import('../../models/Agent.js')).default;
      const agentModel = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
      if (agentModel?.erc8004?.agentId != null && agentModel.erc8004.status === 'active') {
        erc8004 = { agentId: agentModel.erc8004.agentId, verified: true };
      }
    } catch {}

    // Include our ENS name so peers can auto-trust us
    const agentName = (process.env.AGENT_NAME || 'lanagent').toLowerCase();
    const ensName = `${agentName}.lanagent.eth`;

    await sendFn(fromFingerprint, {
      type: 'capabilities_response',
      capabilities,
      walletAddress,
      skynetTokenAddress,
      skynetBalance,
      erc8004,
      ensProvider,
      ensName
    });
  }

  /**
   * Handle capabilities response - store peer's capabilities
   */
  async _handleCapabilitiesResponse(fromFingerprint, message, sendFn) {
    const { capabilities, walletAddress, skynetTokenAddress, skynetBalance, erc8004, ensProvider, ensName } = message;
    if (Array.isArray(capabilities)) {
      await peerManager.updateCapabilities(fromFingerprint, capabilities);
      logger.info(`P2P received ${capabilities.length} capabilities from ${fromFingerprint.slice(0, 8)}...`);
    }

    // Auto-trust the peer fork if they announced a valid ENS name
    if (ensName && typeof ensName === 'string' && ensName.endsWith('.lanagent.eth')) {
      try {
        const trustRegistryService = (await import('../../services/crypto/trustRegistryService.js')).default;
        if (trustRegistryService._initialized) {
          await trustRegistryService.autoTrustFork(ensName);
          logger.info(`P2P auto-trusted fork: ${ensName} (${fromFingerprint.slice(0, 8)}...)`);
        }
      } catch (err) {
        logger.debug(`P2P auto-trust fork skipped for ${ensName}: ${err.message}`);
      }
    }

    // Store peer's wallet info and announced SKYNET balance
    try {
      const peer = await peerManager.getPeer(fromFingerprint);
      if (peer) {
        if (walletAddress) peer.skynetWallet = walletAddress;
        if (skynetTokenAddress) peer.skynetTokenAddress = skynetTokenAddress;
        if (skynetBalance !== undefined) peer.skynetBalance = skynetBalance || 0;

        // Verify on-chain balance if peer announced one
        if (walletAddress && skynetTokenAddress && skynetBalance > 0) {
          try {
            const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
            const provider = await contractService.getProvider('bsc');
            const { ethers } = await import('ethers');
            const token = new ethers.Contract(skynetTokenAddress, [
              'function balanceOf(address) view returns (uint256)'
            ], provider);
            const onChainBal = await token.balanceOf(walletAddress);
            const verified = parseFloat(ethers.formatUnits(onChainBal, 18));
            // Accept if on-chain balance is at least 90% of announced
            peer.skynetBalanceVerified = verified >= skynetBalance * 0.9;
            peer.skynetBalance = verified;
            peer.skynetBalanceVerifiedAt = new Date();
          } catch (err) {
            logger.debug(`Could not verify SKYNET balance for ${fromFingerprint.slice(0, 8)}...: ${err.message}`);
          }
        }

        // Store and verify ERC-8004 identity info from peer on-chain
        if (erc8004?.agentId != null) {
          let onChainVerified = false;
          try {
            const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
            const provider = await contractService.getProvider('bsc');
            const { ethers } = await import('ethers');
            const registryAddr = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
            const registry = new ethers.Contract(registryAddr, [
              'function ownerOf(uint256 tokenId) external view returns (address)'
            ], provider);
            // Verify the agent ID exists on-chain (ownerOf won't revert for valid tokens)
            const owner = await registry.ownerOf(erc8004.agentId);
            // If peer announced a wallet, check it matches the on-chain owner
            if (walletAddress && owner.toLowerCase() === walletAddress.toLowerCase()) {
              onChainVerified = true;
            } else if (owner !== ethers.ZeroAddress) {
              // Agent ID exists on-chain even if wallet doesn't match exactly
              onChainVerified = true;
            }
            logger.info(`ERC-8004 on-chain verify for ${fromFingerprint.slice(0, 8)}...: agentId=${erc8004.agentId}, owner=${owner.slice(0, 10)}..., verified=${onChainVerified}`);
          } catch (err) {
            logger.debug(`ERC-8004 on-chain verify failed for ${fromFingerprint.slice(0, 8)}...: ${err.message}`);
          }
          peer.erc8004 = {
            agentId: erc8004.agentId,
            verified: onChainVerified,
            verifiedAt: onChainVerified ? new Date() : undefined
          };
        }

        // Check Sentinel token balance (soulbound reputation badge from scammer reporting)
        if (walletAddress) {
          try {
            const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
            const provider = await contractService.getProvider('bsc');
            const { ethers } = await import('ethers');
            const registryContract = new ethers.Contract(
              '0xEa68dad9D44a51428206B4ECFE38147C7783b9e9',
              ['function sentinelToken() external view returns (address)'],
              provider
            );
            const sentinelAddr = await registryContract.sentinelToken();
            const sentinel = new ethers.Contract(sentinelAddr, [
              'function balanceOf(address) view returns (uint256)'
            ], provider);
            const bal = await sentinel.balanceOf(walletAddress);
            peer.sentinelBalance = Number(bal);
            peer.sentinelBalanceVerified = true;
            if (peer.sentinelBalance > 0) {
              logger.info(`Peer ${fromFingerprint.slice(0, 8)}... holds ${peer.sentinelBalance} SENTINEL token(s)`);
            }
          } catch (err) {
            logger.debug(`Sentinel balance check failed for ${fromFingerprint.slice(0, 8)}...: ${err.message}`);
          }
        }

        // Recalculate trust score
        peer.calculateTrustScore();
        await peer.save();
      }
    } catch (err) {
      logger.error(`Failed to save peer info: ${err.message}`);
    }
  }

  /**
   * Handle plugin list request - send our available plugins
   */
  async _handlePluginListRequest(fromFingerprint, message, sendFn) {
    logger.debug(`P2P plugin list request from ${fromFingerprint.slice(0, 8)}...`);

    if (!this.pluginSharing) {
      await sendFn(fromFingerprint, { type: 'plugin_list_response', plugins: [] });
      return;
    }

    const plugins = await this.pluginSharing.getShareablePluginList();

    await sendFn(fromFingerprint, {
      type: 'plugin_list_response',
      plugins
    });
  }

  /**
   * Handle plugin list response - store available plugins from peer
   */
  async _handlePluginListResponse(fromFingerprint, message, sendFn) {
    if (this.pluginSharing) {
      this.pluginSharing.handlePluginListResponse(fromFingerprint, message.plugins || []);
    }
  }

  /**
   * Handle plugin request - start sending the requested plugin
   */
  async _handlePluginRequest(fromFingerprint, message, sendFn) {
    const { name, version } = message;
    logger.info(`P2P plugin request from ${fromFingerprint.slice(0, 8)}...: ${name}@${version || 'latest'}`);

    if (!this.pluginSharing) {
      logger.warn('P2P plugin sharing not available');
      return;
    }

    await this.pluginSharing.handlePluginRequest(fromFingerprint, name, version, sendFn);
  }

  /**
   * Handle plugin offer - peer is offering to send a plugin
   */
  async _handlePluginOffer(fromFingerprint, message, sendFn) {
    if (this.pluginSharing) {
      await this.pluginSharing.handlePluginOffer(fromFingerprint, message);
    }
  }

  /**
   * Handle plugin chunk - receive a chunk of plugin data
   */
  async _handlePluginChunk(fromFingerprint, message, sendFn) {
    if (this.pluginSharing) {
      await this.pluginSharing.handlePluginChunk(fromFingerprint, message, sendFn);
    }
  }

  /**
   * Handle plugin received confirmation
   */
  async _handlePluginReceived(fromFingerprint, message, sendFn) {
    logger.info(`P2P peer ${fromFingerprint.slice(0, 8)}... confirmed plugin receipt: ${message.name}, verified: ${message.verified}`);
  }

  // ==================== Knowledge Pack Handlers ====================

  async _handleKnowledgePackListRequest(fromFingerprint, message, sendFn) {
    logger.debug(`P2P knowledge pack list request from ${fromFingerprint.slice(0, 8)}...`);
    if (!this.knowledgePackSharing) {
      await sendFn(fromFingerprint, { type: 'knowledge_pack_list_response', packs: [] });
      return;
    }
    await this.knowledgePackSharing.handlePackListRequest(fromFingerprint, sendFn);
  }

  async _handleKnowledgePackListResponse(fromFingerprint, message, sendFn) {
    if (this.knowledgePackSharing) {
      this.knowledgePackSharing.handlePackListResponse(fromFingerprint, message.packs || []);
    }
  }

  async _handleKnowledgePackRequest(fromFingerprint, message, sendFn) {
    const { packId, paymentTxHash } = message;
    logger.info(`P2P knowledge pack request from ${fromFingerprint.slice(0, 8)}...: ${packId?.slice(0, 16)}`);
    if (!this.knowledgePackSharing) {
      logger.warn('P2P knowledge pack sharing not available');
      return;
    }
    await this.knowledgePackSharing.handlePackRequest(fromFingerprint, packId, sendFn, paymentTxHash);
  }

  async _handleKnowledgePackOffer(fromFingerprint, message, sendFn) {
    if (this.knowledgePackSharing) {
      await this.knowledgePackSharing.handlePackOffer(fromFingerprint, message);
    }
  }

  async _handleKnowledgePackChunk(fromFingerprint, message, sendFn) {
    if (this.knowledgePackSharing) {
      await this.knowledgePackSharing.handlePackChunk(fromFingerprint, message, sendFn);
    }
  }

  async _handleKnowledgePackReceived(fromFingerprint, message, sendFn) {
    logger.info(`P2P peer ${fromFingerprint.slice(0, 8)}... confirmed knowledge pack receipt: ${message.packId?.slice(0, 16)}, verified: ${message.verified}`);
  }

  async _handleKnowledgePackUpdate(fromFingerprint, message, sendFn) {
    if (this.knowledgePackSharing) {
      await this.knowledgePackSharing.handlePackUpdate(fromFingerprint, message);
    }
  }

  async _handleKnowledgePackPaymentRequired(fromFingerprint, message, sendFn) {
    const { packId, price, currency, walletAddress, tokenAddress } = message;
    logger.info(`P2P knowledge pack payment required from ${fromFingerprint.slice(0, 8)}...: ${packId?.slice(0, 16)} — ${price} ${currency}`);
    if (this.knowledgePackSharing?.agent?.emit) {
      this.knowledgePackSharing.agent.emit('skynet:pack_payment_required', {
        fromFingerprint, packId, price, currency, walletAddress, tokenAddress
      });
    }
  }

  /**
   * Handle ping
   */
  async _handlePing(fromFingerprint, message, sendFn) {
    await sendFn(fromFingerprint, {
      type: 'pong',
      ts: message.ts
    });
  }

  /**
   * Handle pong
   */
  async _handlePong(fromFingerprint, message, sendFn) {
    const latency = Date.now() - (message.ts || 0);
    logger.debug(`P2P pong from ${fromFingerprint.slice(0, 8)}...: ${latency}ms`);

    // Notify p2pService so pingPeer() can return latency to the API caller
    try {
      const { default: agent } = await import('../../core/agent.js');
      const p2p = agent?.services?.get('p2p') || agent?.p2pService;
      p2p?.handlePongReceived?.(fromFingerprint, message.ts);
    } catch { /* best effort */ }
  }

  // ==================== Skynet Paid Service Handlers ====================

  async _handleServiceCatalogRequest(fromFingerprint, message, sendFn) {
    if (this.skynetServiceExecutor) {
      await this.skynetServiceExecutor.handleCatalogRequest(fromFingerprint, message, sendFn);
    }
  }

  async _handleServiceCatalogResponse(fromFingerprint, message, sendFn) {
    if (this.skynetServiceExecutor) {
      await this.skynetServiceExecutor.handleCatalogResponse(fromFingerprint, message);
    }
  }

  async _handleServiceRequest(fromFingerprint, message, sendFn) {
    if (this.skynetServiceExecutor) {
      await this.skynetServiceExecutor.handleServiceRequest(fromFingerprint, message, sendFn);
    }
  }

  async _handleServiceResult(fromFingerprint, message, sendFn) {
    if (this.skynetServiceExecutor) {
      await this.skynetServiceExecutor.handleServiceResult(fromFingerprint, message);
    }
  }

  async _handleServiceError(fromFingerprint, message, sendFn) {
    if (this.skynetServiceExecutor) {
      await this.skynetServiceExecutor.handleServiceError(fromFingerprint, message);
    }
  }

  async _handlePaymentRequired(fromFingerprint, message, sendFn) {
    if (this.skynetServiceExecutor) {
      await this.skynetServiceExecutor.handlePaymentRequired(fromFingerprint, message);
    }
  }

  // ==================== Skynet Economy Handlers ====================

  async _handleBountyPost(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleBountyPost(fromFingerprint, message);
    }
  }

  async _handleBountyClaim(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleBountyClaim(fromFingerprint, message, sendFn);
    }
  }

  async _handleBountyClaimResponse(fromFingerprint, message, sendFn) {
    const { bountyId, accepted, reason } = message;
    logger.info(`Skynet bounty claim response from ${fromFingerprint.slice(0, 8)}...: ${bountyId} ${accepted ? 'accepted' : 'rejected'}`);
    if (this.skynetEconomy?.agent?.emit) {
      this.skynetEconomy.agent.emit('skynet:bounty_claim_response', { fromFingerprint, bountyId, accepted, reason });
    }
  }

  async _handleGovernanceProposal(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleGovernanceProposal(fromFingerprint, message);
    }
  }

  async _handleGovernanceVote(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleGovernanceVote(fromFingerprint, message);
    }
  }

  async _handleTipReceived(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleTipReceived(fromFingerprint, message);
    }
  }

  // ==================== Data Marketplace Handlers ====================

  async _handleDataListingPost(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleDataListingPost(fromFingerprint, message);
    }
  }

  async _handleDataPurchaseRequest(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleDataPurchaseRequest(fromFingerprint, message, sendFn);
    }
  }

  async _handleDataPurchaseResponse(fromFingerprint, message, sendFn) {
    const { listingId, success, error } = message;
    logger.info(`Data purchase response from ${fromFingerprint.slice(0, 8)}...: ${listingId} ${success ? 'success' : 'failed'}`);
    if (this.skynetEconomy?.agent?.emit) {
      this.skynetEconomy.agent.emit('skynet:data_purchase_response', { fromFingerprint, listingId, success, error });
    }
  }

  // ==================== Referral & Arbitrage Handlers ====================

  async _handleReferralReward(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleReferralReward(fromFingerprint, message);
    }
  }

  async _handleArbSignal(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleArbSignal(fromFingerprint, message);
    }
  }

  // ==================== Compute Rental Handlers ====================

  async _handleComputeRequest(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleComputeRequest(fromFingerprint, message, sendFn);
    }
  }

  async _handleComputeResponse(fromFingerprint, message, sendFn) {
    if (this.skynetEconomy) {
      await this.skynetEconomy.handleComputeResponse(fromFingerprint, message);
    }
  }

  async _handleComputePaymentRequired(fromFingerprint, message, sendFn) {
    const { jobId, pricePerMinute, currency, maxDurationSeconds } = message;
    logger.info(`Compute payment required from ${fromFingerprint.slice(0, 8)}...: ${jobId} — ${pricePerMinute} ${currency}/min`);
    if (this.skynetEconomy?.agent?.emit) {
      this.skynetEconomy.agent.emit('skynet:compute_payment_required', {
        fromFingerprint, jobId, pricePerMinute, currency, maxDurationSeconds
      });
    }
  }

  // ==================== Email Lease Handlers ====================

  /**
   * Handle email_lease_request — Genesis creates email account for requesting peer.
   */
  async _handleEmailLeaseRequest(fromFingerprint, message, sendFn) {
    logger.info(`Email lease request from ${fromFingerprint.slice(0, 8)}...: username=${message.desiredUsername}`);
    try {
      const emailLeaseService = (await import('../email/emailLeaseService.js')).default;
      if (!emailLeaseService.initialized) await emailLeaseService.initialize();
      await emailLeaseService.handleLeaseRequest(fromFingerprint, message, sendFn);
    } catch (error) {
      logger.error(`Email lease request handler error: ${error.message}`);
      await sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: 'Internal error processing email lease request'
      });
    }
  }

  /**
   * Handle email_lease_response — Fork receives result of email lease.
   */
  async _handleEmailLeaseResponse(fromFingerprint, message, sendFn) {
    const fp = fromFingerprint.slice(0, 8);
    if (message.success) {
      logger.info(`Email lease granted by ${fp}...: ${message.email} (lease: ${message.leaseId})`);

      // Save credentials locally
      try {
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        await SystemSettings.setSetting('email.myLease', {
          leaseId: message.leaseId,
          email: message.email,
          password: message.password,
          imap: message.imap,
          smtp: message.smtp,
          expiresAt: message.expiresAt,
          quotaMB: message.quotaMB,
          status: 'active',
          grantedBy: fromFingerprint,
          grantedAt: new Date().toISOString(),
          passwordReset: message.passwordReset || false,
          renewed: message.renewed || false
        }, 'Email lease credentials from genesis', 'email');
        logger.info(`Email lease credentials saved: ${message.email}`);
      } catch (err) {
        logger.error(`Failed to save email lease credentials: ${err.message}`);
      }

      // Emit event for notifications
      if (this.skynetEconomy?.agent?.emit) {
        this.skynetEconomy.agent.emit('email:lease_granted', {
          email: message.email, leaseId: message.leaseId, expiresAt: message.expiresAt
        });
      }
    } else {
      logger.warn(`Email lease denied by ${fp}...: ${message.error}`);
    }
  }

  /**
   * Handle email_lease_payment_required — Genesis requests SKYNET payment before creating email.
   */
  async _handleEmailLeasePaymentRequired(fromFingerprint, message, sendFn) {
    const { desiredUsername, amount, currency, tokenAddress, recipientWallet } = message;
    const fp = fromFingerprint.slice(0, 8);
    logger.info(`Email lease payment required from ${fp}...: ${amount} ${currency} for ${desiredUsername}@lanagent.net`);

    // Auto-pay if configured
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const autoPay = await SystemSettings.getSetting('email.autoPayLease', true);

      if (autoPay && tokenAddress && recipientWallet) {
        const { ethers } = await import('ethers');
        const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
        const signer = await contractService.getSigner('bsc');
        const ownerAddress = await signer.getAddress();

        const token = new ethers.Contract(tokenAddress, [
          'function transfer(address to, uint256 amount) returns (bool)'
        ], signer);

        const amountWei = ethers.parseUnits(String(amount), 18);
        const tx = await token.transfer(recipientWallet, amountWei);
        const receipt = await tx.wait();

        logger.info(`Email lease payment sent: ${amount} SKYNET → ${recipientWallet.slice(0, 10)}... tx=${receipt.hash}`);

        // Wait for confirmations then retry with payment proof
        await new Promise(r => setTimeout(r, 15000));

        // Get P2P service for sending the retry
        let p2pService = null;
        if (this.skynetEconomy?.agent?.services) {
          p2pService = this.skynetEconomy.agent.services.get('p2p');
        }

        if (p2pService) {
          const emailLeaseService = (await import('../email/emailLeaseService.js')).default;
          await emailLeaseService.requestLease(
            p2pService, fromFingerprint, desiredUsername, ownerAddress, receipt.hash
          );
        }
      } else {
        logger.info('Email lease auto-pay disabled or missing payment info — manual action needed');

        // Save pending request
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        await SystemSettings.setSetting('email.pendingLeaseRequest', {
          genesisFingerprint: fromFingerprint,
          desiredUsername,
          amount,
          currency,
          tokenAddress,
          recipientWallet,
          isRenewal: message.isRenewal || false,
          leaseId: message.leaseId || null,
          savedAt: new Date().toISOString()
        }, 'Pending email lease payment', 'email');
      }
    } catch (error) {
      logger.error(`Email lease auto-payment error: ${error.message}`);
    }
  }

  /**
   * Handle email_lease_renew — Peer requests renewal of existing lease.
   */
  async _handleEmailLeaseRenew(fromFingerprint, message, sendFn) {
    logger.info(`Email lease renew from ${fromFingerprint.slice(0, 8)}...: leaseId=${message.leaseId}`);
    try {
      const emailLeaseService = (await import('../email/emailLeaseService.js')).default;
      if (!emailLeaseService.initialized) await emailLeaseService.initialize();
      await emailLeaseService.handleRenewRequest(fromFingerprint, message, sendFn);
    } catch (error) {
      logger.error(`Email lease renew handler error: ${error.message}`);
      await sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: 'Internal error processing renewal request'
      });
    }
  }

  /**
   * Handle email_lease_revoke — Genesis notifies peer their lease was revoked.
   */
  async _handleEmailLeaseRevoke(fromFingerprint, message, sendFn) {
    const { leaseId, email, reason, revokedAt } = message;
    const fp = fromFingerprint.slice(0, 8);
    logger.warn(`Email lease revoked by ${fp}...: ${email} — ${reason}`);

    // Clear local credentials
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const myLease = await SystemSettings.getSetting('email.myLease', null);
      if (myLease && myLease.leaseId === leaseId) {
        await SystemSettings.deleteSetting('email.myLease');
        logger.info(`Local email lease credentials cleared: ${email}`);
      }
    } catch (err) {
      logger.error(`Failed to clear email lease credentials: ${err.message}`);
    }

    if (this.skynetEconomy?.agent?.emit) {
      this.skynetEconomy.agent.emit('email:lease_revoked', {
        leaseId, email, reason, revokedAt
      });
    }
  }

  // ==================== Welcome Package Handlers ====================

  /**
   * Handle welcome_package_request — Genesis provisions new agent with tokens + email.
   */
  async _handleWelcomePackageRequest(fromFingerprint, message, sendFn) {
    logger.info(`Welcome package request from ${fromFingerprint.slice(0, 8)}...: agent=${message.agentName}`);
    try {
      const { welcomePackage } = await import('./welcomePackage.js');
      await welcomePackage.handleRequest(fromFingerprint, message, sendFn);
    } catch (error) {
      logger.error(`Welcome package request handler error: ${error.message}`);
      await sendFn(fromFingerprint, {
        type: 'welcome_package_response',
        success: false,
        error: 'Internal error processing welcome package request'
      });
    }
  }

  /**
   * Handle welcome_package_response — Fork receives welcome package result.
   */
  async _handleWelcomePackageResponse(fromFingerprint, message, sendFn) {
    logger.info(`Welcome package response from ${fromFingerprint.slice(0, 8)}...: success=${message.success}`);
    try {
      const { welcomePackage } = await import('./welcomePackage.js');
      await welcomePackage.handleResponse(fromFingerprint, message);
    } catch (error) {
      logger.error(`Welcome package response handler error: ${error.message}`);
    }
  }

  // ==================== ENS Subname Handlers ====================

  /**
   * Handle ens_subname_request — Genesis creates subname for requesting peer.
   */
  async _handleENSSubnameRequest(fromFingerprint, message, sendFn) {
    logger.info(`ENS subname request from ${fromFingerprint.slice(0, 8)}...: label=${message.label}`);
    try {
      const ensService = (await import('../crypto/ensService.js')).default;
      if (!ensService.isAvailable()) await ensService.initialize();
      await ensService.handleSubnameRequest(fromFingerprint, message, sendFn);
    } catch (error) {
      logger.error(`ENS subname request handler error: ${error.message}`);
      await sendFn(fromFingerprint, {
        type: 'ens_subname_response',
        success: false,
        error: 'Internal error processing subname request'
      });
    }
  }

  /**
   * Handle ens_subname_response — Fork receives result of subname creation.
   */
  async _handleENSSubnameResponse(fromFingerprint, message, sendFn) {
    const fp = fromFingerprint.slice(0, 8);
    if (message.success) {
      logger.info(`ENS subname granted by ${fp}...: ${message.name} (tx: ${message.txHash})`);

      // Save locally
      try {
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        await SystemSettings.setSetting('ens.mySubname', {
          name: message.name,
          owner: message.owner,
          txHash: message.txHash,
          grantedBy: fromFingerprint,
          grantedAt: new Date().toISOString(),
          paidAmount: message.paidAmount || 0
        }, 'ENS subname received from genesis', 'crypto');
        logger.info(`ENS subname saved: ${message.name}`);
        // Clear any pending request
        await SystemSettings.deleteSetting('ens.pendingSubnameRequest');
      } catch (err) {
        logger.error(`Failed to save ENS subname: ${err.message}`);
      }

      // Emit event for notifications
      if (this.skynetEconomy?.agent?.emit) {
        this.skynetEconomy.agent.emit('ens:subname_granted', {
          name: message.name, owner: message.owner, txHash: message.txHash
        });
      }
    } else {
      logger.warn(`ENS subname denied by ${fp}...: ${message.error}`);

      // If name collision, retry with fingerprint suffix
      if (message.error?.includes('already taken') && message.requestedLabel) {
        try {
          const { cryptoManager } = await import('./cryptoManager.js');
          const identity = cryptoManager.getPublicKeys();
          if (identity?.fingerprint) {
            const suffix = identity.fingerprint.slice(0, 8).toLowerCase();
            const fallbackLabel = `${message.requestedLabel}-${suffix}`;
            logger.info(`ENS subname collision — retrying with fallback: ${fallbackLabel}`);

            let p2pService = null;
            if (this.skynetEconomy?.agent?.services) {
              p2pService = this.skynetEconomy.agent.services.get('p2p');
            }
            if (p2pService) {
              const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
              const signer = await contractService.getSigner('ethereum');
              const ownerAddress = await signer.getAddress();
              await p2pService.requestENSSubname(fromFingerprint, fallbackLabel, ownerAddress);
            }
          }
        } catch (retryErr) {
          logger.debug(`ENS subname fallback retry failed: ${retryErr.message}`);
        }
      }
    }
  }

  /**
   * Handle ens_subname_payment_required — Genesis requests SKYNET payment before creating subname.
   */
  async _handleENSSubnamePaymentRequired(fromFingerprint, message, sendFn) {
    const { label, amount, currency, tokenAddress, recipientWallet, baseName } = message;
    const fp = fromFingerprint.slice(0, 8);
    logger.info(`ENS subname payment required from ${fp}...: ${amount} ${currency} for ${label}.${baseName}`);

    // Auto-pay if configured
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const autoPay = await SystemSettings.getSetting('ens.autoPaySubname', true);

      if (autoPay && tokenAddress && recipientWallet) {
        const ensService = (await import('../crypto/ensService.js')).default;
        const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
        const ownerAddress = (await contractService.getSigner('bsc')).getAddress();

        // Get P2P service for sending the retry
        const p2pModule = await import('./p2pService.js');
        const p2pInstances = Object.values(p2pModule);
        // Find the active p2p service instance via the agent
        let p2pService = null;
        if (this.skynetEconomy?.agent?.services) {
          p2pService = this.skynetEconomy.agent.services.get('p2p');
        }
        if (!p2pService) {
          logger.warn('Cannot auto-pay ENS subname: P2P service not accessible');
          return;
        }

        await ensService.autoPayAndRequest(
          p2pService, fromFingerprint, label, await ownerAddress,
          { amount, tokenAddress, recipientWallet }
        );
      } else {
        logger.info(`ENS subname auto-pay disabled or missing payment info — manual action needed`);
      }
    } catch (error) {
      logger.error(`ENS subname auto-payment error: ${error.message}`);
    }
  }
}

export const messageHandler = new MessageHandler();
export default MessageHandler;
