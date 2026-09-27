/**
 * Parameters a PAID EXTERNAL caller may pass to a plugin (POST /api/external/service/:plugin/:action).
 *
 * The route used to hand req.body to the plugin as-is: `execute({ action, ...body })`. That let
 * a body `action` replace the one in the path (past BLOCKED_ACTIONS), let `_`-prefixed internal
 * fields and local paths through (aiDetector read or deleted any host file; ffmpeg read and wrote
 * any path), let any URL be fetched from the agent's LAN, and put unchecked values into shell
 * strings in ytdlp and ffmpeg. Reported by TrellisWebAgent, card 2754 #162 (2026-09-26).
 *
 * Rules:
 *   - the action always comes from the path; `action` and every `_…` key in the body are dropped;
 *   - keys that name a local file, directory, proxy or cookie jar are dropped;
 *   - every URL-looking field must be http(s) to a public address;
 *   - shell-backed plugins get a per-action allowlist with typed values;
 *   - huggingface `model` must look like `owner/name`.
 */
import { assertPublicUrl } from '../../utils/publicUrl.js';

const LOCAL_KEYS = new Set([
  'path', 'filepath', 'file_path', 'filePath', 'file', 'files', 'inputpath', 'inputPath', 'input_path',
  'outputpath', 'outputPath', 'output_path', 'output', 'outputDir', 'outputdir', 'outputFile', 'dir',
  'directory', 'cwd', 'dest', 'destination', 'savePath', 'tempPath', 'tmpPath', 'cookies', 'cookie',
  'cookieFile', 'cookiesFile', 'proxy', 'executable', 'bin', 'binary', 'command', 'cmd', 'args', 'argv',
  'env', 'shell'
]);
const URL_KEYS = new Set(['url', 'imageUrl', 'image_url', 'videoUrl', 'video_url', 'audioUrl', 'audio_url',
  'fileUrl', 'file_url', 'link']);
// Sometimes a URL, sometimes a plain word (a news "source"): checked when it carries a scheme.
const MAYBE_URL_KEYS = new Set(['source', 'src', 'image', 'feed']);
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Characters that mean something to a shell. Refused in free text for shell-backed plugins.
const SHELL_META = /[`$;|&<>\\\n\r"']/;

const str = (max = 500) => (v) => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error('must be text');
  const s = String(v);
  if (s.length > max) throw new Error(`is longer than ${max} characters`);
  if (SHELL_META.test(s)) throw new Error('contains characters that are not allowed');
  return s;
};
const int = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`must be a whole number from ${min} to ${max}`);
  return n;
};
const pattern = (re, what) => (v) => {
  const s = String(v ?? '');
  if (!re.test(s)) throw new Error(`must be ${what}`);
  return s;
};
const url = async (v, key) => assertPublicUrl(v, key);

/** ytdlp builds shell commands: only these fields, per action. */
const SHELL_PLUGIN_SCHEMAS = {
  ytdlp: {
    info: { url },
    formats: { url },
    download: { url, format: pattern(/^[\w+\-/]{1,40}$/, 'a format id'), quality: pattern(/^[\w-]{1,20}$/, 'a quality name') },
    audio: { url, format: pattern(/^[a-z0-9]{2,6}$/, 'an audio format'), quality: pattern(/^[\w-]{1,20}$/, 'a quality name') },
    search: { query: str(200), limit: int(1, 25) },
    playlist: { url, limit: int(1, 50) },
    transcribe: { url, lang: pattern(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'a language code like en or pt-BR') }
  }
};

/** Plugins whose actions build shell strings from arbitrary fields: not on the generic route. */
export const SHELL_PLUGINS_OFF_GENERIC_ROUTE = new Set(['ffmpeg']);

/**
 * Clean `body` for an external call to plugin/action. Returns the params to pass (without
 * `action`); throws an Error whose message is safe to show the caller.
 */
export async function guardExternalParams(plugin, action, body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  const schema = SHELL_PLUGIN_SCHEMAS[plugin];
  if (schema) {
    const fields = schema[action];
    if (!fields) throw new Error(`Action '${action}' is not available for ${plugin}`);
    const out = {};
    for (const [key, check] of Object.entries(fields)) {
      if (src[key] === undefined || src[key] === null || src[key] === '') continue;
      try { out[key] = await check(src[key], key); } catch (e) { throw new Error(`${key} ${e.message}`); }
    }
    return out;
  }

  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === 'action' || key.startsWith('_') || LOCAL_KEYS.has(key)) continue;
    if ((URL_KEYS.has(key) || (MAYBE_URL_KEYS.has(key) && HAS_SCHEME.test(String(value)))) && typeof value === 'string' && value) {
      // data: images are content, not a fetch
      out[key] = /^data:image\//i.test(value) ? value : await assertPublicUrl(value, key);
      continue;
    }
    out[key] = value;
  }
  if (plugin === 'huggingface' && out.model !== undefined &&
      !/^[A-Za-z0-9][\w.-]{0,95}(\/[A-Za-z0-9][\w.-]{0,95})?$/.test(String(out.model))) {
    throw new Error('model must be a HuggingFace model id like owner/name');
  }
  return out;
}
