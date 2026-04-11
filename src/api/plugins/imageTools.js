import { BasePlugin } from '../core/basePlugin.js';
import sharp from 'sharp';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

const MAX_INPUT_SIZE = 20 * 1024 * 1024; // 20MB max input
const MAX_DIMENSION = 8192; // max output dimension

/**
 * Image Tools Plugin
 *
 * Image processing operations powered by Sharp: optimize, resize, crop,
 * convert, watermark, metadata extraction, and multi-step transforms.
 * Accepts image via URL or base64. Returns processed image as base64.
 */
export default class ImageToolsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'imageTools';
    this.version = '1.0.0';
    this.description = 'Image processing — optimize, resize, crop, convert, watermark, metadata, transform';
    this.category = 'media';
    this.commands = [
      { command: 'optimize', description: 'Compress image with optional format conversion', usage: 'optimize({ url: "https://...", quality: 80, format: "webp", stripMetadata: true })', offerAsService: true },
      { command: 'resize', description: 'Resize image to target dimensions', usage: 'resize({ url: "https://...", width: 800, height: 600, fit: "cover", format: "webp" })', offerAsService: true },
      { command: 'crop', description: 'Crop image by region or smart crop', usage: 'crop({ url: "https://...", left: 100, top: 50, width: 400, height: 300 }) or crop({ url: "...", width: 400, height: 300, strategy: "attention" })', offerAsService: true },
      { command: 'convert', description: 'Convert image format (png, jpeg, webp, avif, tiff)', usage: 'convert({ url: "https://...", format: "avif", quality: 80 })', offerAsService: true },
      { command: 'watermark', description: 'Add text watermark to image', usage: 'watermark({ url: "https://...", text: "Copyright 2026", position: "bottom-right", opacity: 0.5, fontSize: 24 })', offerAsService: true },
      { command: 'metadata', description: 'Get image info (dimensions, format, size, EXIF)', usage: 'metadata({ url: "https://..." })', offerAsService: true },
      { command: 'transform', description: 'Apply multiple operations in one call', usage: 'transform({ url: "https://...", operations: [{ op: "resize", width: 800 }, { op: "blur", sigma: 3 }, { op: "grayscale" }] })', offerAsService: true }
    ];
  }

  async execute(params) {
    const { action, ...data } = params;
    switch (action) {
      case 'optimize': return this._optimize(data);
      case 'resize': return this._resize(data);
      case 'crop': return this._crop(data);
      case 'convert': return this._convert(data);
      case 'watermark': return this._watermark(data);
      case 'metadata': return this._metadata(data);
      case 'transform': return this._transform(data);
      default:
        return { success: false, error: `Unknown action: ${action}. Available: optimize, resize, crop, convert, watermark, metadata, transform` };
    }
  }

  /**
   * Fetch image from URL or decode base64 input. Returns a Buffer.
   */
  async _getImageBuffer(params) {
    if (params.url) {
      const resp = await axios.get(params.url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: MAX_INPUT_SIZE,
        headers: { 'User-Agent': 'LANAgent-ImageTools/1.0' }
      });
      return Buffer.from(resp.data);
    }
    if (params.base64 || params.imageBase64) {
      const b64 = params.base64 || params.imageBase64;
      // Strip data URI prefix if present
      const raw = b64.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(raw, 'base64');
      if (buf.length > MAX_INPUT_SIZE) throw new Error(`Image exceeds ${MAX_INPUT_SIZE / 1024 / 1024}MB limit`);
      return buf;
    }
    throw new Error('Provide "url" or "base64" parameter with the image');
  }

  /**
   * Wrap result with base64 output and metadata
   */
  async _outputResult(pipeline, format, originalSize) {
    const outputBuffer = await pipeline.toBuffer();
    const info = await sharp(outputBuffer).metadata();

    return {
      success: true,
      data: {
        image: `data:image/${info.format || format || 'png'};base64,${outputBuffer.toString('base64')}`,
        format: info.format || format,
        width: info.width,
        height: info.height,
        size: outputBuffer.length,
        originalSize: originalSize || null,
        compressionRatio: originalSize ? Math.round((1 - outputBuffer.length / originalSize) * 100) + '%' : null
      }
    };
  }

  _clampDimension(val) {
    if (!val) return undefined;
    return Math.min(Math.max(1, Math.round(val)), MAX_DIMENSION);
  }

  _applyFormat(pipeline, format, quality) {
    const q = quality ? Math.min(100, Math.max(1, Math.round(quality))) : undefined;
    switch (format) {
      case 'jpeg': case 'jpg': return pipeline.jpeg({ quality: q || 80 });
      case 'png': return pipeline.png({ quality: q });
      case 'webp': return pipeline.webp({ quality: q || 80 });
      case 'avif': return pipeline.avif({ quality: q || 50 });
      case 'tiff': return pipeline.tiff({ quality: q || 80 });
      default: return pipeline;
    }
  }

  // --- Commands ---

  async _optimize(params) {
    try {
      const buf = await this._getImageBuffer(params);
      const format = params.format || 'webp';
      const quality = params.quality || 80;
      const stripMetadata = params.stripMetadata !== false;

      let pipeline = sharp(buf);
      if (stripMetadata) pipeline = pipeline.withMetadata(false);
      // Remove unnecessary metadata but keep orientation
      pipeline = this._applyFormat(pipeline, format, quality);

      return this._outputResult(pipeline, format, buf.length);
    } catch (err) {
      logger.error('[imageTools] optimize error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async _resize(params) {
    try {
      const buf = await this._getImageBuffer(params);
      const width = this._clampDimension(params.width);
      const height = this._clampDimension(params.height);
      if (!width && !height) return { success: false, error: 'Provide width and/or height' };

      const fit = ['cover', 'contain', 'fill', 'inside', 'outside'].includes(params.fit) ? params.fit : 'inside';
      const format = params.format;
      const quality = params.quality;

      let pipeline = sharp(buf).resize(width, height, {
        fit,
        withoutEnlargement: params.withoutEnlargement !== false
      });
      if (format) pipeline = this._applyFormat(pipeline, format, quality);

      return this._outputResult(pipeline, format, buf.length);
    } catch (err) {
      logger.error('[imageTools] resize error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async _crop(params) {
    try {
      const buf = await this._getImageBuffer(params);
      let pipeline = sharp(buf);

      if (params.strategy) {
        // Smart crop — attention or entropy based
        const strategy = params.strategy === 'entropy' ? sharp.strategy.entropy : sharp.strategy.attention;
        const width = this._clampDimension(params.width);
        const height = this._clampDimension(params.height);
        if (!width || !height) return { success: false, error: 'Smart crop requires both width and height' };
        pipeline = pipeline.resize(width, height, { fit: 'cover', position: strategy });
      } else {
        // Manual region crop
        const left = Math.max(0, Math.round(params.left || 0));
        const top = Math.max(0, Math.round(params.top || 0));
        const width = this._clampDimension(params.width);
        const height = this._clampDimension(params.height);
        if (!width || !height) return { success: false, error: 'Provide width and height for crop region' };
        pipeline = pipeline.extract({ left, top, width, height });
      }

      if (params.format) pipeline = this._applyFormat(pipeline, params.format, params.quality);

      return this._outputResult(pipeline, params.format, buf.length);
    } catch (err) {
      logger.error('[imageTools] crop error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async _convert(params) {
    try {
      const buf = await this._getImageBuffer(params);
      const format = params.format;
      if (!format) return { success: false, error: 'Provide target format: jpeg, png, webp, avif, tiff' };

      let pipeline = sharp(buf);
      pipeline = this._applyFormat(pipeline, format, params.quality);

      return this._outputResult(pipeline, format, buf.length);
    } catch (err) {
      logger.error('[imageTools] convert error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async _watermark(params) {
    try {
      const buf = await this._getImageBuffer(params);
      const text = params.text;
      if (!text) return { success: false, error: 'Provide "text" for watermark' };

      const meta = await sharp(buf).metadata();
      const fontSize = params.fontSize || Math.max(16, Math.round(Math.min(meta.width, meta.height) / 20));
      const opacity = Math.min(1, Math.max(0.05, params.opacity || 0.3));
      const color = params.color || 'white';
      const position = params.position || 'bottom-right';

      // Create SVG text overlay
      const padding = fontSize;
      const svgWidth = meta.width;
      const svgHeight = meta.height;

      // Calculate text position
      let x, y, anchor;
      switch (position) {
        case 'top-left': x = padding; y = padding + fontSize; anchor = 'start'; break;
        case 'top-right': x = svgWidth - padding; y = padding + fontSize; anchor = 'end'; break;
        case 'top-center': x = svgWidth / 2; y = padding + fontSize; anchor = 'middle'; break;
        case 'center': x = svgWidth / 2; y = svgHeight / 2; anchor = 'middle'; break;
        case 'bottom-left': x = padding; y = svgHeight - padding; anchor = 'start'; break;
        case 'bottom-center': x = svgWidth / 2; y = svgHeight - padding; anchor = 'middle'; break;
        case 'bottom-right': default: x = svgWidth - padding; y = svgHeight - padding; anchor = 'end'; break;
      }

      // Escape XML special chars in text
      const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const svg = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
        <text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}" text-anchor="${anchor}" font-weight="bold"
          stroke="black" stroke-width="1" stroke-opacity="${opacity * 0.5}">${safeText}</text>
      </svg>`;

      let pipeline = sharp(buf).composite([{
        input: Buffer.from(svg),
        gravity: 'northwest' // SVG is full-size, positioning is handled by the SVG coordinates
      }]);

      if (params.format) pipeline = this._applyFormat(pipeline, params.format, params.quality);

      return this._outputResult(pipeline, params.format, buf.length);
    } catch (err) {
      logger.error('[imageTools] watermark error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async _metadata(params) {
    try {
      const buf = await this._getImageBuffer(params);
      const meta = await sharp(buf).metadata();

      return {
        success: true,
        data: {
          format: meta.format,
          width: meta.width,
          height: meta.height,
          channels: meta.channels,
          colorSpace: meta.space,
          hasAlpha: meta.hasAlpha,
          orientation: meta.orientation,
          size: buf.length,
          density: meta.density || null,
          isProgressive: meta.isProgressive || false,
          exif: meta.exif ? true : false,
          icc: meta.icc ? true : false
        }
      };
    } catch (err) {
      logger.error('[imageTools] metadata error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async _transform(params) {
    try {
      const ops = params.operations;
      if (!ops || !Array.isArray(ops) || ops.length === 0) {
        return { success: false, error: 'Provide "operations" array, e.g. [{ op: "resize", width: 800 }, { op: "grayscale" }]' };
      }
      if (ops.length > 10) return { success: false, error: 'Maximum 10 operations per transform call' };

      const buf = await this._getImageBuffer(params);
      let pipeline = sharp(buf);
      let outputFormat = null;

      for (const step of ops) {
        switch (step.op) {
          case 'resize':
            pipeline = pipeline.resize(
              this._clampDimension(step.width),
              this._clampDimension(step.height),
              { fit: step.fit || 'inside', withoutEnlargement: step.withoutEnlargement !== false }
            );
            break;
          case 'crop':
            if (step.strategy) {
              const strategy = step.strategy === 'entropy' ? sharp.strategy.entropy : sharp.strategy.attention;
              pipeline = pipeline.resize(this._clampDimension(step.width), this._clampDimension(step.height), { fit: 'cover', position: strategy });
            } else {
              pipeline = pipeline.extract({
                left: Math.max(0, Math.round(step.left || 0)),
                top: Math.max(0, Math.round(step.top || 0)),
                width: this._clampDimension(step.width),
                height: this._clampDimension(step.height)
              });
            }
            break;
          case 'rotate':
            pipeline = pipeline.rotate(step.angle || 0, { background: step.background || { r: 0, g: 0, b: 0, alpha: 0 } });
            break;
          case 'flip':
            pipeline = pipeline.flip();
            break;
          case 'flop':
            pipeline = pipeline.flop();
            break;
          case 'sharpen':
            pipeline = pipeline.sharpen(step.sigma || 1);
            break;
          case 'blur':
            pipeline = pipeline.blur(Math.max(0.3, Math.min(100, step.sigma || 3)));
            break;
          case 'grayscale': case 'greyscale':
            pipeline = pipeline.grayscale();
            break;
          case 'negate':
            pipeline = pipeline.negate();
            break;
          case 'tint':
            if (step.r !== undefined && step.g !== undefined && step.b !== undefined) {
              pipeline = pipeline.tint({ r: step.r, g: step.g, b: step.b });
            }
            break;
          case 'trim':
            pipeline = pipeline.trim(step.threshold || 10);
            break;
          case 'flatten':
            pipeline = pipeline.flatten({ background: step.background || '#ffffff' });
            break;
          case 'format': case 'convert':
            outputFormat = step.format;
            pipeline = this._applyFormat(pipeline, step.format, step.quality);
            break;
          case 'stripMetadata':
            pipeline = pipeline.withMetadata(false);
            break;
          default:
            return { success: false, error: `Unknown operation: ${step.op}. Available: resize, crop, rotate, flip, flop, sharpen, blur, grayscale, negate, tint, trim, flatten, format, stripMetadata` };
        }
      }

      return this._outputResult(pipeline, outputFormat, buf.length);
    } catch (err) {
      logger.error('[imageTools] transform error:', err.message);
      return { success: false, error: err.message };
    }
  }
}
