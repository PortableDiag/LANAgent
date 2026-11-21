// LANAgent: copied from AvatarX web/src/look.js (0.4.6, MIT, eef3d08) — the store's look spec (2119 #575, 2951 #277).
// A saved look from the owner's Bots & Borgs locker, worn on its outfit file (the store's spec, #2951 277):
//   {pieces: ["Body", "Hair", ...] | null, colors: {<material>: {hue, sat, light} | {tint: "#rrggbb"}}, morphs: {<shape key>: -1..1}}
// - pieces: each mesh node naming a piece (glTF extras.bnb_piece, three.js userData) is shown when the list has its
//   exact name and hidden otherwise; with no list, the author's default (bnb_default_visible). Other nodes are never touched.
// - colors, by material name: {hue (deg), sat, light} filters the material's texture as CSS hue-rotate, saturate and
//   brightness do (a copy of the texture, so the colour is changed, not only its multiplier); with no texture, its
//   colour. {tint} replaces a plain colour.
// - morphs, by shape-key name: set on every mesh that has the key, again after each VRM update.
import * as THREE from 'three';

function filtered(tex, c) {
  const img = tex?.image;
  const w = img?.width, h = img?.height;
  if (!w || !h) return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.filter = `hue-rotate(${Number(c.hue) || 0}deg) saturate(${c.sat ?? 1}) brightness(${c.light ?? 1})`;
  g.drawImage(img, 0, 0, w, h);
  const t = new THREE.CanvasTexture(cv);
  for (const k of ['flipY', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'colorSpace', 'channel', 'anisotropy']) t[k] = tex[k];
  t.offset.copy(tex.offset); t.repeat.copy(tex.repeat); t.rotation = tex.rotation; t.center.copy(tex.center);
  t.needsUpdate = true;
  return t;
}

// The same filter on one colour (the CSS filter matrices, in linear order hue -> saturate -> brightness).
function filterColor(color, c) {
  if (!color?.isColor) return;
  const a = (Number(c.hue) || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const m = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  let { r, g, b } = color;
  [r, g, b] = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
  const s = c.sat ?? 1;
  const sm = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  [r, g, b] = [sm[0] * r + sm[1] * g + sm[2] * b, sm[3] * r + sm[4] * g + sm[5] * b, sm[6] * r + sm[7] * g + sm[8] * b];
  const l = c.light ?? 1;
  color.setRGB(THREE.MathUtils.clamp(r * l, 0, 1), THREE.MathUtils.clamp(g * l, 0, 1), THREE.MathUtils.clamp(b * l, 0, 1));
}

/** Apply a look to a loaded VRM. Returns what it applied, and an `apply(vrm)` to call after each vrm.update. */
export function wearLook(vrm, look) {
  const out = { pieces: [], hidden: [], colors: [], morphs: [], apply: () => {} };
  if (!vrm) return out;
  const pieces = look && Array.isArray(look.pieces) ? look.pieces : null;
  vrm.scene.traverse((o) => {
    const name = o.userData?.bnb_piece;
    if (!name) return;
    o.visible = pieces ? pieces.includes(name) : o.userData.bnb_default_visible !== false;
    (o.visible ? out.pieces : out.hidden).push(name);
  });
  if (!look || typeof look !== 'object') return out;
  const colors = look.colors && typeof look.colors === 'object' ? look.colors : {};
  const done = new Set();
  vrm.scene.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (!m || done.has(m) || !(m.name in colors)) continue;
      done.add(m);
      const c = colors[m.name] || {};
      if (typeof c.tint === 'string') {
        m.color?.set(c.tint);
      } else {
        for (const slot of ['map', 'shadeMultiplyTexture']) {
          const t = m[slot] && filtered(m[slot], c);
          if (t) { m[slot] = t; if (m.uniforms?.[slot]) m.uniforms[slot].value = t; }
        }
        if (!m.map) filterColor(m.color, c);
        if (m.shadeColorFactor && !m.shadeMultiplyTexture) filterColor(m.shadeColorFactor, c);
      }
      m.needsUpdate = true;
      out.colors.push(m.name);
    }
  });
  const morphs = look.morphs && typeof look.morphs === 'object' ? look.morphs : {};
  const targets = [];
  for (const [name, raw] of Object.entries(morphs)) {
    const w = THREE.MathUtils.clamp(Number(raw) || 0, -1, 1);
    let hit = false;
    vrm.scene.traverse((o) => {
      const i = o.morphTargetDictionary?.[name];
      if (i == null || !o.morphTargetInfluences) return;
      targets.push({ o, i, w });
      hit = true;
    });
    if (hit) out.morphs.push(name);
  }
  out.apply = () => { for (const t of targets) t.o.morphTargetInfluences[t.i] = t.w; };
  return out;
}
