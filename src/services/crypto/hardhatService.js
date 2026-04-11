import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { templates, getTemplate } from './contractTemplates.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { decrypt } from '../../utils/encryption.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class HardhatService {
    constructor() {
        this.projectsDir = path.join(process.cwd(), 'contracts');
        this.initialized = false;
        this._explorerApiKey = null;
    }

    /**
     * Get the explorer API key from DB (cached after first load).
     * Used to pass ETHERSCAN_API_KEY env var to hardhat subprocess.
     */
    async getExplorerApiKey() {
        if (this._explorerApiKey) return this._explorerApiKey;
        try {
            const stored = await PluginSettings.getCached('crypto', 'explorer_api_keys');
            if (stored?.bsc) {
                this._explorerApiKey = decrypt(stored.bsc);
                return this._explorerApiKey;
            }
        } catch (err) {
            logger.debug(`HardhatService: could not load explorer key: ${err.message}`);
        }
        return process.env.ETHERSCAN_API_KEY || null;
    }

    /**
     * Get env vars to pass to hardhat subprocesses (includes API keys).
     */
    async getHardhatEnv() {
        const apiKey = await this.getExplorerApiKey();
        return {
            ...process.env,
            ...(apiKey ? { ETHERSCAN_API_KEY: apiKey, BSCSCAN_API_KEY: apiKey } : {})
        };
    }

    /**
     * Initialize Hardhat service
     */
    async initialize() {
        try {
            // Create contracts directory if it doesn't exist
            await fs.mkdir(this.projectsDir, { recursive: true });
            
            // Check if Hardhat is installed globally
            try {
                await execAsync('npx hardhat --version');
                logger.info('Hardhat is available');
            } catch (error) {
                logger.info('Installing Hardhat...');
                await execAsync('npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox');
            }
            
            this.initialized = true;
            logger.info('Hardhat service initialized');
        } catch (error) {
            logger.error('Failed to initialize Hardhat service:', error);
            throw error;
        }
    }

    /**
     * Create a new Hardhat project
     */
    async createProject(projectName, template = 'basic') {
        if (!this.initialized) await this.initialize();
        
        const projectPath = path.join(this.projectsDir, projectName);
        
        try {
            // Create project directory
            await fs.mkdir(projectPath, { recursive: true });
            
            // Initialize Hardhat project
            const initCommand = template === 'basic' 
                ? 'npx hardhat init --no-interactive'
                : `npx hardhat init --template ${template}`;
                
            await execAsync(initCommand, { cwd: projectPath });
            
            // Create basic hardhat config
            const config = `
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: "0.8.19",
    networks: {
        hardhat: {
            chainId: 1337
        },
        sepolia: {
            url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
        },
        mumbai: {
            url: process.env.MUMBAI_RPC_URL || "https://rpc-mumbai.maticvigil.com",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
        },
        bscTestnet: {
            url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
        }
    },
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts"
    }
};
`;
            
            await fs.writeFile(path.join(projectPath, 'hardhat.config.js'), config);
            
            // Create contracts directory
            await fs.mkdir(path.join(projectPath, 'contracts'), { recursive: true });
            
            logger.info(`Created Hardhat project: ${projectName}`);
            return projectPath;
            
        } catch (error) {
            logger.error(`Failed to create project ${projectName}:`, error);
            throw error;
        }
    }

    /**
     * Compile contracts in a project
     */
    async compile(projectName) {
        const projectPath = path.join(this.projectsDir, projectName);
        
        try {
            const env = await this.getHardhatEnv();
            const { stdout, stderr } = await execAsync('npx hardhat compile', {
                cwd: projectPath, env
            });
            
            if (stderr && !stderr.includes('Warning')) {
                throw new Error(stderr);
            }
            
            logger.info(`Compiled contracts in ${projectName}`);
            
            // Get compilation artifacts
            const artifactsPath = path.join(projectPath, 'artifacts', 'contracts');
            const artifacts = await this.getArtifacts(artifactsPath);
            
            return {
                success: true,
                output: stdout,
                artifacts
            };
            
        } catch (error) {
            logger.error(`Compilation failed for ${projectName}:`, error);
            throw error;
        }
    }

    /**
     * Deploy a contract
     */
    async deploy(projectName, contractName, constructorArgs = [], network = 'hardhat') {
        const projectPath = path.join(this.projectsDir, projectName);
        
        try {
            // Create deployment script
            const deployScript = `
const hre = require("hardhat");

async function main() {
    const Contract = await hre.ethers.getContractFactory("${contractName}");
    const contract = await Contract.deploy(${constructorArgs.map(arg => JSON.stringify(arg)).join(', ')});
    await contract.waitForDeployment();
    
    const address = await contract.getAddress();
    console.log("Contract deployed to:", address);
    
    // Return deployment info as JSON
    console.log("DEPLOYMENT_INFO:" + JSON.stringify({
        address: address,
        contractName: "${contractName}",
        network: "${network}",
        timestamp: new Date().toISOString()
    }));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
`;
            
            const scriptPath = path.join(projectPath, 'scripts', 'deploy-temp.js');
            await fs.mkdir(path.dirname(scriptPath), { recursive: true });
            await fs.writeFile(scriptPath, deployScript);
            
            // Run deployment
            const env = await this.getHardhatEnv();
            const { stdout } = await execAsync(
                `npx hardhat run scripts/deploy-temp.js --network ${network}`,
                { cwd: projectPath, env }
            );
            
            // Parse deployment info
            const infoMatch = stdout.match(/DEPLOYMENT_INFO:(.+)/);
            const deploymentInfo = infoMatch ? JSON.parse(infoMatch[1]) : null;
            
            // Clean up temp script
            await fs.unlink(scriptPath);
            
            logger.info(`Deployed ${contractName} to ${deploymentInfo?.address}`);
            
            return deploymentInfo;
            
        } catch (error) {
            logger.error(`Deployment failed:`, error);
            throw error;
        }
    }

    /**
     * Run tests
     */
    async runTests(projectName, testFile = null) {
        const projectPath = path.join(this.projectsDir, projectName);
        
        try {
            const testCommand = testFile 
                ? `npx hardhat test test/${testFile}`
                : 'npx hardhat test';
                
            const env = await this.getHardhatEnv();
            const { stdout, stderr } = await execAsync(testCommand, {
                cwd: projectPath, env
            });
            
            logger.info(`Tests completed for ${projectName}`);
            
            return {
                success: !stderr || stderr.includes('passing'),
                output: stdout,
                errors: stderr
            };
            
        } catch (error) {
            logger.error(`Tests failed:`, error);
            throw error;
        }
    }

    /**
     * Create a contract from template
     */
    async createContract(projectName, contractName, template = 'basic', params = {}) {
        const projectPath = path.join(this.projectsDir, projectName);
        const contractPath = path.join(projectPath, 'contracts', `${contractName}.sol`);
        
        let contractCode;
        
        // Check if it's an advanced template
        const advancedTemplate = getTemplate(template);
        if (advancedTemplate) {
            contractCode = advancedTemplate.code(contractName, params);
        } else {
            // Use basic templates
            switch (template) {
                case 'erc20':
                    contractCode = this.getERC20Template(contractName);
                    break;
                case 'erc721':
                    contractCode = this.getERC721Template(contractName);
                    break;
                case 'basic':
                default:
                    contractCode = this.getBasicTemplate(contractName);
                    break;
            }
        }
        
        try {
            // Ensure OpenZeppelin is installed if needed
            if (contractCode.includes('@openzeppelin')) {
                await this.installOpenZeppelin(projectPath);
            }
            
            await fs.writeFile(contractPath, contractCode);
            logger.info(`Created contract ${contractName} in ${projectName}`);
            return contractPath;
        } catch (error) {
            logger.error(`Failed to create contract:`, error);
            throw error;
        }
    }
    
    /**
     * Install OpenZeppelin contracts
     */
    async installOpenZeppelin(projectPath) {
        try {
            await execAsync('npm install @openzeppelin/contracts', { cwd: projectPath });
            logger.info('OpenZeppelin contracts installed');
        } catch (error) {
            logger.debug('OpenZeppelin might already be installed');
        }
    }

    /**
     * Get contract templates
     */
    getBasicTemplate(name) {
        return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract ${name} {
    string public message;
    address public owner;
    
    event MessageChanged(string oldMessage, string newMessage);
    
    constructor(string memory _message) {
        message = _message;
        owner = msg.sender;
    }
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Not the owner");
        _;
    }
    
    function setMessage(string memory _message) public onlyOwner {
        string memory oldMessage = message;
        message = _message;
        emit MessageChanged(oldMessage, _message);
    }
    
    function getMessage() public view returns (string memory) {
        return message;
    }
}`;
    }

    getERC20Template(name) {
        return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ${name} is ERC20, ERC20Burnable, Ownable {
    constructor(string memory _name, string memory _symbol, uint256 _initialSupply) 
        ERC20(_name, _symbol) 
        Ownable(msg.sender)
    {
        _mint(msg.sender, _initialSupply * 10 ** decimals());
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }
}`;
    }

    getERC721Template(name) {
        return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ${name} is ERC721, ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    constructor(string memory _name, string memory _symbol) 
        ERC721(_name, _symbol) 
        Ownable(msg.sender)
    {}

    function safeMint(address to, string memory uri) public onlyOwner {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    // Required overrides
    function tokenURI(uint256 tokenId) public view override(ERC721, ERC721URIStorage) 
        returns (string memory) 
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC721URIStorage) 
        returns (bool) 
    {
        return super.supportsInterface(interfaceId);
    }
}`;
    }

    /**
     * Get compilation artifacts
     */
    async getArtifacts(artifactsPath) {
        const artifacts = {};
        
        try {
            const files = await fs.readdir(artifactsPath);
            
            for (const file of files) {
                if (file.endsWith('.sol')) {
                    const contractDir = path.join(artifactsPath, file);
                    const contractFiles = await fs.readdir(contractDir);
                    
                    for (const contractFile of contractFiles) {
                        if (contractFile.endsWith('.json') && !contractFile.includes('.dbg.')) {
                            const artifactPath = path.join(contractDir, contractFile);
                            const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
                            const contractName = contractFile.replace('.json', '');
                            
                            artifacts[contractName] = {
                                abi: artifact.abi,
                                bytecode: artifact.bytecode
                            };
                        }
                    }
                }
            }
            
            return artifacts;
        } catch (error) {
            logger.error('Failed to get artifacts:', error);
            return artifacts;
        }
    }

    /**
     * List all projects
     */
    async listProjects() {
        try {
            const projects = await fs.readdir(this.projectsDir);
            const projectInfo = [];
            
            for (const project of projects) {
                const projectPath = path.join(this.projectsDir, project);
                const stat = await fs.stat(projectPath);
                
                if (stat.isDirectory()) {
                    // Check if it's a Hardhat project
                    try {
                        await fs.access(path.join(projectPath, 'hardhat.config.js'));
                        
                        // Get contracts
                        const contractsPath = path.join(projectPath, 'contracts');
                        let contracts = [];
                        try {
                            const files = await fs.readdir(contractsPath);
                            contracts = files.filter(f => f.endsWith('.sol'));
                        } catch (e) {
                            // No contracts directory
                        }
                        
                        projectInfo.push({
                            name: project,
                            path: projectPath,
                            contracts,
                            created: stat.birthtime
                        });
                    } catch (e) {
                        // Not a Hardhat project
                    }
                }
            }
            
            return projectInfo;
        } catch (error) {
            logger.error('Failed to list projects:', error);
            return [];
        }
    }

    /**
     * Get project details
     */
    async getProjectDetails(projectName) {
        const projectPath = path.join(this.projectsDir, projectName);
        
        try {
            // Get contracts
            const contractsPath = path.join(projectPath, 'contracts');
            const contracts = [];
            
            try {
                const files = await fs.readdir(contractsPath);
                for (const file of files) {
                    if (file.endsWith('.sol')) {
                        const content = await fs.readFile(
                            path.join(contractsPath, file), 
                            'utf8'
                        );
                        contracts.push({
                            name: file,
                            content
                        });
                    }
                }
            } catch (e) {
                // No contracts
            }
            
            // Get deployments (if tracked)
            let deployments = [];
            try {
                const deploymentsPath = path.join(projectPath, 'deployments.json');
                deployments = JSON.parse(await fs.readFile(deploymentsPath, 'utf8'));
            } catch (e) {
                // No deployments file
            }
            
            return {
                name: projectName,
                path: projectPath,
                contracts,
                deployments
            };
        } catch (error) {
            logger.error(`Failed to get project details:`, error);
            throw error;
        }
    }
    
    /**
     * Get available contract templates
     */
    getAvailableTemplates() {
        const basicTemplates = [
            { id: 'basic', name: 'Basic Contract', description: 'Simple smart contract with owner' },
            { id: 'erc20', name: 'ERC-20 Token', description: 'Standard fungible token' },
            { id: 'erc721', name: 'ERC-721 NFT', description: 'Non-fungible token' }
        ];
        
        const advancedTemplates = Object.entries(templates).map(([id, template]) => ({
            id,
            name: template.name,
            description: template.description
        }));
        
        return {
            basic: basicTemplates,
            advanced: advancedTemplates
        };
    }
}

export default new HardhatService();