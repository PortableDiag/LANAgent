/**
 * Memory Palace — 3D Visualization of Agent's Learned Memories
 * Memories as glowing nodes grouped by category, sized by importance.
 * Click to view/edit/delete. Color = category, brightness = access frequency.
 */
class MemoryPalaceViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.nodeMeshes = [];
        this.memories = [];
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
        this.scene.background = new THREE.Color(0x080510);
        this.scene.fog = new THREE.FogExp2(0x080510, 0.005);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 500);
        this.camera.position.set(0, 20, 50);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
    }

    _setupLights() {
        this.scene.add(new THREE.AmbientLight(0x404060, 0.5));
        const pl = new THREE.PointLight(0xe056fd, 0.8, 120);
        pl.position.set(0, 25, 0);
        this.scene.add(pl);
        const pl2 = new THREE.PointLight(0x00a8ff, 0.4, 80);
        pl2.position.set(-15, -10, 15);
        this.scene.add(pl2);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '8px 12px', background: 'rgba(0,0,0,0.9)',
            color: '#fff', borderRadius: '6px', fontSize: '12px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #e056fd', maxWidth: '320px',
            fontFamily: 'monospace', lineHeight: '1.4'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '340px',
            background: 'rgba(8,5,16,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '12px', display: 'none', zIndex: '200',
            border: '1px solid #e056fd', boxShadow: '0 4px 24px rgba(224,86,253,0.2)',
            fontFamily: 'monospace', overflow: 'hidden', maxHeight: '80vh', overflowY: 'auto'
        });
        this.container.appendChild(this.infoCard);
        this._selectedMesh = null;
    }

    _categoryColor(cat) {
        const c = (cat || '').toLowerCase();
        if (c.includes('master_name') || c.includes('master_fact')) return 0xffd700;
        if (c.includes('master_preference') || c.includes('preference')) return 0xe67e22;
        if (c.includes('master_project') || c.includes('master_work')) return 0x3498db;
        if (c.includes('master_goal') || c.includes('master_instruction')) return 0x2ecc71;
        if (c.includes('master_routine') || c.includes('master_method')) return 0x1abc9c;
        if (c.includes('master_location')) return 0x9b59b6;
        if (c.includes('contact')) return 0x00bcd4;
        if (c.includes('resource') || c.includes('link')) return 0xf39c12;
        if (c.includes('technical')) return 0x6c7ae0;
        if (c.includes('personal')) return 0xfd79a8;
        if (c.includes('pattern') || c.includes('behavioral')) return 0xff6b35;
        if (c.includes('system')) return 0x95a5a6;
        if (c.includes('email')) return 0x3498db;
        return 0xe056fd;
    }

    _categoryColorHex(cat) {
        return '#' + this._categoryColor(cat).toString(16).padStart(6, '0');
    }

    _categoryLabel(cat) {
        if (!cat) return 'Uncategorized';
        return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    _importanceStars(imp) {
        const stars = Math.floor((imp || 5) / 2);
        return '\u2b50'.repeat(Math.min(stars, 5));
    }

    async _fetchAndBuild() {
        let memories = [];
        try {
            const token = localStorage.getItem('lanagent_token');
            const resp = await fetch('/api/memory/learned?limit=500&sort=importance', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                memories = data.data || [];
            }
        } catch (e) { console.error('Memory fetch error:', e); }

        this.memories = memories;

        // Stats for center node
        const totalCount = memories.length;
        const categories = {};
        memories.forEach(m => {
            const cat = m.metadata?.category || m.type || 'general';
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(m);
        });

        // Center node — agent brain
        const centerGeo = new THREE.DodecahedronGeometry(2.5);
        const centerMat = new THREE.MeshPhongMaterial({
            color: 0xe056fd, emissive: 0xe056fd, emissiveIntensity: 0.6,
            transparent: true, opacity: 0.9
        });
        const centerMesh = new THREE.Mesh(centerGeo, centerMat);
        centerMesh.userData = { isCenter: true, totalCount, categoryCount: Object.keys(categories).length };
        this.scene.add(centerMesh);
        this.nodeMeshes.push(centerMesh);

        // Glow rings
        for (let r = 0; r < 2; r++) {
            const ringGeo = new THREE.RingGeometry(3.2 + r * 1.0, 3.5 + r * 1.0, 48);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0xe056fd, transparent: true, opacity: 0.10 - r * 0.03, side: THREE.DoubleSide
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = Math.PI / 2;
            this.scene.add(ring);
        }

        this._createLabel('Memory Palace', new THREE.Vector3(0, 4.5, 0), true);

        if (memories.length === 0) {
            this._createLabel('No memories stored yet', new THREE.Vector3(0, -3, 0), false, '#888888');
        }

        // Place memory nodes grouped by category
        const catKeys = Object.keys(categories);
        const maxImportance = Math.max(...memories.map(m => m.metadata?.importance || 5), 1);

        catKeys.forEach((cat, catIdx) => {
            const catMemories = categories[cat];
            const catAngle = (catIdx / catKeys.length) * Math.PI * 2;
            const color = this._categoryColor(cat);

            // Category label at the sector center
            const labelR = 18;
            const labelPos = new THREE.Vector3(
                Math.cos(catAngle) * labelR, 2, Math.sin(catAngle) * labelR
            );
            this._createLabel(this._categoryLabel(cat), labelPos, false, this._categoryColorHex(cat));

            catMemories.forEach((mem, i) => {
                const importance = mem.metadata?.importance || 5;
                const accessCount = mem.accessCount || 0;
                const size = 0.3 + (importance / maxImportance) * 1.5;

                // Position in a cluster around the category angle
                const spread = 0.8;
                const angleOffset = (i - catMemories.length / 2) * (spread / Math.max(catMemories.length, 1));
                const angle = catAngle + angleOffset;
                const r = 10 + (i % 4) * 4 + Math.random() * 2;
                const y = (Math.random() - 0.5) * 12;

                const x = r * Math.cos(angle);
                const z = r * Math.sin(angle);

                // Brighter = more accessed
                const accessGlow = Math.min(accessCount / 20, 1);
                const geo = new THREE.SphereGeometry(size, 16, 16);
                const mat = new THREE.MeshPhongMaterial({
                    color, emissive: color,
                    emissiveIntensity: 0.3 + accessGlow * 0.4,
                    transparent: true, opacity: 0.8
                });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(x, y, z);
                mesh.userData = {
                    ...mem,
                    _category: cat,
                    _size: size
                };
                this.scene.add(mesh);
                this.nodeMeshes.push(mesh);

                // Faint connection to center
                const points = [new THREE.Vector3(0, 0, 0), mesh.position.clone()];
                const edgeGeo = new THREE.BufferGeometry().setFromPoints(points);
                const edgeMat = new THREE.LineBasicMaterial({
                    color, transparent: true, opacity: 0.04 + (importance / 10) * 0.06
                });
                this.scene.add(new THREE.Line(edgeGeo, edgeMat));
            });
        });

        // Legend
        this._createLegend(catKeys);

        // Ambient particles
        const pGeo = new THREE.BufferGeometry();
        const pPos = new Float32Array(600 * 3);
        const pColors = new Float32Array(600 * 3);
        for (let i = 0; i < 600; i++) {
            pPos[i * 3] = (Math.random() - 0.5) * 100;
            pPos[i * 3 + 1] = (Math.random() - 0.5) * 60;
            pPos[i * 3 + 2] = (Math.random() - 0.5) * 100;
            const c = new THREE.Color(this._categoryColor(catKeys[i % catKeys.length] || ''));
            pColors[i * 3] = c.r; pColors[i * 3 + 1] = c.g; pColors[i * 3 + 2] = c.b;
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
        ctx.fillText(text.length > 30 ? text.slice(0, 28) + '..' : text, 256, 32);
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
            border: '1px solid #333', maxHeight: '200px', overflowY: 'auto'
        });
        const lines = catKeys.slice(0, 12).map(cat =>
            `<span style="color:${this._categoryColorHex(cat)}">&#9679;</span> ${this._categoryLabel(cat)}`
        );
        if (catKeys.length > 12) lines.push(`<span style="color:#888">...and ${catKeys.length - 12} more</span>`);
        lines.push('<span style="color:#888">Size = importance, Glow = access count</span>');
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
            this.infoCard.style.borderColor = '#e056fd';
            this.infoCard.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(224,86,253,0.08);border-bottom:1px solid #e056fd">
                    <strong style="font-size:14px;color:#e056fd">Memory Palace</strong>
                    <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
                </div>
                <div style="padding:8px 14px">
                    <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                        <span style="color:#888">Total Memories</span><span>${d.totalCount}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                        <span style="color:#888">Categories</span><span>${d.categoryCount}</span>
                    </div>
                </div>`;
            this.infoCard.style.display = 'block';
            this.infoCard.querySelector('.info-card-close').addEventListener('click', (e) => {
                e.stopPropagation(); this._dismissInfoCard();
            });
            return;
        }

        const cat = d._category || d.metadata?.category || d.type || 'general';
        const catColor = this._categoryColorHex(cat);
        const importance = d.metadata?.importance || 5;
        const content = d.content || '';
        const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
        const memId = d._id;

        let rows = '';
        const addRow = (label, value, color) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${color || '#fff'};text-align:right;max-width:180px">${value}</span>
            </div>`;
        };

        addRow('Category', this._categoryLabel(cat), catColor);
        addRow('Importance', `${this._importanceStars(importance)} (${importance}/10)`);
        addRow('Accessed', `${d.accessCount || 0} times`);
        addRow('Type', d.type);
        if (d.metadata?.tags?.length) addRow('Tags', d.metadata.tags.join(', '));
        if (d.metadata?.source) addRow('Source', d.metadata.source);
        addRow('Created', d.createdAt ? new Date(d.createdAt).toLocaleString() : null);
        if (d.lastAccessedAt) addRow('Last Accessed', new Date(d.lastAccessedAt).toLocaleString());
        if (d.isPermanent) addRow('Permanent', 'Yes', '#ffd700');

        this.infoCard.style.borderColor = catColor;
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(224,86,253,0.06);border-bottom:1px solid ${catColor}">
                <strong style="font-size:13px">${this._categoryLabel(cat)}</strong>
                <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
            </div>
            <div style="padding:8px 14px;color:#ccc;font-size:12px;line-height:1.5;border-bottom:1px solid rgba(255,255,255,0.06);max-height:150px;overflow-y:auto">${preview}</div>
            <div style="padding:4px 14px">${rows}</div>
            ${memId ? `<div style="padding:8px 14px;display:flex;gap:8px;border-top:1px solid rgba(255,255,255,0.06)">
                <button onclick="memoryPalaceAction('edit','${memId}')" style="flex:1;padding:6px;background:rgba(52,152,219,0.2);border:1px solid #3498db;border-radius:4px;color:#3498db;cursor:pointer;font-size:11px"><i class="fas fa-edit"></i> Edit</button>
                <button onclick="memoryPalaceAction('delete','${memId}')" style="flex:1;padding:6px;background:rgba(231,76,60,0.2);border:1px solid #e74c3c;border-radius:4px;color:#e74c3c;cursor:pointer;font-size:11px"><i class="fas fa-trash"></i> Delete</button>
            </div>` : ''}
        `;
        this.infoCard.style.display = 'block';
        this.infoCard.querySelector('.info-card-close').addEventListener('click', (e) => {
            e.stopPropagation(); this._dismissInfoCard();
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
                this.tooltip.innerHTML = `<strong style="color:#e056fd">Memory Palace</strong><br>${d.totalCount} memories in ${d.categoryCount} categories`;
            } else {
                const cat = d._category || d.metadata?.category || d.type || '';
                const content = (d.content || '').slice(0, 80);
                this.tooltip.innerHTML = `<strong style="color:${this._categoryColorHex(cat)}">${this._categoryLabel(cat)}</strong><br>${content}${d.content?.length > 80 ? '...' : ''}<br><span style="color:#888">${this._importanceStars(d.metadata?.importance)} | ${d.accessCount || 0} accesses</span>`;
            }
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = (event.clientX - rect.left + 15) + 'px';
            this.tooltip.style.top = (event.clientY - rect.top + 15) + 'px';
        } else {
            this.tooltip.style.display = 'none';
        }
    }

    animate() {
        this.renderer.setAnimationLoop(() => this._renderFrame());
    }

    _renderFrame() {
        const t = this.clock.getElapsedTime();

        this.nodeMeshes.forEach((mesh, i) => {
            if (mesh.userData.isCenter) {
                mesh.rotation.y = t * 0.2;
                mesh.material.emissiveIntensity = 0.5 + Math.sin(t * 1.5) * 0.15;
            } else {
                mesh.rotation.y = t * 0.3 + i * 0.5;
                const base = mesh.material.emissiveIntensity;
                mesh.position.y += Math.sin(t * 0.3 + i * 0.5) * 0.001;
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
        if (this.renderer) this.renderer.setAnimationLoop(null);
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

// Global action handler for info card buttons
window.memoryPalaceAction = async function(action, memId) {
    const token = localStorage.getItem('lanagent_token');
    if (!token) return;

    if (action === 'delete') {
        if (!confirm('Delete this memory?')) return;
        try {
            const resp = await fetch(`/api/memory/${memId}/delete`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.ok) {
                // Reload the visualization
                if (window.vizDashboard?.activeViz) {
                    window.vizDashboard.activeViz.destroy();
                    window.vizDashboard.activeViz = new MemoryPalaceViz('viz-render');
                    await window.vizDashboard.activeViz.init();
                    if (window.vizDashboard._vrSupported) {
                        window.vizDashboard._enableVR(window.vizDashboard.activeViz);
                    }
                }
            }
        } catch (e) { alert('Delete failed: ' + e.message); }
    } else if (action === 'edit') {
        // Find current content to pre-populate
        let currentContent = '';
        if (window.vizDashboard?.activeViz?.nodeMeshes) {
            const mesh = window.vizDashboard.activeViz.nodeMeshes.find(m => m.userData?._id === memId);
            if (mesh) currentContent = mesh.userData.content || '';
        }
        const newContent = prompt('Edit memory content:', currentContent);
        if (newContent === null || newContent === currentContent) return;
        try {
            const resp = await fetch(`/api/memory/${memId}/edit`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: newContent })
            });
            if (resp.ok) {
                // Reload
                if (window.vizDashboard?.activeViz) {
                    window.vizDashboard.activeViz.destroy();
                    window.vizDashboard.activeViz = new MemoryPalaceViz('viz-render');
                    await window.vizDashboard.activeViz.init();
                    if (window.vizDashboard._vrSupported) {
                        window.vizDashboard._enableVR(window.vizDashboard.activeViz);
                    }
                }
            }
        } catch (e) { alert('Edit failed: ' + e.message); }
    }
};

if (typeof window !== 'undefined') window.MemoryPalaceViz = MemoryPalaceViz;
