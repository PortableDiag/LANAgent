/**
 * Email Contacts — 3D Visualization of Email Communication Network
 * Agent at center, email contacts as orbiting nodes.
 * Size: importance, Color: relationship type, Distance: recency.
 */
class EmailContactsViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.nodeMeshes = [];
        this.edgeLines = [];
        this.animationId = null;
        this.clock = new THREE.Timer();
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
        this.scene.background = new THREE.Color(0x0a0812);

        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 500);
        this.camera.position.set(0, 15, 35);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
    }

    _setupLights() {
        this.scene.add(new THREE.AmbientLight(0x404050, 0.5));
        const pl = new THREE.PointLight(0x3498db, 0.8, 100);
        pl.position.set(0, 20, 0);
        this.scene.add(pl);
        const pl2 = new THREE.PointLight(0xe67e22, 0.4, 80);
        pl2.position.set(-10, -5, 15);
        this.scene.add(pl2);
    }

    _createTooltip() {
        this.tooltip = document.createElement('div');
        Object.assign(this.tooltip.style, {
            position: 'absolute', padding: '8px 12px', background: 'rgba(0,0,0,0.9)',
            color: '#fff', borderRadius: '6px', fontSize: '12px', pointerEvents: 'none',
            display: 'none', zIndex: '100', border: '1px solid #3498db', maxWidth: '300px',
            fontFamily: 'monospace'
        });
        this.container.style.position = 'relative';
        this.container.appendChild(this.tooltip);
    }

    _createInfoCard() {
        this.infoCard = document.createElement('div');
        Object.assign(this.infoCard.style, {
            position: 'absolute', top: '12px', right: '12px', width: '300px',
            background: 'rgba(10,8,18,0.95)', color: '#fff', borderRadius: '10px',
            fontSize: '12px', display: 'none', zIndex: '200',
            border: '1px solid #3498db', boxShadow: '0 4px 24px rgba(52,152,219,0.2)',
            fontFamily: 'monospace', overflow: 'hidden'
        });
        this.container.appendChild(this.infoCard);
        this._selectedMesh = null;
    }

    _relationshipColor(rel) {
        if (rel === 'master') return 0xffd700;
        if (rel === 'personal') return 0xe67e22;
        if (rel === 'agent_contact') return 0x9b59b6;
        if (rel === 'self') return 0x00ddff;
        return 0x3498db;
    }

    _relationshipColorHex(rel) {
        if (rel === 'master') return '#ffd700';
        if (rel === 'personal') return '#e67e22';
        if (rel === 'agent_contact') return '#9b59b6';
        if (rel === 'self') return '#00ddff';
        return '#3498db';
    }

    _relationshipLabel(rel) {
        if (rel === 'master') return 'Master';
        if (rel === 'personal') return 'Personal';
        if (rel === 'agent_contact') return 'Agent Contact';
        if (rel === 'self') return 'Self';
        return 'Contact';
    }

    async _fetchAndBuild() {
        let contacts = [];
        let emails = [];
        let agentName = 'Agent';
        let agentEmail = '';

        try {
            const token = localStorage.getItem('lanagent_token');

            // Get agent info
            const statusResp = await fetch('/api/system/status', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (statusResp.ok) {
                const statusData = await statusResp.json();
                const agent = statusData.data?.agent || statusData.agent || {};
                agentName = agent.name || 'Agent';
            }

            // Get email settings to find agent's email address
            const emailSettingsResp = await fetch('/api/email/notification-settings', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (emailSettingsResp.ok) {
                const settingsData = await emailSettingsResp.json();
                agentEmail = settingsData.email || settingsData.data?.email || '';
            }

            // Fetch both received and sent emails (API defaults to one type)
            const [recvResp, sentResp] = await Promise.all([
                fetch('/api/emails?limit=500&type=received', { headers: { 'Authorization': `Bearer ${token}` } }),
                fetch('/api/emails?limit=500&type=sent', { headers: { 'Authorization': `Bearer ${token}` } })
            ]);
            if (recvResp.ok) {
                const data = await recvResp.json();
                const raw = data.data?.emails || data.emails || data.data || [];
                if (Array.isArray(raw)) emails.push(...raw);
            }
            if (sentResp.ok) {
                const data = await sentResp.json();
                const raw = data.data?.emails || data.emails || data.data || [];
                if (Array.isArray(raw)) emails.push(...raw);
            }

            // Detect agent email from emails if not found in settings
            if (!agentEmail && emails.length > 0) {
                const received = emails.find(e => e.type === 'received' && e.to);
                if (received) {
                    const match = received.to.match(/<([^>]+)>/) || [null, received.to];
                    agentEmail = (match[1] || received.to).trim().toLowerCase();
                }
            }
        } catch (e) { console.error('Email fetch error:', e); }

        // Build contact map from emails
        const contactMap = new Map();
        emails.forEach(email => {
            const addr = email.type === 'received' ? email.from : email.to;
            if (!addr) return;
            // Extract email address from "Name <email>" format
            const match = addr.match(/<([^>]+)>/) || [null, addr];
            const emailAddr = (match[1] || addr).trim().toLowerCase();
            const nameMatch = addr.match(/^([^<]+)</);
            const name = nameMatch ? nameMatch[1].trim().replace(/"/g, '') : '';

            if (!contactMap.has(emailAddr)) {
                contactMap.set(emailAddr, {
                    email: emailAddr,
                    name: name || emailAddr,
                    sent: 0,
                    received: 0,
                    lastDate: null,
                    firstDate: null,
                    subjects: []
                });
            }
            const c = contactMap.get(emailAddr);
            if (name && (!c.name || c.name === emailAddr)) c.name = name;
            if (email.type === 'sent') c.sent++;
            else c.received++;
            const date = email.sentDate || email.createdAt;
            if (date) {
                if (!c.lastDate || new Date(date) > new Date(c.lastDate)) c.lastDate = date;
                if (!c.firstDate || new Date(date) < new Date(c.firstDate)) c.firstDate = date;
            }
            if (email.subject && c.subjects.length < 5) c.subjects.push(email.subject);
        });

        contacts = Array.from(contactMap.values());

        // Sort by total messages
        contacts.sort((a, b) => (b.sent + b.received) - (a.sent + a.received));

        // Build center node — this agent
        const centerGeo = new THREE.DodecahedronGeometry(2.2);
        const centerMat = new THREE.MeshPhongMaterial({
            color: 0x3498db, emissive: 0x3498db, emissiveIntensity: 0.6,
            transparent: true, opacity: 0.9
        });
        this.centerMesh = new THREE.Mesh(centerGeo, centerMat);
        this.centerMesh.userData = { isCenter: true, name: agentName, email: agentEmail };
        this.scene.add(this.centerMesh);
        this.nodeMeshes.push(this.centerMesh);

        // Glow rings
        for (let r = 0; r < 2; r++) {
            const ringGeo = new THREE.RingGeometry(2.8 + r * 0.8, 3.0 + r * 0.8, 48);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x3498db, transparent: true, opacity: 0.12 - r * 0.04, side: THREE.DoubleSide
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = Math.PI / 2;
            this.scene.add(ring);
        }

        const centerLabel = agentEmail || agentName;
        this._createLabel(centerLabel, new THREE.Vector3(0, 3.5, 0), true);

        if (contacts.length === 0) {
            this._createLabel('No email contacts yet', new THREE.Vector3(0, -3, 0), false, '#888888');
        }

        // Place contact nodes
        const maxMessages = Math.max(...contacts.map(c => c.sent + c.received), 1);

        contacts.forEach((contact, i) => {
            const totalMessages = contact.sent + contact.received;
            const msgRatio = totalMessages / maxMessages;
            const distance = 25 - msgRatio * 15; // more messages = closer
            const size = 0.5 + msgRatio * 2.0;

            const phi = Math.acos(-1 + (2 * i + 1) / Math.max(contacts.length, 1));
            const theta = Math.sqrt(contacts.length * Math.PI) * phi;

            const x = distance * Math.sin(phi) * Math.cos(theta);
            const y = distance * Math.cos(phi) * 0.6;
            const z = distance * Math.sin(phi) * Math.sin(theta);

            // Color by sent/received ratio
            let color;
            if (contact.sent > contact.received * 2) color = 0xe67e22; // mostly sent to
            else if (contact.received > contact.sent * 2) color = 0x2ecc71; // mostly receive from
            else color = 0x3498db; // balanced

            const geo = new THREE.SphereGeometry(size, 24, 24);
            const mat = new THREE.MeshPhongMaterial({
                color, emissive: color, emissiveIntensity: 0.4,
                transparent: true, opacity: 0.85
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(x, y, z);
            mesh.userData = { ...contact, totalMessages, distance };
            this.scene.add(mesh);
            this.nodeMeshes.push(mesh);

            // Edge to center
            const points = [new THREE.Vector3(0, 0, 0), mesh.position.clone()];
            const edgeGeo = new THREE.BufferGeometry().setFromPoints(points);
            const edgeMat = new THREE.LineBasicMaterial({
                color, transparent: true, opacity: 0.1 + msgRatio * 0.3
            });
            const line = new THREE.Line(edgeGeo, edgeMat);
            line.userData = { phase: Math.random() * Math.PI * 2, msgRatio };
            this.scene.add(line);
            this.edgeLines.push(line);

            // Label for top contacts
            if (i < 12) {
                const labelText = contact.email || contact.name;
                const label = labelText.length > 24 ? labelText.slice(0, 22) + '..' : labelText;
                this._createLabel(label, new THREE.Vector3(x, y + size + 1.2, z));
            }
        });

        // Legend
        this._createLegend();

        // Ambient particles
        const pGeo = new THREE.BufferGeometry();
        const pPos = new Float32Array(300 * 3);
        for (let i = 0; i < 300; i++) {
            pPos[i * 3] = (Math.random() - 0.5) * 80;
            pPos[i * 3 + 1] = (Math.random() - 0.5) * 60;
            pPos[i * 3 + 2] = (Math.random() - 0.5) * 80;
        }
        pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        this.scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({
            color: 0x3498db, size: 0.12, transparent: true, opacity: 0.25
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
            '<span style="color:#3498db">&#9670;</span> Agent (center)',
            '<span style="color:#e67e22">&#9679;</span> Mostly outbound',
            '<span style="color:#2ecc71">&#9679;</span> Mostly inbound',
            '<span style="color:#3498db">&#9679;</span> Balanced',
            '<span style="color:#888">&mdash;</span> Closer = more messages'
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
        if (d.isCenter) {
            this.infoCard.style.borderColor = '#3498db';
            this.infoCard.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(52,152,219,0.08);border-bottom:1px solid #3498db">
                    <strong style="font-size:14px;color:#3498db">${d.name}</strong>
                    <span class="info-card-close" style="cursor:pointer;font-size:18px;color:#888;line-height:1">&times;</span>
                </div>
                <div style="padding:8px 14px">
                    ${d.email ? '<div style="color:#aaa;margin-bottom:6px">' + d.email + '</div>' : ''}
                    <div style="color:#666">Click on a contact node to see details.</div>
                </div>
            `;
            this.infoCard.style.display = 'block';
            this.infoCard.querySelector('.info-card-close').addEventListener('click', (e) => {
                e.stopPropagation();
                this._dismissInfoCard();
            });
            return;
        }

        let rows = '';
        const addRow = (label, value, color) => {
            if (!value && value !== 0) return;
            rows += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#888">${label}</span>
                <span style="color:${color || '#fff'};text-align:right;max-width:180px;word-break:break-all">${value}</span>
            </div>`;
        };

        addRow('Email', d.email);
        addRow('Messages Sent', d.sent, '#e67e22');
        addRow('Messages Received', d.received, '#2ecc71');
        addRow('Total', d.totalMessages);
        if (d.lastDate) addRow('Last Contact', new Date(d.lastDate).toLocaleString());
        if (d.firstDate) addRow('First Contact', new Date(d.firstDate).toLocaleString());
        if (d.subjects && d.subjects.length > 0) {
            const subjectList = d.subjects.slice(0, 3).map(s => s.length > 30 ? s.slice(0, 28) + '..' : s).join(', ');
            addRow('Recent Subjects', subjectList);
        }

        this.infoCard.style.borderColor = '#3498db';
        this.infoCard.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(52,152,219,0.08);border-bottom:1px solid #3498db">
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
        const intersects = this.raycaster.intersectObjects(this.nodeMeshes);

        if (intersects.length > 0) {
            const d = intersects[0].object.userData;
            if (d.isCenter) {
                this.tooltip.innerHTML = `<strong style="color:#3498db">${d.name}</strong>${d.email ? '<br><span style="color:#aaa">' + d.email + '</span>' : ''}`;
            } else {
                let html = `<strong>${d.name}</strong>`;
                html += `<br><span style="color:#aaa">${d.email}</span>`;
                html += `<br>Sent: <span style="color:#e67e22">${d.sent}</span> | Received: <span style="color:#2ecc71">${d.received}</span>`;
                if (d.lastDate) html += `<br>Last: ${new Date(d.lastDate).toLocaleDateString()}`;
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
        this.clock.update();
        const t = this.clock.getElapsed();

        if (this.centerMesh) {
            this.centerMesh.rotation.y = t * 0.3;
            this.centerMesh.material.emissiveIntensity = 0.5 + Math.sin(t * 1.5) * 0.15;
        }

        this.nodeMeshes.forEach((mesh, i) => {
            if (mesh === this.centerMesh) return;
            mesh.rotation.y = t * 0.3 + i;
            mesh.material.emissiveIntensity = 0.3 + Math.sin(t * 1.2 + i * 0.5) * 0.15;
        });

        this.edgeLines.forEach(line => {
            const base = 0.08 + (line.userData.msgRatio || 0) * 0.25;
            line.material.opacity = base + Math.sin(t * 2 + line.userData.phase) * 0.08;
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

if (typeof window !== 'undefined') window.EmailContactsViz = EmailContactsViz;
