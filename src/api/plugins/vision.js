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

export default class VisionPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'vision';
    this.version = '1.0.0';
    this.description = 'Look at a local image file and answer a question about it (what is in it, a facial expression, text, whether something is present)';
    this.commands = [
      {
        command: 'ask',
        description: 'Ask the vision model a question about one or more local images (frames from ffmpeg extract, files saved with http.request saveTo)',
        usage: 'ask({ path: "/abs/frame_0005.png", question: "Is the person laughing or smiling?" })  // or paths: [ ... ] (up to 8)',
        examples: ['look at this frame and tell me if the person is laughing', 'describe this image file', 'what does this screenshot show']
      }
    ];
  }

  async execute(params = {}) {
    if (params.action !== 'ask') return { success: false, error: `Unknown action: ${params.action}. Use ask.` };
    const question = String(params.question || 'Describe this image.').slice(0, 1000);
    const list = [].concat(params.paths || params.path || []).filter(Boolean).slice(0, 8);
    if (!list.length) return { success: false, error: 'ask needs path (or paths) of a local image' };
    const answers = [];
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
        // Providers answer in different fields (OpenRouter: `analysis`); never stringify the object.
        const text = typeof r === 'string' ? r : (r?.analysis ?? r?.content ?? r?.text ?? r?.description ?? '');
        if (!String(text).trim()) throw new Error('the vision model returned no text');
        answers.push({ path: abs, answer: String(text).trim() });
      } catch (err) {
        answers.push({ path: abs, error: err.message });
      }
    }
    const ok = answers.filter(a => a.answer);
    return {
      success: ok.length > 0,
      answers,
      ...(ok.length ? {} : { error: answers.map(a => a.error).filter(Boolean)[0] || 'no answer' }),
      result: answers.map(a => `${path.basename(a.path)}: ${a.answer || `(failed: ${a.error})`}`).join('\n')
    };
  }
}
