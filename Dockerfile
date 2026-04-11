FROM node:20-slim

# System dependencies for LANAgent
# - ffmpeg: media transcoding plugin
# - python3: code sandbox, utility scripts
# - git: self-modification, version control
# - chromium + deps: Puppeteer stealth scraper
# - xvfb: virtual display for non-headless Chromium (better fingerprinting)
# - tesseract: OCR plugin
# - curl: health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 python3-venv python3-pip \
    git \
    openssh-client \
    curl \
    ca-certificates \
    chromium \
    xvfb \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libxss1 \
    libasound2 \
    tesseract-ocr \
    iproute2 \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (YouTube downloads, media services)
RUN curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Tell Puppeteer to use system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_BIN=/usr/bin/chromium \
    DISPLAY=:99

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps

# Copy application source
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY ecosystem.config.cjs ./
COPY .env.example ./
COPY docs/api/API_README.md ./docs/api/API_README.md

# Create data directories with proper permissions
RUN mkdir -p data data/agent logs workspace temp uploads quarantine \
    && chmod -R 777 data logs workspace temp uploads quarantine \
    && git config --global --add safe.directory /app/repo

# Default ports: web UI + SSH interface
EXPOSE 3000 2222

# Health check (start period 180s = 3 min for full startup)
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD curl -f http://localhost:${AGENT_PORT:-3000}/api/health || exit 1

# Start with Xvfb for Puppeteer, then launch the agent
CMD ["sh", "-c", "rm -f /tmp/.X99-lock; Xvfb :99 -screen 0 1280x720x16 -nolisten tcp &>/dev/null & sleep 1 && exec node src/index.js"]
