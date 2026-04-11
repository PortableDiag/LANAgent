import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { logger } from '../../../utils/logger.js';

const UPLOAD_DIR = path.resolve('data/external-uploads');
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
const FILE_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours

const ALLOWED_MIMES = new Set([
  'audio/mpeg', 'audio/wav', 'audio/flac',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  'application/pdf',
  'image/png', 'image/jpeg', 'image/tiff'
]);

// Magic byte signatures (first bytes of known formats)
const MAGIC_BYTES = {
  'application/pdf': [Buffer.from('%PDF')],
  'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  'image/jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
  'image/tiff': [Buffer.from([0x49, 0x49, 0x2A, 0x00]), Buffer.from([0x4D, 0x4D, 0x00, 0x2A])],
  'audio/mpeg': [Buffer.from([0xFF, 0xFB]), Buffer.from([0xFF, 0xF3]), Buffer.from([0xFF, 0xF2]), Buffer.from('ID3')],
  'audio/wav': [Buffer.from('RIFF')],
  'audio/flac': [Buffer.from('fLaC')],
  'video/mp4': [Buffer.from([0x00, 0x00, 0x00]), Buffer.from('ftyp')], // offset 4
  'video/webm': [Buffer.from([0x1A, 0x45, 0xDF, 0xA3])],
  'video/quicktime': [Buffer.from([0x00, 0x00, 0x00]), Buffer.from('ftyp')],
  'video/x-matroska': [Buffer.from([0x1A, 0x45, 0xDF, 0xA3])]
};

// Ensure upload directory exists
try {
  fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (e) {
  logger.error('Failed to create external uploads directory:', e);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const randomName = crypto.randomBytes(16).toString('hex');
    cb(null, `${randomName}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIMES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} not allowed`), false);
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
});

export const uploadArray = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
}).array('files', 20);

export async function validateMagicBytes(req, res, next) {
  if (!req.file) {
    // Allow JSON body with fileBase64 or fileUrl (gateway sends JSON, not multipart)
    if (req.body?.fileBase64 || req.body?.fileUrl) return next();
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const { path: filePath, mimetype } = req.file;

  try {
    const fd = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(16);
    await fd.read(buf, 0, 16, 0);
    await fd.close();

    const signatures = MAGIC_BYTES[mimetype];
    if (signatures) {
      const matched = signatures.some(sig => {
        // For MP4/QuickTime, check 'ftyp' at offset 4
        if (mimetype.includes('mp4') || mimetype === 'video/quicktime') {
          return buf.subarray(4, 8).toString() === 'ftyp';
        }
        return buf.subarray(0, sig.length).equals(sig);
      });

      if (!matched) {
        await fs.unlink(filePath).catch(() => {});
        return res.status(400).json({
          success: false,
          error: 'File content does not match declared type'
        });
      }
    }

    next();
  } catch (error) {
    await fs.unlink(filePath).catch(() => {});
    logger.error('Magic byte validation error:', error);
    res.status(500).json({ success: false, error: 'File validation failed' });
  }
}

export async function validateMagicBytesArray(req, res, next) {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, error: 'No files uploaded' });
  }

  try {
    for (const file of req.files) {
      const { path: filePath, mimetype } = file;
      const fd = await fs.open(filePath, 'r');
      const buf = Buffer.alloc(16);
      await fd.read(buf, 0, 16, 0);
      await fd.close();

      const signatures = MAGIC_BYTES[mimetype];
      if (signatures) {
        const matched = signatures.some(sig => {
          if (mimetype.includes('mp4') || mimetype === 'video/quicktime') {
            return buf.subarray(4, 8).toString() === 'ftyp';
          }
          return buf.subarray(0, sig.length).equals(sig);
        });

        if (!matched) {
          // Clean up all uploaded files
          for (const f of req.files) {
            await fs.unlink(f.path).catch(() => {});
          }
          return res.status(400).json({
            success: false,
            error: `File "${file.originalname}" content does not match declared type`
          });
        }
      }
    }

    next();
  } catch (error) {
    for (const f of req.files) {
      await fs.unlink(f.path).catch(() => {});
    }
    logger.error('Magic byte array validation error:', error);
    res.status(500).json({ success: false, error: 'File validation failed' });
  }
}

export async function scanWithVirusTotal(req, res, next) {
  if (!req.file) return next();

  const filePath = req.file.path;
  const fileSize = req.file.size;

  // Only scan files under 32MB (VT free API limit)
  if (fileSize > 32 * 1024 * 1024) {
    logger.info(`Skipping VT scan for ${req.file.filename} (${fileSize} bytes > 32MB limit)`);
    return next();
  }

  try {
    const vtPlugin = req.app.locals.agent?.apiManager?.apis?.get('virustotal');
    if (!vtPlugin) {
      logger.debug('VirusTotal plugin not available, skipping scan');
      return next();
    }

    // Hash file and check against VT database
    const fileData = await fs.readFile(filePath);
    const hash = crypto.createHash('sha256').update(fileData).digest('hex');

    const result = await vtPlugin.execute({ action: 'scanHash', hash });

    if (result.success && result.malicious) {
      await fs.unlink(filePath).catch(() => {});
      logger.warn(`VirusTotal flagged file as malicious: ${req.file.filename} (hash: ${hash})`);
      return res.status(400).json({
        success: false,
        error: 'File flagged as potentially malicious'
      });
    }

    next();
  } catch (error) {
    // Don't block on VT scan failure — log and continue
    logger.warn('VirusTotal scan failed, proceeding:', error.message);
    next();
  }
}

// Auto-cleanup old uploads
function startCleanupInterval() {
  setInterval(async () => {
    try {
      const files = await fs.readdir(UPLOAD_DIR);
      const now = Date.now();
      let deleted = 0;

      for (const file of files) {
        const fullPath = path.join(UPLOAD_DIR, file);
        try {
          const stat = await fs.stat(fullPath);
          if (now - stat.mtimeMs > FILE_MAX_AGE) {
            await fs.unlink(fullPath);
            deleted++;
          }
        } catch (e) {
          // File may have been deleted already
        }
      }

      if (deleted > 0) {
        logger.info(`Cleaned up ${deleted} expired upload(s) from external-uploads`);
      }
    } catch (error) {
      logger.error('Upload cleanup error:', error);
    }
  }, CLEANUP_INTERVAL);
}

startCleanupInterval();
