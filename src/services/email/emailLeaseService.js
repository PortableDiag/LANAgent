import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

const RESERVED_USERNAMES = new Set([
  'admin', 'postmaster', 'abuse', 'root', 'info', 'support',
  'noreply', 'no-reply', 'alice', 'webmaster', 'hostmaster',
  'security', 'mailer-daemon', 'mail', 'smtp', 'imap', 'pop3'
]);

const USERNAME_REGEX = /^[a-z0-9][a-z0-9.\-]{1,28}[a-z0-9]$/;
const DOMAIN = 'lanagent.net';
const MAIL_HOST = 'mail.lanagent.net';

class EmailLeaseService {
  constructor() {
    this.mailApiUrl = null;
    this.mailApiSecret = null;
    this.initialized = false;
  }

  async initialize() {
    this.mailApiUrl = process.env.MAIL_API_URL || null;
    this.mailApiSecret = process.env.MAIL_API_SECRET || null;
    this.initialized = true;

    if (this.isGenesisEmailProvider()) {
      logger.info('Email lease service initialized (genesis provider mode)');
    }
  }

  // ─── Genesis Detection ──────────────────────────────────────────────────

  isGenesisEmailProvider() {
    return process.env.EMAIL_LEASE_ENABLED === 'true' &&
           !!this.mailApiUrl &&
           !!this.mailApiSecret;
  }

  // ─── Mail API Client ───────────────────────────────────────────────────

  _signRequest(method, path, body) {
    const timestamp = String(Date.now());
    const bodyHash = crypto.createHash('sha256')
      .update(JSON.stringify(body) || '')
      .digest('hex');
    const signature = crypto.createHmac('sha256', this.mailApiSecret)
      .update(`${method}:${path}:${timestamp}:${bodyHash}`)
      .digest('hex');
    return { timestamp, signature };
  }

  async _callMailApi(method, path, body = null) {
    const { timestamp, signature } = this._signRequest(method, path, body);

    const url = `${this.mailApiUrl}${path}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Timestamp': timestamp,
        'X-Signature': signature
      }
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Mail API error: ${response.status}`);
    }

    return data;
  }

  async _createMailAccount(email, password) {
    return this._callMailApi('POST', '/api/mail/accounts', { email, password });
  }

  async _deleteMailAccount(email) {
    return this._callMailApi('DELETE', `/api/mail/accounts/${encodeURIComponent(email)}`);
  }

  async _resetMailPassword(email, password) {
    return this._callMailApi('PUT', `/api/mail/accounts/${encodeURIComponent(email)}/password`, { password });
  }

  async _setQuota(email, quotaMB) {
    return this._callMailApi('POST', `/api/mail/accounts/${encodeURIComponent(email)}/quota`, { quotaMB });
  }

  async _listMailAccounts() {
    return this._callMailApi('GET', '/api/mail/accounts');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  _generatePassword() {
    return crypto.randomBytes(16).toString('base64url');
  }

  _validateUsername(username) {
    if (!username || typeof username !== 'string') {
      return { valid: false, error: 'Username is required' };
    }

    const lower = username.toLowerCase().trim();

    if (lower.length < 3 || lower.length > 30) {
      return { valid: false, error: 'Username must be 3-30 characters' };
    }

    if (!USERNAME_REGEX.test(lower)) {
      return { valid: false, error: 'Username must be alphanumeric with dots/hyphens, cannot start/end with dot or hyphen' };
    }

    if (lower.includes('..') || lower.includes('--') || lower.includes('.-') || lower.includes('-.')) {
      return { valid: false, error: 'Username cannot contain consecutive special characters' };
    }

    if (RESERVED_USERNAMES.has(lower)) {
      return { valid: false, error: 'Username is reserved' };
    }

    return { valid: true, username: lower };
  }

  async getLeasePrice() {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    return await SystemSettings.getSetting('email.leasePrice', 100);
  }

  async getRenewalPrice() {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    return await SystemSettings.getSetting('email.renewalPrice', 80);
  }

  async _getMaxLeasesPerPeer() {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    return await SystemSettings.getSetting('email.maxLeasesPerPeer', 3);
  }

  async _getLeaseDurationDays() {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    return await SystemSettings.getSetting('email.leaseDurationDays', 365);
  }

  async _getDefaultQuotaMB() {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    return await SystemSettings.getSetting('email.defaultQuotaMB', 500);
  }

  // ─── Genesis Side: Handle Lease Request ─────────────────────────────────

  async handleLeaseRequest(fromFingerprint, message, sendFn) {
    const fp = fromFingerprint.slice(0, 8);
    const { desiredUsername, ownerWallet, paymentTxHash } = message;

    if (!this.isGenesisEmailProvider()) {
      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: 'This instance does not provide email leases'
      });
    }

    // Validate username
    const validation = this._validateUsername(desiredUsername);
    if (!validation.valid) {
      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: validation.error
      });
    }

    const email = `${validation.username}@${DOMAIN}`;
    const EmailLease = (await import('../../models/EmailLease.js')).default;

    // Check if already taken
    const existingLease = await EmailLease.findActiveLease(email);
    if (existingLease) {
      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: `${email} is already leased`
      });
    }

    // Check max leases per peer
    const maxLeases = await this._getMaxLeasesPerPeer();
    const peerLeases = await EmailLease.countDocuments({
      peerFingerprint: fromFingerprint,
      status: 'active'
    });
    if (peerLeases >= maxLeases) {
      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: `Maximum ${maxLeases} active leases per peer reached`
      });
    }

    // Payment flow
    const price = await this.getLeasePrice();
    if (price > 0) {
      if (!paymentTxHash) {
        // Request payment — get recipient wallet and SKYNET token address
        let recipientWallet = null;
        let tokenAddress = null;
        try {
          const skynetExecutor = (await import('../p2p/skynetServiceExecutor.js')).default;
          recipientWallet = await skynetExecutor.getRecipientAddress();
          tokenAddress = await skynetExecutor.getSkynetTokenAddress();
        } catch {}
        // Fallback: get wallet from signer if skynetExecutor failed
        if (!recipientWallet) {
          try {
            const cs = (await import('../crypto/contractServiceWrapper.js')).default;
            const signer = await cs.getSigner('bsc');
            recipientWallet = await signer.getAddress();
          } catch {}
        }
        if (!tokenAddress) {
          tokenAddress = process.env.SKYNET_TOKEN_ADDRESS || '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
        }

        const durationDays = await this._getLeaseDurationDays();
        const quotaMB = await this._getDefaultQuotaMB();

        return sendFn(fromFingerprint, {
          type: 'email_lease_payment_required',
          desiredUsername: validation.username,
          amount: price,
          currency: 'SKYNET',
          tokenAddress,
          recipientWallet,
          leaseDurationDays: durationDays,
          quotaMB
        });
      }

      // Verify payment
      try {
        const skynetExecutor = (await import('../p2p/skynetServiceExecutor.js')).default;
        const paymentResult = await skynetExecutor.verifyPayment(
          paymentTxHash, price, fromFingerprint, 'email_lease'
        );
        if (!paymentResult.success) {
          return sendFn(fromFingerprint, {
            type: 'email_lease_response',
            success: false,
            error: `Payment verification failed: ${paymentResult.error}`
          });
        }
      } catch (err) {
        return sendFn(fromFingerprint, {
          type: 'email_lease_response',
          success: false,
          error: `Payment verification error: ${err.message}`
        });
      }
    }

    // Create mail account
    try {
      const password = this._generatePassword();
      const quotaMB = await this._getDefaultQuotaMB();
      const durationDays = await this._getLeaseDurationDays();

      logger.info(`Creating email account for peer ${fp}...: ${email}`);

      await this._createMailAccount(email, password);
      await this._setQuota(email, quotaMB);

      // Create lease record
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + durationDays);

      const lease = await EmailLease.create({
        email,
        peerFingerprint: fromFingerprint,
        peerDisplayName: message.peerDisplayName || '',
        peerWallet: ownerWallet || '',
        status: 'active',
        leasedAt: new Date(),
        expiresAt,
        paymentTxHash: paymentTxHash || null,
        paymentAmount: price > 0 ? String(price) : null,
        quotaMB,
        passwordLastSet: new Date()
      });

      logger.info(`Email lease created: ${email} for peer ${fp}... expires ${expiresAt.toISOString()}`);

      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: true,
        leaseId: lease.leaseId,
        email,
        password,
        imap: { host: MAIL_HOST, port: 993, secure: true },
        smtp: { host: MAIL_HOST, port: 587, starttls: true },
        expiresAt: expiresAt.toISOString(),
        quotaMB
      });
    } catch (err) {
      logger.error(`Email lease creation failed for peer ${fp}...: ${err.message}`);
      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: `Account creation failed: ${err.message}`
      });
    }
  }

  // ─── Genesis Side: Handle Renewal ───────────────────────────────────────

  async handleRenewRequest(fromFingerprint, message, sendFn) {
    const fp = fromFingerprint.slice(0, 8);
    const { leaseId, paymentTxHash } = message;

    if (!this.isGenesisEmailProvider()) {
      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: 'This instance does not provide email leases'
      });
    }

    const EmailLease = (await import('../../models/EmailLease.js')).default;
    const lease = await EmailLease.findOne({ leaseId, peerFingerprint: fromFingerprint });

    if (!lease) {
      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: 'Lease not found'
      });
    }

    if (lease.status === 'revoked') {
      return sendFn(fromFingerprint, {
        type: 'email_lease_response',
        success: false,
        error: 'Lease has been revoked'
      });
    }

    // Payment flow
    const price = await this.getRenewalPrice();
    if (price > 0) {
      if (!paymentTxHash) {
        let recipientWallet = null;
        let tokenAddress = null;
        try {
          const skynetExecutor = (await import('../p2p/skynetServiceExecutor.js')).default;
          recipientWallet = await skynetExecutor.getRecipientAddress();
          tokenAddress = await skynetExecutor.getSkynetTokenAddress();
        } catch {}

        return sendFn(fromFingerprint, {
          type: 'email_lease_payment_required',
          desiredUsername: lease.email.split('@')[0],
          amount: price,
          currency: 'SKYNET',
          tokenAddress,
          recipientWallet,
          leaseDurationDays: await this._getLeaseDurationDays(),
          quotaMB: lease.quotaMB,
          isRenewal: true,
          leaseId
        });
      }

      // Verify payment
      try {
        const skynetExecutor = (await import('../p2p/skynetServiceExecutor.js')).default;
        const paymentResult = await skynetExecutor.verifyPayment(
          paymentTxHash, price, fromFingerprint, 'email_lease_renewal'
        );
        if (!paymentResult.success) {
          return sendFn(fromFingerprint, {
            type: 'email_lease_response',
            success: false,
            error: `Payment verification failed: ${paymentResult.error}`
          });
        }
      } catch (err) {
        return sendFn(fromFingerprint, {
          type: 'email_lease_response',
          success: false,
          error: `Payment verification error: ${err.message}`
        });
      }
    }

    // Extend lease
    const durationDays = await this._getLeaseDurationDays();
    const baseDate = lease.expiresAt > new Date() ? lease.expiresAt : new Date();
    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + durationDays);

    lease.expiresAt = newExpiry;
    lease.renewedAt = new Date();
    lease.status = 'active';
    lease.renewalPayments.push({
      txHash: paymentTxHash || 'free',
      amount: String(price),
      paidAt: new Date(),
      extendsTo: newExpiry
    });
    await lease.save();

    logger.info(`Email lease renewed: ${lease.email} for peer ${fp}... new expiry ${newExpiry.toISOString()}`);

    return sendFn(fromFingerprint, {
      type: 'email_lease_response',
      success: true,
      leaseId: lease.leaseId,
      email: lease.email,
      expiresAt: newExpiry.toISOString(),
      renewed: true
    });
  }

  // ─── Genesis Side: Revoke ───────────────────────────────────────────────

  async revokeLease(leaseId, reason) {
    const EmailLease = (await import('../../models/EmailLease.js')).default;
    const lease = await EmailLease.findOne({ leaseId });
    if (!lease) throw new Error('Lease not found');

    // Delete the mail account
    if (this.isGenesisEmailProvider()) {
      try {
        await this._deleteMailAccount(lease.email);
      } catch (err) {
        logger.warn(`Failed to delete mail account ${lease.email}: ${err.message}`);
      }
    }

    lease.status = 'revoked';
    lease.revokedAt = new Date();
    lease.revokeReason = reason || 'Admin revocation';
    await lease.save();

    logger.info(`Email lease revoked: ${lease.email} — ${reason}`);
    return lease;
  }

  // ─── Genesis Side: Check Expired Leases ─────────────────────────────────

  async checkExpiredLeases() {
    if (!this.isGenesisEmailProvider()) return { checked: false };

    const EmailLease = (await import('../../models/EmailLease.js')).default;
    const expired = await EmailLease.find({
      status: 'active',
      expiresAt: { $lt: new Date() }
    });

    let processed = 0;
    for (const lease of expired) {
      try {
        await this._deleteMailAccount(lease.email);
        lease.status = 'expired';
        await lease.save();
        processed++;
        logger.info(`Email lease expired and account deleted: ${lease.email}`);
      } catch (err) {
        logger.error(`Failed to expire lease ${lease.email}: ${err.message}`);
      }
    }

    return { checked: true, expired: processed };
  }

  // ─── Genesis Side: Reset Password ───────────────────────────────────────

  async resetLeasePassword(leaseId, sendFn) {
    const EmailLease = (await import('../../models/EmailLease.js')).default;
    const lease = await EmailLease.findOne({ leaseId, status: 'active' });
    if (!lease) throw new Error('Active lease not found');

    const password = this._generatePassword();
    await this._resetMailPassword(lease.email, password);

    lease.passwordLastSet = new Date();
    await lease.save();

    // Deliver new credentials via P2P if sendFn available
    if (sendFn) {
      await sendFn(lease.peerFingerprint, {
        type: 'email_lease_response',
        success: true,
        leaseId: lease.leaseId,
        email: lease.email,
        password,
        imap: { host: MAIL_HOST, port: 993, secure: true },
        smtp: { host: MAIL_HOST, port: 587, starttls: true },
        expiresAt: lease.expiresAt.toISOString(),
        quotaMB: lease.quotaMB,
        passwordReset: true
      });
    }

    return { email: lease.email, passwordDelivered: !!sendFn };
  }

  // ─── Fork Side: Find Provider ──────────────────────────────────────────

  async findEmailProvider() {
    try {
      const { peerManager } = await import('../p2p/peerManager.js');
      const peers = await peerManager.getAllPeers();

      for (const peer of peers) {
        if (peer.capabilities?.some(c => c.name === 'email_provider')) {
          return peer;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── Fork Side: Request Lease ──────────────────────────────────────────

  async requestLease(p2pService, fingerprint, username, wallet, txHash) {
    return p2pService.sendMessage(fingerprint, {
      type: 'email_lease_request',
      desiredUsername: username.toLowerCase(),
      ownerWallet: wallet || null,
      paymentTxHash: txHash || null
    });
  }
}

const emailLeaseService = new EmailLeaseService();
export { emailLeaseService };
export default emailLeaseService;
