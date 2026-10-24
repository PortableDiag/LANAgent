/**
 * Paid text-to-speech — billed per started 1,000 characters of input.
 *
 *   POST /api/external/tts          JSON { text, model?, voice?, speed? } → MP3 as base64
 *   GET  /api/external/tts/voices   free: models, tiers, prices and the voices each accepts
 *   POST /api/external/tts/estimate free: the credits a POST /tts would charge, after the same checks
 *
 * Speech is generated through the agent's OpenRouter provider (services/tts.js), which bills
 * per input character at the model's catalog price. The price is fixed per tier and known
 * from the text length BEFORE anything is charged; a model whose live cost has risen past
 * 90% of what its tier charges is refused, uncharged, so a provider price change can never
 * sell speech at a loss. Credits only: the flat-price legacy payment path cannot express a
 * per-length price.
 */
import { Router } from 'express';
import { creditAuth } from '../middleware/creditAuth.js';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import { ConcurrencyLimiter } from '../../../utils/concurrencyLimiter.js';
import { getMediaModels } from '../../../services/media/mediaCatalog.js';
import { logger } from '../../../utils/logger.js';

// ── Pricing and limits (1 credit = $0.01) ────────────────────────────────────
export const TTS_MAX_CHARS = 5000;
export const TTS_MARGIN_GUARD = 0.9; // refuse when cost per 1K chars > 90% of the tier price
export const TTS_TIERS = {
  // Live costs 2026-10-16 (OpenRouter, per 1K chars): kokoro $0.0006, orpheus $0.007, csm $0.007
  standard: { creditsPer1k: 1, models: {
    'hexgrad/kokoro-82m': { defaultVoice: 'af_heart', note: 'Default. 54 voices, many languages' },
    'canopylabs/orpheus-3b-0.1-ft': { defaultVoice: 'tara', note: 'Expressive English (tara, leah, jess, leo, dan, mia, zac)' },
    'sesame/csm-1b': { defaultVoice: 'conversational_a', note: 'Conversational English' }
  } },
  // mai 2.1 flash $0.015, grok $0.015, eleven flash v2.5 $0.02, voxtral $0.016
  premium: { creditsPer1k: 3, models: {
    'microsoft/mai-voice-2.1-flash': { defaultVoice: 'en-US-Jasper:MAI-Voice-2.1-Flash', note: '97 voices across many languages' },
    'x-ai/grok-voice-tts-1.0': { defaultVoice: 'ara', note: 'Grok voices (eve, ara, rex, sal, leo)' },
    'elevenlabs/eleven-flash-v2.5': { defaultVoice: 'sarah', note: 'ElevenLabs Flash v2.5, 21 voices' },
    'mistralai/voxtral-mini-tts-2603': { defaultVoice: 'en_paul_neutral', note: 'Voxtral, voices with emotions' }
  } }
};
export const TTS_DEFAULT_MODEL = 'hexgrad/kokoro-82m';

/** The tier and settings of a model we sell, or null. */
export function modelInfo(model) {
  for (const [tier, t] of Object.entries(TTS_TIERS)) {
    if (t.models[model]) return { tier, creditsPer1k: t.creditsPer1k, ...t.models[model] };
  }
  return null;
}

/** Credits for `chars` characters on a tier: per started 1,000, minimum one block. */
export function ttsCredits(chars, creditsPer1k) {
  if (!Number.isFinite(chars) || chars <= 0) return null;
  return Math.max(1, Math.ceil(chars / 1000)) * creditsPer1k;
}

/** Whether the live per-character cost still leaves margin at the tier's price. */
export function withinMargin(pricePerChar, creditsPer1k) {
  if (!Number.isFinite(pricePerChar)) return false;
  return pricePerChar * 1000 <= creditsPer1k * 0.01 * TTS_MARGIN_GUARD;
}

const limiter = new ConcurrencyLimiter({ maxConcurrent: 3, maxQueue: 10 });

function requireCredits(req, res, next) {
  if (req.wallet) return next();
  return res.status(401).json({ success: false, error: 'Text-to-speech is billed in credits: send your API key (X-API-Key) or a Bearer token' });
}

async function liveCatalog() {
  const models = await getMediaModels('openrouter', 'speech');
  return new Map(models.map(m => [m.id, m]));
}

/**
 * Validate a speech request against the limits and the live catalog. Shared by POST /tts and
 * POST /tts/estimate so a quote can never accept what the paid call would refuse (or the reverse).
 * Returns { error: { status, body } } or { text, model, info, voice, speed }. Charges nothing.
 */
export async function checkTtsRequest(body, catalog = liveCatalog) {
  const fail = (status, b) => ({ error: { status, body: { success: false, ...b, creditsCharged: 0 } } });
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return fail(400, { error: 'Send JSON { "text": "…" } (and optionally model, voice, speed)' });
  if (text.length > TTS_MAX_CHARS) {
    return fail(413, { error: `Text is ${text.length} characters; the limit is ${TTS_MAX_CHARS} per request`, maxChars: TTS_MAX_CHARS });
  }
  const model = body.model ? String(body.model) : TTS_DEFAULT_MODEL;
  const info = modelInfo(model);
  if (!info) {
    return fail(400, { error: `Unknown model "${model}". See GET /tts/voices`, models: Object.values(TTS_TIERS).flatMap(t => Object.keys(t.models)) });
  }
  let speed;
  if (body.speed !== undefined) {
    speed = Number(body.speed);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
      return fail(400, { error: 'speed must be a number from 0.5 to 2' });
    }
  }

  // Live catalog: the voices this model accepts and its current per-character cost.
  let entry;
  try {
    entry = (await catalog()).get(model);
  } catch (e) {
    logger.warn(`[tts] catalog unavailable: ${e.message}`);
  }
  if (!entry || !withinMargin(Number(entry.pricing?.prompt), info.creditsPer1k)) {
    return fail(503, { error: `Model ${model} is not available right now; try another (GET /tts/voices)` });
  }
  const voice = body.voice ? String(body.voice) : info.defaultVoice;
  const voices = entry.voices || [];
  if (voices.length && !voices.includes(voice)) {
    return fail(400, { error: `Voice "${voice}" is not offered by ${model}`, voices });
  }
  return { text, model, info, voice, speed };
}

const router = Router();

router.get('/voices', async (req, res) => {
  let live = new Map();
  try { live = await liveCatalog(); } catch (e) { logger.warn(`[tts] voice catalog unavailable: ${e.message}`); }
  const models = [];
  for (const [tier, t] of Object.entries(TTS_TIERS)) {
    for (const [id, m] of Object.entries(t.models)) {
      const entry = live.get(id);
      models.push({
        model: id,
        tier,
        creditsPer1000Chars: t.creditsPer1k,
        default: id === TTS_DEFAULT_MODEL,
        defaultVoice: m.defaultVoice,
        note: m.note,
        available: entry ? withinMargin(Number(entry.pricing?.prompt), t.creditsPer1k) : null,
        voices: entry?.voices || []
      });
    }
  }
  res.json({
    success: true,
    billing: 'per started 1,000 characters of text (minimum one block), by tier; known before charging',
    maxChars: TTS_MAX_CHARS,
    format: 'mp3',
    creditValueUsd: 0.01,
    models
  });
});

router.post('/',
  creditAuth(false),
  requireCredits,
  async (req, res) => {
    const checked = await checkTtsRequest(req.body);
    if (checked.error) return res.status(checked.error.status).json(checked.error.body);
    const { text, model, info, voice, speed } = checked;

    const credits = ttsCredits(text.length, info.creditsPer1k);
    // A reseller (the api.lanagent.net gateway) holds only what its customer can afford and
    // says so here. Refuse — before charging — anything that would cost more.
    const budget = Number.parseInt(req.get('x-max-credits'), 10);
    if (Number.isFinite(budget) && budget >= 0 && credits > budget) {
      return res.status(402).json({ success: false, creditsCharged: 0, required: credits, budget,
        error: `This text costs ${credits} credits (${text.length} characters, ${info.tier}); the available budget is ${budget}` });
    }

    const tts = req.app.locals.agent?.ttsService;
    if (!tts?.generateSpeechOpenRouter) {
      return res.status(503).json({ success: false, error: 'Text-to-speech is not available', creditsCharged: 0 });
    }

    try {
      await limiter.run(async () => {
        const debited = await ExternalCreditBalance.debitCredits(req.wallet, credits);
        if (!debited) {
          const account = await ExternalCreditBalance.findByWallet(req.wallet);
          return res.status(402).json({ success: false, error: 'Insufficient credits', required: credits, balance: account?.credits || 0 });
        }
        try {
          const result = await tts.generateSpeechOpenRouter(text, { model, voice, speed, format: 'mp3', source: 'external-api' });
          if (!result?.buffer?.length) throw new Error('no audio returned');
          const account = await ExternalCreditBalance.findByWallet(req.wallet);
          return res.json({
            success: true,
            audio: result.buffer.toString('base64'),
            format: 'mp3',
            mimeType: 'audio/mpeg',
            bytes: result.buffer.length,
            model,
            voice: result.voice || voice,
            tier: info.tier,
            characters: text.length,
            creditsCharged: credits,
            creditsRemaining: account?.credits ?? null
          });
        } catch (error) {
          logger.error(`[tts] failed after charging ${credits} credits: ${error.message}`);
          await ExternalCreditBalance.refundCredits(req.wallet, credits)
            .catch(e => logger.error(`[tts] REFUND FAILED for ${req.wallet} (${credits} credits): ${e.message}`));
          return res.status(502).json({ success: false, error: 'Speech generation failed', targetError: true,
            credited: true, creditsRefunded: credits, creditsCharged: 0 });
        }
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(503).json({ success: false, error: 'Text-to-speech queue is full — retry shortly', creditsCharged: 0 });
      }
    }
  });

/**
 * POST /tts/estimate — free quote: the credits POST /tts would charge for this text, model and
 * voice, after the same checks (length, model, voice, live availability). Generates nothing,
 * debits nothing, needs no key.
 */
router.post('/estimate', async (req, res) => {
  const checked = await checkTtsRequest(req.body);
  if (checked.error) return res.status(checked.error.status).json(checked.error.body);
  const { text, model, info, voice } = checked;
  return res.json({
    success: true,
    creditsRequired: ttsCredits(text.length, info.creditsPer1k),
    model,
    voice,
    tier: info.tier,
    characters: text.length
  });
});

export default router;
