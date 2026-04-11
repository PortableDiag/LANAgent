/**
 * Trust Graph — 3D ERC-8107 Trust Attestation Visualization
 * Fetches real attestation data from /api/external/trust/admin/graph.
 * Nodes = ENS names, edges = trust attestations colored by trust level.
 */
class TrustGraphViz {
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
        this.scene.background = new THREE.Color(0x080812);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 500);
        this.camera.position.set(0, 12, 28);

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
        const pl = new THREE.PointLight(0x00ff88, 0.8, 80);
        pl.position.set(0, 15, 0);
        this.scene.add(pl);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '8px 12px', background: 'rgba(0,0,0,0.9)',
            color: '#fff', borderRadius: '6px', fontSize: '13px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #2ecc71', maxWidth: '280px'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    _trustColor(level) {
        const l = (level || '').toLowerCase();
        if (l === 'full' || l === 'ultimate') return 0x2ecc71;
        if (l === 'marginal' || l === 'partial') return 0xf1c40f;
        if (l === 'none' || l === 'revoked') return 0xe74c3c;
        return 0x95a5a6;
    }

    _trustColorHex(level) {
        const l = (level || '').toLowerCase();
        if (l === 'full' || l === 'ultimate') return '#2ecc71';
        if (l === 'marginal' || l === 'partial') return '#f1c40f';
        if (l === 'none' || l === 'revoked') return '#e74c3c';
        return '#95a5a6';
    }

    async _fetchAndBuild() {
        let nodes = [], edges = [];

        try {
            const token = localStorage.getItem('lanagent_token');
            const resp = await fetch('/api/external/trust/admin/graph', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                // API returns { success, graph: [{trustorName, trusteeName, level, scopeName, source}] }
                if (data.success && Array.isArray(data.graph) && data.graph.length > 0) {
                    const nodeSet = new Map(); // name -> { id, bestLevel, scopes, sources, edgeCount }
                    const edgeList = [];

                    data.graph.forEach(att => {
                        const from = att.trustorName || 'unknown';
                        const to = att.trusteeName || 'unknown';
                        const level = att.level || 'Unknown';
                        const scope = att.scopeName || 'universal';
                        const source = att.source || 'manual';

                        // Track nodes with metadata
                        if (!nodeSet.has(from)) nodeSet.set(from, { id: from, levels: [], scopes: new Set(), sources: new Set(), edgeCount: 0 });
                        if (!nodeSet.has(to)) nodeSet.set(to, { id: to, levels: [], scopes: new Set(), sources: new Set(), edgeCount: 0 });

                        const fromNode = nodeSet.get(from);
                        const toNode = nodeSet.get(to);
                        fromNode.edgeCount++;
                        toNode.edgeCount++;
                        toNode.levels.push(level);
                        fromNode.scopes.add(scope);
                        toNode.scopes.add(scope);
                        fromNode.sources.add(source);
                        toNode.sources.add(source);

                        edgeList.push({ from, to, level, scope, source });
                    });

                    // Convert to node array, determine best trust level per node
                    const levelRank = { Full: 3, Marginal: 2, None: 1, Unknown: 0 };
                    nodeSet.forEach((info, name) => {
                        // Best level received
                        let bestLevel = 'Unknown';
                        info.levels.forEach(l => {
                            if ((levelRank[l] || 0) > (levelRank[bestLevel] || 0)) bestLevel = l;
                        });
                        // Node with most edges is "ultimate" (anchor/hub)
                        nodes.push({
                            id: name,
                            label: name,
                            trustLevel: bestLevel,
                            scopes: Array.from(info.scopes),
                            sources: Array.from(info.sources),
                            edgeCount: info.edgeCount,
                            isHub: false
                        });
                    });

                    // Mark the node with most connections as hub
                    if (nodes.length > 0) {
                        nodes.sort((a, b) => b.edgeCount - a.edgeCount);
                        nodes[0].isHub = true;
                        nodes[0].trustLevel = 'ultimate';
                    }

                    edges = edgeList;
                }
            }
        } catch (e) { /* fallback below */ }

        // If no real data, show a message instead of fake data
        if (nodes.length === 0) {
            nodes = [
                { id: 'No attestations yet', label: 'No attestations yet', trustLevel: 'unknown', scopes: [], sources: [], edgeCount: 0, isHub: true }
            ];
        }

        // Position nodes in 3D space
        const nodeMap = {};
        nodes.forEach((node, i) => {
            const phi = Math.acos(-1 + (2 * i + 1) / nodes.length);
            const theta = Math.sqrt(nodes.length * Math.PI) * phi;
            const r = nodes.length === 1 ? 0 : 10 + Math.random() * 3;

            const color = this._trustColor(node.trustLevel);
            const isHub = node.isHub;
            const size = isHub ? 1.8 : 1.0;
            const geo = isHub ? new THREE.DodecahedronGeometry(size) : new THREE.SphereGeometry(size, 24, 24);
            const mat = new THREE.MeshPhongMaterial({
                color, emissive: color, emissiveIntensity: 0.5,
                transparent: true, opacity: 0.85
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(
                r * Math.sin(phi) * Math.cos(theta),
                r * Math.cos(phi),
                r * Math.sin(phi) * Math.sin(theta)
            );
            mesh.userData = { ...node };
            this.scene.add(mesh);
            this.nodeMeshes.push(mesh);
            nodeMap[node.id] = mesh;

            // Label
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 48;
            const ctx = canvas.getContext('2d');
            ctx.font = isHub ? 'bold 22px monospace' : '18px monospace';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(node.label || node.id, 256, 32);
            const tex = new THREE.CanvasTexture(canvas);
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.8 }));
            sprite.position.copy(mesh.position);
            sprite.position.y += size + 1.5;
            sprite.scale.set(8, 1, 1);
            this.scene.add(sprite);
        });

        // Create edges
        edges.forEach(edge => {
            const fromMesh = nodeMap[edge.from];
            const toMesh = nodeMap[edge.to];
            if (!fromMesh || !toMesh) return;

            const color = this._trustColor(edge.level);
            const points = [fromMesh.position.clone(), toMesh.position.clone()];
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
            const line = new THREE.Line(geo, mat);
            line.userData = { _from: edge.from, _to: edge.to, level: edge.level, scope: edge.scope, source: edge.source, phase: Math.random() * Math.PI * 2 };
            this.scene.add(line);
            this.edgeLines.push(line);
        });

        // Ambient particles
        const pGeo = new THREE.BufferGeometry();
        const pPos = new Float32Array(300 * 3);
        for (let i = 0; i < 300; i++) {
            pPos[i * 3] = (Math.random() - 0.5) * 60;
            pPos[i * 3 + 1] = (Math.random() - 0.5) * 60;
            pPos[i * 3 + 2] = (Math.random() - 0.5) * 60;
        }
        pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        this.scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0x2ecc71, size: 0.12, transparent: true, opacity: 0.3 })));
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '280px',
            background: 'rgba(8,8,18,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '13px', display: 'none', zIndex: '200',
            border: '1px solid #2ecc71', boxShadow: '0 4px 24px rgba(46,204,113,0.15)',
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
        const trustC = this._trustColorHex(d.trustLevel);
        const borderColor = trustC;

        // Find edges involving this node to show trust relationships
        const relationships = [];
        this.edgeLines.forEach(edge => {
            if (edge.userData._from === d.id || edge.userData._to === d.id) {
                const other = edge.userData._from === d.id ? edge.userData._to : edge.userData._from;
                relationships.push(`${other} (${edge.userData.level})`);
            }
        });

        let rows = '';
        const addRow = (label, value, c) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${c || '#fff'};text-align:right;max-width:160px">${value}</span>
            </div>`;
        };

        addRow('Trust Level', d.trustLevel, trustC);
        if (d.isHub) addRow('Role', 'Hub (most connected)', '#ffd700');
        addRow('Connections', d.edgeCount);
        if (d.scopes?.length) addRow('Scopes', d.scopes.join(', '));
        if (d.sources?.length) addRow('Sources', d.sources.join(', '));
        if (relationships.length > 0) addRow('Relationships', relationships.slice(0, 5).join(', '));

        this.infoCard.style.borderColor = borderColor;
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(46,204,113,0.08);border-bottom:1px solid ${borderColor}">
                <strong style="font-size:14px">${d.label || d.id}</strong>
                <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
            </div>
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
            const c = this._trustColorHex(d.trustLevel);
            let html = `<strong>${d.label || d.id}</strong><br>Trust: <span style="color:${c}">${d.trustLevel || 'unknown'}</span>`;
            if (d.scopes?.length) html += `<br>Scopes: ${d.scopes.join(', ')}`;
            if (d.sources?.length) html += `<br>Sources: ${d.sources.join(', ')}`;
            if (d.edgeCount) html += `<br>Connections: ${d.edgeCount}`;
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

        this.nodeMeshes.forEach((mesh, i) => {
            mesh.rotation.y = t * 0.2 + i;
            mesh.material.emissiveIntensity = 0.4 + Math.sin(t * 1.5 + i * 0.8) * 0.15;
        });

        this.edgeLines.forEach(line => {
            line.material.opacity = 0.3 + Math.sin(t * 2 + line.userData.phase) * 0.2;
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
        if (this.renderer) {
            this.renderer.dispose();
            this.container.removeChild(this.renderer.domElement);
        }
        this.scene = null;
    }
}

if (typeof window !== 'undefined') window.TrustGraphViz = TrustGraphViz;
