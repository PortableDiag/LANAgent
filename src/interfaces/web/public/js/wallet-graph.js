/**
 * Wallet Interaction Graph — 3D visualization of on-chain wallet interactions
 * Center: Agent's wallet address + ENS name
 * Nodes: Wallets/contracts the agent has interacted with
 * Size: Transaction value, Distance: Frequency (closer = more frequent)
 * Colors: Wallets (blue), Contracts (purple), Scammers (red)
 */
class WalletGraphViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.nodeMeshes = [];
        this.edgeLines = [];
        this.labelSprites = [];
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
        this.scene.background = new THREE.Color(0x060610);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 500);
        this.camera.position.set(0, 18, 35);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
    }

    _setupLights() {
        this.scene.add(new THREE.AmbientLight(0x303050, 0.5));
        const pl1 = new THREE.PointLight(0x4488ff, 0.8, 100);
        pl1.position.set(0, 20, 0);
        this.scene.add(pl1);
        const pl2 = new THREE.PointLight(0x8844ff, 0.5, 80);
        pl2.position.set(-15, -5, 10);
        this.scene.add(pl2);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '10px 14px', background: 'rgba(0,0,0,0.92)',
            color: '#fff', borderRadius: '8px', fontSize: '12px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #4488ff', maxWidth: '320px',
            fontFamily: 'monospace', lineHeight: '1.5'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    _nodeColor(node) {
        if (node.isScammer) return 0xff2244;
        if (node.isCenter) return 0x00ddff;
        if (node.isContract) return 0xaa44ff;
        return 0x4488ff;
    }

    _nodeColorHex(node) {
        if (node.isScammer) return '#ff2244';
        if (node.isCenter) return '#00ddff';
        if (node.isContract) return '#aa44ff';
        return '#4488ff';
    }

    _edgeColor(node) {
        if (node.isScammer) return 0xff2244;
        if (node.isContract) return 0x7733cc;
        return 0x335599;
    }

    _shortAddr(addr) {
        if (!addr) return '?';
        return addr.slice(0, 6) + '...' + addr.slice(-4);
    }

    async _fetchAndBuild() {
        let wallet = null;
        let interactions = [];

        try {
            const token = localStorage.getItem('lanagent_token');
            const resp = await fetch('/api/crypto/interactions', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.success) {
                    wallet = data.wallet;
                    interactions = data.interactions || [];
                }
            }
        } catch (e) { console.error('Failed to fetch interactions:', e); }

        if (!wallet) {
            this._showMessage('No wallet data available');
            return;
        }

        // Build center node
        const centerLabel = wallet.ensName || this._shortAddr(wallet.address);
        const centerNode = {
            address: wallet.address,
            label: centerLabel,
            isCenter: true,
            isContract: false,
            isScammer: false,
            txCount: 0,
            totalValueUsd: 0
        };

        // Compute distance based on interaction frequency
        // More interactions = closer to center
        const maxTxCount = Math.max(...interactions.map(i => i.txCount), 1);
        const maxValue = Math.max(...interactions.map(i => i.totalValueUsd), 1);

        // Create center mesh — larger dodecahedron with glow
        const centerGeo = new THREE.DodecahedronGeometry(2.2);
        const centerMat = new THREE.MeshPhongMaterial({
            color: 0x00ddff, emissive: 0x00ddff, emissiveIntensity: 0.6,
            transparent: true, opacity: 0.9
        });
        this.centerMesh = new THREE.Mesh(centerGeo, centerMat);
        this.centerMesh.position.set(0, 0, 0);
        this.centerMesh.userData = centerNode;
        this.scene.add(this.centerMesh);
        this.nodeMeshes.push(this.centerMesh);

        // Glow rings around center
        for (let r = 0; r < 2; r++) {
            const ringGeo = new THREE.RingGeometry(2.8 + r * 0.8, 3.0 + r * 0.8, 48);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x00ddff, transparent: true, opacity: 0.15 - r * 0.05, side: THREE.DoubleSide
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = Math.PI / 2;
            this.scene.add(ring);
        }

        // Center label
        this._createLabel(centerLabel, new THREE.Vector3(0, 3.5, 0), true);

        // Place interaction nodes
        interactions.forEach((inter, i) => {
            // Distance: inverse of frequency — frequent = close
            const freqRatio = inter.txCount / maxTxCount; // 0..1
            const minDist = 6;
            const maxDist = 30;
            const distance = maxDist - (freqRatio * (maxDist - minDist));

            // Size: based on transaction value
            const valueRatio = Math.min(inter.totalValueUsd / Math.max(maxValue, 0.01), 1);
            const size = 0.4 + valueRatio * 1.8;

            // Distribute on a sphere at the computed distance
            const phi = Math.acos(-1 + (2 * i + 1) / Math.max(interactions.length, 1));
            const theta = Math.sqrt(interactions.length * Math.PI) * phi;

            const x = distance * Math.sin(phi) * Math.cos(theta);
            const y = distance * Math.cos(phi) * 0.6; // flatten vertically
            const z = distance * Math.sin(phi) * Math.sin(theta);

            const color = this._nodeColor(inter);

            // Contracts: octahedron, Wallets: sphere, Scammers: tetrahedron
            let geo;
            if (inter.isScammer) {
                geo = new THREE.TetrahedronGeometry(size);
            } else if (inter.isContract) {
                geo = new THREE.OctahedronGeometry(size);
            } else {
                geo = new THREE.SphereGeometry(size, 16, 16);
            }

            const mat = new THREE.MeshPhongMaterial({
                color, emissive: color, emissiveIntensity: inter.isScammer ? 0.7 : 0.4,
                transparent: true, opacity: 0.85
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(x, y, z);
            mesh.userData = {
                ...inter,
                label: this._shortAddr(inter.address),
                distance
            };
            this.scene.add(mesh);
            this.nodeMeshes.push(mesh);

            // Edge to center
            const edgeColor = this._edgeColor(inter);
            const points = [new THREE.Vector3(0, 0, 0), mesh.position.clone()];
            const edgeGeo = new THREE.BufferGeometry().setFromPoints(points);
            const edgeMat = new THREE.LineBasicMaterial({
                color: edgeColor, transparent: true,
                opacity: 0.15 + freqRatio * 0.35
            });
            const line = new THREE.Line(edgeGeo, edgeMat);
            line.userData = { phase: Math.random() * Math.PI * 2, freqRatio };
            this.scene.add(line);
            this.edgeLines.push(line);

            // Labels for top interactors or scammers
            if (i < 10 || inter.isScammer) {
                const label = inter.isScammer ? '⚠ ' + this._shortAddr(inter.address) : this._shortAddr(inter.address);
                this._createLabel(label, new THREE.Vector3(x, y + size + 1.2, z), false, inter.isScammer ? '#ff2244' : '#aabbcc');
            }
        });

        // Legend in bottom-left
        this._createLegend();

        // Ambient particles
        const pGeo = new THREE.BufferGeometry();
        const pCount = 400;
        const pPos = new Float32Array(pCount * 3);
        const pColors = new Float32Array(pCount * 3);
        for (let i = 0; i < pCount; i++) {
            pPos[i * 3] = (Math.random() - 0.5) * 70;
            pPos[i * 3 + 1] = (Math.random() - 0.5) * 50;
            pPos[i * 3 + 2] = (Math.random() - 0.5) * 70;
            // Mix of blue and purple particles
            const c = new THREE.Color(Math.random() > 0.5 ? 0x4488ff : 0x8844ff);
            pColors[i * 3] = c.r;
            pColors[i * 3 + 1] = c.g;
            pColors[i * 3 + 2] = c.b;
        }
        pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        pGeo.setAttribute('color', new THREE.BufferAttribute(pColors, 3));
        this.scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({
            size: 0.1, transparent: true, opacity: 0.25, vertexColors: true
        })));
    }

    _createLabel(text, position, isBold, color) {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.font = isBold ? 'bold 22px monospace' : '16px monospace';
        ctx.fillStyle = color || '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(text, 256, 32);
        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: isBold ? 0.9 : 0.7 }));
        sprite.position.copy(position);
        sprite.scale.set(isBold ? 10 : 7, isBold ? 1.2 : 0.9, 1);
        this.scene.add(sprite);
        this.labelSprites.push(sprite);
    }

    _createLegend() {
        const legend = document.createElement('div');
        Object.assign(legend.style, {
            position: 'absolute', bottom: '12px', left: '12px', padding: '10px 14px',
            background: 'rgba(0,0,0,0.8)', borderRadius: '8px', fontSize: '11px',
            color: '#ccc', zIndex: '50', lineHeight: '1.8', fontFamily: 'monospace',
            border: '1px solid #333'
        });
        legend.innerHTML = [
            '<span style="color:#00ddff">◆</span> Agent Wallet (center)',
            '<span style="color:#4488ff">●</span> Wallet (EOA)',
            '<span style="color:#aa44ff">◆</span> Contract',
            '<span style="color:#ff2244">▲</span> Scammer',
            '<span style="color:#888">—</span> Closer = more interactions'
        ].join('<br>');
        this.container.appendChild(legend);
        this._legend = legend;
    }

    _showMessage(msg) {
        const div = document.createElement('div');
        Object.assign(div.style, {
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            color: '#666', fontSize: '1.2em', fontFamily: 'monospace'
        });
        div.textContent = msg;
        this.container.appendChild(div);
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '300px',
            background: 'rgba(6,6,16,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '12px', display: 'none', zIndex: '200',
            border: '1px solid #4488ff', boxShadow: '0 4px 24px rgba(68,136,255,0.2)',
            fontFamily: 'monospace', overflow: 'hidden'
        });
        this.container.appendChild(this.infoCard);
        this._selectedMesh = null;
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
        const c = this._nodeColorHex(d);
        const typeLabel = d.isCenter ? 'Agent Wallet' : d.isScammer ? 'SCAMMER' : d.isContract ? 'Contract' : 'Wallet (EOA)';
        const borderColor = d.isScammer ? '#ff2244' : d.isCenter ? '#00ddff' : '#4488ff';

        let rows = '';
        const addRow = (label, value, color) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${color || '#fff'};text-align:right;max-width:180px;word-break:break-all">${value}</span>
            </div>`;
        };

        addRow('Address', d.address);
        if (d.isCenter && d.label !== d.address) addRow('ENS', d.label, '#00ddff');
        addRow('Type', typeLabel, c);
        if (!d.isCenter) {
            addRow('Transactions', d.txCount);
            if (d.totalValueUsd > 0) addRow('Total USD', '$' + d.totalValueUsd.toFixed(2));
            if (d.totalValueBnb > 0) addRow('Total BNB', d.totalValueBnb.toFixed(4));
            if (d.types?.length) addRow('Tx Types', d.types.join(', '));
            if (d.networks?.length) addRow('Networks', d.networks.join(', '));
            if (d.lastSeen) addRow('Last Seen', new Date(d.lastSeen).toLocaleString());
            if (d.firstSeen) addRow('First Seen', new Date(d.firstSeen).toLocaleString());
        }

        this.infoCard.style.borderColor = borderColor;
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(68,136,255,0.08);border-bottom:1px solid ${borderColor}">
                <strong style="font-size:14px;color:${c}">${typeLabel}</strong>
                <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
            </div>
            ${d.isScammer ? '<div style="padding:4px 14px;background:rgba(255,34,68,0.15);color:#ff2244;font-size:11px;text-align:center">REPORTED SCAMMER</div>' : ''}
            <div style="padding:8px 14px">${rows}</div>
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
            const c = this._nodeColorHex(d);
            let typeLabel = d.isCenter ? 'Agent Wallet' : d.isScammer ? 'SCAMMER' : d.isContract ? 'Contract' : 'Wallet';
            let html = `<strong style="color:${c}">${typeLabel}</strong><br>`;
            html += `<span style="color:#aaa">${d.address || d.label}</span>`;
            if (d.isCenter && d.label !== d.address) {
                html += `<br>ENS: <span style="color:#00ddff">${d.label}</span>`;
            }
            if (!d.isCenter) {
                html += `<br>Transactions: <strong>${d.txCount}</strong>`;
                if (d.totalValueUsd > 0) html += `<br>Value: <strong>$${d.totalValueUsd.toFixed(2)}</strong> (${d.totalValueBnb?.toFixed(4)} BNB)`;
                if (d.types?.length) html += `<br>Types: ${d.types.join(', ')}`;
                if (d.networks?.length) html += `<br>Networks: ${d.networks.join(', ')}`;
                if (d.lastSeen) html += `<br>Last: ${new Date(d.lastSeen).toLocaleDateString()}`;
            }
            if (d.isScammer) html += `<br><span style="color:#ff2244">⚠ REPORTED SCAMMER</span>`;
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = (event.clientX - rect.left + 15) + 'px';
            this.tooltip.style.top = (event.clientY - rect.top + 15) + 'px';
            this.tooltip.innerHTML = html;
        } else {
            this.tooltip.style.display = 'none';
        }
    }

    animate() {
        this.animationId = requestAnimationFrame(() => this.animate());
        const t = this.clock.getElapsedTime();

        // Rotate center node
        if (this.centerMesh) {
            this.centerMesh.rotation.y = t * 0.3;
            this.centerMesh.rotation.x = Math.sin(t * 0.2) * 0.1;
            this.centerMesh.material.emissiveIntensity = 0.5 + Math.sin(t * 1.5) * 0.15;
        }

        // Gentle rotation and pulse for other nodes
        this.nodeMeshes.forEach((mesh, i) => {
            if (mesh === this.centerMesh) return;
            mesh.rotation.y = t * 0.4 + i;
            if (mesh.userData.isScammer) {
                // Scammers pulse red more aggressively
                mesh.material.emissiveIntensity = 0.5 + Math.sin(t * 3 + i) * 0.3;
            } else {
                mesh.material.emissiveIntensity = 0.3 + Math.sin(t * 1.2 + i * 0.5) * 0.15;
            }
        });

        // Pulse edges
        this.edgeLines.forEach(line => {
            const base = 0.1 + (line.userData.freqRatio || 0) * 0.3;
            line.material.opacity = base + Math.sin(t * 2 + line.userData.phase) * 0.1;
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

if (typeof window !== 'undefined') window.WalletGraphViz = WalletGraphViz;
