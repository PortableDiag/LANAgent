import express from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import { logger } from '../utils/logger.js';
import ensService from '../services/crypto/ensService.js';
import emailLeaseService from '../services/email/emailLeaseService.js';

const router = express.Router();
router.use(authenticateToken);

/**
 * GET /api/identity/status
 * Returns current ENS subname and email lease status for this instance.
 */
router.get('/status', async (req, res) => {
  try {
    const { SystemSettings } = await import('../models/SystemSettings.js');

    // ENS status
    const mySubname = await SystemSettings.getSetting('ens.mySubname', null);
    const pendingENS = await SystemSettings.getSetting('ens.pendingSubnameRequest', null);
    const ensBaseName = await SystemSettings.getSetting('ens.baseName', null);

    // Email status — check both possible storage keys
    const myLease = await SystemSettings.getSetting('email.myLease', null);
    const myEmail = myLease?.email || await SystemSettings.getSetting('email.leasedAddress', null);
    const pendingEmail = await SystemSettings.getSetting('email.pendingLeaseRequest', null);

    // Welcome package status
    const welcomeReceived = await SystemSettings.getSetting('skynet.welcomeReceived', false);
    const welcomeDetails = await SystemSettings.getSetting('skynet.welcomePackageDetails', null);
    let welcomeStatus = 'pending';
    if (welcomeReceived) {
      welcomeStatus = 'received';
    }
    // Check if disabled on genesis (we can only know if we got a denial)
    const welcomeEnabled = await SystemSettings.getSetting('skynet.welcomePackageEnabled', true);
    if (!welcomeEnabled) {
      welcomeStatus = 'disabled';
    }

    // Get dynamic ENS price
    let ensPricing = { price: 100, dynamic: false };
    try {
      await ensService.initialize();
      ensPricing = await ensService.getSubnamePriceDetails();
    } catch { /* use default */ }

    res.json({
      success: true,
      data: {
        ens: {
          configured: !!mySubname,
          subname: mySubname ? `${mySubname}.lanagent.eth` : null,
          pending: pendingENS ? pendingENS.label : null,
          isGenesis: !!ensBaseName,
          price: ensPricing.price,
          priceDynamic: ensPricing.dynamic,
          gasCostUsd: ensPricing.gasCostUsd,
          ethGwei: ensPricing.ethGwei
        },
        email: {
          configured: !!myEmail,
          address: myEmail || null,
          pending: pendingEmail ? pendingEmail.username : null,
          price: ensPricing.price // same price as ENS
        },
        welcomePackage: {
          status: welcomeStatus,
          received: welcomeReceived,
          details: welcomeDetails
        }
      }
    });
  } catch (error) {
    logger.error('Identity status error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/identity/ens
 * Request an ENS subname from the genesis agent.
 * Body: { label: "myagent" }
 */
router.post('/ens', async (req, res) => {
  try {
    const { label } = req.body;
    if (!label || typeof label !== 'string') {
      return res.status(400).json({ success: false, error: 'Label is required (e.g., "myagent" for myagent.lanagent.eth)' });
    }

    const cleanLabel = label.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (cleanLabel.length < 3 || cleanLabel.length > 32) {
      return res.status(400).json({ success: false, error: 'Label must be 3-32 characters (lowercase alphanumeric and hyphens)' });
    }

    // Initialize ENS service
    await ensService.initialize();

    // Check if already have a subname
    const { SystemSettings } = await import('../models/SystemSettings.js');
    const existing = await SystemSettings.getSetting('ens.mySubname', null);
    if (existing) {
      return res.json({ success: true, data: { status: 'already_configured', subname: `${existing}.lanagent.eth` } });
    }

    // Find genesis peer
    const { default: agent } = await import('../core/agent.js');
    const p2pService = agent?.services?.get('p2p');
    if (!p2pService) {
      return res.status(503).json({ success: false, error: 'P2P service not available — connect to the SKYNET network first' });
    }

    const genesisPeer = await ensService.findGenesisENSProvider(null);
    if (!genesisPeer) {
      return res.status(404).json({ success: false, error: 'No ENS provider found on the network. Make sure you are connected to the SKYNET P2P network.' });
    }

    // Get wallet address
    const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
    let ownerAddress;
    try {
      const signer = await contractService.getSigner('ethereum');
      ownerAddress = await signer.getAddress();
    } catch {
      // Try BSC signer as fallback (same wallet, different network)
      const signer = await contractService.getSigner('bsc');
      ownerAddress = await signer.getAddress();
    }

    await ensService.requestSubnameFromGenesis(p2pService, genesisPeer.fingerprint, cleanLabel, ownerAddress);

    // Get current dynamic price for display
    let currentPrice = 100;
    try { currentPrice = await ensService.getSubnamePrice(); } catch { /* fallback */ }

    res.json({
      success: true,
      data: {
        label: cleanLabel,
        fullName: `${cleanLabel}.lanagent.eth`,
        status: 'requested',
        price: `${currentPrice} SKYNET`,
        message: `Subname "${cleanLabel}.lanagent.eth" requested. The genesis agent will process it shortly. Cost: ${currentPrice} SKYNET (auto-paid from wallet).`
      }
    });
  } catch (error) {
    logger.error('ENS subname request error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/identity/email
 * Request an email lease from the genesis agent.
 * Body: { username: "myagent" }
 */
router.post('/email', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ success: false, error: 'Username is required (e.g., "myagent" for myagent@lanagent.net)' });
    }

    const cleanUsername = username.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (cleanUsername.length < 3 || cleanUsername.length > 32) {
      return res.status(400).json({ success: false, error: 'Username must be 3-32 characters' });
    }

    // Check if already have an email
    const { SystemSettings } = await import('../models/SystemSettings.js');
    const existingLease = await SystemSettings.getSetting('email.myLease', null);
    const existing = existingLease?.email || await SystemSettings.getSetting('email.leasedAddress', null);
    if (existing) {
      return res.json({ success: true, data: { status: 'already_configured', address: existing } });
    }

    // Find genesis peer (email provider)
    const { default: agent } = await import('../core/agent.js');
    const p2pService = agent?.services?.get('p2p');
    if (!p2pService) {
      return res.status(503).json({ success: false, error: 'P2P service not available — connect to the SKYNET network first' });
    }

    // Find a peer that provides email leases
    const peers = p2pService.peerManager?.getAllPeers() || [];
    const emailProvider = peers.find(p => p.capabilities?.includes('email_lease_provider'));
    if (!emailProvider) {
      // Try genesis peer as fallback
      const genesisPeer = await ensService.findGenesisENSProvider(null);
      if (!genesisPeer) {
        return res.status(404).json({ success: false, error: 'No email provider found on the network.' });
      }

      // Get wallet
      const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
      const signer = await contractService.getSigner('bsc');
      const wallet = await signer.getAddress();

      await emailLeaseService.requestLease(p2pService, genesisPeer.fingerprint, cleanUsername, wallet, null);

      let emailPrice = 100;
      try { emailPrice = await ensService.getSubnamePrice(); } catch { /* fallback */ }

      return res.json({
        success: true,
        data: {
          username: cleanUsername,
          address: `${cleanUsername}@lanagent.net`,
          status: 'requested',
          price: `${emailPrice} SKYNET`,
          message: `Email "${cleanUsername}@lanagent.net" requested. The genesis agent will process it shortly. Cost: ${emailPrice} SKYNET.`
        }
      });
    }

    const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
    const signer = await contractService.getSigner('bsc');
    const wallet = await signer.getAddress();

    await emailLeaseService.requestLease(p2pService, emailProvider.fingerprint, cleanUsername, wallet, null);

    let emailPrice = 100;
    try { emailPrice = await ensService.getSubnamePrice(); } catch { /* fallback */ }

    res.json({
      success: true,
      data: {
        username: cleanUsername,
        address: `${cleanUsername}@lanagent.net`,
        status: 'requested',
        price: `${emailPrice} SKYNET`,
        message: `Email "${cleanUsername}@lanagent.net" requested. Cost: ${emailPrice} SKYNET.`
      }
    });
  } catch (error) {
    logger.error('Email lease request error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/identity/welcome-status
 * Returns detailed welcome package state.
 */
router.get('/welcome-status', async (req, res) => {
  try {
    const { SystemSettings } = await import('../models/SystemSettings.js');

    const received = await SystemSettings.getSetting('skynet.welcomeReceived', false);
    const details = await SystemSettings.getSetting('skynet.welcomePackageDetails', null);
    const enabled = await SystemSettings.getSetting('skynet.welcomePackageEnabled', true);

    // Genesis-side stats (only populated on genesis)
    const recipients = await SystemSettings.getSetting('skynet.welcomeRecipients', {});
    const recipientCount = Object.keys(recipients).length;
    const skynetAmount = await SystemSettings.getSetting('skynet.welcomePackageSkynetAmount', 200);
    const uptimeMinutes = await SystemSettings.getSetting('skynet.welcomeUptimeMinutes', 60);

    let status = 'pending';
    if (received) status = 'received';
    else if (!enabled) status = 'disabled';

    res.json({
      success: true,
      data: {
        status,
        received,
        enabled,
        details,
        genesis: {
          skynetAmount,
          uptimeMinutes,
          recipientCount,
          recipients: recipientCount > 0 ? recipients : null
        }
      }
    });
  } catch (error) {
    logger.error('Welcome status error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/identity/wallet
 * Returns wallet address, BNB balance, and SKYNET balance.
 */
router.get('/wallet', async (req, res) => {
  try {
    const { ethers } = await import('ethers');
    const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
    const provider = await contractService.getProvider('bsc');
    const signer = await contractService.getSigner('bsc');
    const address = await signer.getAddress();

    const bnbBalance = parseFloat(ethers.formatEther(await provider.getBalance(address)));
    const skynetToken = new ethers.Contract(
      '0x8Ef0ecE5687417a8037F787b39417eB16972b04F',
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );
    const skynetBalance = parseFloat(ethers.formatEther(await skynetToken.balanceOf(address)));

    res.json({
      success: true,
      data: {
        address,
        bnb: bnbBalance,
        skynet: skynetBalance,
        hasSufficientSkynet: skynetBalance >= 100,
        network: 'BNB Smart Chain (BSC)',
        fundingInstructions: bnbBalance === 0 && skynetBalance === 0
          ? 'Send BNB to your agent wallet address above, then use "Convert to SKYNET" to swap.'
          : null
      }
    });
  } catch (error) {
    logger.error('Identity wallet error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/identity/buy-skynet
 * Swap BNB in the agent wallet for SKYNET via PancakeSwap.
 * Body: { amount: "0.01" } — amount of BNB to swap (or "all" to swap all minus gas reserve)
 */
router.post('/buy-skynet', async (req, res) => {
  try {
    let { amount } = req.body;

    const { ethers } = await import('ethers');
    const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
    const provider = await contractService.getProvider('bsc');
    const signer = await contractService.getSigner('bsc');
    const address = await signer.getAddress();
    const bnbBalance = parseFloat(ethers.formatEther(await provider.getBalance(address)));

    // Reserve 0.005 BNB for gas
    const GAS_RESERVE = 0.005;

    if (amount === 'all' || !amount) {
      amount = Math.max(0, bnbBalance - GAS_RESERVE);
    } else {
      amount = parseFloat(amount);
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        error: `Insufficient BNB. Balance: ${bnbBalance.toFixed(6)} BNB (${GAS_RESERVE} reserved for gas).`,
        data: { bnbBalance, gasReserve: GAS_RESERVE }
      });
    }

    if (amount > bnbBalance - GAS_RESERVE) {
      return res.status(400).json({
        success: false,
        error: `Not enough BNB. Available: ${(bnbBalance - GAS_RESERVE).toFixed(6)} BNB (after ${GAS_RESERVE} gas reserve).`
      });
    }

    const swapService = (await import('../services/crypto/swapService.js')).default;
    const result = await swapService.swap(
      'native',
      '0x8Ef0ecE5687417a8037F787b39417eB16972b04F',
      amount.toString(),
      2, // 2% slippage
      'bsc'
    );

    if (result.success) {
      // Check new SKYNET balance
      const skynetToken = new ethers.Contract(
        '0x8Ef0ecE5687417a8037F787b39417eB16972b04F',
        ['function balanceOf(address) view returns (uint256)'],
        provider
      );
      const newSkynetBalance = parseFloat(ethers.formatEther(await skynetToken.balanceOf(address)));
      const newBnbBalance = parseFloat(ethers.formatEther(await provider.getBalance(address)));

      res.json({
        success: true,
        data: {
          txHash: result.hash,
          bnbSpent: amount,
          skynetReceived: result.expectedOut || 'pending',
          newBalances: {
            bnb: newBnbBalance,
            skynet: newSkynetBalance
          },
          hasSufficientSkynet: newSkynetBalance >= 100,
          bscscanLink: `https://bscscan.com/tx/${result.hash}`
        }
      });
    } else {
      res.status(500).json({ success: false, error: result.error || 'Swap failed' });
    }
  } catch (error) {
    logger.error('Buy SKYNET error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
