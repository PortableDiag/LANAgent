/**
 * Shared filters for auto-post content across all social platforms (MindSwarm, Telegram, X).
 * Prevents the agent from posting about sensitive internal topics.
 */

// Commit messages matching these patterns are excluded from auto-post context.
// `session` covers docs/sessions/* commits — the pathspec excludes pure-session
// commits, but a commit touching both src/ AND docs/sessions/ slips through
// the pathspec since git log still shows it. Defense in depth.
//
// CRYPTO-TRADING terms (2026-06-19): the agent's own trading positions, token picks,
// and watchlist are PRIVATE — publicly announcing them invites front-running / dumps.
// A `feat(crypto): … add CAKE fallback` commit subject leaked the operator's token pick
// to social before this was added (the subject had no `strategy`/`revenue` keyword to
// catch it). `crypto` matches the conventional-commit scope `feat(crypto)`/`fix(crypto)`
// used by the trading subsystem; the rest catch trading mechanics by name. Erring toward
// over-exclusion here is intentional — a missed crypto-service announcement is cheap, a
// leaked trading pick is not.
// 2026-08-02: a second class of trading commit was found slipping through — six
// subjects from two days of work survived the filter, including
// `enable cross-DEX arbitrage (SKYNET excluded, $10 cap)` and
// `tranche-scalp profit gate uses lot basis`. Neither the conventional-commit
// `crypto` scope nor any listed mechanic appeared in them, yet both describe live
// trading configuration. Arbitrage/tranche/scalp terms and trade-sizing language
// are now covered explicitly. Same reasoning as above: over-exclusion is cheap.
// 2026-08-03: the session-report guard only matched `session` followed by a DATE, or
// the conventional-commit form `docs(session)`. A subject reading `docs: session report
// part 2 …` matched neither and passed straight through — as did `session summary` and
// `session handoff`. Session reports are private dev notes that must never reach a
// public post, so the undated phrasings are now covered. Deliberately NOT a blanket
// /session/: this product has real user-session and session-timeout commits that must
// still be postable, so only the report-ish suffixes and `handoff`/`wrap-up` match.
const SENSITIVE_COMMIT_PATTERNS = /outreach|proposal|business.plan|linkedin|strategy|monetiz|revenue|pricing|release.plan|contact.email|partner|investor|funding|pitch|competitive|roadmap|session.*\d{4}-\d{2}-\d{2}|docs\(session|session.?(report|summary|notes|wrap|handoff|recap|log)|\bhandoff\b|wrap.?up|crypto|token.?trad|watchlist|dollar.?max|native.?max|realized.?pnl|circuit.?break|grid.?buy|scale.?out|trailing.?stop|dump.?threshold|capital.?alloc|arbitrag|arb.?sig|arb.?scan|arbsignal|cross.?dex|max.?trade|trade.?cap|trade.?size|tranche|scalp|lot.?basis|profit.?gate|spread.?percent|min.?profit|take.?profit|stop.?loss|entry.?anchor|sell.?anchor|avg.?entry|average.?entry|cost.?basis|baseline.?reset|idle.?easing|price.?impact|slippage|cow.?swap|cowswap|\bcow\b|\bdex\b|\bswap|\bv[234]\b(?![.\d])|uniswap|pancake|1inch|permit2|order.?book|liquidity|mev|front.?run|quoter|routing|regime|heartbeat.?tick|position.?ledger|\bdm\b|\btt\b/i;
// NOTE on `\bv[234]\b` above: the negative lookahead `(?![.\d])` is load-bearing.
// It was added to catch DEX protocol versions ("V3 routing", "uniswap v4"), but a bare
// \bv[234]\b also matches the leading `v2` of every `v2.25.x` RELEASE version, because
// `.` ends a word. Every versioned commit subject in this repo — i.e. nearly all of
// them — was therefore being discarded before the composer ever saw it. That fails
// safe (it over-blocks rather than leaks) which is exactly why it went unnoticed: the
// symptom is a composer with no material, not a bad post. Verified 2026-08-04 by
// running the deployed filter over the day's own subjects.

// Git paths excluded from commit context gathering (pathspecs for git log)
const EXCLUDED_GIT_PATHS = [':!docs/proposals', ':!docs/sessions'];

// Topics that must never appear in auto-post output
const SENSITIVE_OUTPUT_RULES = [
  'NEVER post about business plans, outreach campaigns, partnership proposals, monetization strategy, LinkedIn posts, release strategy, or anything from internal proposals or documentation.',
  'NEVER mention contacting companies (Google, Anthropic, OpenAI, etc.) or any outreach/partnership activity.',
  'Never discuss investor relations, funding plans, competitive analysis, or internal roadmaps.',
  'Never discuss business plans, outreach campaigns, partnership proposals, monetization strategy, release plans, or any content from internal proposals or documentation.',
  'NEVER mention internal development sessions, session reports, session wrap-ups, debug sessions, or anything about your operator\'s workflow — those are private dev notes, not public-facing content.',
  'NEVER post about crypto TRADING activity — specific token picks, the active/secondary trading token, watchlist tokens, buy/sell/grid trades, positions, PnL, allocations, or the trading strategies. These are private trading operations; announcing them invites front-running. (Promoting the operator\'s OWN published token or generic paid crypto SERVICES is fine; live trading positions/picks are not.)',
];

// Openers that the AI keeps producing despite being told not to.
// Used by isBadOpener() to hard-reject candidate posts and trigger retry.
const BANNED_OPENERS = [
  /^just\b/i,
  /^i ?just\b/i,
  /^excited\b/i,
  /^been\b/i,
  /^thrilled\b/i,
  /^happy to\b/i,
  /^proud to\b/i,
  // "I'm now…" / "Now offering…" / "Operating with…" / "Operated with…" —
  // these are the exact templates that produced the 10-day repetition loop
  // 2026-05-27 → 06-05 (confirmed in the auto-post audit).
  /^i'?m now\b/i,
  /^now offering\b/i,
  /^operating with\b/i,
  /^operated with\b/i,
];

/**
 * @param {string} text — candidate post text
 * @returns {string|null} — null if opener is fine, the offending pattern if bad
 */
function isBadOpener(text) {
  if (!text) return null;
  const trimmed = String(text).trim().replace(/^["']/, '');
  for (const re of BANNED_OPENERS) {
    if (re.test(trimmed)) return re.source;
  }
  return null;
}

/**
 * Lossy normalization for n-gram overlap detection.
 * Drops case, punctuation, runs of whitespace, hashtags, and emoji.
 */
function _normalizeForOverlap(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')           // URLs
    .replace(/#[\w]+/g, '')                    // hashtags (the agent rotates these)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')         // strip punctuation/emoji
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract overlapping n-grams from a normalized string.
 * @param {string} s
 * @param {number} n
 * @returns {Set<string>}
 */
function _ngrams(s, n) {
  const words = _normalizeForOverlap(s).split(' ').filter(Boolean);
  const out = new Set();
  if (words.length < n) return out;
  for (let i = 0; i <= words.length - n; i++) {
    out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}

/**
 * Hard repetition check: does the candidate share a long n-gram (default
 * 4 words) with ANY recent post? Catches the case where the AI rephrases
 * lightly but keeps the same distinctive phrase ("scammer addresses on-chain
 * with soulbound badges", "decentralized service marketplace", etc).
 *
 * @param {string} candidate — proposed post text
 * @param {string[]} recentPosts — last N actual post contents
 * @param {object} [opts]
 * @param {number} [opts.n=4] — n-gram size
 * @param {number} [opts.maxOverlap=0] — fail if any post shares > this many n-grams
 * @returns {{ ok: boolean, conflict: string|null, sharedNgrams: string[] }}
 */
function repetitionConflict(candidate, recentPosts, opts = {}) {
  const n = opts.n ?? 4;
  const maxOverlap = opts.maxOverlap ?? 0;
  if (!candidate || !Array.isArray(recentPosts) || recentPosts.length === 0) {
    return { ok: true, conflict: null, sharedNgrams: [] };
  }
  const candGrams = _ngrams(candidate, n);
  if (candGrams.size === 0) return { ok: true, conflict: null, sharedNgrams: [] };
  for (const prior of recentPosts) {
    const priorGrams = _ngrams(prior, n);
    const shared = [];
    for (const g of candGrams) {
      if (priorGrams.has(g)) shared.push(g);
      if (shared.length > maxOverlap) break;
    }
    if (shared.length > maxOverlap) {
      return { ok: false, conflict: String(prior).slice(0, 160), sharedNgrams: shared };
    }
  }
  return { ok: true, conflict: null, sharedNgrams: [] };
}

/**
 * Grounding check: does the candidate quote AT LEAST ONE concrete fact from
 * the items the AI was given? Numeric tokens, capitalized multi-word names,
 * and quoted strings from items all count. Catches hallucinations like
 * "Reasoning across 6 AI providers (..., Gab, ...)" when no item mentioned
 * "Gab" or "6 providers".
 *
 * @param {string} candidate
 * @param {string[]} itemTexts — the raw item strings shown to the AI
 * @returns {{ ok: boolean, anchor: string|null }}
 */
function groundingAnchor(candidate, itemTexts) {
  if (!candidate || !Array.isArray(itemTexts) || itemTexts.length === 0) {
    return { ok: false, anchor: null };
  }
  // Concrete anchors per item: integers, decimals, percentages, capitalized
  // multi-word phrases ("SKYNET decentralized marketplace"), and acronyms.
  const candLower = candidate.toLowerCase();
  for (const item of itemTexts) {
    // Numeric tokens — straight digits, optionally with decimal/comma/percent
    const numbers = (item.match(/\b\d[\d,]*(?:\.\d+)?%?\b/g) || []);
    for (const num of numbers) {
      if (candidate.includes(num)) return { ok: true, anchor: num };
    }
    // Distinctive single-word tokens (length >= 5, uppercase or lowercase)
    // that aren't trivially common English. Avoids matching "the" / "and".
    const words = item.split(/\W+/).filter(w => w.length >= 5);
    for (const w of words) {
      if (/^(today|hours|hours\b|recent|across|while|world|using|level)$/i.test(w)) continue;
      if (candLower.includes(w.toLowerCase())) return { ok: true, anchor: w };
    }
  }
  return { ok: false, anchor: null };
}

/**
 * Filter commit messages to remove sensitive topics.
 * @param {string[]} commits - Array of commit message strings
 * @returns {string[]} Filtered commits safe for public posting
 */
function filterSensitiveCommits(commits) {
  return commits.filter(c => !SENSITIVE_COMMIT_PATTERNS.test(c));
}

/**
 * Get git pathspec exclusions for auto-post context gathering.
 * @returns {string} Pathspec string to append to git log commands
 */
function getExcludedPathspecs() {
  return EXCLUDED_GIT_PATHS.map(p => `'${p}'`).join(' ');
}

/**
 * Get prompt rules that prevent sensitive content in AI-generated posts.
 * @returns {string} Rules to include in any auto-post AI prompt
 */
function getSensitiveContentRules() {
  return SENSITIVE_OUTPUT_RULES.map(r => `- ${r}`).join('\n');
}

export {
  filterSensitiveCommits, getExcludedPathspecs, getSensitiveContentRules,
  isBadOpener, repetitionConflict, groundingAnchor,
  SENSITIVE_COMMIT_PATTERNS, EXCLUDED_GIT_PATHS, SENSITIVE_OUTPUT_RULES, BANNED_OPENERS
};
