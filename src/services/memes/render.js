/**
 * Draws meme text on a picture: white Anton with a black outline, wrapped and sized to fill each box.
 * Anton (SIL Open Font License, fonts/OFL.txt) stands in for Impact, which is Microsoft's.
 *
 * Text is drawn by sharp (libvips + pango), which takes the font file directly and fits the text to a width and
 * height. node-canvas was tried first: on both the dev box and ALICE it ignored every font size (measureText gave the
 * same width at 10 px and 80 px), so every caption came out tiny.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

export const FONT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts', 'Anton-Regular.ttf');

/** Box fractions {x,y,w,h} (0..1) for `count` texts with no known layout: top and bottom, else even bands. */
export function defaultBoxes(count) {
  if (count <= 1) return [{ x: 0.03, y: 0.02, w: 0.94, h: 0.2 }];
  if (count === 2) return [{ x: 0.03, y: 0.02, w: 0.94, h: 0.2 }, { x: 0.03, y: 0.78, w: 0.94, h: 0.2 }];
  return Array.from({ length: count }, (_, i) => ({ x: 0.03, y: i / count + 0.01, w: 0.94, h: 1 / count - 0.02 }));
}

/** A named spot ("top", "bottom", "center", "top-left", ...) as a box. */
export function namedBox(name) {
  const n = String(name || '').toLowerCase().replace(/[\s_]+/g, '-');
  const col = n.includes('left') ? { x: 0.02, w: 0.46 } : n.includes('right') ? { x: 0.52, w: 0.46 } : { x: 0.03, w: 0.94 };
  const row = n.startsWith('bottom') ? { y: 0.78, h: 0.2 } : n.startsWith('center') || n === 'middle' ? { y: 0.4, h: 0.2 } : { y: 0.02, h: 0.2 };
  return { ...col, ...row };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One caption as an RGBA PNG no bigger than w×h: the text fitted to the box, outlined unless `plain`. */
async function caption(text, w, h, { color, plain, align = 'centre' }) {
  const pad = plain ? 0 : Math.max(2, Math.round(Math.min(w, h) / 40));
  const textOpts = (fg) => ({
    text: `<span foreground="${fg}">${esc(text)}</span>`, font: 'Anton', fontfile: FONT_FILE,
    width: Math.max(10, w - 2 * pad), height: Math.max(10, h - 2 * pad), rgba: true, align, wrap: 'word', spacing: 0
  });
  const fill = await sharp({ text: textOpts(color || (plain ? '#111111' : '#ffffff')) }).png().toBuffer({ resolveWithObject: true });
  const tw = fill.info.width, th = fill.info.height;
  if (plain) return { buffer: fill.data, width: tw, height: th };
  // Outline: the same text in black, stamped around the fill in a ring.
  const outline = await sharp({ text: textOpts('#000000') }).png().toBuffer();
  const r = Math.max(2, Math.round(Math.min(w, h) / 40));
  const ring = [];
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * 2 * Math.PI;
    ring.push({ input: outline, left: Math.round(pad + r * Math.cos(ang)), top: Math.round(pad + r * Math.sin(ang)) });
  }
  const W = tw + 2 * pad, H = th + 2 * pad;
  const buffer = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([...ring, { input: fill.data, left: pad, top: pad }]).png().toBuffer();
  return { buffer, width: W, height: H };
}

/**
 * Render a meme. `image` is a Buffer; `texts` is [{ text, box:{x,y,w,h} (fractions), align?, valign?, color?, style? }].
 * Returns { buffer, width, height, format }.
 */
export async function renderMeme(image, texts, { format = 'jpeg', maxSide = 1200, uppercase = true, quality = 88 } = {}) {
  const base = sharp(image).rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
  const { data: baseBuf, info } = await base.toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const layers = [];
  for (const t of texts) {
    const raw = String(t.text ?? '').trim();
    if (!raw) continue;
    const b = t.box;
    const bw = Math.round(b.w * W), bh = Math.round(b.h * H);
    const align = t.align === 'left' ? 'left' : t.align === 'right' ? 'right' : 'centre';
    const c = await caption(uppercase ? raw.toUpperCase() : raw, bw, bh, { color: t.color, plain: t.style === 'plain', align });
    const vAlign = t.valign || (b.y + b.h / 2 < 0.34 ? 'top' : b.y + b.h / 2 > 0.66 ? 'bottom' : 'middle');
    const left = Math.round(b.x * W + (align === 'left' ? 0 : align === 'right' ? bw - c.width : (bw - c.width) / 2));
    const top = Math.round(b.y * H + (vAlign === 'top' ? 0 : vAlign === 'bottom' ? bh - c.height : (bh - c.height) / 2));
    layers.push({ input: c.buffer, left: Math.max(0, Math.min(W - c.width, left)), top: Math.max(0, Math.min(H - c.height, top)) });
  }
  const fmt = String(format).toLowerCase() === 'png' ? 'png' : 'jpeg';
  let out = sharp(baseBuf).composite(layers);
  out = fmt === 'png' ? out.png() : out.jpeg({ quality, mozjpeg: true });
  return { buffer: await out.toBuffer(), width: W, height: H, format: fmt };
}
