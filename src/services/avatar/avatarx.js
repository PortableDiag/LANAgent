/**
 * Tell an AvatarX sidecar which VRM this agent wears. AvatarX is an optional extra body for the agent, beside the
 * avatar designer and playground, which stay as they are. The agent pushes and AvatarX never polls (AvatarX README,
 * "Other agents"). Off unless AVATARX_URL and AVATARX_AGENT_KEY_FILE are set. A .vrm stays on this machine.
 * AvatarX makes its own certificate: AVATARX_CA_FILE names it, and it is verified, never skipped.
 */
import fs from 'fs/promises';
import path from 'path';
import https from 'node:https';
import axios from 'axios';
import { DATA_PATH } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

/** fetch's shape over axios, which can be told which certificate to trust. */
function fetcherTrusting(ca) {
  const httpsAgent = ca ? new https.Agent({ ca }) : undefined;
  return async (url, { method, body, headers }) => {
    const res = await axios({ url, method, data: body, headers, httpsAgent, timeout: 120000, maxBodyLength: Infinity, validateStatus: () => true });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.data };
  };
}

/** An authorized caller for the sidecar's agent API, or null when AvatarX is not set up here. */
async function connect({ url = process.env.AVATARX_URL, keyFile = process.env.AVATARX_AGENT_KEY_FILE, caFile = process.env.AVATARX_CA_FILE, fetchFn } = {}) {
  if (!url || !keyFile) return null;
  const send = fetchFn || fetcherTrusting(caFile ? await fs.readFile(caFile) : null);
  const key = (await fs.readFile(keyFile, 'utf8')).trim();
  const base = String(url).replace(/\/+$/, '');
  return async (method, route, body, type = 'application/json') => {
    const res = await send(`${base}${route}`, {
      method, body, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': type } : {}) }
    });
    if (!res.ok) throw new Error(`AvatarX ${method} ${route}: ${res.status}`);
    return res.json();
  };
}

/** The agent-API caller, or null when AvatarX is not set up here. */
export const avatarxCaller = (opts) => connect(opts);

/** AvatarX's name for a clip: its file stem, lower case, [a-z0-9_-] (AvatarX store::clean_name). */
export function avatarxClipName(file) {
  const stem = path.basename(String(file || '')).replace(/\.(vrma|fbx)$/i, '');
  return stem.split('').map(c => /[A-Za-z0-9_-]/.test(c) ? c.toLowerCase() : '_').join('').slice(0, 60);
}

/**
 * Give AvatarX the clips this agent owns, so each is a button there and the agent can play it. Clips are keyed by name
 * and a re-upload replaces, so this is safe to repeat. A name that is one of AvatarX's built-in gestures gets a bnb-
 * prefix, never shadowing it. clips: [{ file (absolute path), name?, replace? }]: `replace` uploads even when AvatarX holds
 * the name already (the store reissued the file: Set One's Wave, 2026-11-09). Returns the names AvatarX holds, or 'not connected'.
 */
export async function pushClipsToAvatarX(clips, opts = {}) {
  const call = await connect(opts);
  if (!call) return 'not connected';
  const state = await call('GET', '/agent/v1/state');
  const builtIn = new Set(state.gestures || []);
  const have = new Set(state.animations || []);
  const names = [];
  for (const c of clips) {
    let name = avatarxClipName(c.name || c.file);
    if (!name) continue;
    // bnb- once a built-in had the name: keep that name though AvatarX has since dropped the built-in (its wave, 0.3.4).
    if (builtIn.has(name) || have.has(`bnb-${name}`.slice(0, 60))) name = `bnb-${name}`.slice(0, 60);
    if (!have.has(name) || c.replace) {
      const up = await call('POST', `/agent/v1/animations?name=${encodeURIComponent(name)}`, await fs.readFile(c.file), 'application/octet-stream');
      name = up.animation || name;
      logger.info(`AvatarX: added clip ${name}`);
    }
    names.push(name);
  }
  return names;
}

/** Play a gesture or an owned clip on AvatarX now. Returns 'played', or 'not connected'. */
export async function playOnAvatarX(name, opts = {}) {
  const call = await connect(opts);
  if (!call) return 'not connected';
  await call('POST', '/agent/v1/gesture', JSON.stringify({ name }));
  logger.info(`AvatarX: played ${name}`);
  return 'played';
}

export async function pushModelToAvatarX(modelId, {
  url = process.env.AVATARX_URL,
  keyFile = process.env.AVATARX_AGENT_KEY_FILE,
  caFile = process.env.AVATARX_CA_FILE,
  vrmDir = path.join(DATA_PATH, 'vrm-models'),
  fetchFn
} = {}) {
  const call = await connect({ url, keyFile, caFile, fetchFn });
  if (!call) return 'not connected';
  const manifest = JSON.parse(await fs.readFile(path.join(vrmDir, 'manifest.json'), 'utf8'));
  const model = manifest.find(m => m.id === modelId);
  if (!model?.file) throw new Error(`model ${modelId} is not in the gallery`);
  const name = model.name || modelId;
  // An upload always adds an entry and the agent's key can't delete one, so look by name first.
  const state = await call('GET', '/agent/v1/state');
  // Same name AND same size is the same file. A store fix keeps the name and changes the bytes (Racer Blue's hair,
  // 2026-11-08): then the new file goes up and is shown. The agent's key can't delete, so the old copy stays in
  // AvatarX's list (Settings) until the owner removes it; the log says which.
  const bytes = await fs.readFile(path.join(vrmDir, model.file));
  const same = (state.avatars || []).filter(a => a.name === name);
  let id = same.find(a => a.size == null || Number(a.size) === bytes.length)?.id;
  if (!id) {
    const up = await call('POST', `/agent/v1/avatars?name=${encodeURIComponent(name)}`, bytes, 'application/octet-stream');
    id = up.avatar?.id;
    if (!id) throw new Error('AvatarX answered an upload with no id');
    if (same.length) logger.info(`AvatarX: ${name} changed (${bytes.length} bytes); older copies left to remove in AvatarX Settings: ${same.map(a => a.id).join(', ')}`);
  }
  if (state.active === id) return 'unchanged';
  await call('PATCH', '/agent/v1/state', JSON.stringify({ active: id }));
  logger.info(`AvatarX: now showing ${name} (${id})`);
  return 'updated';
}
