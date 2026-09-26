/**
 * Paid audio transcription — speech to text, billed per minute of audio.
 *
 *   POST /api/external/transcribe          multipart `file` (audio, or video with a soundtrack)
 *   POST /api/external/transcribe/url      JSON { url } — anything the yt-dlp plugin can fetch
 *   GET  /api/external/transcribe/pricing  free: the price and limits below
 *
 * Billing is per STARTED minute, measured with ffprobe (or from the source's metadata for a
 * URL) BEFORE anything is charged, so a request over the length limit costs nothing. Credits
 * only: the flat-price legacy payment path cannot express a per-minute price.
 *
 * Audio is normalised to mono 16 kHz Ogg/Opus at 24 kbps (~0.18 MB/min) before
 * transcription. That keeps the longest allowed input (~11 MB) under the transcription
 * API's 25 MB file limit, so no request needs chunking, and matches the container the
 * provider labels uploads with.
 */
import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { creditAuth } from '../middleware/creditAuth.js';
import multer from 'multer';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import { ConcurrencyLimiter } from '../../../utils/concurrencyLimiter.js';
import { logger } from '../../../utils/logger.js';

// ── Pricing and limits (1 credit = $0.01) ────────────────────────────────────
export const TRANSCRIBE_CREDITS_PER_MINUTE = 2;   // $0.02 per started minute
export const TRANSCRIBE_MIN_CREDITS = 2;          // a 10-second clip still costs 2
export const TRANSCRIBE_URL_FETCH_CREDITS = 5;    // fetching remote media, on top
export const TRANSCRIBE_MAX_MINUTES = 60;         // per request
// Containers pad audio by a few hundred milliseconds (Opus pre-skip, AAC priming), so a clean
// 5:00 recording probes as 300.02 s. Without a grace that is a sixth "started" minute.
export const TRANSCRIBE_GRACE_SECONDS = 0.5;

/**
 * Credits for a given duration. Returns null when the duration is unknown or over the limit
 * — the caller must refuse rather than guess.
 */
export function transcriptionCredits(durationSeconds, { fromUrl = false } = {}) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  if (durationSeconds > TRANSCRIBE_MAX_MINUTES * 60 + TRANSCRIBE_GRACE_SECONDS) return null;
  const minutes = Math.max(1, Math.ceil((durationSeconds - TRANSCRIBE_GRACE_SECONDS) / 60));
  const credits = Math.max(TRANSCRIBE_MIN_CREDITS, minutes * TRANSCRIBE_CREDITS_PER_MINUTE)
    + (fromUrl ? TRANSCRIBE_URL_FETCH_CREDITS : 0);
  return { minutes, credits };
}

const WORK_DIR = path.resolve('data/external-uploads');
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// ── Accepted input ───────────────────────────────────────────────────────────
// The shared upload middleware allows three audio types by declared MIME. Transcription
// takes every common format instead, and validates by PROBING the file: only a real media
// container with an audio stream is transcribed or charged. Clients label the same format
// many ways (audio/x-wav, audio/wave, audio/x-m4a, audio/mp4, application/octet-stream…),
// so the upload filter accepts audio/* and video/* by MIME or a known extension; ffprobe
// is the gate that matters.
export const TRANSCRIBE_EXTENSIONS = new Set([
  'mp3', 'wav', 'wave', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'webm', 'mkv',
  'mka', 'mov', 'avi', 'wma', 'wmv', 'aif', 'aiff', 'aifc', 'amr', '3gp', '3g2', 'caf',
  'mpeg', 'mpg', 'mpga', 'm4v', 'ts', 'mts', 'flv', 'wv', 'ac3', 'mp2'
]);
// ffprobe `format_name` values (each is a comma-separated alias list) accepted for
// transcription. Anything else is refused — in particular playlist and indirection formats
// (hls, concat, image2, lavfi…), which can make ffmpeg read OTHER files on the host.
export const TRANSCRIBE_CONTAINERS = new Set([
  'mp3', 'wav', 'w64', 'flac', 'ogg', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska',
  'webm', 'aac', 'amr', 'aiff', 'asf', 'caf', 'mpeg', 'mpegts', 'avi', 'flv', 'wv', 'ac3',
  'eac3', 'mp2', 'opus'
]);

export function isAcceptedUpload(mimetype = '', originalname = '') {
  const ext = path.extname(originalname).slice(1).toLowerCase();
  if (/^(audio|video)\//.test(mimetype)) return true;
  return TRANSCRIBE_EXTENSIONS.has(ext);
}

export function isAcceptedContainer(formatName = '') {
  return String(formatName).split(',').some(f => TRANSCRIBE_CONTAINERS.has(f.trim()));
}

const transcribeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, WORK_DIR),
    // Never keep the client's extension: the name is random and the content is probed.
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}.media`)
  }),
  fileFilter: (req, file, cb) => isAcceptedUpload(file.mimetype, file.originalname)
    ? cb(null, true)
    : cb(Object.assign(new Error(`Unsupported file type ${file.mimetype || '(none)'}`), { code: 'UNSUPPORTED_TYPE' }), false),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
}).single('file');

function acceptUpload(req, res, next) {
  transcribeUpload(req, res, (err) => {
    if (!err) return next();
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 415;
    res.status(status).json({ success: false, creditsCharged: 0,
      error: err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 500 MB upload limit' : err.message });
  });
}
// Whisper calls are slow and paid; a queue keeps a burst from running them all at once.
const limiter = new ConcurrencyLimiter({ maxConcurrent: 2, maxQueue: 6 });

function run(cmd, args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`));
    });
  });
}

/**
 * Probe a file: container, duration and whether it has an audio stream. Local files only
 * (`-protocol_whitelist file`), so a crafted input cannot make ffprobe open a URL.
 */
export async function probeMedia(filePath) {
  const out = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
    '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', filePath],
    { timeoutMs: 60000 });
  const data = JSON.parse(out || '{}');
  const seconds = parseFloat(data?.format?.duration);
  return {
    formatName: data?.format?.format_name || '',
    durationSeconds: Number.isFinite(seconds) ? seconds : NaN,
    hasAudio: (data?.streams || []).some(s => s.codec_type === 'audio')
  };
}

/** Probe and vet an input. Returns { durationSeconds } or { error, status }. */
export async function vetMedia(filePath) {
  let info;
  try { info = await probeMedia(filePath); } catch { return { status: 415, error: 'Not a readable audio or video file' }; }
  if (!isAcceptedContainer(info.formatName)) {
    return { status: 415, error: `Unsupported container (${info.formatName || 'unknown'})` };
  }
  if (!info.hasAudio) return { status: 422, error: 'The file has no audio track' };
  return { durationSeconds: info.durationSeconds };
}

async function normaliseAudio(inputPath) {
  const outPath = path.join(WORK_DIR, `${crypto.randomBytes(12).toString('hex')}.ogg`);
  await run('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'libopus', '-b:a', '24k', outPath]);
  return outPath;
}

async function removeQuietly(...paths) {
  await Promise.all(paths.filter(Boolean).map(p => fs.unlink(p).catch(() => {})));
}

function requireCredits(req, res, next) {
  if (req.wallet) return next();
  return res.status(401).json({ success: false, error: 'Transcription is billed in credits: send your API key (X-API-Key) or a Bearer token' });
}

/**
 * Charge, transcribe, and refund on any failure after the charge. `sourcePath` is the media
 * to transcribe; the caller owns its cleanup.
 */
async function chargeAndTranscribe(req, res, { sourcePath, durationSeconds, fromUrl, extra = {} }) {
  const price = transcriptionCredits(durationSeconds, { fromUrl });
  if (!price) {
    const tooLong = Number.isFinite(durationSeconds) && durationSeconds > TRANSCRIBE_MAX_MINUTES * 60 + TRANSCRIBE_GRACE_SECONDS;
    return res.status(tooLong ? 413 : 422).json({
      success: false,
      error: tooLong
        ? `Audio is ${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, '0')} long; the limit is ${TRANSCRIBE_MAX_MINUTES} minutes per request`
        : 'Could not determine the audio duration — is this an audio or video file with sound?',
      maxMinutes: TRANSCRIBE_MAX_MINUTES,
      creditsCharged: 0
    });
  }

  // A reseller (the api.lanagent.net gateway) holds only what its customer can afford and
  // says so here. Refuse — before charging — anything that would cost more, so the reseller
  // can never be billed beyond what it collected.
  const budget = Number.parseInt(req.get('x-max-credits'), 10);
  if (Number.isFinite(budget) && budget >= 0 && price.credits > budget) {
    return res.status(402).json({ success: false, creditsCharged: 0, required: price.credits, budget,
      error: `This audio costs ${price.credits} credits (${price.minutes} min); the available budget is ${budget}` });
  }

  const debited = await ExternalCreditBalance.debitCredits(req.wallet, price.credits);
  if (!debited) {
    const account = await ExternalCreditBalance.findByWallet(req.wallet);
    return res.status(402).json({ success: false, error: 'Insufficient credits', required: price.credits, balance: account?.credits || 0 });
  }

  let normalised = null;
  try {
    normalised = await normaliseAudio(sourcePath);
    const audio = await fs.readFile(normalised);
    const providerManager = req.app.locals.agent?.providerManager;
    if (!providerManager?.transcribeAudio) throw new Error('Transcription provider not available');
    const text = await providerManager.transcribeAudio(audio);
    const account = await ExternalCreditBalance.findByWallet(req.wallet);
    return res.json({
      success: true,
      text: typeof text === 'string' ? text.trim() : String(text ?? ''),
      durationSeconds: Math.round(durationSeconds * 10) / 10,
      minutesBilled: price.minutes,
      creditsCharged: price.credits,
      creditsRemaining: account?.credits ?? null,
      ...extra
    });
  } catch (error) {
    logger.error(`[transcribe] failed after charging ${price.credits} credits: ${error.message}`);
    await ExternalCreditBalance.refundCredits(req.wallet, price.credits)
      .catch(e => logger.error(`[transcribe] REFUND FAILED for ${req.wallet} (${price.credits} credits): ${e.message}`));
    return res.status(502).json({ success: false, error: 'Transcription failed', targetError: true,
      credited: true, creditsRefunded: price.credits, creditsCharged: 0 });
  } finally {
    await removeQuietly(normalised);
  }
}

function queueFull(res) {
  return res.status(503).json({ success: false, error: 'Transcription queue is full — retry shortly', creditsCharged: 0 });
}

const router = Router();

router.get('/pricing', (req, res) => {
  res.json({
    success: true,
    creditsPerMinute: TRANSCRIBE_CREDITS_PER_MINUTE,
    minimumCredits: TRANSCRIBE_MIN_CREDITS,
    urlFetchCredits: TRANSCRIBE_URL_FETCH_CREDITS,
    maxMinutes: TRANSCRIBE_MAX_MINUTES,
    billing: 'per started minute of audio, measured before charging; nothing is charged for a request over the limit',
    formats: [...TRANSCRIBE_EXTENSIONS].sort(),
    maxUploadMB: MAX_UPLOAD_BYTES / (1024 * 1024),
    creditValueUsd: 0.01
  });
});

router.post('/',
  creditAuth(false),
  requireCredits,
  acceptUpload,
  async (req, res) => {
    const uploaded = req.file?.path;
    if (!uploaded) return res.status(400).json({ success: false, error: 'Send the audio as multipart field "file"' });
    try {
      await limiter.run(async () => {
        const vet = await vetMedia(uploaded);
        if (vet.error) return res.status(vet.status).json({ success: false, error: vet.error, creditsCharged: 0 });
        await chargeAndTranscribe(req, res, { sourcePath: uploaded, durationSeconds: vet.durationSeconds, fromUrl: false,
          extra: { source: 'upload' } });
      });
    } catch (error) {
      if (error.code === 'QUEUE_FULL') return queueFull(res);
      logger.error(`[transcribe] upload handler: ${error.message}`);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Transcription failed', creditsCharged: 0 });
    } finally {
      await removeQuietly(uploaded);
    }
  });

router.post('/url',
  creditAuth(false),
  requireCredits,
  async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    let parsed;
    try { parsed = new URL(url); } catch { /* handled below */ }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      return res.status(400).json({ success: false, error: 'Send JSON { "url": "https://…" }' });
    }

    const entry = req.app.locals.agent?.apiManager?.apis?.get('ytdlp');
    const ytdlp = entry?.instance || entry;
    if (!ytdlp || entry?.enabled === false || typeof ytdlp.execute !== 'function') {
      return res.status(503).json({ success: false, error: 'Media fetching is not available', creditsCharged: 0 });
    }

    let downloaded = null;
    try {
      await limiter.run(async () => {
        // Check the length from metadata first so an over-limit URL is never downloaded.
        const info = await ytdlp.execute({ action: 'info', url }).catch(() => null);
        const metaSeconds = Number(info?.raw?.duration);
        if (Number.isFinite(metaSeconds) && metaSeconds > TRANSCRIBE_MAX_MINUTES * 60 + TRANSCRIBE_GRACE_SECONDS) {
          return chargeAndTranscribe(req, res, { durationSeconds: metaSeconds, fromUrl: true });
        }

        // A unique output name: the plugin joins identical in-flight downloads and names
        // files by title, so without it this request could share — and then delete — a
        // file another customer's download link points at.
        const result = await ytdlp.execute({ action: 'audio', url, format: 'mp3',
          output: `transcribe-${crypto.randomBytes(12).toString('hex')}.%(ext)s` });
        downloaded = result?.file?.path || null;
        if (!result?.success || !downloaded) {
          return res.status(422).json({ success: false, error: result?.error || 'Could not fetch audio from that URL', creditsCharged: 0 });
        }
        // Bill on the file actually fetched, not the metadata — they can disagree.
        const vet = await vetMedia(downloaded);
        if (vet.error) return res.status(422).json({ success: false, error: vet.error, creditsCharged: 0 });
        await chargeAndTranscribe(req, res, { sourcePath: downloaded, durationSeconds: vet.durationSeconds, fromUrl: true,
          extra: { source: 'url', title: info?.data?.title || result?.title || undefined } });
      });
    } catch (error) {
      if (error.code === 'QUEUE_FULL') return queueFull(res);
      logger.error(`[transcribe] url handler: ${error.message}`);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Transcription failed', creditsCharged: 0 });
    } finally {
      await removeQuietly(downloaded);
    }
  });

export default router;
