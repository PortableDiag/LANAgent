# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.85] - 2026-02-11

### Added
- **Calibre Content Server plugin** — Browse and search Calibre eBook libraries via natural language
  - 15 commands: search, book details, browse by author/tag/series/publisher/rating, recent books, download links, library stats
  - 10 vectorized intents for NLP matching
  - Settings UI integration with optional Basic HTTP auth
  - Auto-detects default library, hex-encoded category API, fuzzy matching for browse queries
  - Cached responses (NodeCache, 2min TTL) with retry logic

## [2.10.84] - 2026-02-11

### Added
- **Jellyfin media server plugin** — Full Jellyfin management via natural language
  - 30 commands across 8 categories (system, libraries, media, TV shows, users, sessions, playlists, packages)
  - 16 vectorized intents for NLP matching
  - Settings UI integration (server URL + API key) with encrypted credential storage
  - MediaBrowser Token authentication, admin user auto-detection
  - Cached responses (NodeCache, 2min TTL) with retry logic

### Fixed
- **Plugin toggle confirmation** — Replaced native `window.confirm()` with in-page modal dialog
  - Browser was silently suppressing native confirm dialogs on plugin enable/disable
  - New modal with action-specific styling (danger for disable, primary for enable)
  - Updated plugin development guidelines with Web UI requirements

## [2.10.83] - 2026-02-11

### Added
- **FeatureRequest.js** — NodeCache (5min TTL) and retryOperation for all static query methods
- **SystemReport.js** — NodeCache caching for getLatestReport, retryOperation for all static methods
- **NetworkDevice.js** — Compound indexes on services.port+protocol and stats.uptimePercentage
- **GitHostingProvider.js** — performNetworkOperation retry helper with corrected import path
- **Account activity logging** — Middleware logging all API operations on accounts endpoint
- **FCM message priority** — Priority parameter with Android/APNs handling for push notifications

### Fixed
- **FilteredTransport** — Fixed import paths, replaced console.error with logger.error, added updateLogLevel method

## [2.10.28] - 2026-01-23

### Major Refactor
- **Crypto Strategy Consolidation**: Merged legacy `cryptoStrategyService.js` into `CryptoStrategyAgent` SubAgent
  - Removed 1,682 lines of legacy code
  - All crypto trading now controlled through single SubAgent architecture
  - WebUI now controls SubAgent directly instead of legacy service
  - Dynamic scheduling via Agenda jobs (configurable interval)

### Added
- **CryptoStrategyAgent WebUI Control Methods**:
  - `enable()` / `disable()` - Toggle agent with Agenda job scheduling
  - `emergencyStop()` / `clearEmergencyStop()` - Emergency controls
  - `updatePosition()` / `getPositions()` - Position tracking
  - `getJournal()` / `recordDecision()` - Decision history
  - `listStrategies()` / `switchStrategy()` / `getActiveStrategy()` - Strategy management
  - `setScheduleInterval()` / `getScheduleInfo()` / `triggerRun()` - Scheduling
  - Enhanced `getStatus()` returning comprehensive status

- **Agenda Job for Crypto Strategy**:
  - New `crypto-strategy-agent` job type in scheduler
  - `scheduleCryptoAgent(agentId, intervalMinutes)` helper method
  - Dynamic interval changes without restart

- **New API Endpoints**:
  - `POST /api/crypto/strategy/schedule` - Set schedule interval
  - `GET /api/crypto/strategy/schedule` - Get schedule info

- **Migration Script**:
  - `scripts/migrate-crypto-strategy.js` - Migrates legacy config/state to SubAgent
  - Supports `--dry-run` flag for preview

### Removed
- `src/services/crypto/cryptoStrategyService.js` - Legacy service (1,682 lines)
- `setStrategyService()` export from crypto.js
- Legacy service initialization from agent.js

### Changed
- All 25+ crypto API endpoints now use `getCryptoHandler()` instead of `strategyService`
- Network mode endpoint updates SubAgent directly via handler
- agent.js now connects crypto API to SubAgent via `setCryptoAgent()`

### Technical Details
Files modified:
- `src/services/subagents/CryptoStrategyAgent.js` - Added ~400 lines of WebUI control methods
- `src/services/scheduler.js` - Added Agenda job for crypto agent
- `src/api/crypto.js` - Replaced all strategyService references with handler
- `src/core/agent.js` - Removed legacy service init, connected to SubAgent
- `scripts/migrate-crypto-strategy.js` - NEW: Migration script

---

## [2.10.21] - 2026-01-21

### Added
- **ScanProgress Query Caching** (`src/services/scanProgressCache.js`):
  - New service-layer caching helper for incremental scanner queries
  - Uses node-cache with 30-second TTL for time-sensitive operations
  - Caches countDocuments and pending entries queries
  - Automatic cache invalidation on status changes
  - Reduces database load during bug scanning operations

- **Dynamic Volatility Config Adjustment** (`src/services/crypto/cryptoStrategyService.js`):
  - New `adjustConfigForVolatility()` method
  - Automatically adjusts maxTradePercentage based on market volatility
  - High volatility: reduces trade size (6%), increases slippage tolerance (2%)
  - Low volatility: increases trade size (13%), tightens slippage (0.7%)
  - New API endpoint `POST /api/crypto/strategy/adjust-volatility`

- **Bluetooth RSSI Trilateration** (`src/models/BluetoothDevice.js`):
  - `rssiToDistance()` - Converts RSSI to distance using log-distance path loss model
  - `trilaterate()` - 2D position estimation using least squares method
  - `estimateDevicePosition()` - Full position estimation with confidence scoring
  - Supports 3+ access points for indoor positioning

- **ReAct Agent Retry Logic** (`src/services/reasoning/reactAgent.js`):
  - Plugin execution now includes retry logic for transient failures
  - Uses existing retryOperation utility with 2 retries
  - Exponential backoff (1-5 seconds)
  - Logs retry attempts for debugging

### Fixed
- **Crypto Strategy Selection Persistence** (`src/interfaces/web/public/app.js`):
  - Strategy selector now properly loads from server on page refresh
  - Added `refreshStrategy()` call in `loadCrypto()` function
  - Strategy selection now persists across restarts and page refreshes

- **Strategy Registry Persistence** (`src/models/CryptoStrategy.js`):
  - Added `strategyRegistry` field to schema for proper persistence
  - Stores activeStrategy and per-strategy state data

### Technical Details
Files modified:
- `src/services/scanProgressCache.js` - NEW: Caching helper for ScanProgress
- `src/services/incrementalScanner.js` - Added cache integration
- `src/services/crypto/cryptoStrategyService.js` - Added volatility adjustment
- `src/api/crypto.js` - Added /strategy/adjust-volatility endpoint
- `src/models/BluetoothDevice.js` - Added trilateration methods
- `src/models/CryptoStrategy.js` - Added strategyRegistry field
- `src/services/reasoning/reactAgent.js` - Added retry logic
- `src/interfaces/web/public/app.js` - Fixed strategy selection on load

---

## [2.10.20] - 2026-01-21

### Enhanced
- **Self-Modification Service Quality Gates**:
  - Added blocking validation for placeholder code (Math.random(), hardcoded zeros)
  - Added blocking validation for removed database indexes
  - Added blocking validation for mongoose model wrappers that break API
  - Added blocking validation for excessive comment removal (>30%)
  - Updated AI prompt with explicit rules against these anti-patterns
  - PRs with critical issues are now blocked instead of just warned

### Technical Details
Files modified:
- `src/services/selfModification.js` - Enhanced validateGeneratedCode() with blocking errors

---

## [2.10.19] - 2026-01-21

### Enhanced
- **Dashboard Visuals Improvements**:
  - Added proper markdown escaping to chart titles and labels (security improvement)
  - New `zoomChart()` method to zoom into specific data point ranges
  - New `filterChartData()` method to filter chart data by custom criteria
  - Added command documentation array for available chart operations
  - Added `execute()` method for command dispatch pattern

### Technical Details
Files modified:
- `src/interfaces/telegram/dashboardVisuals.js` - Enhanced text-based chart functionality

---

## [2.10.18] - 2026-01-21

### Added
- **Price History Seeding for Volatility Strategies**:
  - New API endpoint `POST /api/crypto/strategy/seed-history` to pre-populate price data
  - Fetches 24h historical prices from CoinGecko for ETH, BNB, MATIC
  - Allows volatility_adjusted strategy to start trading immediately without 12h warmup
  - Eliminates need to wait for data collection on strategy activation

### Technical Details
Files modified:
- `src/services/crypto/cryptoStrategyService.js` - Added `seedPriceHistory()` method
- `src/api/crypto.js` - Added `/strategy/seed-history` endpoint

---

## [2.10.17] - 2026-01-21

### Added
- **RPC Fallback System**:
  - Multiple RPC endpoints per network (3-7 fallbacks each)
  - Automatic failover on rate limits, timeouts, and connection errors
  - Static network configuration to prevent infinite retry loops
  - Networks supported: Ethereum, BSC, Polygon, Base (mainnet & testnet)

### Fixed
- **RPC Provider Infinite Retry Bug**:
  - Fixed JsonRpcProvider getting stuck in infinite retry loop during network auto-detection
  - Providers now use explicit chainId with `staticNetwork: true` for fast failure
  - Enables proper RPC fallback behavior when endpoints are unavailable

### Technical Details
Files modified:
- `src/services/crypto/contractServiceWrapper.js` - Added RPC fallback system with static network config

---

## [2.10.16] - 2026-01-20

### Fixed
- **Network Mode Persistence Bug**:
  - Fixed critical bug where crypto strategy reverted to testnet after PM2 restarts
  - Root cause: WebUI was pushing localStorage value to server on every page load
  - Added `strategyService.setNetworkMode()` call to `/api/crypto/network-mode` endpoint
  - Fixed CryptoStrategyAgent to read from correct config path (`config.domainConfig.networkMode`)
  - Changed WebUI to fetch network mode from server (GET) instead of pushing localStorage (POST)
  - Server is now the source of truth for network mode

- **Token Scanner Improvements**:
  - Whitelisted tokens now return actual balance instead of just whitelist info
  - Fixed decimals handling for ethers v6 (convert BigInt to Number)

- **BSC Stablecoin Configuration**:
  - Changed BSC stablecoin from USDT to BUSD for swap operations

### Technical Details
Files modified:
- `src/api/crypto.js` - Added strategyService sync to network-mode endpoint
- `src/interfaces/web/public/app.js` - Changed to fetch network mode from server
- `src/services/subagents/CryptoStrategyAgent.js` - Fixed config path for networkMode
- `src/services/crypto/tokenScanner.js` - Added balance fetching for whitelisted tokens
- `src/services/crypto/cryptoStrategyService.js` - Updated BSC stablecoin config

## [2.8.45] - 2026-01-02

### Added
- **Memory System Enhancements**:
  - 17 specific memory categories for better organization (master preferences, goals, projects, etc.)
  - Access tracking with usage counters and last accessed timestamps
  - "Most Accessed" sort option for learned memories
  - Display of last accessed date in memory cards
  - Full plugin execution result storage in conversation memory

- **Bug Detection Status Indicator**:
  - Real-time visual indicator on web UI showing scan status
  - Progress tracking with files scanned and total file count
  - Auto-refresh without manual page reload
  - API endpoint for programmatic status checking

- **NASA Plugin Earth Imagery**:
  - Added `earthImagery` command to fetch satellite images by coordinates
  - Accepts latitude and longitude parameters
  - Uses NASA's Earth API endpoint
  - Added NASA_API_KEY to environment configuration

- **Project Bulk Task Management**:
  - Added `addTasks` method to Project model for bulk operations
  - Handles duplicate prevention automatically
  - Improves performance when adding multiple tasks to projects

### Enhanced
- **Error Handling & Self-Healing**:
  - Errors are now stored in conversation memory with full context
  - Users can reference previous errors in follow-up questions
  - Enhanced GitHub issue creation to pull error details from conversation history
  - Added ability to create bug reports by saying "create a bug report for that error"
  - Telegram interface now shows actual error messages instead of generic ones
  - Improved self-awareness and debugging capabilities

### Fixed
- **Crypto Wallet Self-Awareness**:
  - Fixed "Cannot read properties of undefined (reading 'getWalletInfo')" error  
  - Corrected wallet service import from destructured to default export
  - Added comprehensive crypto wallet capabilities to system prompt
  - Agent now properly advertises multi-chain wallet, smart contract, and DeFi features
  - Fixed behavioral notes to mention actual wallet capabilities instead of generic crypto info
  
- **Conversation Context**:
  - Plugin execution results now properly stored with full content
  - Fixed generic "completed successfully" messages losing actual result data
  - Added metadata storage for better context retention
  - Users can now reference previous command outputs in follow-up questions

- **Intent Detection**:
  - Fixed Telegram large message handling for changelog queries
  - Added proper message splitting at line/word boundaries
  - Resolved changelog intent being misclassified as planned improvements

### Enhanced
- **Web UI Memory Management**:
  - Updated category filter with all 17 memory categories
  - Added comprehensive sorting options including by access count
  - Improved memory card display with usage statistics
  - Better organization of master-specific and structured data types

## [2.8.43] - 2025-12-31

### Fixed
- **Self-Modification Service**:
  - Fixed critical emailService.js import error (missing pluginManager.js)
  - Fixed Capability Scanner only analyzing 3 files due to debug limit
  - Added file randomization for better upgrade opportunity discovery
  - Made scanner context-aware based on AI model token limits
  - Fixed Telegram notification markdown parsing errors by escaping special characters
  - Fixed duplicate Telegram notifications (removed redundant agent.notify call)
  - Fixed unnecessary period escaping in Telegram messages
  - Added proper error handling and validation in upgrade selection flow

- **Logging Issues**:
  - Fixed self-modification logs incorrectly appearing in plugin-development.log
  - Changed capabilityIncrementalScanner to use selfModLogger for proper log routing
  - Added debug logging to trace self-modification workflow

### Enhanced
- **Self-Modification Improvements**:
  - Scanner now analyzes entire /src/ directory instead of just plugins
  - Dynamically adjusts file count based on AI provider context limits
  - Better filtering and prioritization of upgrade opportunities
  - Improved notification system with proper markdown formatting
  - Always attempts Telegram notifications even with timeout warnings

## [2.8.39] - 2025-12-30

### Added
- **CoinGecko Plugin**: Complete cryptocurrency market data integration
  - Real-time price quotes with market cap and 24h changes
  - Market data including ATH/ATL information
  - Trending cryptocurrencies tracking
  - Global market statistics
  - Cryptocurrency search functionality
  - Exchange listing with volume data
  
- **News API Plugin**: Comprehensive news integration
  - Top headlines by category (business, technology, health, science, sports, entertainment)
  - Headlines by country with multiple region support
  - Full article search with date filtering
  - News source discovery and filtering
  - Support for both NEWS_API_KEY and NEWSAPI_KEY environment variables
  
- **Alpha Vantage Plugin**: Stock market and financial data
  - Real-time stock quotes with volume data
  - Daily time series with historical data
  - Company overview with fundamental data
  - Foreign exchange (forex) rates
  - Cryptocurrency exchange rates
  - Symbol search functionality
  
- **Scraper Plugin Enhancements**: 
  - 1-hour cache TTL (increased from 5 minutes) for improved performance
  - Smart caching for both web scraping and PDF generation
  - Cache hit indicators in responses
  - Optional `bypassCache` parameter for fresh data
  - Automatic cache cleanup every 30 minutes
  - Cache age reporting in milliseconds

### Fixed
- Closed 3 broken PRs (#488, #487, #486) that contained error messages instead of implementations

### Enhanced
- **Device Info Plugin**: Already includes IoT device detection (v1.1.0)
  - MQTT device detection on port 1883
  - CoAP device detection on port 5683
  - Network scanning for IoT protocols
  
- **Development Plugin**: Already includes performance optimization
  - Debounced save operations (1-second delay)
  - Reduced disk I/O for development plan updates

### Documentation
- Updated `.env.example` with new API key requirements
- Added comprehensive API documentation for all new plugins
- Updated main README with latest features

## [2.8.38] - 2025-12-30

### Added
- **Centralized GitHub Discovery System**
  - Scheduled searches running twice daily (9 AM & 9 PM)
  - Database storage for discovered features with code snippets
  - Service integration for self-modification and plugin development
  - Automatic cleanup after successful implementation
  - Resource optimization reducing API calls
  - Web UI integration showing discovery status

## [2.8.37] - 2025-12-30

### Added
- Device Detection Plugin with comprehensive hardware detection
- Intent Detection improvements for natural language processing
- Comprehensive Telegram media support for all types
- Media processing pipeline with buffer-to-file conversion

## [2.8.36] - 2025-12-29

### Fixed
- Self-modification service type filtering
- Plugin development service GitHub issue processing

## [2.8.35] - 2025-12-29

### Added
- ThingsBoard device group management
- Autonomous services status display
- Microcontroller support for Arduino Nano and Raspberry Pi Pico
- Scraper bulk processing capabilities