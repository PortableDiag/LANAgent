import { launchBrowser } from '../utils/stealthBrowser.js';
import { logger } from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import AutoAccount from '../models/AutoAccount.js';
import emailService from './emailService.js';
import crypto from 'crypto';

class AccountRegistrationService {
    constructor() {
        this.browser = null;
        this.registrationStrategies = new Map();
        this.initializeStrategies();
    }

    initializeStrategies() {
        // Add common registration strategies
        this.addStrategy('github', {
            signupUrl: 'https://github.com/signup',
            selectors: {
                email: 'input[name="user[email]"]',
                password: 'input[name="user[password]"]',
                username: 'input[name="user[login]"]',
                submitButton: 'button[type="submit"]'
            },
            requiresEmail: true,
            verificationType: 'link'
        });

        this.addStrategy('openai', {
            signupUrl: 'https://platform.openai.com/signup',
            selectors: {
                email: 'input[name="email"]',
                password: 'input[name="password"]',
                submitButton: 'button[type="submit"]'
            },
            requiresEmail: true,
            verificationType: 'link'
        });

        // Generic strategy for unknown sites
        this.addStrategy('generic', {
            selectors: {
                email: 'input[type="email"], input[name*="email"], input[id*="email"]',
                password: 'input[type="password"], input[name*="password"], input[id*="password"]',
                username: 'input[name*="username"], input[name*="user"], input[id*="username"]',
                submitButton: 'button[type="submit"], input[type="submit"], button:contains("Sign Up"), button:contains("Register")'
            },
            requiresEmail: true,
            verificationType: 'auto'
        });
    }

    addStrategy(serviceName, strategy) {
        this.registrationStrategies.set(serviceName.toLowerCase(), strategy);
    }

    async initBrowser() {
        if (!this.browser) {
            this.browser = await launchBrowser();
        }
        return this.browser;
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    /**
     * Generate account credentials
     * @param {string} serviceName - Name of the service
     * @param {boolean} isPrimary - If true, uses plain email; if false, uses plus-addressing
     */
    generateCredentials(serviceName, isPrimary = false) {
        const timestamp = Date.now();
        const randomStr = crypto.randomBytes(4).toString('hex');

        // Get email from EMAIL_USER or GMAIL_USER env var (e.g., alice@lanagent.net)
        const gmailUser = process.env.EMAIL_USER || process.env.GMAIL_USER || 'lanagent@example.com';
        const [emailPrefix, emailDomain] = gmailUser.split('@');

        // Generate unique but memorable credentials
        // Use first part of agent name for username prefix
        const agentName = emailPrefix.replace(/[^a-z0-9]/gi, '').substring(0, 10);

        let email;
        let baseUsername;

        if (isPrimary) {
            // Primary account uses the plain email directly
            email = gmailUser;
            baseUsername = agentName;
        } else {
            // Secondary accounts use plus addressing for uniqueness
            baseUsername = `${agentName}_${serviceName}_${randomStr}`;
            email = `${emailPrefix}+${serviceName.toLowerCase().replace(/[^a-z0-9]/gi, '')}_${timestamp}@${emailDomain}`;
        }

        const password = this.generateSecurePassword();

        return {
            username: baseUsername.toLowerCase().replace(/[^a-z0-9_]/g, ''),
            email: email,
            password: password
        };
    }

    /**
     * Add a manually created account (for accounts created outside the agent)
     * @param {Object} accountData - Account data including credentials
     */
    async addManualAccount(accountData) {
        const { serviceName, serviceUrl, credentials, credentialType = 'password', isPrimary = false, notes, tags } = accountData;

        // If marking as primary, unset any existing primary for this service
        if (isPrimary) {
            await AutoAccount.updateMany(
                { serviceName, isPrimary: true },
                { $set: { isPrimary: false } }
            );
        }

        const account = new AutoAccount({
            serviceName,
            serviceUrl: serviceUrl || `https://${serviceName.toLowerCase()}.com`,
            encryptedCredentials: encrypt(JSON.stringify(credentials)),
            credentialType,
            isPrimary,
            source: 'manual',
            status: 'active',
            verificationStatus: 'verified',
            notes,
            tags: tags || []
        });

        await account.save();

        logger.info(`Manual account added for ${serviceName}`, { isPrimary, credentialType });

        await this.logActivity('manual_add', {
            serviceName,
            accountId: account._id.toString(),
            isPrimary
        });

        return account;
    }

    /**
     * Get the primary account for a service
     * @param {string} serviceName - Name of the service
     */
    async getPrimaryAccount(serviceName) {
        const account = await AutoAccount.findOne({
            serviceName,
            isPrimary: true,
            status: 'active'
        });

        if (!account) {
            return null;
        }

        return {
            ...account.toObject(),
            credentials: JSON.parse(decrypt(account.encryptedCredentials))
        };
    }

    /**
     * Set an account as primary for its service
     * @param {string} accountId - Account ID to set as primary
     */
    async setPrimaryAccount(accountId) {
        const account = await AutoAccount.findById(accountId);
        if (!account) {
            throw new Error('Account not found');
        }

        // Unset any existing primary for this service
        await AutoAccount.updateMany(
            { serviceName: account.serviceName, isPrimary: true },
            { $set: { isPrimary: false } }
        );

        // Set this account as primary
        account.isPrimary = true;
        await account.save();

        logger.info(`Account ${accountId} set as primary for ${account.serviceName}`);
        return account;
    }

    /**
     * Update account credentials
     * @param {string} accountId - Account ID
     * @param {Object} credentials - New credentials to merge/replace
     */
    async updateCredentials(accountId, credentials) {
        const account = await AutoAccount.findById(accountId);
        if (!account) {
            throw new Error('Account not found');
        }

        // Get existing credentials and merge
        const existingCreds = JSON.parse(decrypt(account.encryptedCredentials));
        const mergedCreds = { ...existingCreds, ...credentials };

        account.encryptedCredentials = encrypt(JSON.stringify(mergedCreds));
        account.lastActivityDate = new Date();
        await account.save();

        logger.info(`Credentials updated for account ${accountId}`);
        return account;
    }

    generateSecurePassword() {
        // Generate a strong password with uppercase, lowercase, numbers, and symbols
        const lowercase = 'abcdefghijklmnopqrstuvwxyz';
        const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const numbers = '0123456789';
        const symbols = '!@#$%^&*()_+-=[]{}';
        
        const allChars = lowercase + uppercase + numbers + symbols;
        let password = '';
        
        // Ensure at least one of each type
        password += lowercase[Math.floor(Math.random() * lowercase.length)];
        password += uppercase[Math.floor(Math.random() * uppercase.length)];
        password += numbers[Math.floor(Math.random() * numbers.length)];
        password += symbols[Math.floor(Math.random() * symbols.length)];
        
        // Fill rest randomly
        for (let i = 4; i < 16; i++) {
            password += allChars[Math.floor(Math.random() * allChars.length)];
        }
        
        // Shuffle the password
        return password.split('').sort(() => Math.random() - 0.5).join('');
    }

    /**
     * Register for a new account on a service
     * @param {string} serviceName - Name of the service
     * @param {string} serviceUrl - URL of the service
     * @param {Object} options - Options including isPrimary, credentials
     */
    async registerAccount(serviceName, serviceUrl, options = {}) {
        const { isPrimary = false } = options;

        // If marking as primary, unset any existing primary for this service
        if (isPrimary) {
            await AutoAccount.updateMany(
                { serviceName, isPrimary: true },
                { $set: { isPrimary: false } }
            );
        }

        // Generate credentials upfront so they're available for both success and error paths
        const credentials = options.credentials || this.generateCredentials(serviceName, isPrimary);

        const account = new AutoAccount({
            serviceName,
            serviceUrl,
            status: 'pending',
            isPrimary,
            source: 'auto-registered',
            encryptedCredentials: encrypt(JSON.stringify(credentials))
        });

        try {
            logger.info(`Starting registration for ${serviceName}`, { isPrimary });

            // Get strategy
            const strategy = this.registrationStrategies.get(serviceName.toLowerCase()) ||
                           this.registrationStrategies.get('generic');
            
            // Launch browser and navigate
            await this.initBrowser();
            const page = await this.browser.newPage();
            
            // Set user agent to avoid detection
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Navigate to signup page
            const signupUrl = strategy.signupUrl || serviceUrl;
            await page.goto(signupUrl, { waitUntil: 'networkidle2' });
            
            // Fill registration form
            const filled = await this.fillRegistrationForm(page, strategy, credentials);
            if (!filled) {
                throw new Error('Failed to fill registration form');
            }
            
            // Submit form
            await this.submitForm(page, strategy);
            
            // Wait for response
            await page.waitForNavigation({ waitUntil: 'networkidle2' });
            
            // Check for success or errors
            const result = await this.checkRegistrationResult(page);
            
            // Update account status (credentials already encrypted upfront)
            account.status = result.success ? 'active' : 'failed';
            account.verificationStatus = result.requiresVerification ? 'email_sent' : 'verified';
            
            if (result.error) {
                account.lastError = {
                    message: result.error,
                    timestamp: new Date()
                };
            }
            
            await account.save();
            
            // Handle email verification if needed
            if (result.requiresVerification) {
                await this.scheduleEmailVerification(account);
            }
            
            await page.close();
            
            logger.info(`Registration ${result.success ? 'successful' : 'failed'} for ${serviceName}`);
            
            // Log the registration activity
            await this.logActivity('register', {
                serviceName,
                accountId: result.account?._id,
                success: result.success
            });
            return account;
            
        } catch (error) {
            logger.error(`Registration failed for ${serviceName}:`, error);
            account.status = 'failed';
            account.lastError = {
                message: error.message,
                timestamp: new Date(),
                details: error.stack
            };
            await account.save();
            throw error;
        }
    }

    /**
     * Fill registration form using selectors
     */
    async fillRegistrationForm(page, strategy, credentials) {
        try {
            // Fill email
            if (strategy.selectors.email) {
                await page.waitForSelector(strategy.selectors.email, { timeout: 10000 });
                await page.type(strategy.selectors.email, credentials.email, { delay: 100 });
            }
            
            // Fill username if required
            if (strategy.selectors.username) {
                const usernameField = await page.$(strategy.selectors.username);
                if (usernameField) {
                    await page.type(strategy.selectors.username, credentials.username, { delay: 100 });
                }
            }
            
            // Fill password
            if (strategy.selectors.password) {
                await page.waitForSelector(strategy.selectors.password, { timeout: 10000 });
                await page.type(strategy.selectors.password, credentials.password, { delay: 100 });
            }
            
            // Handle password confirmation if exists
            const confirmFields = await page.$$('input[type="password"]');
            if (confirmFields.length > 1) {
                await confirmFields[1].type(credentials.password, { delay: 100 });
            }
            
            // Handle checkboxes (terms, etc)
            const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)');
            for (const checkbox of checkboxes) {
                await checkbox.click();
            }
            
            return true;
        } catch (error) {
            logger.error('Failed to fill form:', error);
            return false;
        }
    }

    /**
     * Submit registration form
     */
    async submitForm(page, strategy) {
        try {
            await page.waitForSelector(strategy.selectors.submitButton, { timeout: 10000 });
            await page.click(strategy.selectors.submitButton);
        } catch (error) {
            // Try alternative submit methods
            const submitButton = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                return buttons.find(b => 
                    b.textContent.match(/sign up|register|create account|get started/i)
                );
            });
            
            if (submitButton) {
                await submitButton.click();
            } else {
                throw new Error('Could not find submit button');
            }
        }
    }

    /**
     * Check registration result
     */
    async checkRegistrationResult(page) {
        // Wait a bit for any errors to appear
        await page.waitForTimeout(2000);
        
        // Check for common error messages
        const errorTexts = [
            'already exists',
            'already taken',
            'invalid',
            'error',
            'failed',
            'try again'
        ];
        
        const pageContent = await page.content();
        const hasError = errorTexts.some(text => 
            pageContent.toLowerCase().includes(text)
        );
        
        // Check for verification messages
        const verificationTexts = [
            'verify your email',
            'verification email',
            'check your email',
            'confirm your email'
        ];
        
        const requiresVerification = verificationTexts.some(text => 
            pageContent.toLowerCase().includes(text)
        );
        
        return {
            success: !hasError,
            requiresVerification,
            error: hasError ? 'Registration failed - check form errors' : null
        };
    }

    /**
     * Schedule email verification check
     */
    async scheduleEmailVerification(account) {
        // Set verification expiry (24 hours)
        account.verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await account.save();
        
        // Schedule periodic checks for verification email
        setTimeout(() => this.checkVerificationEmail(account._id), 30000); // Check after 30s
    }

    /**
     * Check for verification email and extract code/link
     */
    async checkVerificationEmail(accountId) {
        try {
            const account = await AutoAccount.findById(accountId);
            if (!account || account.verificationStatus === 'verified') {
                return;
            }
            
            const credentials = JSON.parse(decrypt(account.encryptedCredentials));
            
            // Check email for verification
            const verificationData = await emailService.checkForVerification(
                credentials.email,
                account.serviceName
            );
            
            if (verificationData) {
                account.verificationCode = verificationData.code;
                account.verificationLink = verificationData.link;
                
                // Attempt automatic verification
                if (verificationData.link) {
                    await this.completeVerification(account, verificationData.link);
                }
                
                await account.save();
            } else if (!account.isVerificationExpired()) {
                // Check again in 2 minutes
                setTimeout(() => this.checkVerificationEmail(accountId), 120000);
            }
        } catch (error) {
            logger.error('Failed to check verification email:', error);
        }
    }

    /**
     * Complete email verification
     */
    async completeVerification(account, verificationLink) {
        try {
            await this.initBrowser();
            const page = await this.browser.newPage();
            
            await page.goto(verificationLink, { waitUntil: 'networkidle2' });
            
            // Check if verification succeeded
            await page.waitForTimeout(3000);
            const pageContent = await page.content();
            
            if (pageContent.toLowerCase().includes('verified') || 
                pageContent.toLowerCase().includes('confirmed') ||
                pageContent.toLowerCase().includes('success')) {
                account.verificationStatus = 'verified';
                account.status = 'active';
                logger.info(`Verification completed for ${account.serviceName}`);
                
                // Log the verification activity
                await this.logActivity('verify_complete', {
                    accountId: account._id.toString(),
                    serviceName: account.serviceName
                });
            }
            
            await page.close();
        } catch (error) {
            logger.error('Verification failed:', error);
        }
    }

    /**
     * Get stored account credentials
     */
    async getAccountCredentials(serviceName) {
        const account = await AutoAccount.findOne({
            serviceName,
            status: 'active'
        }).sort('-createdAt');
        
        if (!account) {
            throw new Error(`No active account found for ${serviceName}`);
        }
        
        const credentials = JSON.parse(decrypt(account.encryptedCredentials));
        
        // Update last activity
        account.lastActivityDate = new Date();
        await account.save();
        
        return credentials;
    }

    /**
     * List all registered accounts
     */
    async listAccounts(filter = {}) {
        const accounts = await AutoAccount.find(filter)
            .select('-encryptedCredentials')
            .sort('-createdAt')
            .lean();

        return accounts;
    }

    /**
     * Update account status
     */
    async updateAccountStatus(accountId, status) {
        const account = await AutoAccount.findById(accountId);
        if (!account) {
            throw new Error('Account not found');
        }
        
        account.status = status;
        await account.save();
        
        return account;
    }

    /**
     * Delete account
     */
    async deleteAccount(accountId) {
        const account = await AutoAccount.findById(accountId);
        const serviceName = account?.serviceName;
        
        await AutoAccount.findByIdAndDelete(accountId);
        logger.info(`Account ${accountId} deleted`);
        
        // Log the deletion activity
        await this.logActivity('delete', {
            accountId,
            serviceName
        });
    }

    /**
     * Log account activity for audit trail and tracking
     * @param {string} action - The action performed (e.g., 'register', 'login', 'delete', 'verify')
     * @param {Object} details - Additional details about the action
     */
    async logActivity(action, details) {
        try {
            // If we have an accountId, update the account's activity tracking
            if (details.accountId) {
                const account = await AutoAccount.findById(details.accountId);
                if (account) {
                    account.lastActivityDate = new Date();
                    
                    // Add to API calls log if it's an API-related action
                    if (action.includes('api') || action.includes('verify') || action.includes('check')) {
                        account.apiCalls.push({
                            endpoint: action,
                            timestamp: new Date(),
                            success: true,
                            error: null
                        });
                        // Keep only last 100 API calls to avoid unbounded growth
                        if (account.apiCalls.length > 100) {
                            account.apiCalls = account.apiCalls.slice(-100);
                        }
                    }
                    
                    await account.save();
                }
            }
            
            // Also log to the general logger for audit trail
            logger.info(`Account activity: ${action}`, {
                action,
                ...details,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            // Don't throw error from logging - we don't want logging failures to break the main flow
            logger.error('Failed to log account activity:', error);
        }
    }
}

export default new AccountRegistrationService();