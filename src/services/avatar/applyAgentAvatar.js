/**
 * Make a picture the agent's avatar everywhere it shows one.
 *
 * Setting an avatar used to write data/agent/avatar.<ext> and the Agent record, and stop there:
 * DELTA's Bots & Borgs avatar (2026-10-28) became avatar.jpg beside the old avatar.png, so MindSwarm
 * (which reads avatar.png by name) and Trellis (avatar.png before .jpg) kept the old picture, and the
 * Telegram bot, Gravatar and X were never told. Now there is one file, always data/agent/avatar.png,
 * and every connected service gets the new picture. Each service is best-effort: one that is not
 * connected or refuses is reported, never fatal.
 *
 * The picture being replaced goes to data/agent/avatar-history first: DELTA's original avatar was
 * lost to an overwrite. To put one back, apply that file again.
 *
 * The on-chain ERC-8004 identity shows the avatar too, so a changed picture goes there as well (owner, 2026-11-05):
 * a new IPFS upload and one setAgentURI transaction, only when the picture really changed. TextX/DialX fetch
 * /textx/v1/avatar from avatarPath, and are told the new address at once. AvatarX is not hooked up to this agent yet.
 */

import fs from 'fs/promises';
import path from 'path';
import { DATA_PATH } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

const OTHER_EXTS = ['.jpg', '.jpeg', '.webp', '.gif'];
const HISTORY_KEEP = 20;
const MAX_AVATAR_BYTES = 1500 * 1024;

/**
 * Copy the avatar about to be replaced into avatar-history, newest 20 kept. A failure here never blocks the change.
 * Returns whether the picture differs from the current avatar.png.
 */
async function keepPrevious(dir, png) {
  const historyDir = path.join(dir, 'avatar-history');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const current = await fs.readFile(path.join(dir, 'avatar.png')).catch(() => null);
  try {
    for (const ext of ['.png', ...OTHER_EXTS]) {
      const old = await fs.readFile(path.join(dir, `avatar${ext}`)).catch(() => null);
      if (!old || old.equals(png)) continue;
      await fs.mkdir(historyDir, { recursive: true });
      await fs.writeFile(path.join(historyDir, `avatar-${stamp}${ext}`), old);
    }
    const kept = (await fs.readdir(historyDir).catch(() => [])).filter(n => n.startsWith('avatar-')).sort();
    for (const name of kept.slice(0, -HISTORY_KEEP)) await fs.unlink(path.join(historyDir, name));
  } catch (e) {
    logger.warn(`Avatar: could not keep the previous picture: ${e.message}`);
  }
  return !current?.equals(png);
}

/** The plugin instance behind an apiManager entry, or null. */
function pluginOf(agent, name) {
  const entry = agent?.apiManager?.apis?.get?.(name);
  return entry ? (entry.instance || entry) : null;
}

/**
 * @param {object} agent    the running agent (agentModel, interfaces, apiManager)
 * @param {Buffer} buffer   the picture, any format sharp reads
 * @param {object} [opts]   { source: 'where it came from, for the log', only: ['telegram', …] to limit the services }
 * @returns {Promise<{ path: string, services: Record<string, string> }>} what each service did
 */
export async function applyAgentAvatar(agent, buffer, { source = 'a new picture', only = null } = {}) {
  const { default: sharp } = await import('sharp');
  // 1024×1024 PNG: Telegram, X and Gravatar all take it, and Trellis shrinks it to 256 itself.
  let png = await sharp(buffer).rotate().resize(1024, 1024, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
  // DialX and TextX refuse a sealed avatar over 2 MB, and say nothing to the user.
  if (png.length > MAX_AVATAR_BYTES) png = await sharp(png).png({ palette: true, compressionLevel: 9 }).toBuffer();
  const dir = path.join(DATA_PATH, 'agent');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'avatar.png');
  const changed = await keepPrevious(dir, png);
  await fs.writeFile(file, png);
  for (const ext of OTHER_EXTS) await fs.unlink(path.join(dir, `avatar${ext}`)).catch(() => {});

  const { Agent } = await import('../../models/Agent.js');
  await Agent.updateOne({ name: process.env.AGENT_NAME || 'LANAgent' }, { $set: { avatarPath: 'data/agent/avatar.png', avatar: '/api/agent/avatar' } });
  if (agent?.agentModel) { agent.agentModel.avatarPath = 'data/agent/avatar.png'; agent.agentModel.avatar = '/api/agent/avatar'; }

  const wanted = (name) => !only || only.includes(name);
  const services = {};
  const attempt = async (name, run) => {
    if (!wanted(name)) return;
    try {
      services[name] = (await run()) || 'updated';
    } catch (e) {
      services[name] = `not updated: ${String(e?.message || e).slice(0, 160)}`;
    }
  };

  await attempt('telegram', async () => {
    const tg = agent?.interfaces?.get?.('telegram');
    if (!tg?.syncBotPhoto) return 'not connected';
    const r = await tg.syncBotPhoto(file, { caption: `🖼 My new avatar (${source}).\n\nTelegram refused my request to set it myself, so: in @BotFather send /setuserpic, pick this bot, and send this picture.` });
    if (!r?.success) throw new Error(r?.error || 'refused');
    return r.note ? 'sent to the owner to set in @BotFather' : 'updated';
  });
  await attempt('mindswarm', async () => {
    const ms = pluginOf(agent, 'mindswarm');
    if (!ms?._uploadAvatar) return 'not connected';
    if (!ms.accessToken) return 'not logged in';
    await ms._uploadAvatar({ filePath: file });
    return 'updated';
  });
  await attempt('twitter', async () => {
    const tw = pluginOf(agent, 'twitter');
    if (!tw?.updateAvatar) return 'not connected';
    const r = await tw.updateAvatar({ imagePath: file });
    if (!r?.success) throw new Error(r?.error || 'refused');
    return 'updated';
  });
  await attempt('gravatar', async () => {
    if (!process.env.GRAVATAR_OAUTH_TOKEN && !process.env.GRAVATAR_API_KEY) return 'not connected';
    const { uploadAvatarToGravatar } = await import('../../utils/gravatarHelper.js');
    const r = await uploadAvatarToGravatar(file, process.env.EMAIL_USER || process.env.GMAIL_USER);
    if (!r?.success) throw new Error(r?.error || 'refused');
    return 'updated';
  });
  await attempt('trellis', async () => {
    const listener = pluginOf(agent, 'trellis-notes')?.listener;
    if (!listener?._publishCard) return 'not connected';
    await listener._publishCard();
    return 'updated';
  });
  // TextX, DialX, NotifX and the LANAgent app, all through their pairing.
  await attempt('apps', async () => {
    const { textxIfStarted } = await import('../textx/index.js');
    const hub = textxIfStarted()?.hub;
    if (!hub?.avatarChanged) return 'not connected';
    if (!changed) return 'unchanged';
    const told = await hub.avatarChanged();
    logger.info(`Avatar: told ${told} paired app(s) about the new picture`);
    return told ? 'updated' : 'not connected';
  });
  await attempt('identity', async () => {
    const minted = agent?.agentModel?.erc8004;
    if (!minted?.agentId || minted.status !== 'active') return 'not connected';
    if (!changed) return 'unchanged';
    const { default: identity } = await import('../crypto/agentIdentityService.js');
    const r = await identity.updateRegistration({ forceAvatarReupload: true });
    logger.info(`Avatar: on-chain identity ${r.agentId} now points at ${r.agentURI} (tx ${r.txHash})`);
    return 'updated';
  });

  logger.info(`Avatar applied from ${source}: ${Object.entries(services).map(([k, v]) => `${k} ${v}`).join(', ') || 'local only'}`);
  return { path: file, services };
}

/** "Telegram updated, MindSwarm not logged in, …" for a reply to the owner. */
export function describeAvatarServices(services) {
  const names = { telegram: 'Telegram', mindswarm: 'MindSwarm', twitter: 'X', gravatar: 'Gravatar', trellis: 'Trellis', apps: 'TextX, DialX and NotifX', identity: 'my on-chain identity' };
  const done = Object.entries(services).filter(([, v]) => v === 'updated').map(([k]) => names[k] || k);
  const other = Object.entries(services).filter(([, v]) => !['updated', 'not connected', 'unchanged'].includes(v)).map(([k, v]) => `${names[k] || k} ${v}`);
  return [done.length ? `Updated on ${done.join(', ')}.` : '', other.join('; ')].filter(Boolean).join(' ');
}
