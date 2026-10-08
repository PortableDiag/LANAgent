import { logger } from './logger.js';

/**
 * Shrink a picture before a vision model reads it.
 *
 * A full-size phone photo (3000×4000) sent to openai/gpt-5.6-luna read the brand "WONSIM" as
 * "WESN" every time, at 14,144 prompt tokens. The same photo at 1280 px read WONSIM 3/3 at
 * 1,484 tokens; 1600 px and 2048 px misread it (card 21, 2026-10-07). The model's own
 * downscaling of a huge picture loses small text, so we do it first.
 *
 * Photos fit inside VISION_MAX_SIDE (default 1280). A tall or wide screenshot (sides more than
 * 2:1) keeps its short side at that size and its long side up to 4096, so its text survives.
 * Anything sharp cannot read, or that is already small enough, goes through unchanged.
 */
export const VISION_MAX_SIDE = Math.max(256, Number(process.env.VISION_MAX_SIDE) || 1280);
const LONG_SIDE_CAP = 4096;

export function visionTargetSize(width, height, maxSide = VISION_MAX_SIDE) {
  if (!width || !height) return null;
  const long = Math.max(width, height), short = Math.min(width, height);
  const scale = long / short > 2
    ? Math.min(1, maxSide / short, LONG_SIDE_CAP / long)
    : Math.min(1, maxSide / long);
  if (scale >= 1) return null;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function fitForVision(imageBuffer, mimeType = null, { maxSide = VISION_MAX_SIDE } = {}) {
  if (!Buffer.isBuffer(imageBuffer)) return { buffer: imageBuffer, mimeType, resized: false };
  try {
    const { default: sharp } = await import('sharp');
    // rotate() applies the EXIF orientation, so a phone photo is upright once the tag is gone.
    const meta = await sharp(imageBuffer).metadata();
    const turned = (meta.orientation || 1) >= 5;
    const w = turned ? meta.height : meta.width, h = turned ? meta.width : meta.height;
    const target = visionTargetSize(w, h, maxSide);
    if (!target) return { buffer: imageBuffer, mimeType, resized: false };
    const keepPng = meta.format === 'png' || meta.format === 'gif' || meta.format === 'webp';
    // kernel 'linear': sharp's default lanczos3 sharpens, and the sharpened lettering misread.
    // Same photo, 10 reads each on gpt-5.6-luna: lanczos3 3/10, mitchell 4/10, cubic 6/10,
    // linear 9/10 (twice), PIL's thumbnail 10/10 (2026-10-07).
    let img = sharp(imageBuffer).rotate().resize(target.width, target.height, { fit: 'fill', kernel: 'linear' });
    img = keepPng ? img.png() : img.jpeg({ quality: 90 });
    const buffer = await img.toBuffer();
    logger.info(`[vision] picture ${w}×${h} (${imageBuffer.length} B) shrunk to ${target.width}×${target.height} (${buffer.length} B) before reading`);
    return { buffer, mimeType: keepPng ? 'image/png' : 'image/jpeg', resized: true };
  } catch (err) {
    logger.debug(`[vision] picture sent as-is (${err.message})`);
    return { buffer: imageBuffer, mimeType, resized: false };
  }
}
