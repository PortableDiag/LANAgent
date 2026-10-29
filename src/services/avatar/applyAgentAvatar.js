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
 * Not changed here: the on-chain ERC-8004 identity (updating it costs gas; it is a separate,
 * deliberate step) and TextX/DialX (the apps fetch /textx/v1/avatar from avatarPath on their own).
 */

import fs from 'fs/promises';
import path from 'path';
import { DATA_PATH } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

const OTHER_EXTS = ['.jpg', '.jpeg', '.webp', '.gif'];

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
  const png = await sharp(buffer).rotate().resize(1024, 1024, { fit: 'cover' }).png().toBuffer();
  const dir = path.join(DATA_PATH, 'agent');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'avatar.png');
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
    const r = await tg.syncBotPhoto(file, { caption: `🖼 My new avatar (${source}).\n\nTelegram doesn't let a bot change its own photo here: in @BotFather send /setuserpic, pick this bot, and send this picture.` });
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

  logger.info(`Avatar applied from ${source}: ${Object.entries(services).map(([k, v]) => `${k} ${v}`).join(', ') || 'local only'}`);
  return { path: file, services };
}

/** "Telegram updated, MindSwarm not logged in, …" for a reply to the owner. */
export function describeAvatarServices(services) {
  const names = { telegram: 'Telegram', mindswarm: 'MindSwarm', twitter: 'X', gravatar: 'Gravatar' };
  const done = Object.entries(services).filter(([, v]) => v === 'updated').map(([k]) => names[k] || k);
  const other = Object.entries(services).filter(([, v]) => v !== 'updated' && v !== 'not connected').map(([k, v]) => `${names[k] || k} ${v}`);
  return [done.length ? `Updated on ${done.join(', ')}.` : '', other.join('; ')].filter(Boolean).join(' ');
}
