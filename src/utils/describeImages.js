/**
 * Let the model see pictures attached to a message. The router and the chat model are text-only:
 * an attached picture reached them as "[The user attached still-1.jpg]" and nothing else, so a
 * question about a photo (Telegram caption, TextX "Ask ALICE about this", 2026-10-22) was
 * answered blind. Each picture goes to the vision model once and comes back as a description the
 * request can carry.
 */

const MAX_PICTURES = 8;

const PROMPT = 'Describe this picture in detail. Then transcribe every piece of text in it exactly, ' +
  'under the heading "Text in the image:". Say "none" if there is no text.';

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
 */
export async function describeImages(providerManager, pictures, question = '') {
  const list = (pictures || []).slice(0, MAX_PICTURES);
  if (!list.length) return [];
  if (!providerManager?.analyzeImage) return list.map(p => ({ name: p.name, error: 'no vision model is available' }));
  const prompt = question ? `${PROMPT}\n\nThe person asking about it said: "${String(question).slice(0, 500)}"` : PROMPT;
  return Promise.all(list.map(async (p) => {
    try {
      const text = answerText(await providerManager.analyzeImage(p.buffer, prompt, { mimeType: p.mime }));
      return text ? { name: p.name, text } : { name: p.name, error: 'the vision model returned nothing' };
    } catch (err) {
      return { name: p.name, error: err.message };
    }
  }));
}

/** A vision read is not a fact: small or stylised lettering is misread (Trellis card 21, 2026-10-07). */
export const VISION_CAVEAT = 'These pictures were described by a vision model. Text read from a picture can be wrong; ' +
  'if it disagrees with what the person said, mention both rather than telling them they are mistaken.';
