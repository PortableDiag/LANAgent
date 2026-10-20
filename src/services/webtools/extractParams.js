import { safeJsonParse } from '../../utils/jsonUtils.js';
import { logger } from '../../utils/logger.js';

/**
 * Last-resort patterns for when the model cannot be reached or answers with something that
 * is not JSON. Keyed by the real `plugin.action`; each pattern's first capture is the value
 * of `param`. Only actions whose request reliably names one value belong here: a pattern
 * that guesses wrong is worse than handing the plugin the whole request.
 */
const FALLBACK_PATTERNS = {
  'maps.timezone': {
    param: 'place',
    patterns: [
      /\bwhat(?:'s| is) the (?:local )?time in (.+)/i,
      /\bwhat time is it in (.+)/i,
      /\b(?:current|local) time in (.+)/i,
      /\bwhat time zone is (.+?) in\b/i
    ]
  }
};

// Trailing filler that is not part of a place name ("Tokyo right now?").
const TRAILING_FILLER = /(?:\s+(?:right now|now|today|currently|please))+\s*$/i;

/**
 * The fallback value for an action, or null when no pattern applies.
 * @param {string} key - `plugin.action`
 * @param {string} input - the whole request
 * @returns {Object|null}
 */
export function fallbackExtract(key, input) {
  const spec = FALLBACK_PATTERNS[key];
  if (!spec) return null;
  for (const re of spec.patterns) {
    const m = String(input).match(re);
    if (!m) continue;
    const value = m[1].replace(/[?.!,\s]+$/, '').replace(TRAILING_FILLER, '').replace(/[?.!,\s]+$/, '').trim();
    if (value) return { [spec.param]: value };
  }
  return null;
}

/**
 * Parameters from a plain-language request, for plugins reached by AI intent detection.
 *
 * When intent detection picks a plugin action but not its arguments, the plugin receives
 * `{ query: <the whole request>, needsParameterExtraction: true, originalInput }` and has to
 * work the arguments out itself. Without this, "what time is it in Tokyo right now" reached
 * maps.timezone as a place name and found nothing (ALICE, 2026-09-26). The command's own
 * `usage` line tells the model which names to use.
 */
export async function extractParams(plugin, action, params = {}) {
  const input = String(params.originalInput || params.input || '').trim();
  const queryIsWholeRequest = input && typeof params.query === 'string' && params.query.trim() === input;
  if (!input || !(params.needsParameterExtraction || queryIsWholeRequest)) return params;
  const pm = plugin.agent?.providerManager;
  const cmd = (plugin.commands || []).find(c => c.command === action);
  if (!pm || !cmd) return params;

  const { needsParameterExtraction, originalInput, input: _i, fromAI, _context, ...rest } = params;
  if (queryIsWholeRequest) delete rest.query;

  const prompt = `Extract the arguments for the ${plugin.name}.${action} action from this request.
Request: "${input}"
Action: ${cmd.description}
Call shape: ${cmd.usage}
Return ONLY a JSON object using the parameter names from the call shape, with only the values the request actually gives (numbers as numbers, lists as arrays). Strip command words: for "what time is it in Tokyo" the place is "Tokyo". Omit anything not stated.`;
  try {
    const gen = pm.generateAux ? pm.generateAux.bind(pm) : pm.generateResponse.bind(pm);
    const res = await gen(prompt, { maxTokens: 800, temperature: 0 });
    const extracted = safeJsonParse(String(res?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, ''), null);
    if (extracted && typeof extracted === 'object' && !Array.isArray(extracted)) {
      logger.info(`${plugin.name}.${action} parameters from the request: ${JSON.stringify(extracted).slice(0, 300)}`);
      return { ...rest, ...extracted, originalInput: input };
    }
  } catch (err) {
    logger.warn(`${plugin.name}.${action} parameter extraction failed: ${err.message}`);
  }
  const fallback = fallbackExtract(`${plugin.name}.${action}`, input);
  if (fallback) {
    logger.info(`${plugin.name}.${action} parameters by pattern fallback: ${JSON.stringify(fallback).slice(0, 300)}`);
    return { ...rest, ...fallback, originalInput: input };
  }
  // Extraction failed: hand the plugin the whole request, as before.
  return params;
}

/**
 * True when a request asks for ongoing watching rather than a one-off look ("watch this feed",
 * "alert me when it drops below 200"). Vector matching ranks the read/check action above the
 * watch action for such requests (feeds.read 0.652 for "watch the Node.js blog feed …",
 * 2026-09-26), so the plugins check the words themselves before doing a one-off read.
 */
export function asksToWatch(input) {
  const t = String(input || '').toLowerCase();
  if (/\b(am i|are we|i'm|i am)\s+(watching|tracking|following|monitoring)\b/.test(t)) return false;
  return /\b(watch|monitor|follow|track|subscribe to|keep an eye on|alert me|notify me|tell me when|let me know when|ping me when)\b/.test(t);
}
