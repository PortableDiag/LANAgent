/**
 * What an agent does with its Bots & Borgs library without being asked (the owner, 2026-11-05: buying is pointless
 * if it only uses things on request). A sticker or emoji follows a reply to the owner when it fits, and a wallpaper
 * sits behind the dashboard and the 3D viewer. Nothing here reaches a contact, and a model picks only among moods
 * the library really holds.
 */

// Unasked, only light feelings are on offer. In replay a model told "never for grief" still chose a crying sticker
// for "my dog died" and "lol" for "the cake made me sick"; one that isn't offered can't be sent. All stay usable on request.
const NOT_UNASKED = /sad|cry|tear|angry|worried|nervous|scream|shock|dizzy|meh|confused|questioning|awkward|error|glitch|lowbatt|bug|loading|money|surprised/i;

/** Light sticker and emoji files grouped by the feeling they show: [{ mood, picks: [{ item, file }] }]. */
export function moodChoices(items = []) {
  const byMood = new Map();
  for (const item of items) {
    for (const file of item.files || []) {
      if (!['sticker', 'emoji'].includes(file.kind) || !file.mood || NOT_UNASKED.test(file.mood)) continue;
      if (!byMood.has(file.mood)) byMood.set(file.mood, []);
      byMood.get(file.mood).push({ item, file });
    }
  }
  return [...byMood].map(([mood, picks]) => ({ mood, picks }));
}

/** Replies a sticker would only cheapen: code, long reports. */
export function stickerCouldFit(replyText) {
  const reply = String(replyText || '').trim();
  return !!reply && reply.length <= 1200 && !reply.includes('```');
}

/**
 * The choice that suits this exchange, or null. A slow or failed model means no sticker, never a late one.
 */
export async function chooseSticker({ generate, choices, userText, replyText, agentName = 'The assistant', timeoutMs = 12000 }) {
  if (!choices?.length || !stickerCouldFit(replyText)) return null;
  const prompt = `${agentName} is chatting with its owner and has just replied. Decide whether a sticker follows the reply, the way a friend adds one.\n\n` +
    'Send one for: thanks, compliments, hello and goodbye, good night, a joke or laughter, good news, relief such as feeling better, playful chat.\n' +
    'Never send one for: death, grief, illness or pain, anything upsetting or worrying, plain facts, data, instructions, errors, or a task just done.\n\n' +
    `Owner: ${String(userText || '').slice(0, 500)}\n${agentName}: ${String(replyText).slice(0, 800)}\n\nStickers by feeling:\n` +
    `${choices.map((c, n) => `${n + 1}. ${c.mood}`).join('\n')}\n\nAnswer with one number, or 0 for no sticker.`;
  let timer;
  const r = await Promise.race([
    generate(prompt),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
  const n = Number(/\d+/.exec(String(r?.content ?? r ?? ''))?.[0]);
  return n >= 1 ? choices[n - 1] || null : null;
}

/** One wallpaper of a format, changing daily. Files with no stated format count for either. */
export function wallpaperFor(items = [], { format = 'desktop', now = new Date() } = {}) {
  const pool = items.flatMap(item => (item.files || [])
    .filter(f => f.kind === 'wallpaper' && (!f.format || f.format === format))
    .map(file => ({ item, file })));
  if (!pool.length) return null;
  return pool[Math.floor(now.getTime() / 86400000) % pool.length];
}
