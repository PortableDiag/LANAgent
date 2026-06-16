import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';
import { parseStringPromise } from 'xml2js';
import crypto from 'node:crypto';

const webLoaderCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

/**
 * Deterministic content fingerprint + stable document ID for idempotency/dedup.
 * Use a stable `source` (file path, URL, or `${path}#page=N` style) so two loads
 * of the same content + source produce identical IDs.
 */
function computeFingerprint(content, source) {
  const hash = crypto.createHash('sha256').update(String(content)).digest('hex');
  return { hash, documentId: `${source}#${hash}` };
}

/**
 * Document representation with content and metadata
 */
export class Document {
  constructor(content, metadata = {}) {
    this.pageContent = content;
    this.metadata = {
      ...metadata,
      loadedAt: new Date().toISOString()
    };
  }
}

/**
 * Base DocumentLoader class - abstract interface for loading documents
 */
export class DocumentLoader {
  constructor(options = {}) {
    this.options = options;
  }

  async load() {
    throw new Error('load() must be implemented by subclass');
  }

  async loadAndSplit(splitter) {
    const docs = await this.load();
    if (splitter) {
      return splitter.splitDocuments(docs);
    }
    return docs;
  }
}

/**
 * TextLoader - Load plain text files
 */
export class TextLoader extends DocumentLoader {
  constructor(filePath, options = {}) {
    super(options);
    this.filePath = filePath;
  }

  async load() {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const stats = await fs.stat(this.filePath);

      const { hash, documentId } = computeFingerprint(content, this.filePath);
      return [new Document(content, {
        source: this.filePath,
        filename: path.basename(this.filePath),
        type: 'text',
        size: stats.size,
        modified: stats.mtime.toISOString(),
        hash,
        documentId
      })];
    } catch (error) {
      logger.error(`TextLoader error for ${this.filePath}:`, error.message);
      throw error;
    }
  }
}

/**
 * PDFLoader - Load PDF files using pdf-parse
 */
export class PDFLoader extends DocumentLoader {
  constructor(filePath, options = {}) {
    super(options);
    this.filePath = filePath;
    this.splitPages = options.splitPages !== false;
  }

  async load() {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const dataBuffer = await fs.readFile(this.filePath);
      const data = await pdfParse(dataBuffer);

      const metadata = {
        source: this.filePath,
        filename: path.basename(this.filePath),
        type: 'pdf',
        pages: data.numpages,
        info: data.info
      };

      if (this.splitPages && data.numpages > 1) {
        // Split by page markers if possible
        const pages = data.text.split(/\f|\n{3,}/);
        return pages.map((pageContent, index) => {
          const trimmed = pageContent.trim();
          if (!trimmed) return null;
          const pageSource = `${this.filePath}#page=${index + 1}`;
          const { hash, documentId } = computeFingerprint(trimmed, pageSource);
          return new Document(trimmed, { ...metadata, page: index + 1, hash, documentId });
        }).filter(doc => doc && doc.pageContent.length > 0);
      }

      const { hash, documentId } = computeFingerprint(data.text, this.filePath);
      return [new Document(data.text, { ...metadata, hash, documentId })];
    } catch (error) {
      logger.error(`PDFLoader error for ${this.filePath}:`, error.message);
      throw error;
    }
  }
}

/**
 * WebLoader - Load content from URLs
 */
export class WebLoader extends DocumentLoader {
  constructor(url, options = {}) {
    super(options);
    this.url = url;
    this.selector = options.selector || 'body';
    this.removeSelectors = options.removeSelectors || ['script', 'style', 'nav', 'footer', 'header', 'aside'];
    this.timeout = options.timeout || 30000;
  }

  async load() {
    try {
      const cached = webLoaderCache.get(this.url);
      if (cached) {
        return [new Document(cached.content, cached.metadata)];
      }

      const response = await retryOperation(() => axios.get(this.url, {
        timeout: this.timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LANAgent/1.0; +https://github.com/lanagent)'
        }
      }), { retries: 3, minTimeout: 1000 });

      const $ = cheerio.load(response.data);

      // Remove unwanted elements
      this.removeSelectors.forEach(selector => $(selector).remove());

      // Extract text content
      const content = $(this.selector).text().replace(/\s+/g, ' ').trim();

      // Extract title
      const title = $('title').text().trim() || $('h1').first().text().trim();

      // Extract meta description
      const description = $('meta[name="description"]').attr('content') || '';

      const { hash, documentId } = computeFingerprint(content, this.url);
      const metadata = {
        source: this.url,
        type: 'web',
        title,
        description,
        contentType: response.headers['content-type'],
        hash,
        documentId
      };

      webLoaderCache.set(this.url, { content, metadata });

      return [new Document(content, metadata)];
    } catch (error) {
      logger.error(`WebLoader error for ${this.url}:`, error.message);
      throw error;
    }
  }
}

/**
 * MarkdownLoader - Load markdown files with frontmatter support
 */
export class MarkdownLoader extends DocumentLoader {
  constructor(filePath, options = {}) {
    super(options);
    this.filePath = filePath;
  }

  async load() {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const stats = await fs.stat(this.filePath);

      // Extract frontmatter if present
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let metadata = {
        source: this.filePath,
        filename: path.basename(this.filePath),
        type: 'markdown',
        size: stats.size,
        modified: stats.mtime.toISOString()
      };

      let bodyContent = content;

      if (frontmatterMatch) {
        try {
          // Simple YAML-like parsing for frontmatter
          const frontmatter = {};
          frontmatterMatch[1].split('\n').forEach(line => {
            const [key, ...valueParts] = line.split(':');
            if (key && valueParts.length > 0) {
              frontmatter[key.trim()] = valueParts.join(':').trim();
            }
          });
          metadata = { ...metadata, ...frontmatter };
          bodyContent = frontmatterMatch[2];
        } catch {
          // Ignore frontmatter parsing errors
        }
      }

      // Extract headings for structure metadata
      const headings = [];
      const headingRegex = /^(#{1,6})\s+(.+)$/gm;
      let match;
      while ((match = headingRegex.exec(bodyContent)) !== null) {
        headings.push({
          level: match[1].length,
          text: match[2]
        });
      }

      if (headings.length > 0) {
        metadata.headings = headings;
        metadata.title = metadata.title || headings[0]?.text;
      }

      {
        const { hash, documentId } = computeFingerprint(bodyContent, this.filePath);
        return [new Document(bodyContent, { ...metadata, hash, documentId })];
      }
    } catch (error) {
      logger.error(`MarkdownLoader error for ${this.filePath}:`, error.message);
      throw error;
    }
  }
}

/**
 * JSONLoader - Load JSON files with optional key extraction
 */
export class JSONLoader extends DocumentLoader {
  constructor(filePath, options = {}) {
    super(options);
    this.filePath = filePath;
    this.contentKey = options.contentKey; // Key to extract as content (optional)
    this.metadataKeys = options.metadataKeys || []; // Keys to extract as metadata
  }

  async load() {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content);
      const stats = await fs.stat(this.filePath);

      const baseMetadata = {
        source: this.filePath,
        filename: path.basename(this.filePath),
        type: 'json',
        size: stats.size,
        modified: stats.mtime.toISOString()
      };

      // If it's an array, create a document for each item
      if (Array.isArray(data)) {
        return data.map((item, index) => {
          const itemContent = this.contentKey && item[this.contentKey]
            ? String(item[this.contentKey])
            : JSON.stringify(item, null, 2);

          const itemMetadata = { ...baseMetadata, index };
          this.metadataKeys.forEach(key => {
            if (item[key] !== undefined) {
              itemMetadata[key] = item[key];
            }
          });

          {
            const itemSource = `${this.filePath}#index=${index}`;
            const { hash, documentId } = computeFingerprint(itemContent, itemSource);
            return new Document(itemContent, { ...itemMetadata, hash, documentId });
          }
        });
      }

      // Single object
      const docContent = this.contentKey && data[this.contentKey]
        ? String(data[this.contentKey])
        : JSON.stringify(data, null, 2);

      const docMetadata = { ...baseMetadata };
      this.metadataKeys.forEach(key => {
        if (data[key] !== undefined) {
          docMetadata[key] = data[key];
        }
      });

      {
        const { hash, documentId } = computeFingerprint(docContent, this.filePath);
        return [new Document(docContent, { ...docMetadata, hash, documentId })];
      }
    } catch (error) {
      logger.error(`JSONLoader error for ${this.filePath}:`, error.message);
      throw error;
    }
  }
}

/**
 * XMLLoader - Load and process XML files
 */
export class XMLLoader extends DocumentLoader {
  constructor(filePath, options = {}) {
    super(options);
    this.filePath = filePath;
  }

  async load() {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const data = await parseStringPromise(content);
      const stats = await fs.stat(this.filePath);

      const metadata = {
        source: this.filePath,
        filename: path.basename(this.filePath),
        type: 'xml',
        size: stats.size,
        modified: stats.mtime.toISOString()
      };

      {
        const stringified = JSON.stringify(data, null, 2);
        const { hash, documentId } = computeFingerprint(stringified, this.filePath);
        return [new Document(stringified, { ...metadata, hash, documentId })];
      }
    } catch (error) {
      logger.error(`XMLLoader error for ${this.filePath}:`, error.message);
      throw error;
    }
  }
}

/**
 * DirectoryLoader - Load all files from a directory
 */
export class DirectoryLoader extends DocumentLoader {
  constructor(dirPath, options = {}) {
    super(options);
    this.dirPath = dirPath;
    this.glob = options.glob || '**/*';
    this.recursive = options.recursive !== false;
    this.loaderMapping = options.loaderMapping || {
      '.txt': TextLoader,
      '.md': MarkdownLoader,
      '.pdf': PDFLoader,
      '.json': JSONLoader,
      '.xml': XMLLoader
    };
  }

  async load() {
    const documents = [];

    const loadDir = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && this.recursive) {
          await loadDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const LoaderClass = this.loaderMapping[ext];

          if (LoaderClass) {
            try {
              const loader = new LoaderClass(fullPath, this.options);
              const docs = await loader.load();
              documents.push(...docs);
            } catch (error) {
              logger.warn(`Skipping ${fullPath}: ${error.message}`);
            }
          }
        }
      }
    };

    await loadDir(this.dirPath);
    return documents;
  }
}

/**
 * Auto-detect loader based on source type
 */
export function createLoader(source, options = {}) {
  // URL
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return new WebLoader(source, options);
  }

  // File path
  const ext = path.extname(source).toLowerCase();

  switch (ext) {
    case '.pdf':
      return new PDFLoader(source, options);
    case '.md':
    case '.markdown':
      return new MarkdownLoader(source, options);
    case '.json':
      return new JSONLoader(source, options);
    case '.xml':
      return new XMLLoader(source, options);
    case '.txt':
    default:
      return new TextLoader(source, options);
  }
}

export default {
  Document,
  DocumentLoader,
  TextLoader,
  PDFLoader,
  WebLoader,
  MarkdownLoader,
  JSONLoader,
  XMLLoader,
  DirectoryLoader,
  createLoader
};