/**
 * Partial-edit support for self-modification of files too large for a
 * whole-file rewrite.
 *
 * The whole-file upgrade path asks the model to return the COMPLETE modified
 * file, so any file bigger than the output cap can only ever come back
 * truncated. The v2.25.190 preflight correctly refuses those targets — but
 * refusing put ~34 files (including the five largest, most-improved-worth
 * files in the tree) permanently out of reach, and became the binding
 * constraint on self-modification (133 recorded refusals).
 *
 * This module provides the pieces of a path whose output scales with the
 * CHANGE, not the file:
 *
 *   1. buildFileOutline(content)      — structural map: every top-level
 *      construct and class method with its line range, built by a
 *      string/comment-aware brace scanner (never a full parser).
 *   2. extractRegions(content, ...)   — verbatim excerpts of chosen regions,
 *      merged and clamped.
 *   3. parseSearchReplaceBlocks(text) — parse the model's edit output.
 *   4. applySearchReplaceBlocks(...)  — splice the edits into the original
 *      locally, refusing ambiguous or unmatched edits with determinate,
 *      retryable error codes.
 *
 * The result is a full before/after pair, so the existing import remediation,
 * validation, and PR pipeline run unchanged downstream.
 *
 * Everything here is pure (content in, data out) and throws coded errors —
 * error.code is one of NO_BLOCKS, UNTERMINATED_BLOCK, EMPTY_SEARCH,
 * SEARCH_NOT_FOUND, SEARCH_AMBIGUOUS, NO_EFFECT — so the caller's retry loop
 * can feed the model a precise correction instead of a stack trace.
 */

const OUTLINE_SIGNATURE_MAX = 110;

/** Marker lines for the model's edit format. */
export const SEARCH_MARKER = '<<<<<<< SEARCH';
export const DIVIDER_MARKER = '=======';
export const REPLACE_MARKER = '>>>>>>> REPLACE';

function codedError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/**
 * Character-level scan that reports, for each line, the brace depth at the
 * START of that line — aware of ', ", ` strings (with escapes and template
 * interpolation), // and multi-line comments, and regex literals (the
 * standard prev-significant-char heuristic, with character classes).
 *
 * Sets .balanced=false on the result if the file does not return to depth 0,
 * which callers must treat as "outline untrustworthy".
 */
export function scanLineDepths(content) {
  const depths = [];
  let depth = 0;
  let state = 'code'; // code | line-comment | block-comment | single | double | template | regex | regex-class
  const templateBraceStack = []; // depth of ${ nesting inside template literals
  let prevSignificant = ''; // last non-space, non-comment char seen in code state
  let lineStartDepth = 0;

  depths.push(0); // depth at start of line 1
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '\n') {
      if (state === 'line-comment') state = 'code';
      lineStartDepth = depth;
      depths.push(lineStartDepth);
      continue;
    }

    switch (state) {
      case 'line-comment':
        break;
      case 'block-comment':
        if (ch === '*' && next === '/') { state = 'code'; i++; }
        break;
      case 'single':
        if (ch === '\\') i++;
        else if (ch === "'") state = 'code';
        break;
      case 'double':
        if (ch === '\\') i++;
        else if (ch === '"') state = 'code';
        break;
      case 'template':
        if (ch === '\\') i++;
        else if (ch === '`') state = 'code';
        else if (ch === '$' && next === '{') {
          templateBraceStack.push(depth);
          depth++;
          state = 'code';
          i++;
        }
        break;
      case 'regex':
        if (ch === '\\') i++;
        else if (ch === '[') state = 'regex-class';
        else if (ch === '/') state = 'code';
        break;
      case 'regex-class':
        if (ch === '\\') i++;
        else if (ch === ']') state = 'regex';
        break;
      case 'code':
      default:
        if (ch === '/' && next === '/') { state = 'line-comment'; i++; }
        else if (ch === '/' && next === '*') { state = 'block-comment'; i++; }
        else if (ch === "'") { state = 'single'; prevSignificant = ch; }
        else if (ch === '"') { state = 'double'; prevSignificant = ch; }
        else if (ch === '`') { state = 'template'; prevSignificant = ch; }
        else if (ch === '/') {
          // Regex vs division: a regex can only start where an expression can.
          if (prevSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prevSignificant) ||
              /\b(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/.test(lastWord(content, i))) {
            state = 'regex';
          }
          prevSignificant = ch;
        }
        else if (ch === '{') { depth++; prevSignificant = ch; }
        else if (ch === '}') {
          if (templateBraceStack.length > 0 && depth - 1 === templateBraceStack[templateBraceStack.length - 1]) {
            templateBraceStack.pop();
            depth--;
            state = 'template';
          } else {
            depth = Math.max(0, depth - 1);
          }
          prevSignificant = ch;
        }
        else if (!/\s/.test(ch)) prevSignificant = ch;
        break;
    }
  }

  return { depths, balanced: depth === 0 && state !== 'block-comment' };
}

function lastWord(content, idx) {
  let end = idx;
  while (end > 0 && /\s/.test(content[end - 1])) end--;
  let start = end;
  while (start > 0 && /[A-Za-z]/.test(content[start - 1])) start--;
  return content.slice(start, end);
}

const TOP_LEVEL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(function|class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;
const METHOD_RE = /^\s{2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*\(/;
const METHOD_KEYWORD_BLOCKLIST = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor']);

/**
 * Build a structural outline: top-level constructs plus the methods of
 * top-level classes, each with a 1-based [startLine, endLine].
 *
 * Returns { entries, balanced }. When balanced is false the depth scan
 * desynced (pathological string/regex content) and entries must not be
 * trusted for excerpt extraction.
 */
export function buildFileOutline(content) {
  const lines = content.split('\n');
  const { depths, balanced } = scanLineDepths(content);
  const entries = [];

  let openClass = null; // { entry, bodyDepth }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const depth = depths[i] ?? 0;

    if (openClass && depth <= openClass.startDepth && i > openClass.entry.startLine - 1) {
      openClass.entry.endLine = i; // line i (1-based i) is the closing brace line or first line after
      openClass = null;
    }

    if (depth === 0) {
      const m = line.match(TOP_LEVEL_RE);
      if (m) {
        const kind = m[1] || 'const';
        const name = m[2] || m[3];
        const entry = {
          name,
          kind,
          startLine: i + 1,
          endLine: i + 1, // fixed up below
          signature: line.trim().slice(0, OUTLINE_SIGNATURE_MAX)
        };
        entries.push(entry);
        if (kind === 'class') openClass = { entry, startDepth: depth };
      }
    } else if (openClass && depth === 1) {
      const m = line.match(METHOD_RE);
      if (m && !METHOD_KEYWORD_BLOCKLIST.has(m[1])) {
        entries.push({
          name: `${openClass.entry.name}.${m[1]}`,
          kind: 'method',
          startLine: i + 1,
          endLine: i + 1,
          signature: line.trim().slice(0, OUTLINE_SIGNATURE_MAX)
        });
      }
    }
  }

  // End lines: each entry runs to the line before the next entry at the same
  // or shallower nesting; classes already got a real end. This is coarse but
  // only feeds excerpt WINDOWS, whose safety comes from the exact-match
  // apply step, not from outline precision.
  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e];
    if (entry.kind === 'class' && entry.endLine > entry.startLine) continue;
    let end = lines.length;
    for (let n = e + 1; n < entries.length; n++) {
      const isMethod = entry.kind === 'method';
      const nextIsSibling = isMethod
        ? true // next entry of any kind bounds a method
        : entries[n].kind !== 'method'; // top-level bounded by next top-level
      if (entries[n].startLine > entry.startLine && nextIsSibling) {
        end = entries[n].startLine - 1;
        break;
      }
    }
    entry.endLine = Math.max(entry.startLine, end);
  }

  return { entries, balanced };
}

/**
 * Render an outline as compact prompt text, one construct per line.
 */
export function renderOutline(entries) {
  return entries
    .map(e => `${String(e.startLine).padStart(6)}-${String(e.endLine).padEnd(6)} ${e.kind.padEnd(8)} ${e.name} :: ${e.signature}`)
    .join('\n');
}

/**
 * Merge requested 1-based line ranges (with context), clamp to the file, and
 * return excerpt sections. Ranges that overlap after context expansion are
 * merged so no line appears twice.
 *
 * @returns {Array<{startLine:number,endLine:number,text:string}>}
 */
export function extractRegions(content, ranges, { contextLines = 6, maxTotalLines = 700 } = {}) {
  const lines = content.split('\n');
  const expanded = ranges
    .map(r => ({
      start: Math.max(1, Math.floor(r.startLine) - contextLines),
      end: Math.min(lines.length, Math.ceil(r.endLine) + contextLines)
    }))
    .filter(r => r.end >= r.start)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const r of expanded) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  // Clamp total size, largest-first trim: drop trailing regions once over
  // budget rather than silently truncating one mid-region (a half-shown
  // region invites SEARCH text the file doesn't contain).
  const kept = [];
  let total = 0;
  for (const r of merged) {
    const size = r.end - r.start + 1;
    if (total + size > maxTotalLines && kept.length > 0) break;
    kept.push(r);
    total += size;
  }

  return kept.map(r => ({
    startLine: r.start,
    endLine: r.end,
    text: lines.slice(r.start - 1, r.end).join('\n')
  }));
}

/**
 * Parse SEARCH/REPLACE blocks out of a model response. Tolerates markdown
 * fences and prose around the blocks; the markers themselves must be exact
 * and line-anchored.
 *
 * @returns {Array<{search:string,replace:string}>}
 */
export function parseSearchReplaceBlocks(text) {
  if (!text || typeof text !== 'string') {
    throw codedError('NO_BLOCKS', 'empty response');
  }
  const lines = text.split('\n');
  const blocks = [];
  let mode = 'outside'; // outside | search | replace
  let search = [];
  let replace = [];

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === SEARCH_MARKER) {
      if (mode !== 'outside') throw codedError('UNTERMINATED_BLOCK', 'new SEARCH before previous block closed');
      mode = 'search';
      search = [];
      replace = [];
    } else if (mode === 'search' && line.trim() === DIVIDER_MARKER) {
      mode = 'replace';
    } else if (mode === 'replace' && line.trim() === REPLACE_MARKER) {
      blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
      mode = 'outside';
    } else if (mode === 'search') {
      search.push(line);
    } else if (mode === 'replace') {
      replace.push(line);
    }
    // outside: prose/fences, ignored
  }

  if (mode !== 'outside') {
    throw codedError('UNTERMINATED_BLOCK', `block still open at end of response (in ${mode} section)`);
  }
  if (blocks.length === 0) {
    throw codedError('NO_BLOCKS', 'no SEARCH/REPLACE blocks found in response');
  }
  return blocks;
}

/**
 * Count occurrences of `needle` in `haystack` (non-overlapping).
 */
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length || 1;
  }
  return count;
}

/**
 * Fallback matcher: find `search` in `content` comparing line-by-line with
 * trailing whitespace stripped. Returns the exact substring of `content`
 * that corresponds, or null; 'ambiguous' if it matches more than once.
 */
function findWhitespaceTolerant(content, search) {
  const norm = s => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
  const contentLines = content.split('\n');
  const searchNorm = norm(search);
  const searchLineCount = search.split('\n').length;

  let found = null;
  let count = 0;
  for (let i = 0; i + searchLineCount <= contentLines.length; i++) {
    const windowText = contentLines.slice(i, i + searchLineCount).join('\n');
    if (norm(windowText) === searchNorm) {
      count++;
      if (count > 1) return 'ambiguous';
      found = windowText;
    }
  }
  return found;
}

/**
 * Apply parsed blocks to `content` sequentially. Every SEARCH must match the
 * evolving content exactly once (exact match first, then a trailing-
 * whitespace-tolerant retry). Throws coded errors naming the failing block
 * so a retry prompt can quote it back to the model.
 *
 * @returns {{code:string, applied:number}}
 */
export function applySearchReplaceBlocks(content, blocks) {
  let code = content;
  let applied = 0;

  for (let b = 0; b < blocks.length; b++) {
    const { search, replace } = blocks[b];
    const label = `block ${b + 1}/${blocks.length}`;

    if (!search.trim()) {
      throw codedError('EMPTY_SEARCH',
        `${label} has an empty SEARCH section - additions must anchor on existing lines (include the lines the new code goes after)`);
    }
    if (search === replace) continue; // no-op block; tolerated, not counted

    let effectiveSearch = search;
    let occurrences = countOccurrences(code, effectiveSearch);

    if (occurrences === 0) {
      const tolerant = findWhitespaceTolerant(code, search);
      if (tolerant === 'ambiguous') {
        throw codedError('SEARCH_AMBIGUOUS',
          `${label} SEARCH matches more than one place - include more surrounding lines to make it unique. SEARCH began: ${firstLines(search)}`);
      }
      if (tolerant === null) {
        throw codedError('SEARCH_NOT_FOUND',
          `${label} SEARCH text not found in the file - it must be copied EXACTLY from the excerpts. SEARCH began: ${firstLines(search)}`);
      }
      effectiveSearch = tolerant;
      occurrences = countOccurrences(code, effectiveSearch);
    }
    if (occurrences > 1) {
      throw codedError('SEARCH_AMBIGUOUS',
        `${label} SEARCH matches ${occurrences} places - include more surrounding lines to make it unique. SEARCH began: ${firstLines(search)}`);
    }

    code = code.replace(effectiveSearch, () => replace);
    applied++;
  }

  if (applied === 0) {
    throw codedError('NO_EFFECT', 'every block was a no-op (SEARCH identical to REPLACE)');
  }
  return { code, applied };
}

function firstLines(text, n = 2) {
  return JSON.stringify(text.split('\n').slice(0, n).join('\\n').slice(0, 120));
}

/**
 * The head of the file (imports and module prologue) is always worth showing
 * the editor: nearly any change needs to add or check an import. Runs from
 * line 1 through the last top-of-file import, plus a little, capped.
 */
export function headRegion(content, { maxLines = 60 } = {}) {
  const lines = content.split('\n');
  let lastImport = 0;
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    if (/^\s*import\b|^\s*const\s+\w+\s*=\s*require\(/.test(lines[i])) lastImport = i + 1;
  }
  const end = Math.min(lines.length, Math.max(lastImport + 5, 20), maxLines);
  return { startLine: 1, endLine: end };
}
