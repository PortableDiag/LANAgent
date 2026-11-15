/**
 * Kokoro-82M speech, run on this machine (kokoro-onnx, Apache-2.0 weights, CPU: ~1.5 s for 6 s of speech).
 *
 * Bots & Borgs voice packs (store 0.17, 2026-11-14) name a Kokoro voice for each avatar in voice.json, so an agent
 * can speak in the voice that matches the model it wears. The model runs in a Python worker
 * (scripts/tts/kokoro_worker.py) as an unprivileged user, because this host also holds the wallet: the worker only
 * ever sees text. It is started on first use, loads the model once, and is stopped after 10 idle minutes.
 *
 * Setup on a host (see docs/TTS_KOKORO.md): a venv with `kokoro-onnx soundfile` (KOKORO_PYTHON, default
 * /opt/kokoro/bin/python), the model files kokoro-v1.0.onnx + voices-v1.0.bin in KOKORO_DIR (default
 * /var/lib/kokoro), and a system user KOKORO_USER (default kokoro) owning that directory.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { SCRIPTS_PATH } from '../utils/paths.js';

const IDLE_MS = 10 * 60 * 1000;
const REQUEST_MS = 90 * 1000;
const START_MS = 60 * 1000;

/** voice.json `lang_code` (KPipeline's one-letter codes) → the espeak language kokoro-onnx takes. */
const LANGS = { a: 'en-us', b: 'en-gb', e: 'es', f: 'fr-fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-br', z: 'cmn' };
export function kokoroLang(code, voice = '') {
  const c = String(code || '').trim().toLowerCase();
  if (LANGS[c]) return LANGS[c];
  if (/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(c)) return c;
  // The voice's first letter is its language (af_nicole = American, bf_emma = British).
  return LANGS[String(voice || '').charAt(0)] || 'en-us';
}

/** A Kokoro voice id: language + gender letter, underscore, name ("af_nicole", "bm_george"). */
export function isKokoroVoice(v) { return /^[a-z][fm]_[a-z0-9]+$/.test(String(v || '')); }

function config() {
  return {
    python: process.env.KOKORO_PYTHON || '/opt/kokoro/bin/python',
    dir: process.env.KOKORO_DIR || '/var/lib/kokoro',
    user: process.env.KOKORO_USER || 'kokoro'
  };
}

/** uid/gid of a local user from /etc/passwd, or null (then the worker runs as this process's user). */
function lookupUser(name) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.split(':')[0] === name);
    if (!line) return null;
    const [, , uid, gid] = line.split(':');
    return { uid: Number(uid), gid: Number(gid) };
  } catch { return null; }
}

/** Whether this host can speak with Kokoro: the venv's python and both model files are there. */
export function kokoroAvailable() {
  const { python, dir } = config();
  return fs.existsSync(python) && fs.existsSync(path.join(dir, 'kokoro-v1.0.onnx')) && fs.existsSync(path.join(dir, 'voices-v1.0.bin'));
}

class KokoroWorker {
  constructor() {
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.voices = [];
    this.idleTimer = null;
    this.spawnImpl = spawn;
  }

  start() {
    if (this.ready) return this.ready;
    const { python, dir, user } = config();
    // The worker's source goes in as -c: the deploy tree is not readable by the worker's user.
    const source = fs.readFileSync(path.join(SCRIPTS_PATH, 'tts', 'kokoro_worker.py'), 'utf8');
    const id = process.getuid?.() === 0 ? lookupUser(user) : null;
    const child = this.spawnImpl(python, ['-u', '-c', source], {
      cwd: dir,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, KOKORO_DIR: dir, OMP_NUM_THREADS: process.env.KOKORO_THREADS || '4' },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(id ? { uid: id.uid, gid: id.gid } : {})
    });
    this.child = child;
    let buf = '';
    let err = '';
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error('Kokoro did not start in time')); this.stop(); }, START_MS);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if ('ready' in msg) {
            clearTimeout(t);
            if (msg.ready) { this.voices = msg.voices || []; resolve(this); } else { reject(new Error(`Kokoro could not load: ${msg.error}`)); this.stop(); }
            continue;
          }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id); clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg); else p.reject(new Error(`Kokoro: ${msg.error}`));
        }
      });
      child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
      child.on('error', (e) => { clearTimeout(t); reject(e); this._fail(e); });
      child.on('close', (code) => {
        clearTimeout(t);
        reject(new Error(`Kokoro exited (${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
        this._fail(new Error(`Kokoro exited (${code})`));
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  _fail(e) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
    this.child = null; this.ready = null;
    clearTimeout(this.idleTimer);
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.child) { try { this.child.stdin.end(); this.child.kill('SIGTERM'); } catch { /* gone */ } }
    this.child = null; this.ready = null;
  }

  async speak({ text, voice, speed = 1, lang }) {
    await this.start();
    clearTimeout(this.idleTimer);
    const id = this.nextId++;
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Kokoro took too long')); this.stop(); }, REQUEST_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, text, voice, speed, lang })}\n`);
    });
    if (!this.pending.size) {
      this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
      this.idleTimer.unref?.();
    }
    return answer;
  }
}

export const kokoroWorker = new KokoroWorker();
process.once('exit', () => kokoroWorker.stop());

/** WAV → MP3 with ffmpeg (every voice consumer here takes MP3). */
function toMp3(wav) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-q:a', '3', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim() || code}`))));
    p.stdin.end(wav);
  });
}

/**
 * Speak `text` with a Kokoro voice. Returns the TTS service's shape: { buffer, format, model, voice, cost: 0, ... }.
 * format 'wav' skips the MP3 step.
 */
export async function kokoroSpeech(text, { voice = 'af_heart', speed = 1, lang, format = 'mp3' } = {}) {
  if (!kokoroAvailable()) throw new Error('Kokoro is not installed on this host (KOKORO_PYTHON / KOKORO_DIR).');
  if (!isKokoroVoice(voice)) throw new Error(`"${voice}" is not a Kokoro voice (like af_nicole).`);
  const started = Date.now();
  const r = await kokoroWorker.speak({ text, voice, speed: Number(speed) || 1, lang: kokoroLang(lang, voice) });
  const wav = Buffer.from(r.wav_b64, 'base64');
  const buffer = format === 'wav' ? wav : await toMp3(wav);
  const responseTime = Date.now() - started;
  logger.info(`Kokoro: ${voice} spoke ${String(text).length} chars as ${r.seconds} s in ${responseTime} ms`);
  return { buffer, format: format === 'wav' ? 'wav' : 'mp3', model: 'kokoro-82m', voice, cost: 0, duration: r.seconds, responseTime, size: buffer.length, provider: 'kokoro' };
}
