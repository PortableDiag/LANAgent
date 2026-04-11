import QRCode from 'qrcode';
import { logger } from '../../utils/logger.js';
import walletService from './walletService.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';

// Common donation addresses for different chains
const DONATION_PRESETS = {
    ethereum: {
        USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        DAI: '0x6b175474e89094c44da98b954eedeac495271d0f'
    },
    eth: {
        USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        DAI: '0x6b175474e89094c44da98b954eedeac495271d0f'
    },
    bsc: {
        BUSD: '0xe9e7cea3dedca5984780bafc599bd69add087d56',
        USDT: '0x55d398326f99059ff775485246999027b3197955',
        USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
    },
    polygon: {
        USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
        USDC: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
        DAI: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063'
    },
    bitcoin: {},
    btc: {}
};

// Donation amounts in USD
const SUGGESTED_AMOUNTS = [5, 10, 25, 50, 100, 250];

class DonationService {
    constructor() {
        this.qrCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
    }

    /**
     * Generate QR code for donation address
     */
    async generateQRCode(address, options = {}) {
        const {
            size = 256,
            format = 'png',
            network = 'ethereum',
            amount = null,
            message = null
        } = options;

        const cacheKey = `${address}-${size}-${format}-${amount}`;
        
        // Check cache
        if (this.qrCache.has(cacheKey)) {
            return this.qrCache.get(cacheKey);
        }

        try {
            // Build payment URI if amount specified
            let qrData = address;
            if (amount) {
                // Create EIP-681 payment request for Ethereum
                if (network === 'ethereum' || network === 'bsc' || network === 'polygon') {
                    qrData = `ethereum:${address}?value=${amount}`;
                    if (message) {
                        qrData += `&message=${encodeURIComponent(message)}`;
                    }
                }
            }

            // Generate QR code
            const qrOptions = {
                type: format === 'png' ? 'png' : 'svg',
                width: size,
                margin: 1,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                },
                errorCorrectionLevel: 'M'
            };

            let qrCode;
            if (format === 'png') {
                // Generate as data URL
                qrCode = await QRCode.toDataURL(qrData, qrOptions);
            } else if (format === 'svg') {
                // Generate as SVG string
                qrCode = await QRCode.toString(qrData, { ...qrOptions, type: 'svg' });
            } else {
                // Generate as buffer
                qrCode = await QRCode.toBuffer(qrData, qrOptions);
            }

            // Cache the result (NodeCache handles TTL-based expiry automatically)
            this.qrCache.set(cacheKey, qrCode);

            return qrCode;
        } catch (error) {
            logger.error('Failed to generate QR code:', error);
            throw error;
        }
    }

    /**
     * Get donation addresses for all networks
     */
    async getDonationAddresses() {
        const wallet = await retryOperation(() => walletService.getWallet(), { retries: 3 });
        if (!wallet) {
            throw new Error('Wallet not initialized');
        }

        const addresses = {};
        
        // Map wallet addresses to donation info
        wallet.addresses.forEach(addr => {
            // Use 'chain' property from wallet addresses
            let network = addr.chain || addr.network;
            let displayName = addr.name || (network.charAt(0).toUpperCase() + network.slice(1));
            
            addresses[network] = {
                address: addr.address,
                network: network,
                displayName: displayName,
                chainId: this.getChainId(network),
                nativeCurrency: this.getNativeCurrency(network),
                tokens: DONATION_PRESETS[network] || {}
            };
        });

        return addresses;
    }

    /**
     * Create donation widget configuration
     */
    async createDonationWidget(options = {}) {
        const {
            networks = ['ethereum', 'bsc', 'polygon'],
            showQR = true,
            showAmounts = true,
            customAmounts = null,
            theme = 'dark',
            title = 'Support Development',
            description = 'Your donation helps maintain and improve this project'
        } = options;

        const addresses = await this.getDonationAddresses();
        
        // Filter to requested networks with mapping
        const networkMap = {
            'ethereum': 'eth',
            'bitcoin': 'btc',
            'eth': 'eth',
            'btc': 'btc',
            'bsc': 'bsc',
            'polygon': 'polygon'
        };
        
        const enabledAddresses = {};
        networks.forEach(requestedNetwork => {
            const walletNetwork = networkMap[requestedNetwork] || requestedNetwork;
            if (addresses[walletNetwork]) {
                // Use the requested network name as key for consistency
                enabledAddresses[requestedNetwork] = addresses[walletNetwork];
            }
        });

        // Generate QR codes if requested
        if (showQR) {
            for (const [network, info] of Object.entries(enabledAddresses)) {
                try {
                    info.qrCode = await this.generateQRCode(info.address, {
                        network,
                        format: 'png',
                        size: 200
                    });
                } catch (error) {
                    logger.warn(`Failed to generate QR for ${network}:`, error);
                }
            }
        }

        return {
            title,
            description,
            addresses: enabledAddresses,
            suggestedAmounts: customAmounts || SUGGESTED_AMOUNTS,
            showAmounts,
            showQR,
            theme,
            generatedAt: Date.now()
        };
    }

    /**
     * Generate payment links for various wallets
     */
    generatePaymentLinks(address, network, amount = null) {
        const links = {};

        // MetaMask / Web3 wallet link
        if (amount) {
            links.web3 = `ethereum:${address}?value=${amount}`;
        } else {
            links.web3 = `ethereum:${address}`;
        }

        // Trust Wallet
        links.trust = `https://link.trustwallet.com/send?address=${address}&asset=c${this.getChainId(network)}`;

        // Blockchain explorers
        switch (network) {
            case 'ethereum':
                links.explorer = `https://etherscan.io/address/${address}`;
                break;
            case 'bsc':
                links.explorer = `https://bscscan.com/address/${address}`;
                break;
            case 'polygon':
                links.explorer = `https://polygonscan.com/address/${address}`;
                break;
        }

        return links;
    }

    /**
     * Track donation (for analytics)
     */
    async trackDonation(network, address, amount, currency) {
        try {
            logger.info('Donation initiated:', {
                network,
                address: address.substring(0, 10) + '...',
                amount,
                currency,
                timestamp: new Date()
            });
            
            // Could integrate with analytics service here
            
            return true;
        } catch (error) {
            logger.error('Failed to track donation:', error);
            return false;
        }
    }

    /**
     * Get chain ID for network
     */
    getChainId(network) {
        const chainIds = {
            ethereum: 1,
            eth: 1,
            bsc: 56,
            polygon: 137,
            bitcoin: null,
            btc: null
        };
        return chainIds[network] || null;
    }

    /**
     * Get native currency for network
     */
    getNativeCurrency(network) {
        const currencies = {
            ethereum: { symbol: 'ETH', name: 'Ether' },
            eth: { symbol: 'ETH', name: 'Ether' },
            bsc: { symbol: 'BNB', name: 'BNB' },
            polygon: { symbol: 'MATIC', name: 'Matic' },
            bitcoin: { symbol: 'BTC', name: 'Bitcoin' },
            btc: { symbol: 'BTC', name: 'Bitcoin' }
        };
        return currencies[network] || { symbol: '?', name: 'Unknown' };
    }

    /**
     * Generate donation page HTML
     */
    async generateDonationHTML(options = {}) {
        const widget = await this.createDonationWidget(options);
        
        let html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${widget.title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: ${widget.theme === 'dark' ? '#1a1a1a' : '#ffffff'};
            color: ${widget.theme === 'dark' ? '#ffffff' : '#000000'};
            padding: 20px;
            max-width: 600px;
            margin: 0 auto;
        }
        .donation-container {
            background: ${widget.theme === 'dark' ? '#2a2a2a' : '#f5f5f5'};
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        h1 { margin-top: 0; }
        .network-section {
            margin: 20px 0;
            padding: 20px;
            background: ${widget.theme === 'dark' ? '#333333' : '#ffffff'};
            border-radius: 8px;
        }
        .address-container {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 10px 0;
        }
        .address {
            font-family: monospace;
            background: ${widget.theme === 'dark' ? '#1a1a1a' : '#f0f0f0'};
            padding: 10px;
            border-radius: 4px;
            word-break: break-all;
            flex: 1;
        }
        .copy-button {
            background: #0078d4;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
        }
        .copy-button:hover { background: #006bb3; }
        .qr-code {
            text-align: center;
            margin: 20px 0;
        }
        .qr-code img {
            border: 2px solid ${widget.theme === 'dark' ? '#ffffff' : '#000000'};
            border-radius: 8px;
            padding: 10px;
            background: white;
        }
        .amounts {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin: 15px 0;
        }
        .amount-button {
            background: ${widget.theme === 'dark' ? '#444444' : '#e0e0e0'};
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
        }
        .amount-button:hover {
            background: #0078d4;
            color: white;
        }
    </style>
</head>
<body>
    <div class="donation-container">
        <h1>${widget.title}</h1>
        <p>${widget.description}</p>
        `;
        
        for (const [network, info] of Object.entries(widget.addresses)) {
            html += `
        <div class="network-section">
            <h2>${info.displayName}</h2>
            <div class="address-container">
                <div class="address" id="${network}-address">${info.address}</div>
                <button class="copy-button" onclick="copyAddress('${network}')">Copy</button>
            </div>
            `;
            
            if (widget.showQR && info.qrCode) {
                html += `
            <div class="qr-code">
                <img src="${info.qrCode}" alt="${info.displayName} QR Code" />
            </div>
                `;
            }
            
            if (widget.showAmounts) {
                html += `
            <div class="amounts">
                ${widget.suggestedAmounts.map(amount => 
                    `<button class="amount-button" onclick="donate('${network}', ${amount})">$${amount}</button>`
                ).join('')}
            </div>
                `;
            }
            
            html += '</div>';
        }
        
        html += `
    </div>
    <script>
        function copyAddress(network) {
            const address = document.getElementById(network + '-address').textContent;
            navigator.clipboard.writeText(address).then(() => {
                alert('Address copied to clipboard!');
            });
        }
        
        function donate(network, amount) {
            alert('Please send $' + amount + ' worth of tokens to the ' + network + ' address shown above.');
        }
    </script>
</body>
</html>
        `;
        
        return html;
    }
}

export default new DonationService();