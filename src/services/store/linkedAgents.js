/**
 * Bots & Borgs linked agents (store 0.51.0, llms.txt "Linked agents"; design 2119 #564-#571): a person lets this agent
 * use some of their own avatars (My Models: models, outfits, saved looks), read-only. The agent asks with its own key
 * (POST /api/account/links/request {owner_email}) or takes a one-time code; the owner picks the models and the
 * per-agent roles in their dashboard. Files come by ETag = sha256; offline copies are fine; an ended link (403
 * link_ended, or feed kind link_ended) means deleting our copies of their models.
 *
 * Per-contact avatars: the owner shows a different avatar to each person the agent talks to. The store only ever sees
 * OUR opaque key for a contact (an HMAC of our Person id) and a label the owner types: never a number, email or handle.
 *
 * This module is the part with no network: names, keys and reading the store's answers.
 */
import crypto from 'node:crypto';

export const LINK_ROLES = ['public', 'assistant', 'personal'];

/** The gallery variant for one outfit of a linked model: linked-<link>-<model>-<outfit>, lower case, safe. */
export function linkedVariant(linkId, model, outfit) {
  const s = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `linked-${s(linkId)}-${s(model)}-${s(outfit) || 'default'}`;
}

/** The start every gallery id of one link's models has (store-linked-<link>-). */
export const linkedPrefix = (linkId) => `store-linked-${String(linkId ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}-`;

/** The gallery id installVrm gives that variant (store-<variant>). */
export const linkedModelId = (linkId, model, outfit) => `store-${linkedVariant(linkId, model, outfit)}`;

/**
 * Our opaque key for a contact: an HMAC of the Person id under a secret of this agent, so the store can't tell who it
 * is and two agents' keys for one person never match. 1-64 of [A-Za-z0-9._:~-] (the store's rule).
 */
export function contactKey(personId, secret) {
  if (!personId) throw new Error('no person');
  if (!secret) throw new Error('no secret for contact keys');
  return `p_${crypto.createHmac('sha256', String(secret)).update(String(personId)).digest('hex').slice(0, 40)}`;
}

/** The links where this agent is the agent, from GET /api/account/links, whatever envelope it comes in. */
export function agentLinks(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.as_agent) ? d.as_agent : Array.isArray(d?.links) ? d.links.filter(l => !l.role || l.role === 'agent' || l.as === 'agent') : [];
  return list.filter(Boolean).map(l => ({ id: String(l.id || l.link || ''), status: String(l.status || l.state || 'active'), owner: l.owner_name || l.owner || null })).filter(l => l.id);
}

/**
 * Every outfit a link lets us use, from GET /api/account/links/<id>: [{ model, outfit, name, sha256, file, looks,
 * personalLicense }]. A model with no outfits list is its own one outfit.
 */
export function linkOutfits(detail) {
  const models = Array.isArray(detail?.models) ? detail.models : [];
  const out = [];
  for (const m of models) {
    const modelId = m.id || m.model || m.slug;
    if (!modelId) continue;
    const outfits = Array.isArray(m.outfits) && m.outfits.length ? m.outfits : [{ id: m.outfit || 'default', sha256: m.sha256, file: m.file, looks: m.looks }];
    for (const o of outfits) {
      out.push({
        model: String(modelId), outfit: String(o.id || o.outfit || o.name || 'default'),
        name: [m.name || modelId, o.name && o.name !== m.name ? o.name : null].filter(Boolean).join(' — '),
        sha256: o.sha256 ? String(o.sha256).toLowerCase() : null, file: o.file || null,
        looks: Array.isArray(o.looks) ? o.looks : [],
        personalLicense: m.personal_license === true || o.personal_license === true || detail?.personal_license === true
      });
    }
  }
  return out;
}

/**
 * What GET …/roles/<role> or …/contacts/<key>/avatar answers: { model, outfit, look, fallback } or null. `fallback`
 * is set when the owner chose nothing for it (the store answered another role's avatar, `fallback_from`).
 */
export function readChoice(d) {
  const a = d?.avatar && typeof d.avatar === 'object' ? d.avatar : d || {};
  let model = a.model || a.model_id || null;
  let outfit = a.outfit || a.outfit_id || null;
  let look = a.look?.id || a.look_id || (typeof a.look === 'string' ? a.look : null);
  const ref = a.ref || d?.ref;
  if (!model && typeof ref === 'string') {
    // "locker:<model>/<outfit>[#<look>]"
    const m = /^locker:([^/#]+)\/([^#]+)(?:#(.+))?$/.exec(ref);
    if (m) { model = m[1]; outfit = m[2]; look = look || m[3] || null; }
  }
  if (!model) return null;
  return { model: String(model), outfit: String(outfit || 'default'), look: look ? String(look) : null, fallback: d?.fallback_from || a.fallback_from || null };
}

/** The store's ref for a choice: locker:<model>/<outfit>[#<look>]. */
export const lockerRef = (model, outfit, look = null) => `locker:${model}/${outfit}${look ? `#${look}` : ''}`;

/** sha256 of a buffer, hex. */
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Whether an error from the store means the link is over (403 link_ended). */
export const linkEnded = (e) => e?.status === 403 && /link_ended/.test(String(e?.code || e?.message || ''));
