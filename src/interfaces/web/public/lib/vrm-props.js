// Bots & Borgs props ("bots-and-borgs props 1", Trellis 2119 #494): a .glb held in a hand or set on the floor, shown
// only while a clip that uses it plays. Shared by the playground, the designer and the headless video render.
//
// An attachment: { prop, file | url, bone, position: [x,y,z] (metres), rotation: [x,y,z] (degrees, XYZ Euler) }.
// bone = a VRM humanoid bone, parented to vrm.humanoid.getNormalizedBoneNode(bone), whose space the numbers are in;
// "floor" = the avatar root (vrm.scene), metres from the avatar origin, +Z forward. The .glb origin is the grip point.
//
// Without props nothing here runs: an empty or missing list attaches nothing. A prop that is malformed, whose bone the
// model lacks, or whose file fails to load is skipped with a warning; the clip plays on without it.

const DEG = Math.PI / 180;
const cache = new Map(); // url -> Promise<Object3D> (the loaded scene; each use gets a clone)

const triple = (a) => Array.isArray(a) && a.length === 3 && a.every(n => typeof n === 'number' && Number.isFinite(n));

/** True when an attachment can be placed: a bone name, a file or url, and three numbers each for position and rotation. */
export function validAttachment(p) {
  return !!p && typeof p.bone === 'string' && /^[A-Za-z]+$/.test(p.bone) && (typeof p.url === 'string' || typeof p.file === 'string')
    && triple(p.position) && triple(p.rotation);
}

export function propUrl(p, base = '/vrm-models/') {
  if (typeof p.url === 'string') return p.url;
  return base + String(p.file).split('/').map(encodeURIComponent).join('/');
}

/**
 * This body's standing hip height in metres (rest pose, not the clip's current pose: a prop is attached while the clip
 * plays, and a sitting clip would halve it). Null when the model does not say.
 */
export function standingHips(vrm) {
  const y = vrm?.humanoid?.normalizedRestPose?.hips?.position?.[1];
  const s = vrm?.scene?.scale?.y ?? 1;
  return typeof y === 'number' && y > 0.1 ? y * s : null;
}

/** The factor a placement made to scale (scale_with "body", ref_hips) takes on this body; 1 otherwise. */
export function bodyScale(vrm, p) {
  if (p?.scale_with !== 'body' || !(p.ref_hips > 0.1)) return 1;
  const hips = standingHips(vrm);
  return hips ? hips / p.ref_hips : 1;
}

/** True for a VRM 0.x model (three-vrm meta.metaVersion "0"). */
export function isVrm0(vrm) {
  return String(vrm?.meta?.metaVersion ?? '') === '0';
}

function frameHolder(vrm) {
  const Group = vrm.scene.constructor; // three's Group/Object3D, without importing three here
  const holder = new Group();
  if (isVrm0(vrm)) holder.rotation.y = Math.PI;
  return holder;
}

async function loadProp(GLTFLoader, url) {
  if (!cache.has(url)) {
    const loading = new GLTFLoader().loadAsync(url).then(g => g.scene);
    loading.catch(() => cache.delete(url)); // a failed load is tried again next time
    cache.set(url, loading);
  }
  return (await cache.get(url)).clone(true);
}

/**
 * Attach every prop in `props` to `vrm`. Returns the placed objects (pass them to detachProps). `isCurrent()` is asked
 * after each load: false (the clip changed meanwhile) drops what was loaded instead of showing it on the wrong clip.
 */
export async function attachProps({ GLTFLoader, vrm, props, base = '/vrm-models/', isCurrent = () => true, warn = (m) => console.warn(m) }) {
  const placed = [];
  if (!Array.isArray(props) || !props.length || !vrm) return placed;
  for (const p of props) {
    if (!validAttachment(p)) { warn(`Prop ${p?.prop || '?'}: attachment is malformed, skipped`); continue; }
    const parent = p.bone === 'floor' ? vrm.scene : vrm.humanoid?.getNormalizedBoneNode?.(p.bone);
    if (!parent) { warn(`Prop ${p.prop || p.file}: this model has no ${p.bone} bone, skipped`); continue; }
    let obj;
    try { obj = await loadProp(GLTFLoader, propUrl(p, base)); } catch (e) { warn(`Prop ${p.prop || p.file}: ${e?.message || 'did not load'}, skipped`); continue; }
    if (!isCurrent()) { detachProps(placed); return []; }
    const k = bodyScale(vrm, p);
    obj.position.set(p.position[0] * k, p.position[1] * k, p.position[2] * k);
    obj.rotation.set(p.rotation[0] * DEG, p.rotation[1] * DEG, p.rotation[2] * DEG, 'XYZ');
    const size = (typeof p.scale === 'number' && p.scale > 0 ? p.scale : 1) * k;
    if (size !== 1) obj.scale.multiplyScalar(size);
    obj.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    // The numbers are for VRM 1.0 (+Z forward). A VRM 0.x body faces -Z, so its bone and root frames are turned 180°
    // about Y: the prop goes in a holder turned back, or it lands mirrored (RemoteAgent, 2951 #200).
    const holder = frameHolder(vrm);
    holder.name = `clip-prop-${p.prop || 'glb'}`;
    holder.userData.floor = p.bone === 'floor';
    holder.add(obj);
    parent.add(holder);
    placed.push(holder);
  }
  return placed;
}

/** Remove placed props. The loaded files stay cached (clones share them), so nothing is disposed here. */
export function detachProps(placed) {
  for (const o of placed || []) o?.parent?.remove(o);
}
