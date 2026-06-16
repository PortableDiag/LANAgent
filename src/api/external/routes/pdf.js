import { Router } from 'express';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import pdfParse from 'pdf-parse';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { hybridAuth } from '../middleware/hybridAuth.js';
import { upload, validateMagicBytes, validateMagicBytesArray, scanWithVirusTotal } from '../middleware/fileUpload.js';
import { generateDownloadToken } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

const OUTPUT_DIR = path.resolve('data/external-uploads');
const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB per file

function generateOutputPath(ext = '.pdf') {
  return path.join(OUTPUT_DIR, `${crypto.randomBytes(16).toString('hex')}${ext}`);
}

// Helper to clean up uploaded files on error
async function cleanupFiles(...paths) {
  for (const p of paths) {
    if (p) await fs.unlink(p).catch(() => {});
  }
}

// ── MERGE ──────────────────────────────────────────────────────────────────────
router.post('/merge',
  ...hybridAuth('pdf-toolkit', 5),
  upload.array('files', 20),
  validateMagicBytesArray,
  async (req, res) => {
    const files = req.files;
    const filePaths = files?.map(f => f.path) || [];

    if (!files || files.length < 2) {
      await cleanupFiles(...filePaths);
      return res.status(400).json({ success: false, error: 'At least 2 PDF files required' });
    }

    try {
      const mergedPdf = await PDFDocument.create();

      for (const file of files) {
        const pdfBytes = await fs.readFile(file.path);
        const sourcePdf = await PDFDocument.load(pdfBytes);
        const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
      }

      const mergedBytes = await mergedPdf.save();
      const outputPath = generateOutputPath();
      await fs.writeFile(outputPath, mergedBytes);

      // Clean up input files
      await cleanupFiles(...filePaths);

      const token = generateDownloadToken({
        filePath: outputPath,
        filename: 'merged.pdf',
        agentId: req.externalAgentId,
        maxDownloads: 3,
        expiresInMinutes: 60
      });

      res.json({
        success: true,
        downloadUrl: `/api/external/download/${token}`,
        filename: 'merged.pdf',
        pageCount: mergedPdf.getPageCount(),
        tokenExpires: '60 minutes',
        maxDownloads: 3
      });
    } catch (error) {
      await cleanupFiles(...filePaths);
      logger.error('PDF merge failed:', error);
      res.status(500).json({ success: false, error: 'PDF merge failed' });
    }
  }
);

// ── SPLIT ──────────────────────────────────────────────────────────────────────
router.post('/split',
  ...hybridAuth('pdf-toolkit', 5),
  upload.single('file'),
  validateMagicBytes,
  scanWithVirusTotal,
  async (req, res) => {
    const filePath = req.file?.path;
    const { pages } = req.body;

    if (!pages || typeof pages !== 'string') {
      await cleanupFiles(filePath);
      return res.status(400).json({ success: false, error: 'Missing pages parameter (e.g. "1-5,8,10-12")' });
    }

    try {
      const pdfBytes = await fs.readFile(filePath);
      const sourcePdf = await PDFDocument.load(pdfBytes);
      const totalPages = sourcePdf.getPageCount();

      // Parse page ranges like "1-5,8,10-12"
      const pageIndices = parsePageRanges(pages, totalPages);
      if (pageIndices.length === 0) {
        await cleanupFiles(filePath);
        return res.status(400).json({ success: false, error: `Invalid page range. Document has ${totalPages} pages.` });
      }

      const newPdf = await PDFDocument.create();
      const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices);
      copiedPages.forEach(page => newPdf.addPage(page));

      const newBytes = await newPdf.save();
      const outputPath = generateOutputPath();
      await fs.writeFile(outputPath, newBytes);
      await cleanupFiles(filePath);

      const token = generateDownloadToken({
        filePath: outputPath,
        filename: 'split.pdf',
        agentId: req.externalAgentId,
        maxDownloads: 3,
        expiresInMinutes: 60
      });

      res.json({
        success: true,
        downloadUrl: `/api/external/download/${token}`,
        filename: 'split.pdf',
        pageCount: newPdf.getPageCount(),
        originalPageCount: totalPages,
        tokenExpires: '60 minutes',
        maxDownloads: 3
      });
    } catch (error) {
      await cleanupFiles(filePath);
      logger.error('PDF split failed:', error);
      res.status(500).json({ success: false, error: 'PDF split failed' });
    }
  }
);

// ── COMPRESS ───────────────────────────────────────────────────────────────────
router.post('/compress',
  ...hybridAuth('pdf-toolkit', 5),
  upload.single('file'),
  validateMagicBytes,
  scanWithVirusTotal,
  async (req, res) => {
    const filePath = req.file?.path;
    const { quality = 'ebook' } = req.body;

    const qualitySettings = {
      screen: '/screen',        // lowest quality, smallest size
      ebook: '/ebook',          // medium quality
      printer: '/printer'       // high quality
    };

    if (!qualitySettings[quality]) {
      await cleanupFiles(filePath);
      return res.status(400).json({ success: false, error: 'quality must be screen, ebook, or printer' });
    }

    try {
      const originalSize = (await fs.stat(filePath)).size;
      const outputPath = generateOutputPath();

      await new Promise((resolve, reject) => {
        execFile('gs', [
          '-sDEVICE=pdfwrite',
          `-dPDFSETTINGS=${qualitySettings[quality]}`,
          '-dNOPAUSE',
          '-dQUIET',
          '-dBATCH',
          '-dCompatibilityLevel=1.4',
          `-sOutputFile=${outputPath}`,
          filePath
        ], { timeout: 120000 }, (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr || error.message));
          resolve();
        });
      });

      const compressedSize = (await fs.stat(outputPath)).size;
      await cleanupFiles(filePath);

      const token = generateDownloadToken({
        filePath: outputPath,
        filename: 'compressed.pdf',
        agentId: req.externalAgentId,
        maxDownloads: 3,
        expiresInMinutes: 60
      });

      res.json({
        success: true,
        downloadUrl: `/api/external/download/${token}`,
        filename: 'compressed.pdf',
        originalSize,
        compressedSize,
        reduction: `${Math.round((1 - compressedSize / originalSize) * 100)}%`,
        tokenExpires: '60 minutes',
        maxDownloads: 3
      });
    } catch (error) {
      await cleanupFiles(filePath);
      logger.error('PDF compress failed:', error);
      res.status(500).json({ success: false, error: 'PDF compression failed' });
    }
  }
);

// ── WATERMARK ──────────────────────────────────────────────────────────────────
router.post('/watermark',
  ...hybridAuth('pdf-toolkit', 5),
  upload.single('file'),
  validateMagicBytes,
  scanWithVirusTotal,
  async (req, res) => {
    const filePath = req.file?.path;
    const { text, opacity = 0.3, position = 'center' } = req.body;

    if (!text || typeof text !== 'string' || text.length > 200) {
      await cleanupFiles(filePath);
      return res.status(400).json({ success: false, error: 'Missing or invalid text parameter (max 200 chars)' });
    }

    const parsedOpacity = Math.min(Math.max(parseFloat(opacity) || 0.3, 0.05), 1.0);

    try {
      const pdfBytes = await fs.readFile(filePath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const pages = pdfDoc.getPages();

      for (const page of pages) {
        const { width, height } = page.getSize();
        const fontSize = Math.min(width, height) / 12;
        const textWidth = font.widthOfTextAtSize(text, fontSize);

        let x, y;
        switch (position) {
          case 'top-left':
            x = 50; y = height - 50;
            break;
          case 'top-right':
            x = width - textWidth - 50; y = height - 50;
            break;
          case 'bottom-left':
            x = 50; y = 50;
            break;
          case 'bottom-right':
            x = width - textWidth - 50; y = 50;
            break;
          case 'center':
          default:
            x = (width - textWidth) / 2; y = height / 2;
            break;
        }

        page.drawText(text, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.5, 0.5, 0.5),
          opacity: parsedOpacity,
          rotate: position === 'center' ? degrees(-45) : degrees(0)
        });
      }

      const watermarkedBytes = await pdfDoc.save();
      const outputPath = generateOutputPath();
      await fs.writeFile(outputPath, watermarkedBytes);
      await cleanupFiles(filePath);

      const token = generateDownloadToken({
        filePath: outputPath,
        filename: 'watermarked.pdf',
        agentId: req.externalAgentId,
        maxDownloads: 3,
        expiresInMinutes: 60
      });

      res.json({
        success: true,
        downloadUrl: `/api/external/download/${token}`,
        filename: 'watermarked.pdf',
        pagesWatermarked: pages.length,
        tokenExpires: '60 minutes',
        maxDownloads: 3
      });
    } catch (error) {
      await cleanupFiles(filePath);
      logger.error('PDF watermark failed:', error);
      res.status(500).json({ success: false, error: 'PDF watermarking failed' });
    }
  }
);

// ── EXTRACT (aliased as /text for gateway compatibility) ──────────────────────
const extractMiddleware = [...hybridAuth('pdf-toolkit', 5), upload.single('file'), validateMagicBytes, scanWithVirusTotal];
const extractHandler = async (req, res) => {
  let filePath = req.file?.path;
  let tmpFile = null;
  const { format = 'text' } = req.body;

  // Support JSON body with fileBase64 or fileUrl (gateway sends JSON, not multipart)
  if (!filePath) {
    try {
      if (req.body.fileBase64) {
        tmpFile = generateOutputPath('.pdf');
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        await fs.writeFile(tmpFile, Buffer.from(req.body.fileBase64, 'base64'));
        filePath = tmpFile;
      } else if (req.body.fileUrl) {
        const axios = (await import('axios')).default;
        const resp = await axios.get(req.body.fileUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: MAX_PDF_SIZE });
        tmpFile = generateOutputPath('.pdf');
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        await fs.writeFile(tmpFile, resp.data);
        filePath = tmpFile;
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: `Failed to fetch file: ${err.message}` });
    }
  }

  if (!filePath) {
    return res.status(400).json({ success: false, error: 'File required — upload via multipart, or provide fileBase64 or fileUrl in JSON body' });
  }

  if (!['text', 'json'].includes(format)) {
    await cleanupFiles(filePath);
    return res.status(400).json({ success: false, error: 'format must be text or json' });
  }

  try {
    const pdfBytes = await fs.readFile(filePath);
    const parsed = await pdfParse(pdfBytes);
    await cleanupFiles(filePath);

    if (format === 'json') {
      res.json({
        success: true,
        text: parsed.text,
        pages: parsed.numpages,
        metadata: {
          title: parsed.info?.Title || null,
          author: parsed.info?.Author || null,
          creator: parsed.info?.Creator || null,
          producer: parsed.info?.Producer || null,
          creationDate: parsed.info?.CreationDate || null
        }
      });
    } else {
      res.json({
        success: true,
        text: parsed.text,
        pages: parsed.numpages
      });
    }
  } catch (error) {
    await cleanupFiles(filePath);
    logger.error('PDF extract failed:', error);
    res.status(500).json({ success: false, error: 'PDF text extraction failed' });
  }
};

router.post('/extract', ...extractMiddleware, extractHandler);
router.post('/text', ...extractMiddleware, extractHandler);

// ── ANNOTATE ───────────────────────────────────────────────────────────────────
router.post('/annotate',
  ...hybridAuth('pdf-toolkit', 5),
  upload.single('file'),
  validateMagicBytes,
  scanWithVirusTotal,
  async (req, res) => {
    const filePath = req.file?.path;
    const { annotations } = req.body;

    if (!annotations || !Array.isArray(annotations)) {
      await cleanupFiles(filePath);
      return res.status(400).json({ success: false, error: 'Missing or invalid annotations parameter' });
    }

    try {
      const pdfBytes = await fs.readFile(filePath);
      const pdfDoc = await PDFDocument.load(pdfBytes);

      for (const annotation of annotations) {
        const { pageIndex, type, options } = annotation;
        const page = pdfDoc.getPage(pageIndex);

        switch (type) {
          case 'highlight':
            page.drawRectangle({
              ...options,
              color: rgb(1, 1, 0),
              opacity: 0.5
            });
            break;
          case 'comment': {
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            page.drawText(options.text, {
              x: options.x,
              y: options.y,
              size: options.size || 12,
              font,
              color: rgb(0, 0, 0)
            });
            break;
          }
          case 'shape':
            page.drawRectangle(options);
            break;
          default:
            throw new Error(`Unsupported annotation type: ${type}`);
        }
      }

      const annotatedBytes = await pdfDoc.save();
      const outputPath = generateOutputPath();
      await fs.writeFile(outputPath, annotatedBytes);
      await cleanupFiles(filePath);

      const token = generateDownloadToken({
        filePath: outputPath,
        filename: 'annotated.pdf',
        agentId: req.externalAgentId,
        maxDownloads: 3,
        expiresInMinutes: 60
      });

      res.json({
        success: true,
        downloadUrl: `/api/external/download/${token}`,
        filename: 'annotated.pdf',
        tokenExpires: '60 minutes',
        maxDownloads: 3
      });
    } catch (error) {
      await cleanupFiles(filePath);
      logger.error('PDF annotation failed:', error);
      res.status(500).json({ success: false, error: 'PDF annotation failed' });
    }
  }
);

// ── HELPERS ────────────────────────────────────────────────────────────────────
function parsePageRanges(rangeStr, totalPages) {
  const indices = new Set();

  const parts = rangeStr.split(',').map(s => s.trim());
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      if (start < 1 || end > totalPages || start > end) continue;
      for (let i = start; i <= end; i++) {
        indices.add(i - 1); // 0-indexed
      }
    } else {
      const page = parseInt(part);
      if (page >= 1 && page <= totalPages) {
        indices.add(page - 1);
      }
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

export default router;
