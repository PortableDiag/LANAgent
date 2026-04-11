# LANAgent

AI-powered autonomous agent framework for personal server management. Each instance runs independently with natural language control via Telegram, SSH, and Web interfaces — self-improving, trading crypto, networking with peers, and contributing improvements back upstream.

## Quick Start

**Docker (recommended):**
```bash
git clone https://github.com/PortableDiag/LANAgent.git && cd LANAgent && bash scripts/setup/install.sh --docker
```

**Native Linux/macOS:**
```bash
git clone https://github.com/PortableDiag/LANAgent.git && cd LANAgent && bash scripts/setup/install.sh
```

That's it. The installer handles everything — naming your agent, connecting AI providers, forking the repo to your GitHub, generating a wallet, joining the P2P network, and installing all dependencies (Node.js, MongoDB, FFmpeg, PM2, Chromium). When it's done, your agent starts automatically.

> **You just need:** An API key for [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/), and a [GitHub PAT](https://github.com/settings/tokens) for the self-modification pipeline.

Your agent's web UI will be at `http://localhost:3000` (or `https://yourdomain.com` if you used `--domain`). Takes ~3 minutes to fully start.

**Unattended / CI deploy:**
```bash
git clone https://github.com/PortableDiag/LANAgent.git && cd LANAgent
bash scripts/setup/install.sh --unattended --name MYAGENT --openai-key sk-proj-... --github-pat ghp_...
```

**With HTTPS (auto-SSL via Caddy):**
```bash
bash scripts/setup/install.sh --docker --unattended --name MYAGENT --openai-key sk-proj-... --domain myagent.example.com
```

Run `bash scripts/setup/install.sh --help` for all options.

### Get your identity (automatic)

After ~1 hour of being connected to the P2P network, your agent automatically receives:
- **200 SKYNET tokens** — free welcome package from the genesis agent
- **yourname@lanagent.net email** — automatically provisioned, no setup needed

For an **ENS subname** (yourname.lanagent.eth), go to **Skynet > Identity** in the web UI:
1. Send BNB to your agent's wallet address (shown on the page)
2. Click **Convert BNB to SKYNET** (one-click PancakeSwap swap)
3. Click **Request Subname** (costs SKYNET based on Ethereum gas)

## Multi-Instance Ecosystem

LANAgent is designed for many instances to run simultaneously, each contributing to the project:

- **Upstream sync**: Your instance automatically pulls updates from the genesis repo every 30 minutes
- **Self-improvement**: Discovers bugs and improvements in its own code, creates PRs on your fork
- **Upstream contributions**: Improvements are automatically contributed back to the main project via cross-fork PRs (enabled by default, set `UPSTREAM_CONTRIBUTIONS=false` to disable)
- **P2P networking**: Instances discover and communicate with each other via the Skynet P2P network
- **PR review**: AI-powered review and auto-deployment of upstream updates (enabled by default)

All repo references are resolved dynamically from git remotes — no hardcoded URLs to change.

## Features

### Core AI & Communication
- 🤖 **Multiple AI Providers**: OpenAI, Anthropic, Gab, HuggingFace, Ollama, BitNet (hot-swappable)
- 🔎 **AI Content Detector**: Detect AI-generated text, images, video, and audio. Uses the selected AI provider for text analysis and a ViT model for image detection. Available locally, via Telegram `/aidetect`, as a paid external API, and as a P2P Skynet service.
- 🧠 **AI Intent Detection**: Intelligent natural language understanding with 28+ base intents + dynamic plugin intents, graceful parameter extraction error handling
- 🚀 **Vector Intent Detection**: Embedding-based intent matching using OpenAI for lightning-fast, accurate command recognition
  - **Automatic intent indexing**: Plugin intents are automatically indexed when plugins are loaded or enabled
  - **Dynamic intent management**: Intents are removed when plugins are disabled or unloaded
  - **Action-type semantic enrichment**: Embedding text includes operation keywords (retrieve/add/delete/search) for better separation of same-plugin intents
  - **Post-match disambiguation**: Keyword-based correction for *arr plugins ensures list/search/add/delete actions route correctly even when vector similarity is close
  - **Per-plugin thresholds**: High-confusion plugins (e.g., Dry.AI with many similar CRUD actions) use elevated similarity thresholds to reduce misrouting
  - **Destructive action safety net**: Delete-intent keywords override vector similarity when matched to non-delete actions, preventing accidental data modification
- 💬 **Advanced Telegram**: Large message handling, markdown support, multi-media, voice message input, reply context awareness, **streaming AI responses** via Bot API 9.5 `sendMessageDraft`
- 🎤 **Voice Integration**: Text-to-speech with HuggingFace/OpenAI, Telegram voice responses, Web UI mic input
  - **Custom Wake Word Training**: Train personalized wake word models using your own voice via Telegram
  - **Local Wake Word Detection**: Privacy-focused detection using OpenWakeWord - audio only sent to cloud after local confirmation
  - **Hands-free Interaction**: Speak directly to server microphone with wake word activation
  - **Persistent Voice Toggle**: Web UI toggle for wake word listening - state survives restarts
- 🖼️ **Image Generation**: AI-powered image creation via natural language
  - OpenAI (GPT-Image-1, DALL-E 3/2) and HuggingFace (FLUX.1, Stable Diffusion 3, SDXL)
  - Configurable settings in Web UI with per-image cost tracking
- 🎬 **Video Generation**: AI-powered video creation via natural language
  - ModelsLab (Wan 2.1/2.2, CogVideoX, WanX — no content moderation), OpenAI Sora 2, HuggingFace Wan 2.1 T2V
  - Pay-as-you-go pricing ($0.20/video Ultra, $0.08 Standard), background generation with Telegram delivery
- 📧 **Email Integration**: Multi-provider email support (Gmail, Outlook, Fastmail, custom SMTP/IMAP) with background checking, auto-replies, AI-powered email composition with web search, and multi-language verification detection (EN/IT/PT/NL)
- 🔄 **Multi-Channel Notifications**: Reminders via Telegram, email, or both

### Autonomous System Management
- 🖥️ **Self-Maintaining**: Hourly disk/memory checks with automatic cleanup  
- 🏥 **Enhanced Diagnostics**: Comprehensive health monitoring with API endpoint testing
  - Runs every 6 hours via Agenda task scheduler
  - Tests system resources, database, API endpoints, interfaces, and services
  - Auto-generates secure API key for self-testing
  - 10-minute startup delay prevents false alerts during initialization
  - Dedicated diagnostics.log for tracking health history
- 📊 **Daily Status Reports**: Comprehensive automated reports with AI usage stats, crypto activity, media stats, self-improvement metrics, scheduled job analysis, and memory activity breakdown
- 🔧 **Self-Improvement**: Five autonomous services for continuous enhancement
  - Self-Modification: Improves existing code quality, creates PRs on your fork
  - Plugin Development: Discovers and implements new APIs (enabled by default)
  - Bug Fixing: Automatically resolves issues with PR/MR fixes (supports GitHub and GitLab)
  - Feature Discovery: Centralized feature discovery from git repositories (runs twice daily)
  - PR Review: AI-powered autonomous review, merge, and deployment of pull/merge requests (disabled by default)
  - **Cross-Fork Upstream PRs**: Improvements are automatically contributed back to the upstream repo
  - **Upstream Sync**: Forked instances auto-receive updates from the genesis repo every 30 minutes
- 🚨 **Proactive Alerts**: Immediate notifications for resource issues
- 📦 **ARR Service Update Monitoring**: Daily check for Prowlarr, Radarr, Sonarr, Lidarr, Readarr updates with Telegram notifications — flags major version bumps
- 🗂️ **Development Plan Auto-Archive**: Daily Agenda job (`archive-old-dev-items`, 02:30) archives `completed` items older than 30 days
- 📧 **Email Lease Expiration Warnings**: Daily Agenda job (`email-lease-expiration-warnings`, 09:00) warns lease holders 7 days before expiry via the existing email plugin
- 💾 **Performance Tracking**: Continuous system stats for maintenance decisions

### Advanced Capabilities  
- 🔍 **Real-time Web Search**: Live crypto/stock prices, weather, general queries
- 💰 **Smart Crypto Support**: ANY cryptocurrency via intelligent search
- 📦 **Software Management**: Install/compile/manage packages with root access
- 🐙 **Git Integration**: Repository management with natural language commands
- 📋 **Task Management**: Create, track, prioritize tasks with automatic reminders and intelligent cleanup
- 🔌 **Plugin System**: 108+ modular plugins with automatic expansion via Plugin Development Service
  - **MCP Tool Versioning**: Version tracking and rollback for MCP-registered tools
- 🏠 **MQTT & Home Automation**: Built-in MQTT broker with Event Engine for IoT control
  - Aedes MQTT broker (TCP port 1883, WebSocket port 9883)
  - Home Assistant MQTT Discovery auto-detection
  - Event-driven automation rules (NO AI in hot path for cost efficiency)
  - Natural language device control: "turn on the living room light"
  - Device state tracking with time-series history
- 🔒 **Dual VPN Management**: WireGuard (inbound) + ExpressVPN (outbound) running simultaneously
  - WireGuard tunnel provides the reverse-proxy path for api.lanagent.net ERC-8004 gateway traffic
  - ExpressVPN hides the server's real IP for scrapes, API calls, and IP hopping to avoid blocks
  - wg0.conf PostUp/PostDown hooks manage coexistence: static route for WG endpoint + iptables exception in ExpressVPN's kill-switch chain
  - WireGuard watchdog Agenda job (every 2 min): auto-bounces tunnel if handshake stale (>3 min) or peer unreachable
  - netcheck systemd watchdog (every 30s): monitors ExpressVPN connection + DNS, auto-recovers, locks resolv.conf to prevent DNS hijacking
  - Web UI shows both providers: ExpressVPN status (location, IP, protocol) + WireGuard status (endpoint, handshake age, transfer, peer ping)
  - API routes: `/vpn/api/status` (both), `/vpn/api/wireguard/status`, `/vpn/api/wireguard/bounce`, `/vpn/api/wireguard/health`
- 🔋 **UPS Monitoring (NUT)**: Monitor UPS power devices via Network UPS Tools
  - Battery status, runtime remaining, load percentage, voltage monitoring
  - Power event notifications (on battery, low battery, power restored)
  - Severity-based notification routing: configurable channels per severity level (low→email, medium→email+telegram, high→telegram+webhook)
  - Auto-shutdown capability when battery critical (disabled by default)
  - Event history and statistics tracking
  - Natural language: "what's my UPS status?", "how much battery is left?"
- 📹 **Eufy Security Cameras**: Direct P2P integration with Eufy cameras via `eufy-security-client`
  - On-demand snapshots from any camera, delivered via Telegram
  - Motion and person detection alerts with configurable per-device throttling
  - Device listing with battery status, model info, and serial numbers
  - 2FA authentication flow via Telegram (code entry inline)
  - Persistent sessions — re-auth only needed once
  - Natural language: "show me the front door camera", "enable camera alerts", "list cameras"
- 📶 **Bluetooth Control**: Manage Bluetooth devices from the server
  - Scan for nearby devices, pair/unpair, connect/disconnect
  - Device tracking with connection history and statistics
  - RSSI-based indoor positioning with trilateration (3+ access points)
  - Natural language: "scan for bluetooth devices", "connect to my headphones"
  - Web UI for device management
- 🖼️ **Agent Avatar**: Per-instance visual identity with API serving, Web UI management, and system prompt self-awareness
  - **VRM Animated Avatar**: 10 VRM 1.0 models with 49 VRMA animations, facial expressions, eye tracking, spring bone physics, and lip sync
  - **3D Avatar Designer**: Upload photo → generate 3D GLB model via HuggingFace Spaces (Hunyuan3D-2.1, TRELLIS), or pick a VRM model, or upload your own VRM
  - **Playground**: Interactive 3D page — chat with agent, emote studio, mirror mode (VR + webcam), VR floating menu
  - **Update Avatar Everywhere**: Renders bust portrait and syncs to agent profile, Gravatar, Telegram, and ERC-8004 NFT
  - Server-side VRM persistence via `GET/PUT /api/agent/vrm`
  - Gallery, customization, VRM selection, and NFT minting at `/avatar.html`
  - Public avatar endpoint (no auth) for use in NFTs, emails, profiles
  - Upload via Settings tab or API (base64 JSON, max 5MB)
  - Auto-detected from `data/agent/` on startup
  - Gravatar OAuth2 integration — one-click browser authorization for avatar sync
  - Auto-crops non-square images before Gravatar upload
  - NLP intents: "sync avatar to gravatar", "show me your avatar", "change your profile picture"
- 🧠 **Persistent Memory**: MongoDB-backed knowledge storage with LanceDB vector search
  - Regex fast-pass for explicit patterns (name, preference, work, location, facts)
  - AI relevance filter via active provider for subtle personal facts, opinions, and instructions
  - Pre-filters skip commands, URLs, and short messages before AI analysis
  - Automatic deduplication (0.85 similarity threshold) and vector-indexed semantic search
  - Personal question detection recalls memories before intent routing — "what is my name?" answers from stored knowledge
  - Access tracking: recalled memories increment access counters for relevance ranking
- 📚 **RAG (Retrieval-Augmented Generation)**: LangChain-inspired knowledge management
  - Document loaders: PDF, Text, Web, Markdown, JSON
  - Smart text splitters: Recursive, Semantic, Code-aware, Sentence
  - Retrieval strategies: Similarity, MMR, Hybrid, Contextual Compression
  - Knowledge plugin for natural language queries and document ingestion
- 🤖 **Agent Reasoning Patterns**: Advanced problem-solving capabilities
  - ReAct (Reasoning + Acting): Interleaved thinking and acting loop with context-aware error logging
  - Plan-and-Execute: Create plans upfront with replanning on errors
  - Thought persistence for learning from past reasoning traces
- 📊 **Structured Output Parsing**: JSON schema validation with Ajv
  - Pre-defined schemas for intents, chains, and plugin parameters
  - Automatic format instructions for LLM prompts
- 🦙 **Ollama Provider**: Local LLM support for privacy and cost savings
  - Chat, embedding, and vision model support
  - Zero-cost inference with local models
- 🤖 **Sub-Agent Orchestrator**: Autonomous agent system for domain-specific tasks
  - Domain agents (crypto, data analysis, etc.) with specialized handlers
  - **Event-driven execution**: `dispatchEvent()` routes domain events to agents via `schedule.eventTriggers`
  - **Session Resilience**: 10-minute execution timeout, stale session recovery on startup, force-reset fallback
  - Project and task agents for workflow automation
  - Scheduling with hourly, daily, custom, or event-driven patterns
  - Approval workflow for high-impact actions
  - Cost tracking and budget management
  - Learning from past executions
  - CryptoStrategyAgent: Autonomous trading with Chainlink oracle prices, RSI analysis, LLM decision-making
  - **Event-Driven Trading**: Chainlink price monitor (5-min) triggers execution on >1% moves instead of blind timers
  - **Multi-Strategy System**: Pluggable strategy architecture with 3 included strategies (DCA, Mean Reversion, Momentum) and support for custom strategies — see [Custom Strategies Guide](docs/guides/CUSTOM-STRATEGIES.md)
  - **Market Regime Detection**: Dollar Maximizer assesses market regime from 72h price history, trend strength, and RSI to dynamically widen buy thresholds in downtrends and tighten in uptrends
  - **Token Trader**: Secondary strategy for speculative token trading with grid-based entries, trailing stops (4.5% PUMP, 5% MOON, 8% standard), regime detection, progressive scale-out at [10, 20, 25, 30, 40, 50]% gain levels, pump stall detection (10% sell after 6hr without next level), post-dump cooldown, config version migration (v8), forced V3 routing for small-cap tokens, graduated DUMP sell (50% on hourly spike, 100% only on hard stop-loss), grid buy trend gates (short/long-term trend checks), emergency sell buy-back cooldown, escalating grid buy cooldowns, consecutive grid buy cap, avg entry price sanity checks, and reliable manual exit via Web UI
  - **Per-Token Heartbeats**: Each token trader instance runs its own independent timer with regime-based intervals (DUMP=1m to COOLDOWN=15m), concurrency semaphore, per-network swap mutex, error backoff, and shared market data cache
  - **DEX Routing**: 5-way price comparison across V2, V3, V4, CoW Protocol, and 1inch — best price wins. Uniswap V4 (Ethereum + BSC) and PancakeSwap Infinity (BSC) quote in parallel. V4 multi-hop via WBNB and native BNB (address(0)) intermediaries, CLAMM hooked pool support
  - **CoW Protocol (CoW Swap)**: Intent-based DEX aggregator for Ethereum, Base, and Arbitrum. MEV/sandwich attack protection via batch auctions. Solver competition ensures best execution. Urgent sells (stop-loss, trailing stop) skip CoW for instant on-chain execution. $10 minimum order value
  - **Dead Token Detection**: Tokens with no DEX liquidity are detected via swap path analysis and permanently skipped after 3 failures
  - **Rule-Based Strategy Engine**: Declarative JSON rules with 50+ indicators (price, time, technical, moon, market, position), condition operators (equals, between, greaterThan, matches, etc.), logical combinators (all/any/not), custom indicators with cycle detection, and simulation mode
  - **Strategy Import/Export**: Universal Strategy Format (.strategy.json) with versioning, checksum validation, sensitive data sanitization, and bundle support for backup/sharing
  - **Gas Cost Tracking**: Captures actual gas costs from swap receipts, deducts from PnL, and tracks cumulative gas spend. Pre-trade gate requires $1+ net value after gas for buys and $1+ net profit after gas for sells (emergency sells bypass)
  - **P&L History Chart**: D3 cumulative line chart in P&L Dashboard with area gradient, hover tooltips, configurable range (7d–1yr). Backfilled from trade logs, auto-updated every 15 minutes from live token trader positions
  - **Dynamic Risk Assessment**: Liquidity-based slippage tolerance and volatility-based position sizing on BaseStrategy
  - **Batch Transaction Confirmations**: `Promise.allSettled`-based parallel transaction waiting with per-tx error handling
  - **Gas Profitability**: Estimates swap gas cost in USD before executing; skips trades where profit < 2x gas cost (stop-loss bypasses this)
  - **Network Controls**: Per-network enable/disable toggle in Web UI, low-balance auto-skip (e.g., skip Ethereum if wallet < $50)
  - **Volatility-Adjusted MA Periods**: Momentum strategy dynamically adjusts moving average periods based on market volatility
  - **Baseline Staleness Auto-Reset**: Automatically resets stale price baselines to enable trading when markets shift
  - **Strategy Evolution**: Self-modification for trading strategies with performance tracking and automated improvements
- 🔗 **Skynet — P2P Federation (LANP)**: Connect multiple LANAgent instances via end-to-end encrypted relay
  - Registry server at `registry.lanagent.net` routes encrypted messages between instances behind NAT
  - Ed25519 signing + X25519 ECDH + AES-256-GCM encryption — registry sees only opaque blobs
  - Automatic peer discovery via introduction protocol — new peers exchange keys on first contact, no manual setup
  - Capabilities exchange, plugin sharing with chunked transfer and SHA-256 verification
  - **Knowledge Packs**: Structured, signed memory packages for sharing expertise between agents
    - Create packs from existing memories with query filters (type, tags, importance)
    - AI safety evaluation before auto-import (checks for malicious content, PII, social engineering)
    - Content validation: type restriction, size limits, executable code scanning
    - Web UI with Available, Pending Approval, My Packs, and Imported views
  - **SKYNET Token Economy**: BEP-20 token on BSC powering the peer-to-peer marketplace
    - Paid services: peers expose plugin commands with per-operation SKYNET pricing
    - Payment verification: BEP-20 Transfer event parsing, double-spend prevention, 3-block confirmations
    - Reputation staking: composite trust scores (0-100) based on SKYNET balance, ERC-8004, SENTINEL tokens, longevity, activity
    - On-chain staking: Synthetix-style staking contract with proportional yield, 7-day epochs auto-funded from registry fee income
    - NLP staking control: "stake 5000 SKYNET", "claim my rewards", "check staking status" via intents 119-122
    - Bounty system: post tasks with SKYNET rewards, claim and complete workflow
    - Governance: token-weighted proposal voting (for/against/abstain)
    - V2 liquidity management: add/remove liquidity, position tracking, pool share monitoring
    - V3 autonomous market maker: concentrated liquidity with auto-rebalance, fee collection, circuit breakers, and Telegram alerts
  - **Email Lease Service**: P2P email account provisioning — genesis provisions `username@lanagent.net` accounts for fork agents
    - SKYNET token payment with on-chain verification, configurable pricing
    - HMAC-SHA256 authenticated Mail Management API on docker-mailserver
    - Auto-pay, renewal, revocation, expired lease cleanup
    - Admin API for lease management, stats, and password resets
  - Source code sanitization strips all credentials, paths, IPs before sharing
  - Trust levels per peer: auto-install plugins from trusted peers, manual approval for untrusted
  - Web UI Skynet page with peer management, transfer history, knowledge packs, services, economy, and settings
  - Enable/disable from web UI toggle (no restart required) or via `P2P_ENABLED=true` env var
- 🔒 **Security**: User authorization, command approval, audit logging
- 🌐 **Web Scraping**: Extract content, take screenshots, generate PDFs from any URL
- 👁️ **Image Analysis**: Describe images, detect objects, extract text using AI
- 💰 **Cryptocurrency Wallet**: Full multi-chain wallet with BTC/ETH/BSC/Polygon/Base support, smart contract interaction, DeFi operations, testnet faucets, HD wallet generation, and secure key management

**Latest (v2.24.8):** Installer auto-fork and auto-dependency install, Docker self-modification support, PancakeSwap slippage protection, MIT license. See [CHANGELOG.md](CHANGELOG.md) for full history.

## API Authentication

LANAgent supports two authentication methods for API access:

### JWT Token Authentication (for Web UI)
```bash
# Get JWT token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "lanagent"}' | jq -r '.token')

# Use JWT token
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/system/status
```

### API Key Authentication (for External Apps)
```bash
# Use API key with X-API-Key header
curl -H "X-API-Key: la_your_api_key_here" http://localhost:3000/api/system/status

# Or use Authorization header
curl -H "Authorization: ApiKey la_your_api_key_here" http://localhost:3000/api/system/status

# Create API key via agent
curl -H "X-API-Key: la_your_existing_key" -X POST http://localhost:3000/api/plugin \
  -H "Content-Type: application/json" \
  -d '{"plugin": "apikeys", "action": "create", "params": {"name": "My App"}}'
```

API keys can be managed through:
- Web UI: Navigate to the "API Keys" tab
- Agent Plugin: Use the `apikeys` plugin with create/list/revoke/delete actions

## Debugging & Monitoring

LANAgent features an **organized logging system** for easy debugging:

### 📁 Log Structure (`logs/logs/`)
- **`all-activity.log`** - Complete timeline view (human-readable)
- **`errors.log`** - Critical issues only
- **`crypto.log`** - Crypto strategy and trading activity
- **`self-modification.log`** - Self-modification service debugging
- **`bug-detection.log`** - Bug detection and security scanning
- **`diagnostics.log`** - System health checks and API endpoint testing
- **`api-web.log`** - Web interface and API calls
- **`plugins.log`** - Plugin activity (plus per-plugin logs in `plugins/`)
- **`structured.json`** - Machine-readable format for automated analysis

**Note:** The base filename (e.g., `crypto.log`) is always the active log file. Numbered files (e.g., `crypto1.log`) are older rotations. The Logs page dynamically displays all available logs (excluding archived/rotated files).

### 🔍 Quick Debugging Commands
```bash
# Quick error check
tail -20 logs/logs/errors.log

# Service-specific debugging
tail -50 logs/logs/self-modification.log
tail -50 logs/logs/bug-detection.log
tail -50 logs/logs/api-web.log

# Live monitoring
tail -f logs/logs/all-activity.log
```

**📖 See [docs/LOGGING.md](docs/LOGGING.md) for complete debugging guide**

## Cryptocurrency Features

LANAgent includes a comprehensive Web3 and cryptocurrency system with:

### 🔐 **Multi-Chain Wallet**
- Bitcoin, Ethereum, BSC, Polygon, Base, **Nano (XNO)** support
- Secure key management with hardware encryption
- Testnet/Mainnet mode switching
- QR codes for easy mobile access
- Nano: feeless instant transactions, auto-receive monitor, faucet integration

### 📊 **Smart Contract Interaction**
- Read/write contract functions on any EVM chain
- Real-time event monitoring and notifications
- ABI management and contract verification
- Gas optimization and transaction simulation

### 🔗 **Chainlink Oracle Integration**
- 50+ price feeds across multiple networks
- Historical price data queries
- Decentralized data aggregation
- LINK token management

### 💼 **DeFi & Web3 Features**
- SIWE (Sign-In With Ethereum) authentication
- EIP-712 typed data signatures
- **ENS Name Management**: Register `.eth` names, create subnames for multi-agent setups, auto-renew before expiry, **Web UI Identity tab** for one-click subname + email requests via P2P
    - P2P subname provisioning: forked instances auto-request subnames from genesis peer (e.g., `fork.lanagent.eth`)
    - Optional SKYNET token pricing for subname creation (configurable per-instance, default free)
    - NLP control: "what is my ENS name", "get me an ENS subname", "request subname coolbot"
    - **Identity tab** (Skynet > Identity): Wallet funding (send BNB → convert to SKYNET), ENS subname request (`name.lanagent.eth`), email lease request (`name@lanagent.net`) — all via P2P to genesis agent, 100 SKYNET each
    - Name collision auto-fallback with fingerprint suffix, pending payment retry on daily schedule
  - Registered: `lanagent.eth` (base) + `alice.lanagent.eth` (subname)
  - Cross-chain resolution: names resolve on BSC, Ethereum, and all EVM chains
  - NameWrapper integration for gasless subname creation
- Multi-signature wallet support
- Revenue tracking and tax reporting

### 📈 **Autonomous Trading Strategy**
- Event-driven execution: Chainlink price monitor (5-min) dispatches events on >1% price moves
- Heartbeat (30-min) ensures time-based strategies like DCA run in flat markets
- 3 included strategies (DCA, Mean Reversion, Momentum) with a pluggable architecture for building your own
- Market regime detection: composite scoring from 72h price slope, trend strength, and RSI dynamically adjusts buy thresholds
- Token Trader secondary strategy for speculative tokens with **multi-token simultaneous trading**, grid trading, trailing stops, progressive scale-out levels, pump stall detection, grid buy trend gates, emergency sell cooldown, escalating grid cooldowns, consecutive buy caps, avg entry sanity checks, and autonomous watchlist rotation with composite scoring (60% volatility, 25% liquidity, 15% momentum), fail-count tolerance (3-strike removal with system token immunity), and minimum score threshold
- Multi-network support: Ethereum, BSC, Polygon with network-specific thresholds
- Chainlink as primary price source with CoinGecko fallback
- DEX swaps via Uniswap V2/V3/V4, PancakeSwap V2/V3/V4 (Infinity) with V4 > V3 > V2 preference, dual-protocol V4 quoting on BSC (PCS Infinity + Uniswap V4), CLAMM hooked pool support with native BNB address(0) intermediary routing, 1inch Aggregator fallback for tokens with no direct DEX path, and Telegram notifications
- Cross-DEX arbitrage: V2/V3/V4 cross-protocol and intra-V3 fee-tier scanning with native pair (WBNB↔stablecoin) arb detection, configurable token list, and Web UI management (SKYNET included in default scan tokens)
- V3 LP Market Maker: autonomous SKYNET/BNB concentrated liquidity with ±20% range, auto-rebalance on drift, hourly fee collection, 5/day circuit breaker, auto-open when enabled with no position, and capital isolation from trading strategies
- Volatility-triggered fast scanning: >3% price moves reduce arb scan intervals for faster opportunity detection
- Gas profitability checks prevent unprofitable micro-trades on high-gas networks
- Residual token sweep with retry limiting: illiquid tokens auto-skipped after 3 failed sell cycles
- Per-network trading controls: disable/enable Ethereum, BSC via Web UI (persisted in MongoDB)
- Position reconciliation: wallet balance synced every heartbeat, unmanaged native auto-detected
- Risk management: max trade %, daily loss limits, emergency stop, gas reserve protection
- Auto gas top-up: swaps stablecoins to native when gas reserves drop below 50%, preventing stuck strategies
- Token decimal auto-detection: on-chain metadata lookup for accurate quotes (6-decimal USDT/USDC)
- Testnet/mainnet mode toggle with graceful empty wallet handling

### 🔍 **Token Scanner & Scam Protection**
- Automatic detection of incoming token transfers with deposit tracking
- Auto-sell of unknown/airdrop tokens via chunked progressive sell (100% → 0.01%)
- 99% slippage tolerance for fee-on-transfer tokens with hidden taxes
- Rate-limit-aware sell execution with backoff delays and 24h cooldown for failed sells
- Honeypot detection via sell simulation on DEX routers and on-chain revert detection (reverted swap transactions treated as honeypot indicators)
- Scam token identification (name patterns, dust attacks, blacklists)
- Whitelist for verified tokens (USDC, USDT, DAI, WETH, WBNB, WMATIC)
- Safe vs unsafe token classification with detailed warnings
- **On-Chain Scammer Registry**: BSC smart contract for flagging scammer addresses with soulbound tokens
  - Report scammers via NLP ("report 0x1234 as scammer address poisoning") or REST API
  - SCAMMER soulbound token minted to flagged address (visible on BscScan)
  - SENTINEL soulbound token minted to reporter as reputation badge
  - SENTINEL tokens boost P2P trust score (+5 per token, up to +15)
  - 7 scam categories: Address Poisoning, Phishing, Honeypot, Rug Pull, Fake Contract, Dust Attack, Other
  - SKYNET token fee for reporting (adjustable by genesis agent)
  - 2-of-3 immunity system: ERC-8004 identity, SKYNET balance, active stake
  - Batch reporting (up to 50 addresses per transaction)
  - Genesis agent (ERC-8004 #2930) can remove false positives
  - **Automatic Scam Token Reporting**: Agent autonomously detects and reports scam tokens to the registry
    - Confidence scoring: honeypot (50pts), scam name (40pts), no code (20pts), dust (15pts)
    - Requires 2+ signals (threshold 50) — "no swap path" alone never triggers
    - Batch-reports at end of each sweep cycle, WebUI toggle (enabled by default)
  - **USD-Anchored Fee Auto-Pricing**: The genesis instance continuously anchors `reportFee` and `immunityThreshold` to a USD target via the shared SKYNET/USD oracle (PancakeSwap LP reserves × Chainlink BNB/USD)
    - Hourly Agenda jobs `skynet-auto-price-fee` and `skynet-auto-price-immunity`
    - 25% drift gate + 24h hard rate limit prevent gas burn on small price wiggles
    - Min/max SKYNET clamps protect against oracle anomalies
    - Pre-flight `_isGenesisInstance()` check (signer vs `OwnershipFacet.owner()`) so forks silently no-op — only the canonical genesis instance drives the fee
    - Defaults: $0.50 flag fee, $50 immunity threshold. Kill switch per-param via `skynet.scammerFee.autoPrice` / `skynet.immunityThreshold.autoPrice` SystemSettings keys
  - **Fee-to-Staking Flywheel**: Registry reporting fees automatically fund staking reward epochs
    - On-chain detection of `ScammerRegistered` events (self + external reporters)
    - Isolated `registryFees` ledger prevents mixing with LP/treasury/reserve funds
    - Configurable threshold, routing percent, and epoch duration via API
  - **Passive Safety Layer**: Local cache of flagged addresses synced every 4 hours from on-chain registry
    - Token deposits from flagged senders are silently ignored
    - DEX swaps blocked if either token address is flagged
    - Outbound sends and contract interactions blocked to flagged addresses
    - Graceful degradation: if registry unavailable, all operations proceed normally

### 🪪 **ERC-8004 Agent Identity**
- On-chain identity NFT for AI agents on BSC (or Ethereum) — Agent #2930
- Registration file generator with agent capabilities, plugins, and metadata
- IPFS hosting via Pinata (avatar + registration JSON)
- Mint, update, and view identity NFT from Web UI or API
- NFT card display in Web UI — avatar, chain badge, metadata grid, BscScan/IPFS links
- Wallet linking via EIP-712 signed `setAgentWallet()` on-chain call
- Telegram integration — ask ALICE to show her NFT identity
- Staleness detection — notifies when on-chain registration is outdated
- Pinata API key management with encrypted database storage

### 🌐 **Unified API Gateway (api.lanagent.net)**
- 97+ paid services (17 plugins, 90+ commands, 8 dedicated routes) via unified gateway at `https://api.lanagent.net`
- **Three payment methods**: Stripe (credit card), BNB, or SKYNET — no crypto knowledge required
- **Agent directory**: `GET /agents` lists all network agents; `POST /agents/:id/:service` routes to specific agent
- **ERC-8004 endpoints**: each agent at `api.lanagent.net/agents/{agentId}`
- **Auto-discovery**: gateway polls P2P registry for new agents every 5 minutes
- **Credit system**: wallet auth or email signup → purchase credits → use across all services
- Dynamic USD-pegged pricing, auto-refund on failures, batch operations (100 URLs)
- **Services**: Chainlink price feeds (97 feeds, 7 networks + CoinGecko fallback), HuggingFace AI (13 NLP/vision tasks), image processing (optimize/resize/crop/convert/watermark via Sharp), token profiler (honeypot/scam detection), wallet profiler (risk scoring), contract auditor (Solidity security), challenge questions (bot filtering), AI content detector (text/image/audio/video), real web search (Anthropic/OpenAI), YouTube download (MP4/MP3), media transcoding, AI image gen, web scraping, document OCR, code sandbox, PDF toolkit, weather, stocks, crypto prices, lyrics, NASA, anime, news
- **Code Sandbox**: Execute Python, Node.js, Bash, Ruby, Go, PHP, Java, Rust in isolated Docker containers with full network/filesystem/resource isolation
- **PDF Toolkit**: Merge, split, compress (Ghostscript), watermark, and text extraction
- VPS reverse proxy with WireGuard tunnel, nginx path whitelist, Let's Encrypt SSL
- Admin dashboard with service management, kill switch, revenue tracking, audit log
- Real-time Telegram notifications when external agents make payments
- NLP intent: "show external service stats" — query revenue, payments, usage, and service status
- NLP intents for SKYNET: "what is SKYNET?" (knowledge), "show skynet network status" (live peers/bounties/proposals), "show SKYNET token ledger" (live allocations/payments)

### 🤝 **ERC-8183 Agentic Commerce**
- On-chain job escrow for agent-to-agent commerce on BSC
- Hire-deliver-settle pattern: Client posts job with BNB escrow, Provider delivers, settlement via evaluation
- Mode A (API-initiated): Create jobs via REST API with budget, description, and expiry
- Mode B (contract-initiated): Auto-accept incoming on-chain jobs matching agent capabilities
- Self-evaluation for Phase 1, third-party evaluator support planned
- Revenue tracking integrated with existing analytics
- Scammer registry check before accepting any job
- Trust registry integration: successful jobs accumulate trust (3→Marginal, 10→Full, 2 failures→None)
- All protocols consolidated into SkynetDiamond (ERC-2535)

### 🔐 **ERC-8107 ENS Trust Registry**
- On-chain trust graph with ENS names as node identifiers on BSC
- Trust levels: Unknown, None, Marginal, Full — scoped by domain (COMMERCE, P2P, ORACLE, NETWORK)
- BFS trust path discovery between any two agents
- Staking-based trust boost: staked SKYNET or LP tokens increase effective trust level
- Consolidated into SkynetDiamond TrustFacet

### 🔮 **ERC-8033 Agent Council Oracles**
- Decentralized oracle system where AI agents answer queries via commit-reveal consensus
- Bonds in BNB or SKYNET — loser bonds route to staking pool
- Consolidated into SkynetDiamond OracleFacet

### 🤖 **ERC-8001 Multi-Agent Coordination**
- Intent-based coordination protocol for multi-agent operations on BSC
- Optional BNB/SKYNET bond deposits, slash conditions route to staking pool
- Consolidated into SkynetDiamond CoordinationFacet

**All on-chain protocols:** SkynetDiamond `0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7` (BSC mainnet) — ERC-2535 Diamond Proxy with 15 facets, 151 function selectors, fully upgradeable

### Paid API Gateway (api.lanagent.net)
- **75+ plugin commands** via generic proxy: `POST /service/:plugin/:action`
- 15 plugins: anime (6), chainlink (5), challengeQuestions (4), contractAudit (3), lyrics (3), nasa (8), news (4), tokenProfiler (4), walletProfiler (3), websearch (5), huggingface (13), scraper (5), ytdlp (6), ffmpeg (6), aiDetector (5)
- 13 dedicated service endpoints: scrape, YouTube, image gen, code sandbox, OCR, PDF x4, transcode, price x5
- Dynamic service catalog: `GET /service/catalog`
- Auto-pricing every 15 minutes from PancakeSwap LP reserves + Chainlink BNB/USD oracle (toggle in UI, `skynet.autoPriceEnabled` SystemSetting)
- Stripe live payments ($5/400, $15/1300, $50/4700 credits) + BNB/SKYNET crypto payments
- Auto-refund on failures, API key regeneration
- Revenue dashboard with payment log, usage chart (24h/7d/14d), service breakdown
- Web3 staking DApp on skynettoken.com
- **Autonomous LP staking** — auto-claim rewards, auto re-stake at Tier 3 on lock expiry, compound SKYNET into regular staking. All configurable per instance via SystemSettings.
- PancakeSwap V2 SKYNET/BNB liquidity pool with LP staking
- Token economics: SKYNET treasury managed via SkynetDiamond
- **SKYNET Telegram Bot** (`@SkynetAPIBot`) — public API showcase, 30+ commands, auto-credit purchase, on-chain event broadcasting to @skynet_events, token transfer tracking to @skynet_tracker, MindSwarm rich embeds, cashtag price tooltips
- **Identity onboarding** — Skynet > Identity tab: send BNB → convert to SKYNET → request ENS subname + email lease in three clicks

### 🎭 **VR Avatar System**
- **Avatar Designer** at `/avatar.html` — full 3D viewer/designer with Three.js r140
  - **VRM Tab**: 10 VRM 1.0 models with 49 VRMA animations — pick one and it animates with motion-captured idle
  - Upload custom VRM files from VRoid Studio or VRoid Hub
  - **Set as Active Avatar** — persists in MongoDB, loads automatically across pages/devices
  - **Update Agent Avatar Everywhere** — renders bust portrait, syncs to profile, Gravatar, Telegram, ERC-8004 NFT
  - Facial expressions dynamically built from each model's presets (happy, angry, sad, etc.)
  - Eye tracking: avatar eyes follow mouse cursor or VR headset position
  - Spring bone physics: hair and clothing react to movement
  - Lip sync: Web Audio FFT analysis drives VRM visemes (aa, oh, ee, ih, ou) in sync with TTS audio
  - Gallery, create (photo/prompt to 3D), auto-rig, export GLB, mint NFT
  - WebXR VR mode with full controller interactions
- **Playground** at `/playground.html` — interactive 3D agent interaction
  - **Free Play**: Chat with agent in 3D, random animation reactions per response
  - **Emote Studio**: Trigger expressions and animations on your agent
  - **Mirror Mode**: VR headset/controller tracking mirrors movements onto avatar, webcam MediaPipe Pose fallback
  - **VR Floating Menu**: Press B/Y to open, point-and-click to trigger animations and expressions
  - Scale/position controls, mobile responsive collapsible panel
  - Future activities stubbed: Dance, Exercise, Sparring, Games, Meditation
- Three.js r140 self-hosted with @pixiv/three-vrm v1.0
- 49 VRMA animations from VRoid Hub (official mocap), tk256ailab, DavinciDreams (Mixamo conversions)
- Photo/text-to-3D avatar creation via Python bridge (Hunyuan3D-2.1 → Hunyuan3D-2 → TRELLIS cascade)
- Auto-rigging via Blender headless — fully local, no external API costs
- NFT minting as ERC-721 on BSC with IPFS pinning via nft.storage
- Avatar gallery with rename, delete, and export (GLB format)
- See `docs/VRM_AVATAR_GUIDE.md` for adding models and animations
- Contract: `0x91Eab4Dd5C769330B6e6ed827714A66136d24842` (BSC mainnet)

### 📊 **Protocol Dashboard**
- ERC-8033, ERC-8107, and ERC-8001 protocol status cards in Web UI crypto page
- Live stats: oracle win rate/earnings, trust scopes/levels, coordination active/total counts
- Domain tags and coordination type badges with graceful "Not Configured" fallback

### 📊 **3D Visualizations**
- 9 interactive Three.js visualizations at `/visualizations.html` with click-to-show info cards
- **Agent Brain**: Dynamic neural network built from live `/api/system/status` — shows all running services and interfaces
- **Network Topology**: Force-directed 3D graph of LAN devices with trust-based coloring, pulsing glow rings on self node
- **P2P Network**: Federation peers as orbiting nodes — trust level, transfer count, ERC-8004 verification
- **Email Contacts**: Email communication graph from sent+received history — sized by message count, colored by direction
- **Crypto Token Space**: Real portfolio from `/api/crypto/portfolio` — tokens sized by USD value, colored by 24h performance
- **Trust Graph**: Real ERC-8107 attestation data from trust registry — nodes colored by trust level, edges by scope
- **Wallet Graph**: On-chain wallet interaction graph with EOA/contract/scammer classification
- **Plugin Constellation**: All plugins grouped by category (crypto, network, media, dev, AI, etc.) — sized by command count
- **Log Waterfall**: Matrix-rain style real-time log display color-coded by severity
- Click any node for detailed info card panel (IP, balance, trust score, commands, etc.)
- OrbitControls for camera navigation, auto-resize, lazy-loaded tabs, cache-busting
- WebXR VR mode with full controller interactions: grip-to-grab, trigger-to-select, thumbstick locomotion, snap-turn, two-grip scale/rotate, 3D info cards visible inside headset

### 🛠️ **Smart Contract Development**
- Integrated Hardhat environment
- Pre-built contract templates (ERC-20, ERC-721, etc.)
- Automated testing and deployment
- Contract verification on Etherscan

## Documentation

### AI & Intent Detection
- **Vector Intent Detection** — Embedding-based intent matching (see [docs/VECTOR_INTENT.md](docs/VECTOR_INTENT.md))

### Cryptocurrency & Smart Contracts
- **[Crypto User Guide](docs/CRYPTO_USER_GUIDE.md)** — Complete guide for using wallet and blockchain features

### On-Chain Protocols
- **ERC-8183 Commerce** — Agentic commerce job escrow on BSC
- **ERC-8107 Trust Registry** — ENS-based trust graph
- **ERC-8033 Oracle** — Agent council oracle system
- **ERC-8001 Coordination** — Multi-agent coordination
- **VR Avatar System** — Avatar creation and VR environment (see [VRM Avatar Guide](docs/VRM_AVATAR_GUIDE.md))

### API Documentation
- **[Main API Documentation](docs/api/API_README.md)** - Complete REST API reference
- **[Plugin Development](docs/PLUGIN_DEVELOPMENT.md)** - Guide for creating custom plugins
- **[Scheduling Documentation](docs/SCHEDULING.md)** - Task and job scheduling details

## Project Structure

```
LANAgent/
├── src/                      # Source code
│   ├── core/                 # Core agent functionality
│   ├── interfaces/           # Communication interfaces
│   │   ├── telegram/         # Telegram bot (enhanced dashboard)
│   │   ├── ssh/             # SSH server interface
│   │   └── web/             # Web dashboard
│   ├── api/                 # Plugin system
│   │   ├── core/            # Base classes and manager
│   │   └── plugins/         # Available plugins
│   │       ├── tasks.js     # Task management
│   │       ├── email.js     # Email integration
│   │       ├── git.js       # Git operations
│   │       ├── websearch.js # Web search and real-time data
│   │       ├── system.js    # System management (restart/redeploy)
│   │       ├── development.js # Development planning
│   │       ├── software.js  # Software package management
│   │       └── docker.js    # Docker orchestration
│   ├── models/              # MongoDB schemas
│   ├── providers/           # AI provider integrations
│   ├── services/            # Agent services
│   │   ├── avatar/          # VR avatar service
│   └── utils/               # Utilities (paths.js, logger, retry)
├── scripts/                 # Helper scripts
│   ├── deployment/          # Deployment scripts
│   └── setup/               # Install wizard & setup scripts
├── docs/                    # Documentation
│   ├── api/                 # API documentation
│   │   ├── API_README.md    # Main API documentation
│   │   └── CRYPTO_API.md    # Cryptocurrency & Smart Contract APIs
│   ├── CRYPTO_USER_GUIDE.md # User guide for crypto features
│   └── CRYPTO_TESTING_GUIDE.md # Testing guide for crypto features
├── Dockerfile              # Docker image definition
├── docker-compose.yml      # Multi-service Docker setup
├── CONTRIBUTING.md         # Contribution guide for humans & agents
├── SECURITY.md             # Security practices
├── package.json            # Node.js dependencies
└── .env.example            # Environment variables template
```

## Command Examples

### Natural Language Queries

#### Single-Step Operations
```bash
# System Information  
"How much memory does your system have available?"
"What's the disk usage on the server?"
"Show me CPU stats"

# Cryptocurrency & Stock Prices (Real-time with Anthropic web search)
"What's the price of bitcoin?"
"How much is chainlink worth?"
"AAPL stock price"
"Show me ethereum value"
"What's the weather in Eureka, CA today?"

# Scammer Registry
"Is 0x1234...abcd a scammer?"
"Report 0x1234...abcd as scammer address poisoning"
"Show scammer registry stats"
"Remove 0x1234...abcd from scammer registry"

#### Multi-Step Plugin Chaining (NEW!)
```bash
# Download + Convert Operations
"Download the latest music video from YouTube and convert it to mp3"
"Get smash mouth all star video and send it to me as an mp4"

# Search + Task Management
"Search for current bitcoin price and create a task to check it tomorrow"
"Look up Tesla stock price and remind me to check it in 1 hour"

# Web Scraping + Email
"Take a screenshot of https://news.ycombinator.com and email it to john@example.com"
"Scrape the content from that website and send me a summary via email"

# Complex Workflows
"Download video, convert to audio, and create a task to organize my music library"
```

#### Single-Step Operations Continued
```bash
# Multi-Channel Reminders
"Remind me to check logs in 30 minutes via email"
"Set reminder to call mom in 1 hour via both"  
"Remind me to deploy in 45 minutes" (defaults to telegram)

# Software Management
"Install ffmpeg"
"Compile neovim from source" 
"Is docker installed?"
"Update system packages"

# Git Operations
"Git status"
"Commit changes with message: fix bug"
"Pull latest updates"

# Email & Tasks
"Send email to john@example.com about meeting"
"Check my emails"
"Add task: backup server database [high priority]"
"Send email to alice@example.com with attachment /home/report.pdf"
"Email the monthly report at /tmp/report.xlsx to the team"
"Schedule email to bob@example.com tomorrow at 9am with subject 'Daily Report'"
"Send recurring email to team@example.com every Monday at 9am"

# Web Scraping & Analysis
"What's on this page https://example.com"
"Analyze https://github.com/trending"
"Take a screenshot of https://news.ycombinator.com"
"Extract content from this URL: https://example.com/article"

# Cryptocurrency & Smart Contracts
"Show my wallet addresses"
"Check ETH balance on all networks"
"Send 100 SKYNET to 0x..."
"Send 0.01 BNB to 0x..."
"Sign message 'Hello Web3' with Ethereum key"
"Get ETH/USD price from Chainlink oracle"
"Monitor USDC transfers to my address"
"Create SIWE authentication message"
"Generate crypto tax report for 2024"
"Read totalSupply from contract 0x..."
"Deploy new ERC-20 token called MyToken"
"Check gas prices on Ethereum"
"Import transactions for revenue tracking"
"Set up price alert when BTC drops below $40k"
"Check AAVE lending APY for USDC"
"Monitor Uniswap ETH/USDC pool reserves"

# Autonomous Trading Strategy
"Show crypto strategy status"
"Enable trading strategy"
"Trigger strategy analysis"
"Set strategy to testnet mode"
"Emergency stop trading"
"Show strategy decision journal"
"Swap 0.01 BNB to BUSD on BSC testnet"

# Sub-Agent Orchestrator
"List my sub-agents"
"Create a crypto strategy agent"
"Run the crypto agent"
"Show agent status"
"Pause the trading agent"
"Get agent history for crypto"

# Bug Tracking & Code Analysis
"Scan the code for bugs"
"Create a bug report for the email sending issue"
"List all high severity bugs"
"Show me bugs found by the agent"
"Create a GitHub issue for bug #123456"

# Image Recognition
# (Send an image to the bot)
"What's in this image?"
"Analyze this photo"
# The bot will describe objects, text, and notable features

# MindSwarm Social Network (auto-registers, AI-driven engagement)
"Post on mindswarm: Just set up a new automation pipeline!"
"Check my mindswarm feed"
"What's trending on mindswarm?"
"Reply to that mindswarm post"
"Search mindswarm for AI topics"
"Check mindswarm notifications"
"Configure mindswarm engagement"
# Agent auto-registers, verifies email, sets up profile + avatar
# AI decides: like/reply/ignore based on sentiment analysis
# Auto-replies to DMs, deflects financial questions, promotes Skynet
# Daily auto-post about recent activity (Agenda-scheduled, Telegram notification to owner)
# Sensitive content filter: auto-excludes proposals, outreach, business plans, pricing from posts
# 153+ commands: posts, DMs, lists, drafts, AI features, groups CRUD, moderation, analytics, ads, admin, push notifications, support tickets, developer apps, data export

# Smart Home Control (Govee)
"Turn on the living room lights"
"Turn my master toilet light green"
"Set bedroom light brightness to 50%"
"Make all lights bright white"
"Set kitchen lights to warm white"
"Apply sunset scene to living room"
"Create a schedule to turn on lights at 6am"
"Turn off all lights in the house"
"Set movie theme for the living room"
"Backup all my device settings"
```

### Manual Installation

If you prefer manual setup over the install wizard:

1. Clone:
```bash
git clone https://github.com/PortableDiag/LANAgent.git && cd LANAgent
```

2. Install dependencies:
```bash
npm install --legacy-peer-deps
```

3. Configure environment:
```bash
cp .env.example .env
# Edit .env — at minimum set AGENT_NAME, ANTHROPIC_API_KEY or OPENAI_API_KEY, MONGODB_URI
# Set UPSTREAM_REPO=https://github.com/PortableDiag/LANAgent for auto-sync
# Set GIT_PERSONAL_ACCESS_TOKEN for self-modification and upstream contributions
```

4. Start the agent:
```bash
npm start
# Or with PM2: pm2 start ecosystem.config.cjs
```

### Development

Requires Node.js 20+:
```bash
nvm use 20
```

## Configuration

Required environment variables in `.env`:
```
# Agent Configuration
AGENT_NAME=ALICE
AGENT_PORT=80
AGENT_SSH_PORT=2222
SSH_PASSWORD=your_secure_password

# MongoDB
MONGODB_URI=mongodb://localhost:27017/lanagent

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_USER_ID=your_user_id

# AI Providers (at least one required)
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
ANTHROPIC_ENABLE_WEB_SEARCH=true  # Enable web search for Claude (default: true)

# Vector Intent Detection (optional)
ENABLE_VECTOR_INTENT=true  # Enable embedding-based intent detection (default: false)

# Optional: Email Integration (supports: gmail, outlook, hotmail, fastmail, custom)
EMAIL_PROVIDER=gmail
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_app_password
# For custom/self-hosted providers:
# EMAIL_SMTP_HOST=mail.yourdomain.com
# EMAIL_SMTP_PORT=587
# EMAIL_IMAP_HOST=mail.yourdomain.com
# EMAIL_IMAP_PORT=993

# Optional: Git Hosting Integration (supports: github, gitlab)
GIT_HOSTING_PROVIDER=github  # or gitlab
GITHUB_TOKEN=your_github_token
# For GitLab (alternative to GitHub):
# GITLAB_TOKEN=your_gitlab_token
# GITLAB_URL=https://gitlab.com  # or self-hosted URL
# GITLAB_PROJECT_ID=owner/repo

# Optional: Rate Limiting
DEVICE_ALIAS_RATE_LIMIT=100  # Max requests per 15 minutes for device alias API (default: 100)
```

## Usage

### Telegram Commands
- `/start` - Welcome message
- `/help` - Show all commands and examples
- `/dashboard` - System status dashboard
- `/tasks` - Task management interface
- `/git` - Git repository status and controls
- `/api` - Manage API plugins
- `/system` - System controls
- `/network` - Network tools
- `/ai` - AI provider management
- `/restart` - Restart agent (master only)
- `/aidetect` - AI content detection mode (text/image/audio/video)
- `/dev` - Development planning (master only)

### Natural Language Examples
```
"Show system status"
"Add task: Deploy new feature to production"
"List all high priority tasks"
"Complete task 123456"
"Show git status"
"Commit changes with message: Add API plugin system"
"Push to remote"
"Enable email plugin"
"Send email to user@example.com"
"What is the price of Bitcoin?"
"Stock price of AAPL"
"Weather in New York"
"Search the web for latest AI news"
```

### SSH Access
```bash
ssh lanagent@your_server_ip -p 2222
# Password from SSH_PASSWORD in .env
```

Available SSH commands:
- `agent status` - Agent information
- `system info` - System details
- `ai providers` - List AI providers
- `task list` - Show tasks

## Plugin Development

Create a new plugin by extending the BasePlugin class:

```javascript
import { BasePlugin } from '../core/basePlugin.js';

export default class MyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'myplugin';
    this.version = '1.0.0';
    this.description = 'My custom plugin';
  }

  async execute(params) {
    const { action, ...data } = params;
    
    // Your plugin logic here
    return { success: true, result: 'Done!' };
  }
}
```

### Available Helper Methods
- `this.notify(message)` - Send Telegram notification
- `this.executeCommand(cmd)` - Run system commands
- `this.storeMemory(key, value)` - Store in agent memory
- `this.processWithAI(prompt)` - Use AI for processing

## Production Deployment

The agent runs as a PM2 process. To update:

```bash
cd /path/to/LANAgent
git pull
npm install --legacy-peer-deps
pm2 restart lan-agent
```

Check status:
```bash
pm2 status lan-agent
```

## API Plugin System

### Built-in Plugins

1. **Tasks Plugin**
   - Create, update, delete, complete tasks
   - Set priorities and due dates
   - Recurring tasks with patterns
   - Reminders and notifications

2. **Email Plugin**
   - Gmail integration
   - Templates (welcome, reminder, report) + custom templates
   - Bulk email sending
   - AI-generated email content
   - Smart greeting detection
   - File attachments support (paths or objects)
   - Scheduled and recurring emails
   - Dynamic variable substitution in templates

3. **Git Plugin**
   - Repository management
   - Commit with AI-generated messages
   - Push/pull with auth token support
   - Branch management
   - GitHub issue creation and management
   - Status and diff viewing

4. **Projects Plugin**
   - Project management and tracking
   - Git-based version history and rollback per project
   - Bug tracking system with CRUD operations
   - Severity and status management
   - Integration with GitHub issues
   - Filtering and search capabilities

5. **Bug Detector Plugin**
   - Automated code analysis and bug detection
   - 8+ built-in detection patterns (security vulnerabilities, missing error handling, input validation, etc.)
   - Daily automated scanning at 2:00 AM
   - Robust duplicate prevention using SHA-256 fingerprints
   - GitHub issue integration with duplicate detection
   - Path normalization for consistent bug tracking
   - Self-bug detection capabilities with AI provider agnostic processing
   - Real-time scan progress tracking with status indicator
   - GetScanProgress action for monitoring current scan status
   - Critical-severity bug notifications sent immediately via agent notification system

6. **Web Search Plugin**
   - Real-time web search via OpenAI
   - Stock market prices (e.g., AAPL, TSLA)
   - Cryptocurrency prices (BTC, ETH, etc.)
   - Weather information by location
   - General information queries

7. **Lyrics Plugin**
   - Song lyrics lookup via free APIs (LRCLIB + lyrics.ovh fallback)
   - Direct lookup by artist + title
   - Search by query (partial lyrics, song names)
   - Time-synced LRC lyrics for timed display
   - Results cached, no API key required
   - Lyrics stored in conversation context for follow-up questions

8. **Govee Plugin**
   - Complete Govee smart home device control
   - Natural language commands: "turn my master toilet light green", "set brightness to 50%"
   - Color control with 25+ named colors and compound colors ("bright white", "dark blue")
   - Brightness control with percentage support
   - Color temperature control (warm/cool white)
   - Scene application from device presets
   - Device groups for controlling multiple devices
   - Predefined themes (relax, party, movie, romance)
   - Schedule creation with color/brightness/on/off support
   - Backup and restore device settings
   - Real-time device status monitoring
   - MQTT event subscriptions
   - Web UI with visual controls

9. **Jellyfin Plugin**
   - Full Jellyfin media server management with 30 commands
   - Browse libraries, search media, manage users, control playback
   - Active session monitoring (who is watching what)
   - Playlist management, scheduled tasks, activity logs
   - TV show support: seasons, episodes, next-up queue
   - Configurable via Settings tab (server URL + API key)

10. **Eufy Security Camera Plugin**
    - Direct integration with Eufy cameras (cloud + P2P via `eufy-security-client`)
    - 5 commands: setup, devices, snapshot, alerts, status
    - On-demand snapshots delivered as Telegram photos
    - Motion/person detection alerts with per-device throttle
    - 2FA authentication handled inline via Telegram
    - Session persistence across restarts (no re-auth needed)

11. **Calibre Plugin**
    - Browse and search Calibre eBook libraries with 15 commands
    - Search by title, author, tag, series, publisher, or rating
    - Get book details, available formats, and download links
    - Browse all library categories with fuzzy matching
    - Recently added books, library statistics
    - Configurable via Settings tab (server URL + optional auth)

### Managing Plugins

Via Telegram:
- `/api` - Show all plugins with status
- Click "Manage Plugins" to enable/disable

Via Natural Language:
- "Enable git plugin"
- "Disable email plugin"
- "Show plugin status"

## Contributing

1. Fork the repository (PortableDiag/LANAgent)
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (AI can help: "commit: auto")
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Current Status

- ✅ Core agent with all interfaces operational
- ✅ MongoDB integration with models
- ✅ Telegram bot with full command set
- ✅ SSH server with authentication
- ✅ API plugin system with 108 plugins (tasks, email, git, websearch, system, software, monitoring, network, samba, docker, microcontroller, projects, bugDetector, ffmpeg, ytdlp, development, ssh, vpn, systemAdmin, voice, scraper, sendgrid, virustotal, documentIntelligence, calendar, devenv, backupStrategy, thingsboard, thingspeak, nasa, slack, govee, subagents, crypto, chainlink, music, lyrics, twitter, jellyfin, calibre, radarr, sonarr, lidarr, readarr, prowlarr, and more)
- ✅ Natural language processing
- ✅ Multi-AI provider support
- ✅ Web UI dashboard (fully functional with all features)
- ✅ All planned features implemented

---

MIT License — © 2026 PortableDiag