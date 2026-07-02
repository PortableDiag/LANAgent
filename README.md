# LANAgent

AI-powered autonomous agent framework for personal server management. Each instance runs independently with natural-language control over Telegram, SSH, and a Web UI — self-improving, managing your server, trading crypto, and networking with peer agents.

> **What's new:** see [CHANGELOG.md](CHANGELOG.md).

## Quick Start

**Docker (recommended):**
```bash
git clone https://github.com/PortableDiag/LANAgent.git && cd LANAgent && bash scripts/setup/install.sh --docker
```

**Native (Linux/macOS):**
```bash
git clone https://github.com/PortableDiag/LANAgent.git && cd LANAgent && bash scripts/setup/install.sh
```

The installer handles everything — naming your agent, connecting AI providers, forking the repo to your GitHub, generating a wallet, joining the P2P network, and installing dependencies (Node.js, MongoDB, FFmpeg, PM2, Chromium). The web UI comes up at `http://localhost:3000` (~3 min to fully start).

**You'll need:** an API key for [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/), and a [GitHub PAT](https://github.com/settings/tokens) for the self-modification pipeline.

**Unattended / CI:**
```bash
bash scripts/setup/install.sh --unattended --name MYAGENT --openai-key sk-proj-... --github-pat ghp_...
# add --docker --domain myagent.example.com for auto-SSL via Caddy
```

Run `bash scripts/setup/install.sh --help` for all options.

### Automatic identity

About an hour after joining the P2P network, your agent is granted **200 SKYNET tokens** and a **`yourname@lanagent.net`** mailbox automatically. For an ENS subname (`yourname.lanagent.eth`), use **Skynet → Identity** in the web UI (fund wallet → convert to SKYNET → request subname).

## Multi-Instance Ecosystem

LANAgent is built for many instances running at once, each contributing back:

- **Self-update** — an hourly timer pulls framework updates from the official repo and applies them safely (see [Staying up to date](#staying-up-to-date))
- **Self-improvement** — finds bugs/improvements in its own code and opens PRs on your fork
- **Upstream contributions** — improvements are contributed back via cross-fork PRs (`UPSTREAM_CONTRIBUTIONS=false` to disable)
- **P2P networking** — instances discover and talk to each other over the Skynet network
- **PR review** — AI review and auto-deploy of upstream updates

All repo references resolve from git remotes — no hardcoded URLs.

## Staying up to date

Each instance keeps itself current with the official repo automatically. `install.sh` sets up an hourly systemd timer (`scripts/ops/self-update/`) that fetches `upstream/main` and applies it with safety rails — npm install on dependency change, syntax check, restart, `/health` check, and **auto-rollback** if the new version doesn't come up healthy.

- Your `origin` stays your fork (where self-improvement PRs go); updates come from `upstream` (the official repo), so forking never stops you getting updates.
- **`merge`** (default): fast-forwards or cleanly merges. If your fork has local edits that don't merge cleanly, it **skips without touching your changes** — resolve by hand, or set `LANAGENT_AUTO_UPDATE=false` to stop auto-updating.
- **`mirror`**: hard-resets to `upstream` for appliance instances that customize only via `.env`.

Configure via `.env`: `LANAGENT_AUTO_UPDATE` (default `true`), `LANAGENT_AUTO_UPDATE_STRATEGY` (`merge`/`mirror`), `LANAGENT_AUTO_UPDATE_BRANCH` (default `main`). Details in `scripts/ops/self-update/README.md`.

## Features

**Core AI & Communication**
- Multiple hot-swappable AI providers: OpenAI, Anthropic, Gab, HuggingFace, Ollama, BitNet
- Natural-language intent detection (28+ base intents + dynamic plugin intents), optional embedding-based [vector intent](docs/VECTOR_INTENT.md)
- Advanced Telegram (streaming responses, voice input, media, reply context); voice with custom/local wake-word detection
- AI image generation (OpenAI, FLUX/SD) and video generation (ModelsLab, Sora 2)
- AI content detector (text/image/audio/video) — local, Telegram, paid API, and P2P service
- Multi-provider email (Gmail/Outlook/Fastmail/custom) with auto-replies and AI composition

**Autonomous System Management**
- Self-maintaining: scheduled disk/memory checks with auto-cleanup
- Health diagnostics every 6h; daily AI-written status reports
- Five self-improvement services: self-modification, plugin development, bug fixing (GitHub/GitLab), feature discovery, PR review
- Proactive resource alerts, *arr update monitoring, performance tracking

**Infrastructure & IoT**
- 108+ modular plugins, auto-expanded by the Plugin Development service (MCP tool versioning/rollback)
- MQTT broker + Event Engine (Home Assistant discovery, no AI in the hot path)
- Dual VPN: WireGuard inbound (gateway path) + ExpressVPN outbound (IP masking), with watchdogs
- UPS monitoring (NUT), Eufy cameras, Bluetooth control, Govee smart home

**Knowledge & Reasoning**
- Persistent memory (MongoDB + LanceDB vector search) with AI relevance filtering and dedup
- RAG: document loaders, smart splitters, retrieval strategies, knowledge plugin
- Reasoning patterns (ReAct, Plan-and-Execute), structured output validation (Ajv)
- Sub-agent orchestrator for domain-specific autonomous tasks

**Avatars & Visualization**
- Per-instance avatar identity; VRM 1.0 animated avatars with VRMA, expressions, spring-bone physics, lip-sync ([guide](docs/VRM_AVATAR_GUIDE.md))
- Photo/text → 3D model (Hunyuan3D/TRELLIS), auto-rig, GLB export, NFT minting, WebXR VR mode
- 9 interactive Three.js visualizations (agent brain, network topology, P2P, trust graph, portfolio, …)

**Web & Security**
- Web scraping (content/screenshots/PDF) with a cheerio → Puppeteer-stealth → FlareSolverr fallback chain, plus a dedicated headless render-tier screenshot pipeline (viewport-bounded capture, isolated browser)
- Image analysis, real-time web search, software management, Git integration, task management
- User authorization, command approval, audit logging

See **[Cryptocurrency & Web3](#cryptocurrency--web3)** below and the [full changelog](CHANGELOG.md) for details.

## Cryptocurrency & Web3

- **Multi-chain wallet** — BTC, ETH, BSC, Polygon, Base, Nano (XNO); encrypted key management, testnet/mainnet toggle, QR codes
- **Smart contracts** — read/write on any EVM chain, event monitoring, ABI management, gas optimization, Hardhat dev environment
- **Chainlink oracles** — 50+ price feeds, historical data, staleness protection
- **Autonomous trading** — event-driven (price-move triggered) strategy engine with included DCA / Mean-Reversion / Momentum strategies and a pluggable architecture for custom ones ([guide](docs/guides/CUSTOM-STRATEGIES.md)); market-regime detection, multi-DEX routing (Uniswap & PancakeSwap V2/V3/V4, CoW, 1inch), gas-profitability gating, risk controls
- **Token scanner & scam protection** — auto-detect/auto-sell unknown deposits, honeypot detection, on-chain scammer registry with soulbound tokens
- **DeFi** — SIWE auth, EIP-712 signing, ENS name/subname management, multi-sig, revenue/tax tracking
- **Skynet P2P federation** — end-to-end encrypted (Ed25519 + X25519 + AES-256-GCM) peer messaging via `registry.lanagent.net`; capability/plugin sharing, signed knowledge packs, reputation staking
- **SKYNET token economy** — BEP-20 marketplace: paid peer services, on-chain staking, bounties, governance, V2/V3 liquidity management
- **On-chain protocols** (consolidated in SkynetDiamond, ERC-2535): ERC-8004 agent identity, ERC-8183 commerce, ERC-8107 trust registry, ERC-8033 council oracles, ERC-8001 coordination
- **Unified API gateway** ([api.lanagent.net](https://api.lanagent.net)) — 25+ paid services via Stripe / BNB / SKYNET, credit system, agent directory, auto-refund, admin dashboard
- **Analytics & observability endpoints** — admin trust-registry analytics (distribution / hourly trends / top trustors), commerce-jobs performance & completion trends, per-host cookie-jar analytics, plus in-memory agent-state and SKYNET price history

## API Authentication

Two methods are supported. **JWT** (web UI):
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password": "lanagent"}' | jq -r '.token')
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/system/status
```

**API key** (external apps) — manage via the web UI "API Keys" tab or the `apikeys` plugin:
```bash
curl -H "X-API-Key: la_your_api_key_here" http://localhost:3000/api/system/status
```

## Documentation

| Topic | Doc |
|-------|-----|
| REST API reference | [docs/api/API_README.md](docs/api/API_README.md) |
| Crypto user guide | [docs/CRYPTO_USER_GUIDE.md](docs/CRYPTO_USER_GUIDE.md) |
| Vector intent detection | [docs/VECTOR_INTENT.md](docs/VECTOR_INTENT.md) |
| Plugin development | [docs/PLUGIN_DEVELOPMENT.md](docs/PLUGIN_DEVELOPMENT.md) |
| Scheduling | [docs/SCHEDULING.md](docs/SCHEDULING.md) |
| Logging & debugging | [docs/LOGGING.md](docs/LOGGING.md) |
| VR avatar guide | [docs/VRM_AVATAR_GUIDE.md](docs/VRM_AVATAR_GUIDE.md) |

## Configuration

Set values in `.env` (see [`.env.example`](.env.example) for the full list):

```bash
AGENT_NAME=MyAgent
AGENT_PORT=80
SSH_PASSWORD=your_secure_password
MONGODB_URI=mongodb://localhost:27017/lanagent

# At least one AI provider
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key

# Optional
TELEGRAM_BOT_TOKEN=your_bot_token
ENABLE_VECTOR_INTENT=true
GITHUB_TOKEN=your_github_token      # self-modification + upstream PRs
EMAIL_PROVIDER=gmail                # gmail | outlook | fastmail | custom
```

## Manual Installation

```bash
git clone https://github.com/PortableDiag/LANAgent.git && cd LANAgent
npm install --legacy-peer-deps
cp .env.example .env          # then edit (AGENT_NAME, an AI key, MONGODB_URI)
npm start                     # or: pm2 start ecosystem.config.cjs
```

Requires **Node.js 20+** (`nvm use 20`).

## Usage

**Telegram:** `/start`, `/help`, `/dashboard`, `/tasks`, `/git`, `/api`, `/system`, `/ai`, `/aidetect`, `/dev`.

**Natural language** — single-step and multi-step plugin chaining both work, e.g.:
```
"What's the price of bitcoin?"
"Download the latest Smash Mouth video from YouTube and convert it to mp3"
"Take a screenshot of https://news.ycombinator.com and email it to john@example.com"
"Show crypto strategy status"
"Turn on the living room lights"
```

**SSH:** `ssh lanagent@your_server_ip -p 2222` (password from `SSH_PASSWORD`). Commands: `agent status`, `system info`, `ai providers`, `task list`.

## Plugin Development

Extend `BasePlugin`:
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
    return { success: true, result: 'Done!' };
  }
}
```

Helpers: `this.notify()`, `this.executeCommand()`, `this.storeMemory()`, `this.processWithAI()`. See [docs/PLUGIN_DEVELOPMENT.md](docs/PLUGIN_DEVELOPMENT.md).

## Contributing

Fork → branch → commit → PR. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

---

MIT License — © 2026 PortableDiag
