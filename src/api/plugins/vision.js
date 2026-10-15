import { BasePlugin } from '../core/basePlugin.js';
import { DATA_PATH, TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH, DEPLOY_PATH } from '../../utils/paths.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Ask the agent's vision model a question about a local picture: a frame ffmpeg extracted, a
 * download saved by http.request({ saveTo }). imageCaption only takes a URL or base64 and only
 * writes a generic caption; judging a recorded reaction ("is the person laughing?") needs a
 * question asked of a file on disk (2026-10-02).
 */
const ROOTS = () => [TEMP_PATH, DATA_PATH, UPLOADS_PATH, WORKSPACE_PATH, path.join(DEPLOY_PATH, 'media'), '/tmp'];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const ALLOWED_MIME_TYPES = [...new Set(Object.values(MIME))];
// Decoded size cap for inline images; providerManager shrinks big pictures, but a
// multi-hundred-MB string should never reach the decoder.
const MAX_BASE64_BYTES = 20 * 1024 * 1024;

/** Identify an image by its first bytes, so a caller need not name the type. */
function sniffMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Decode a base64 image (raw, or a data: URL) and settle its type. A caller-
 * supplied mimeType must agree with the bytes: a mislabelled picture is the
 * failure OpenRouter answers worst (see providerManager.analyzeImage).
 */
function decodeBase64Image(input, declaredMime) {
  let raw = String(input).trim();
  let mime = declaredMime ? String(declaredMime).trim().toLowerCase() : null;
  const dataUrl = raw.match(/^data:([^;,]+);base64,/i);
  if (dataUrl) {
    mime = mime || dataUrl[1].toLowerCase();
    raw = raw.slice(dataUrl[0].length);
  }
  raw = raw.replace(/\s+/g, '');
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return { error: 'Invalid base64 string' };
  if (raw.length * 0.75 > MAX_BASE64_BYTES) return { error: `Image too large (max ${MAX_BASE64_BYTES / 1024 / 1024} MB)` };
  const buf = Buffer.from(raw, 'base64');
  const sniffed = sniffMime(buf);
  if (!sniffed) return { error: `Not a recognised image (${ALLOWED_MIME_TYPES.join(', ')})` };
  if (mime && !ALLOWED_MIME_TYPES.includes(mime)) return { error: `Unsupported mimeType: ${mime}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}` };
  if (mime && mime !== sniffed) return { error: `mimeType ${mime} does not match the image data (${sniffed})` };
  return { buf, mime: sniffed };
}

/** Providers answer in different fields (OpenRouter: `analysis`); never stringify the object. */
function answerText(r) {
  const text = typeof r === 'string' ? r : (r?.analysis ?? r?.content ?? r?.text ?? r?.description ?? '');
  if (!String(text).trim()) throw new Error('the vision model returned no text');
  return String(text).trim();
}

export default class VisionPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'vision';
    this.version = '1.0.0';
    this.description = 'Look at a local image file or a base64-encoded image and answer a question about it (what is in it, a facial expression, text, whether something is present)';
    this.commands = [
      {
        command: 'ask',
        description: 'Ask the vision model a question about one or more local images (frames from ffmpeg extract, files saved with http.request saveTo) or a base64-encoded image string',
        usage: 'ask({ path: "/abs/frame_0005.png", question: "Is the person laughing or smiling?" })  // or paths: [ ... ] (up to 8). For base64: ask({ base64: "iVBORw0KGgo..." or "data:image/png;base64,...", question: "..." })  // type is read from the bytes; mimeType optional',
        examples: ['look at this frame and tell me if the person is laughing', 'describe this image file', 'what does this screenshot show', 'analyze this base64 image']
      }
    ];
  }

  async execute(params = {}) {
    if (params.action !== 'ask') return { success: false, error: `Unknown action: ${params.action}. Use ask.` };
    const question = String(params.question || 'Describe this image.').slice(0, 1000);
    const list = [].concat(params.paths || params.path || []).filter(Boolean).slice(0, 8);
    let inline = null;
    if (params.base64) {
      inline = decodeBase64Image(params.base64, params.mimeType);
      if (inline.error) return { success: false, error: inline.error };
    }

    if (!list.length && !inline) {
      return { success: false, error: 'ask needs path (or paths) of a local image, or a base64 image' };
    }

    const answers = [];

    // Process file paths
    for (const p of list) {
      const abs = path.resolve(String(p));
      if (!ROOTS().some(r => abs === r || abs.startsWith(r + path.sep))) {
        answers.push({ path: abs, error: 'outside the agent\'s data, temp, upload and media folders' });
        continue;
      }
      const mime = MIME[path.extname(abs).toLowerCase()];
      if (!mime) { answers.push({ path: abs, error: 'not an image (png, jpg, webp, gif)' }); continue; }
      try {
        const buf = await fs.readFile(abs);
        const r = await this.agent.providerManager.analyzeImage(buf, question, { mimeType: mime });
        answers.push({ path: abs, answer: answerText(r) });
      } catch (err) {
        answers.push({ path: abs, error: err.message });
      }
    }

    // Process base64 image if provided
    if (inline) {
      try {
        const r = await this.agent.providerManager.analyzeImage(inline.buf, question, { mimeType: inline.mime });
        answers.push({ source: 'base64', answer: answerText(r) });
      } catch (err) {
        answers.push({ source: 'base64', error: err.message });
      }
    }

    const ok = answers.filter(a => a.answer);
    return {
      success: ok.length > 0,
      answers,
      ...(ok.length ? {} : { error: answers.map(a => a.error).filter(Boolean)[0] || 'no answer' }),
      result: answers.map(a => {
        const label = a.path ? path.basename(a.path) : (a.source || 'unknown');
        return `${label}: ${a.answer || `(failed: ${a.error})`}`;
      }).join('\n')
    };
  }
}
