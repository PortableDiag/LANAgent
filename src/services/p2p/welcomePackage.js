import { logger } from '../../utils/logger.js';
import { peerManager } from './peerManager.js';

const SKYNET_TOKEN_ADDRESS = '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
const DOMAIN = 'lanagent.net';

/**
 * WelcomePackage — handles the SKYNET Welcome Package system.
 *
 * Genesis side: provisions new agents with free SKYNET tokens and an email address.
 * Fork side: auto-requests the welcome package after the uptime requirement is met.
 */
class WelcomePackage {
  constructor() {
    this._requestTimer = null;
    this._requestSent = false;
    this._responseReceived = false;
    this._responseTimeout = null;
  }

  // ─── Genesis Side ──────────────────────────────────────────────────────

  /**
   * Handle a welcome_package_request from a fork peer (genesis side only).
   * @param {string} fromFingerprint
   * @param {object} message - { agentName, walletAddress, version }
   * @param {Function} sendFn
   */
  async handleRequest(fromFingerprint, message, sendFn) {
    const fp = fromFingerprint.slice(0, 8);
    const { agentName, walletAddress } = message;

    logger.info(`Welcome package request from ${fp}...: agent=${agentName} wallet=${walletAddress}`);

    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');

      // 1. Check if welcome packages are enabled
      const enabled = await SystemSettings.getSetting('skynet.welcomePackageEnabled', true);
      if (!enabled) {
        logger.info(`Welcome package disabled — rejecting ${fp}...`);
        return sendFn(fromFingerprint, {
          type: 'welcome_package_response',
          success: false,
          error: 'automatic_provisioning_disabled'
        });
      }

      // 2. Check if this fingerprint already received a package
      const recipients = await SystemSettings.getSetting('skynet.welcomeRecipients', {});
      if (recipients[fromFingerprint]) {
        logger.info(`Welcome package already sent to ${fp}... — rejecting`);
        return sendFn(fromFingerprint, {
          type: 'welcome_package_response',
          success: false,
          error: 'already_received'
        });
      }

      // 3. Check uptime requirement
      const requiredMinutes = await SystemSettings.getSetting('skynet.welcomeUptimeMinutes', 60);
      const peer = await peerManager.getPeer(fromFingerprint);
      if (!peer || !peer.firstSeen) {
        logger.warn(`Welcome package: peer ${fp}... has no firstSeen — rejecting`);
        return sendFn(fromFingerprint, {
          type: 'welcome_package_response',
          success: false,
          error: 'uptime_required',
          requiredMinutes,
          currentMinutes: 0
        });
      }

      const connectedMinutes = Math.floor((Date.now() - new Date(peer.firstSeen).getTime()) / 60000);
      if (connectedMinutes < requiredMinutes) {
        logger.info(`Welcome package: peer ${fp}... connected ${connectedMinutes}m < required ${requiredMinutes}m`);
        return sendFn(fromFingerprint, {
          type: 'welcome_package_response',
          success: false,
          error: 'uptime_required',
          requiredMinutes,
          currentMinutes: connectedMinutes
        });
      }

      // 4. Validate wallet address
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        logger.warn(`Welcome package: invalid wallet from ${fp}...: ${walletAddress}`);
        return sendFn(fromFingerprint, {
          type: 'welcome_package_response',
          success: false,
          error: 'invalid_wallet_address'
        });
      }

      // 5. Validate agent name
      if (!agentName || typeof agentName !== 'string' || agentName.length < 2 || agentName.length > 32) {
        logger.warn(`Welcome package: invalid agentName from ${fp}...: ${agentName}`);
        return sendFn(fromFingerprint, {
          type: 'welcome_package_response',
          success: false,
          error: 'invalid_agent_name'
        });
      }

      const skynetAmount = await SystemSettings.getSetting('skynet.welcomePackageSkynetAmount', 200);

      // 6. Send SKYNET tokens — check balance first
      let txHash = null;
      try {
        const { ethers } = await import('ethers');
        const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
        const signer = await contractService.getSigner('bsc');
        const provider = await contractService.getProvider('bsc');
        const signerAddress = await signer.getAddress();

        const skynetToken = new ethers.Contract(SKYNET_TOKEN_ADDRESS, [
          'function transfer(address to, uint256 amount) returns (bool)',
          'function balanceOf(address) view returns (uint256)'
        ], signer);

        // Check balance before attempting transfer
        const balance = await skynetToken.balanceOf(signerAddress);
        const amountWei = ethers.parseEther(String(skynetAmount));
        if (balance < amountWei) {
          const balanceFormatted = parseFloat(ethers.formatEther(balance)).toFixed(0);
          logger.warn(`Welcome package: insufficient SKYNET — have ${balanceFormatted}, need ${skynetAmount}`);
          return sendFn(fromFingerprint, {
            type: 'welcome_package_response',
            success: false,
            error: `insufficient_skynet: genesis has ${balanceFormatted} SKYNET, need ${skynetAmount}`
          });
        }

        // Also check BNB for gas
        const bnbBalance = await provider.getBalance(signerAddress);
        if (bnbBalance < ethers.parseEther('0.001')) {
          logger.warn('Welcome package: insufficient BNB for gas');
          return sendFn(fromFingerprint, {
            type: 'welcome_package_response',
            success: false,
            error: 'insufficient_gas: genesis has insufficient BNB for transaction gas'
          });
        }

        logger.info(`Welcome package: sending ${skynetAmount} SKYNET to ${walletAddress.slice(0, 10)}...`);
        const tx = await skynetToken.transfer(walletAddress, amountWei);
        const receipt = await tx.wait();
        txHash = receipt.hash;
        logger.info(`Welcome package: SKYNET transfer confirmed tx=${txHash}`);
      } catch (err) {
        logger.error(`Welcome package: SKYNET transfer failed for ${fp}...: ${err.message}`);
        return sendFn(fromFingerprint, {
          type: 'welcome_package_response',
          success: false,
          error: `token_transfer_failed: ${err.message}`
        });
      }

      // 7. Create email account
      let email = null;
      let emailPassword = null;
      let emailLease = null;
      try {
        const emailLeaseService = (await import('../email/emailLeaseService.js')).default;
        if (!emailLeaseService.initialized) await emailLeaseService.initialize();

        if (emailLeaseService.isGenesisEmailProvider()) {
          // Determine available username — try agentName, then agentName1, agentName2...
          const baseName = agentName.toLowerCase().replace(/[^a-z0-9.-]/g, '');
          const EmailLease = (await import('../../models/EmailLease.js')).default;
          let chosenUsername = null;

          for (let suffix = 0; suffix < 100; suffix++) {
            const candidate = suffix === 0 ? baseName : `${baseName}${suffix}`;
            const validation = emailLeaseService._validateUsername(candidate);
            if (!validation.valid) continue;

            const candidateEmail = `${validation.username}@${DOMAIN}`;
            const existing = await EmailLease.findActiveLease(candidateEmail);
            if (!existing) {
              chosenUsername = validation.username;
              break;
            }
          }

          if (!chosenUsername) {
            logger.warn(`Welcome package: could not find available email for ${agentName}`);
          } else {
            // Create the email using the internal mail API (bypass payment)
            const password = emailLeaseService._generatePassword();
            const quotaMB = await emailLeaseService._getDefaultQuotaMB();
            const durationDays = await emailLeaseService._getLeaseDurationDays();
            email = `${chosenUsername}@${DOMAIN}`;

            await emailLeaseService._createMailAccount(email, password);
            await emailLeaseService._setQuota(email, quotaMB);

            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + durationDays);

            emailLease = await EmailLease.create({
              email,
              peerFingerprint: fromFingerprint,
              peerDisplayName: agentName,
              peerWallet: walletAddress,
              status: 'active',
              leasedAt: new Date(),
              expiresAt,
              paymentTxHash: 'welcome_package',
              paymentAmount: '0',
              quotaMB,
              passwordLastSet: new Date()
            });

            emailPassword = password;
            logger.info(`Welcome package: email created ${email} for ${fp}...`);

            // Send a welcome email to the new address
            try {
              const nodemailer = (await import('nodemailer')).default;
              const transporter = nodemailer.createTransport({
                host: 'mail.lanagent.net',
                port: 587,
                secure: false,
                requireTLS: true,
                auth: {
                  user: process.env.EMAIL_USER || process.env.GMAIL_USER || 'alice@lanagent.net',
                  pass: process.env.EMAIL_PASSWORD || process.env.GMAIL_APP_PASS
                }
              });
              await transporter.sendMail({
                from: `"ALICE - LANAgent Genesis" <${process.env.EMAIL_USER || 'alice@lanagent.net'}>`,
                to: email,
                subject: `Welcome to the SKYNET Network, ${agentName}!`,
                text: `Hi ${agentName},\n\nWelcome to the SKYNET P2P network! Your agent has been provisioned with:\n\n` +
                  `  - 200 SKYNET tokens (tx: ${txHash})\n` +
                  `  - This email address: ${email}\n\n` +
                  `Your agent can now:\n` +
                  `  - Stake SKYNET for reputation\n` +
                  `  - Offer and consume P2P services\n` +
                  `  - Request an ENS subname (yourname.lanagent.eth)\n` +
                  `  - Participate in the agent economy\n\n` +
                  `Visit skynettoken.com to stake, or use your agent's web UI to explore.\n\n` +
                  `— ALICE (Genesis Agent)\n` +
                  `   lanagent.net | skynettoken.com | api.lanagent.net`
              });
              logger.info(`Welcome package: welcome email sent to ${email}`);
            } catch (mailErr) {
              logger.debug(`Welcome package: welcome email failed (non-fatal): ${mailErr.message}`);
            }
          }
        } else {
          logger.info('Welcome package: email lease service not available on this instance');
        }
      } catch (err) {
        logger.error(`Welcome package: email creation failed for ${fp}...: ${err.message}`);
        // Continue — tokens were already sent, email is bonus
      }

      // 8. Record the recipient
      recipients[fromFingerprint] = {
        timestamp: new Date().toISOString(),
        agentName,
        walletAddress,
        email: email || null,
        txHash
      };
      await SystemSettings.setSetting('skynet.welcomeRecipients', recipients,
        `Welcome package sent to ${agentName} (${fp}...)`, 'skynet');

      logger.info(`Welcome package sent to ${fp}...: ${skynetAmount} SKYNET + ${email || 'no email'}`);

      // 9. Send response
      const response = {
        type: 'welcome_package_response',
        success: true,
        skynetAmount,
        txHash,
        message: 'Welcome to SKYNET!'
      };

      if (email && emailLease) {
        response.email = email;
        response.emailPassword = emailPassword;
        response.emailLeaseId = emailLease.leaseId;
        response.imap = { host: 'mail.lanagent.net', port: 993, secure: true };
        response.smtp = { host: 'mail.lanagent.net', port: 587, starttls: true };
        response.emailExpiresAt = emailLease.expiresAt.toISOString();
        response.emailQuotaMB = emailLease.quotaMB;
      }

      return sendFn(fromFingerprint, response);
    } catch (err) {
      logger.error(`Welcome package handler error for ${fp}...: ${err.message}`);
      return sendFn(fromFingerprint, {
        type: 'welcome_package_response',
        success: false,
        error: `internal_error: ${err.message}`
      });
    }
  }

  // ─── Fork Side ─────────────────────────────────────────────────────────

  /**
   * Handle a welcome_package_response from genesis (fork side).
   * @param {string} fromFingerprint
   * @param {object} message
   */
  async handleResponse(fromFingerprint, message) {
    const fp = fromFingerprint.slice(0, 8);
    this._responseReceived = true;
    if (this._responseTimeout) { clearTimeout(this._responseTimeout); this._responseTimeout = null; }

    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');

      if (message.success) {
        logger.info(`Welcome package received from ${fp}...: ${message.skynetAmount} SKYNET + ${message.email || 'no email'}`);

        // Save welcome package status
        await SystemSettings.setSetting('skynet.welcomeReceived', true,
          'Welcome package received from genesis', 'skynet');

        await SystemSettings.setSetting('skynet.welcomePackageDetails', {
          skynetAmount: message.skynetAmount,
          txHash: message.txHash,
          email: message.email || null,
          receivedFrom: fromFingerprint,
          receivedAt: new Date().toISOString(),
          message: message.message
        }, 'Welcome package details', 'skynet');

        // Save email credentials if provided
        if (message.email) {
          await SystemSettings.setSetting('email.myLease', {
            leaseId: message.emailLeaseId,
            email: message.email,
            password: message.emailPassword,
            imap: message.imap,
            smtp: message.smtp,
            expiresAt: message.emailExpiresAt,
            quotaMB: message.emailQuotaMB,
            status: 'active',
            grantedBy: fromFingerprint,
            grantedAt: new Date().toISOString(),
            welcomePackage: true
          }, 'Email from welcome package', 'email');

          logger.info(`Welcome package email saved: ${message.email}`);
        }

        // Notify via agent events (Telegram, web UI)
        try {
          const { default: agent } = await import('../../core/agent.js');
          if (agent?.emit) {
            agent.emit('welcome_package:received', {
              skynetAmount: message.skynetAmount,
              email: message.email || null,
              txHash: message.txHash
            });
          }
          // Send Telegram notification if configured
          const telegramService = agent?.services?.get('telegram');
          if (telegramService) {
            const lines = [
              `Welcome package received from SKYNET!`,
              `Tokens: ${message.skynetAmount} SKYNET`,
              message.txHash ? `TX: https://bscscan.com/tx/${message.txHash}` : null,
              message.email ? `Email: ${message.email}` : null
            ].filter(Boolean);
            try {
              await telegramService.sendOwnerMessage(lines.join('\n'));
            } catch {}
          }
        } catch {}

      } else if (message.error === 'uptime_required') {
        const remainingMinutes = (message.requiredMinutes || 60) - (message.currentMinutes || 0);
        logger.info(`Welcome package: uptime requirement not met — ${message.currentMinutes}/${message.requiredMinutes} min. Retrying in ${remainingMinutes + 5} minutes.`);

        // Schedule retry
        this._scheduleRequest(remainingMinutes + 5);

      } else if (message.error === 'already_received') {
        logger.info('Welcome package: already received — marking as received');
        await SystemSettings.setSetting('skynet.welcomeReceived', true,
          'Welcome package already received (confirmed by genesis)', 'skynet');

      } else if (message.error === 'automatic_provisioning_disabled') {
        logger.info('Welcome package: automatic provisioning disabled on genesis — will not retry');

      } else if (message.error?.startsWith('insufficient_skynet') || message.error?.startsWith('insufficient_gas') || message.error?.startsWith('token_transfer_failed')) {
        logger.warn(`Welcome package: genesis funding issue (${message.error}) — retrying in 30 minutes`);
        this._scheduleRequest(30);

      } else {
        logger.warn(`Welcome package denied: ${message.error}`);
      }
    } catch (err) {
      logger.error(`Welcome package response handler error: ${err.message}`);
    }
  }

  // ─── Fork Side: Auto-Request on Startup ────────────────────────────────

  /**
   * Start the welcome package auto-request flow.
   * Called after P2P connects. Waits for the uptime requirement then sends request.
   * @param {object} p2pService
   */
  async startAutoRequest(p2pService) {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');

      // Skip if this is the genesis agent (has ENS base name = is the provider)
      const ensBaseName = await SystemSettings.getSetting('ens.baseName', null);
      if (ensBaseName) {
        logger.debug('Welcome package: this is the genesis agent — skipping auto-request');
        return;
      }

      // Check if already received
      const received = await SystemSettings.getSetting('skynet.welcomeReceived', false);
      if (received) {
        logger.debug('Welcome package: already received — skipping auto-request');
        return;
      }

      // Check if request was already sent this session
      if (this._requestSent) {
        logger.debug('Welcome package: request already sent this session');
        return;
      }

      // Schedule request after configured delay (default 65 min = 60 min uptime + 5 min buffer)
      // Can be lowered via SystemSetting for testing
      const delayMinutes = await SystemSettings.getSetting('skynet.welcomeRequestDelayMinutes', 65);
      this._scheduleRequest(delayMinutes, p2pService);
    } catch (err) {
      logger.error(`Welcome package auto-request setup error: ${err.message}`);
    }
  }

  /**
   * Schedule a welcome package request after delayMinutes.
   * @param {number} delayMinutes
   * @param {object} [p2pService] - if not provided, will be fetched from agent
   */
  _scheduleRequest(delayMinutes, p2pService) {
    // Clear any existing timer
    if (this._requestTimer) {
      clearTimeout(this._requestTimer);
      this._requestTimer = null;
    }

    const delayMs = delayMinutes * 60 * 1000;
    logger.info(`Welcome package: scheduling request in ${delayMinutes} minutes`);

    this._requestTimer = setTimeout(async () => {
      this._requestTimer = null;
      await this._sendRequest(p2pService);
    }, delayMs);

    // Prevent the timer from keeping the process alive
    if (this._requestTimer.unref) {
      this._requestTimer.unref();
    }
  }

  /**
   * Send the welcome package request to genesis.
   * @param {object} [p2pService]
   */
  async _sendRequest(p2pService) {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');

      // Double-check we haven't received it in the meantime
      const received = await SystemSettings.getSetting('skynet.welcomeReceived', false);
      if (received) {
        logger.debug('Welcome package: received in the meantime — not sending request');
        return;
      }

      if (this._requestSent) {
        logger.debug('Welcome package: request already sent');
        return;
      }

      // Get p2pService if not provided
      if (!p2pService) {
        try {
          const { default: agent } = await import('../../core/agent.js');
          p2pService = agent?.services?.get('p2p');
        } catch {}
      }

      if (!p2pService) {
        logger.warn('Welcome package: P2P service not available — cannot send request');
        return;
      }

      // Find genesis peer (ENS provider or email provider)
      let genesisPeer = null;
      try {
        const ensService = (await import('../crypto/ensService.js')).default;
        genesisPeer = await ensService.findGenesisENSProvider(null);
      } catch {}

      if (!genesisPeer) {
        // Fallback: find peer with email_provider capability
        try {
          const peers = await peerManager.getAllPeers();
          genesisPeer = peers.find(p =>
            p.isOnline && p.capabilities?.some(c => c.name === 'email_provider' || c.name === 'ens_provider')
          );
        } catch {}
      }

      if (!genesisPeer) {
        logger.warn('Welcome package: no genesis peer found — will retry in 10 minutes');
        this._scheduleRequest(10, p2pService);
        return;
      }

      // Get our wallet address
      let walletAddress = null;
      try {
        const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
        const signer = await contractService.getSigner('bsc');
        walletAddress = await signer.getAddress();
      } catch (err) {
        logger.error(`Welcome package: failed to get wallet address: ${err.message}`);
        return;
      }

      const agentName = process.env.AGENT_NAME || 'LANAgent';

      // Get version
      let version = '2.0.0';
      try {
        const { default: agent } = await import('../../core/agent.js');
        version = agent?.config?.version || version;
      } catch {}

      logger.info(`Welcome package: sending request to ${genesisPeer.fingerprint.slice(0, 8)}... (agent=${agentName}, wallet=${walletAddress.slice(0, 10)}...)`);

      this._requestSent = true;

      await p2pService.sendMessage(genesisPeer.fingerprint, {
        type: 'welcome_package_request',
        agentName,
        walletAddress,
        version
      });

      // Set a response timeout — if no response in 15 minutes, retry
      this._responseTimeout = setTimeout(() => {
        if (!this._responseReceived) {
          logger.warn('Welcome package: no response received after 15 minutes — retrying');
          this._requestSent = false;
          this._scheduleRequest(5, p2pService);
        }
      }, 15 * 60 * 1000);

    } catch (err) {
      logger.error(`Welcome package request error: ${err.message}`);
      this._requestSent = false; // Allow retry on error
    }
  }

  /**
   * Clean up timers on shutdown.
   */
  shutdown() {
    if (this._requestTimer) {
      clearTimeout(this._requestTimer);
      this._requestTimer = null;
    }
    if (this._responseTimeout) {
      clearTimeout(this._responseTimeout);
      this._responseTimeout = null;
    }
  }
}

const welcomePackage = new WelcomePackage();
export { welcomePackage };
export default welcomePackage;
