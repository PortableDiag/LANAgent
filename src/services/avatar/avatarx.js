/**
 * Tell an AvatarX sidecar which VRM this agent wears. AvatarX is an optional extra body for the agent, beside the
 * avatar designer and playground, which stay as they are. The agent pushes and AvatarX never polls (AvatarX README,
 * "Other agents"). Off unless AVATARX_URL and AVATARX_AGENT_KEY_FILE are set. A .vrm stays on this machine.
 */
import fs from 'fs/promises';
import path from 'path';
import { DATA_PATH } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

export async function pushModelToAvatarX(modelId, {
  url = process.env.AVATARX_URL,
  keyFile = process.env.AVATARX_AGENT_KEY_FILE,
  vrmDir = path.join(DATA_PATH, 'vrm-models'),
  fetchFn = fetch
} = {}) {
  if (!url || !keyFile) return 'not connected';
  const key = (await fs.readFile(keyFile, 'utf8')).trim();
  const base = String(url).replace(/\/+$/, '');
  const call = async (method, route, body, type = 'application/json') => {
    const res = await fetchFn(`${base}${route}`, {
      method, body, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': type } : {}) },
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) throw new Error(`AvatarX ${method} ${route}: ${res.status}`);
    return res.json();
  };
  const manifest = JSON.parse(await fs.readFile(path.join(vrmDir, 'manifest.json'), 'utf8'));
  const model = manifest.find(m => m.id === modelId);
  if (!model?.file) throw new Error(`model ${modelId} is not in the gallery`);
  const name = model.name || modelId;
  // An upload always adds an entry and the agent's key can't delete one, so look by name first.
  const state = await call('GET', '/agent/v1/state');
  let id = (state.avatars || []).find(a => a.name === name)?.id;
  if (!id) {
    const up = await call('POST', `/agent/v1/avatars?name=${encodeURIComponent(name)}`, await fs.readFile(path.join(vrmDir, model.file)), 'application/octet-stream');
    id = up.avatar?.id;
    if (!id) throw new Error('AvatarX answered an upload with no id');
  }
  await call('PATCH', '/agent/v1/state', JSON.stringify({ active: id }));
  logger.info(`AvatarX: now showing ${name} (${id})`);
  return 'updated';
}
