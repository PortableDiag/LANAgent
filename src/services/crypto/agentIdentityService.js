import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import transactionService from './transactionService.js';
import { Agent } from '../../models/Agent.js';

const IDENTITY_REGISTRY_ABI = [
  'function register(string agentURI) external returns (uint256)',
  'function register(string agentURI, tuple(string metadataKey, bytes metadataValue)[] metadata) external returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature) external',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
  'function unsetAgentWallet(uint256 agentId) external',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)'
];

const REGISTRY_ADDRESSES = {
  bsc: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  ethereum: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
};

const EXPLORER_URLS = {
  bsc: 'https://bscscan.com',
  ethereum: 'https://etherscan.io'
};

class AgentIdentityService {
  constructor() {
    this.agent = null;
  }

  /**
   * Set agent reference (called from web interface routes)
   */
  setAgent(agent) {
    this.agent = agent;
  }

  /**
   * Generate the ERC-8004 registration file JSON
   */
  async generateRegistrationFile() {
    const agentModel = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
    if (!agentModel) throw new Error('Agent model not found');

    // Read version from package.json
    let version = '1.0.0';
    try {
      const pkgPath = path.join(process.cwd(), 'package.json');
      const pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      version = pkgJson.version;
    } catch { /* ignore */ }

    // Build avatar URI
    let avatarURI = '/api/agent/avatar';
    if (agentModel.erc8004?.ipfs?.avatarCID) {
      avatarURI = `ipfs://${agentModel.erc8004.ipfs.avatarCID}`;
    }

    // Capabilities are derived from enabled External Services (legacy routes)
    // AND approved plugin services (generic plugin proxy).
    // Internal plugins like agentstats, backupStrategy, ssh, etc. are private
    // and must not be leaked — only ALLOWED_PLUGINS from plugins.js are included.
    let capabilities = [];
    let externalServices = [];
    try {
      const ExternalServiceConfig = (await import('../../models/ExternalServiceConfig.js')).default;
      const configs = await ExternalServiceConfig.find({ enabled: true }).lean();
      externalServices = configs.map(s => ({
        id: s.serviceId,
        name: s.name,
        description: s.description,
        pricing: { amount: s.price, currency: s.currency, chainId: 56 },
        endpoint: `/api/external/${s.serviceId.replace(/-/g, '/')}`,
        rateLimit: s.rateLimit
      }));
      capabilities = configs.map(s => ({
        name: s.name,
        version: '1.0.0',
        description: s.description || '',
        enabled: true
      }));
    } catch (e) {
      logger.debug('Could not load external services for registration:', e.message);
    }

    // Add approved plugin services (only those in the external allowlist)
    try {
      const { ALLOWED_PLUGINS, PLUGIN_CREDIT_COSTS } = await import('../../api/external/routes/plugins.js');
      const apiManager = this.agent?.apiManager || this.agent?.services?.get('apiManager');
      if (apiManager?.apis) {
        for (const pluginName of ALLOWED_PLUGINS) {
          const pluginEntry = apiManager.apis.get(pluginName);
          if (!pluginEntry || pluginEntry.enabled === false) continue;

          const instance = pluginEntry.instance || pluginEntry;
          const commands = (instance.commands || [])
            .filter(c => c.command || c.name)
            .map(c => c.command || c.name);
          const creditCost = PLUGIN_CREDIT_COSTS[pluginName] || 1;

          externalServices.push({
            id: `plugin:${pluginName}`,
            name: instance.description || pluginName,
            description: instance.description || '',
            pricing: { credits: creditCost, currency: 'credits', chainId: 56 },
            endpoint: `/api/external/service/${pluginName}/:action`,
            actions: commands
          });
          capabilities.push({
            name: instance.description || pluginName,
            version: instance.version || '1.0.0',
            description: instance.description || '',
            enabled: true
          });
        }
      }
    } catch (e) {
      logger.debug('Could not load plugin services for registration:', e.message);
    }

    const capabilitiesHash = this.computeCapabilitiesHash(capabilities);

    const registrationFile = {
      name: agentModel.name || 'ALICE',
      description: agentModel.personality || 'Autonomous Learning Intelligent Command Executor',
      version,
      active: externalServices.length > 0,
      avatar: avatarURI,
      chain: agentModel.erc8004?.chain || 'bsc',
      capabilities,
      capabilitiesHash,
      services: externalServices,
      interfaces: this.agent ? Array.from(this.agent.interfaces?.keys() || []) : [],
      gateway: `https://api.lanagent.net/agents/${agentModel.erc8004?.agentId || 'unknown'}`,
      endpoints: {
        gateway: `https://api.lanagent.net/agents/${agentModel.erc8004?.agentId || 'unknown'}`,
        catalog: `https://api.lanagent.net/agents/${agentModel.erc8004?.agentId || 'unknown'}/catalog`,
        api: '/api',
        command: '/api/command/execute',
        identity: '/api/agent/identity',
        health: '/health',
        external: '/api/external',
        directCatalog: '/api/external/catalog'
      },
      metadata: {
        framework: 'LANAgent',
        runtime: 'Node.js',
        generatedAt: new Date().toISOString()
      }
    };

    // Save to model
    agentModel.erc8004 = agentModel.erc8004 || {};
    agentModel.erc8004.registrationFile = registrationFile;
    agentModel.erc8004.capabilitiesHash = capabilitiesHash;
    if (agentModel.erc8004.status === 'none') {
      agentModel.erc8004.status = 'local';
    }
    agentModel.erc8004.lastUpdated = new Date();
    await agentModel.save();

    return registrationFile;
  }

  /**
   * Compute SHA-256 hash of capabilities for staleness detection
   */
  computeCapabilitiesHash(capabilities) {
    const sorted = capabilities
      .filter(c => c.enabled !== false)
      .map(c => `${c.name}:${c.version || '1.0.0'}`)
      .sort()
      .join(',');
    return crypto.createHash('sha256').update(sorted).digest('hex');
  }

  /**
   * Upload data to Pinata IPFS
   */
  async uploadToIPFS(data, filename, isFile = false) {
    const apiKey = process.env.PINATA_API_KEY;
    const secretKey = process.env.PINATA_SECRET_KEY;

    if (!apiKey || !secretKey) {
      throw new Error('Pinata API keys not configured. Set them in the ERC-8004 settings.');
    }

    const headers = {
      pinata_api_key: apiKey,
      pinata_secret_api_key: secretKey
    };

    if (isFile) {
      // Upload file (avatar image)
      const FormData = (await import('form-data')).default;
      const form = new FormData();

      const fileBuffer = typeof data === 'string'
        ? await fs.readFile(data)
        : data;

      form.append('file', fileBuffer, { filename });
      form.append('pinataMetadata', JSON.stringify({ name: filename }));

      const response = await axios.post(
        'https://api.pinata.cloud/pinning/pinFileToIPFS',
        form,
        { headers: { ...headers, ...form.getHeaders() }, maxContentLength: Infinity }
      );
      return response.data.IpfsHash;
    } else {
      // Upload JSON
      const response = await axios.post(
        'https://api.pinata.cloud/pinning/pinJSONToIPFS',
        {
          pinataContent: data,
          pinataMetadata: { name: filename }
        },
        { headers }
      );
      return response.data.IpfsHash;
    }
  }

  /**
   * Upload avatar to IPFS if not already uploaded
   */
  async uploadAvatarToIPFS() {
    const agentModel = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
    if (agentModel?.erc8004?.ipfs?.avatarCID) {
      return agentModel.erc8004.ipfs.avatarCID;
    }

    // Find the avatar file
    const avatarPath = agentModel?.avatarPath || 'data/agent/avatar.png';
    const fullPath = path.isAbsolute(avatarPath) ? avatarPath : path.join(process.cwd(), avatarPath);

    let avatarExists = false;
    try {
      await fs.access(fullPath);
      avatarExists = true;
    } catch { /* no avatar file */ }

    if (!avatarExists) {
      // Try alice.png in project root
      const alicePath = path.join(process.cwd(), 'alice.png');
      try {
        await fs.access(alicePath);
        const cid = await this.uploadToIPFS(alicePath, 'alice-avatar.png', true);
        logger.info(`Avatar uploaded to IPFS: ${cid}`);
        return cid;
      } catch {
        logger.warn('No avatar file found, skipping avatar upload');
        return null;
      }
    }

    const cid = await this.uploadToIPFS(fullPath, 'alice-avatar.png', true);
    logger.info(`Avatar uploaded to IPFS: ${cid}`);
    return cid;
  }

  /**
   * Mint ERC-8004 identity NFT on-chain
   */
  async mintIdentity(chain = 'bsc') {
    const registryAddress = REGISTRY_ADDRESSES[chain];
    if (!registryAddress) throw new Error(`Unsupported chain: ${chain}`);

    const agentModel = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
    if (!agentModel) throw new Error('Agent model not found');

    if (agentModel.erc8004?.status === 'minted' || agentModel.erc8004?.status === 'active') {
      throw new Error(`Identity already minted (agentId: ${agentModel.erc8004.agentId})`);
    }

    // Step 1: Generate registration file
    const registrationFile = await this.generateRegistrationFile();

    // Step 2: Upload avatar to IPFS
    let avatarCID = null;
    try {
      avatarCID = await this.uploadAvatarToIPFS();
      if (avatarCID) {
        registrationFile.avatar = `ipfs://${avatarCID}`;
      }
    } catch (err) {
      logger.warn('Avatar IPFS upload failed, continuing without:', err.message);
    }

    // Step 3: Upload registration file to IPFS
    const registrationCID = await this.uploadToIPFS(registrationFile, 'alice-erc8004-registration.json');
    const agentURI = `ipfs://${registrationCID}`;
    logger.info(`Registration file uploaded to IPFS: ${registrationCID}`);

    // Step 4: Call register() on the Identity Registry
    const ethers = await import('ethers');
    const signer = await transactionService.getWalletSigner(chain);
    const contract = new ethers.Contract(registryAddress, IDENTITY_REGISTRY_ABI, signer);

    logger.info(`Calling register("${agentURI}") on ${chain}...`);
    const tx = await contract['register(string)'](agentURI);
    logger.info(`Transaction sent: ${tx.hash}`);

    const receipt = await tx.wait();
    logger.info(`Transaction confirmed in block ${receipt.blockNumber}`);

    // Parse agentId from Registered event (ERC-8004) or Transfer event (ERC-721)
    let agentId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === 'Registered') {
          agentId = Number(parsed.args.agentId);
          break;
        }
        if (parsed?.name === 'Transfer' && agentId === null) {
          agentId = Number(parsed.args.tokenId);
        }
      } catch { /* not our event */ }
    }

    // Save to model
    agentModel.erc8004 = {
      ...agentModel.erc8004,
      status: 'active',
      chain,
      agentId,
      txHash: tx.hash,
      agentURI,
      registrationFile,
      capabilitiesHash: registrationFile.capabilitiesHash,
      ipfs: {
        avatarCID: avatarCID || agentModel.erc8004?.ipfs?.avatarCID,
        registrationCID
      },
      mintedAt: new Date(),
      lastUpdated: new Date()
    };
    await agentModel.save();

    logger.info(`ERC-8004 identity minted! agentId=${agentId}, tx=${tx.hash}`);

    // Auto-link wallet on-chain after minting
    let linkedWallet = null;
    try {
      const linkResult = await this.linkWallet();
      linkedWallet = linkResult.linkedWallet;
      logger.info(`Wallet auto-linked after mint: ${linkedWallet}`);
    } catch (linkError) {
      logger.warn(`Auto-link wallet failed (can be done manually): ${linkError.message}`);
    }

    return {
      agentId,
      txHash: tx.hash,
      agentURI,
      registrationCID,
      avatarCID,
      chain,
      linkedWallet,
      explorerUrl: `${EXPLORER_URLS[chain]}/tx/${tx.hash}`
    };
  }

  /**
   * Update on-chain registration (re-upload + setAgentURI)
   */
  async updateRegistration({ forceAvatarReupload = false } = {}) {
    const agentModel = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
    if (!agentModel?.erc8004?.agentId) {
      throw new Error('No minted identity found. Mint first.');
    }

    const chain = agentModel.erc8004.chain || 'bsc';
    const registryAddress = REGISTRY_ADDRESSES[chain];
    const agentId = agentModel.erc8004.agentId;

    // Re-generate registration file
    const registrationFile = await this.generateRegistrationFile();

    // Re-upload avatar to IPFS if forced (e.g. avatar image changed)
    if (forceAvatarReupload && agentModel.erc8004?.ipfs) {
      agentModel.erc8004.ipfs.avatarCID = null;
      await agentModel.save();
      const newAvatarCID = await this.uploadAvatarToIPFS();
      if (newAvatarCID) {
        agentModel.erc8004.ipfs.avatarCID = newAvatarCID;
        registrationFile.avatar = `ipfs://${newAvatarCID}`;
      }
    } else if (agentModel.erc8004?.ipfs?.avatarCID) {
      registrationFile.avatar = `ipfs://${agentModel.erc8004.ipfs.avatarCID}`;
    }

    // Upload new registration to IPFS
    const registrationCID = await this.uploadToIPFS(registrationFile, 'alice-erc8004-registration.json');
    const newURI = `ipfs://${registrationCID}`;

    // Call setAgentURI on-chain
    const ethers = await import('ethers');
    const signer = await transactionService.getWalletSigner(chain);
    const contract = new ethers.Contract(registryAddress, IDENTITY_REGISTRY_ABI, signer);

    logger.info(`Calling setAgentURI(${agentId}, "${newURI}") on ${chain}...`);
    const tx = await contract.setAgentURI(agentId, newURI);
    const receipt = await tx.wait();
    logger.info(`Update confirmed in block ${receipt.blockNumber}`);

    // Update model
    agentModel.erc8004.agentURI = newURI;
    agentModel.erc8004.registrationFile = registrationFile;
    agentModel.erc8004.capabilitiesHash = registrationFile.capabilitiesHash;
    agentModel.erc8004.ipfs.registrationCID = registrationCID;
    agentModel.erc8004.lastUpdated = new Date();
    agentModel.erc8004.status = 'active';
    await agentModel.save();

    return {
      agentId,
      txHash: tx.hash,
      agentURI: newURI,
      registrationCID,
      chain,
      explorerUrl: `${EXPLORER_URLS[chain]}/tx/${tx.hash}`
    };
  }

  /**
   * Recover on-chain ERC-8004 state if DB record was lost/reset.
   * Checks ownerOf() and tokenURI() for the stored agentId.
   */
  async _recoverOnChainState(agentModel) {
    const erc8004 = agentModel.erc8004 || {};
    const chain = erc8004.chain || 'bsc';
    const agentId = erc8004.agentId;
    const registryAddress = REGISTRY_ADDRESSES[chain];

    const ethers = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(chain);
    const contract = new ethers.Contract(registryAddress, IDENTITY_REGISTRY_ABI, provider);

    const owner = await contract.ownerOf(agentId);
    if (!owner || owner === ethers.ZeroAddress) return false;

    const agentURI = await contract.tokenURI(agentId);
    let linkedWallet = null;
    try {
      linkedWallet = await contract.getAgentWallet(agentId);
      if (linkedWallet === ethers.ZeroAddress) linkedWallet = null;
    } catch { /* optional */ }

    agentModel.erc8004 = {
      ...erc8004,
      status: 'active',
      agentId,
      agentURI: agentURI || erc8004.agentURI,
      linkedWallet: linkedWallet || erc8004.linkedWallet,
      lastUpdated: new Date()
    };
    await agentModel.save();
    logger.info(`ERC-8004 state recovered from on-chain: agentId=${agentId}, owner=${owner}`);
    return true;
  }

  /**
   * Get current identity status
   */
  async getIdentityStatus() {
    const agentModel = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' }).lean();
    let erc8004 = agentModel?.erc8004 || {};

    // If DB says unregistered but agent has an agentId we know about, or if
    // status was lost, try to recover from on-chain state
    if (agentModel && (!erc8004.status || erc8004.status === 'none') && erc8004.agentId != null) {
      try {
        const recovered = await this._recoverOnChainState(agentModel);
        if (recovered) erc8004 = agentModel.erc8004;
      } catch (e) {
        logger.debug('On-chain recovery check failed:', e.message);
      }
    }

    // Check staleness by comparing current external services hash vs stored
    let isStale = false;
    if (erc8004.capabilitiesHash) {
      try {
        const ExternalServiceConfig = (await import('../../models/ExternalServiceConfig.js')).default;
        const configs = await ExternalServiceConfig.find({ enabled: true }).lean();
        const capabilities = configs.map(s => ({
          name: s.name,
          version: '1.0.0',
          enabled: true
        }));
        const currentHash = this.computeCapabilitiesHash(capabilities);
        isStale = currentHash !== erc8004.capabilitiesHash;
      } catch (e) {
        logger.debug('Could not check capabilities staleness:', e.message);
      }
    }

    const chain = erc8004.chain || 'bsc';
    return {
      status: erc8004.status || 'none',
      chain,
      agentId: erc8004.agentId || null,
      txHash: erc8004.txHash || null,
      agentURI: erc8004.agentURI || null,
      capabilitiesHash: erc8004.capabilitiesHash || null,
      isStale,
      ipfs: erc8004.ipfs || {},
      mintedAt: erc8004.mintedAt || null,
      lastUpdated: erc8004.lastUpdated || null,
      registryAddress: REGISTRY_ADDRESSES[chain],
      explorerUrl: erc8004.txHash ? `${EXPLORER_URLS[chain]}/tx/${erc8004.txHash}` : null,
      nftUrl: erc8004.agentId != null ? `${EXPLORER_URLS[chain]}/nft/${REGISTRY_ADDRESSES[chain]}/${erc8004.agentId}` : null,
      linkedWallet: erc8004.linkedWallet || null,
      walletLinkedAt: erc8004.walletLinkedAt || null
    };
  }

  /**
   * Link a wallet address via EIP-712 signed setAgentWallet
   */
  async linkWallet(walletAddress = null) {
    const agentModel = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
    if (!agentModel?.erc8004?.agentId) {
      throw new Error('No minted identity found. Mint first.');
    }

    const chain = agentModel.erc8004.chain || 'bsc';
    const registryAddress = REGISTRY_ADDRESSES[chain];
    const agentId = agentModel.erc8004.agentId;

    const ethers = await import('ethers');
    const signer = await transactionService.getWalletSigner(chain);
    const signerAddress = await signer.getAddress();
    const newWallet = walletAddress || signerAddress;

    // Deadline: 1 hour from now
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    // Build EIP-712 typed data matching the contract's DOMAIN_SEPARATOR
    const domain = {
      name: 'AgentIdentity',
      version: '1',
      chainId: chain === 'bsc' ? 56 : 1,
      verifyingContract: registryAddress
    };

    const types = {
      SetAgentWallet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'deadline', type: 'uint256' }
      ]
    };

    const value = {
      agentId,
      newWallet,
      deadline
    };

    // Sign EIP-712 typed data
    const signature = await signer.signTypedData(domain, types, value);

    // Call setAgentWallet on-chain
    const contract = new ethers.Contract(registryAddress, IDENTITY_REGISTRY_ABI, signer);
    logger.info(`Calling setAgentWallet(${agentId}, ${newWallet}, ${deadline}) on ${chain}...`);
    const tx = await contract.setAgentWallet(agentId, newWallet, deadline, signature);
    const receipt = await tx.wait();
    logger.info(`setAgentWallet confirmed in block ${receipt.blockNumber}`);

    // Update model
    agentModel.erc8004.linkedWallet = newWallet;
    agentModel.erc8004.walletLinkedAt = new Date();
    agentModel.erc8004.lastUpdated = new Date();
    await agentModel.save();

    return {
      agentId,
      linkedWallet: newWallet,
      txHash: tx.hash,
      chain,
      explorerUrl: `${EXPLORER_URLS[chain]}/tx/${tx.hash}`
    };
  }

  /**
   * Estimate gas for minting
   */
  async estimateMintGas(chain = 'bsc') {
    const registryAddress = REGISTRY_ADDRESSES[chain];
    if (!registryAddress) throw new Error(`Unsupported chain: ${chain}`);

    try {
      const ethers = await import('ethers');
      const provider = await contractServiceWrapper.getProvider(chain);
      const contract = new ethers.Contract(registryAddress, IDENTITY_REGISTRY_ABI, provider);

      // Estimate gas for register() with a sample URI
      const gasEstimate = await contract['register(string)'].estimateGas('ipfs://QmSampleCIDForEstimate');
      const feeData = await provider.getFeeData();
      const gasCost = gasEstimate * feeData.gasPrice;
      const costInEth = ethers.formatEther(gasCost);

      return {
        gasUnits: gasEstimate.toString(),
        gasPrice: ethers.formatUnits(feeData.gasPrice, 'gwei') + ' gwei',
        estimatedCost: costInEth,
        currency: chain === 'bsc' ? 'BNB' : 'ETH'
      };
    } catch (err) {
      logger.debug('Gas estimation failed (contract may not be deployed):', err.message);
      // Return a reasonable default for BSC
      return {
        gasUnits: '~150000',
        gasPrice: '~3 gwei',
        estimatedCost: chain === 'bsc' ? '~0.0005' : '~0.003',
        currency: chain === 'bsc' ? 'BNB' : 'ETH',
        estimated: true
      };
    }
  }
}

export default new AgentIdentityService();
