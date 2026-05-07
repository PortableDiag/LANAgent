import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const autoAccountSchema = new mongoose.Schema({
    serviceName: {
        type: String,
        required: true,
        index: true
    },
    serviceUrl: {
        type: String,
        required: true
    },
    accountType: {
        type: String,
        enum: ['email', 'username', 'phone', 'oauth'],
        default: 'email'
    },
    isPrimary: {
        type: Boolean,
        default: false,
        index: true
    },
    source: {
        type: String,
        enum: ['manual', 'auto-registered'],
        default: 'manual'
    },
    credentialType: {
        type: String,
        enum: ['password', 'api_key', 'oauth_token', 'session', 'mixed'],
        default: 'password'
    },
    encryptedCredentials: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'active', 'suspended', 'expired', 'failed'],
        default: 'pending'
    },
    verificationStatus: {
        type: String,
        enum: ['unverified', 'email_sent', 'verified', 'failed'],
        default: 'unverified'
    },
    registrationDate: {
        type: Date,
        default: Date.now
    },
    lastLoginDate: Date,
    lastActivityDate: Date,
    verificationEmail: String,
    verificationCode: String,
    verificationLink: String,
    verificationExpiry: Date,
    serviceData: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    usageCount: {
        type: Number,
        default: 0
    },
    apiCalls: [{
        endpoint: String,
        timestamp: Date,
        success: Boolean,
        error: String
    }],
    notes: String,
    tags: [String],
    autoRenew: {
        type: Boolean,
        default: false
    },
    renewalDate: Date,
    failedAttempts: {
        type: Number,
        default: 0
    },
    lastError: {
        message: String,
        timestamp: Date,
        details: mongoose.Schema.Types.Mixed
    },
    mfaEnabled: {
        type: Boolean,
        default: false
    },
    backupCodes: [String],
    loginFrequency: {
        type: Number,
        default: 0
    },
    averageSessionDuration: {
        type: Number,
        default: 0
    },
    featureUsage: {
        type: Map,
        of: Number,
        default: {}
    }
}, {
    timestamps: true
});

autoAccountSchema.index({ serviceName: 1, status: 1 });
autoAccountSchema.index({ serviceName: 1, isPrimary: 1 });
autoAccountSchema.index({ verificationStatus: 1 });
autoAccountSchema.index({ tags: 1 });
autoAccountSchema.index({ source: 1 });

autoAccountSchema.virtual('accountAge').get(function() {
    return Date.now() - this.registrationDate;
});

autoAccountSchema.methods.isVerificationExpired = function() {
    if (!this.verificationExpiry) return false;
    return Date.now() > this.verificationExpiry;
};

autoAccountSchema.methods.needsRenewal = function() {
    if (!this.autoRenew || !this.renewalDate) return false;
    return Date.now() > this.renewalDate;
};

/**
 * Enable MFA for the account
 * @returns {Promise<void>}
 */
autoAccountSchema.methods.enableMFA = async function() {
    if (this.mfaEnabled) {
        throw new Error('MFA is already enabled.');
    }
    const decryptedCredentials = JSON.parse(decrypt(this.encryptedCredentials));
    if (!decryptedCredentials.totpSecret) {
        throw new Error('TOTP secret is missing.');
    }
    this.mfaEnabled = true;
    await this.save();
    logger.info(`MFA enabled for account: ${this.serviceName}`);
};

/**
 * Disable MFA for the account
 * @returns {Promise<void>}
 */
autoAccountSchema.methods.disableMFA = async function() {
    if (!this.mfaEnabled) {
        throw new Error('MFA is not enabled.');
    }
    this.mfaEnabled = false;
    this.backupCodes = [];
    await this.save();
    logger.info(`MFA disabled for account: ${this.serviceName}`);
};

/**
 * Generate backup codes for MFA
 * @returns {Promise<string[]>}
 */
autoAccountSchema.methods.generateBackupCodes = async function() {
    if (!this.mfaEnabled) {
        throw new Error('MFA is not enabled.');
    }
    const codes = Array.from({ length: 10 }, () => Math.random().toString(36).slice(-8));
    this.backupCodes = codes;
    await this.save();
    logger.info(`Backup codes generated for account: ${this.serviceName}`);
    return codes;
};

/**
 * Update account activity analytics
 * @returns {Promise<void>}
 */
autoAccountSchema.methods.updateActivityAnalytics = async function() {
    try {
        await retryOperation(async () => {
            const now = Date.now();
            const lastLogin = this.lastLoginDate ? this.lastLoginDate.getTime() : now;
            const sessionDuration = now - lastLogin;
            this.averageSessionDuration = ((this.averageSessionDuration * this.usageCount) + sessionDuration) / (this.usageCount + 1);
            this.usageCount += 1;
            this.loginFrequency += 1;
            await this.save();
            logger.info(`Updated activity analytics for account: ${this.serviceName}`);
        }, { retries: 3, context: 'AutoAccount.updateActivityAnalytics' });
    } catch (error) {
        logger.error(`Failed to update activity analytics for account: ${this.serviceName}`, { error });
    }
};

/**
 * Track feature usage
 * @param {string} featureName
 * @returns {Promise<void>}
 */
autoAccountSchema.methods.trackFeatureUsage = async function(featureName) {
    try {
        await retryOperation(async () => {
            if (!this.featureUsage.has(featureName)) {
                this.featureUsage.set(featureName, 0);
            }
            this.featureUsage.set(featureName, this.featureUsage.get(featureName) + 1);
            await this.save();
            logger.info(`Tracked feature usage for account: ${this.serviceName}, feature: ${featureName}`);
        }, { retries: 3, context: 'AutoAccount.trackFeatureUsage' });
    } catch (error) {
        logger.error(`Failed to track feature usage for account: ${this.serviceName}, feature: ${featureName}`, { error });
    }
};

/**
 * Deactivate the account
 * @returns {Promise<void>}
 */
autoAccountSchema.methods.deactivateAccount = async function() {
    if (this.status === 'suspended') {
        throw new Error('Account is already deactivated.');
    }
    this.status = 'suspended';
    await this.save();
    logger.info(`Account deactivated: ${this.serviceName}`);
};

/**
 * Reactivate the account
 * @returns {Promise<void>}
 */
autoAccountSchema.methods.reactivateAccount = async function() {
    if (this.status !== 'suspended') {
        throw new Error('Account is not suspended.');
    }
    this.status = 'active';
    await this.save();
    logger.info(`Account reactivated: ${this.serviceName}`);
};

/**
 * Archive the account
 * @returns {Promise<void>}
 */
autoAccountSchema.methods.archiveAccount = async function() {
    if (this.status === 'expired') {
        throw new Error('Account is already archived.');
    }
    this.status = 'expired';
    await this.save();
    logger.info(`Account archived: ${this.serviceName}`);
};

/**
 * Automatically archive inactive accounts
 * @param {number} inactivityThreshold - Duration in milliseconds for inactivity
 * @returns {Promise<void>}
 */
autoAccountSchema.statics.archiveInactiveAccounts = async function(inactivityThreshold) {
    try {
        const thresholdDate = new Date(Date.now() - inactivityThreshold);
        const inactiveAccounts = await this.find({ lastActivityDate: { $lt: thresholdDate }, status: { $ne: 'expired' } });

        for (const account of inactiveAccounts) {
            account.status = 'expired';
            await account.save();
            logger.info(`Archived inactive account: ${account.serviceName}`);
        }
    } catch (error) {
        logger.error('Failed to archive inactive accounts', { error });
    }
};

const AutoAccount = mongoose.model('AutoAccount', autoAccountSchema);

export default AutoAccount;
