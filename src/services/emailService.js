import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

class EmailService {
    constructor() {
        this.agent = null;
        this.emailPlugin = null;
        this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL for search results
        this.verificationPatterns = {
            code: [
                /verification code[:\s]+([0-9]{4,8})/i,
                /confirm code[:\s]+([0-9]{4,8})/i,
                /your code is[:\s]+([0-9]{4,8})/i,
                /code[:\s]+([0-9]{4,8})/i,
                /\b([0-9]{6})\b/, // Common 6-digit codes
                // Spanish patterns
                /código de verificación[:\s]+([0-9]{4,8})/i,
                /tu código es[:\s]+([0-9]{4,8})/i,
                // French patterns
                /code de vérification[:\s]+([0-9]{4,8})/i,
                /votre code est[:\s]+([0-9]{4,8})/i,
                // German patterns
                /bestätigungscode[:\s]+([0-9]{4,8})/i,
                /ihr code ist[:\s]+([0-9]{4,8})/i,
                // Italian patterns
                /codice di verifica[:\s]+([0-9]{4,8})/i,
                /il tuo codice è[:\s]+([0-9]{4,8})/i,
                // Portuguese patterns
                /código de verificação[:\s]+([0-9]{4,8})/i,
                /seu código é[:\s]+([0-9]{4,8})/i,
                // Dutch patterns
                /verificatiecode[:\s]+([0-9]{4,8})/i,
                /uw code is[:\s]+([0-9]{4,8})/i,
            ],
            link: [
                /(https?:\/\/[^\s]+(?:verify|confirm|activate)[^\s]*)/i,
                /verify your (?:email|account)[:\s]+(https?:\/\/[^\s]+)/i,
                /click (?:here|this link)[:\s]+(https?:\/\/[^\s]+)/i,
                /<a[^>]+href=["']([^"']+(?:verify|confirm|activate)[^"']+)["']/i,
                // Spanish patterns
                /(https?:\/\/[^\s]+(?:verificar|confirmar|activar)[^\s]*)/i,
                /verifica tu (?:correo|cuenta)[:\s]+(https?:\/\/[^\s]+)/i,
                // French patterns
                /(https?:\/\/[^\s]+(?:vérifier|confirmer|activer)[^\s]*)/i,
                /vérifiez votre (?:email|compte)[:\s]+(https?:\/\/[^\s]+)/i,
                // German patterns
                /(https?:\/\/[^\s]+(?:überprüfen|bestätigen|aktivieren)[^\s]*)/i,
                /überprüfen sie ihr (?:email|konto)[:\s]+(https?:\/\/[^\s]+)/i,
                // Italian patterns
                /(https?:\/\/[^\s]+(?:verificare|confermare|attivare)[^\s]*)/i,
                /verifica il tuo (?:email|account)[:\s]+(https?:\/\/[^\s]+)/i,
                // Portuguese patterns
                /(https?:\/\/[^\s]+(?:verificar|confirmar|ativar)[^\s]*)/i,
                /verifique seu (?:email|conta)[:\s]+(https?:\/\/[^\s]+)/i,
                // Dutch patterns
                /(https?:\/\/[^\s]+(?:verifiëren|bevestigen|activeren)[^\s]*)/i,
                /verifieer uw (?:email|account)[:\s]+(https?:\/\/[^\s]+)/i,
            ]
        };
    }

    setAgent(agent) {
        this.agent = agent;
    }

    async initialize() {
        if (this.emailPlugin) {
            return;
        }
        try {
            // Get email plugin from agent's API manager
            if (this.agent?.apiManager) {
                this.emailPlugin = this.agent.apiManager.getPlugin('email');
                if (!this.emailPlugin) {
                    logger.warn('Email plugin not available for verification checks');
                }
            } else {
                logger.warn('Agent API manager not available');
            }
        } catch (error) {
            logger.error('Failed to initialize email service:', error);
        }
    }

    /**
     * Get cached data or fetch and cache it
     */
    async getCachedData(key, fetchFunc) {
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            logger.debug(`Email search cache hit for key: ${key.substring(0, 50)}...`);
            return cached;
        }
        const data = await fetchFunc();
        this.cache.set(key, data);
        return data;
    }

    /**
     * Check for verification emails
     */
    async checkForVerification(emailAddress, serviceName) {
        if (!this.emailPlugin) {
            await this.initialize();
            if (!this.emailPlugin) {
                throw new Error('Email plugin not available');
            }
        }

        try {
            // Search for emails from the service
            const searchQuery = `from:${serviceName} to:${emailAddress} subject:(verify OR confirm OR activate)`;
            const emails = await this.getCachedData(searchQuery, async () => {
                return await retryOperation(async () => {
                    return await this.emailPlugin.execute({
                        action: 'search',
                        query: searchQuery,
                        limit: 10
                    });
                });
            });

            if (!emails || emails.length === 0) {
                return null;
            }

            // Check most recent email first
            for (const email of emails) {
                const verificationData = this.extractVerificationData(email);
                if (verificationData) {
                    logger.info(`Found verification data for ${serviceName}`);
                    return verificationData;
                }
            }

            return null;
        } catch (error) {
            logger.error('Failed to check verification email:', error);
            return null;
        }
    }

    /**
     * Extract verification code or link from email
     */
    extractVerificationData(email) {
        const content = email.body || email.text || '';
        const htmlContent = email.html || '';
        
        const result = {
            code: null,
            link: null,
            emailId: email.id,
            subject: email.subject,
            from: email.from,
            date: email.date
        };

        // Check for verification code
        for (const pattern of this.verificationPatterns.code) {
            const match = content.match(pattern);
            if (match && match[1]) {
                result.code = match[1];
                break;
            }
        }

        // Check for verification link
        const combinedContent = content + ' ' + htmlContent;
        for (const pattern of this.verificationPatterns.link) {
            const match = combinedContent.match(pattern);
            if (match && match[1]) {
                result.link = match[1];
                // Clean up HTML entities
                result.link = result.link.replace(/&amp;/g, '&');
                break;
            }
        }

        // Return null if no verification data found
        if (!result.code && !result.link) {
            return null;
        }

        return result;
    }

    /**
     * Send email (for testing or notifications)
     */
    async sendEmail(to, subject, body, options = {}) {
        if (!this.emailPlugin) {
            await this.initialize();
            if (!this.emailPlugin) {
                throw new Error('Email plugin not available');
            }
        }

        try {
            const result = await retryOperation(async () => {
                return await this.emailPlugin.execute({
                    action: 'send',
                    to,
                    subject,
                    body,
                    ...options
                });
            });

            logger.info(`Email sent to ${to}: ${subject}`);
            return result;
        } catch (error) {
            logger.error('Failed to send email:', error);
            throw error;
        }
    }

    /**
     * Mark email as read
     */
    async markAsRead(emailId) {
        if (!this.emailPlugin) {
            await this.initialize();
            if (!this.emailPlugin) {
                return;
            }
        }

        try {
            await retryOperation(async () => {
                await this.emailPlugin.execute({
                    action: 'markAsRead',
                    emailId
                });
            });
        } catch (error) {
            logger.warn('Failed to mark email as read:', error);
        }
    }

    /**
     * Delete email
     */
    async deleteEmail(emailId) {
        if (!this.emailPlugin) {
            await this.initialize();
            if (!this.emailPlugin) {
                return;
            }
        }

        try {
            await retryOperation(async () => {
                await this.emailPlugin.execute({
                    action: 'delete',
                    emailId
                });
            });
        } catch (error) {
            logger.warn('Failed to delete email:', error);
        }
    }

    /**
     * Get email configuration for agent
     */
    getAgentEmailConfig() {
        const domain = process.env.AGENT_EMAIL_DOMAIN || 'example.com';
        const baseEmail = process.env.AGENT_EMAIL || `lanagent@${domain}`;
        
        return {
            domain,
            baseEmail,
            canUsePlusAddressing: baseEmail.includes('@gmail.com') || baseEmail.includes('@outlook.com')
        };
    }

    /**
     * Generate unique email for service
     */
    generateServiceEmail(serviceName) {
        const config = this.getAgentEmailConfig();
        const timestamp = Date.now();
        
        if (config.canUsePlusAddressing) {
            const [localPart, domain] = config.baseEmail.split('@');
            return `${localPart}+${serviceName}_${timestamp}@${domain}`;
        } else {
            // Use subdomain addressing if available
            return `lanagent-${serviceName}-${timestamp}@${config.domain}`;
        }
    }
}

export default new EmailService();