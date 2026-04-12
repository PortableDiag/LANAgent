#!/bin/bash
#
# LANAgent Installation Wizard
# Sets up a new LANAgent instance from scratch
#
# Usage:
#   ./scripts/setup/install.sh           # Interactive setup
#   ./scripts/setup/install.sh --docker  # Docker-based setup
#   ./scripts/setup/install.sh --quick   # Minimal setup (just AI key + agent name)
#

set -e

# ─── Colors & Formatting ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── Helpers ──────────────────────────────────────────────────────────
print_header() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}  ${BOLD}LANAgent Setup Wizard${NC}                           ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  ${DIM}Autonomous Agent Framework${NC}                       ${CYAN}║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_step() {
    local step=$1
    local total=$2
    local title=$3
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}  Step ${step}/${total}: ${title}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

ask() {
    local prompt=$1
    local default=$2
    local var_name=$3

    if [ -n "$default" ]; then
        echo -ne "  ${prompt} ${DIM}[${default}]${NC}: "
    else
        echo -ne "  ${prompt}: "
    fi

    read -r input
    if [ -z "$input" ] && [ -n "$default" ]; then
        eval "$var_name=\"$default\""
    else
        eval "$var_name=\"$input\""
    fi
}

ask_secret() {
    local prompt=$1
    local var_name=$2
    echo -ne "  ${prompt}: "
    read -rs input
    echo ""
    eval "$var_name=\"$input\""
}

ask_yn() {
    local prompt=$1
    local default=$2
    local var_name=$3

    if [ "$default" = "y" ]; then
        echo -ne "  ${prompt} ${DIM}[Y/n]${NC}: "
    else
        echo -ne "  ${prompt} ${DIM}[y/N]${NC}: "
    fi

    read -r input
    input=${input:-$default}
    if [[ "$input" =~ ^[Yy] ]]; then
        eval "$var_name=true"
    else
        eval "$var_name=false"
    fi
}

generate_secret() {
    openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64
}

generate_api_key() {
    local random=$(openssl rand -base64 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null)
    echo "la_${random}"
}

# ─── Detect Script Location ──────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── Parse Arguments ─────────────────────────────────────────────────
DOCKER_MODE=false
QUICK_MODE=false
UNATTENDED=false

# Unattended mode pre-set values
_NAME="" _PORT="" _SSH_PORT=""
_ANTHROPIC_KEY="" _OPENAI_KEY="" _GITHUB_PAT=""
_P2P_URL="" _MONGO_URI="" _NO_P2P=false _NO_START=false _DOMAIN=""
_OLLAMA_URL="" _LOCAL_AI=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --docker)       DOCKER_MODE=true ;;
        --quick)        QUICK_MODE=true ;;
        --unattended)   UNATTENDED=true; QUICK_MODE=true ;;
        --name)         _NAME="$2"; shift ;;
        --name=*)       _NAME="${1#*=}" ;;
        --port)         _PORT="$2"; shift ;;
        --port=*)       _PORT="${1#*=}" ;;
        --ssh-port)     _SSH_PORT="$2"; shift ;;
        --ssh-port=*)   _SSH_PORT="${1#*=}" ;;
        --anthropic-key) _ANTHROPIC_KEY="$2"; shift ;;
        --anthropic-key=*) _ANTHROPIC_KEY="${1#*=}" ;;
        --openai-key)   _OPENAI_KEY="$2"; shift ;;
        --openai-key=*) _OPENAI_KEY="${1#*=}" ;;
        --github-pat)   _GITHUB_PAT="$2"; shift ;;
        --github-pat=*) _GITHUB_PAT="${1#*=}" ;;
        --p2p-url)      _P2P_URL="$2"; shift ;;
        --p2p-url=*)    _P2P_URL="${1#*=}" ;;
        --mongo-uri)    _MONGO_URI="$2"; shift ;;
        --mongo-uri=*)  _MONGO_URI="${1#*=}" ;;
        --domain)       _DOMAIN="$2"; shift ;;
        --domain=*)     _DOMAIN="${1#*=}" ;;
        --ollama-url)   _OLLAMA_URL="$2"; _LOCAL_AI=true; shift ;;
        --ollama-url=*) _OLLAMA_URL="${1#*=}"; _LOCAL_AI=true ;;
        --local-ai)     _LOCAL_AI=true ;;
        --no-p2p)       _NO_P2P=true ;;
        --no-start)     _NO_START=true ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Modes:"
            echo "  --docker        Configure for Docker deployment"
            echo "  --quick         Minimal setup (agent name + AI key only)"
            echo "  --unattended    Non-interactive install (requires --name + an AI key)"
            echo ""
            echo "Options (for --unattended or to pre-fill interactive prompts):"
            echo "  --name NAME             Agent name (default: LANAgent)"
            echo "  --port PORT             Web UI port (default: 3000)"
            echo "  --ssh-port PORT         SSH port (default: 2222)"
            echo "  --anthropic-key KEY     Anthropic API key"
            echo "  --openai-key KEY        OpenAI API key"
            echo "  --github-pat TOKEN      GitHub PAT for self-modification + auto-fork"
            echo "  --p2p-url URL           Public URL for P2P (auto-detected if omitted)"
            echo "  --mongo-uri URI         MongoDB URI (default: mongodb://localhost:27017/agentname)"
            echo "  --domain DOMAIN         Domain name for auto-SSL (e.g. myagent.example.com)"
            echo "  --ollama-url URL        Ollama server URL (default: http://localhost:11434)"
            echo "  --local-ai              Use local AI (Ollama) instead of cloud providers"
            echo "  --no-p2p                Disable P2P networking"
            echo "  --no-start              Don't start the agent after install"
            echo ""
            echo "Examples:"
            echo "  # Interactive install"
            echo "  ./install.sh"
            echo ""
            echo "  # Docker, fully automated"
            echo "  ./install.sh --unattended --docker --name MYAGENT --openai-key sk-proj-..."
            echo ""
            echo "  # Native, with GitHub self-mod"
            echo "  ./install.sh --unattended --name MYAGENT --openai-key sk-proj-... --github-pat ghp_..."
            exit 0
            ;;
    esac
    shift
done

# Validate unattended mode
if [ "$UNATTENDED" = "true" ]; then
    if [ -z "$_ANTHROPIC_KEY" ] && [ -z "$_OPENAI_KEY" ] && [ "$_LOCAL_AI" != "true" ]; then
        fail "Unattended mode requires --anthropic-key, --openai-key, or --local-ai"
        exit 1
    fi
    _NAME="${_NAME:-LANAgent}"
    if [ -z "$_PORT" ]; then
        _PORT=$( [ "$(id -u)" = "0" ] && echo "80" || echo "3000" )
    fi
    _SSH_PORT="${_SSH_PORT:-2222}"
fi

# ─── Main ─────────────────────────────────────────────────────────────
print_header

# Check if .env already exists
if [ -f "$PROJECT_ROOT/.env" ]; then
    warn ".env file already exists!"
    if [ "$UNATTENDED" = "true" ]; then
        OVERWRITE=true
    else
        ask_yn "Overwrite existing configuration?" "n" OVERWRITE
    fi
    if [ "$OVERWRITE" != "true" ]; then
        info "Keeping existing .env. Exiting."
        exit 0
    fi
    cp "$PROJECT_ROOT/.env" "$PROJECT_ROOT/.env.backup.$(date +%s)"
    ok "Backed up existing .env"
fi

# ═══════════════════════════════════════════════════
# STEP 1: System Dependencies Check
# ═══════════════════════════════════════════════════
TOTAL_STEPS=10

print_step 1 $TOTAL_STEPS "System Dependencies"

MISSING_DEPS=()

# Docker mode skips Node/npm/MongoDB checks — container handles them
if [ "$DOCKER_MODE" = "true" ]; then
    # Only need Docker and Git on the host
    if command -v docker &>/dev/null; then
        ok "Docker $(docker --version 2>/dev/null | head -1 | sed 's/Docker version //')"
        if docker compose version &>/dev/null 2>&1 || command -v docker-compose &>/dev/null; then
            ok "Docker Compose found"
        else
            info "Installing Docker Compose..."
            apt-get install -y -qq docker-compose-v2 &>/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin &>/dev/null 2>&1 || pip3 install docker-compose &>/dev/null 2>&1
            if docker compose version &>/dev/null 2>&1 || command -v docker-compose &>/dev/null; then
                ok "Docker Compose installed"
            else
                fail "Docker Compose not found"
                MISSING_DEPS+=("docker-compose")
            fi
        fi
    else
        info "Installing Docker..."
        if curl -fsSL https://get.docker.com | sh &>/dev/null 2>&1 && command -v docker &>/dev/null; then
            ok "Docker installed"
            # Also install Docker Compose if not bundled
            if ! docker compose version &>/dev/null 2>&1; then
                apt-get install -y -qq docker-compose-v2 &>/dev/null 2>&1 || true
            fi
            if docker compose version &>/dev/null 2>&1; then
                ok "Docker Compose found"
            else
                fail "Docker Compose not found"
                MISSING_DEPS+=("docker-compose")
            fi
        else
            fail "Docker installation failed"
            MISSING_DEPS+=("docker")
        fi
    fi
    ok "Node.js 20, MongoDB 7 — handled by Docker"
else

# Node.js
if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v 2>/dev/null)
    NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 20 ]; then
        ok "Node.js $NODE_VERSION"
    else
        fail "Node.js $NODE_VERSION (need v20+)"
        MISSING_DEPS+=("nodejs")
    fi
else
    fail "Node.js not found"
    MISSING_DEPS+=("nodejs")
fi

# npm
if command -v npm &>/dev/null; then
    ok "npm $(npm -v 2>/dev/null)"
else
    fail "npm not found"
    MISSING_DEPS+=("npm")
fi

# MongoDB
if command -v mongosh &>/dev/null || command -v mongo &>/dev/null; then
    ok "MongoDB client found"
else
    warn "MongoDB client not found (install mongosh for local DB)"
    info "Or set MONGODB_URI to a remote MongoDB instance"
fi

fi  # end non-Docker dependency checks

# Git
if command -v git &>/dev/null; then
    ok "Git $(git --version | cut -d' ' -f3)"
else
    fail "Git not found"
    MISSING_DEPS+=("git")
fi

# FFmpeg (optional)
if command -v ffmpeg &>/dev/null; then
    ok "FFmpeg found (media processing enabled)"
else
    warn "FFmpeg not found (media processing disabled — install later with: sudo apt install ffmpeg)"
fi

# OpenSSL (for secret generation)
if command -v openssl &>/dev/null; then
    ok "OpenSSL found"
else
    warn "OpenSSL not found (will use alternative for secret generation)"
fi

# GitHub CLI (required for self-modification PRs)
if command -v gh &>/dev/null; then
    ok "GitHub CLI found"
else
    if [ "$AUTO_INSTALL_DEPS" = "true" ] || [ "$UNATTENDED" = "true" ]; then
        (type -t apt-get &>/dev/null && (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update -qq &>/dev/null && apt-get install -y -qq gh &>/dev/null)) 2>/dev/null
        if command -v gh &>/dev/null; then
            ok "GitHub CLI installed"
        else
            warn "GitHub CLI not installed (self-modification PRs will use API fallback)"
        fi
    else
        warn "GitHub CLI not found (install with: sudo apt install gh)"
    fi
fi

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo ""
    warn "Missing required dependencies: ${MISSING_DEPS[*]}"
    echo ""

    if [ "$UNATTENDED" = "true" ]; then
        AUTO_INSTALL_DEPS=true
    else
        ask_yn "Install missing dependencies automatically?" "y" AUTO_INSTALL_DEPS
    fi

    if [ "$AUTO_INSTALL_DEPS" = "true" ]; then
        # Install Node.js via nvm
        if [[ "${MISSING_DEPS[*]}" =~ "nodejs" ]] || [[ "${MISSING_DEPS[*]}" =~ "npm" ]]; then
            info "Installing Node.js 20 via nvm..."
            export NVM_DIR="${HOME}/.nvm"
            if [ ! -s "$NVM_DIR/nvm.sh" ]; then
                curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh 2>/dev/null | bash &>/dev/null
            fi
            [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
            nvm install 20 &>/dev/null
            nvm use 20 &>/dev/null
            nvm alias default 20 &>/dev/null

            if command -v node &>/dev/null; then
                ok "Node.js $(node -v) installed"
                ok "npm $(npm -v) installed"
            else
                fail "Node.js installation failed"
                echo -e "  ${DIM}Try manually: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash${NC}"
                exit 1
            fi
        fi

        # Install Git
        if [[ "${MISSING_DEPS[*]}" =~ "git" ]]; then
            info "Installing Git..."
            if command -v apt-get &>/dev/null; then
                apt-get update -qq &>/dev/null && apt-get install -y -qq git &>/dev/null
            elif command -v yum &>/dev/null; then
                yum install -y -q git &>/dev/null
            elif command -v dnf &>/dev/null; then
                dnf install -y -q git &>/dev/null
            fi

            if command -v git &>/dev/null; then
                ok "Git $(git --version | cut -d' ' -f3) installed"
            else
                fail "Git installation failed — install manually"
                exit 1
            fi
        fi

        # Install MongoDB
        if ! command -v mongosh &>/dev/null && ! command -v mongo &>/dev/null; then
            MONGO_INSTALLED=false
            info "Installing MongoDB 7..."

            # Try native package install first
            if command -v apt-get &>/dev/null; then
                CODENAME=$(lsb_release -cs 2>/dev/null || echo "bookworm")
                # MongoDB only has packages for specific Debian/Ubuntu versions
                curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg 2>/dev/null
                echo "deb [signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg] http://repo.mongodb.org/apt/debian ${CODENAME}/mongodb-org/7.0 main" > /etc/apt/sources.list.d/mongodb-org-7.0.list
                apt-get update -qq &>/dev/null && apt-get install -y -qq mongodb-org &>/dev/null

                if command -v mongod &>/dev/null; then
                    systemctl enable mongod &>/dev/null
                    systemctl start mongod &>/dev/null
                    ok "MongoDB 7 installed and started"
                    MONGO_INSTALLED=true
                else
                    # Native install failed — clean up the apt source so it doesn't break other installs
                    rm -f /etc/apt/sources.list.d/mongodb-org-7.0.list
                    rm -f /usr/share/keyrings/mongodb-server-7.0.gpg
                    apt-get update -qq &>/dev/null
                fi
            fi

            # Fall back to Docker MongoDB if native install failed
            if [ "$MONGO_INSTALLED" != "true" ]; then
                if command -v docker &>/dev/null; then
                    info "Native MongoDB install not available for this OS — using Docker instead"
                    # Stop any existing MongoDB container
                    docker rm -f lanagent-mongodb &>/dev/null
                    if docker run -d \
                        --name lanagent-mongodb \
                        --restart unless-stopped \
                        -p 27017:27017 \
                        -v lanagent_mongodb_data:/data/db \
                        mongo:7 &>/dev/null; then
                        ok "MongoDB 7 running via Docker (auto-restarts on reboot)"
                        MONGO_INSTALLED=true
                    else
                        warn "Docker MongoDB failed to start"
                    fi
                fi
            fi

            if [ "$MONGO_INSTALLED" != "true" ]; then
                warn "Could not install MongoDB — set MONGODB_URI to a remote instance in .env"
            fi
        fi

        # Install FFmpeg
        if ! command -v ffmpeg &>/dev/null; then
            info "Installing FFmpeg..."
            if command -v apt-get &>/dev/null; then
                apt-get install -y -qq ffmpeg &>/dev/null && ok "FFmpeg installed" || warn "FFmpeg install failed (optional)"
            fi
        fi

        # Install yt-dlp (YouTube downloads, media services)
        if ! command -v yt-dlp &>/dev/null; then
            info "Installing yt-dlp..."
            if curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp; then
                ok "yt-dlp installed"
            else
                warn "yt-dlp install failed (optional — YouTube features disabled)"
            fi
        fi

        # Install Chromium + dependencies (web scraping, screenshots, PDF generation)
        # Puppeteer needs a system Chromium or will download its own
        if ! command -v chromium &>/dev/null && ! command -v chromium-browser &>/dev/null && ! command -v google-chrome &>/dev/null; then
            info "Installing Chromium and dependencies..."
            if command -v apt-get &>/dev/null; then
                # Install Chromium + common libs needed for headless browser
                apt-get install -y -qq \
                  chromium chromium-common xvfb \
                  fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libcups2 \
                  libdrm2 libgbm1 libnspr4 libnss3 libxcomposite1 \
                  libxdamage1 libxrandr2 xdg-utils 2>/dev/null \
                || apt-get install -y -qq chromium-browser xvfb 2>/dev/null

                if command -v chromium &>/dev/null || command -v chromium-browser &>/dev/null; then
                    ok "Chromium installed"
                else
                    warn "Chromium install failed (optional — scraping/screenshot features disabled)"
                fi
            fi
        fi
    else
        echo ""
        echo -e "  Install manually:"
        if [[ "${MISSING_DEPS[*]}" =~ "nodejs" ]]; then
            echo -e "    ${DIM}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash${NC}"
            echo -e "    ${DIM}source ~/.nvm/nvm.sh && nvm install 20${NC}"
        fi
        if [[ "${MISSING_DEPS[*]}" =~ "git" ]]; then
            echo -e "    ${DIM}sudo apt install git${NC}"
        fi
        echo ""
        ask_yn "Continue anyway?" "n" CONTINUE_ANYWAY
        if [ "$CONTINUE_ANYWAY" != "true" ]; then
            exit 1
        fi
    fi
fi

# ═══════════════════════════════════════════════════
# STEP 2: Agent Identity
# ═══════════════════════════════════════════════════
print_step 2 $TOTAL_STEPS "Agent Identity"

if [ "$UNATTENDED" = "true" ]; then
    AGENT_NAME="$_NAME"
    AGENT_PORT="$_PORT"
    AGENT_SSH_PORT="$_SSH_PORT"
else
    echo -e "  ${DIM}Give your agent a name. This will be used in the UI,${NC}"
    echo -e "  ${DIM}database, logs, and P2P network.${NC}"
    echo ""

    ask "Agent name" "${_NAME:-LANAgent}" AGENT_NAME
    DEFAULT_PORT="${_PORT:-$( [ "$(id -u)" = "0" ] && echo "80" || echo "3000" )}"
    ask "Web UI port" "$DEFAULT_PORT" AGENT_PORT
    ask "SSH interface port" "${_SSH_PORT:-2222}" AGENT_SSH_PORT
fi

ok "Agent: ${BOLD}${AGENT_NAME}${NC} on port ${AGENT_PORT}"

# ═══════════════════════════════════════════════════
# STEP 3: AI Providers
# ═══════════════════════════════════════════════════
print_step 3 $TOTAL_STEPS "AI Providers"

OLLAMA_URL=""
ENABLE_OLLAMA=""

# Install Ollama if needed and pull a default model
install_ollama() {
    if command -v ollama &>/dev/null || curl -s http://localhost:11434/api/tags &>/dev/null; then
        return 0
    fi
    info "Installing Ollama..."
    curl -fsSL https://ollama.ai/install.sh -o /tmp/ollama-install.sh 2>/dev/null
    bash /tmp/ollama-install.sh &>/dev/null 2>&1
    rm -f /tmp/ollama-install.sh
    sleep 3
    if curl -s http://localhost:11434/api/tags &>/dev/null; then
        ok "Ollama installed and running"
        # Pull a small default model
        info "Pulling default model (tinyllama — small, fast)..."
        ollama pull tinyllama &>/dev/null 2>&1 && ok "Model tinyllama ready" || warn "Model pull failed — run later: ollama pull tinyllama"
        return 0
    else
        warn "Ollama install failed — install later: https://ollama.ai"
        return 1
    fi
}

if [ "$UNATTENDED" = "true" ]; then
    ANTHROPIC_KEY="$_ANTHROPIC_KEY"
    OPENAI_KEY="$_OPENAI_KEY"
    if [ "$_LOCAL_AI" = "true" ]; then
        OLLAMA_URL="${_OLLAMA_URL:-http://localhost:11434}"
        ENABLE_OLLAMA="true"
        # Auto-install Ollama if not reachable and URL is localhost
        if [[ "$OLLAMA_URL" == *"localhost"* ]] && ! curl -s "$OLLAMA_URL/api/tags" &>/dev/null; then
            install_ollama
        fi
    fi
else
    echo -e "  ${DIM}LANAgent supports cloud AI (Anthropic/OpenAI) and local AI${NC}"
    echo -e "  ${DIM}(Ollama — runs on your hardware, free, private, works offline).${NC}"
    echo -e "  ${DIM}You can use one or both. You can always add more later.${NC}"
    echo ""

    ask_yn "Use local AI via Ollama? (free, private, runs on your hardware)" "n" USE_OLLAMA
    if [ "$USE_OLLAMA" = "true" ]; then
        # Check if Ollama is running locally
        if curl -s http://localhost:11434/api/tags &>/dev/null; then
            ok "Ollama detected at localhost:11434"
            OLLAMA_URL="http://localhost:11434"
        else
            echo -e "  ${DIM}Ollama not detected locally.${NC}"
            ask_yn "Install Ollama now? (recommended)" "y" INSTALL_OLLAMA
            if [ "$INSTALL_OLLAMA" = "true" ]; then
                install_ollama
                if curl -s http://localhost:11434/api/tags &>/dev/null; then
                    OLLAMA_URL="http://localhost:11434"
                fi
            fi
            if [ -z "$OLLAMA_URL" ]; then
                echo -e "  ${DIM}You can point to a remote Ollama instance on your LAN instead.${NC}"
                ask "Ollama server URL (or Enter to skip)" "http://localhost:11434" OLLAMA_URL
                if [ -n "$OLLAMA_URL" ] && curl -s "${OLLAMA_URL}/api/tags" &>/dev/null; then
                    ok "Ollama connected at ${OLLAMA_URL}"
                elif [ -n "$OLLAMA_URL" ]; then
                    warn "Ollama not reachable at ${OLLAMA_URL} — start it later"
                fi
            fi
        fi
        ENABLE_OLLAMA="true"
    fi

    echo ""
    echo -e "  ${DIM}Cloud AI gives stronger reasoning (good for self-modification).${NC}"
    echo -e "  ${DIM}You can use cloud + local together, or cloud/local alone.${NC}"
    echo ""

    ask_secret "Anthropic API key (sk-ant-..., or Enter to skip)" ANTHROPIC_KEY

    ask_secret "OpenAI API key (sk-..., or Enter to skip)" OPENAI_KEY

    if [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ] && [ -z "$ENABLE_OLLAMA" ]; then
        echo ""
        fail "At least one AI provider is required (cloud key or Ollama)!"
        ask_secret "Enter an API key (Anthropic or OpenAI)" ANTHROPIC_KEY
        if [ -z "$ANTHROPIC_KEY" ]; then
            fail "Cannot proceed without an AI provider. Exiting."
            exit 1
        fi
    fi
fi

if [ -n "$ENABLE_OLLAMA" ]; then
    ok "Local AI (Ollama) configured at ${OLLAMA_URL}"
fi
if [ -n "$ANTHROPIC_KEY" ] || [ -n "$OPENAI_KEY" ]; then
    ok "Cloud AI provider configured"
fi
if [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ] && [ -n "$ENABLE_OLLAMA" ]; then
    ok "Running with local AI only (no cloud API costs)"
fi

# ═══════════════════════════════════════════════════
# STEP 4: Database
# ═══════════════════════════════════════════════════
DB_NAME=$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_')

if [ -n "$_MONGO_URI" ]; then
    MONGODB_URI="$_MONGO_URI"
elif [ "$DOCKER_MODE" = "true" ]; then
    MONGODB_URI="mongodb://mongodb:27017/${DB_NAME}"
else
    MONGODB_URI="mongodb://localhost:27017/${DB_NAME}"
fi

if [ "$QUICK_MODE" != "true" ]; then
    print_step 4 $TOTAL_STEPS "Database"

    echo -e "  ${DIM}Default: ${MONGODB_URI}${NC}"
    ask_yn "Use a custom MongoDB URI instead?" "n" CUSTOM_DB

    if [ "$CUSTOM_DB" = "true" ]; then
        ask "MongoDB URI" "$MONGODB_URI" MONGODB_URI
    fi

    # Test connection
    if command -v mongosh &>/dev/null; then
        info "Testing MongoDB connection..."
        if mongosh "$MONGODB_URI" --eval "db.runCommand({ping:1})" --quiet &>/dev/null; then
            ok "MongoDB connection successful"
        else
            warn "Could not connect to MongoDB (make sure it's running)"
            info "You can fix the URI in .env later"
        fi
    else
        ok "Using: $MONGODB_URI"
    fi
else
    ok "Database: $MONGODB_URI"
fi

# ═══════════════════════════════════════════════════
# STEP 5: Telegram Bot (optional)
# ═══════════════════════════════════════════════════
TELEGRAM_TOKEN=""
TELEGRAM_ID=""

if [ "$QUICK_MODE" != "true" ]; then
    print_step 5 $TOTAL_STEPS "Telegram Bot (optional)"

    echo -e "  ${DIM}Connect your agent to Telegram for mobile control.${NC}"
    echo -e "  ${DIM}Create a bot via @BotFather on Telegram first.${NC}"
    echo ""

    ask_yn "Set up Telegram bot?" "n" SETUP_TELEGRAM

    if [ "$SETUP_TELEGRAM" = "true" ]; then
        ask_secret "Bot token (from @BotFather)" TELEGRAM_TOKEN
        ask "Your Telegram user ID (get via @userinfobot)" "" TELEGRAM_ID

        if [ -n "$TELEGRAM_TOKEN" ] && [ -n "$TELEGRAM_ID" ]; then
            ok "Telegram bot configured"
        else
            warn "Incomplete Telegram config — you can set it in .env later"
        fi
    else
        info "Skipping Telegram setup"
    fi
fi

# ═══════════════════════════════════════════════════
# STEP 6: Email (optional)
# ═══════════════════════════════════════════════════
MASTER_EMAIL=""
GMAIL_USER=""
GMAIL_PASS=""

if [ "$QUICK_MODE" != "true" ]; then
    print_step 6 $TOTAL_STEPS "Email Configuration (optional)"

    echo -e "  ${DIM}Configure email for notifications and the email plugin.${NC}"
    echo ""

    ask "Your email address (for notifications)" "" MASTER_EMAIL

    ask_yn "Set up SMTP for sending emails?" "n" SETUP_SMTP
    if [ "$SETUP_SMTP" = "true" ]; then
        ask "SMTP email (Gmail, etc.)" "" GMAIL_USER
        ask_secret "SMTP app password" GMAIL_PASS
        if [ -n "$GMAIL_USER" ]; then
            ok "SMTP configured"
        fi
    fi
fi

# ═══════════════════════════════════════════════════
# STEP 7: Agent Wallet
# ═══════════════════════════════════════════════════
CRYPTO_WALLET=""
WALLET_ADDRESS="pending"
WALLET_MNEMONIC=""

print_step 7 $TOTAL_STEPS "Agent Wallet"

if [ "$UNATTENDED" = "true" ]; then
    IMPORT_WALLET=false
else
    echo -e "  ${DIM}Your agent needs a crypto wallet to participate in the network.${NC}"
    echo -e "  ${DIM}It's used for receiving payments, P2P service fees, and API credits.${NC}"
    echo ""

    ask_yn "Import an existing wallet?" "n" IMPORT_WALLET
fi

if [ "$IMPORT_WALLET" = "true" ]; then
    ask_secret "Private key (0x...)" CRYPTO_WALLET
    ok "Wallet imported"
else
    # Generate wallet using Node.js + ethers
    info "Generating new wallet..."
    if command -v node &>/dev/null; then
        WALLET_OUTPUT=$(node -e "
            import('ethers').then(({ethers}) => {
                const w = ethers.Wallet.createRandom();
                console.log(JSON.stringify({address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic.phrase}));
            }).catch(() => {
                const crypto = require('crypto');
                const pk = '0x' + crypto.randomBytes(32).toString('hex');
                console.log(JSON.stringify({address: 'pending', privateKey: pk, mnemonic: ''}));
            });
        " 2>/dev/null || echo '{"address":"pending","privateKey":"generate-after-install","mnemonic":""}')

        CRYPTO_WALLET=$(echo "$WALLET_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('privateKey',''))" 2>/dev/null || echo "")
        WALLET_ADDRESS=$(echo "$WALLET_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('address','pending'))" 2>/dev/null || echo "pending")
        WALLET_MNEMONIC=$(echo "$WALLET_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mnemonic',''))" 2>/dev/null || echo "")

        if [ -n "$CRYPTO_WALLET" ] && [ "$CRYPTO_WALLET" != "generate-after-install" ]; then
            ok "Wallet generated: ${WALLET_ADDRESS}"
            if [ -n "$WALLET_MNEMONIC" ]; then
                echo ""
                echo -e "  ${RED}${BOLD}IMPORTANT: Save this recovery phrase somewhere safe!${NC}"
                echo -e "  ${YELLOW}${WALLET_MNEMONIC}${NC}"
                echo -e "  ${RED}This will NOT be shown again.${NC}"
                echo ""
                echo -e "  ${DIM}You can back up and restore your wallet from the web UI.${NC}"
            fi
        else
            info "Wallet will be generated automatically on first startup"
        fi
    else
        info "Wallet will be generated automatically on first startup"
    fi
fi

# ═══════════════════════════════════════════════════
# STEP 8: Self-Modification / GitHub
# ═══════════════════════════════════════════════════
GIT_TOKEN=""
GITHUB_REPO=""
GITHUB_USER=""
UPSTREAM_CONTRIBUTIONS="true"

print_step 8 $TOTAL_STEPS "Self-Modification & GitHub"

if [ "$UNATTENDED" = "true" ]; then
    GIT_TOKEN="$_GITHUB_PAT"
else
    echo -e "  ${DIM}LANAgent improves itself: it detects bugs, writes fixes, and${NC}"
    echo -e "  ${DIM}submits PRs — both to your fork and upstream so all agents${NC}"
    echo -e "  ${DIM}on the network benefit from each other's improvements.${NC}"
    echo ""
    echo -e "  ${DIM}To enable this, your agent needs a GitHub Personal Access Token.${NC}"
    echo -e "  ${DIM}Create one at:${NC}"
    echo -e "  ${BOLD}https://github.com/settings/tokens/new?scopes=repo${NC}"
    echo -e "  ${DIM}(select the 'repo' scope)${NC}"
    echo ""

    ask_secret "GitHub Personal Access Token (or Enter to skip)" GIT_TOKEN
fi

if [ -n "$GIT_TOKEN" ]; then
    # Detect GitHub username from PAT
    info "Verifying token..."
    GITHUB_USER=$(curl -s -H "Authorization: token ${GIT_TOKEN}" https://api.github.com/user 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('login',''))" 2>/dev/null || echo "")

    if [ -z "$GITHUB_USER" ]; then
        warn "Could not verify token — check that it has 'repo' scope"
        warn "Self-modification disabled"
        GIT_TOKEN=""
    else
        ok "Authenticated as ${BOLD}${GITHUB_USER}${NC}"

        # Auto-fork the LANAgent repo
        echo ""
        info "Forking LANAgent to your GitHub account..."
        FORK_RESULT=$(curl -s -X POST -H "Authorization: token ${GIT_TOKEN}" \
            https://api.github.com/repos/PortableDiag/LANAgent/forks 2>/dev/null)
        FORK_NAME=$(echo "$FORK_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('full_name',''))" 2>/dev/null || echo "")

        if [ -n "$FORK_NAME" ]; then
            GITHUB_REPO="https://github.com/${FORK_NAME}"
            ok "Fork created: ${BOLD}${GITHUB_REPO}${NC}"
        else
            # Fork may already exist
            EXISTING=$(curl -s -H "Authorization: token ${GIT_TOKEN}" \
                "https://api.github.com/repos/${GITHUB_USER}/LANAgent" 2>/dev/null | \
                python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('full_name','') if d.get('fork') else '')" 2>/dev/null || echo "")

            if [ -n "$EXISTING" ]; then
                GITHUB_REPO="https://github.com/${EXISTING}"
                ok "Fork already exists: ${BOLD}${GITHUB_REPO}${NC}"
            else
                warn "Could not create fork automatically"
                ask "GitHub repo URL (your fork of LANAgent)" "https://github.com/${GITHUB_USER}/LANAgent" GITHUB_REPO
            fi
        fi

        # Upstream contributions
        echo ""
        echo -e "  ${BOLD}Upstream Contributions${NC}"
        echo -e "  ${DIM}When enabled, your agent submits improvements back to the${NC}"
        echo -e "  ${DIM}main LANAgent project so all agents on the network benefit.${NC}"
        echo ""

        if [ "$UNATTENDED" = "true" ]; then
            UPSTREAM_CONTRIBUTIONS_YN=true
        else
            ask_yn "Enable upstream contributions? (recommended)" "y" UPSTREAM_CONTRIBUTIONS_YN
        fi

        if [ "$UPSTREAM_CONTRIBUTIONS_YN" = "true" ]; then
            UPSTREAM_CONTRIBUTIONS="true"
            ok "Upstream contributions enabled"
            echo ""
            echo -e "  ${DIM}How it works:${NC}"
            echo -e "  ${DIM}1. Your agent detects a bug or improvement opportunity${NC}"
            echo -e "  ${DIM}2. Generates a fix, validates it, creates a PR on your fork${NC}"
            echo -e "  ${DIM}3. Simultaneously submits a cross-fork PR upstream${NC}"
            echo -e "  ${DIM}4. Maintainers review — approved fixes reach all agents${NC}"
        else
            UPSTREAM_CONTRIBUTIONS="false"
            info "Upstream contributions disabled — PRs stay on your fork only"
        fi
    fi
else
    info "Skipped — self-modification can be enabled later in .env"
fi

# ═══════════════════════════════════════════════════
# STEP 9: P2P Skynet Network
# ═══════════════════════════════════════════════════
P2P_ENABLED="true"
P2P_DISPLAY_NAME="${AGENT_NAME}"
AGENT_SERVICE_URL=""

print_step 9 $TOTAL_STEPS "P2P Skynet Network"

# Detect public IP (used in both modes)
DETECTED_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || curl -s --max-time 5 https://ifconfig.me 2>/dev/null || echo "")

if [ "$UNATTENDED" = "true" ]; then
    if [ "$_NO_P2P" = "true" ]; then
        P2P_ENABLED="false"
        info "P2P disabled"
    else
        P2P_ENABLED="true"
        P2P_DISPLAY_NAME="${AGENT_NAME}"
        if [ -n "$_P2P_URL" ]; then
            AGENT_SERVICE_URL="$_P2P_URL"
        elif [ -n "$DETECTED_IP" ]; then
            AGENT_SERVICE_URL="http://${DETECTED_IP}:${AGENT_PORT}"
        fi
        ok "P2P Skynet enabled (${AGENT_SERVICE_URL:-auto-detect})"
    fi
else
    echo -e "  ${DIM}Connect to the Skynet peer-to-peer network to communicate${NC}"
    echo -e "  ${DIM}with other LANAgent instances. Agents can share plugins,${NC}"
    echo -e "  ${DIM}knowledge packs, and execute services for each other.${NC}"
    echo -e "  ${DIM}All communication is end-to-end encrypted (Ed25519 + X25519).${NC}"
    echo ""

    ask_yn "Join the Skynet P2P network? (recommended)" "y" P2P_YN

    if [ "$P2P_YN" = "true" ]; then
        P2P_ENABLED="true"
        P2P_DISPLAY_NAME="${AGENT_NAME}"

        if [ -n "$DETECTED_IP" ]; then
            DEFAULT_SERVICE_URL="http://${DETECTED_IP}:${AGENT_PORT}"
        else
            DEFAULT_SERVICE_URL=""
        fi

        echo ""
        echo -e "  ${DIM}Other agents need a public URL to reach your instance.${NC}"
        echo -e "  ${DIM}This should be your server's public IP or domain name.${NC}"
        ask "Public service URL" "$DEFAULT_SERVICE_URL" AGENT_SERVICE_URL

        ok "P2P Skynet enabled — your agent will join the network on startup"
        echo ""
        echo -e "  ${DIM}Your agent will:${NC}"
        echo -e "  ${DIM}  - Generate a unique cryptographic identity (Ed25519)${NC}"
        echo -e "  ${DIM}  - Connect to the registry at wss://registry.lanagent.net${NC}"
        echo -e "  ${DIM}  - Discover and communicate with other agents${NC}"
        echo -e "  ${DIM}  - Share capabilities and execute services${NC}"
        echo -e "  ${DIM}  - Trust levels configurable via the web UI${NC}"
    else
        P2P_ENABLED="false"
        info "P2P disabled — your agent will run standalone"
    fi
fi

# ═══════════════════════════════════════════════════
# STEP 10: SSL / HTTPS (optional)
# ═══════════════════════════════════════════════════
SETUP_SSL=false
SSL_DOMAIN=""

# SSL applies to both native and Docker modes (Caddy runs on the host either way)
if true; then
    print_step 10 $TOTAL_STEPS "SSL / HTTPS (optional)"

    if [ "$UNATTENDED" = "true" ]; then
        if [ -n "$_DOMAIN" ]; then
            SETUP_SSL=true
            SSL_DOMAIN="$_DOMAIN"
        fi
    else
        echo -e "  ${DIM}Secure your web UI with HTTPS using Caddy (auto-SSL).${NC}"
        echo -e "  ${DIM}Recommended for VPS/cloud servers exposed to the internet.${NC}"
        echo -e "  ${DIM}LAN-only servers can skip this.${NC}"
        echo ""

        ask_yn "Set up HTTPS?" "n" SETUP_SSL_YN
        if [ "$SETUP_SSL_YN" = "true" ]; then
            SETUP_SSL=true
            echo ""
            echo -e "  ${DIM}If you have a domain pointing to this server (e.g. myagent.example.com),${NC}"
            echo -e "  ${DIM}enter it below for automatic Let's Encrypt SSL.${NC}"
            echo -e "  ${DIM}Leave blank for a self-signed certificate (works without a domain).${NC}"
            ask "Domain name (or Enter for self-signed)" "" SSL_DOMAIN
        fi
    fi

    if [ "$SETUP_SSL" = "true" ]; then
        # Install Caddy
        if ! command -v caddy &>/dev/null; then
            info "Installing Caddy web server..."
            if command -v apt-get &>/dev/null; then
                apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https &>/dev/null
                curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
                curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' 2>/dev/null > /etc/apt/sources.list.d/caddy-stable.list
                apt-get update -qq &>/dev/null && apt-get install -y -qq caddy &>/dev/null
            fi

            if command -v caddy &>/dev/null; then
                ok "Caddy installed"
            else
                warn "Caddy install failed — HTTPS not configured"
                SETUP_SSL=false
            fi
        else
            ok "Caddy already installed"
        fi
    fi

    if [ "$SETUP_SSL" = "true" ] && command -v caddy &>/dev/null; then
        # Caddy needs ports 80 (ACME/redirect) and 443 (HTTPS)
        # Move the agent to an internal port so they don't conflict
        INTERNAL_PORT=3000
        if [ "$AGENT_PORT" = "80" ] || [ "$AGENT_PORT" = "443" ]; then
            AGENT_PORT=$INTERNAL_PORT
            ok "Agent port changed to ${AGENT_PORT} (Caddy handles 80/443)"
        fi

        # Write Caddyfile
        if [ -n "$SSL_DOMAIN" ]; then
            # Domain mode — Let's Encrypt auto-SSL
            cat > /etc/caddy/Caddyfile << CADDYEOF
${SSL_DOMAIN} {
    reverse_proxy localhost:${AGENT_PORT}
}
CADDYEOF
            ok "Caddy configured for ${BOLD}https://${SSL_DOMAIN}${NC} → localhost:${AGENT_PORT}"
            info "Make sure your DNS A record points ${SSL_DOMAIN} to this server's IP"
        else
            # No domain — self-signed cert on the server's IP
            cat > /etc/caddy/Caddyfile << CADDYEOF
:443 {
    tls internal
    reverse_proxy localhost:${AGENT_PORT}
}
CADDYEOF
            ok "Caddy configured with self-signed cert on port 443 → localhost:${AGENT_PORT}"
            warn "Browser will show a security warning (self-signed). Traffic is still encrypted."
        fi

        # Restart Caddy
        systemctl enable caddy &>/dev/null
        systemctl restart caddy &>/dev/null
        ok "Caddy started"

        # Update P2P service URL to use HTTPS
        if [ -n "$SSL_DOMAIN" ]; then
            AGENT_SERVICE_URL="https://${SSL_DOMAIN}"
        elif [ -n "$DETECTED_IP" ]; then
            AGENT_SERVICE_URL="https://${DETECTED_IP}"
        fi
    fi
fi

# ═══════════════════════════════════════════════════
# Generate Security Keys
# ═══════════════════════════════════════════════════
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Generating Security Keys${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

JWT_SECRET=$(generate_secret)
ENCRYPTION_KEY=$(generate_secret)
SSH_PASS=$(openssl rand -base64 12 2>/dev/null || echo "changeme$(date +%s)")

ok "JWT secret generated"
ok "Encryption key generated"
ok "SSH password generated"

# ═══════════════════════════════════════════════════
# Write .env
# ═══════════════════════════════════════════════════
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Writing Configuration${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

cat > "$PROJECT_ROOT/.env" << ENVEOF
# LANAgent Configuration — Generated by install.sh
# $(date -u +"%Y-%m-%d %H:%M:%S UTC")

# Agent Identity
AGENT_NAME=${AGENT_NAME}
AGENT_PORT=${AGENT_PORT}
AGENT_SSH_PORT=${AGENT_SSH_PORT}

# AI Providers
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
OPENAI_API_KEY=${OPENAI_KEY}
ANTHROPIC_ENABLE_WEB_SEARCH=true

# Local AI (Ollama) — free, private, runs on your hardware
ENABLE_OLLAMA=${ENABLE_OLLAMA:-false}
# Docker containers can't reach host localhost — use host.docker.internal
if [ "$DOCKER_MODE" = "true" ] && [[ "${OLLAMA_URL:-localhost}" == *"localhost"* ]]; then
  OLLAMA_BASE_URL=${OLLAMA_URL/localhost/host.docker.internal}
else
  OLLAMA_BASE_URL=${OLLAMA_URL:-http://localhost:11434}
fi
OLLAMA_CHAT_MODEL=llama3.1
OLLAMA_EMBEDDING_MODEL=nomic-embed-text

# Database
MONGODB_URI=${MONGODB_URI}

# Master
EMAIL_OF_MASTER=${MASTER_EMAIL}

# Security
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
WEB_UI_PASSWORD=lanagent

# SSH Interface
SSH_USERNAME=lanagent
SSH_PASSWORD=${SSH_PASS}

# VPN
EXPRESSVPN_ENABLED=false

# Browser (Puppeteer) — use system Chromium if available
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
PUPPETEER_EXECUTABLE_PATH=$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || echo "")

# Vector Intent
ENABLE_VECTOR_INTENT=true

# P2P Skynet Network
P2P_ENABLED=${P2P_ENABLED}
P2P_DISPLAY_NAME=${P2P_DISPLAY_NAME:-${AGENT_NAME}}
AGENT_SERVICE_URL=${AGENT_SERVICE_URL}
ENVEOF

# Add optional sections
if [ -n "$TELEGRAM_TOKEN" ]; then
    cat >> "$PROJECT_ROOT/.env" << ENVEOF

# Telegram
TELEGRAM_BOT_TOKEN=${TELEGRAM_TOKEN}
TELEGRAM_USER_ID=${TELEGRAM_ID}
ENVEOF
fi

if [ -n "$GMAIL_USER" ]; then
    cat >> "$PROJECT_ROOT/.env" << ENVEOF

# Email (SMTP)
GMAIL_USER=${GMAIL_USER}
GMAIL_APP_PASS=${GMAIL_PASS}
ENVEOF
fi

# Always write upstream/repo path so sync works even without git token
cat >> "$PROJECT_ROOT/.env" << ENVEOF

# Git & Self-Modification
AGENT_REPO_PATH=${PROJECT_ROOT}
UPSTREAM_REPO=https://github.com/PortableDiag/LANAgent
UPSTREAM_CONTRIBUTIONS=${UPSTREAM_CONTRIBUTIONS}
ENVEOF

if [ -n "$GIT_TOKEN" ]; then
    cat >> "$PROJECT_ROOT/.env" << ENVEOF
GIT_PERSONAL_ACCESS_TOKEN=${GIT_TOKEN}
GITHUB_REPO=${GITHUB_REPO}
ENVEOF
fi

if [ -n "$CRYPTO_WALLET" ] && [ "$CRYPTO_WALLET" != "generate-after-install" ]; then
    cat >> "$PROJECT_ROOT/.env" << ENVEOF

# Crypto (wallet stored encrypted in DB on first run)
CRYPTO_PRIVATE_KEY=${CRYPTO_WALLET}
ENVEOF
fi

ok ".env written"

# ═══════════════════════════════════════════════════
# Configure Git Remotes
# ═══════════════════════════════════════════════════
if command -v git &>/dev/null; then
    cd "$PROJECT_ROOT"

    # Initialize git repo if not already one (e.g. downloaded as zip)
    if [ ! -d ".git" ]; then
        git init -b main &>/dev/null
        git add -A &>/dev/null
        git commit -m "initial install" --quiet 2>/dev/null
        ok "Git repository initialized"
    fi

    # Set up origin (agent's fork) if GITHUB_REPO provided
    if [ -n "$GITHUB_REPO" ]; then
        ORIGIN_URL="$GITHUB_REPO"
        # Inject PAT into URL for push access
        if [ -n "$GIT_TOKEN" ]; then
            ORIGIN_URL=$(echo "$GITHUB_REPO" | sed "s|https://|https://${GIT_TOKEN}@|")
        fi

        if git remote get-url origin &>/dev/null; then
            git remote set-url origin "$ORIGIN_URL" 2>/dev/null
        else
            git remote add origin "$ORIGIN_URL" 2>/dev/null
        fi
        ok "Git remote 'origin' set to your fork"
    fi

    # Set up upstream (main LANAgent repo — use PAT for private repo access)
    if [ -n "$GIT_TOKEN" ]; then
        UPSTREAM_URL="https://${GIT_TOKEN}@github.com/PortableDiag/LANAgent.git"
    else
        UPSTREAM_URL="https://github.com/PortableDiag/LANAgent.git"
    fi
    if git remote get-url upstream &>/dev/null; then
        git remote set-url upstream "$UPSTREAM_URL" 2>/dev/null
    else
        git remote add upstream "$UPSTREAM_URL" 2>/dev/null
    fi
    ok "Git remote 'upstream' set to main LANAgent repo"

    # Configure git user for self-mod commits
    git config user.name "${AGENT_NAME}" 2>/dev/null
    git config user.email "${AGENT_NAME,,}@lanagent.net" 2>/dev/null
    ok "Git user configured as ${AGENT_NAME}"
else
    warn "Git not installed — self-modification will not work"
fi

# ═══════════════════════════════════════════════════
# Write CLAUDE.local.md
# ═══════════════════════════════════════════════════
cat > "$PROJECT_ROOT/CLAUDE.local.md" << CLEOF
# ${AGENT_NAME} — Instance Configuration

## Agent Identity
- **Name:** ${AGENT_NAME}
- **Port:** ${AGENT_PORT}
- **SSH Port:** ${AGENT_SSH_PORT}

## Database
- **URI:** ${MONGODB_URI}

## AI Providers
- Anthropic: $([ -n "$ANTHROPIC_KEY" ] && echo "configured" || echo "not set")
- OpenAI: $([ -n "$OPENAI_KEY" ] && echo "configured" || echo "not set")

## Interfaces
- Telegram: $([ -n "$TELEGRAM_TOKEN" ] && echo "configured" || echo "not set")
- Email: $([ -n "$GMAIL_USER" ] && echo "configured ($GMAIL_USER)" || echo "not set")
- Crypto: $([ "$CRYPTO_ENABLED" = "true" ] && echo "enabled" || echo "disabled")
- Self-mod: $([ -n "$GIT_TOKEN" ] && echo "configured" || echo "disabled")
CLEOF

ok "CLAUDE.local.md written"

# ═══════════════════════════════════════════════════
# Create Directories
# ═══════════════════════════════════════════════════
for dir in data logs workspace temp uploads quarantine; do
    mkdir -p "$PROJECT_ROOT/$dir"
done
ok "Data directories created"

# ═══════════════════════════════════════════════════
# Install Dependencies
# ═══════════════════════════════════════════════════
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Installing Dependencies${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ "$DOCKER_MODE" = "true" ]; then
    ok "Dependencies will be installed inside Docker container"
else
    # Ensure nvm is loaded (may have been installed during this session)
    export NVM_DIR="${HOME}/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

    if command -v npm &>/dev/null; then
        info "Running npm install (this may take a few minutes)..."
        cd "$PROJECT_ROOT"
        if npm install --legacy-peer-deps 2>&1 | tail -5; then
            ok "Dependencies installed"
        else
            warn "npm install had issues — check output above"
            info "You can retry manually: cd $PROJECT_ROOT && npm install --legacy-peer-deps"
        fi

        # Ensure nvm node is active for PM2 install
        if [ -s "${HOME}/.nvm/nvm.sh" ]; then
            export NVM_DIR="${HOME}/.nvm"
            . "$NVM_DIR/nvm.sh"
            nvm use 20 &>/dev/null 2>&1
        fi

        # Install PM2 globally for process management (uses nvm node if available)
        if ! command -v pm2 &>/dev/null; then
            info "Installing PM2 process manager..."
            npm install -g pm2 &>/dev/null && ok "PM2 installed" || warn "PM2 install failed — install later: npm install -g pm2"
        else
            ok "PM2 already installed"
        fi
    else
        warn "npm not available — install Node.js 20+ first, then run: npm install --legacy-peer-deps"
    fi
fi

# ═══════════════════════════════════════════════════
# Docker Setup (if requested)
# ═══════════════════════════════════════════════════
if [ "$DOCKER_MODE" = "true" ]; then
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}  Docker Configuration${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    if command -v docker &>/dev/null; then
        ok "Docker found: $(docker --version | head -1)"

        if command -v docker-compose &>/dev/null || docker compose version &>/dev/null 2>&1; then
            ok "Docker Compose found"
            info "Start with: docker compose up -d"
        else
            warn "Docker Compose not found"
            info "Install: sudo apt install docker-compose-plugin"
        fi
    else
        fail "Docker not installed"
        info "Install Docker: https://docs.docker.com/engine/install/"
    fi
fi

# ═══════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}  ${BOLD}Setup Complete!${NC}                                 ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Agent:${NC}      ${AGENT_NAME}"
echo -e "  ${BOLD}Web UI:${NC}     http://localhost:${AGENT_PORT}"
echo -e "  ${BOLD}Database:${NC}   ${MONGODB_URI}"
if [ -n "$TELEGRAM_TOKEN" ]; then
echo -e "  ${BOLD}Telegram:${NC}   Configured"
fi
if [ -n "$WALLET_ADDRESS" ] && [ "$WALLET_ADDRESS" != "pending" ]; then
echo -e "  ${BOLD}Wallet:${NC}     ${WALLET_ADDRESS}"
else
echo -e "  ${BOLD}Wallet:${NC}     Will be generated on first startup"
fi
if [ -n "$GITHUB_REPO" ]; then
echo -e "  ${BOLD}Fork:${NC}       ${GITHUB_REPO}"
echo -e "  ${BOLD}Self-Mod:${NC}   Enabled (upstream contributions: ${UPSTREAM_CONTRIBUTIONS})"
fi
if [ -n "$AGENT_SERVICE_URL" ]; then
echo -e "  ${BOLD}P2P URL:${NC}    ${AGENT_SERVICE_URL}"
fi
echo ""
echo -e "  ${BOLD}Start your agent:${NC}"
echo ""

if [ "$DOCKER_MODE" = "true" ]; then
    echo -e "    ${CYAN}docker compose up -d${NC}"
    echo ""

    # Auto-launch Docker
    if command -v docker &>/dev/null; then
        if [ "$UNATTENDED" = "true" ]; then
            START_DOCKER=$( [ "$_NO_START" = "true" ] && echo "false" || echo "true" )
        else
            ask_yn "Start your agent now with Docker?" "y" START_DOCKER
        fi
        if [ "$START_DOCKER" = "true" ]; then
            echo ""
            info "Building and starting containers..."
            if docker compose up -d --build 2>/dev/null || docker-compose up -d --build 2>/dev/null; then
                echo ""
                ok "Agent is starting!"
                info "Web UI will be ready in ~3 minutes at ${BOLD}http://localhost:${AGENT_PORT}${NC}"
                info "View logs: docker compose logs -f"
            else
                warn "Docker start failed. Run manually: docker compose up -d"
            fi
        fi
    fi
    echo ""
    echo -e "  Or run natively:"
fi

if [ "$DOCKER_MODE" != "true" ] && command -v pm2 &>/dev/null; then
    if [ "$UNATTENDED" = "true" ]; then
        START_PM2=$( [ "$_NO_START" = "true" ] && echo "false" || echo "true" )
    else
        ask_yn "Start your agent now with PM2?" "y" START_PM2
    fi
    if [ "$START_PM2" = "true" ]; then
        echo ""
        # Ensure nvm node 20 is active and set as default for PM2
        export NVM_DIR="${HOME}/.nvm"
        if [ -s "$NVM_DIR/nvm.sh" ]; then
            . "$NVM_DIR/nvm.sh"
            nvm use 20 &>/dev/null 2>&1
            nvm alias default 20 &>/dev/null 2>&1
        fi
        cd "$PROJECT_ROOT"
        if pm2 start ecosystem.config.cjs 2>&1 | tail -5; then
            echo ""
            ok "Agent is starting!"
            info "Web UI will be ready in ~3 minutes at ${BOLD}http://localhost:${AGENT_PORT}${NC}"
            info "View logs: pm2 logs lan-agent"

            # Set up PM2 to restart on reboot
            pm2 save &>/dev/null
            pm2 startup 2>/dev/null | tail -1 | bash &>/dev/null 2>&1
            ok "PM2 configured to restart on reboot"
        else
            warn "PM2 start failed. Run manually: pm2 start ecosystem.config.cjs"
        fi
    fi
else
    echo -e "    ${CYAN}npm start${NC}"
    echo ""
    echo -e "  For production (with PM2):"
    echo -e "    ${CYAN}pm2 start ecosystem.config.cjs${NC}"
fi
echo ""
echo -e "  ${DIM}Web UI takes ~3 minutes to fully load on first start.${NC}"
echo -e "  ${DIM}Login with password: lanagent (change in .env WEB_UI_PASSWORD)${NC}"
echo ""

if [ -n "$GIT_TOKEN" ]; then
    echo -e "  ${BOLD}Self-Modification:${NC}"
    echo -e "  ${DIM}Your agent will analyze its code and create PRs on your fork.${NC}"
    echo -e "  ${DIM}To contribute improvements upstream:${NC}"
    echo -e "  ${DIM}  1. Review and merge PRs to your fork${NC}"
    echo -e "  ${DIM}  2. Create a PR from your fork to PortableDiag/LANAgent${NC}"
    echo ""
fi

echo -e "  ${BOLD}Security Checklist:${NC}"
echo -e "  ${DIM}1. Change the default web password in .env (WEB_UI_PASSWORD)${NC}"
echo -e "  ${DIM}2. Restrict .env file permissions: chmod 600 .env${NC}"
echo -e "  ${DIM}3. Ensure MongoDB is not exposed to the internet (bind to localhost or use Docker)${NC}"
echo -e "  ${DIM}4. If using a domain, the installer already set up HTTPS via Caddy${NC}"
echo -e "  ${DIM}5. Your wallet private key is in .env — keep this file safe${NC}"
echo ""
echo -e "  ${DIM}Configuration: ${PROJECT_ROOT}/.env${NC}"
echo -e "  ${DIM}Documentation: ${PROJECT_ROOT}/README.md${NC}"
echo -e "  ${DIM}Wiki: https://github.com/PortableDiag/LANAgent/wiki${NC}"
echo ""
