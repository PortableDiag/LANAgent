import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { hybridAuth } from '../middleware/hybridAuth.js';
import { upload, validateMagicBytes, validateMagicBytesArray, scanWithVirusTotal } from '../middleware/fileUpload.js';
import { logger } from '../../../utils/logger.js';
import { safePromiseAll } from '../../../utils/errorHandlers.js';

const router = Router();

/**
 * Write base64 or URL content to a temp file for processing
 */
async function resolveFileInput(body) {
  // Determine file extension from URL or explicit parameter
  let ext = body.fileExtension || '';
  if (!ext && body.fileUrl) {
    const urlPath = new URL(body.fileUrl).pathname;
    ext = path.extname(urlPath) || '';
  }
  if (!ext && body.contentType) {
    const mimeMap = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/tiff': '.tiff' };
    ext = mimeMap[body.contentType] || '';
  }

  if (body.fileBase64) {
    const tmpPath = path.join(os.tmpdir(), `doc-${crypto.randomBytes(8).toString('hex')}${ext}`);
    await fs.writeFile(tmpPath, Buffer.from(body.fileBase64, 'base64'));
    return tmpPath;
  }
  if (body.fileUrl) {
    const axios = (await import('axios')).default;
    const resp = await axios.get(body.fileUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 50 * 1024 * 1024 });
    // Try to get extension from Content-Type if not from URL
    if (!ext && resp.headers['content-type']) {
      const ct = resp.headers['content-type'].split(';')[0].trim();
      const mimeMap = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/tiff': '.tiff' };
      ext = mimeMap[ct] || '';
    }
    const tmpPath = path.join(os.tmpdir(), `doc-${crypto.randomBytes(8).toString('hex')}${ext}`);
    await fs.writeFile(tmpPath, resp.data);
    return tmpPath;
  }
  return null;
}

router.post('/process',
  ...hybridAuth('document-processing', 10),
  upload.single('file'),
  validateMagicBytes,
  scanWithVirusTotal,
  async (req, res) => {
    const { operation = 'ocr', language = 'eng', outputFormat = 'json' } = req.body;

    if (!['ocr', 'extract'].includes(operation)) {
      return res.status(400).json({ success: false, error: 'operation must be ocr or extract' });
    }

    let tmpFile = null;
    try {
      const docEntry = req.app.locals.agent?.apiManager?.apis?.get('documentIntelligence');
      const docPlugin = docEntry?.instance || docEntry;
      if (!docPlugin?.execute) {
        return res.status(503).json({ success: false, error: 'Document processing service not available' });
      }

      // Support multipart file upload OR JSON body with fileBase64/fileUrl
      let filePath = req.file?.path;
      if (!filePath) {
        tmpFile = await resolveFileInput(req.body);
        filePath = tmpFile;
      }
      if (!filePath) {
        return res.status(400).json({ success: false, error: 'File required — upload via multipart, or provide fileBase64 or fileUrl in JSON body' });
      }

      const action = operation === 'extract' ? 'extractStructuredData' : 'processDocument';
      const params = {
        action,
        filePath,
        language,
        outputFormat
      };

      const result = await docPlugin.execute(params);

      if (!result.success) {
        return res.status(500).json({ success: false, error: result.error || 'Document processing failed' });
      }

      // Return inline JSON (text results are small)
      const response = { success: true };

      if (action === 'processDocument') {
        response.ocr = result.ocr;
        response.content = result.content;
        response.analysis = result.analysis;
        response.outputFormat = result.outputFormat;
      } else {
        response.documentType = result.documentType;
        response.structuredData = result.structuredData;
        response.confidence = result.confidence;
      }

      if (tmpFile) fs.unlink(tmpFile).catch(() => {});
      res.json(response);
    } catch (error) {
      if (tmpFile) fs.unlink(tmpFile).catch(() => {});
      logger.error('Document processing failed:', error);
      res.status(500).json({ success: false, error: 'Document processing failed' });
    }
  }
);

router.post('/process/batch',
  externalAuthMiddleware,
  paymentMiddleware('document-processing'),
  upload.array('files', 10),
  validateMagicBytesArray,
  async (req, res) => {
    const { operation = 'ocr', language = 'eng', outputFormat = 'json' } = req.body;

    if (!['ocr', 'extract'].includes(operation)) {
      return res.status(400).json({ success: false, error: 'operation must be ocr or extract' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    try {
      const docEntry = req.app.locals.agent?.apiManager?.apis?.get('documentIntelligence');
      const docPlugin = docEntry?.instance || docEntry;
      if (!docPlugin?.execute) {
        return res.status(503).json({ success: false, error: 'Document processing service not available' });
      }

      const action = operation === 'extract' ? 'extractStructuredData' : 'processDocument';

      const results = await safePromiseAll(req.files.map(file => {
        const params = { action, filePath: file.path, language, outputFormat };
        return docPlugin.execute(params);
      }));

      const aggregatedResults = results.map((result, index) => {
        if (!result.success) {
          return { success: false, fileName: req.files[index].originalname, error: result.error || 'Document processing failed' };
        }

        const response = { success: true, fileName: req.files[index].originalname };
        if (action === 'processDocument') {
          response.ocr = result.ocr;
          response.content = result.content;
          response.analysis = result.analysis;
          response.outputFormat = result.outputFormat;
        } else {
          response.documentType = result.documentType;
          response.structuredData = result.structuredData;
          response.confidence = result.confidence;
        }
        return response;
      });

      res.json({ success: true, results: aggregatedResults });
    } catch (error) {
      logger.error('Batch document processing failed:', error);
      res.status(500).json({ success: false, error: 'Batch document processing failed' });
    }
  }
);

export default router;
