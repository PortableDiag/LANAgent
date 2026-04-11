/**
 * Agent Brain — Neural Network Visualization
 * Dynamically builds nodes from live /api/system/status data.
 * Nodes = running services + interfaces, edges = logical dependencies.
 */
class AgentBrainViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.nodes = [];
        this.edges = [];
        this.labels = [];
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
        this.scene.background = new THREE.Color(0x0a0a1a);
        this.scene.fog = new THREE.FogExp2(0x0a0a1a, 0.012);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 1000);
        this.camera.position.set(0, 18, 35);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxDistance = 80;
    }

    _setupLights() {
        this.scene.add(new THREE.AmbientLight(0x404060, 0.5));
        const point = new THREE.PointLight(0x00a8ff, 1, 100);
        point.position.set(0, 20, 0);
        this.scene.add(point);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '8px 12px', background: 'rgba(0,0,0,0.9)',
            color: '#fff', borderRadius: '6px', fontSize: '13px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #00a8ff', maxWidth: '300px'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    // Color palette for service categories
    _serviceColor(name) {
        const n = name.toLowerCase();
        if (n.includes('crypto') || n.includes('swap') || n.includes('wallet')) return 0xffd700;
        if (n.includes('p2p') || n.includes('ens')) return 0x9b59b6;
        if (n.includes('scheduler') || n.includes('task') || n.includes('agenda')) return 0x2ecc71;
        if (n.includes('network') || n.includes('mqtt') || n.includes('event')) return 0xe74c3c;
        if (n.includes('self') || n.includes('bug') || n.includes('plugin-dev')) return 0xff6b35;
        if (n.includes('telegram')) return 0x0088cc;
        if (n.includes('plugin')) return 0x1abc9c;
        if (n.includes('memory') || n.includes('thought') || n.includes('vector')) return 0xe056fd;
        if (n.includes('security') || n.includes('scam') || n.includes('sentinel')) return 0xf39c12;
        if (n.includes('email')) return 0x3498db;
        if (n.includes('ai') || n.includes('react') || n.includes('embedding')) return 0xfd79a8;
        if (n.includes('web') || n.includes('ssh')) return 0x00bcd4;
        if (n.includes('diagnostic') || n.includes('healing') || n.includes('error')) return 0xff5252;
        if (n.includes('metric') || n.includes('report')) return 0x8bc34a;
        return 0x00a8ff;
    }

    _formatName(name) {
        return name
            .replace(/([A-Z])/g, ' $1')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
    }

    async _fetchAndBuild() {
        let serviceList = [];
        let interfaceList = [];
        let agentName = 'Agent';
        let uptime = '';
        let sysInfo = null;

        try {
            const token = localStorage.getItem('lanagent_token');
            const resp = await fetch('/api/system/status', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                agentName = data.agent?.name || 'Agent';
                uptime = data.agent?.uptime || '';
                sysInfo = data.system;

                // Collect services
                if (data.services?.list && Array.isArray(data.services.list)) {
                    serviceList = data.services.list.map(s => ({ name: s, type: 'service', active: true }));
                }
                // Collect interfaces
                if (data.interfaces?.list && Array.isArray(data.interfaces.list)) {
                    interfaceList = data.interfaces.list.map(s => ({ name: s, type: 'interface', active: true }));
                }
            }
        } catch (e) { /* fallback below */ }

        // Build combined node list with core at center
        const allNodes = [];

        // Core node (always present)
        allNodes.push({
            name: agentName,
            type: 'core',
            active: true,
            detail: uptime ? `Uptime: ${uptime}` : '',
            size: 2.2
        });

        // Add real services and interfaces
        serviceList.forEach(s => allNodes.push({ ...s, size: 1.0 }));
        interfaceList.forEach(s => allNodes.push({ ...s, size: 1.1 }));

        // If we got nothing, show a minimal fallback
        if (allNodes.length <= 1) {
            ['Crypto', 'Scheduler', 'Network', 'Plugins', 'AI Provider', 'Security', 'Self-Mod'].forEach(name => {
                allNodes.push({ name, type: 'service', active: true, size: 1.2 });
            });
        }

        // Position nodes: core at center, others on concentric shells
        const coreNode = allNodes[0];
        const others = allNodes.slice(1);

        // Core
        this._createNode(coreNode, [0, 0, 0]);

        // Distribute others on a sphere
        others.forEach((node, i) => {
            const phi = Math.acos(-1 + (2 * i + 1) / others.length);
            const theta = Math.sqrt(others.length * Math.PI) * phi;
            const r = 12 + (node.type === 'interface' ? 4 : 0);
            const pos = [
                r * Math.sin(phi) * Math.cos(theta),
                r * Math.cos(phi),
                r * Math.sin(phi) * Math.sin(theta)
            ];
            this._createNode(node, pos);
        });

        // Edges: core to all, plus some cross-links between related services
        for (let i = 1; i < this.nodes.length; i++) {
            this._createEdge(0, i);
        }
        // Cross-link nearby nodes
        for (let i = 1; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const dist = this.nodes[i].position.distanceTo(this.nodes[j].position);
                if (dist < 10) {
                    this._createEdge(i, j, 0.12);
                }
            }
        }

        // Ambient particles
        const particleGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(500 * 3);
        for (let i = 0; i < 500; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 80;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 80;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
        }
        particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.scene.add(new THREE.Points(particleGeo, new THREE.PointsMaterial({ color: 0x00a8ff, size: 0.15, transparent: true, opacity: 0.4 })));
    }

    _createNode(node, pos) {
        const size = node.size || 1.2;
        const color = node.type === 'core' ? 0x00a8ff : this._serviceColor(node.name);
        const isCore = node.type === 'core';

        const geo = isCore ? new THREE.DodecahedronGeometry(size) : new THREE.SphereGeometry(size, 32, 32);
        const mat = new THREE.MeshPhongMaterial({
            color,
            emissive: color,
            emissiveIntensity: node.active ? 0.6 : 0.1,
            transparent: true,
            opacity: node.active ? 0.9 : 0.4,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...pos);
        mesh.userData = {
            name: this._formatName(node.name),
            type: node.type,
            active: node.active,
            detail: node.detail || '',
            baseEmissive: node.active ? 0.6 : 0.1
        };
        this.scene.add(mesh);
        this.nodes.push(mesh);

        // Glow ring
        const ringGeo = new THREE.RingGeometry(size * 1.3, size * 1.6, 32);
        const ringMat = new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.15, side: THREE.DoubleSide
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(mesh.position);
        ring.lookAt(this.camera.position);
        this.scene.add(ring);

        // Label
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = isCore ? 'bold 26px Arial' : '22px Arial';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(this._formatName(node.name), 128, 40);
        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.8 }));
        sprite.position.set(pos[0], pos[1] + size + 1.5, pos[2]);
        sprite.scale.set(6, 1.5, 1);
        this.scene.add(sprite);
    }

    _createEdge(a, b, baseOpacity) {
        const points = [this.nodes[a].position, this.nodes[b].position];
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: 0x00a8ff, transparent: true, opacity: baseOpacity || 0.25
        });
        const line = new THREE.Line(geo, mat);
        line.userData = { a, b, phase: Math.random() * Math.PI * 2, baseOpacity: baseOpacity || 0.25 };
        this.scene.add(line);
        this.edges.push(line);
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '280px',
            background: 'rgba(10,10,26,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '13px', display: 'none', zIndex: '200',
            border: '1px solid #00a8ff', boxShadow: '0 4px 24px rgba(0,168,255,0.2)',
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
        const intersects = this.raycaster.intersectObjects(this.nodes);

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
        const typeLabel = d.type === 'core' ? 'Core Agent' : d.type === 'interface' ? 'Interface' : 'Service';
        const statusColor = d.active ? '#4caf50' : '#f44336';
        const color = d.type === 'core' ? '#00a8ff' : '#' + this._serviceColor(d.name || '').toString(16).padStart(6, '0');
        const borderColor = d.type === 'core' ? '#00a8ff' : color;

        // Find connected nodes
        const nodeIdx = this.nodes.indexOf(this._selectedMesh);
        const connections = [];
        this.edges.forEach(edge => {
            if (edge.userData.a === nodeIdx) connections.push(this.nodes[edge.userData.b]?.userData?.name);
            if (edge.userData.b === nodeIdx) connections.push(this.nodes[edge.userData.a]?.userData?.name);
        });

        let rows = '';
        const addRow = (label, value, c) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${c || '#fff'};text-align:right;max-width:160px">${value}</span>
            </div>`;
        };

        addRow('Type', typeLabel);
        addRow('Status', d.active ? 'Active' : 'Inactive', statusColor);
        if (d.detail) addRow('Info', d.detail);
        if (connections.length > 0) addRow('Connected To', connections.filter(Boolean).slice(0, 6).join(', '));

        this.infoCard.style.borderColor = borderColor;
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(0,168,255,0.1);border-bottom:1px solid ${borderColor}">
                <strong style="font-size:14px">${d.name}</strong>
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
        const intersects = this.raycaster.intersectObjects(this.nodes);

        if (intersects.length > 0) {
            const d = intersects[0].object.userData;
            const typeLabel = d.type === 'core' ? 'Core Agent' : d.type === 'interface' ? 'Interface' : 'Service';
            const statusColor = d.active ? '#4caf50' : '#f44336';
            let html = `<strong>${d.name}</strong><br>Type: ${typeLabel}<br>Status: <span style="color:${statusColor}">${d.active ? 'Active' : 'Inactive'}</span>`;
            if (d.detail) html += `<br>${d.detail}`;
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

        this.nodes.forEach((node, i) => {
            if (node.userData.active) {
                node.material.emissiveIntensity = node.userData.baseEmissive + Math.sin(t * 2 + i) * 0.2;
            }
            node.position.y += Math.sin(t * 0.5 + i * 0.7) * 0.002;
        });

        this.edges.forEach(edge => {
            edge.material.opacity = edge.userData.baseOpacity + Math.sin(t * 3 + edge.userData.phase) * 0.1;
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

if (typeof window !== 'undefined') window.AgentBrainViz = AgentBrainViz;
