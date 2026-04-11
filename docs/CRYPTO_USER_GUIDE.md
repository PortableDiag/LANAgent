# LANAgent Cryptocurrency & Smart Contract User Guide

## Overview

LANAgent includes a powerful cryptocurrency wallet and smart contract interaction system that allows you to manage digital assets, interact with blockchain applications, and develop smart contracts. This guide will help you get started with all crypto features.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Wallet Management](#wallet-management)
3. [Sending and Receiving Crypto](#sending-and-receiving-crypto)
4. [Smart Contract Interaction](#smart-contract-interaction)
5. [Using Chainlink Oracles](#using-chainlink-oracles)
6. [Digital Signatures & Web3 Auth](#digital-signatures--web3-auth)
7. [Revenue Tracking](#revenue-tracking)
8. [Smart Contract Development](#smart-contract-development)
9. [Security Best Practices](#security-best-practices)
10. [Troubleshooting](#troubleshooting)
11. [Advanced Use Cases](#advanced-use-cases)
12. [Automated Trading Strategies](#automated-trading-strategies)
13. [Automation Examples](#automation-examples)
14. [Best Practices for Production Use](#best-practices-for-production-use)
15. [Support & Resources](#support--resources)

## Getting Started

### First Time Setup

1. **Access the Crypto Tab**
   - Navigate to the LANAgent web interface
   - Click on the "Crypto" tab in the sidebar
   - The wallet will automatically initialize on first access

2. **Wallet Addresses**
   Your LANAgent wallet includes addresses for multiple blockchains:
   - **Bitcoin**: Your BTC address (shown in the Crypto tab)
   - **Ethereum/EVM**: Your ETH/EVM address (shown in the Crypto tab)
   
   The same Ethereum address works for:
   - Ethereum
   - Binance Smart Chain (BSC)
   - Polygon
   - Base

3. **Network Mode**
   - By default, LANAgent operates in **testnet mode** for safety
   - You can switch to mainnet mode using the toggle in the web UI
   - A red warning appears when in mainnet mode

### Natural Language Commands

You can interact with crypto features using natural language:

```
"What's my wallet balance?"
"Check ETH balance"
"Show my Bitcoin address"
"Get ETH price from Chainlink"
"Switch to mainnet mode"
"Export my encrypted seed phrase"
```

## Wallet Management

### Viewing Your Wallet

Through the Web UI:
1. Go to the Crypto tab
2. Your addresses and balances are displayed at the top
3. Click any address to copy it to clipboard
4. QR codes are shown for easy mobile scanning

Through commands:
```
"Show my wallet status"
"What are my crypto addresses?"
"Display wallet QR codes"
```

### Backing Up Your Wallet

**Important**: Always backup your wallet seed phrase!

1. **Export Encrypted Seed**
   ```
   "Export my encrypted seed phrase"
   "Backup my wallet"
   ```
   
2. **Store the encrypted seed securely**
   - Save it in a password manager
   - Store offline in multiple locations
   - Never share your seed phrase

### Checking Balances

Balances update automatically, or you can refresh manually:
```
"Refresh my crypto balances"
"Check balance on all networks"
"What's my Polygon balance?"
```

## Sending and Receiving Crypto

### Receiving Cryptocurrency

1. **Share Your Address**
   - Click the address to copy
   - Use QR codes for mobile wallets
   - Addresses are the same for all EVM chains

2. **Donation System**
   - Generate a donation page: "Create crypto donation page"
   - Set suggested amounts
   - Include payment links for popular wallets

3. **Monitor Incoming Transactions**
   ```
   "Check for new transactions"
   "Show recent crypto activity"
   ```

### Sending Cryptocurrency

Send cryptocurrency directly from your LANAgent wallet:

1. **Through Natural Language**
   ```
   "Send 0.1 ETH to 0x742d35Cc6634C0532925a3b844Bc9e7595f8fA49"
   "Transfer 50 MATIC on Polygon to address.eth"
   "Send 100 USDC to my friend's address"
   ```

2. **Through Web UI**
   - Navigate to the Crypto tab
   - Click "Send" button
   - Enter recipient address
   - Specify amount and network
   - Review gas fees
   - Confirm transaction

3. **Safety Features**
   - Address validation before sending
   - Gas price estimation
   - Transaction simulation (when available)
   - Confirmation required for all sends
   - Automatic nonce management

4. **Transaction Status**
   ```
   "Check status of my last transaction"
   "Show pending transactions"
   "Get transaction receipt for 0x123..."
   ```

## Smart Contract Interaction

### Reading Contract Data

1. **Check Token Balances**
   ```
   "Check USDC balance on Ethereum"
   "What's my LINK token balance on Polygon?"
   ```

2. **Query Contract Functions**
   ```
   "Read totalSupply from contract 0x... on Ethereum"
   "Get token info for USDT on BSC"
   ```

3. **Through Web UI**
   - Navigate to Smart Contract Explorer
   - Enter contract address
   - Select network
   - Choose function to call

### Monitoring Events

Track blockchain events in real-time:

```
"Monitor USDC transfers to my address"
"Watch for Transfer events on contract 0x..."
"Track NFT mints on Ethereum"
```

Events are stored in the database and visible in the web UI.

### Interacting with DeFi Protocols

Common DeFi operations:
```
"Check Uniswap pool reserves"
"Get AAVE lending rates"
"Monitor liquidations on Compound"
```

## Using Chainlink Oracles

Chainlink provides decentralized price feeds across multiple networks.

### Getting Prices

```
"Get ETH price from Chainlink"
"What's the BTC/USD price on Chainlink Polygon?"
"Compare Chainlink and CoinGecko prices for ETH"
```

### Available Price Feeds

View all available feeds:
```
"List Chainlink price feeds on Ethereum"
"Show available oracles on Polygon"
```

### Historical Prices

Query past price data:
```
"Get historical ETH price from round 123456"
"Show Chainlink price history for BTC"
```

### LINK Token Management

```
"Check my LINK balance"
"Where can I get testnet LINK?"
"Show LINK faucets"
```

## Digital Signatures & Web3 Auth

### Signing Messages

1. **Personal Messages**
   ```
   "Sign message 'Hello World' with Ethereum key"
   ```

2. **Through Web UI**
   - Go to Digital Signatures section
   - Enter your message
   - Select network
   - Click Sign

### Sign-In With Ethereum (SIWE)

Authenticate with Web3 applications:
```
"Create SIWE message for example.com"
"Sign in to Web3 app"
```

### EIP-712 Typed Data

Sign structured data for dApps:
```
"Sign typed data for permit"
"Approve token spending with signature"
```

### Signature Verification

Verify any signature:
```
"Verify signature 0x... for message 'Hello'"
"Check if signature is valid"
```

## Revenue Tracking

Track all crypto income and expenses for tax purposes.

### Recording Transactions

1. **Add Revenue**
   ```
   "Record 0.5 ETH donation received"
   "Add crypto payment of 100 USDC"
   ```

2. **Track Expenses**
   ```
   "Record 0.01 ETH gas fee"
   "Add smart contract deployment cost"
   ```

### Generating Reports

1. **Annual Tax Report**
   ```
   "Generate crypto tax report for 2024"
   "Show profit/loss for this year"
   ```

2. **Custom Reports**
   ```
   "Revenue report for December"
   "Show expenses by category"
   ```

3. **Export Options**
   - CSV for spreadsheets
   - JSON for programmatic use
   - PDF for documentation

### Automatic Import

Import transactions from blockchain:
```
"Import all Ethereum transactions"
"Sync Polygon transaction history"
```

## Smart Contract Development

LANAgent includes a full Hardhat development environment.

### Creating a Project

1. **Through Web UI**
   - Go to Smart Contract Development
   - Click "New Project"
   - Choose a template
   - Configure parameters

2. **Via Commands**
   ```
   "Create new ERC-20 token contract"
   "Start NFT project"
   ```

### Available Templates

- **Basic Token** - Simple ERC-20
- **Advanced Token** - With minting, burning, pausable
- **NFT Collection** - ERC-721 with metadata
- **Governance Token** - With voting capabilities
- **Multi-Signature Wallet** - Secure fund management
- **Payment Splitter** - Revenue sharing
- **Staking Contract** - Token staking with rewards

### Compiling Contracts

```
"Compile my smart contract"
"Check for compilation errors"
```

### Deploying Contracts

1. **To Testnet**
   ```
   "Deploy MyToken to Sepolia"
   "Launch contract on Polygon Mumbai"
   ```

2. **Deployment Process**
   - Ensures sufficient gas
   - Estimates deployment cost
   - Provides transaction hash
   - Saves contract address

### Testing Contracts

```
"Run smart contract tests"
"Test MyToken transfer function"
```

## Security Best Practices

### Wallet Security

1. **Seed Phrase Protection**
   - Never share your seed phrase
   - Store encrypted backups only
   - Use hardware wallets for large amounts

2. **Network Mode**
   - Always use testnet for development
   - Double-check before mainnet operations
   - Set spending limits

3. **Transaction Verification**
   - Review all transactions before signing
   - Verify contract addresses
   - Check gas prices

### Smart Contract Security

1. **Before Interacting**
   - Verify contract source code
   - Check for audits
   - Test on testnet first

2. **Common Scams to Avoid**
   - Fake token approvals
   - Phishing sites
   - Honeypot contracts

### API Security

1. **Authentication**
   - Use API keys for external apps
   - Rotate keys regularly
   - Set rate limits

2. **Network Security**
   - Use HTTPS only
   - Firewall crypto endpoints
   - Monitor for anomalies

## Troubleshooting

### Common Issues

1. **"Wallet not initialized"**
   - Visit Crypto tab to auto-initialize
   - Or run: "Initialize crypto wallet"

2. **"Insufficient balance"**
   - Check you're on the right network
   - For testnet, claim from faucets
   - Ensure enough for gas fees

3. **"Contract interaction failed"**
   - Verify contract address
   - Check network selection
   - Ensure contract has required function

4. **"RPC connection error"**
   - The system automatically handles RPC failures with built-in fallback
   - Each network has 3-7 backup RPC endpoints that are tried automatically
   - If all RPCs fail, check your internet connection
   - You can manually trigger a retry: "Trigger strategy run"

### Getting Test Tokens

For development and testing:

1. **Sepolia ETH**
   ```
   "Get Sepolia testnet ETH"
   "Show Ethereum testnet faucets"
   ```

2. **Mumbai MATIC**
   ```
   "Get Mumbai test tokens"
   "Polygon faucet link"
   ```

3. **Other Networks**
   - BSC Testnet: https://testnet.binance.org/faucet-smart
   - Base Sepolia: Use Sepolia ETH

### Debug Mode

Enable detailed logging:
```
"Enable crypto debug mode"
"Show contract interaction logs"
```

## Advanced Features

### Custom RPC Endpoints

Add custom networks:
```
"Add custom RPC for Arbitrum"
"Configure Optimism endpoint"
```

### Batch Operations

Process multiple transactions:
```
"Batch check token balances"
"Monitor multiple contracts"
```

### Integration Examples

1. **With Email Notifications**
   ```
   "Email me when I receive crypto"
   "Send donation receipt via email"
   ```

2. **With Task Management**
   ```
   "Create task to check gas prices daily"
   "Remind me to claim staking rewards"
   ```

3. **With Web Scraping**
   ```
   "Monitor etherscan for new transactions"
   "Track gas prices from multiple sources"
   ```

## Advanced Use Cases

### DeFi Integration Examples

1. **Yield Farming**
   ```
   "Check APY on AAVE for USDC"
   "Monitor my lending positions on Compound"
   "Calculate impermanent loss for ETH/USDC pool"
   ```

2. **DEX Trading**
   ```
   "Get Uniswap price for ETH to USDC"
   "Check slippage for 1000 USDC swap"
   "Monitor arbitrage opportunities"
   ```

3. **Liquidity Provision**
   ```
   "Add liquidity to Uniswap ETH/USDC pool"
   "Check my LP token balance"
   "Calculate pool share percentage"
   ```

### NFT Management

1. **NFT Collections**
   ```
   "Check my NFT balance for Bored Apes"
   "Get floor price for CryptoPunks"
   "Monitor NFT transfers to my wallet"
   ```

2. **Minting & Trading**
   ```
   "Deploy new NFT collection"
   "Set up allowlist for minting"
   "Track royalty payments"
   ```

### DAO Participation

1. **Governance**
   ```
   "Check my voting power in Uniswap DAO"
   "View active proposals for Compound"
   "Delegate voting power to address"
   ```

2. **Proposal Creation**
   ```
   "Create governance proposal"
   "Check proposal status"
   "Execute passed proposals"
   ```

### Cross-Chain Operations

1. **Multi-Chain Monitoring**
   ```
   "Compare ETH balance across all networks"
   "Track USDC on Ethereum, Polygon, and BSC"
   "Monitor cross-chain bridge activity"
   ```

2. **Bridge Integration**
   ```
   "Check bridge fees from Ethereum to Polygon"
   "Monitor pending bridge transactions"
   "Calculate optimal bridging route"
   ```

## Automated Trading Strategies

LANAgent includes 6 automated trading strategies that can help manage your cryptocurrency portfolio based on different market conditions and trading philosophies.

### Available Strategies

#### 1. Native Maximizer (Default)
**Goal**: Maximize native token holdings by selling high and buying back low.

- **Sell Threshold**: 4% above baseline (configurable)
- **Buy Threshold**: 3% below baseline (configurable)
- **Stop-Loss**: -8% from high watermark
- **Best For**: Volatile markets, active traders

```
"Set sell threshold to 5%"
"Check current native maximizer settings"
```

#### 2. Dollar Cost Averaging (DCA)
**Goal**: Reduce timing risk by buying at regular intervals.

- **Investment Interval**: Configurable (daily, weekly, monthly)
- **Fixed Amount**: Consistent investment size
- **Best For**: Long-term holders, passive investors

```
"Enable DCA strategy"
"Set DCA to buy $100 weekly"
```

#### 3. Grid Trading
**Goal**: Profit from price oscillations in sideways markets.

- **Grid Levels**: 5 (configurable)
- **Grid Spacing**: 2% between levels
- **Trade Per Level**: 10% of position
- **Best For**: Range-bound markets, high-frequency trading

```
"Switch to grid trading strategy"
"Set grid spacing to 1.5%"
"Configure 7 grid levels"
```

**How it works**:
- Places buy orders at fixed intervals below current price
- Places sell orders at fixed intervals above current price
- Profits from each price oscillation through the grid
- Works best in sideways/choppy markets

#### 4. Mean Reversion
**Goal**: Profit from prices returning to their historical average.

- **MA Period**: 24 hours
- **Buy Deviation**: -5% below moving average
- **Sell Deviation**: +5% above moving average
- **Best For**: Markets with clear averages, contrarian trading

```
"Switch to mean reversion strategy"
"Set MA period to 48 hours"
"Check deviation from moving average"
```

**How it works**:
- Calculates moving average from historical prices
- Buys when price drops significantly below MA
- Sells when price rises significantly above MA
- Based on the principle that prices tend to revert to the mean

#### 5. Volatility-Adjusted Trading
**Goal**: Dynamically adjust trading thresholds based on market volatility.

- **Low Volatility**: Tighter thresholds (0.6x multiplier)
- **Normal Volatility**: Base thresholds
- **High Volatility**: Wider thresholds (1.8x multiplier)
- **Volatility Period**: 24 hours
- **Best For**: All market conditions, adaptive trading

```
"Switch to volatility-adjusted strategy"
"Check current volatility regime"
"View adjusted thresholds"
```

**How it works**:
- Calculates current market volatility from recent price movements
- In high volatility: widens thresholds to avoid noise
- In low volatility: tightens thresholds to capture smaller moves
- Prevents getting stopped out during normal volatility

**Volatility Regimes**:
- **Low** (< 30% annualized): Tighter thresholds
- **Normal** (30-80%): Base thresholds
- **High** (> 80%): Wider thresholds

#### 6. Momentum/Trend Following
**Goal**: Trade in the direction of the prevailing trend.

- **Fast MA**: 6 hours (trend detection)
- **Slow MA**: 24 hours (trend confirmation)
- **Trailing Stop**: 5% from high
- **Best For**: Trending markets, avoiding falling knives

```
"Switch to momentum strategy"
"Check current trend analysis"
"View MA crossover status"
```

**How it works**:
- Uses fast/slow moving average crossovers to identify trend
- Only buys in confirmed uptrends
- Stays out (or sells) in downtrends
- Uses trailing stops to protect profits
- Avoids "catching falling knives"

**Signals**:
- **Uptrend**: Fast MA > Slow MA (buy signal)
- **Downtrend**: Fast MA < Slow MA (sell signal)
- **Sideways**: MAs converging (no action)

### Managing Strategies

#### Switching Strategies

```
"Switch to grid trading strategy"
"Activate mean reversion"
"Use momentum strategy"
"Switch back to native maximizer"
```

#### Checking Strategy Status

```
"What strategy is active?"
"List all available strategies"
"Show strategy performance comparison"
"Get strategy info for momentum"
```

#### Configuring Strategy Settings

```
"Set sell threshold to 5% for native maximizer"
"Configure grid trading with 7 levels"
"Update volatility thresholds"
```

### Strategy Selection Guide

| Strategy | Best Market Condition | Risk Level | Trading Frequency |
|----------|----------------------|------------|-------------------|
| Native Maximizer | Volatile, trending | Medium | Medium |
| DCA | Any (long-term) | Low | Low |
| Grid Trading | Sideways, range-bound | Medium | High |
| Mean Reversion | Oscillating around average | Medium | Medium |
| Volatility-Adjusted | All conditions | Low-Medium | Adaptive |
| Momentum | Trending (up or down) | Medium | Low |

### Strategy Tips

1. **Test on Testnet First**: Always test new strategies on testnet before using mainnet
2. **Start Conservative**: Use default thresholds initially
3. **Monitor Performance**: Check strategy stats regularly
4. **Adapt to Markets**: Switch strategies based on market conditions
5. **Use Stop-Losses**: All strategies include stop-loss protection
6. **Review Daily PnL**: Track daily profit/loss for each strategy

### Strategy API Endpoints

For programmatic access:

```bash
# List all strategies
GET /api/crypto/strategy/list

# Get active strategy
GET /api/crypto/strategy/active

# Switch strategy
POST /api/crypto/strategy/switch
Body: {"strategy": "grid_trading"}

# Get strategy info
GET /api/crypto/strategy/info/:name

# Update strategy config
POST /api/crypto/strategy/config/:name
Body: {"gridLevels": 7}

# Get performance comparison
GET /api/crypto/strategy/performance

# Trigger manual analysis
POST /api/crypto/strategy/trigger

# Seed price history for volatility strategies (fetches from CoinGecko)
POST /api/crypto/strategy/seed-history
Body: {"strategy": "volatility_adjusted"}  # optional, defaults to volatility_adjusted
```

## Automation Examples

### Scheduled Tasks

1. **Price Monitoring**
   ```
   "Alert me when ETH drops below $2000"
   "Daily report of portfolio value"
   "Track gas prices every hour"
   ```

2. **Transaction Automation**
   ```
   "Auto-claim staking rewards weekly"
   "Rebalance portfolio monthly"
   "Compound yield farming rewards daily"
   ```

### Integration with Other LANAgent Features

1. **Email Integration**
   ```
   "Email me daily crypto portfolio summary"
   "Send transaction receipts to my email"
   "Alert via email for large transfers"
   ```

2. **Task Management**
   ```
   "Create task to check DeFi positions daily"
   "Remind me to claim airdrops"
   "Schedule weekly revenue report generation"
   ```

3. **Data Analysis**
   ```
   "Analyze my trading patterns"
   "Generate profit/loss charts"
   "Compare portfolio performance to BTC"
   ```

## Best Practices for Production Use

### Security Checklist

- [ ] Enable 2FA on LANAgent account
- [ ] Use hardware wallet for large amounts
- [ ] Regular seed phrase backup verification
- [ ] Monitor for suspicious transactions
- [ ] Set up alerts for large transfers
- [ ] Use multisig for team wallets
- [ ] Regular security audits

### Performance Optimization

1. **RPC Endpoints**
   - Built-in RPC fallback: Each network has 3-7 backup endpoints
   - Automatic failover on rate limits, timeouts, or connection errors
   - Static network configuration prevents infinite retry loops
   - Supported networks: Ethereum, BSC, Polygon, Base (mainnet & testnet)
   
2. **Gas Optimization**
   - Batch similar transactions
   - Use gas price oracles
   - Schedule non-urgent txs for low gas times

3. **Data Management**
   - Regular database cleanup
   - Archive old transaction data
   - Optimize event listener queries

## Support & Resources

### Getting Help

1. **Built-in Documentation**
   ```
   "Explain crypto features"
   "How do I use smart contracts?"
   "Show DeFi integration examples"
   ```

2. **Example Commands**
   ```
   "Show crypto command examples"
   "List blockchain operations"
   "Demonstrate NFT management"
   ```

3. **Troubleshooting Assistant**
   ```
   "Debug failed transaction"
   "Why is my balance not updating?"
   "Help with smart contract error"
   ```

### External Resources

- [Ethereum Documentation](https://ethereum.org/developers)
- [Chainlink Docs](https://docs.chain.link)
- [Hardhat Guides](https://hardhat.org/tutorial)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com)
- [DeFi Pulse](https://defipulse.com) - DeFi analytics
- [Etherscan](https://etherscan.io) - Blockchain explorer
- [Dune Analytics](https://dune.com) - Blockchain analytics

### Community & Updates

1. **Stay Updated**
   ```
   "Check for crypto plugin updates"
   "Show latest blockchain features"
   ```

2. **Feature Requests**
   ```
   "Request new crypto feature: [your idea]"
   "Suggest blockchain integration"
   "Report crypto bug"
   ```

3. **Contributing**
   - Submit pull requests for new features
   - Share custom smart contract templates
   - Report security vulnerabilities responsibly

---

Remember: Always start with testnet operations until you're comfortable with the features. Your LANAgent is here to help make blockchain interactions simple and secure!