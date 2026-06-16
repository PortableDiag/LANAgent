import { BasePlugin } from '../core/basePlugin.js';
import contractService from '../../services/crypto/contractService.js';
import transactionService from '../../services/crypto/transactionService.js';
import walletService from '../../services/crypto/walletService.js';
import faucetService from '../../services/crypto/faucetService.js';

let ethersLib = null;
async function getEthers() {
    if (!ethersLib) {
        ethersLib = await import('ethers');
    }
    return ethersLib;
}

export default class ContractCommandsPlugin extends BasePlugin {
    constructor(agent) {
        super(agent);
        this.name = 'contractCommands';
        this.version = '1.0.0';
        this.description = 'Smart contract interaction commands for crypto operations';

        this.commands = [
            {
                command: 'readContract',
                description: 'Read data from a smart contract',
                usage: 'readContract({ address: "0x...", method: "balanceOf", params: ["0x..."], network: "ethereum" })',
                examples: [
                    'read contract 0x... method balanceOf',
                    'call totalSupply on contract 0x...',
                    'get owner of contract 0x... on bsc',
                    'check contract name at 0x...'
                ]
            },
            {
                command: 'writeContract',
                description: 'Write data to a smart contract (sends transaction)',
                usage: 'writeContract({ address: "0x...", method: "transfer", params: ["0x...", "1000"], network: "ethereum" })',
                examples: [
                    'call approve on contract 0x...',
                    'execute transfer on 0x...',
                    'send transaction to contract 0x...'
                ]
            },
            {
                command: 'contractEvents',
                description: 'Monitor contract events',
                usage: 'contractEvents({ address: "0x...", event: "Transfer", blocks: 100, network: "ethereum" })',
                examples: [
                    'get events from contract 0x...',
                    'show Transfer events for 0x...',
                    'monitor events on contract 0x... last 100 blocks'
                ]
            },
            {
                command: 'tokenBalance',
                description: 'Check ERC-20 token balance',
                usage: 'tokenBalance({ token: "0x...", address: "0x...", network: "ethereum" })',
                examples: [
                    'check token balance for 0x...',
                    'how many tokens do I have at 0x...',
                    'get my USDT balance on bsc'
                ]
            },
            {
                command: 'tokenTransfer',
                description: 'Transfer ERC-20 tokens',
                usage: 'tokenTransfer({ token: "0x...", to: "0x...", amount: "100", network: "ethereum" })',
                examples: [
                    'transfer 100 tokens from 0x... to 0x...',
                    'send USDT to 0x...',
                    'move tokens to address 0x...'
                ]
            },
            {
                command: 'nftInfo',
                description: 'Get NFT information',
                usage: 'nftInfo({ address: "0x...", tokenId: "1", network: "ethereum" })',
                examples: [
                    'get NFT info for token 1 at 0x...',
                    'show NFT details for 0x... token 42',
                    'who owns NFT 5 at 0x...'
                ]
            },
            {
                command: 'estimateGas',
                description: 'Estimate gas for a transaction',
                usage: 'estimateGas({ to: "0x...", value: "0.1", data: "0x", network: "ethereum" })',
                examples: [
                    'estimate gas for sending 0.1 ETH to 0x...',
                    'how much gas to call contract 0x...',
                    'gas estimate for transaction to 0x...'
                ]
            },
            {
                command: 'faucetClaim',
                description: 'Claim from testnet faucet',
                usage: 'faucetClaim({ network: "sepolia" })',
                examples: [
                    'claim from sepolia faucet',
                    'get testnet tokens',
                    'faucet claim for mumbai'
                ]
            },
            {
                command: 'verifyContract',
                description: 'Verify contract source code on-chain',
                usage: 'verifyContract({ address: "0x...", network: "ethereum" })',
                examples: [
                    'verify contract at 0x...',
                    'check if contract 0x... is verified',
                    'contract verification for 0x...'
                ]
            }
        ];

        this.config = {
            defaultNetwork: 'ethereum',
            maxGasPrice: '100',
            confirmTransactions: true,
            simulateFirst: true
        };

        this.initialized = false;
    }

    async initialize() {
        this.logger.info(`Initializing ${this.name} plugin...`);

        try {
            if (!contractService) {
                throw new Error('Contract service not available');
            }
            if (!transactionService) {
                throw new Error('Transaction service not available');
            }
            if (!walletService) {
                throw new Error('Wallet service not available');
            }

            this.initialized = true;
            this.logger.info(`${this.name} plugin initialized successfully`);
        } catch (error) {
            this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
            throw error;
        }
    }

    async execute(params) {
        const { action, ...data } = params;

        this.validateParams(params, {
            action: {
                required: true,
                type: 'string',
                enum: this.commands.map(c => c.command)
            }
        });

        if (params.needsParameterExtraction && this.agent.providerManager) {
            const extracted = await this.extractParameters(params.originalInput || params.input, action);
            Object.assign(data, extracted);
        }

        try {
            switch (action) {
                case 'readContract':
                    return await this.readContract(data);
                case 'writeContract':
                    return await this.writeContract(data);
                case 'contractEvents':
                    return await this.monitorEvents(data);
                case 'tokenBalance':
                    return await this.checkTokenBalance(data);
                case 'tokenTransfer':
                    return await this.transferToken(data);
                case 'nftInfo':
                    return await this.getNFTInfo(data);
                case 'estimateGas':
                    return await this.estimateGas(data);
                case 'faucetClaim':
                    return await this.claimFaucet(data);
                case 'verifyContract':
                    return await this.verifyContract(data);
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        } catch (error) {
            this.logger.error(`${action} failed:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async readContract(params) {
        const { address, method, params: methodParams, network = this.config.defaultNetwork } = params;
        if (!address) throw new Error('Contract address is required');
        if (!method) throw new Error('Method name is required');

        const parsedParams = typeof methodParams === 'string' ? JSON.parse(methodParams) : (methodParams || []);

        this.logger.info(`Reading from contract ${address} on ${network}`);

        const result = await contractService.readContract(
            address, method, parsedParams, { network }
        );

        return {
            success: true,
            data: {
                contract: address,
                method,
                result,
                network
            }
        };
    }

    async writeContract(params) {
        const ethers = await getEthers();
        const { address, method, params: methodParams, value, network = this.config.defaultNetwork } = params;
        if (!address) throw new Error('Contract address is required');
        if (!method) throw new Error('Method name is required');

        const parsedParams = typeof methodParams === 'string' ? JSON.parse(methodParams) : (methodParams || []);
        const txValue = value ? ethers.parseEther(value) : '0';

        this.logger.info(`Writing to contract ${address} on ${network}`);

        const result = await contractService.writeContract(
            address, method, parsedParams, { network, value: txValue }
        );

        if (result.hash) {
            await transactionService.waitForConfirmation(result.hash, network);
        }

        return {
            success: true,
            data: {
                contract: address,
                method,
                txHash: result.hash,
                network
            }
        };
    }

    async monitorEvents(params) {
        const { address, event, blocks = 100, network = this.config.defaultNetwork } = params;
        if (!address) throw new Error('Contract address is required');

        this.logger.info(`Monitoring events for ${address} on ${network}`);

        const events = await contractService.getContractEvents(
            address, event, parseInt(blocks), { network }
        );

        return {
            success: true,
            data: {
                contract: address,
                eventCount: events.length,
                events: events.slice(0, 10),
                network
            }
        };
    }

    async checkTokenBalance(params) {
        const ethers = await getEthers();
        const { token, address, network = this.config.defaultNetwork } = params;
        if (!token) throw new Error('Token contract address is required');

        const wallet = await walletService.getWallet();
        const targetAddress = address || wallet.addresses.find(a => a.network === network)?.address;

        if (!targetAddress) {
            throw new Error('No address specified or found for network');
        }

        this.logger.info(`Checking token balance for ${targetAddress} on ${network}`);

        const tokenInfo = await contractService.getTokenInfo(token, { network });
        const balance = await contractService.readContract(
            token, 'balanceOf', [targetAddress], { network }
        );

        const formattedBalance = ethers.formatUnits(balance, tokenInfo.decimals);

        return {
            success: true,
            data: {
                token: tokenInfo.name,
                symbol: tokenInfo.symbol,
                balance: formattedBalance,
                rawBalance: balance.toString(),
                address: targetAddress,
                network
            }
        };
    }

    async transferToken(params) {
        const ethers = await getEthers();
        const { token, to, amount, network = this.config.defaultNetwork } = params;
        if (!token) throw new Error('Token contract address is required');
        if (!to) throw new Error('Recipient address is required');
        if (!amount) throw new Error('Amount is required');

        const tokenInfo = await contractService.getTokenInfo(token, network);
        const parsedAmount = ethers.parseUnits(amount, tokenInfo.decimals);

        this.logger.info(`Transferring ${amount} ${tokenInfo.symbol} to ${to} on ${network}`);

        const signer = await contractService.getSigner(network);
        const abi = ['function transfer(address to, uint256 amount) returns (bool)'];
        const contract = new ethers.Contract(token, abi, signer);
        const tx = await contract.transfer(to, parsedAmount);
        const receipt = await tx.wait();

        return {
            success: true,
            data: {
                token: tokenInfo.name,
                symbol: tokenInfo.symbol,
                amount,
                to,
                txHash: receipt.hash,
                network
            }
        };
    }

    async getNFTInfo(params) {
        const { address, tokenId, network = this.config.defaultNetwork } = params;
        if (!address) throw new Error('NFT contract address is required');
        if (!tokenId) throw new Error('Token ID is required');

        this.logger.info(`Getting NFT info for token ${tokenId} on ${network}`);

        const [name, symbol, owner, tokenURI] = await Promise.all([
            contractService.readContract(address, 'name', [], { network }),
            contractService.readContract(address, 'symbol', [], { network }),
            contractService.readContract(address, 'ownerOf', [tokenId], { network }),
            contractService.readContract(address, 'tokenURI', [tokenId], { network })
        ]);

        let metadata = null;
        if (tokenURI && tokenURI.startsWith('http')) {
            try {
                const response = await fetch(tokenURI);
                metadata = await response.json();
            } catch (e) {
                this.logger.warn('Failed to fetch NFT metadata:', e);
            }
        }

        return {
            success: true,
            data: {
                contract: address,
                tokenId,
                name,
                symbol,
                owner,
                tokenURI,
                metadata,
                network
            }
        };
    }

    async estimateGas(params) {
        const ethers = await getEthers();
        const { to, data, value, network = this.config.defaultNetwork } = params;
        if (!to) throw new Error('Recipient address is required');

        const txValue = value ? ethers.parseEther(value) : '0';

        this.logger.info(`Estimating gas for transaction on ${network}`);

        const gasEstimate = await transactionService.estimateGas({
            to,
            data: data || '0x',
            value: txValue
        }, network);

        const provider = contractService.getProvider(network);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice;

        const estimatedCost = gasEstimate * gasPrice;
        const estimatedCostETH = ethers.formatEther(estimatedCost);

        return {
            success: true,
            data: {
                gasLimit: gasEstimate.toString(),
                gasPrice: ethers.formatUnits(gasPrice, 'gwei') + ' Gwei',
                estimatedCost: estimatedCostETH + ' ETH',
                network
            }
        };
    }

    async claimFaucet(params) {
        const { network } = params;
        if (!network) throw new Error('Network is required');

        const addresses = await faucetService.getWalletAddresses();
        const address = addresses[network];

        if (!address) {
            return {
                success: false,
                error: `No wallet address found for network ${network}`
            };
        }

        this.logger.info(`Attempting to claim from ${network} faucet`);

        if (network === 'mumbai') {
            const result = await faucetService.claimFromMumbaiFaucet(address);
            return { success: true, data: result };
        } else {
            const instructions = await faucetService.generateFaucetInstructions(network);
            return {
                success: true,
                data: {
                    message: 'Manual claiming required',
                    address,
                    faucets: instructions.faucets
                }
            };
        }
    }

    async verifyContract(params) {
        const { address, network = this.config.defaultNetwork } = params;
        if (!address) throw new Error('Contract address is required');

        this.logger.info(`Verifying contract ${address} on ${network}`);

        const code = await contractService.getContractCode(address, { network });

        if (code === '0x') {
            return {
                success: false,
                error: 'No contract found at this address'
            };
        }

        const contractType = await contractService.identifyContractType(
            address, { network }
        );

        return {
            success: true,
            data: {
                address,
                hasCode: true,
                codeSize: (code.length - 2) / 2,
                contractType: contractType || 'Unknown',
                network
            }
        };
    }

    async extractParameters(input, action) {
        const prompt = `Extract parameters from: "${input}"
        For contractCommands plugin action: ${action}

        Based on the action type:
        - readContract: extract address (hex), method (string), params (array), network (string)
        - writeContract: extract address (hex), method (string), params (array), value (ETH amount), network
        - contractEvents: extract address (hex), event (string), blocks (number), network
        - tokenBalance: extract token (hex address), address (hex, optional), network
        - tokenTransfer: extract token (hex), to (hex), amount (string), network
        - nftInfo: extract address (hex), tokenId (string), network
        - estimateGas: extract to (hex), value (ETH amount), data (hex), network
        - faucetClaim: extract network (string)
        - verifyContract: extract address (hex), network

        Return JSON with appropriate parameters.`;

        const response = await this.agent.providerManager.generateResponse(prompt, {
            temperature: 0.3,
            maxTokens: 200
        });

        try {
            return JSON.parse(response.content);
        } catch (error) {
            this.logger.warn('Failed to parse AI parameters:', error);
            return {};
        }
    }

    async getAICapabilities() {
        return {
            enabled: true,
            examples: this.commands.flatMap(cmd => cmd.examples || [])
        };
    }

    async cleanup() {
        this.logger.info(`Cleaning up ${this.name} plugin...`);
        this.initialized = false;
    }

    getCommands() {
        return this.commands.reduce((acc, cmd) => {
            acc[cmd.command] = cmd.description;
            return acc;
        }, {});
    }
}
