# WebXR VR Controller Implementation Guide

## Overview

This guide documents how to add full VR controller interactions to Three.js visualizations rendered in a browser with WebXR support. It covers the architecture, gotchas, and solutions discovered during implementation on a Valve Index headset with Three.js r128.

The approach uses a single shared `VRControls` utility class that works across any number of Three.js scenes — visualizations, 3D model viewers, etc. — without modifying the individual scene code.

## Architecture

### Shared Utility Pattern

Create one `VRControls` class that accepts a configuration object:

```js
const vrc = new VRControls({
    renderer,          // THREE.WebGLRenderer with xr.enabled = true
    scene,             // THREE.Scene
    camera,            // THREE.PerspectiveCamera
    controls,          // THREE.OrbitControls (optional, auto-disabled in VR)
    getSelectables,    // () => THREE.Mesh[] — returns array of interactive meshes
    onSelect,          // (mesh, controllerIndex) => void — trigger click callback
    onHover            // (mesh|null, controllerIndex) => void — hover callback
});
vrc.attach();
// In render loop: vrc.update(delta);
// On cleanup: vrc.detach();
```

This keeps VR logic out of individual visualization code. Each viz just provides its selectable meshes and callbacks.

### World Manipulation via worldGroup

In WebXR, the browser controls the camera rig (head tracking). You cannot move the camera programmatically. Instead, wrap all scene content in a `THREE.Group` (called `worldGroup`) and manipulate that group to simulate user movement.

```
Scene
├── Camera (managed by XR system — do not touch)
├── Controller 0 (managed by XR system)
├── Controller 1 (managed by XR system)
├── ControllerGrip 0
├── ControllerGrip 1
└── worldGroup (your content — manipulate THIS)
    ├── Meshes
    ├── Lights
    ├── Particles
    └── etc.
```

**Critical: Do NOT reparent XR controllers into worldGroup.** The XR system positions controllers in world space. If you put them inside a moving group, their positions feed back into your movement calculations, creating a runaway loop where the scene flies away.

```js
// Correct: exclude controllers when building worldGroup
const xrObjects = new Set();
for (let i = 0; i < 2; i++) {
    xrObjects.add(renderer.xr.getController(i));
    xrObjects.add(renderer.xr.getControllerGrip(i));
}

const worldGroup = new THREE.Group();
scene.children.forEach(child => {
    if (child === camera || child.isCamera || xrObjects.has(child)) return;
    toReparent.push(child);
});
toReparent.forEach(c => worldGroup.add(c));
scene.add(worldGroup);
```

### Render Loop

WebXR requires `renderer.setAnimationLoop()` instead of `requestAnimationFrame`. Cancel any existing rAF loop before setting the XR loop:

```js
if (viz.animationId) {
    cancelAnimationFrame(viz.animationId);
    viz.animationId = null;
}
renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    vrControls.update(delta);
    // ... your animation updates ...
    renderer.render(scene, camera);
});
```

Disable OrbitControls during VR (`controls.enabled = false`) — it conflicts with the XR camera system.

## Controller Input Mapping

### Valve Index Specific Issues

The Valve Index has **pressure-sensitive grip buttons**. Simply holding the controller naturally applies grip pressure, which fires `squeezestart` events without the user intending to grab anything. This makes grip-only actions unusable.

**Solution: Require trigger + grip combo for all grab/scale operations.** Grip alone does nothing.

The Index also has **capacitive thumbsticks** that register small axis values when fingers are near (not touching) the stick. A standard deadzone of 0.15 is insufficient.

**Solution: Use a deadzone of 0.4, AND require trigger held for thumbstick locomotion/snap-turn.**

### Recommended Control Scheme

| Action | Input | Why |
|--------|-------|-----|
| Look around | Head movement only | Always works, no buttons |
| Select/click node | Trigger press + release (quick) | Point ray → pull trigger |
| Move (locomotion) | Hold trigger + left thumbstick | Prevents drift from capacitive touch |
| Snap turn | Hold trigger + right thumbstick L/R | 30-degree increments |
| Grab & drag scene | Hold trigger + squeeze grip + move hand | Combo prevents accidental grip |
| Scale scene | Both triggers + both grips + pull apart/together | Two-hand pinch gesture |
| Rotate scene | Both triggers + both grips + twist | Y-axis rotation from hand angle |

### Controller Events (Three.js WebXR)

```js
const controller = renderer.xr.getController(i); // i = 0 or 1

controller.addEventListener('selectstart', () => { /* trigger pressed */ });
controller.addEventListener('selectend', () => { /* trigger released */ });
controller.addEventListener('squeezestart', () => { /* grip pressed */ });
controller.addEventListener('squeezeend', () => { /* grip released */ });
controller.addEventListener('connected', (event) => {
    // event.data = XRInputSource
    // event.data.gamepad = Gamepad (for thumbstick axes)
    // event.data.handedness = 'left' | 'right'
});
controller.addEventListener('disconnected', () => { /* controller lost */ });
```

### Gamepad Axes (Thumbstick)

Access via the `connected` event's `event.data.gamepad`:

```js
const gp = gamepad; // stored from connected event
const thumbX = gp.axes[2]; // left/right (-1 to 1)
const thumbY = gp.axes[3]; // forward/back (-1 to 1)
```

**Note:** Some controllers use axes[0]/axes[1] and some use axes[2]/axes[3]. Test with your target hardware. Valve Index uses axes[2] and axes[3].

## Raycasting from Controllers

```js
const tempMatrix = new THREE.Matrix4();
const raycaster = new THREE.Raycaster();

function raycastFromController(controller, selectables) {
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const intersects = raycaster.intersectObjects(selectables, false);
    return intersects.length > 0 ? intersects[0].object : null;
}
```

## Visual Feedback

### Controller Rays

Add a line to each controller for the laser pointer:

```js
const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -5)
]);
const lineMat = new THREE.LineBasicMaterial({
    color: 0x00a8ff, transparent: true, opacity: 0.5
});
controller.add(new THREE.Line(lineGeo, lineMat));
```

Change ray color on state:
- Default: cyan (`0x00a8ff`)
- Hover: green (`0x00ff88`)
- Selecting: red (`0xff4444`)

### Node Hover Glow

On hover, boost the mesh's `emissiveIntensity`. Store the original value to restore on un-hover:

```js
// Hover on
mesh.userData._vrOrigEmissive = mesh.material.emissiveIntensity || 0;
mesh.material.emissiveIntensity = 1.2;

// Hover off
mesh.material.emissiveIntensity = mesh.userData._vrOrigEmissive;
delete mesh.userData._vrOrigEmissive;
```

## 3D Info Cards (Visible in VR)

HTML DOM elements (info panels, tooltips) are **invisible inside the VR headset** — only the WebGL canvas renders in stereo. To show node details in VR, render the info to a canvas and display it as a sprite.

### Implementation Pattern

```js
function createVRInfoCard(data, mesh) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Build text lines from the data
    const lines = buildInfoLines(data);

    // Size canvas
    const fontSize = 24;
    const lineHeight = fontSize + 6;
    const padding = 16;
    canvas.width = 512;
    canvas.height = padding * 2 + lines.length * lineHeight;

    // Draw background
    ctx.fillStyle = 'rgba(10, 10, 30, 0.92)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(0, 168, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);

    // Draw title
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.fillStyle = '#00ccff';
    ctx.fillText(lines[0], padding, padding + fontSize);

    // Draw body lines
    ctx.font = `${fontSize - 4}px monospace`;
    for (let i = 1; i < lines.length; i++) {
        ctx.fillStyle = '#ccccee';
        ctx.fillText(lines[i], padding, padding + fontSize + i * lineHeight);
    }

    // Create sprite
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture, transparent: true, depthTest: false
    });
    const sprite = new THREE.Sprite(material);

    // Position above the node
    const pos = new THREE.Vector3();
    mesh.getWorldPosition(pos);
    worldGroup.worldToLocal(pos); // convert to local space of parent group
    sprite.position.copy(pos);
    sprite.position.y += 2; // offset above node

    // Scale to be readable
    const aspect = canvas.width / canvas.height;
    const scale = Math.max(3, lines.length * 0.3);
    sprite.scale.set(scale * aspect, scale, 1);

    worldGroup.add(sprite);
    return sprite;
}
```

### Key Details

- Add sprite to `worldGroup` (not scene root) so it moves/scales with the scene content
- Use `worldToLocal()` to convert the mesh's world position to worldGroup local space
- Use `depthTest: false` on the material so the card renders on top of other geometry
- Clean up the sprite (remove from parent, dispose texture and material) when hover ends
- Word-wrap long text with a helper function for readability
- Scale the card dynamically based on content length

### Data Extraction Per Visualization Type

Different visualizations store different data in `mesh.userData`. Detect the viz type by checking for distinctive fields:

```js
// Memory Palace: has 'content' and '_category'
if (data.content !== undefined || data._category !== undefined) {
    // Show: category, importance, access count, tags, content text
}
// Plugin Constellation: has 'displayName' and 'commands'
else if (data.displayName !== undefined || data.commands !== undefined) {
    // Show: status, category, version, command list, description
}
// Network/Crypto/etc: generic fields
else {
    // Show: type, status, IP, value, price, trust level, etc.
}
```

## Grab / Scale / Rotate Implementation

### Single-Grip Drag

When trigger + grip combo is active on one controller:

1. On first frame of grab: store controller world position and worldGroup position
2. Each frame: compute delta between current and stored controller position
3. Apply delta to worldGroup position

```js
// First frame
controller.getWorldPosition(startPos);
startGroupPos.copy(worldGroup.position);

// Each frame
controller.getWorldPosition(currentPos);
const delta = currentPos.clone().sub(startPos);
worldGroup.position.copy(startGroupPos).add(delta);
```

### Two-Grip Scale + Rotate

When both trigger+grip combos are active:

1. Store initial distance between controllers and initial worldGroup transform
2. Each frame: scale = currentDistance / startDistance
3. Rotation: compute angle between controller-to-controller direction vectors projected onto XZ plane

```js
// Scale
const scaleRatio = currentDist / startDist;
worldGroup.scale.copy(startScale).multiplyScalar(clampedScale);

// Position (track midpoint)
const midDelta = currentMidpoint.sub(startMidpoint);
worldGroup.position.copy(startPos).add(midDelta);

// Rotation (Y-axis only, from XZ-projected direction)
startDir.y = 0; currentDir.y = 0;
const angle = atan2(cross, dot);
worldGroup.quaternion = startQuat * quaternionFromAxisAngle(Y, angle);
```

**Important:** Re-capture all start positions when transitioning between single-grip and two-grip mode. If you only capture on `squeezestart`, the positions will be stale when the second grip engages.

## Locomotion

Translate `worldGroup` in the opposite direction of desired user movement (moving world left = user appears to move right):

```js
// Get controller forward direction on XZ plane
const forward = new THREE.Vector3(0, 0, -1);
forward.applyQuaternion(controller.quaternion);
forward.y = 0;
forward.normalize();

const right = new THREE.Vector3().crossVectors(UP, forward);

worldGroup.position.addScaledVector(right, axisX * speed * delta);
worldGroup.position.addScaledVector(forward, axisY * speed * delta);
```

### Snap Turn

Rotate worldGroup in 30-degree increments with re-arm threshold:

```js
const SNAP_ANGLE = Math.PI / 6;  // 30 degrees
const THRESHOLD = 0.7;
const REARM = 0.3;

if (armed && Math.abs(axisX) > THRESHOLD) {
    worldGroup.rotateY(axisX > 0 ? -SNAP_ANGLE : SNAP_ANGLE);
    armed = false;
} else if (!armed && Math.abs(axisX) < REARM) {
    armed = true;
}
```

## Integration Checklist

1. Create the shared VR controls utility file
2. Add `<script>` tag before the visualization dashboard script
3. In the VR enable function:
   - Add controller ray lines and grip models
   - Instantiate VRControls with renderer, scene, camera, controls, callbacks
   - Call `vrControls.attach()`
   - Set up `setAnimationLoop` calling `vrControls.update(delta)` each frame
4. On visualization switch/destroy: call `vrControls.detach()`
5. For standalone viewers (e.g., 3D model viewer):
   - Add script tag
   - Instantiate in the VR setup function
   - Call update in the render frame function

## Common Pitfalls

| Problem | Cause | Fix |
|---------|-------|-----|
| Scene flies away on VR enter | Controllers reparented into worldGroup | Exclude XR controllers/grips from worldGroup |
| Scene drifts without input | Thumbstick capacitive sensing (Valve Index) | High deadzone (0.4) + require trigger held |
| Grab fires from holding controller | Valve Index pressure-sensitive grip | Require trigger+grip combo |
| Info cards invisible in VR | HTML DOM doesn't render in stereo | Use canvas texture sprites |
| Grab jumps on second grip engage | Start position captured on squeezestart, stale by combo time | Re-capture start positions when grab mode activates |
| OrbitControls fights XR camera | Both try to control the camera | Disable OrbitControls on attach, re-enable on detach |
| Trigger click fires after locomotion | User held trigger for movement then released | Track `_selectMoved` flag, suppress onSelect if thumbstick was used |
| Canvas roundRect not supported | Older browser/headset WebView | Fallback to fillRect/strokeRect |

## Hardware Tested

- Valve Index (SteamVR) — pressure-sensitive grip, capacitive thumbstick
- Implementation should work with Meta Quest, HTC Vive, and other WebXR headsets but grip/thumbstick sensitivity may need tuning
