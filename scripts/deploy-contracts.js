#!/usr/bin/env node
/**
 * Deploy all new contracts to BSC mainnet using the agent's wallet.
 * Reads the encrypted seed from MongoDB, derives the private key,
 * then deploys each contract sequentially.
 *
 * Usage: node scripts/deploy-contracts.js [--dry-run]
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { decrypt } from '../src/utils/encryption.js';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run');

// Contracts to deploy
const CONTRACTS = [
    {
        name: 'AgenticCommerceJob',
        dir: 'contracts/agentic-commerce',
        settingKey: 'agentic_commerce_address',
        envKey: 'AGENTIC_COMMERCE_ADDRESS',
        constructorArgs: (signer) => [signer.address, 250] // treasury = deployer, fee = 2.5%
    },
    {
        name: 'ENSTrustRegistry',
        dir: 'contracts/ens-trust-registry',
        settingKey: 'trust_registry_address',
        envKey: 'TRUST_REGISTRY_ADDRESS',
        postDeploy: async (contract, signer) => {
            // Register genesis anchor node
            const lanagentNode = ethers.namehash('lanagent.eth');
            console.log(`  Registering genesis node lanagent.eth: ${lanagentNode}`);
            const tx = await contract.registerNode(lanagentNode);
            await tx.wait();
            console.log('  Genesis node registered');
        }
    },
    {
        name: 'AgentCoordination',
        dir: 'contracts/agent-coordination',
        settingKey: 'coordination_contract_address',
        envKey: 'COORDINATION_CONTRACT_ADDRESS'
    },
    {
        name: 'AvatarNFT',
        dir: 'contracts/avatar-nft',
        settingKey: 'avatar_nft_contract_address',
        envKey: 'AVATAR_NFT_CONTRACT_ADDRESS'
    },
    {
        name: 'AgentCouncilOracle',
        dir: 'contracts/agent-council-oracle',
        settingKey: 'oracle_contract_address',
        envKey: 'ORACLE_CONTRACT_ADDRESS'
    }
];

async function main() {
    console.log('=== LANAgent Contract Deployment ===');
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE MAINNET'}`);
    console.log('');

    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Get wallet
    const CryptoWallet = (await import('../src/models/CryptoWallet.js')).default;
    const walletDoc = await CryptoWallet.findOne();
    if (!walletDoc?.encryptedSeed) {
        throw new Error('No wallet found in database');
    }

    const mnemonic = decrypt(walletDoc.encryptedSeed);
    const wallet = ethers.Wallet.fromPhrase(mnemonic);
    const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org', 56);
    const signer = wallet.connect(provider);

    const balance = await provider.getBalance(signer.address);
    console.log(`Deployer: ${signer.address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} BNB`);
    console.log('');

    if (balance < ethers.parseEther('0.005')) {
        throw new Error('Insufficient BNB for deployment (need at least 0.005 BNB)');
    }

    // Get SystemSettings model for saving addresses
    const { SystemSettings } = await import('../src/models/SystemSettings.js');

    const results = [];

    for (const contractInfo of CONTRACTS) {
        console.log(`--- Deploying ${contractInfo.name} ---`);
        const contractDir = path.join(ROOT, contractInfo.dir);

        // Check if already deployed
        const existing = await SystemSettings.getSetting(contractInfo.settingKey, '');
        if (existing) {
            console.log(`  Already deployed at ${existing} — skipping`);
            results.push({ name: contractInfo.name, address: existing, status: 'existing' });
            continue;
        }

        // Install deps if needed
        if (!fs.existsSync(path.join(contractDir, 'node_modules'))) {
            console.log('  Installing dependencies...');
            execSync('npm install', { cwd: contractDir, stdio: 'pipe' });
        }

        // Compile
        console.log('  Compiling...');
        try {
            execSync('npx hardhat compile', { cwd: contractDir, stdio: 'pipe' });
        } catch (err) {
            console.error(`  Compilation failed: ${err.stderr?.toString().slice(0, 500)}`);
            results.push({ name: contractInfo.name, status: 'compile-failed' });
            continue;
        }

        // Find compiled artifact
        const artifactPath = path.join(contractDir, 'artifacts', 'contracts', `${contractInfo.name}.sol`, `${contractInfo.name}.json`);
        if (!fs.existsSync(artifactPath)) {
            console.error(`  Artifact not found: ${artifactPath}`);
            results.push({ name: contractInfo.name, status: 'artifact-missing' });
            continue;
        }

        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        if (DRY_RUN) {
            console.log('  [DRY RUN] Would deploy — skipping');
            results.push({ name: contractInfo.name, status: 'dry-run' });
            continue;
        }

        // Deploy
        console.log('  Deploying to BSC mainnet...');
        try {
            const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
            const args = contractInfo.constructorArgs ? contractInfo.constructorArgs(signer) : [];
            const contract = await factory.deploy(...args);
            console.log(`  Tx: ${contract.deploymentTransaction().hash}`);
            console.log('  Waiting for confirmation...');
            await contract.waitForDeployment();

            const address = await contract.getAddress();
            console.log(`  Deployed: ${address}`);

            // Post-deploy hook
            if (contractInfo.postDeploy) {
                await contractInfo.postDeploy(contract, signer);
            }

            // Save to SystemSettings
            await SystemSettings.setSetting(contractInfo.settingKey, address);
            console.log(`  Saved to SystemSettings: ${contractInfo.settingKey} = ${address}`);

            results.push({ name: contractInfo.name, address, status: 'deployed' });
        } catch (err) {
            console.error(`  Deploy failed: ${err.message}`);
            results.push({ name: contractInfo.name, status: 'deploy-failed', error: err.message });
        }

        console.log('');
    }

    // Summary
    console.log('\n=== Deployment Summary ===');
    for (const r of results) {
        const icon = r.status === 'deployed' ? '✓' : r.status === 'existing' ? '•' : '✗';
        console.log(`  ${icon} ${r.name}: ${r.address || r.status}${r.error ? ` (${r.error})` : ''}`);
    }

    const finalBalance = await provider.getBalance(signer.address);
    console.log(`\nRemaining balance: ${ethers.formatEther(finalBalance)} BNB`);
    console.log(`Gas used: ${ethers.formatEther(balance - finalBalance)} BNB`);

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('Deployment failed:', err.message);
    process.exit(1);
});
