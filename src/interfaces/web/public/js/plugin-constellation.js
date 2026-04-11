/**
 * Plugin Constellation — 3D Visualization of Agent Plugin Ecosystem
 * Agent core at center, plugins as orbiting nodes grouped by category.
 * Size: command count, Color: category, Brightness: enabled/disabled.
 */
class PluginConstellationViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.nodeMeshes = [];
        this.edgeLines = [];
        this.animationId = null;
        this.clock = new THREE.Clock();
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.tooltip = null;
        this.centerMesh = null;
    }

    async init() {
        this._setupScene();
        this._setupLights();
        this._createTooltip();
        this._createInfoCard();
        await this._fetchAndBuild();
        this._onResize = () => this._handleResize();
        this._onMouseMove = (e) => this._handleMouseMove(e);
        this._onPointerDown = (e) => { this._pointerStart = { x: e.clientX, y: e.clientY }; };
        this._onPointerUp = (e) => {
            if (!this._pointerStart) return;
            const dx = e.clientX - this._pointerStart.x, dy = e.clientY - this._pointerStart.y;
            if (dx * dx + dy * dy < 25) this._handleClick(e);
            this._pointerStart = null;
        };
        window.addEventListener('resize', this._onResize);
        this.container.addEventListener('mousemove', this._onMouseMove);
        this.container.addEventListener('pointerdown', this._onPointerDown);
        this.container.addEventListener('pointerup', this._onPointerUp);
        this.animate();
    }

    _setupScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x06080e);
        this.scene.fog = new THREE.FogExp2(0x06080e, 0.006);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 500);
        this.camera.position.set(0, 25, 55);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
    }

    _setupLights() {
        this.scene.add(new THREE.AmbientLight(0x404060, 0.5));
        const pl = new THREE.PointLight(0x1abc9c, 0.8, 120);
        pl.position.set(0, 25, 0);
        this.scene.add(pl);
        const pl2 = new THREE.PointLight(0x9b59b6, 0.4, 80);
        pl2.position.set(-20, -10, 15);
        this.scene.add(pl2);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '8px 12px', background: 'rgba(0,0,0,0.9)',
            color: '#fff', borderRadius: '6px', fontSize: '12px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #1abc9c', maxWidth: '300px',
            fontFamily: 'monospace'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '310px',
            background: 'rgba(6,8,14,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '12px', display: 'none', zIndex: '200',
            border: '1px solid #1abc9c', boxShadow: '0 4px 24px rgba(26,188,156,0.2)',
            fontFamily: 'monospace', overflow: 'hidden', maxHeight: '80vh', overflowY: 'auto'
        });
        this.container.appendChild(this.infoCard);
        this._selectedMesh = null;
    }

    // Categorize plugins by name patterns
    _categorize(name) {
        const n = name.toLowerCase();
        if (['crypto', 'coingecko', 'chainlink', 'contract', 'cryptomonitor', 'virustotal'].some(k => n.includes(k))) return 'crypto';
        if (['network', 'mqtt', 'ssh', 'vpn', 'bluetooth', 'samba', 'ups'].some(k => n.includes(k))) return 'network';
        if (['sonarr', 'radarr', 'lidarr', 'readarr', 'prowlarr', 'jellyfin', 'calibre', 'ytdlp', 'ffmpeg', 'music', 'shazam', 'lyrics', 'voice'].some(k => n.includes(k))) return 'media';
        if (['docker', 'git', 'development', 'devenv', 'projects', 'software', 'microcontroller'].some(k => n.includes(k))) return 'dev';
        if (['system', 'monitoring', 'diagnostics', 'selfhealing', 'bugdetector', 'backup', 'agentstats'].some(k => n.includes(k))) return 'system';
        if (['email', 'twitter', 'calendar', 'journal', 'digest', 'tasks'].some(k => n.includes(k))) return 'communication';
        if (['govee', 'eufy', 'deviceinfo'].some(k => n.includes(k))) return 'iot';
        if (['huggingface', 'mcp', 'knowledge', 'document', 'subagents', 'dry-ai', 'scraper', 'websearch'].some(k => n.includes(k))) return 'ai';
        if (['prreviewer', 'selfmod', 'apikeys'].some(k => n.includes(k))) return 'agent';
        return 'other';
    }

    _categoryColor(cat) {
        const colors = {
            crypto: 0xffd700,
            network: 0xe74c3c,
            media: 0x9b59b6,
            dev: 0x3498db,
            system: 0x2ecc71,
            communication: 0xe67e22,
            iot: 0x00bcd4,
            ai: 0xfd79a8,
            agent: 0xff6b35,
            other: 0x95a5a6
        };
        return colors[cat] || 0x95a5a6;
    }

    _categoryColorHex(cat) {
        const colors = {
            crypto: '#ffd700',
            network: '#e74c3c',
            media: '#9b59b6',
            dev: '#3498db',
            system: '#2ecc71',
            communication: '#e67e22',
            iot: '#00bcd4',
            ai: '#fd79a8',
            agent: '#ff6b35',
            other: '#95a5a6'
        };
        return colors[cat] || '#95a5a6';
    }

    _categoryLabel(cat) {
        const labels = {
            crypto: 'Crypto & Finance',
            network: 'Network & Connectivity',
            media: 'Media & Entertainment',
            dev: 'Development & Tools',
            system: 'System & Monitoring',
            communication: 'Communication',
            iot: 'IoT & Smart Home',
            ai: 'AI & Knowledge',
            agent: 'Agent Services',
            other: 'Other'
        };
        return labels[cat] || 'Other';
    }

    _formatName(name) {
        return name
            .replace(/([A-Z])/g, ' $1')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
    }

    async _fetchAndBuild() {
        let plugins = [];
        let agentName = 'Agent';

        try {
            const token = localStorage.getItem('lanagent_token');

            const sysResp = await fetch('/api/system/status', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (sysResp.ok) {
                const sysData = await sysResp.json();
                agentName = sysData.data?.agent?.name || sysData.agent?.name || 'Agent';
            }

            const resp = await fetch('/api/plugins', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                plugins = data.plugins || data.data?.plugins || [];
                if (!Array.isArray(plugins)) plugins = [];
            }
        } catch (e) { console.error('Plugin fetch error:', e); }

        // Categorize and enrich
        plugins = plugins.map(p => ({
            ...p,
            category: this._categorize(p.name),
            displayName: this._formatName(p.name)
        }));

        // Stats
        const enabledCount = plugins.filter(p => p.enabled).length;
        const totalCommands = plugins.reduce((sum, p) => sum + (p.commandCount || 0), 0);

        // Center node — agent core
        const centerGeo = new THREE.DodecahedronGeometry(2.5);
        const centerMat = new THREE.MeshPhongMaterial({
            color: 0x1abc9c, emissive: 0x1abc9c, emissiveIntensity: 0.6,
            transparent: true, opacity: 0.9
        });
        this.centerMesh = new THREE.Mesh(centerGeo, centerMat);
        this.centerMesh.userData = {
            isCenter: true, name: agentName,
            totalPlugins: plugins.length, enabledCount, totalCommands
        };
        this.scene.add(this.centerMesh);
        this.nodeMeshes.push(this.centerMesh);

        // Glow rings
        for (let r = 0; r < 2; r++) {
            const ringGeo = new THREE.RingGeometry(3.2 + r * 1.0, 3.5 + r * 1.0, 48);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x1abc9c, transparent: true, opacity: 0.10 - r * 0.03, side: THREE.DoubleSide
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = Math.PI / 2;
            this.scene.add(ring);
        }

        this._createLabel(agentName, new THREE.Vector3(0, 4.5, 0), true);

        // Group by category for angular clustering
        const categories = {};
        plugins.forEach(p => {
            if (!categories[p.category]) categories[p.category] = [];
            categories[p.category].push(p);
        });

        const catKeys = Object.keys(categories);
        const maxCmds = Math.max(...plugins.map(p => p.commandCount || 1), 1);
        let globalIdx = 0;

        catKeys.forEach((cat, catIdx) => {
            const catPlugins = categories[cat];
            const catAngle = (catIdx / catKeys.length) * Math.PI * 2;
            const color = this._categoryColor(cat);

            catPlugins.forEach((plugin, i) => {
                const cmds = plugin.commandCount || 1;
                const size = 0.4 + (cmds / maxCmds) * 1.8;

                // Arrange in a cone/cluster around the category angle
                const spread = 0.6; // radians of spread per category
                const angleOffset = (i - catPlugins.length / 2) * (spread / Math.max(catPlugins.length, 1));
                const angle = catAngle + angleOffset;

                // Enabled plugins closer, disabled further
                const baseR = plugin.enabled ? 14 : 24;
                const r = baseR + (i % 3) * 3;

                const x = r * Math.cos(angle);
                const y = (Math.random() - 0.5) * 12 + (plugin.enabled ? 0 : -3);
                const z = r * Math.sin(angle);

                const geo = plugin.enabled
                    ? new THREE.SphereGeometry(size, 20, 20)
                    : new THREE.OctahedronGeometry(size * 0.8);

                const mat = new THREE.MeshPhongMaterial({
                    color, emissive: color,
                    emissiveIntensity: plugin.enabled ? 0.5 : 0.08,
                    transparent: true,
                    opacity: plugin.enabled ? 0.85 : 0.25
                });

                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(x, y, z);
                mesh.userData = { ...plugin, size };
                this.scene.add(mesh);
                this.nodeMeshes.push(mesh);

                // Edge to center — enabled are brighter
                const points = [new THREE.Vector3(0, 0, 0), mesh.position.clone()];
                const edgeGeo = new THREE.BufferGeometry().setFromPoints(points);
                const edgeMat = new THREE.LineBasicMaterial({
                    color, transparent: true,
                    opacity: plugin.enabled ? 0.12 : 0.03
                });
                const line = new THREE.Line(edgeGeo, edgeMat);
                line.userData = { phase: Math.random() * Math.PI * 2, enabled: plugin.enabled };
                this.scene.add(line);
                this.edgeLines.push(line);

                // Labels for enabled plugins with > 5 commands
                if (plugin.enabled && cmds >= 5) {
                    const label = plugin.displayName.length > 14 ? plugin.displayName.slice(0, 12) + '..' : plugin.displayName;
                    this._createLabel(label, new THREE.Vector3(x, y + size + 1.2, z));
                }

                globalIdx++;
            });
        });

        // Legend
        this._createLegend(catKeys);

        // Star field
        const pGeo = new THREE.BufferGeometry();
        const pPos = new Float32Array(500 * 3);
        const pColors = new Float32Array(500 * 3);
        for (let i = 0; i < 500; i++) {
            pPos[i * 3] = (Math.random() - 0.5) * 120;
            pPos[i * 3 + 1] = (Math.random() - 0.5) * 80;
            pPos[i * 3 + 2] = (Math.random() - 0.5) * 120;
            const c = new THREE.Color(this._categoryColor(catKeys[i % catKeys.length]));
            pColors[i * 3] = c.r;
            pColors[i * 3 + 1] = c.g;
            pColors[i * 3 + 2] = c.b;
        }
        pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        pGeo.setAttribute('color', new THREE.BufferAttribute(pColors, 3));
        this.scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({
            size: 0.1, transparent: true, opacity: 0.2, vertexColors: true
        })));
    }

    _createLabel(text, position, isBold, color) {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.font = isBold ? 'bold 22px monospace' : '14px monospace';
        ctx.fillStyle = color || '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(text, 256, 32);
        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: isBold ? 0.9 : 0.6 }));
        sprite.position.copy(position);
        sprite.scale.set(isBold ? 10 : 6, isBold ? 1.2 : 0.8, 1);
        this.scene.add(sprite);
    }

    _createLegend(catKeys) {
        const legend = document.createElement('div');
        Object.assign(legend.style, {
            position: 'absolute', bottom: '12px', left: '12px', padding: '10px 14px',
            background: 'rgba(0,0,0,0.8)', borderRadius: '8px', fontSize: '11px',
            color: '#ccc', zIndex: '50', lineHeight: '1.8', fontFamily: 'monospace',
            border: '1px solid #333'
        });
        const lines = catKeys.map(cat =>
            `<span style="color:${this._categoryColorHex(cat)}">&#9679;</span> ${this._categoryLabel(cat)}`
        );
        lines.push('<span style="color:#888">&#9670;</span> Disabled (dim, octahedron)');
        legend.innerHTML = lines.join('<br>');
        this.container.appendChild(legend);
        this._legend = legend;
    }

    _handleClick(event) {
        const rect = this.container.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.nodeMeshes);

        if (intersects.length > 0) {
            const mesh = intersects[0].object;
            if (this._selectedMesh === mesh) { this._dismissInfoCard(); return; }
            this._selectedMesh = mesh;
            this._showInfoCard(mesh.userData);
        } else {
            this._dismissInfoCard();
        }
    }

    _showInfoCard(d) {
        if (d.isCenter) {
            let rows = '';
            const addRow = (label, value, color) => {
                rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                    <span style="color:#888">${label}</span>
                    <span style="color:${color || '#fff'}">${value}</span>
                </div>`;
            };
            addRow('Total Plugins', d.totalPlugins);
            addRow('Enabled', d.enabledCount, '#2ecc71');
            addRow('Disabled', d.totalPlugins - d.enabledCount, '#e74c3c');
            addRow('Total Commands', d.totalCommands);

            this.infoCard.style.borderColor = '#1abc9c';
            this.infoCard.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(26,188,156,0.08);border-bottom:1px solid #1abc9c">
                    <strong style="font-size:14px;color:#1abc9c">${d.name} - Plugin Hub</strong>
                    <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
                </div>
                <div style="padding:8px 14px">${rows}</div>
            `;
            this.infoCard.style.display = 'block';
            this.infoCard.querySelector('.info-card-close').addEventListener('click', (e) => {
                e.stopPropagation();
                this._dismissInfoCard();
            });
            return;
        }

        const catColor = this._categoryColorHex(d.category);
        const borderColor = d.enabled ? catColor : '#555';

        let rows = '';
        const addRow = (label, value, color) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${color || '#fff'};text-align:right;max-width:180px">${value}</span>
            </div>`;
        };

        addRow('Status', d.enabled ? 'Enabled' : 'Disabled', d.enabled ? '#2ecc71' : '#e74c3c');
        addRow('Category', this._categoryLabel(d.category), catColor);
        addRow('Version', d.version);
        addRow('Commands', d.commandCount);
        if (d.lastUsed) addRow('Last Used', new Date(d.lastUsed).toLocaleString());
        if (d.error) addRow('Error', d.error, '#e74c3c');

        // Show command list
        let cmdHtml = '';
        if (d.commands && d.commands.length > 0) {
            cmdHtml = '<div style="padding:6px 14px;border-top:1px solid rgba(255,255,255,0.06)">';
            cmdHtml += '<div style="color:#888;margin-bottom:4px;font-size:11px">Commands:</div>';
            d.commands.slice(0, 8).forEach(cmd => {
                cmdHtml += `<div style="padding:2px 0;font-size:11px"><span style="color:${catColor}">${cmd.command}</span> <span style="color:#555">— ${(cmd.description || '').slice(0, 40)}</span></div>`;
            });
            if (d.commands.length > 8) cmdHtml += `<div style="color:#555;font-size:11px">...and ${d.commands.length - 8} more</div>`;
            cmdHtml += '</div>';
        }

        this.infoCard.style.borderColor = borderColor;
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(26,188,156,0.06);border-bottom:1px solid ${borderColor}">
                <strong style="font-size:14px">${d.displayName}</strong>
                <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
            </div>
            <div style="padding:4px 14px;color:#aaa;font-size:11px">${d.description || ''}</div>
            <div style="padding:4px 14px">${rows}</div>
            ${cmdHtml}
        `;
        this.infoCard.style.display = 'block';
        this.infoCard.querySelector('.info-card-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this._dismissInfoCard();
        });
    }

    _dismissInfoCard() {
        this.infoCard.style.display = 'none';
        this._selectedMesh = null;
    }

    _handleMouseMove(event) {
        const rect = this.container.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.nodeMeshes);

        if (intersects.length > 0) {
            const d = intersects[0].object.userData;
            if (d.isCenter) {
                this.tooltip.innerHTML = `<strong style="color:#1abc9c">${d.name}</strong><br>${d.enabledCount}/${d.totalPlugins} plugins enabled<br>${d.totalCommands} total commands`;
            } else {
                const catColor = this._categoryColorHex(d.category);
                let html = `<strong>${d.displayName}</strong>`;
                html += `<br><span style="color:${catColor}">${this._categoryLabel(d.category)}</span>`;
                html += `<br>Status: <span style="color:${d.enabled ? '#2ecc71' : '#e74c3c'}">${d.enabled ? 'Enabled' : 'Disabled'}</span>`;
                html += `<br>Commands: ${d.commandCount || 0}`;
                if (d.description) html += `<br><span style="color:#888">${d.description.slice(0, 60)}</span>`;
                this.tooltip.innerHTML = html;
            }
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = (event.clientX - rect.left + 15) + 'px';
            this.tooltip.style.top = (event.clientY - rect.top + 15) + 'px';
        } else {
            this.tooltip.style.display = 'none';
        }
    }

    animate() {
        this.animationId = requestAnimationFrame(() => this.animate());
        const t = this.clock.getElapsedTime();

        if (this.centerMesh) {
            this.centerMesh.rotation.y = t * 0.2;
            this.centerMesh.material.emissiveIntensity = 0.5 + Math.sin(t * 1.5) * 0.15;
        }

        this.nodeMeshes.forEach((mesh, i) => {
            if (mesh === this.centerMesh) return;
            mesh.rotation.y = t * 0.3 + i * 0.5;
            const base = mesh.userData.enabled ? 0.4 : 0.05;
            mesh.material.emissiveIntensity = base + Math.sin(t * 1.2 + i * 0.3) * (mesh.userData.enabled ? 0.15 : 0.03);
            // Gentle bob
            mesh.position.y += Math.sin(t * 0.3 + i * 0.5) * 0.001;
        });

        this.edgeLines.forEach(line => {
            const base = line.userData.enabled ? 0.1 : 0.02;
            line.material.opacity = base + Math.sin(t * 2 + line.userData.phase) * 0.05;
        });

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    _handleResize() {
        if (!this.container) return;
        const w = this.container.clientWidth, h = this.container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    destroy() {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        window.removeEventListener('resize', this._onResize);
        this.container.removeEventListener('mousemove', this._onMouseMove);
        this.container.removeEventListener('pointerdown', this._onPointerDown);
        this.container.removeEventListener('pointerup', this._onPointerUp);
        if (this.tooltip && this.tooltip.parentNode) this.tooltip.parentNode.removeChild(this.tooltip);
        if (this.infoCard && this.infoCard.parentNode) this.infoCard.parentNode.removeChild(this.infoCard);
        if (this._legend && this._legend.parentNode) this._legend.parentNode.removeChild(this._legend);
        if (this.renderer) {
            this.renderer.dispose();
            this.container.removeChild(this.renderer.domElement);
        }
        this.scene = null;
    }
}

if (typeof window !== 'undefined') window.PluginConstellationViz = PluginConstellationViz;
