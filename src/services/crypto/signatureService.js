import { ethers } from 'ethers';
import { logger } from '../../utils/logger.js';
import walletService from './walletService.js';
import { retryOperation } from '../../utils/retryUtils.js';

// EIP-712 Domain Separator
const EIP712_DOMAIN = {
    name: 'LANAgent',
    version: '1',
    chainId: 1,
    verifyingContract: '0x0000000000000000000000000000000000000000'
};

// Common message types
const MESSAGE_TYPES = {
    SIWE: 'Sign-In with Ethereum',
    TRANSACTION: 'Transaction Authorization',
    CONTRACT: 'Contract Interaction',
    ATTESTATION: 'Data Attestation',
    CUSTOM: 'Custom Message'
};

class SignatureService {
    constructor() {
        this.signingRequests = new Map();
        this.verifiedSignatures = new Map();
    }

    /**
     * Sign a batch of plain text messages (EIP-191)
     */
    async signMessagesBatch(messages, options = {}) {
        const results = [];
        for (const message of messages) {
            const result = await retryOperation(() => this.signMessage(message, options), { retries: 3 });
            results.push(result);
        }
        return results;
    }

    /**
     * Sign a batch of typed data (EIP-712)
     */
    async signTypedDataBatch(domains, typesArray, values, options = {}) {
        const results = [];
        for (let i = 0; i < values.length; i++) {
            const result = await retryOperation(() => this.signTypedData(domains[i], typesArray[i], values[i], options), { retries: 3 });
            results.push(result);
        }
        return results;
    }

    /**
     * Verify a batch of message signatures
     */
    async verifySignaturesBatch(messages, signatures, expectedAddresses = []) {
        const results = [];
        for (let i = 0; i < messages.length; i++) {
            const result = await retryOperation(() => this.verifySignature(messages[i], signatures[i], expectedAddresses[i]), { retries: 3 });
            results.push(result);
        }
        return results;
    }

    /**
     * Verify a batch of typed data signatures
     */
    async verifyTypedDataSignaturesBatch(domains, typesArray, values, signatures, expectedAddresses = []) {
        const results = [];
        for (let i = 0; i < values.length; i++) {
            const result = await retryOperation(() => this.verifyTypedDataSignature(domains[i], typesArray[i], values[i], signatures[i], expectedAddresses[i]), { retries: 3 });
            results.push(result);
        }
        return results;
    }

    /**
     * Sign a plain text message (EIP-191)
     */
    async signMessage(message, options = {}) {
        try {
            const wallet = await walletService.getWallet();
            if (!wallet) {
                throw new Error('Wallet not initialized');
            }

            const { network = 'ethereum', purpose = MESSAGE_TYPES.CUSTOM } = options;
            
            // Get the appropriate signer
            const signer = walletService.getSigner(network);
            if (!signer) {
                throw new Error(`No signer available for network: ${network}`);
            }

            // Create prefixed message
            const prefixedMessage = this.createPrefixedMessage(message);
            
            // Sign the message
            const signature = await signer.signMessage(message);
            
            // Get signer address
            const address = await signer.getAddress();
            
            // Store signing record
            const record = {
                message,
                prefixedMessage,
                signature,
                address,
                network,
                purpose,
                timestamp: Date.now()
            };
            
            const recordId = this.generateRecordId(address, message);
            this.signingRequests.set(recordId, record);
            
            logger.info('Message signed:', {
                address: address.substring(0, 10) + '...',
                purpose,
                network
            });
            
            return {
                signature,
                address,
                messageHash: ethers.utils.hashMessage(message)
            };
        } catch (error) {
            logger.error('Failed to sign message:', error);
            throw error;
        }
    }

    /**
     * Sign typed data (EIP-712)
     */
    async signTypedData(domain, types, value, options = {}) {
        try {
            const wallet = await walletService.getWallet();
            if (!wallet) {
                throw new Error('Wallet not initialized');
            }

            const { network = 'ethereum' } = options;
            
            // Get the appropriate signer
            const signer = walletService.getSigner(network);
            if (!signer) {
                throw new Error(`No signer available for network: ${network}`);
            }

            // Use provided domain or default
            const signingDomain = domain || { ...EIP712_DOMAIN, chainId: this.getChainId(network) };
            
            // Sign typed data
            const signature = await signer._signTypedData(signingDomain, types, value);
            
            // Get signer address
            const address = await signer.getAddress();
            
            // Store signing record
            const record = {
                domain: signingDomain,
                types,
                value,
                signature,
                address,
                network,
                timestamp: Date.now()
            };
            
            const recordId = this.generateRecordId(address, JSON.stringify(value));
            this.signingRequests.set(recordId, record);
            
            logger.info('Typed data signed:', {
                address: address.substring(0, 10) + '...',
                network
            });
            
            return {
                signature,
                address,
                domain: signingDomain
            };
        } catch (error) {
            logger.error('Failed to sign typed data:', error);
            throw error;
        }
    }

    /**
     * Create SIWE (Sign-In with Ethereum) message
     */
    createSIWEMessage(params) {
        const {
            domain,
            address,
            statement = 'Sign in with Ethereum to LANAgent',
            uri,
            version = '1',
            chainId = 1,
            nonce,
            issuedAt = new Date().toISOString(),
            expirationTime,
            notBefore,
            requestId,
            resources = []
        } = params;

        let message = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n`;
        message += `${statement}\n\n`;
        message += `URI: ${uri}\n`;
        message += `Version: ${version}\n`;
        message += `Chain ID: ${chainId}\n`;
        message += `Nonce: ${nonce}\n`;
        message += `Issued At: ${issuedAt}`;
        
        if (expirationTime) {
            message += `\nExpiration Time: ${expirationTime}`;
        }
        
        if (notBefore) {
            message += `\nNot Before: ${notBefore}`;
        }
        
        if (requestId) {
            message += `\nRequest ID: ${requestId}`;
        }
        
        if (resources.length > 0) {
            message += `\nResources:`;
            resources.forEach(resource => {
                message += `\n- ${resource}`;
            });
        }

        return message;
    }

    /**
     * Sign SIWE message
     */
    async signSIWE(params) {
        try {
            const wallet = await walletService.getWallet();
            if (!wallet) {
                throw new Error('Wallet not initialized');
            }

            // Generate nonce if not provided
            if (!params.nonce) {
                params.nonce = this.generateNonce();
            }

            // Set address
            const signer = walletService.getSigner('ethereum');
            params.address = await signer.getAddress();

            // Create SIWE message
            const message = this.createSIWEMessage(params);
            
            // Sign the message
            const result = await this.signMessage(message, {
                purpose: MESSAGE_TYPES.SIWE,
                network: 'ethereum'
            });

            return {
                message,
                signature: result.signature,
                address: result.address,
                siweParams: params
            };
        } catch (error) {
            logger.error('Failed to sign SIWE message:', error);
            throw error;
        }
    }

    /**
     * Verify message signature
     */
    async verifySignature(message, signature, expectedAddress = null) {
        try {
            // Recover signer address
            const recoveredAddress = ethers.utils.verifyMessage(message, signature);
            
            // Check if matches expected address
            const isValid = expectedAddress 
                ? recoveredAddress.toLowerCase() === expectedAddress.toLowerCase()
                : true;
            
            // Store verification record
            const record = {
                message,
                signature,
                recoveredAddress,
                expectedAddress,
                isValid,
                timestamp: Date.now()
            };
            
            const recordId = this.generateRecordId(recoveredAddress, message);
            this.verifiedSignatures.set(recordId, record);
            
            return {
                isValid,
                recoveredAddress,
                messageHash: ethers.utils.hashMessage(message)
            };
        } catch (error) {
            logger.error('Failed to verify signature:', error);
            return {
                isValid: false,
                error: error.message
            };
        }
    }

    /**
     * Verify typed data signature
     */
    async verifyTypedDataSignature(domain, types, value, signature, expectedAddress = null) {
        try {
            // Recover signer address
            const recoveredAddress = ethers.utils.verifyTypedData(
                domain,
                types,
                value,
                signature
            );
            
            // Check if matches expected address
            const isValid = expectedAddress 
                ? recoveredAddress.toLowerCase() === expectedAddress.toLowerCase()
                : true;
            
            return {
                isValid,
                recoveredAddress
            };
        } catch (error) {
            logger.error('Failed to verify typed data signature:', error);
            return {
                isValid: false,
                error: error.message
            };
        }
    }

    /**
     * Create multi-signature request
     */
    async createMultiSigRequest(params) {
        const {
            message,
            requiredSignatures = 2,
            signers = [],
            expirationTime = Date.now() + 24 * 60 * 60 * 1000, // 24 hours
            metadata = {}
        } = params;

        const requestId = this.generateNonce();
        
        const multiSigRequest = {
            id: requestId,
            message,
            requiredSignatures,
            signers: signers.map(s => s.toLowerCase()),
            signatures: new Map(),
            expirationTime,
            metadata,
            createdAt: Date.now(),
            status: 'pending'
        };
        
        this.signingRequests.set(requestId, multiSigRequest);
        
        return {
            requestId,
            message,
            requiredSignatures,
            signers
        };
    }

    /**
     * Add signature to multi-sig request
     */
    async addMultiSigSignature(requestId, signature, signerAddress) {
        const request = this.signingRequests.get(requestId);
        if (!request || request.status !== 'pending') {
            throw new Error('Invalid or completed multi-sig request');
        }

        // Check if expired
        if (Date.now() > request.expirationTime) {
            request.status = 'expired';
            throw new Error('Multi-sig request has expired');
        }

        // Verify the signature
        const verification = await this.verifySignature(
            request.message,
            signature,
            signerAddress
        );

        if (!verification.isValid) {
            throw new Error('Invalid signature');
        }

        // Check if signer is authorized
        if (!request.signers.includes(signerAddress.toLowerCase())) {
            throw new Error('Signer not authorized for this request');
        }

        // Add signature
        request.signatures.set(signerAddress.toLowerCase(), signature);

        // Check if we have enough signatures
        if (request.signatures.size >= request.requiredSignatures) {
            request.status = 'completed';
            request.completedAt = Date.now();
        }

        return {
            requestId,
            signaturesCollected: request.signatures.size,
            requiredSignatures: request.requiredSignatures,
            status: request.status
        };
    }

    /**
     * Create prefixed message for EIP-191
     */
    createPrefixedMessage(message) {
        return `\x19Ethereum Signed Message:\n${message.length}${message}`;
    }

    /**
     * Generate nonce
     */
    generateNonce(length = 16) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < length; i++) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }

    /**
     * Generate record ID
     */
    generateRecordId(address, message) {
        return ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ['address', 'string'],
                [address, message]
            )
        );
    }

    /**
     * Get chain ID for network
     */
    getChainId(network) {
        const chainIds = {
            ethereum: 1,
            bsc: 56,
            polygon: 137,
            bitcoin: null
        };
        return chainIds[network] || 1;
    }

    /**
     * Get signing history
     */
    getSigningHistory(address = null) {
        const history = [];
        
        for (const [id, record] of this.signingRequests) {
            if (!address || record.address?.toLowerCase() === address.toLowerCase()) {
                history.push({
                    id,
                    ...record,
                    signature: record.signature?.substring(0, 20) + '...' // Truncate for display
                });
            }
        }
        
        return history.sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Export signature for sharing
     */
    exportSignature(signature, message, metadata = {}) {
        return {
            signature,
            message,
            metadata,
            exportedAt: Date.now(),
            version: '1.0'
        };
    }

    /**
     * Create signature proof
     */
    async createSignatureProof(signature, message, options = {}) {
        const verification = await this.verifySignature(message, signature);
        
        if (!verification.isValid) {
            throw new Error('Invalid signature');
        }

        return {
            signature,
            message,
            signer: verification.recoveredAddress,
            messageHash: verification.messageHash,
            timestamp: Date.now(),
            ...options
        };
    }
}

export default new SignatureService();