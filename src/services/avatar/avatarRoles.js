/**
 * Role-based avatars (owner's idea 2026-11-18; store design 2119 #542, TextX 2119 #543).
 *
 * An agent can wear a different owned 3D model per role:
 *   - public:    profile pictures everyone sees (Telegram bot photo, X, MindSwarm, Gravatar, Trellis card, on-chain identity)
 *   - assistant: what goes to other people on the owner's behalf (videos and talking replies to contacts)
 *   - personal:  what only the owner sees (the 3D pages, AvatarX, the apps' agent picture, videos sent to the owner)
 *
 * The personal model IS the worn model (Agent.activeVRMModel), so every 3D page keeps working unchanged.
 * Empty slots fall back: assistant → public → worn; public → worn. With nothing assigned, everything is the worn model,
 * exactly as before. The store's name `private` is accepted for personal.
 */

export const ROLES = ['public', 'assistant', 'personal'];

/** 'private' → 'personal'; anything else unknown → null. */
export function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'private') return 'personal';
  return ROLES.includes(r) ? r : null;
}

/** Who a video or reply goes to → its role: the owner sees the personal model, anyone else the assistant one. */
export function roleForRecipient(to) {
  const t = String(to ?? '').trim().toLowerCase();
  return !t || /^(me|owner|myself|to me)$/.test(t) ? 'personal' : 'assistant';
}

/** The model id a role uses: its slot, else the fallback chain, else the worn model. */
export function resolveRoleModel(roles = {}, role, worn = null) {
  const r = normalizeRole(role) || 'personal';
  if (r === 'personal') return worn || roles.public || null;
  if (r === 'assistant') return roles.assistant || roles.public || worn || null;
  return roles.public || worn || null;
}

/** Every model id that some role uses (for pass renewals and fit syncs), without repeats. */
export function modelsInUse(roles = {}, worn = null) {
  return [...new Set(ROLES.map(r => resolveRoleModel(roles, r, worn)).filter(Boolean))];
}

/**
 * Fill empty slots from the store's `suits` (store design 2119 #542): for each empty role, the first owned model
 * whose product lists that role. Never touches a slot already set. Returns { role: modelId } for what it filled.
 * `owned` is [{ modelId, suits: [...] }].
 */
export function autoFillRoles(roles = {}, owned = []) {
  const filled = {};
  for (const role of ['public', 'assistant']) {
    if (roles[role]) continue;
    const hit = owned.find(o => o.modelId && (o.suits || []).map(normalizeRole).includes(role));
    if (hit) filled[role] = hit.modelId;
  }
  return filled;
}
