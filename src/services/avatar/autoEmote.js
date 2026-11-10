/**
 * Emotes on the agent's 3D body during a conversation: after a reply, AvatarX nods, shrugs, waves or cheers and takes
 * a face (mood) that suits what was said, the way a person moves while talking (owner, 2026-11-09: "build the auto
 * emotes"). Only conversational moves are used, never a dance; a move plays only if AvatarX holds it (its three head
 * moves, or a clip the agent owns), so a new pack (Emote Set Two, the Idle Pack) is picked up as soon as it is bought.
 * Decoration: a slow or failed model, or no AvatarX, means no emote, and never a late one or an error.
 */
import { logger } from '../../utils/logger.js';

/** What each conversational move means, by AvatarX name (clip file stem; a store clip clashing with a built-in gets bnb-). */
export const EMOTES = {
  nod: 'yes, agreeing, understood, confirming',
  shake_head: 'no, disagreeing, that is not right, sadly not',
  look_around: 'looking for something, puzzled, not sure where',
  wave: 'hello or goodbye, good night',
  bow: 'thank you, respect, an apology',
  cheer: 'celebrating good news or a win',
  clap: 'applauding an achievement, well done',
  laugh: 'laughing at a joke, something funny',
  think: 'thinking it over, working something out, an open question',
  shrug: 'not knowing, it depends, oh well',
  salute: 'on it, will do, yes sir',
  facepalm: 'a silly mistake, oops, exasperation',
  point: 'pointing out the answer, that one',
  'thumbs-up': 'done, it worked, all good, approval',
  'hands-on-hips': 'mock stern, ready, confident',
  'arms-crossed': 'unimpressed, firm, waiting',
  beckon: 'come here, follow me, let me show you',
  'blow-kiss': 'affection, love, sweet goodbye'
};

/** The AvatarX names among `held` that are conversational moves: [{ name, means }]. Dances and loops never match. */
export function emotesHeld(held = []) {
  const out = [];
  for (const name of held) {
    const base = String(name).replace(/^bnb-/, '').replace(/^emote-/, '');
    const key = Object.keys(EMOTES).find(k => base === k || base.endsWith(`-${k}`));
    if (key && !out.some(e => e.key === key)) out.push({ name, key, means: EMOTES[key] });
  }
  return out;
}

/** Whether a reply can carry an emote at all: some text, not a code dump. */
export function emoteCouldFit(replyText) {
  const r = String(replyText || '').trim();
  return !!r && r.length <= 3000 && !r.includes('```');
}

/** { emote, mood } for this exchange (either may be null). `generate(prompt)` is the model. */
export async function chooseEmote({ generate, emotes, moods = [], userText, replyText, agentName = 'The assistant', timeoutMs = 10000 }) {
  if (!emoteCouldFit(replyText) || (!emotes?.length && !moods?.length)) return { emote: null, mood: null };
  const prompt = `${agentName} has a 3D body on its owner's screen and has just replied in a conversation. Choose the body language for that reply, the way a person moves while talking.\n\n` +
    `Owner: ${String(userText || '').slice(0, 500)}\n${agentName}: ${String(replyText).slice(0, 900)}\n\n` +
    `Moves (name: what it means):\n${emotes.map(e => `- ${e.name}: ${e.means}`).join('\n')}\n\n` +
    `Faces: ${moods.join(', ')}\n\n` +
    'Pick the move that fits what the reply does, or none when nothing clearly fits (plain facts, a long explanation). Never a cheerful move or face for death, grief, illness, pain or worry: there a nod or none, and a sad face. ' +
    'The face matches the feeling of the reply; neutral when there is none.\n' +
    'Answer with JSON only: {"move": "<name or none>", "face": "<face>"}';
  let timer;
  const r = await Promise.race([
    generate(prompt),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
  const text = String(r?.content ?? r ?? '');
  let j = {};
  try { j = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] || '{}'); } catch {}
  const emote = emotes.find(e => e.name === String(j.move || '').trim())?.name || null;
  const mood = moods.includes(String(j.face || '').trim()) ? String(j.face).trim() : null;
  return { emote, mood };
}

const ASK_EVERY_MS = 8000;
let askedAt = 0;

/**
 * After a reply: move the body. `call` is AvatarX's agent API (avatarxCaller in avatarx.js); `generate` the model.
 * Returns { emote, mood } as applied, or null when nothing was done.
 */
export async function autoEmote({ userText, replyText, generate, call, agentName, now = Date.now() }) {
  if (!call || !generate || !emoteCouldFit(replyText)) return null;
  if (now - askedAt < ASK_EVERY_MS) return null;
  askedAt = now;
  const state = await call('GET', '/agent/v1/state');
  const emotes = emotesHeld([...(state.gestures || []), ...(state.animations || [])]);
  const moods = state.moods || [];
  const { emote, mood } = await chooseEmote({ generate, emotes, moods, userText, replyText, agentName });
  if (mood && mood !== state.mood) await call('PATCH', '/agent/v1/state', JSON.stringify({ mood }));
  if (emote) await call('POST', '/agent/v1/gesture', JSON.stringify({ name: emote }));
  if (!emote && (!mood || mood === state.mood)) return null;
  logger.info(`AvatarX: emote ${emote || 'none'}, face ${mood || state.mood}`);
  return { emote, mood: mood || state.mood };
}

/** Test hook. */
export function _resetEmoteClock() { askedAt = 0; }
