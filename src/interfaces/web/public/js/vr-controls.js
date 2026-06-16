/**
 * VRControls — Shared WebXR controller interaction utility
 * Provides grip-to-rotate, trigger-to-select, thumbstick locomotion,
 * snap-turn, two-grip scale, and squeeze-to-reset for all Three.js vizzes.
 *
 * Usage:
 *   const vrc = new VRControls({ renderer, scene, camera, controls,
 *       getSelectables: () => meshArray,
 *       onSelect: (mesh, idx) => { ... }
 *   });
 *   vrc.attach();
 *   // in setAnimationLoop: vrc.update(delta);
 *   // on destroy: vrc.detach();
 */
class VRControls {
    constructor(opts) {
        this.renderer = opts.renderer;
        this.scene = opts.scene;
        this.camera = opts.camera;
        this.orbitControls = opts.controls || null;
        this.getSelectables = opts.getSelectables || (() => []);
        this.onSelect = opts.onSelect || null;
        this.onHover = opts.onHover || null;
        this.onAction = opts.onAction || null; // (action, meshUserData) => {} for edit/delete in VR

        // World group — wrap scene content so we can grab/scale/rotate it
        this.worldGroup = null;

        // Controller state
        this.controllers = [null, null];
        this.grips = [null, null];
        this.gamepads = [null, null];
        this.handedness = [null, null]; // 'left' or 'right'
        this.rays = [null, null]; // the ray line objects

        // Squeeze (grip button) state
        this.squeezing = [false, false];
        this.squeezeStartMatrix = [null, null];
        this.squeezeStartWorldPos = [new THREE.Vector3(), new THREE.Vector3()];
        this.squeezeStartGroupPos = new THREE.Vector3();
        this.squeezeStartGroupQuat = new THREE.Quaternion();
        this.squeezeStartGroupScale = new THREE.Vector3();
        this.squeezeStartDist = 0;

        // Select (trigger) state
        this.selecting = [false, false];
        this.selectedHit = [null, null];

        // Hover state
        this.hoveredMesh = [null, null];
        this.raycaster = new THREE.Raycaster();

        // Snap turn state
        this.snapTurnArmed = true;
        this.SNAP_ANGLE = Math.PI / 6; // 30 degrees
        this.SNAP_THRESHOLD = 0.7;
        this.SNAP_REARM = 0.3;

        // Locomotion
        this.MOVE_SPEED = 1.5; // units per second
        this.DEADZONE = 0.4; // high deadzone — only deliberate thumbstick pushes register

        // Highlight colors
        this.RAY_DEFAULT = 0x00a8ff;
        this.RAY_HOVER = 0x00ff88;
        this.RAY_SELECT = 0xff4444;

        // Temp vectors
        this._tmpVec = new THREE.Vector3();
        this._tmpVec2 = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
        this._tmpMat = new THREE.Matrix4();

        // VR action buttons (edit/delete for memories)
        this._vrActionButtons = [];
        this._vrActionTarget = null; // the memory mesh these buttons relate to

        // Bound handlers
        this._handlers = [];
    }

    /**
     * Wire controller events and wrap scene content in worldGroup
     */
    attach() {
        // Collect XR controllers and grips — these must stay at scene root
        // (they're tracked by the XR system; reparenting them causes feedback loops)
        this._xrObjects = new Set();
        for (let i = 0; i < 2; i++) {
            this._xrObjects.add(this.renderer.xr.getController(i));
            this._xrObjects.add(this.renderer.xr.getControllerGrip(i));
        }

        // Create world group and reparent scene children (except camera + XR objects)
        this.worldGroup = new THREE.Group();
        this.worldGroup.name = 'vr-world-group';
        const children = [];
        this.scene.children.forEach(c => {
            if (c === this.camera || c.isCamera) return;
            if (this._xrObjects.has(c)) return;
            children.push(c);
        });
        children.forEach(c => this.worldGroup.add(c));
        this.scene.add(this.worldGroup);

        // Set up controllers
        for (let i = 0; i < 2; i++) {
            const controller = this.renderer.xr.getController(i);
            this.controllers[i] = controller;

            // Find the ray line already added by viz-dashboard / avatar
            controller.children.forEach(child => {
                if (child.isLine) this.rays[i] = child;
            });

            const grip = this.renderer.xr.getControllerGrip(i);
            this.grips[i] = grip;

            // Bind events
            this._bind(controller, 'selectstart', () => this._onSelectStart(i));
            this._bind(controller, 'selectend', () => this._onSelectEnd(i));
            this._bind(controller, 'squeezestart', () => this._onSqueezeStart(i));
            this._bind(controller, 'squeezeend', () => this._onSqueezeEnd(i));
            this._bind(controller, 'connected', (e) => this._onConnected(i, e));
            this._bind(controller, 'disconnected', () => this._onDisconnected(i));
        }

        // Disable OrbitControls in VR (conflicts with XR camera)
        if (this.orbitControls) this.orbitControls.enabled = false;
    }

    /**
     * Clean up: remove listeners, unwrap worldGroup
     */
    detach() {
        // Remove event listeners
        this._handlers.forEach(({ obj, event, fn }) => obj.removeEventListener(event, fn));
        this._handlers = [];

        // Remove VR info card and action buttons
        if (this._vrInfoSprite) {
            if (this._vrInfoSprite.parent) this._vrInfoSprite.parent.remove(this._vrInfoSprite);
            if (this._vrInfoSprite.material.map) this._vrInfoSprite.material.map.dispose();
            this._vrInfoSprite.material.dispose();
            this._vrInfoSprite = null;
        }
        this._removeVRActionButtons();

        // Unwrap worldGroup
        if (this.worldGroup && this.worldGroup.parent === this.scene) {
            const children = [...this.worldGroup.children];
            children.forEach(c => this.scene.add(c));
            this.scene.remove(this.worldGroup);
        }
        this.worldGroup = null;

        // Re-enable OrbitControls
        if (this.orbitControls) this.orbitControls.enabled = true;

        // Clear state
        this.gamepads = [null, null];
        this.controllers = [null, null];
    }

    /**
     * Per-frame update — call from setAnimationLoop
     */
    update(delta) {
        if (!this.worldGroup) return;
        this._updateGrab();
        this._updateLocomotion(delta);
        this._updateSnapTurn();
        this._updateHover();
    }

    // --- Controller Events ---

    _onConnected(i, event) {
        const source = event.data;
        this.gamepads[i] = source.gamepad || null;
        this.handedness[i] = source.handedness || null;
    }

    _onDisconnected(i) {
        this.gamepads[i] = null;
        this.handedness[i] = null;
    }

    _onSelectStart(i) {
        this.selecting[i] = true;
        this._selectMoved = false; // track if thumbstick was used during trigger hold

        // Raycast from controller
        const hit = this._raycastFromController(i);
        this.selectedHit[i] = hit;

        // Visual feedback on ray
        if (this.rays[i] && hit) {
            this.rays[i].material.color.setHex(this.RAY_SELECT);
        }
    }

    _onSelectEnd(i) {
        this.selecting[i] = false;

        // Only fire selection callback if user didn't use thumbstick (pure click, not move)
        const hit = this.selectedHit[i];
        if (hit && !this._selectMoved) {
            // Check if an action button was hit
            if (hit.userData?._vrAction && this.onAction && this._vrActionTarget) {
                this.onAction(hit.userData._vrAction, this._vrActionTarget);
            } else if (this.onSelect) {
                this.onSelect(hit, i);
            }
        }
        this.selectedHit[i] = null;
        this._selectMoved = false;

        // Reset ray color
        if (this.rays[i]) {
            this.rays[i].material.color.setHex(this.RAY_DEFAULT);
        }
    }

    _onSqueezeStart(i) {
        this.squeezing[i] = true;

        // Store controller world position at grab start
        if (this.controllers[i]) {
            this.controllers[i].getWorldPosition(this.squeezeStartWorldPos[i]);
        }

        // If this is the first grip, store the worldGroup's current transform
        const otherIdx = 1 - i;
        if (!this.squeezing[otherIdx]) {
            this.squeezeStartGroupPos.copy(this.worldGroup.position);
            this.squeezeStartGroupQuat.copy(this.worldGroup.quaternion);
            this.squeezeStartGroupScale.copy(this.worldGroup.scale);
        }

        // If both grips, store initial distance for scaling
        if (this.squeezing[0] && this.squeezing[1]) {
            const p0 = new THREE.Vector3();
            const p1 = new THREE.Vector3();
            this.controllers[0].getWorldPosition(p0);
            this.controllers[1].getWorldPosition(p1);
            this.squeezeStartDist = p0.distanceTo(p1);
            if (this.squeezeStartDist < 0.01) this.squeezeStartDist = 0.01;

            // Re-store group transform for two-grip
            this.squeezeStartGroupPos.copy(this.worldGroup.position);
            this.squeezeStartGroupQuat.copy(this.worldGroup.quaternion);
            this.squeezeStartGroupScale.copy(this.worldGroup.scale);

            // Re-store both controller positions
            this.controllers[0].getWorldPosition(this.squeezeStartWorldPos[0]);
            this.controllers[1].getWorldPosition(this.squeezeStartWorldPos[1]);
        }
    }

    _onSqueezeEnd(i) {
        this.squeezing[i] = false;

        // Check for double-squeeze reset: if both were squeezed and now both released
        const otherIdx = 1 - i;
        if (!this.squeezing[otherIdx]) {
            // Both released — could be a reset gesture
            // Only reset if both were released within a short window (they just let go)
        }
    }

    // --- Grab / Scale ---

    _updateGrab() {
        // Require TRIGGER + GRIP together to grab (Valve Index grip is pressure-sensitive)
        const activeGrip0 = this.squeezing[0] && this.selecting[0];
        const activeGrip1 = this.squeezing[1] && this.selecting[1];
        const bothGrip = activeGrip0 && activeGrip1;
        const singleGripIdx = activeGrip0 ? 0 : activeGrip1 ? 1 : -1;
        const wasGrabbing = this._grabActive || false;

        if (bothGrip) {
            // Initialize two-grip on first frame
            if (!this._grabActive || !this._grabBoth) {
                this._grabBoth = true;
                const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
                this.controllers[0].getWorldPosition(p0);
                this.controllers[1].getWorldPosition(p1);
                this.squeezeStartWorldPos[0].copy(p0);
                this.squeezeStartWorldPos[1].copy(p1);
                this.squeezeStartDist = p0.distanceTo(p1);
                if (this.squeezeStartDist < 0.01) this.squeezeStartDist = 0.01;
                this.squeezeStartGroupPos.copy(this.worldGroup.position);
                this.squeezeStartGroupQuat.copy(this.worldGroup.quaternion);
                this.squeezeStartGroupScale.copy(this.worldGroup.scale);
            }
            this._grabActive = true;
            this._selectMoved = true;
            this._updateTwoGripScaleRotate();
        } else if (singleGripIdx >= 0) {
            // Initialize single-grip on first frame
            if (!this._grabActive || this._grabBoth) {
                this._grabBoth = false;
                this.controllers[singleGripIdx].getWorldPosition(this.squeezeStartWorldPos[singleGripIdx]);
                this.squeezeStartGroupPos.copy(this.worldGroup.position);
                this.squeezeStartGroupQuat.copy(this.worldGroup.quaternion);
                this.squeezeStartGroupScale.copy(this.worldGroup.scale);
            }
            this._grabActive = true;
            this._selectMoved = true;
            this._updateSingleGripDrag(singleGripIdx);
        } else {
            this._grabActive = false;
            this._grabBoth = false;
        }
    }

    _updateSingleGripDrag(i) {
        if (!this.controllers[i]) return;

        // Get current controller world position
        const currentPos = this._tmpVec;
        this.controllers[i].getWorldPosition(currentPos);

        // Delta from grab start
        const delta = this._tmpVec2.copy(currentPos).sub(this.squeezeStartWorldPos[i]);

        // Apply delta to worldGroup position
        this.worldGroup.position.copy(this.squeezeStartGroupPos).add(delta);
    }

    _updateTwoGripScaleRotate() {
        if (!this.controllers[0] || !this.controllers[1]) return;

        const p0 = new THREE.Vector3();
        const p1 = new THREE.Vector3();
        this.controllers[0].getWorldPosition(p0);
        this.controllers[1].getWorldPosition(p1);

        // Scale: ratio of current distance to initial distance
        const currentDist = p0.distanceTo(p1);
        if (this.squeezeStartDist > 0.01) {
            const scaleRatio = currentDist / this.squeezeStartDist;
            const clampedScale = Math.max(0.1, Math.min(10, scaleRatio));
            this.worldGroup.scale.copy(this.squeezeStartGroupScale).multiplyScalar(clampedScale);
        }

        // Position: midpoint delta
        const startMid = this._tmpVec.copy(this.squeezeStartWorldPos[0]).add(this.squeezeStartWorldPos[1]).multiplyScalar(0.5);
        const currentMid = this._tmpVec2.copy(p0).add(p1).multiplyScalar(0.5);
        const midDelta = currentMid.sub(startMid);
        this.worldGroup.position.copy(this.squeezeStartGroupPos).add(midDelta);

        // Rotation: angle between the controller-to-controller vectors
        const startDir = new THREE.Vector3().copy(this.squeezeStartWorldPos[1]).sub(this.squeezeStartWorldPos[0]).normalize();
        const currentDir = new THREE.Vector3().copy(p1).sub(p0).normalize();

        // Project onto XZ plane for Y-axis rotation
        startDir.y = 0; startDir.normalize();
        currentDir.y = 0; currentDir.normalize();

        if (startDir.length() > 0.01 && currentDir.length() > 0.01) {
            const angle = Math.atan2(
                startDir.x * currentDir.z - startDir.z * currentDir.x,
                startDir.x * currentDir.x + startDir.z * currentDir.z
            );
            this._tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
            this.worldGroup.quaternion.copy(this.squeezeStartGroupQuat).multiply(this._tmpQuat);
        }
    }

    // --- Thumbstick Locomotion ---

    _updateLocomotion(delta) {
        // Locomotion requires holding trigger — prevents any accidental drift
        if (!this.selecting[0] && !this.selecting[1]) return;
        // Don't move while gripping (grip = grab/scale mode)
        if (this.squeezing[0] || this.squeezing[1]) return;

        // Use left controller thumbstick for movement (or whichever has a gamepad)
        const leftIdx = this.handedness[0] === 'left' ? 0 : this.handedness[1] === 'left' ? 1 : 0;
        const gp = this.gamepads[leftIdx];
        if (!gp || !gp.axes || gp.axes.length < 4) return;

        const axisX = gp.axes[2]; // strafe
        const axisY = gp.axes[3]; // forward/back

        if (Math.abs(axisX) < this.DEADZONE && Math.abs(axisY) < this.DEADZONE) return;
        if (!this.controllers[leftIdx]) return;

        this._selectMoved = true; // thumbstick used — suppress click on trigger release

        // Get controller forward direction projected onto XZ plane
        const controller = this.controllers[leftIdx];
        const forward = new THREE.Vector3(0, 0, -1);
        forward.applyQuaternion(controller.quaternion);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();

        const moveX = (Math.abs(axisX) > this.DEADZONE ? axisX : 0);
        const moveZ = (Math.abs(axisY) > this.DEADZONE ? axisY : 0);
        const speed = this.MOVE_SPEED * delta;

        // Move world opposite to desired user movement direction
        this.worldGroup.position.addScaledVector(right, moveX * speed);
        this.worldGroup.position.addScaledVector(forward, moveZ * speed);
    }

    // --- Snap Turn ---

    _updateSnapTurn() {
        // Snap turn only when trigger held — prevents accidental turns
        if (!this.selecting[0] && !this.selecting[1]) return;
        // Use right controller thumbstick X axis for snap turn
        const rightIdx = this.handedness[0] === 'right' ? 0 : this.handedness[1] === 'right' ? 1 : 1;
        const gp = this.gamepads[rightIdx];
        if (!gp || !gp.axes || gp.axes.length < 4) return;

        const axisX = gp.axes[2];

        if (this.snapTurnArmed && Math.abs(axisX) > this.SNAP_THRESHOLD) {
            const angle = axisX > 0 ? -this.SNAP_ANGLE : this.SNAP_ANGLE;
            this.worldGroup.rotateY(angle);
            this._selectMoved = true;
            this.snapTurnArmed = false;
        } else if (!this.snapTurnArmed && Math.abs(axisX) < this.SNAP_REARM) {
            this.snapTurnArmed = true;
        }
    }

    // --- Hover Raycasting ---

    _updateHover() {
        const selectables = this.getSelectables();
        if (!selectables || selectables.length === 0) return;

        for (let i = 0; i < 2; i++) {
            if (!this.controllers[i] || this.selecting[i]) continue;

            const hit = this._raycastFromController(i);
            const prevHover = this.hoveredMesh[i];

            if (hit !== prevHover) {
                // Un-hover previous
                if (prevHover && prevHover.material) {
                    if (prevHover.userData._vrOrigEmissive !== undefined) {
                        prevHover.material.emissiveIntensity = prevHover.userData._vrOrigEmissive;
                        delete prevHover.userData._vrOrigEmissive;
                    }
                }
                // Hover new
                if (hit && hit.material) {
                    hit.userData._vrOrigEmissive = hit.material.emissiveIntensity || 0;
                    hit.material.emissiveIntensity = 1.2;
                }
                this.hoveredMesh[i] = hit;

                // Update ray color
                if (this.rays[i]) {
                    this.rays[i].material.color.setHex(hit ? this.RAY_HOVER : this.RAY_DEFAULT);
                }

                if (this.onHover) this.onHover(hit, i);

                // Show/hide 3D info card in VR
                this._updateVRInfoCard(hit);
            }
        }
    }

    // --- VR Action Buttons (edit/delete for memory nodes) ---

    _removeVRActionButtons() {
        for (const btn of this._vrActionButtons) {
            if (btn.parent) btn.parent.remove(btn);
            if (btn.material?.map) btn.material.map.dispose();
            if (btn.material) btn.material.dispose();
            if (btn.geometry) btn.geometry.dispose();
        }
        this._vrActionButtons = [];
        this._vrActionTarget = null;
    }

    _createVRActionButton(label, color, action) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.85)`;
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(4, 4, 248, 56, 10);
            ctx.fill();
            ctx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(4, 4, 248, 56, 10);
            ctx.stroke();
        } else {
            ctx.fillRect(4, 4, 248, 56);
            ctx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
            ctx.lineWidth = 2;
            ctx.strokeRect(4, 4, 248, 56);
        }

        // Text
        ctx.font = 'bold 28px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 128, 34);

        const texture = new THREE.CanvasTexture(canvas);
        // Use a flat plane mesh instead of sprite so raycasting works reliably
        const geometry = new THREE.PlaneGeometry(1.2, 0.3);
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            side: THREE.DoubleSide,
            depthTest: false
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData = { _vrAction: action };
        return mesh;
    }

    _showVRActionButtons(targetMesh) {
        this._removeVRActionButtons();

        // Only show for memory nodes (have content and _id)
        const data = targetMesh?.userData;
        if (!data || !data._id || !data.content) return;

        this._vrActionTarget = data;

        const editBtn = this._createVRActionButton('Edit', [52, 152, 219], 'edit');
        const deleteBtn = this._createVRActionButton('Delete', [231, 76, 60], 'delete');

        // Position below the info card sprite
        const spritePos = this._vrInfoSprite ? this._vrInfoSprite.position.clone() : targetMesh.position.clone();
        const spriteScale = this._vrInfoSprite ? this._vrInfoSprite.scale.y : 3;

        editBtn.position.copy(spritePos);
        editBtn.position.y -= spriteScale * 0.55 + 0.2;
        editBtn.position.x -= 0.7;

        deleteBtn.position.copy(spritePos);
        deleteBtn.position.y -= spriteScale * 0.55 + 0.2;
        deleteBtn.position.x += 0.7;

        // Make buttons face the camera
        if (this.camera) {
            const camPos = new THREE.Vector3();
            this.camera.getWorldPosition(camPos);
            editBtn.lookAt(camPos);
            deleteBtn.lookAt(camPos);
        }

        const parent = this.worldGroup || this.scene;
        parent.add(editBtn);
        parent.add(deleteBtn);
        this._vrActionButtons.push(editBtn, deleteBtn);
    }

    // --- 3D VR Info Card (visible inside headset) ---

    _updateVRInfoCard(mesh) {
        // Remove existing card and action buttons
        if (this._vrInfoSprite) {
            if (this._vrInfoSprite.parent) this._vrInfoSprite.parent.remove(this._vrInfoSprite);
            if (this._vrInfoSprite.material.map) this._vrInfoSprite.material.map.dispose();
            this._vrInfoSprite.material.dispose();
            this._vrInfoSprite = null;
        }
        this._removeVRActionButtons();

        if (!mesh || !mesh.userData) return;

        const data = mesh.userData;
        const lines = [];
        const wrapText = (text, maxLen) => {
            if (!text || text.length <= maxLen) return text ? [text] : [];
            const wrapped = [];
            while (text.length > 0) {
                if (text.length <= maxLen) { wrapped.push(text); break; }
                let cut = text.lastIndexOf(' ', maxLen);
                if (cut < maxLen * 0.4) cut = maxLen;
                wrapped.push(text.substring(0, cut));
                text = text.substring(cut).trimStart();
            }
            return wrapped;
        };
        const MAX_LINE = 40;

        // --- Memory Palace ---
        if (data.content !== undefined || data._category !== undefined) {
            const cat = data._category || data.metadata?.category || data.type || 'general';
            const title = data.isCenter ? 'Memory Palace' : cat.charAt(0).toUpperCase() + cat.slice(1);
            lines.push(title);
            lines.push('─'.repeat(Math.min(title.length + 4, MAX_LINE)));

            if (data.isCenter) {
                if (data.totalCount) lines.push(`Total Memories: ${data.totalCount}`);
                if (data.categoryCount) lines.push(`Categories: ${data.categoryCount}`);
            } else {
                const importance = data.metadata?.importance || data.importance || 5;
                lines.push(`Importance: ${'★'.repeat(Math.min(importance, 5))} (${importance}/10)`);
                if (data.accessCount !== undefined) lines.push(`Accessed: ${data.accessCount} times`);
                if (data.type) lines.push(`Type: ${data.type}`);
                if (data.metadata?.tags?.length) lines.push(`Tags: ${data.metadata.tags.slice(0, 3).join(', ')}`);
                if (data.metadata?.source) lines.push(`Source: ${data.metadata.source}`);
                if (data.isPermanent) lines.push('Permanent: Yes');
                if (data.createdAt) lines.push(`Created: ${new Date(data.createdAt).toLocaleDateString()}`);
                // Memory content — the key info
                if (data.content) {
                    lines.push('');
                    const preview = data.content.substring(0, 160);
                    wrapText(preview, MAX_LINE).forEach(l => lines.push(l));
                }
            }
        }
        // --- Plugin Constellation ---
        else if (data.displayName !== undefined || data.commands !== undefined) {
            const title = data.displayName || data.name || 'Plugin';
            lines.push(title);
            lines.push('─'.repeat(Math.min(title.length + 4, MAX_LINE)));

            if (data.isCenter) {
                if (data.totalPlugins) lines.push(`Total Plugins: ${data.totalPlugins}`);
                if (data.enabledCount !== undefined) lines.push(`Enabled: ${data.enabledCount}`);
                if (data.totalCommands) lines.push(`Total Commands: ${data.totalCommands}`);
            } else {
                lines.push(`Status: ${data.enabled ? 'Enabled' : 'Disabled'}`);
                if (data.category) lines.push(`Category: ${data.category}`);
                if (data.version) lines.push(`Version: ${data.version}`);
                if (data.commandCount) lines.push(`Commands: ${data.commandCount}`);
                if (data.description) {
                    lines.push('');
                    wrapText(data.description.substring(0, 120), MAX_LINE).forEach(l => lines.push(l));
                }
                // Command list
                if (data.commands && data.commands.length > 0) {
                    lines.push('');
                    lines.push('Commands:');
                    data.commands.slice(0, 6).forEach(cmd => {
                        lines.push(`  ${cmd.command || cmd}`);
                    });
                    if (data.commands.length > 6) lines.push(`  ...+${data.commands.length - 6} more`);
                }
                if (data.error) lines.push(`Error: ${data.error.substring(0, 40)}`);
            }
        }
        // --- All other vizzes (network, crypto, trust, wallet, brain, p2p, email) ---
        else {
            const title = data.name || data.label || data.title || data.ip || data.symbol || data.displayName || data.agentName || 'Node';
            lines.push(title);
            lines.push('─'.repeat(Math.min(title.length + 4, MAX_LINE)));

            if (data.type) lines.push(`Type: ${data.type}`);
            if (data.status) lines.push(`Status: ${data.status}`);
            if (data.ip) lines.push(`IP: ${data.ip}`);
            if (data.mac) lines.push(`MAC: ${data.mac}`);
            if (data.vendor) lines.push(`Vendor: ${data.vendor}`);
            if (data.os) lines.push(`OS: ${data.os}`);
            if (data.symbol) lines.push(`Symbol: ${data.symbol}`);
            if (data.balance !== undefined) lines.push(`Balance: ${Number(data.balance).toFixed(4)}`);
            if (data.value !== undefined) lines.push(`Value: $${Number(data.value).toFixed(2)}`);
            if (data.price !== undefined) lines.push(`Price: $${Number(data.price).toFixed(4)}`);
            if (data.change24h !== undefined) lines.push(`24h: ${Number(data.change24h).toFixed(2)}%`);
            if (data.trustLevel !== undefined) lines.push(`Trust: ${data.trustLevel}`);
            if (data.commandCount) lines.push(`Commands: ${data.commandCount}`);
            if (data.connections !== undefined) lines.push(`Connections: ${data.connections}`);
            if (data.active !== undefined) lines.push(`Active: ${data.active ? 'Yes' : 'No'}`);
            if (data.network) lines.push(`Network: ${data.network}`);
            if (data.address) lines.push(`Addr: ${data.address.substring(0, 10)}...${data.address.slice(-6)}`);
            if (data.txCount) lines.push(`Transactions: ${data.txCount}`);
            if (data.totalValue) lines.push(`Total: $${Number(data.totalValue).toFixed(2)}`);
            if (data.ping) lines.push(`Ping: ${data.ping}ms`);
            if (data.email) lines.push(`Email: ${data.email}`);
            if (data.messageCount) lines.push(`Messages: ${data.messageCount}`);
            if (data.peerId) lines.push(`Peer: ${data.peerId.substring(0, 12)}...`);
            if (data.agentName) lines.push(`Agent: ${data.agentName}`);
            if (data.description) {
                lines.push('');
                wrapText(data.description.substring(0, 120), MAX_LINE).forEach(l => lines.push(l));
            }
        }

        // Cap lines
        if (lines.length > 18) lines.length = 18;

        // Render to canvas
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 24;
        const lineHeight = fontSize + 6;
        const padding = 16;
        const cardWidth = 512;
        const cardHeight = Math.max(100, padding * 2 + lines.length * lineHeight);
        canvas.width = cardWidth;
        canvas.height = cardHeight;

        // Background (roundRect with fallback for older browsers)
        ctx.fillStyle = 'rgba(10, 10, 30, 0.92)';
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(0, 0, cardWidth, cardHeight, 12);
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 168, 255, 0.7)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(0, 0, cardWidth, cardHeight, 12);
            ctx.stroke();
        } else {
            ctx.fillRect(0, 0, cardWidth, cardHeight);
            ctx.strokeStyle = 'rgba(0, 168, 255, 0.7)';
            ctx.lineWidth = 2;
            ctx.strokeRect(0, 0, cardWidth, cardHeight);
        }

        // Text
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.fillStyle = '#00ccff';
        ctx.fillText(lines[0], padding, padding + fontSize);

        ctx.font = `${fontSize - 4}px monospace`;
        for (let i = 1; i < lines.length; i++) {
            ctx.fillStyle = i === 1 ? 'rgba(0,168,255,0.5)' : '#ccccee';
            ctx.fillText(lines[i], padding, padding + fontSize + i * lineHeight);
        }

        // Create sprite
        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(material);

        // Position above the node (use local position since sprite is in same parent group)
        let offset = 2;
        if (mesh.geometry) {
            if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
            if (mesh.geometry.boundingSphere) offset = mesh.geometry.boundingSphere.radius + 1.5;
        }

        // Get position relative to worldGroup
        if (this.worldGroup && mesh.parent) {
            const localPos = new THREE.Vector3();
            mesh.getWorldPosition(localPos);
            this.worldGroup.worldToLocal(localPos);
            sprite.position.copy(localPos);
        } else {
            sprite.position.copy(mesh.position);
        }
        sprite.position.y += offset;

        // Scale based on card aspect ratio — larger for more content
        const aspect = cardWidth / cardHeight;
        const scale = Math.max(3, lines.length * 0.3);
        sprite.scale.set(scale * aspect, scale, 1);

        // Add to worldGroup so it moves/scales with the scene content
        if (this.worldGroup) {
            this.worldGroup.add(sprite);
        } else {
            this.scene.add(sprite);
        }
        this._vrInfoSprite = sprite;

        // Show edit/delete action buttons for memory nodes
        if (this.onAction) {
            this._showVRActionButtons(mesh);
        }
    }

    // --- Utility ---

    _raycastFromController(i) {
        const controller = this.controllers[i];
        if (!controller) return null;

        const selectables = this.getSelectables();
        if (!selectables || selectables.length === 0) return null;

        // Raycaster from controller position, pointing forward along controller's -Z
        this._tmpMat.identity().extractRotation(controller.matrixWorld);
        this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
        this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._tmpMat);

        // Include VR action buttons in raycast targets
        const allTargets = [...selectables, ...this._vrActionButtons];
        const intersects = this.raycaster.intersectObjects(allTargets, false);
        return intersects.length > 0 ? intersects[0].object : null;
    }

    /**
     * Reset the world group to initial transform
     */
    resetView() {
        if (!this.worldGroup) return;
        this.worldGroup.position.set(0, 0, 0);
        this.worldGroup.quaternion.identity();
        this.worldGroup.scale.set(1, 1, 1);
    }

    _bind(obj, event, fn) {
        obj.addEventListener(event, fn);
        this._handlers.push({ obj, event, fn });
    }
}
