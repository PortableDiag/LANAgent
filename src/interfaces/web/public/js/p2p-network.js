/**
 * P2P Network — 3D Visualization of Federation Peers
 * Agent at center, P2P peers as orbiting nodes.
 * Size: trust score, Color: trust level, Distance: activity frequency.
 */
class P2PNetworkViz {
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
        this.scene.background = new THREE.Color(0x08081a);
        this.scene.fog = new THREE.FogExp2(0x08081a, 0.008);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 500);
        this.camera.position.set(0, 18, 40);

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
        const pl = new THREE.PointLight(0x9b59b6, 0.8, 100);
        pl.position.set(0, 20, 0);
        this.scene.add(pl);
        const pl2 = new THREE.PointLight(0x00a8ff, 0.4, 80);
        pl2.position.set(-15, -5, 10);
        this.scene.add(pl2);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '8px 12px', background: 'rgba(0,0,0,0.9)',
            color: '#fff', borderRadius: '6px', fontSize: '12px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #9b59b6', maxWidth: '300px',
            fontFamily: 'monospace'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '300px',
            background: 'rgba(8,8,26,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '12px', display: 'none', zIndex: '200',
            border: '1px solid #9b59b6', boxShadow: '0 4px 24px rgba(155,89,182,0.2)',
            fontFamily: 'monospace', overflow: 'hidden'
        });
        this.container.appendChild(this.infoCard);
        this._selectedMesh = null;
    }

    _peerColor(peer) {
        if (peer.isCenter) return 0x00ddff;
        if (peer.trustLevel === 'trusted') return 0x2ecc71;
        return 0xe74c3c;
    }

    _peerColorHex(peer) {
        if (peer.isCenter) return '#00ddff';
        if (peer.trustLevel === 'trusted') return '#2ecc71';
        return '#e74c3c';
    }

    _shortFingerprint(fp) {
        if (!fp) return '?';
        return fp.slice(0, 8) + '...' + fp.slice(-4);
    }

    async _fetchAndBuild() {
        let identity = null;
        let peers = [];
        let agentName = 'Agent';
        let p2pEnabled = false;

        try {
            const token = localStorage.getItem('lanagent_token');

            // Get agent name from system status
            const sysResp = await fetch('/api/system/status', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (sysResp.ok) {
                const sysData = await sysResp.json();
                const agent = sysData.data?.agent || sysData.agent || {};
                agentName = agent.name || 'Agent';
            }

            // Get P2P identity (routes mounted at /p2p/api/...)
            const statusResp = await fetch('/p2p/api/status', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (statusResp.ok) {
                const data = await statusResp.json();
                if (data.success) {
                    identity = data.identity || data;
                    p2pEnabled = data.enabled !== false;
                }
            }

            // Get peers
            if (p2pEnabled) {
                const peersResp = await fetch('/p2p/api/peers', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (peersResp.ok) {
                    const data = await peersResp.json();
                    if (data.success) peers = data.peers || [];
                }
            }
        } catch (e) { console.error('P2P fetch error:', e); }

        // Build center node — this agent
        agentName = identity?.displayName || identity?.agentName || agentName;
        const centerNode = {
            isCenter: true,
            displayName: agentName,
            fingerprint: identity?.fingerprint || '',
            trustLevel: 'self',
            isOnline: true
        };

        // Create center mesh
        const centerGeo = new THREE.DodecahedronGeometry(2.2);
        const centerMat = new THREE.MeshPhongMaterial({
            color: 0x00ddff, emissive: 0x00ddff, emissiveIntensity: 0.6,
            transparent: true, opacity: 0.9
        });
        this.centerMesh = new THREE.Mesh(centerGeo, centerMat);
        this.centerMesh.userData = centerNode;
        this.scene.add(this.centerMesh);
        this.nodeMeshes.push(this.centerMesh);

        // Glow rings
        for (let r = 0; r < 2; r++) {
            const ringGeo = new THREE.RingGeometry(2.8 + r * 0.8, 3.0 + r * 0.8, 48);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x00ddff, transparent: true, opacity: 0.12 - r * 0.04, side: THREE.DoubleSide
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = Math.PI / 2;
            this.scene.add(ring);
        }

        // Center label
        this._createLabel(agentName, new THREE.Vector3(0, 3.5, 0), true);

        if (!p2pEnabled) {
            this._createLabel('P2P Federation not enabled', new THREE.Vector3(0, -3, 0), false, '#888888');
            this._createLabel('Enable in Settings to discover peers', new THREE.Vector3(0, -5, 0), false, '#555555');
        } else if (peers.length === 0) {
            this._createLabel('No peers discovered yet', new THREE.Vector3(0, -3, 0), false, '#888888');
        }

        // Place peer nodes
        const maxTransfers = Math.max(...peers.map(p => p.transferCount || 0), 1);
        peers.forEach((peer, i) => {
            const transferRatio = (peer.transferCount || 0) / maxTransfers;
            const distance = 25 - transferRatio * 15; // more transfers = closer
            const trustScore = peer.trustScore || 0;
            const size = 0.6 + (trustScore / 100) * 1.5;

            const phi = Math.acos(-1 + (2 * i + 1) / Math.max(peers.length, 1));
            const theta = Math.sqrt(peers.length * Math.PI) * phi;

            const x = distance * Math.sin(phi) * Math.cos(theta);
            const y = distance * Math.cos(phi) * 0.6;
            const z = distance * Math.sin(phi) * Math.sin(theta);

            const color = this._peerColor(peer);
            const geo = peer.trustLevel === 'trusted'
                ? new THREE.SphereGeometry(size, 24, 24)
                : new THREE.OctahedronGeometry(size);

            const mat = new THREE.MeshPhongMaterial({
                color, emissive: color,
                emissiveIntensity: peer.isOnline ? 0.5 : 0.1,
                transparent: true, opacity: peer.isOnline ? 0.85 : 0.35
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(x, y, z);
            mesh.userData = { ...peer, distance };
            this.scene.add(mesh);
            this.nodeMeshes.push(mesh);

            // Edge to center
            const edgeColor = color;
            const points = [new THREE.Vector3(0, 0, 0), mesh.position.clone()];
            const edgeGeo = new THREE.BufferGeometry().setFromPoints(points);
            const edgeMat = new THREE.LineBasicMaterial({
                color: edgeColor, transparent: true,
                opacity: peer.isOnline ? 0.2 + transferRatio * 0.3 : 0.05
            });
            const line = new THREE.Line(edgeGeo, edgeMat);
            line.userData = { phase: Math.random() * Math.PI * 2, isOnline: peer.isOnline };
            this.scene.add(line);
            this.edgeLines.push(line);

            // Label for online or trusted peers
            if (peer.isOnline || peer.trustLevel === 'trusted') {
                const label = peer.displayName || this._shortFingerprint(peer.fingerprint);
                this._createLabel(label, new THREE.Vector3(x, y + size + 1.2, z), false,
                    peer.trustLevel === 'trusted' ? '#2ecc71' : '#aabbcc');
            }
        });

        // Legend
        this._createLegend();

        // Ambient particles
        const pGeo = new THREE.BufferGeometry();
        const pPos = new Float32Array(400 * 3);
        for (let i = 0; i < 400; i++) {
            pPos[i * 3] = (Math.random() - 0.5) * 80;
            pPos[i * 3 + 1] = (Math.random() - 0.5) * 60;
            pPos[i * 3 + 2] = (Math.random() - 0.5) * 80;
        }
        pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        this.scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({
            color: 0x9b59b6, size: 0.12, transparent: true, opacity: 0.3
        })));
    }

    _createLabel(text, position, isBold, color) {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 48;
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
            '<span style="color:#00ddff">&#9670;</span> This Agent (center)',
            '<span style="color:#2ecc71">&#9679;</span> Trusted Peer',
            '<span style="color:#e74c3c">&#9670;</span> Untrusted Peer',
            '<span style="color:#888">&mdash;</span> Brighter = more active'
        ].join('<br>');
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
        const c = this._peerColorHex(d);
        const borderColor = d.isCenter ? '#00ddff' : d.trustLevel === 'trusted' ? '#2ecc71' : '#e74c3c';

        let rows = '';
        const addRow = (label, value, color) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${color || '#fff'};text-align:right;max-width:180px;word-break:break-all">${value}</span>
            </div>`;
        };

        addRow('Fingerprint', d.fingerprint || 'N/A');
        if (!d.isCenter) {
            addRow('Trust', d.trustLevel || 'untrusted', d.trustLevel === 'trusted' ? '#2ecc71' : '#e74c3c');
            addRow('Status', d.isOnline ? 'Online' : 'Offline', d.isOnline ? '#2ecc71' : '#e74c3c');
            if (d.trustScore) addRow('Trust Score', d.trustScore + '/100');
            if (d.transferCount) addRow('Transfers', d.transferCount);
            if (d.capabilitiesCount) addRow('Capabilities', d.capabilitiesCount);
            if (d.erc8004?.verified) addRow('ERC-8004', 'Verified (Agent #' + d.erc8004.agentId + ')', '#2ecc71');
            if (d.skynetBalance > 0) addRow('Skynet Balance', d.skynetBalance);
            if (d.lastSeen) addRow('Last Seen', new Date(d.lastSeen).toLocaleString());
            if (d.firstSeen) addRow('First Seen', new Date(d.firstSeen).toLocaleString());
        }

        this.infoCard.style.borderColor = borderColor;
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(155,89,182,0.08);border-bottom:1px solid ${borderColor}">
                <strong style="font-size:14px;color:${c}">${d.displayName || this._shortFingerprint(d.fingerprint)}</strong>
                <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
            </div>
            ${d.isCenter ? '<div style="padding:4px 14px;background:rgba(0,221,255,0.1);color:#00ddff;font-size:11px;text-align:center">This Agent</div>' : ''}
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
            const c = this._peerColorHex(d);
            let html = `<strong style="color:${c}">${d.displayName || this._shortFingerprint(d.fingerprint)}</strong>`;
            if (d.isCenter) {
                html += '<br>This Agent';
            } else {
                html += `<br>Trust: <span style="color:${d.trustLevel === 'trusted' ? '#2ecc71' : '#e74c3c'}">${d.trustLevel}</span>`;
                html += `<br>Status: <span style="color:${d.isOnline ? '#2ecc71' : '#e74c3c'}">${d.isOnline ? 'Online' : 'Offline'}</span>`;
                if (d.transferCount) html += `<br>Transfers: ${d.transferCount}`;
                if (d.trustScore) html += `<br>Score: ${d.trustScore}/100`;
            }
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

        if (this.centerMesh) {
            this.centerMesh.rotation.y = t * 0.3;
            this.centerMesh.material.emissiveIntensity = 0.5 + Math.sin(t * 1.5) * 0.15;
        }

        this.nodeMeshes.forEach((mesh, i) => {
            if (mesh === this.centerMesh) return;
            mesh.rotation.y = t * 0.4 + i;
            const base = mesh.userData.isOnline ? 0.4 : 0.1;
            mesh.material.emissiveIntensity = base + Math.sin(t * 1.5 + i * 0.7) * 0.15;
        });

        this.edgeLines.forEach(line => {
            const base = line.userData.isOnline ? 0.2 : 0.03;
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

if (typeof window !== 'undefined') window.P2PNetworkViz = P2PNetworkViz;
