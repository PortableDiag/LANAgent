// VR, through the browser's standard WebXR: the avatar stands on your floor at full size and looks
// at you. Talk is the way in, since a headset has no keyboard; a panel beside it shows the chat
// and has the buttons. Left stick walks, right stick turns, trigger presses.
import * as THREE from 'three';

const PANEL_W = 0.9, PANEL_H = 0.75, PX = 720, PY = 600;

export class VR {
  constructor({ renderer, scene, camera, onEnter, onExit, actions, lines }) {
    Object.assign(this, { renderer, scene, camera, onEnter, onExit, actions, lines });
    this.rig = new THREE.Group();
    this.world = new THREE.Group();
    this.world.visible = false;
    scene.add(this.rig, this.world);
    this.frames = 0;
    this.turned = false;
    this.hover = null;
    this.buttons = [];
    this.lastDrawn = '';
    this.buildRoom();
    this.buildPanel();
    this.buildControllers();
    renderer.xr.addEventListener('sessionstart', () => this.started());
    renderer.xr.addEventListener('sessionend', () => this.ended());
  }

  static async supported() {
    try { return !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'); } catch { return false; }
  }

  buildRoom() {
    const grid = new THREE.GridHelper(20, 40, 0x22d3ee, 0x1e2942);
    grid.material.transparent = true; grid.material.opacity = 0.5;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(10, 48), new THREE.MeshStandardMaterial({ color: 0x0a0f1a, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    this.world.add(grid, floor);
  }

  buildPanel() {
    const c = document.createElement('canvas');
    c.width = PX; c.height = PY;
    this.ctx = c.getContext('2d');
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, side: THREE.DoubleSide }));
    this.panel.position.set(0.95, 1.3, 0.55);
    this.panel.lookAt(0, 1.3, 1.5);
    this.world.add(this.panel);
  }

  buildControllers() {
    this.controllers = [0, 1].map((i) => {
      const con = this.renderer.xr.getController(i);
      const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x22d3ee }));
      ray.scale.z = 3;
      con.add(ray);
      con.userData.ray = ray;
      con.addEventListener('selectstart', () => this.press(con));
      this.rig.add(con);
      const grip = this.renderer.xr.getControllerGrip(i);
      // A plain marker: the browser's own controller models come from a CDN the page's policy refuses.
      grip.add(new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 12), new THREE.MeshStandardMaterial({ color: 0xa78bfa })));
      this.rig.add(grip);
      return con;
    });
    this.raycaster = new THREE.Raycaster();
  }

  async enter() {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    this.renderer.xr.setReferenceSpaceType('local-floor');
    await this.renderer.xr.setSession(session);
  }

  exit() { this.renderer.xr.getSession()?.end(); }

  started() {
    this.savedBackground = this.scene.background;
    this.rig.position.set(0, 0, 1.5);
    this.rig.rotation.set(0, 0, 0);
    this.rig.add(this.camera);
    this.world.visible = true;
    this.camera.clearViewOffset();
    this.frames = 0;
    this.lastDrawn = '';
    this.onEnter?.();
  }

  ended() {
    this.world.visible = false;
    this.scene.add(this.camera);
    this.rig.position.set(0, 0, 0);
    this.onExit?.();
  }

  press(con) {
    const b = this.hit(con);
    if (b) { b.fn(); this.lastDrawn = ''; }
  }

  hit(con) {
    const m = new THREE.Matrix4().extractRotation(con.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(con.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
    const h = this.raycaster.intersectObject(this.panel)[0];
    if (!h?.uv) return null;
    const x = h.uv.x * PX, y = (1 - h.uv.y) * PY;
    return this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
  }

  move(dt) {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const src of session.inputSources) {
      const axes = src.gamepad?.axes;
      if (!axes || axes.length < 4) continue;
      const x = axes[2], y = axes[3];
      if (src.handedness === 'left' && Math.hypot(x, y) > 0.2) {
        const dir = new THREE.Vector3();
        this.renderer.xr.getCamera().getWorldDirection(dir);
        dir.y = 0; dir.normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        this.rig.position.addScaledVector(dir, -y * dt * 1.4).addScaledVector(side, x * dt * 1.4);
      }
      if (src.handedness === 'right') {
        if (Math.abs(x) > 0.6 && !this.turned) { this.rig.rotation.y -= Math.sign(x) * Math.PI / 6; this.turned = true; }
        if (Math.abs(x) < 0.3) this.turned = false;
      }
    }
  }

  draw() {
    const acts = this.actions();
    const lines = this.lines();
    const stamp = JSON.stringify([acts.map((a) => a.label), lines, this.hover?.label]);
    if (stamp === this.lastDrawn) return;
    this.lastDrawn = stamp;
    const g = this.ctx;
    g.clearRect(0, 0, PX, PY);
    g.fillStyle = 'rgba(16,23,38,0.92)';
    g.beginPath(); g.roundRect(0, 0, PX, PY, 24); g.fill();
    g.font = '26px system-ui, sans-serif';
    g.textBaseline = 'top';
    let y = PY - 110;
    for (const l of lines.slice().reverse()) {
      const wrapped = wrap(g, l.text, PX - 60).slice(-5);
      y -= wrapped.length * 32 + 12;
      if (y < 16) break;
      g.fillStyle = l.role.includes('user') ? '#22D3EE' : '#E6EDF7';
      wrapped.forEach((t, i) => g.fillText(t, 30, y + i * 32));
    }
    this.buttons = [];
    let x = 24;
    const w = (PX - 48 - (acts.length - 1) * 12) / acts.length;
    for (const a of acts) {
      const b = { x, y: PY - 84, w, h: 62, label: a.label, fn: a.fn };
      this.buttons.push(b);
      g.fillStyle = this.hover?.label === a.label ? '#22D3EE' : '#1E2942';
      g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 12); g.fill();
      g.fillStyle = this.hover?.label === a.label ? '#05070D' : '#E6EDF7';
      g.textAlign = 'center';
      g.font = '600 26px system-ui, sans-serif';
      g.fillText(a.label, b.x + b.w / 2, b.y + 17);
      g.textAlign = 'left';
      g.font = '26px system-ui, sans-serif';
      x += w + 12;
    }
    this.tex.needsUpdate = true;
  }

  // Where the head is, as a look target; null outside VR.
  update(dt) {
    if (!this.renderer.xr.isPresenting) return null;
    this.frames++;
    this.move(dt);
    this.hover = null;
    for (const c of this.controllers) { const h = this.hit(c); if (h) this.hover = h; }
    this.draw();
    return new THREE.Vector3().setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
  }
}

function wrap(g, text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}
