/**
 * A dance or a move asked for where the owner is LOOKING at the body (AvatarX, the live avatar page), read with no model.
 * The owner, 2026-11-24, by voice on AvatarX: "do the Roger Rabbit" took five turns and 12 to 60 s each, was answered with
 * a file list and "I have no Roger clip", and "try another" got a dance that was never played. Someone who asks a body on
 * screen to dance expects it to dance.
 */

/** Words as they compare: lower case, no punctuation, single spaces, padded. */
export const flatWords = (t) => ` ${String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** How long a move was asked for, in seconds, or null: "for 10 to 15 seconds" 15, "a minute" 60, "longer" 30. */
export function secondsAsked(text) {
  const t = String(text || '').toLowerCase();
  const n = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to|or)\s*(\d+(?:\.\d+)?))?\s*(seconds?|secs?|s|minutes?|mins?)\b/.exec(t);
  if (n) return Math.min(120, Math.max(1, Number(n[2] || n[1]) * (/^m/.test(n[3]) ? 60 : 1)));
  if (/\bhalf a minute\b/.test(t)) return 30;
  if (/\b(?:a )?(?:couple of|few|two) minutes\b/.test(t)) return 120;
  if (/\b(?:a|one) (?:full |whole )?minute\b/.test(t)) return 60;
  if (/\b(?:longer|keep (?:going|dancing|doing|it going)|don'?t stop|for a while|a long time|all night)\b/.test(t)) return 30;
  return null;
}

// Not a request to move now: another medium, another day, a story, a purchase.
const ELSEWHERE = /https?:|\b(?:videos?|film|record|gif|text|texts|email|e-mail|(?<!api )call|phone|post|tweet|send|remind|reminder|schedule|every|tomorrow|tonight|yesterday|later|last night|buy|bought|price|cost|music|song|youtube|playlist|remember|did you|were you|was it|story|poem|why|who)\b/i;
const VERB = '(?:do|doing|dance|dancing|perform|performing|play|playing|run|running|show|showing|start|starting|try|trying|hit|bust out|loop|looping|repeat|engage|trigger|see|give|keep)';

/**
 * What a message asks this body to do: { kind: 'named', label } | { kind: 'dance' } | { kind: 'another' } | { kind: 'again' }
 * | { kind: 'list' } | null, with `seconds` when a length was asked. `labels` are the moves it owns now, `recent` the last
 * move played here within a few minutes ({ label }), so "try another" and "again" mean something.
 */
export function moveRequest(text, { labels = [], recent = null } = {}) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 600 || ELSEWHERE.test(raw)) return null;
  const said = flatWords(raw);
  const seconds = secondsAsked(raw);
  const out = (o) => ({ ...o, ...(seconds ? { seconds } : {}) });
  if (/ (?:what|which|how many) (?:other |kind of |kinds of |sort of )?(?:dances?|moves|dance moves|animations) /.test(said) || / (?:list|name|tell me) (?:all )?(?:your|the|of your) (?:dances|moves|dance moves) /.test(said)
    || / what can you (?:dance|do as a dance) /.test(said)) return out({ kind: 'list' });
  if (/ do (?:you|i|we) (?:know|own|have|like) /.test(said) && !/ (?:can|could|please|show) /.test(said)) return null;
  const named = labels.map(l => ({ l, f: flatWords(l) })).filter(x => x.f.trim().length > 2 && said.includes(x.f))
    // A one-word name is also an ordinary word ("jump", "wave"): only right after its verb. "Dance" is any dance.
    .filter(x => x.f.trim().includes(' ') ? new RegExp(` ${VERB} `).test(said) || said.replace(x.f, ' ').trim().split(' ').filter(Boolean).length <= 3
      : x.f.trim() !== 'dance' && (said === x.f || new RegExp(` (?:do|perform|show|play|try|hit|bust out|give) (?:me |us )?(?:a |an |the |your |that |some )?${x.f.trim()} `).test(said)))
    .sort((a, b) => b.f.length - a.f.length)[0];
  if (named) return out({ kind: 'named', label: named.l });
  if (recent && raw.length < 160) {
    if (/ (?:another|a different|something else|different|the next|next)(?: one| dance| move)? $/.test(said) || / (?:try|do|show me|play|give me|how about) (?:another|a different|something else|one more|a new)(?: one| dance| move)? /.test(said)) return out({ kind: 'another' });
    if (/ (?:again|one more time|once more|repeat (?:it|that)|keep (?:going|dancing|doing (?:it|that))|longer|don t stop) /.test(said)) return out({ kind: 'again', ...(seconds ? {} : {}) });
  }
  // "can you dance", "dance for me", "do a dance", "they want me to dance", "let's see you dance", "show me some dances".
  if (/ danc(?:e|es|ing) /.test(said) && (/^ (?:ok |okay |hey |please |now |so |well |and |alice |yes )*(?:dance|do|show|give|start|bust|perform|let me see|let s see|i want|i d like|i would like|keep)\b/.test(said)
    || / (?:can|could|will|would) (?:you|i|she|it) .*danc/.test(said) || / (?:wants?|asked|asks|asking|like) (?:me|you|her|it|for) .*danc/.test(said))) return out({ kind: 'dance' });
  return null;
}
