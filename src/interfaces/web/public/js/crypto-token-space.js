/**
 * Crypto Token Space — 3D Portfolio Visualization
 * Fetches real portfolio data from /api/crypto/portfolio.
 * Tokens as 3D objects sized by USD value, colored by performance, orbit by volatility.
 */
class CryptoTokenSpaceViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.tokenMeshes = [];
        this.sprites = [];
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
        this.scene.background = new THREE.Color(0x050510);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 500);
        this.camera.position.set(0, 10, 30);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
    }

    _setupLights() {
        this.scene.add(new THREE.AmbientLight(0x303050, 0.6));
        const pl = new THREE.PointLight(0xffd700, 1, 100);
        pl.position.set(0, 15, 0);
        this.scene.add(pl);
        const pl2 = new THREE.PointLight(0x00a8ff, 0.5, 80);
        pl2.position.set(-10, -5, 10);
        this.scene.add(pl2);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '10px 14px', background: 'rgba(0,0,0,0.9)',
            color: '#fff', borderRadius: '8px', fontSize: '13px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #ffd700', maxWidth: '280px'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    async _fetchAndBuild() {
        let tokens = [];
        try {
            const token = localStorage.getItem('lanagent_token');
            const resp = await fetch('/api/crypto/portfolio', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                tokens = data.tokens || [];
                if (!Array.isArray(tokens)) tokens = [];
                // Filter out zero-value tokens
                tokens = tokens.filter(t => (t.value || 0) > 0.01);
            }
        } catch (e) { /* fallback */ }

        // If no real data, show empty state message
        if (tokens.length === 0) {
            tokens = [{ symbol: 'No Holdings', name: 'Wallet empty or not initialized', value: 1, change24h: 0, volatility: 0.1, type: 'placeholder' }];
        }

        const maxVal = Math.max(...tokens.map(t => t.value || 1));
        const totalValue = tokens.reduce((sum, t) => sum + (t.value || 0), 0);

        // Central portfolio sphere showing total value
        const centerGeo = new THREE.SphereGeometry(1.5, 32, 32);
        const centerMat = new THREE.MeshPhongMaterial({
            color: 0xffd700, emissive: 0xffd700, emissiveIntensity: 0.3,
            transparent: true, opacity: 0.4, wireframe: true
        });
        const centerMesh = new THREE.Mesh(centerGeo, centerMat);
        this.scene.add(centerMesh);

        // Total value label at center
        if (totalValue > 0 && tokens[0].type !== 'placeholder') {
            const canvas = document.createElement('canvas');
            canvas.width = 256; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.font = 'bold 24px monospace';
            ctx.fillStyle = '#ffd700';
            ctx.textAlign = 'center';
            ctx.fillText(`$${totalValue.toFixed(0)}`, 128, 40);
            const tex = new THREE.CanvasTexture(canvas);
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
            sprite.position.set(0, -2.5, 0);
            sprite.scale.set(5, 1.2, 1);
            this.scene.add(sprite);
        }

        // Create tokens
        tokens.forEach((tk, i) => {
            const val = tk.value || 1;
            const change = tk.change24h || 0;
            const vol = tk.volatility || Math.abs(change) / 10 || 0.3;
            const size = 0.5 + (val / maxVal) * 2.5;
            const orbitR = 6 + vol * 20;
            const angle = (i / tokens.length) * Math.PI * 2;
            const y = (Math.random() - 0.5) * 8;

            // Color by type and performance
            let color;
            if (tk.type === 'stablecoin') {
                color = 0x2196f3; // blue for stables
            } else if (tk.type === 'placeholder') {
                color = 0x555555;
            } else if (change > 2) color = 0x00ff88;
            else if (change > 0) color = 0x4caf50;
            else if (change > -2) color = 0xff9800;
            else color = 0xf44336;

            const geo = new THREE.IcosahedronGeometry(size, 1);
            const mat = new THREE.MeshPhongMaterial({
                color, emissive: color, emissiveIntensity: 0.4,
                transparent: true, opacity: 0.85
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(Math.cos(angle) * orbitR, y, Math.sin(angle) * orbitR);
            mesh.userData = {
                ...tk, orbitR, angle, y,
                speed: 0.1 + Math.random() * 0.2,
                rotSpeed: 0.5 + Math.random()
            };
            this.scene.add(mesh);
            this.tokenMeshes.push(mesh);

            // Symbol label
            const canvas = document.createElement('canvas');
            canvas.width = 256; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.font = 'bold 28px monospace';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            const label = tk.symbol || '???';
            ctx.fillText(label, 128, 30);
            // Sub-label with value
            if (tk.type !== 'placeholder') {
                ctx.font = '16px monospace';
                ctx.fillStyle = '#aaaaaa';
                ctx.fillText(`$${val.toFixed(0)}`, 128, 52);
            }
            const tex = new THREE.CanvasTexture(canvas);
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
            sprite.position.copy(mesh.position);
            sprite.position.y += size + 1.5;
            sprite.scale.set(5, 1.2, 1);
            sprite.userData = { followIndex: this.tokenMeshes.length - 1, offsetY: size + 1.5 };
            this.scene.add(sprite);
            this.sprites.push(sprite);

            // Orbit ring
            const ringGeo = new THREE.RingGeometry(orbitR - 0.05, orbitR + 0.05, 64);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x1a2a4a, transparent: true, opacity: 0.15, side: THREE.DoubleSide
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = y;
            this.scene.add(ring);
        });

        // Star field background
        const starGeo = new THREE.BufferGeometry();
        const starPos = new Float32Array(1000 * 3);
        for (let i = 0; i < 1000; i++) {
            starPos[i * 3] = (Math.random() - 0.5) * 200;
            starPos[i * 3 + 1] = (Math.random() - 0.5) * 200;
            starPos[i * 3 + 2] = (Math.random() - 0.5) * 200;
        }
        starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
        this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x888888, size: 0.2 })));
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '280px',
            background: 'rgba(5,5,16,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '13px', display: 'none', zIndex: '200',
            border: '1px solid #ffd700', boxShadow: '0 4px 24px rgba(255,215,0,0.15)',
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
        const intersects = this.raycaster.intersectObjects(this.tokenMeshes);

        if (intersects.length > 0) {
            const mesh = intersects[0].object;
            if (mesh.userData.type === 'placeholder') return;
            if (this._selectedMesh === mesh) { this._dismissInfoCard(); return; }
            this._selectedMesh = mesh;
            this._showInfoCard(mesh.userData);
        } else {
            this._dismissInfoCard();
        }
    }

    _showInfoCard(tk) {
        const change = tk.change24h || 0;
        const changeStr = change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
        const changeColor = change >= 0 ? '#4caf50' : '#f44336';
        const typeColor = tk.type === 'stablecoin' ? '#2196f3' : '#ffd700';

        let rows = '';
        const addRow = (label, value, c) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${c || '#fff'};text-align:right;max-width:160px">${value}</span>
            </div>`;
        };

        addRow('Name', tk.name);
        addRow('Value', '$' + (tk.value || 0).toLocaleString());
        if (tk.balance) addRow('Balance', parseFloat(tk.balance).toFixed(6));
        if (tk.price) addRow('Price', '$' + parseFloat(tk.price).toLocaleString());
        addRow('24h Change', changeStr, changeColor);
        if (tk.volatility) addRow('Volatility', (tk.volatility * 100).toFixed(1) + '%');
        if (tk.network) addRow('Network', tk.network);
        if (tk.type) addRow('Type', tk.type, typeColor);
        if (tk.contractAddress) addRow('Contract', tk.contractAddress.slice(0, 8) + '...' + tk.contractAddress.slice(-6));

        this.infoCard.style.borderColor = changeColor;
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(255,215,0,0.08);border-bottom:1px solid ${changeColor}">
                <strong style="font-size:15px">${tk.symbol || '???'}</strong>
                <div style="display:flex;align-items:center;gap:10px">
                    <span style="color:${changeColor};font-size:13px">${changeStr}</span>
                    <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
                </div>
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
        const intersects = this.raycaster.intersectObjects(this.tokenMeshes);

        if (intersects.length > 0) {
            const tk = intersects[0].object.userData;
            if (tk.type === 'placeholder') {
                this.tooltip.style.display = 'none';
                return;
            }
            const changeStr = (tk.change24h || 0) >= 0 ? `+${(tk.change24h || 0).toFixed(2)}%` : `${(tk.change24h || 0).toFixed(2)}%`;
            const changeColor = (tk.change24h || 0) >= 0 ? '#4caf50' : '#f44336';
            let html = `<strong>${tk.symbol}</strong> — ${tk.name || ''}`;
            html += `<br>Value: $${(tk.value || 0).toLocaleString()}`;
            if (tk.balance) html += `<br>Balance: ${parseFloat(tk.balance).toFixed(6)}`;
            if (tk.price) html += `<br>Price: $${parseFloat(tk.price).toLocaleString()}`;
            html += `<br>24h: <span style="color:${changeColor}">${changeStr}</span>`;
            if (tk.network) html += `<br>Network: ${tk.network}`;
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
        this.clock.update();
        const t = this.clock.getElapsed();

        this.tokenMeshes.forEach((mesh, i) => {
            const d = mesh.userData;
            const angle = d.angle + t * d.speed * 0.1;
            mesh.position.x = Math.cos(angle) * d.orbitR;
            mesh.position.z = Math.sin(angle) * d.orbitR;
            mesh.rotation.y += d.rotSpeed * 0.01;
            mesh.rotation.x += d.rotSpeed * 0.005;
        });

        this.sprites.forEach(sprite => {
            const mesh = this.tokenMeshes[sprite.userData.followIndex];
            if (mesh) {
                sprite.position.x = mesh.position.x;
                sprite.position.z = mesh.position.z;
                sprite.position.y = mesh.position.y + sprite.userData.offsetY;
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

if (typeof window !== 'undefined') window.CryptoTokenSpaceViz = CryptoTokenSpaceViz;
