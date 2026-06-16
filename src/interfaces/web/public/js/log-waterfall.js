/**
 * Log Waterfall — Matrix-Rain Style Log Visualization
 * Fetches recent logs and displays them as falling text columns by service.
 */
class LogWaterfallViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.canvas = null;
        this.ctx = null;
        this.animationId = null;
        this.columns = [];
        this.logEntries = [];
        this.columnWidth = 0;
        this.fontSize = 14;
        this.serviceNames = ['API', 'Crypto', 'Network', 'Scheduler', 'P2P', 'Plugins', 'Self-Mod', 'Telegram'];
        this.serviceColors = {
            API: '#3498db', Crypto: '#f1c40f', Network: '#2ecc71', Scheduler: '#9b59b6',
            P2P: '#e67e22', Plugins: '#1abc9c', 'Self-Mod': '#e74c3c', Telegram: '#0088cc'
        };
        this.levelColors = { error: '#ff4444', warn: '#ffaa00', info: '#44ff44', debug: '#4488ff' };

        // Anomaly detection and visualization modulation configuration
        this.anomalyWindowMs = 60000; // 60s rolling window
        this.errorRateThreshold = 0.2; // errors/total threshold
        this.maxBoost = 2.0; // max 2x spawn boost

        // Per-service rolling stats: { [service]: { timestamps: number[], errorTimestamps: number[], warnTimestamps: number[], lastPulse: number, pulsePhase: number, boost: number } }
        this.serviceStats = {};
        this._lastRateCalc = 0;
        this._rateCalcIntervalMs = 500; // recalc a couple times per second for smooth decay
        this._lastIngestIndex = 0; // track how many entries we have already ingested into stats
    }

    async init() {
        this._setupCanvas();
        await this._fetchLogs();
        this._initColumns();
        this._onResize = () => this._handleResize();
        window.addEventListener('resize', this._onResize);
        this.animate();
    }

    _setupCanvas() {
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        this._handleResize();
    }

    async _fetchLogs() {
        try {
            const token = localStorage.getItem('lanagent_token');
            const resp = await fetch('/api/logs?limit=200', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                const logs = data.logs || data.entries || data.data || data || [];
                if (Array.isArray(logs)) {
                    this.logEntries = logs.map(l => ({
                        message: l.message || l.msg || l.text || JSON.stringify(l).substring(0, 60),
                        level: l.level || 'info',
                        service: l.service || l.source || l.category || this.serviceNames[Math.floor(Math.random() * this.serviceNames.length)],
                        // attach a timestamp per upgrade spec (fallback to now if not provided)
                        timestamp: l.timestamp || Date.now()
                    }));
                }
            }
        } catch (e) { /* fallback */ }

        // Generate fallback entries if none fetched
        if (this.logEntries.length === 0) {
            const sampleMsgs = [
                'Request processed', 'Token swap executed', 'Device scan complete',
                'Task scheduled', 'Peer connected', 'Plugin loaded', 'Code analyzed',
                'Message sent', 'Cache refreshed', 'Auth verified', 'Price updated',
                'Route discovered', 'Job queued', 'Subname registered', 'Module init',
                'Heartbeat OK', 'Webhook fired', 'Config reloaded', 'Query resolved',
                'Connection pool ready', 'Block synced', 'Alert cleared', 'Session renewed'
            ];
            const levels = ['info', 'info', 'info', 'info', 'warn', 'error', 'debug'];
            const now = Date.now();
            for (let i = 0; i < 200; i++) {
                this.logEntries.push({
                    message: sampleMsgs[Math.floor(Math.random() * sampleMsgs.length)],
                    level: levels[Math.floor(Math.random() * levels.length)],
                    service: this.serviceNames[Math.floor(Math.random() * this.serviceNames.length)],
                    // distribute fallback timestamps within last 90s so rolling window works
                    timestamp: now - Math.floor(Math.random() * 90000)
                });
            }
        }

        // Initialize per-service stats containers
        this.serviceNames.forEach(svc => {
            if (!this.serviceStats[svc]) {
                this.serviceStats[svc] = {
                    timestamps: [],
                    errorTimestamps: [],
                    warnTimestamps: [],
                    lastPulse: 0,
                    pulsePhase: 0,
                    boost: 1
                };
            }
        });
        // Ingest fetched entries into rolling stats
        this._ingestLogsIntoStats(this.logEntries);
        this._lastIngestIndex = this.logEntries.length;
    }

    _initColumns() {
        const w = this.canvas.width;
        this.columnWidth = Math.floor(w / this.serviceNames.length);
        this.columns = this.serviceNames.map((name, i) => ({
            name,
            x: i * this.columnWidth,
            drops: [],
            nextDrop: Math.random() * 60
        }));

        // Seed initial drops
        this.columns.forEach(col => {
            for (let i = 0; i < 8; i++) {
                this._addDrop(col);
            }
        });
    }

    _addDrop(col) {
        const entry = this.logEntries.filter(l => l.service === col.name);
        const log = entry.length > 0
            ? entry[Math.floor(Math.random() * entry.length)]
            : this.logEntries[Math.floor(Math.random() * this.logEntries.length)];

        const chars = (log.message || 'log').split('');
        col.drops.push({
            chars,
            y: -Math.random() * this.canvas.height,
            speed: 1 + Math.random() * 3,
            charIndex: 0,
            color: this.levelColors[log.level] || this.levelColors.info,
            alpha: 0.3 + Math.random() * 0.7,
            level: log.level || 'info' // keep level on drop so we can modulate spawn for errors
        });
    }

    animate() {
        this.animationId = requestAnimationFrame(() => this.animate());
        this._draw();
    }

    _draw() {
        const { ctx, canvas } = this;
        const now = Date.now();

        // Fade effect
        ctx.fillStyle = 'rgba(5, 5, 15, 0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Periodically recalc rates and decay boosts
        if (!this._lastRateCalc || now - this._lastRateCalc >= this._rateCalcIntervalMs) {
            this._updateRollingStats(now);
            this._computeRatesAndBoosts(now);
            this._lastRateCalc = now;
        }

        // Draw column headers with anomaly pulse
        ctx.font = `bold ${this.fontSize + 2}px monospace`;
        this.columns.forEach(col => {
            const svcColor = this.serviceColors[col.name] || '#ffffff';
            const stat = this.serviceStats[col.name];
            let headerAlpha = 0.7;

            // If boosted (anomaly), pulse the header intensity using sine wave of pulsePhase
            if (stat && stat.boost > 1) {
                stat.pulsePhase = (stat.pulsePhase + 0.12) % (Math.PI * 2);
                headerAlpha = 0.6 + 0.4 * Math.abs(Math.sin(stat.pulsePhase));
            } else if (stat) {
                // slowly relax the pulse phase so next anomaly starts smoothly
                stat.pulsePhase = stat.pulsePhase * 0.98;
            }

            ctx.fillStyle = svcColor;
            ctx.globalAlpha = headerAlpha;
            ctx.fillText(col.name, col.x + 10, 20);
            ctx.globalAlpha = 1;

            // Optional: outline the column when anomalous
            if (stat && stat.boost > 1.01) {
                ctx.strokeStyle = `rgba(255, 64, 64, ${Math.min(0.4, (stat.boost - 1) / (this.maxBoost - 1 + 0.0001))})`;
                ctx.lineWidth = 2;
            } else {
                ctx.strokeStyle = 'rgba(255,255,255,0.05)';
                ctx.lineWidth = 1;
            }
            // Draw separator/outline
            ctx.beginPath();
            ctx.moveTo(col.x, 0);
            ctx.lineTo(col.x, canvas.height);
            ctx.stroke();
        });

        // Draw and update drops
        ctx.font = `${this.fontSize}px monospace`;
        this.columns.forEach(col => {
            const stat = this.serviceStats[col.name] || { boost: 1 };
            // Spawn modulation: decrease wait when boost>1
            col.nextDrop -= stat.boost;
            if (col.nextDrop <= 0) {
                // Prefer spawning error-level drops more often when anomalous
                const boosted = stat.boost > 1.01;
                if (boosted && Math.random() < 0.6) {
                    // Try to find an error log for this service
                    const svcErrors = this.logEntries.filter(l => l.service === col.name && l.level === 'error');
                    if (svcErrors.length > 0) {
                        const log = svcErrors[Math.floor(Math.random() * svcErrors.length)];
                        const chars = (log.message || 'log').split('');
                        col.drops.push({
                            chars,
                            y: -Math.random() * this.canvas.height * 0.5,
                            speed: 1.5 + Math.random() * 3.5,
                            charIndex: 0,
                            color: this.levelColors[log.level] || this.levelColors.info,
                            alpha: 0.5 + Math.random() * 0.5,
                            level: 'error'
                        });
                    } else {
                        this._addDrop(col);
                    }
                } else {
                    this._addDrop(col);
                }
                // Base between 20..80, reduced by boost factor
                const base = 20 + Math.random() * 60;
                col.nextDrop = Math.max(5, base / stat.boost);
            }

            col.drops = col.drops.filter(drop => {
                const x = col.x + 10;
                drop.y += drop.speed;

                // Draw each visible character
                const visibleChars = Math.floor(drop.y / (this.fontSize + 2));
                const startChar = Math.max(0, visibleChars - 20);
                for (let i = startChar; i < Math.min(visibleChars, drop.chars.length); i++) {
                    const charY = drop.y - (visibleChars - i) * (this.fontSize + 2);
                    if (charY < 30 || charY > canvas.height) continue;

                    const fade = i === visibleChars - 1 ? 1.0 : Math.max(0.05, 1 - (visibleChars - i) / 20);
                    ctx.globalAlpha = fade * drop.alpha;

                    // Lead character is bright white, rest in color
                    if (i === visibleChars - 1) {
                        ctx.fillStyle = '#ffffff';
                    } else {
                        ctx.fillStyle = drop.color;
                    }
                    ctx.fillText(drop.chars[i] || '.', x + (i % 3) * 0.5, charY);
                }
                ctx.globalAlpha = 1;

                return drop.y < canvas.height + 200;
            });
        });
    }

    _handleResize() {
        if (!this.container || !this.canvas) return;
        this.canvas.width = this.container.clientWidth;
        this.canvas.height = this.container.clientHeight;
        if (this.columns.length > 0) this._initColumns();
    }

    destroy() {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        window.removeEventListener('resize', this._onResize);
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
    }

    /**
     * Ingests an array of log entries into per-service rolling statistics.
     * Each entry must contain: { service, level, timestamp }
     * @param {Array} entries
     * @private
     */
    _ingestLogsIntoStats(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return;
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const ts = e.timestamp || Date.now();
            const svc = e.service || 'Unknown';
            if (!this.serviceStats[svc]) {
                this.serviceStats[svc] = {
                    timestamps: [],
                    errorTimestamps: [],
                    warnTimestamps: [],
                    lastPulse: 0,
                    pulsePhase: 0,
                    boost: 1
                };
            }
            const s = this.serviceStats[svc];
            s.timestamps.push(ts);
            if (e.level === 'error') s.errorTimestamps.push(ts);
            if (e.level === 'warn') s.warnTimestamps.push(ts);
        }
    }

    /**
     * Updates rolling stats by trimming timestamps outside the anomaly window.
     * Also ingests any new log entries that arrived since last ingestion.
     * @param {number} now
     * @private
     */
    _updateRollingStats(now) {
        // Ingest any new logs that may have been added externally
        if (this._lastIngestIndex < this.logEntries.length) {
            const newEntries = this.logEntries.slice(this._lastIngestIndex);
            this._ingestLogsIntoStats(newEntries);
            this._lastIngestIndex = this.logEntries.length;
        }

        const windowStart = now - this.anomalyWindowMs;
        for (const svc of this.serviceNames) {
            const s = this.serviceStats[svc];
            if (!s) continue;
            // Trim arrays efficiently by finding first index >= windowStart
            const trimArray = (arr) => {
                if (arr.length === 0) return arr;
                let idx = 0;
                while (idx < arr.length && arr[idx] < windowStart) idx++;
                if (idx > 0) arr.splice(0, idx);
                return arr;
            };
            trimArray(s.timestamps);
            trimArray(s.errorTimestamps);
            trimArray(s.warnTimestamps);
        }
    }

    /**
     * Computes error/warn rates and updates visual modulation boosts.
     * Boost scales between 1 and maxBoost when error rate exceeds threshold,
     * then decays smoothly back to 1 as rate falls.
     * @param {number} now
     * @private
     */
    _computeRatesAndBoosts(now) {
        for (const svc of this.serviceNames) {
            const s = this.serviceStats[svc];
            if (!s) continue;
            const total = s.timestamps.length;
            const errors = s.errorTimestamps.length;
            const errorRate = total > 0 ? errors / total : 0;

            if (errorRate > this.errorRateThreshold) {
                // Normalize how far above threshold up to 1.0
                const over = Math.min(1, (errorRate - this.errorRateThreshold) / Math.max(0.0001, 1 - this.errorRateThreshold));
                const targetBoost = 1 + (this.maxBoost - 1) * over;
                // Smoothly approach targetBoost
                s.boost = s.boost * 0.7 + targetBoost * 0.3;
                s.lastPulse = now;
            } else {
                // Decay boost towards 1
                s.boost = s.boost * 0.9 + 1 * 0.1;
                if (Math.abs(s.boost - 1) < 0.01) s.boost = 1;
            }
        }
    }
}

if (typeof window !== 'undefined') window.LogWaterfallViz = LogWaterfallViz;
