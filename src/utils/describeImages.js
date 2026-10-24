/**
 * Let the model see pictures attached to a message. The router and the chat model are text-only:
 * an attached picture reached them as "[The user attached still-1.jpg]" and nothing else, so a
 * question about a photo (Telegram caption, TextX "Ask ALICE about this", 2026-10-22) was
 * answered blind. Each picture goes to the vision model once and comes back as a description the
 * request can carry.
 */

import { logger } from './logger.js';
import NodeCache from 'node-cache';
import crypto from 'crypto';

const MAX_PICTURES = 8;

const PROMPT = 'Describe this picture in detail. Then transcribe every piece of text in it exactly, ' +
  'under the heading "Text in the image:". Say "none" if there is no text.';

// The same picture asked about the same way (a re-sent photo, a retried TextX request) reuses the
// last description for an hour instead of paying the vision model again. The key covers the
// prompt too: the description is shaped by the question, so a new question must look again.
const imageDescriptionCache = new NodeCache({ stdTTL: 3600, checkperiod: 600, maxKeys: 500, useClones: false });

/** True when the attachment is a picture the vision model can take. */
export function isPicture(mime, name = '') {
  return /^image\//i.test(String(mime || '')) || /\.(png|jpe?g|gif|webp)$/i.test(String(name || ''));
}

/** Providers answer in different fields (OpenRouter: `analysis`); never stringify the object. */
function answerText(r) {
  const pick = typeof r === 'string' ? r : (r?.analysis ?? r?.content ?? r?.text ?? r?.description ?? r?.caption);
  return typeof pick === 'string' ? pick.trim() : '';
}

/**
 * Describe up to 8 pictures. `question` is what the person asked, so the description covers what
 * they care about. Returns [{ name, text } | { name, error }] in input order; never throws.
 *
 * Each picture object may supply the image as:
 * - `buffer` (Buffer) – raw image bytes
 * - `buffer` (string) – base64-encoded image
 * - `base64` (string) – base64-encoded image (alternative field)
 */
export async function describeImages(providerManager, pictures, question = '') {
  const list = (pictures || []).slice(0, MAX_PICTURES);
  if (!list.length) return [];
  if (!providerManager?.analyzeImage) return list.map(p => ({ name: p.name, error: 'no vision model is available' }));
  const prompt = question ? `${PROMPT}\n\nThe person asking about it said: "${String(question).slice(0, 500)}"` : PROMPT;
  return Promise.all(list.map(async (p) => {
    try {
      // Determine the image buffer from the picture object
      let buffer;
      if (Buffer.isBuffer(p.buffer)) {
        buffer = p.buffer;
      } else if (typeof p.buffer === 'string') {
        // Assume base64-encoded string
        buffer = Buffer.from(p.buffer, 'base64');
      } else if (typeof p.base64 === 'string') {
        buffer = Buffer.from(p.base64, 'base64');
      } else {
        return { name: p.name, error: 'no image data provided' };
      }

      // Check cache first
      const hash = crypto.createHash('sha256').update(buffer).update('\0').update(prompt).digest('hex');
      const cached = imageDescriptionCache.get(hash);
      if (cached) {
        logger.debug(`Image description cache hit for ${p.name}`);
        return { name: p.name, text: cached };
      }

      // providerManager.analyzeImage already retries transient failures; wrapping it again would
      // multiply the attempts (4 x 4) against a person waiting on the reply.
      const result = await providerManager.analyzeImage(buffer, prompt, { mimeType: p.mime });

      const text = answerText(result);
      if (text) {
        try { imageDescriptionCache.set(hash, text); } catch { /* cache full: still answer */ }
        logger.debug(`Image described successfully: ${p.name}`);
        return { name: p.name, text };
      } else {
        logger.warn(`Vision model returned empty description for ${p.name}`);
        return { name: p.name, error: 'the vision model returned nothing' };
      }
    } catch (err) {
      logger.error(`Error describing image ${p.name}: ${err.message}`);
      return { name: p.name, error: err.message };
    }
  }));
}

/** A vision read is not a fact: small or stylised lettering is misread (Trellis card 21, 2026-10-07). */
export const VISION_CAVEAT = 'These pictures were described by a vision model. Text read from a picture can be wrong; ' +
  'if it disagrees with what the person said, mention both rather than telling them they are mistaken.';
