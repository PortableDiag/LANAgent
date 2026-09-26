/**
 * Codebase context for self-modification prompts.
 *
 * The generator used to see ONE file — the target — while its prompt told it to
 * "verify that method exists in the service" and "check existing functionality".
 * It could do neither, and the most common defect in its PRs was exactly that:
 * reading a field or calling a method that does not exist on the thing it imports
 * (2026-09-05 sweep: 6 of 20; 2026-09-25: most of 34). This module gives it the
 * facts to check against:
 *
 *   1. the real API of every in-repo module the target imports (exports, class
 *      methods, model statics/methods, schema field names);
 *   2. who imports the target, and with which names — so an export is not renamed
 *      or removed under a caller;
 *   3. for a Mongoose model, the code that WRITES the collection, with the fields it
 *      writes — so a new reader does not assume data nothing produces.
 *
 * Everything here is read-only and bounded; any failure yields less context, never
 * an exception into the generation path.
 */
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PER_MODULE_CHARS = 1800;
const DEFAULT_MAX_CHARS = 14000;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super', 'new', 'typeof', 'await']);

/**
 * Summarise the API surface of a JS source file: exports, class methods,
 * Mongoose statics/methods and top-level schema fields.
 * @param {string} src - File contents
 * @returns {string} One entry per line; '' when nothing recognisable
 */
export function extractApiSurface(src) {
  const out = [];
  const seen = new Set();
  const add = (line) => { if (!seen.has(line)) { seen.add(line); out.push(line); } };

  for (const m of src.matchAll(/^export\s+(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/gm)) {
    add(`export ${m[1] ? 'default ' : ''}function ${m[3] || '(anonymous)'}(${m[4].trim()})`);
  }
  for (const m of src.matchAll(/^export\s+(const|let)\s+([A-Za-z_$][\w$]*)/gm)) add(`export ${m[1]} ${m[2]}`);
  for (const m of src.matchAll(/^export\s+(default\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) add(`export ${m[1] ? 'default ' : ''}class ${m[2]}`);
  for (const m of src.matchAll(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) add(`export default ${m[1]}`);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) add(`export { ${m[1].replace(/\s+/g, ' ').trim()} }`);

  // Class methods (2- or 4-space indent, the repo's style).
  for (const m of src.matchAll(/^ {2,4}(static\s+)?(async\s+)?(get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    if (KEYWORDS.has(m[4])) continue;
    add(`  ${m[1] || ''}${m[2] || ''}${m[3] || ''}${m[4]}(${m[5].replace(/\s+/g, ' ').trim()})`);
  }

  // Mongoose statics / instance methods.
  for (const m of src.matchAll(/\.(statics|methods)\.([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?function\s*\(([^)]*)\)/g)) {
    add(`  ${m[1] === 'statics' ? 'static ' : 'method '}${m[2]}(${m[4].replace(/\s+/g, ' ').trim()})`);
  }

  // Schema fields: top-level keys of the first `new mongoose.Schema({` / `new Schema({`.
  const schemaAt = src.search(/new\s+(mongoose\.)?Schema\s*\(\s*\{/);
  if (schemaAt !== -1) {
    const fields = topLevelKeys(src, src.indexOf('{', schemaAt));
    if (fields.length) add(`  schema fields: ${fields.join(', ')}`);
  }

  return out.join('\n');
}

/**
 * Top-level keys of the object literal whose opening brace is at `openIdx`.
 * Brace-depth scan that skips strings and comments; returns [] if unbalanced.
 */
export function topLevelKeys(src, openIdx) {
  if (openIdx < 0 || src[openIdx] !== '{') return [];
  const keys = [];
  let depth = 0;
  let i = openIdx;
  let expectKey = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); if (i === -1) break; i += 2; continue; }
    // Key check first, so a quoted key ('amount': …) is not swallowed as a string.
    if (depth === 1 && expectKey && /[A-Za-z_$'"]/.test(c)) {
      const m = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*:/.exec(src.slice(i, i + 80));
      if (m) { keys.push(m[1]); i += m[0].length; expectKey = false; continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '{' || c === '[' || c === '(') { depth++; if (depth === 1) expectKey = true; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; if (depth === 0) return keys; continue; }
    if (depth === 1 && c === ',') { expectKey = true; i++; continue; }
    if (depth === 1 && !/\s/.test(c)) expectKey = false;
    i++;
  }
  return [];
}

/** Relative import specifiers in a source file (static and dynamic). */
export function relativeImports(src) {
  const specs = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+[^'";]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  return [...specs];
}

async function grepSrc(repoRoot, pattern, extraArgs = []) {
  try {
    const { stdout } = await execFileAsync(
      'grep', ['-rnE', '--include=*.js', ...extraArgs, pattern, 'src'],
      { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024, timeout: 15000 }
    );
    return stdout;
  } catch (err) {
    // grep exits 1 on "no match" — that is an answer, not a failure.
    return err?.code === 1 ? '' : '';
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the CODEBASE CONTEXT block for a generation prompt.
 * @param {Object} opts
 * @param {string} opts.repoRoot - Absolute path of the repo the generation edits
 * @param {string} opts.targetFile - Target path (absolute or repo-relative)
 * @param {string} opts.content - Current contents of the target
 * @param {number} [opts.maxChars] - Overall size cap
 * @returns {Promise<string>} The block, or '' if nothing could be gathered
 */
export async function buildCodeContext({ repoRoot, targetFile, content, maxChars = DEFAULT_MAX_CHARS }) {
  if (!repoRoot || !targetFile || typeof content !== 'string') return '';
  const targetAbs = path.isAbsolute(targetFile) ? targetFile : path.join(repoRoot, targetFile);
  const targetRel = path.relative(repoRoot, targetAbs);
  const sections = [];

  // 1. The real API of what the target imports.
  const apiParts = [];
  for (const spec of relativeImports(content)) {
    let abs = path.resolve(path.dirname(targetAbs), spec);
    if (!path.extname(abs)) abs += '.js';
    let src;
    try { src = await fs.readFile(abs, 'utf8'); } catch {
      apiParts.push(`${spec}: FILE DOES NOT EXIST — do not import it`);
      continue;
    }
    const surface = extractApiSurface(src).slice(0, PER_MODULE_CHARS);
    if (surface) apiParts.push(`${path.relative(repoRoot, abs)}:\n${surface}`);
  }
  if (apiParts.length) {
    sections.push('MODULES THIS FILE IMPORTS — their actual API. Call nothing on them that is not listed here or already used in CURRENT CODE:\n' + apiParts.join('\n\n'));
  }

  // 2. Who imports the target, and how.
  const base = path.basename(targetAbs, '.js');
  const importers = await grepSrc(repoRoot, `(from|import\\()\\s*['"][^'"]*/${escapeRe(base)}(\\.js)?['"]`);
  const importerLines = importers.split('\n').filter(Boolean)
    .filter(l => !l.startsWith(targetRel + ':'))
    .slice(0, 10)
    .map(l => '  ' + l.replace(/^([^:]+):\d+:\s*/, '$1: ').slice(0, 220));
  if (importerLines.length) {
    sections.push('FILES THAT IMPORT THIS ONE — every name they import must keep existing with the same behaviour:\n' + importerLines.join('\n'));
  }

  // 3. Models: where the collection is written.
  const modelName = /mongoose\.model\(\s*['"]([A-Za-z_$][\w$]*)['"]/.exec(content)?.[1];
  if (modelName && targetRel.startsWith(path.join('src', 'models'))) {
    const writes = await grepSrc(
      repoRoot,
      `\\b${escapeRe(modelName)}\\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|bulkWrite|replaceOne)\\b|new ${escapeRe(modelName)}\\(`,
      ['-A4']
    );
    const writeText = writes.split('\n')
      .filter(l => l && !l.startsWith(targetRel))
      .slice(0, 60)
      .map(l => '  ' + l.slice(0, 200))
      .join('\n');
    sections.push(writeText
      ? `WHERE ${modelName} DOCUMENTS ARE WRITTEN — the fields below are the ones production data actually has. Do not read fields nothing writes:\n${writeText}`
      : `NOTHING in src/ writes ${modelName} documents outside this file (no create/update/insert found). A new reader here would only ever see what this file writes — do not add analytics over fields nothing sets.`);
  }

  if (!sections.length) return '';
  let block = 'CODEBASE CONTEXT (read from the repository — this is ground truth):\n\n' + sections.join('\n\n');
  if (block.length > maxChars) block = block.slice(0, maxChars) + '\n  … (truncated)';
  return block;
}
