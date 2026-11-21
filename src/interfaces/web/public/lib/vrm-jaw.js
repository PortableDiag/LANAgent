// The jaw moves with the voice on rigs whose mouth opens by a bone (Character Creator models converted to VRM: Rose,
// 2026-11-20). Their `aa` expression drives only the skin's Jaw_Open shape key, which barely parts the lips, while the
// teeth and lower jaw follow the CC_Base_JawRoot bone; a VRM expression cannot move a bone. So when the model has a
// humanoid `jaw` bone and its `aa` does not move the teeth itself, the jaw bone is turned open with the mouth level.
// Positive x opens (checked on Rose: +0.25 rad shows the teeth and tongue; past ~0.12 its tongue comes forward, so the
// opening stays small until the store bakes jaw visemes into such models, 2119 #580). Models without a jaw bone (VRoid, the
// store's own) are left alone.

/** A driver for this VRM's jaw, or null when its expressions already open the mouth. set(level 0..1) each frame. */
export function jawDriver(vrm, { maxRad = 0.12 } = {}) {
  const jaw = vrm?.humanoid?.getNormalizedBoneNode?.('jaw');
  if (!jaw) return null;
  const aa = vrm.expressionManager?.getExpression?.('aa');
  const binds = aa?._binds || aa?.binds || [];
  const meshName = (b) => [b?.primitives?.[0]?.name, b?.primitives?.[0]?.parent?.name, b?.primitive?.name].filter(Boolean).join(' ');
  if (binds.some((b) => /teeth|tooth/i.test(meshName(b)))) return null;
  const rest = jaw.rotation.x;
  return {
    set(level) {
      const l = Math.max(0, Math.min(1, Number(level) || 0));
      jaw.rotation.x = rest + maxRad * l;
    }
  };
}
