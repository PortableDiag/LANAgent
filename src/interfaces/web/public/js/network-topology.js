/**
 * Network Topology — 3D Star-Topology Graph of LAN Devices
 * Fetches device data from /api/network/devices and renders a structured network graph.
 * Router/gateway at center, devices arranged in rings by type.
 */
class NetworkTopologyViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.deviceMeshes = [];
        this.connectionLines = [];
        this.animationId = null;
        this.clock = new THREE.Timer();
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
        this.scene.background = new THREE.Color(0x0a0e1a);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 500);
        this.camera.position.set(0, 20, 45);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
    }

    _setupLights() {
        this.scene.add(new THREE.AmbientLight(0x404060, 0.6));
        const dl = new THREE.DirectionalLight(0xffffff, 0.8);
        dl.position.set(10, 20, 10);
        this.scene.add(dl);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '8px 12px', background: 'rgba(0,0,0,0.85)',
            color: '#fff', borderRadius: '6px', fontSize: '13px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #00a8ff', maxWidth: '280px'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    _getDeviceColor(dev) {
        // If dev is a string (legacy call), treat as type lookup
        if (typeof dev === 'string') dev = { type: dev };

        // Self highlight — bright cyan
        if (dev._isSelf) return 0x00e5ff;

        // Trust-based coloring
        if (dev.trusted) return 0x2ecc71;  // green — trusted
        if (dev.category === 'untrusted') return 0xe74c3c; // red — explicitly untrusted

        // Fallback to type-based color for uncategorized devices
        const colors = {
            router: 0xe74c3c, switch: 0xff6b6b, gateway: 0xe74c3c,
            server: 0x3498db, nas: 0x2980b9,
            computer: 0x6c7ae0, desktop: 0x6c7ae0, laptop: 0x5b6abf,
            phone: 0xf39c12, mobile: 0xf39c12, tablet: 0xe67e22,
            iot: 0x9b59b6, speaker: 0x8e44ad, tv: 0xa855f7,
            camera: 0xe056fd, printer: 0x1abc9c, gaming: 0x00d2d3,
            unknown: 0x95a5a6
        };
        return colors[(dev.type || 'unknown').toLowerCase()] || colors.unknown;
    }

    _getDeviceGeometry(type) {
        const t = (type || '').toLowerCase();
        if (t === 'router' || t === 'gateway') return new THREE.OctahedronGeometry(2.0);
        if (t === 'switch') return new THREE.OctahedronGeometry(1.3);
        if (t === 'server' || t === 'nas') return new THREE.BoxGeometry(1.6, 2.0, 1.6);
        if (t === 'computer' || t === 'desktop' || t === 'laptop') return new THREE.BoxGeometry(1.4, 1.0, 1.4);
        if (t === 'phone' || t === 'mobile' || t === 'tablet') return new THREE.ConeGeometry(0.7, 1.8, 6);
        if (t === 'camera') return new THREE.CylinderGeometry(0.5, 0.8, 1.2, 8);
        if (t === 'printer') return new THREE.BoxGeometry(1.6, 0.8, 1.2);
        if (t === 'tv' || t === 'gaming') return new THREE.BoxGeometry(2.0, 1.2, 0.3);
        if (t === 'iot' || t === 'speaker') return new THREE.DodecahedronGeometry(0.8);
        return new THREE.SphereGeometry(0.9, 16, 16);
    }

    // Classify devices into tiers for ring placement
    _getDeviceTier(type) {
        const t = (type || '').toLowerCase();
        if (t === 'router' || t === 'gateway') return 0; // center
        if (t === 'switch') return 1; // inner ring — infrastructure
        if (t === 'server' || t === 'nas') return 1; // inner ring — infrastructure
        if (t === 'computer' || t === 'desktop' || t === 'laptop') return 2; // mid ring — workstations
        if (t === 'phone' || t === 'mobile' || t === 'tablet') return 2; // mid ring
        if (t === 'printer') return 2;
        if (t === 'camera' || t === 'iot' || t === 'speaker' || t === 'tv' || t === 'gaming') return 3; // outer ring — peripherals
        return 3; // unknown → outer
    }

    async _fetchAndBuild() {
        let devices = [];
        try {
            const token = localStorage.getItem('lanagent_token');
            const resp = await fetch('/api/network/devices', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                devices = data.devices || data.data || data || [];
                if (!Array.isArray(devices)) devices = [];
            }
        } catch (e) { /* use fallback */ }

        // Detect self — compare device IP to current browser host
        const selfIp = window.location.hostname;

        // Normalize field names (API uses deviceType, fallback uses type)
        devices = devices.map(d => ({
            ...d,
            type: d.deviceType || d.type || 'unknown',
            hostname: d.name || d.hostname || d.ip || 'Unknown',
            status: d.online !== undefined ? (d.online ? 'online' : 'offline') : (d.status || 'unknown'),
            _isSelf: d.ip === selfIp
        }));

        if (devices.length === 0) {
            this._showEmpty();
            return;
        }

        // Separate router/gateway from the rest
        let routerIdx = devices.findIndex(d => d.type === 'router' || d.type === 'gateway');
        // If no router found, check for common gateway IPs
        if (routerIdx === -1) {
            routerIdx = devices.findIndex(d => d.ip && (d.ip.endsWith('.1') || d.ip.endsWith('.254')));
        }
        // If still no router, pick the device tagged as infrastructure
        if (routerIdx === -1) {
            routerIdx = devices.findIndex(d => d.category === 'infrastructure');
        }

        let router = null;
        const otherDevices = [];
        devices.forEach((d, i) => {
            if (i === routerIdx && !router) {
                router = { ...d, type: d.type === 'unknown' ? 'router' : d.type };
            } else {
                otherDevices.push(d);
            }
        });

        // If we found a router, place it at center
        if (router) {
            this._createDeviceMesh(router, 0, 0, 0);
        }

        // Calculate distance from center based on latency
        // Gather all latencies to determine scale
        const latencies = otherDevices.map(d => {
            const ping = (d.stats && (d.stats.avgResponseTime || d.stats.lastResponseTime)) || 0;
            return ping;
        });
        const hasLatency = latencies.some(l => l > 0);
        const maxLatency = Math.max(...latencies.filter(l => l > 0), 1);

        // Min/max radius for the layout
        const MIN_RADIUS = 8;
        const MAX_RADIUS = 30;

        // Assign radius per device: latency-based if available, tier-based fallback
        const tierFallbackRadius = { 1: 10, 2: 18, 3: 25 };

        const devicesWithRadius = otherDevices.map((d, i) => {
            const ping = latencies[i];
            let radius;
            if (hasLatency && ping > 0) {
                // Scale: low latency = close, high latency = far
                // Use sqrt scale so differences are visible but not extreme
                radius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(ping / maxLatency);
            } else if (hasLatency) {
                // Device has no latency data but others do — offline or unknown, put it far
                const tier = this._getDeviceTier(d.type);
                radius = d.status === 'offline' ? MAX_RADIUS + 3 : tierFallbackRadius[tier] || 20;
            } else {
                // No latency data at all — fall back to tier rings
                const tier = this._getDeviceTier(d.type);
                radius = tierFallbackRadius[tier === 0 ? 1 : tier] || 18;
            }
            return { dev: d, radius };
        });

        // Sort by radius so angular spacing is even within similar distances
        devicesWithRadius.sort((a, b) => a.radius - b.radius);

        // Fibonacci sphere distribution — spreads devices on a sphere surface
        // so labels don't overlap and the 3D space is fully used
        const n = devicesWithRadius.length;
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));
        devicesWithRadius.forEach((item, i) => {
            // y goes from ~+0.85 to ~-0.85 (avoid exact poles for readability)
            const y = 1 - (2 * (i + 0.5)) / n;
            const radiusAtY = Math.sqrt(1 - y * y); // horizontal radius at this latitude
            const theta = i * goldenAngle;
            const r = item.radius;
            const x = r * radiusAtY * Math.cos(theta);
            const sy = r * y; // spherical y position
            const z = r * radiusAtY * Math.sin(theta);
            this._createDeviceMesh(item.dev, x, sy, z);
        });

        // Draw connections — every device connects to the router (star topology)
        // Opacity based on distance: closer = brighter connection
        if (router) {
            const routerMesh = this.deviceMeshes[0];
            for (let i = 1; i < this.deviceMeshes.length; i++) {
                const dist = routerMesh.position.distanceTo(this.deviceMeshes[i].position);
                const opacity = Math.max(0.08, 0.5 - (dist / (MAX_RADIUS + 5)) * 0.4);
                this._addConnection(routerMesh, this.deviceMeshes[i], opacity);
            }

            // If there are switches, also connect nearby devices to their nearest switch
            const switchMeshes = this.deviceMeshes.filter(m => m.userData.type === 'switch');
            if (switchMeshes.length > 0) {
                for (let i = 1; i < this.deviceMeshes.length; i++) {
                    if (this.deviceMeshes[i].userData.type === 'switch') continue;
                    let nearest = null, nearestDist = Infinity;
                    switchMeshes.forEach(sw => {
                        const d = this.deviceMeshes[i].position.distanceTo(sw.position);
                        if (d < nearestDist) { nearestDist = d; nearest = sw; }
                    });
                    if (nearest && nearestDist < 15) this._addConnection(nearest, this.deviceMeshes[i], 0.15);
                }
            }
        } else if (this.deviceMeshes.length > 1) {
            // No router found — connect all in a ring
            for (let i = 0; i < this.deviceMeshes.length; i++) {
                const next = (i + 1) % this.deviceMeshes.length;
                this._addConnection(this.deviceMeshes[i], this.deviceMeshes[next], 0.2);
            }
        }

        // Draw faint wireframe sphere guides
        [MIN_RADIUS, (MIN_RADIUS + MAX_RADIUS) / 2, MAX_RADIUS].forEach(r => {
            const sphereGeo = new THREE.SphereGeometry(r, 16, 12);
            const wireframe = new THREE.WireframeGeometry(sphereGeo);
            const mat = new THREE.LineBasicMaterial({ color: 0x1a3a5c, transparent: true, opacity: 0.08 });
            this.scene.add(new THREE.LineSegments(wireframe, mat));
        });
    }

    _createDeviceMesh(dev, x, y, z) {
        const geo = this._getDeviceGeometry(dev.type);
        const color = this._getDeviceColor(dev);
        const isOnline = dev.status === 'online';
        const isSelf = dev._isSelf;

        const mat = new THREE.MeshPhongMaterial({
            color, emissive: color,
            emissiveIntensity: isSelf ? 0.7 : (isOnline ? 0.4 : 0.05),
            transparent: true, opacity: isOnline ? 0.9 : 0.35
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        mesh.userData = { ...dev };
        this.scene.add(mesh);
        this.deviceMeshes.push(mesh);

        // Self highlight: pulsing glow ring around this agent's server
        if (isSelf) {
            const ringGeo = new THREE.RingGeometry(2.8, 3.3, 32);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x00e5ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.set(x, y, z);
            ring.lookAt(0, 0, 0); // face the ring toward center
            ring.userData._selfRing = true;
            this.scene.add(ring);
            this.deviceMeshes.push(ring);

            // Outer glow ring
            const outerGeo = new THREE.RingGeometry(3.5, 4.0, 32);
            const outerMat = new THREE.MeshBasicMaterial({
                color: 0x00e5ff, transparent: true, opacity: 0.2, side: THREE.DoubleSide
            });
            const outerRing = new THREE.Mesh(outerGeo, outerMat);
            outerRing.position.set(x, y, z);
            outerRing.lookAt(0, 0, 0);
            outerRing.userData._selfRing = true;
            this.scene.add(outerRing);
        }

        // Trust indicator ring for non-self devices
        if (!isSelf && dev.trusted) {
            const trustRingGeo = new THREE.RingGeometry(2.0, 2.3, 32);
            const trustRingMat = new THREE.MeshBasicMaterial({
                color: 0x2ecc71, transparent: true, opacity: 0.3, side: THREE.DoubleSide
            });
            const trustRing = new THREE.Mesh(trustRingGeo, trustRingMat);
            trustRing.position.set(x, y, z);
            trustRing.lookAt(0, 0, 0);
            this.scene.add(trustRing);
        }

        // Label
        const label = dev.hostname || dev.ip || 'Unknown';
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 28px Arial';
        if (isSelf) {
            ctx.fillStyle = '#00e5ff';
        } else if (dev.trusted) {
            ctx.fillStyle = '#2ecc71';
        } else {
            ctx.fillStyle = isOnline ? '#ffffff' : '#555555';
        }
        ctx.textAlign = 'center';
        let displayLabel = label.length > 24 ? label.slice(0, 22) + '...' : label;
        if (isSelf) displayLabel = '[ ' + displayLabel + ' ]';
        ctx.fillText(displayLabel, 256, 40);
        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
        sprite.position.set(x, y + 3, z);
        sprite.scale.set(7, 0.9, 1);
        this.scene.add(sprite);

        return mesh;
    }

    _showEmpty() {
        const geo = new THREE.SphereGeometry(2, 32, 32);
        const mat = new THREE.MeshPhongMaterial({ color: 0x555555, emissive: 0x333333, emissiveIntensity: 0.3 });
        const mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        this.deviceMeshes.push(mesh);

        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = '28px Arial';
        ctx.fillStyle = '#888888';
        ctx.textAlign = 'center';
        ctx.fillText('No network devices discovered', 256, 40);
        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
        sprite.position.y = 4;
        sprite.scale.set(10, 1.2, 1);
        this.scene.add(sprite);

        const grid = new THREE.GridHelper(40, 20, 0x1a3a5c, 0x0d1f33);
        grid.position.y = -4;
        this.scene.add(grid);
    }

    _addConnection(meshA, meshB, opacity) {
        const points = [meshA.position.clone(), meshB.position.clone()];
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({ color: 0x00a8ff, transparent: true, opacity });
        const line = new THREE.Line(geo, mat);
        this.scene.add(line);
        this.connectionLines.push(line);
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '280px',
            background: 'rgba(10,14,26,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '13px', display: 'none', zIndex: '200',
            border: '1px solid #00a8ff', boxShadow: '0 4px 24px rgba(0,168,255,0.2)',
            fontFamily: 'monospace', overflow: 'hidden'
        });
        this.container.appendChild(this.infoCard);
        this._selectedMesh = null;
    }

    _handleClick(event) {
        // Ignore if dragging (OrbitControls)
        const rect = this.container.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.deviceMeshes);

        if (intersects.length > 0) {
            const mesh = intersects[0].object;
            const dev = mesh.userData;
            if (dev._selfRing) return; // skip glow rings

            // Toggle off if same node clicked
            if (this._selectedMesh === mesh) {
                this._dismissInfoCard();
                return;
            }
            this._selectedMesh = mesh;
            this._showInfoCard(dev);
        } else {
            this._dismissInfoCard();
        }
    }

    _showInfoCard(dev) {
        const statusColor = dev.status === 'online' ? '#2ecc71' : '#e74c3c';
        const trustColor = dev.trusted ? '#2ecc71' : dev.category === 'untrusted' ? '#e74c3c' : '#95a5a6';
        const trustLabel = dev.trusted ? 'Trusted' : dev.category === 'untrusted' ? 'Untrusted' : 'Unknown';
        const borderColor = dev._isSelf ? '#00e5ff' : dev.trusted ? '#2ecc71' : '#00a8ff';

        let rows = '';
        const addRow = (label, value, color) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${color || '#fff'};text-align:right;max-width:160px;word-break:break-all">${value}</span>
            </div>`;
        };

        addRow('IP Address', dev.ip);
        addRow('MAC', dev.mac);
        addRow('Type', dev.type !== 'unknown' ? dev.type : null);
        addRow('Vendor', dev.vendor);
        addRow('OS', dev.os);
        addRow('Status', dev.status || 'unknown', statusColor);
        addRow('Trust', trustLabel, trustColor);
        if (dev.category && dev.category !== 'unknown' && dev.category !== 'trusted' && dev.category !== 'untrusted')
            addRow('Category', dev.category);
        if (dev.openPorts && dev.openPorts.length > 0)
            addRow('Open Ports', dev.openPorts.join(', '));
        if (dev.stats) {
            if (dev.stats.lastResponseTime) addRow('Ping', dev.stats.lastResponseTime + 'ms');
            if (dev.stats.avgResponseTime) addRow('Avg Ping', dev.stats.avgResponseTime.toFixed(1) + 'ms');
        }
        if (dev.lastSeen) addRow('Last Seen', new Date(dev.lastSeen).toLocaleString());
        if (dev.firstSeen) addRow('First Seen', new Date(dev.firstSeen).toLocaleString());

        this.infoCard.style.borderColor = borderColor;
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(0,168,255,0.1);border-bottom:1px solid ${borderColor}">
                <strong style="font-size:14px">${dev.hostname || dev.name || dev.ip || 'Unknown'}</strong>
                <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
            </div>
            ${dev._isSelf ? '<div style="padding:4px 14px;background:rgba(0,229,255,0.1);color:#00e5ff;font-size:11px;text-align:center">This Server</div>' : ''}
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
        const intersects = this.raycaster.intersectObjects(this.deviceMeshes);

        if (intersects.length > 0) {
            const dev = intersects[0].object.userData;
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = (event.clientX - rect.left + 15) + 'px';
            this.tooltip.style.top = (event.clientY - rect.top + 15) + 'px';

            const lines = [`<strong>${dev.hostname || dev.name || 'Unknown'}</strong>`];
            if (dev.ip) lines.push(`IP: ${dev.ip}`);
            if (dev.mac) lines.push(`MAC: ${dev.mac}`);
            if (dev.type && dev.type !== 'unknown') lines.push(`Type: ${dev.type}`);
            if (dev.vendor) lines.push(`Vendor: ${dev.vendor}`);
            if (dev.os) lines.push(`OS: ${dev.os}`);
            lines.push(`Status: <span style="color:${dev.status === 'online' ? '#2ecc71' : '#e74c3c'}">${dev.status || 'unknown'}</span>`);
            if (dev._isSelf) lines.push(`<span style="color:#00e5ff;font-weight:bold">This Server</span>`);
            if (dev.trusted) {
                lines.push(`Trust: <span style="color:#2ecc71">Trusted</span>`);
            } else if (dev.category === 'untrusted') {
                lines.push(`Trust: <span style="color:#e74c3c">Untrusted</span>`);
            }
            if (dev.category && dev.category !== 'unknown' && dev.category !== 'trusted' && dev.category !== 'untrusted') lines.push(`Category: ${dev.category}`);
            if (dev.openPorts && dev.openPorts.length > 0) lines.push(`Ports: ${dev.openPorts.slice(0, 8).join(', ')}${dev.openPorts.length > 8 ? '...' : ''}`);
            if (dev.stats && dev.stats.lastResponseTime) lines.push(`Ping: ${dev.stats.lastResponseTime}ms`);

            this.tooltip.innerHTML = lines.join('<br>');
        } else {
            this.tooltip.style.display = 'none';
        }
    }

    animate() {
        this.animationId = requestAnimationFrame(() => this.animate());
        this.clock.update();
        const t = this.clock.getElapsed();

        // Gentle rotation for router, subtle bob for others, pulse for self rings
        this.deviceMeshes.forEach((mesh, i) => {
            if (mesh.userData._selfRing) {
                // Pulse the self glow rings
                if (mesh.material) mesh.material.opacity = 0.2 + 0.3 * Math.abs(Math.sin(t * 1.5));
                mesh.rotation.z = t * 0.3;
            } else if (i === 0 && mesh.userData.type && (mesh.userData.type === 'router' || mesh.userData.type === 'gateway')) {
                mesh.rotation.y = t * 0.5;
            } else if (mesh.userData._isSelf) {
                // Self node: gentle hover + brighter pulse
                mesh.rotation.y = t * 0.3;
                mesh.position.y += Math.sin(t * 0.5) * 0.003;
                if (mesh.material) mesh.material.emissiveIntensity = 0.5 + 0.3 * Math.abs(Math.sin(t * 1.2));
            } else {
                mesh.rotation.y = t * 0.2 + i;
                mesh.position.y += Math.sin(t * 0.3 + i * 0.7) * 0.002;
            }
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

if (typeof window !== 'undefined') window.NetworkTopologyViz = NetworkTopologyViz;
