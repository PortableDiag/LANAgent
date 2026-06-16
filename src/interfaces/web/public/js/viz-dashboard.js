/**
 * Viz Dashboard — Tab manager for Three.js visualizations
 * Lazy-loads each visualization when its tab is clicked.
 * Supports WebXR VR mode on all Three.js visualizations.
 */
class VizDashboard {
    constructor() {
        this.activeViz = null;
        this.activeTab = null;
        this.vizContainer = document.getElementById('viz-container');
        this.tabBar = document.getElementById('viz-tabs');
        this._vrSupported = false;
        this._vrSession = null;

        this.visualizations = [
            { id: 'agent-brain', label: 'Agent Brain', icon: 'fa-brain', script: '/js/agent-brain.js', className: 'AgentBrainViz', needsThree: true },
            { id: 'network-topology', label: 'Network', icon: 'fa-network-wired', script: '/js/network-topology.js', className: 'NetworkTopologyViz', needsThree: true },
            { id: 'p2p-network', label: 'P2P Network', icon: 'fa-tower-broadcast', script: '/js/p2p-network.js', className: 'P2PNetworkViz', needsThree: true },
            { id: 'email-contacts', label: 'Email', icon: 'fa-envelope', script: '/js/email-contacts.js', className: 'EmailContactsViz', needsThree: true },
            { id: 'crypto-token-space', label: 'Crypto Space', icon: 'fa-coins', script: '/js/crypto-token-space.js', className: 'CryptoTokenSpaceViz', needsThree: true },
            { id: 'trust-graph', label: 'Trust Graph', icon: 'fa-shield-halved', script: '/js/trust-graph.js', className: 'TrustGraphViz', needsThree: true },
            { id: 'wallet-graph', label: 'Wallet Graph', icon: 'fa-project-diagram', script: '/js/wallet-graph.js', className: 'WalletGraphViz', needsThree: true },
            { id: 'plugin-constellation', label: 'Plugins', icon: 'fa-puzzle-piece', script: '/js/plugin-constellation.js', className: 'PluginConstellationViz', needsThree: true },
            { id: 'memory-palace', label: 'Memories', icon: 'fa-memory', script: '/js/memory-palace.js', className: 'MemoryPalaceViz', needsThree: true },
            { id: 'log-waterfall', label: 'Log Waterfall', icon: 'fa-terminal', script: '/js/log-waterfall.js', className: 'LogWaterfallViz', needsThree: false },
        ];

        this.loadedScripts = new Set();
        this._buildVersion = Date.now();
        this._onHashChange = this._onHashChange.bind(this);
        this._init();
    }

    _init() {
        this._buildTabs();
        this._checkVRSupport();

        // Listen for hash changes to support deep-linking between visualizations
        window.addEventListener('hashchange', this._onHashChange);

        // Determine preferred initial viz (hash has priority over localStorage)
        const hashViz = this._parseHashForViz();
        const storedViz = this._getStoredActiveViz();
        const initialViz = hashViz || storedViz || (this.visualizations[0] ? this.visualizations[0].id : null);

        if (initialViz) {
            this._activateTab(initialViz);
        }
    }

    _checkVRSupport() {
        if (navigator.xr) {
            navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
                this._vrSupported = supported;
                const btn = document.getElementById('btn-vr');
                if (btn && supported) btn.style.display = '';
            }).catch(() => {});
        }
    }

    _buildTabs() {
        this.visualizations.forEach(viz => {
            const btn = document.createElement('button');
            btn.className = 'viz-tab';
            btn.dataset.vizId = viz.id;
            btn.innerHTML = `<i class="fas ${viz.icon}"></i> <span>${viz.label}</span>`;
            btn.addEventListener('click', () => this._activateTab(viz.id));
            this.tabBar.appendChild(btn);
        });
    }

    async _activateTab(vizId) {
        if (this.activeTab === vizId) return;

        // End VR session if active
        if (this._vrSession) {
            try { await this._vrSession.end(); } catch (e) {}
            this._vrSession = null;
        }

        // Destroy current viz
        if (this.activeViz) {
            if (this.activeViz._vrControls) {
                this.activeViz._vrControls.detach();
                this.activeViz._vrControls = null;
            }
            this.activeViz.destroy();
            this.activeViz = null;
        }
        this.vizContainer.innerHTML = '';

        // Update tab active state
        this.tabBar.querySelectorAll('.viz-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.vizId === vizId);
        });
        this.activeTab = vizId;

        // Persist active tab to localStorage
        try {
            localStorage.setItem('lanagent.viz.activeTab', vizId);
        } catch (e) {
            // Ignore storage errors (private mode or quota exceeded)
        }

        // Update URL hash without reloading (prefer replaceState to avoid history spam)
        this._updateHash(vizId);

        // Find viz config
        const viz = this.visualizations.find(v => v.id === vizId);
        if (!viz) return;

        // Create render container
        const renderDiv = document.createElement('div');
        renderDiv.id = 'viz-render';
        renderDiv.style.width = '100%';
        renderDiv.style.height = '100%';
        this.vizContainer.appendChild(renderDiv);

        // Show loading
        renderDiv.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-size:18px;"><i class="fas fa-spinner fa-spin" style="margin-right:10px;"></i> Loading visualization...</div>';

        // Load script if not loaded
        try {
            await this._loadScript(viz.script);
        } catch (err) {
            renderDiv.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#e74c3c;flex-direction:column;"><div>Failed to load ${viz.label}</div><div style="font-size:12px;color:#888;margin-top:8px;">${(err && err.message) ? err.message : 'Network or script error'}</div></div>`;
            return;
        }

        // Clear loading state
        renderDiv.innerHTML = '';

        // Instantiate viz
        const VizClass = window[viz.className];
        if (!VizClass) {
            renderDiv.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#e74c3c;">Failed to load ${viz.label}</div>`;
            return;
        }

        this.activeViz = new VizClass('viz-render');
        try {
            await this.activeViz.init();
            // Enable WebXR on the viz renderer if VR is supported
            if (this._vrSupported && viz.needsThree && this.activeViz.renderer) {
                this._enableVR(this.activeViz);
            }
        } catch (err) {
            console.error(`Viz init error (${vizId}):`, err);
            renderDiv.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#e74c3c;flex-direction:column;"><div>Error initializing ${viz.label}</div><div style="font-size:12px;color:#888;margin-top:8px;">${err.message}</div></div>`;
        }
    }

    /**
     * Enable WebXR on a visualization's renderer.
     * Switches the render loop from requestAnimationFrame to setAnimationLoop
     * for XR compatibility and adds controller ray visuals.
     */
    _enableVR(viz) {
        if (!viz.renderer) return;
        viz.renderer.xr.enabled = true;

        // Switch to setAnimationLoop (rAF doesn't fire during XR sessions)
        // Cancel existing rAF loop first
        if (viz.animationId) {
            cancelAnimationFrame(viz.animationId);
            viz.animationId = null;
        }

        // Add VR controller visuals
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)
        ]);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x00a8ff, transparent: true, opacity: 0.5 });

        for (let i = 0; i < 2; i++) {
            const controller = viz.renderer.xr.getController(i);
            controller.add(new THREE.Line(lineGeo.clone(), lineMat.clone()));
            viz.scene.add(controller);

            const grip = viz.renderer.xr.getControllerGrip(i);
            if (typeof THREE.XRControllerModelFactory !== 'undefined') {
                const factory = new THREE.XRControllerModelFactory();
                grip.add(factory.createControllerModel(grip));
            }
            viz.scene.add(grip);
        }

        // Initialize VR controller interactions
        if (typeof VRControls !== 'undefined') {
            viz._vrControls = new VRControls({
                renderer: viz.renderer,
                scene: viz.scene,
                camera: viz.camera,
                controls: viz.controls,
                getSelectables: () => viz.nodes || viz.deviceMeshes || viz.tokenMeshes || viz.nodeMeshes || [],
                onSelect: (mesh, idx) => {
                    if (mesh && mesh.userData) {
                        if (viz._selectedMesh === mesh) {
                            if (viz._dismissInfoCard) viz._dismissInfoCard();
                            viz._selectedMesh = null;
                        } else {
                            viz._selectedMesh = mesh;
                            if (viz._showInfoCard) viz._showInfoCard(mesh.userData);
                        }
                    }
                },
                onHover: (mesh, idx) => {
                    if (mesh && mesh.userData && viz._showInfoCard) {
                        viz._selectedMesh = mesh;
                        viz._showInfoCard(mesh.userData);
                    } else if (!mesh && viz._dismissInfoCard) {
                        viz._selectedMesh = null;
                        viz._dismissInfoCard();
                    }
                },
                onAction: (action, data) => {
                    // VR edit/delete for memory nodes
                    if (data?._id && typeof window.memoryPalaceAction === 'function') {
                        window.memoryPalaceAction(action, data._id);
                    }
                }
            });
            viz._vrControls.attach();
        }

        // Clock for delta time
        if (!viz._vrClock) viz._vrClock = new THREE.Timer();

        // Set up XR-compatible render loop that calls the viz's existing animate logic
        viz.renderer.setAnimationLoop(() => {
            if (viz.clock) viz.clock.update();
            if (viz._vrClock) viz._vrClock.update();
            const t = viz.clock ? viz.clock.getElapsed() : 0;
            const delta = viz._vrClock ? viz._vrClock.getDelta() : 0.016;

            // Update VR controller interactions
            if (viz._vrControls) viz._vrControls.update(delta);

            // Update node animations if the viz has them (skip emissive override during hover)
            if (viz.nodes || viz.deviceMeshes || viz.tokenMeshes || viz.nodeMeshes) {
                const meshes = viz.nodes || viz.deviceMeshes || viz.tokenMeshes || viz.nodeMeshes || [];
                meshes.forEach((mesh, i) => {
                    if (mesh.userData && mesh.material && !mesh.userData._vrOrigEmissive) {
                        const base = mesh.userData.baseEmissive || mesh.userData.active !== false ? 0.4 : 0.1;
                        if (mesh.material.emissiveIntensity !== undefined) {
                            mesh.material.emissiveIntensity = base + Math.sin(t * 1.5 + i * 0.5) * 0.15;
                        }
                    }
                });
            }

            if (viz.controls && viz.controls.enabled) viz.controls.update();
            viz.renderer.render(viz.scene, viz.camera);
        });
    }

    /**
     * Enter VR mode for the active visualization.
     */
    async enterVR() {
        if (!this._vrSupported) {
            alert('WebXR VR not available. Ensure SteamVR is running and you are using a compatible browser (Chrome/Edge) over HTTPS.');
            return;
        }
        if (!this.activeViz || !this.activeViz.renderer) {
            alert('No visualization loaded.');
            return;
        }

        try {
            const session = await navigator.xr.requestSession('immersive-vr', {
                optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
            });
            this._vrSession = session;
            this.activeViz.renderer.xr.setSession(session);

            session.addEventListener('end', () => {
                this._vrSession = null;
            });
        } catch (err) {
            console.error('Failed to enter VR:', err);
            alert('Failed to enter VR: ' + err.message);
        }
    }

    _loadScript(src) {
        if (this.loadedScripts.has(src)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src + '?v=' + this._buildVersion;
            script.onload = () => { this.loadedScripts.add(src); resolve(); };
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    destroy() {
        if (this._vrSession) {
            try { this._vrSession.end(); } catch (e) {}
            this._vrSession = null;
        }
        if (this.activeViz) {
            this.activeViz.destroy();
            this.activeViz = null;
        }
        window.removeEventListener('hashchange', this._onHashChange);
    }

    /**
     * Parse window.location.hash for viz=<id>.
     * Returns the visualization id if present and valid, otherwise null.
     */
    _parseHashForViz() {
        const hash = (window.location.hash || '').replace(/^#/, '');
        if (!hash) return null;
        // Support both "viz=agent-brain" and simple "#agent-brain" for backward simplicity
        let vizId = null;
        if (hash.includes('=')) {
            const params = new URLSearchParams(hash);
            vizId = params.get('viz');
        } else {
            vizId = hash;
        }
        if (!vizId) return null;
        const exists = this.visualizations.some(v => v.id === vizId);
        return exists ? vizId : null;
    }

    /**
     * Update the URL hash to reflect the active visualization, without reloading.
     * Uses history.replaceState when available to avoid polluting navigation history.
     */
    _updateHash(vizId) {
        const newHash = `viz=${encodeURIComponent(vizId)}`;
        try {
            const url = new URL(window.location.href);
            url.hash = newHash;
            if (window.history && window.history.replaceState) {
                window.history.replaceState(null, '', url.toString());
            } else {
                window.location.hash = newHash;
            }
        } catch (e) {
            // Fallback to direct hash assignment
            try { window.location.hash = newHash; } catch (_) {}
        }
    }

    /**
     * Safely read the last active viz id from localStorage.
     */
    _getStoredActiveViz() {
        try {
            const v = localStorage.getItem('lanagent.viz.activeTab');
            if (!v) return null;
            const exists = this.visualizations.some(x => x.id === v);
            return exists ? v : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Handle URL hash changes to switch active viz when users navigate or external links set it.
     */
    _onHashChange() {
        const targetViz = this._parseHashForViz();
        if (!targetViz) return;
        if (this.activeTab === targetViz) return;
        this._activateTab(targetViz);
    }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.vizDashboard = new VizDashboard();
    });
} else {
    window.vizDashboard = new VizDashboard();
}
