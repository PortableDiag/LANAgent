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
                        service: l.service || l.source || l.category || this.serviceNames[Math.floor(Math.random() * this.serviceNames.length)]
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
            for (let i = 0; i < 200; i++) {
                this.logEntries.push({
                    message: sampleMsgs[Math.floor(Math.random() * sampleMsgs.length)],
                    level: levels[Math.floor(Math.random() * levels.length)],
                    service: this.serviceNames[Math.floor(Math.random() * this.serviceNames.length)]
                });
            }
        }
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
            alpha: 0.3 + Math.random() * 0.7
        });
    }

    animate() {
        this.animationId = requestAnimationFrame(() => this.animate());
        this._draw();
    }

    _draw() {
        const { ctx, canvas } = this;
        // Fade effect
        ctx.fillStyle = 'rgba(5, 5, 15, 0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw column headers
        ctx.font = `bold ${this.fontSize + 2}px monospace`;
        this.columns.forEach(col => {
            ctx.fillStyle = this.serviceColors[col.name] || '#ffffff';
            ctx.globalAlpha = 0.7;
            ctx.fillText(col.name, col.x + 10, 20);
            ctx.globalAlpha = 1;

            // Draw separator line
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.beginPath();
            ctx.moveTo(col.x, 0);
            ctx.lineTo(col.x, canvas.height);
            ctx.stroke();
        });

        // Draw and update drops
        ctx.font = `${this.fontSize}px monospace`;
        this.columns.forEach(col => {
            col.nextDrop--;
            if (col.nextDrop <= 0) {
                this._addDrop(col);
                col.nextDrop = 20 + Math.random() * 60;
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
}

if (typeof window !== 'undefined') window.LogWaterfallViz = LogWaterfallViz;
