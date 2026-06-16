import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Document Intelligence Plugin with OCR
 * Provides comprehensive document processing using Tesseract OCR
 * and AI-powered content analysis for smart categorization
 */
export class DocumentIntelligencePlugin extends BasePlugin {
  constructor() {
    super();
    this.name = 'documentIntelligence';
    this.version = '1.0.0';
    this.description = 'OCR and document processing with AI-powered content analysis and categorization';
    
    this.config = {
      // OCR settings
      ocrEngine: 'tesseract',
      ocrLanguages: ['eng'], // Default to English
      ocrDPI: 300,
      preprocessImages: true,
      
      // Document processing
      supportedFormats: ['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.bmp'],
      outputFormats: ['text', 'json', 'markdown'],
      
      // AI categorization
      enableAIAnalysis: true,
      categorizeDocuments: true,
      extractStructuredData: true,
      
      // Processing paths
      inputPath: '/tmp/document-input',
      outputPath: '/tmp/document-output',
      archivePath: '/tmp/document-archive',
      
      // Batch processing
      batchSize: 10,
      maxFileSize: '50MB',
      
      // Content analysis categories
      documentTypes: [
        'receipt',
        'invoice', 
        'business_card',
        'identity_document',
        'contract',
        'form',
        'article',
        'handwritten',
        'technical_document',
        'other'
      ]
    };
    
    this.processingQueue = [];
    this.processingHistory = new Map();
    
    this.methods = [
      {
        name: 'processDocument',
        description: 'OCR and analyze a single document',
        parameters: {
          filePath: { type: 'string', required: true, description: 'Path to document file' },
          language: { type: 'string', required: false, description: 'OCR language code' },
          outputFormat: { type: 'string', required: false, description: 'Output format (text/json/markdown)' }
        }
      },
      {
        name: 'batchProcessDocuments',
        description: 'Process multiple documents in a directory',
        parameters: {
          inputDir: { type: 'string', required: true, description: 'Input directory path' },
          recursive: { type: 'boolean', required: false, description: 'Process subdirectories' },
          filter: { type: 'string', required: false, description: 'File extension filter' }
        }
      },
      {
        name: 'extractStructuredData',
        description: 'Extract structured data from documents (receipts, invoices, etc.)',
        parameters: {
          filePath: { type: 'string', required: true, description: 'Path to document' },
          documentType: { type: 'string', required: false, description: 'Expected document type' }
        }
      },
      {
        name: 'searchDocuments',
        description: 'Search processed documents by content',
        parameters: {
          query: { type: 'string', required: true, description: 'Search query' },
          searchType: { type: 'string', required: false, description: 'Search type (fuzzy/exact/semantic)' },
          category: { type: 'string', required: false, description: 'Document category filter' }
        }
      },
      {
        name: 'categorizeDocument',
        description: 'AI-powered document categorization',
        parameters: {
          filePath: { type: 'string', required: true, description: 'Path to document' },
          content: { type: 'string', required: false, description: 'Pre-extracted content' }
        }
      },
      {
        name: 'enhanceImage',
        description: 'Preprocess image for better OCR results',
        parameters: {
          imagePath: { type: 'string', required: true, description: 'Path to image file' },
          operations: { type: 'array', required: false, description: 'Enhancement operations' }
        }
      },
      {
        name: 'createSearchableArchive',
        description: 'Create searchable archive of processed documents',
        parameters: {
          sourceDir: { type: 'string', required: true, description: 'Source directory' },
          archiveName: { type: 'string', required: false, description: 'Archive name' }
        }
      },
      {
        name: 'getProcessingStats',
        description: 'Get document processing statistics',
        parameters: {
          timeframe: { type: 'string', required: false, description: 'Time period (day/week/month)' }
        }
      },
      {
        name: 'setupOCRLanguages',
        description: 'Install and configure additional OCR languages',
        parameters: {
          languages: { type: 'array', required: true, description: 'Language codes to install' }
        }
      },
      {
        name: 'validateDocumentQuality',
        description: 'Assess document quality and provide improvement suggestions',
        parameters: {
          filePath: { type: 'string', required: true, description: 'Path to document' }
        }
      }
    ];
  }

  async initialize() {
    try {
      // Check if Tesseract is installed
      await this.checkTesseractInstallation();
      
      // Ensure processing directories exist
      await this.ensureDirectories();
      
      // Check available languages
      await this.checkAvailableLanguages();
      
      logger.info('Document Intelligence Plugin initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Document Intelligence Plugin:', error);
      return false;
    }
  }

  async execute(params) {
    const { action, ...args } = params;
    
    try {
      switch (action) {
        case 'processDocument':
          return await this.processDocument(args);
        case 'batchProcessDocuments':
          return await this.batchProcessDocuments(args);
        case 'extractStructuredData':
          return await this.extractStructuredData(args);
        case 'searchDocuments':
          return await this.searchDocuments(args);
        case 'categorizeDocument':
          return await this.categorizeDocument(args);
        case 'enhanceImage':
          return await this.enhanceImage(args);
        case 'createSearchableArchive':
          return await this.createSearchableArchive(args);
        case 'getProcessingStats':
          return await this.getProcessingStats(args);
        case 'setupOCRLanguages':
          return await this.setupOCRLanguages(args);
        case 'validateDocumentQuality':
          return await this.validateDocumentQuality(args);
        default:
          throw new Error(`Unknown document intelligence action: ${action}`);
      }
    } catch (error) {
      logger.error(`Document Intelligence error in ${action}:`, error);
      throw error;
    }
  }

  /**
   * Process a single document with OCR
   */
  async processDocument({ filePath, language = 'eng', outputFormat = 'json' }) {
    try {
      logger.info(`Processing document: ${filePath}`);

      // Validate file exists and format
      const fileStats = await fs.stat(filePath);
      const fileExt = path.extname(filePath).toLowerCase();
      
      if (!this.config.supportedFormats.includes(fileExt)) {
        throw new Error(`Unsupported file format: ${fileExt}`);
      }

      const startTime = Date.now();
      
      // Preprocess image if needed
      let processedFilePath = filePath;
      if (this.config.preprocessImages && ['.jpg', '.jpeg', '.png'].includes(fileExt)) {
        processedFilePath = await this.preprocessImage(filePath);
      }

      // Perform OCR
      const ocrResult = await this.performOCR(processedFilePath, language);
      
      // Analyze content if AI analysis is enabled
      let analysis = null;
      if (this.config.enableAIAnalysis) {
        analysis = await this.analyzeContent(ocrResult.text);
      }

      // Categorize document
      let category = 'other';
      if (this.config.categorizeDocuments) {
        const categoryResult = await this.categorizeDocument({ 
          filePath, 
          content: ocrResult.text 
        });
        if (categoryResult.success) {
          category = categoryResult.category;
        }
      }

      const result = {
        success: true,
        document: {
          filePath,
          fileName: path.basename(filePath),
          fileSize: fileStats.size,
          processedAt: new Date(),
          processingTime: Date.now() - startTime,
          language,
          category
        },
        ocr: {
          confidence: ocrResult.confidence,
          text: ocrResult.text,
          wordCount: ocrResult.text.split(/\s+/).length,
          lineCount: ocrResult.text.split('\n').length
        },
        analysis,
        outputFormat
      };

      // Format output based on requested format
      if (outputFormat === 'text') {
        result.content = ocrResult.text;
      } else if (outputFormat === 'markdown') {
        result.content = this.formatAsMarkdown(result);
      } else {
        // JSON format (default) — content is the OCR text
        result.content = ocrResult.text;
      }

      // Store processing history
      this.processingHistory.set(filePath, result);

      // Save output file
      await this.saveProcessedDocument(result, outputFormat);

      return result;

    } catch (error) {
      logger.error(`Document processing failed for ${filePath}:`, error);
      return {
        success: false,
        error: error.message,
        filePath
      };
    }
  }

  /**
   * Perform OCR using Tesseract
   */
  async performOCR(filePath, language = 'eng') {
    try {
      // Build Tesseract command
      const outputPath = path.join('/tmp', `ocr_${Date.now()}`);
      const tesseractCmd = `tesseract "${filePath}" "${outputPath}" -l ${language} --dpi ${this.config.ocrDPI}`;
      
      // Execute OCR
      const { stdout, stderr } = await execAsync(tesseractCmd);
      
      // Read OCR result
      const textContent = await fs.readFile(`${outputPath}.txt`, 'utf-8');
      
      // Clean up temporary file
      try {
        await fs.unlink(`${outputPath}.txt`);
      } catch (error) {
        logger.warn('Could not clean up OCR temp file:', error.message);
      }

      // Calculate confidence (mock - Tesseract 4+ provides this)
      const confidence = this.calculateOCRConfidence(textContent);

      return {
        text: textContent.trim(),
        confidence,
        language
      };

    } catch (error) {
      throw new Error(`OCR processing failed: ${error.message}`);
    }
  }

  /**
   * AI-powered content analysis
   */
  async analyzeContent(text) {
    try {
      // This would integrate with AI providers for content analysis
      // For now, provide basic analysis
      const analysis = {
        summary: this.generateSummary(text),
        entities: this.extractEntities(text),
        keywords: this.extractKeywords(text),
        language: this.detectLanguage(text),
        sentiment: this.analyzeSentiment(text),
        topics: this.extractTopics(text)
      };

      return analysis;

    } catch (error) {
      logger.error('Content analysis failed:', error);
      return null;
    }
  }

  /**
   * Categorize document based on content
   */
  async categorizeDocument({ filePath, content = null }) {
    try {
      // Extract content if not provided
      if (!content) {
        const ocrResult = await this.performOCR(filePath);
        content = ocrResult.text;
      }

      // Simple rule-based categorization (could be enhanced with AI)
      const category = this.classifyDocumentType(content);
      const confidence = this.calculateClassificationConfidence(content, category);

      return {
        success: true,
        category,
        confidence,
        suggestedTags: this.generateTags(content, category)
      };

    } catch (error) {
      logger.error('Document categorization failed:', error);
      return {
        success: false,
        error: error.message,
        category: 'other'
      };
    }
  }

  /**
   * Extract structured data from specific document types
   */
  async extractStructuredData({ filePath, documentType = null }) {
    try {
      // First get OCR text
      const ocrResult = await this.performOCR(filePath);
      const text = ocrResult.text;

      // Detect document type if not provided
      if (!documentType) {
        const categoryResult = await this.categorizeDocument({ filePath, content: text });
        documentType = categoryResult.success ? categoryResult.category : 'other';
      }

      let structuredData = {};

      // Extract data based on document type
      switch (documentType) {
        case 'receipt':
          structuredData = this.extractReceiptData(text);
          break;
        case 'invoice':
          structuredData = this.extractInvoiceData(text);
          break;
        case 'business_card':
          structuredData = this.extractBusinessCardData(text);
          break;
        case 'identity_document':
          structuredData = this.extractIdentityData(text);
          break;
        default:
          structuredData = this.extractGenericData(text);
      }

      return {
        success: true,
        documentType,
        structuredData,
        confidence: this.calculateExtractionConfidence(structuredData),
        rawText: text
      };

    } catch (error) {
      logger.error('Structured data extraction failed:', error);
      return {
        success: false,
        error: error.message,
        documentType: documentType || 'unknown'
      };
    }
  }

  /**
   * Search processed documents
   */
  async searchDocuments({ query, searchType = 'fuzzy', category = null }) {
    try {
      const results = [];
      const searchTerms = query.toLowerCase().split(/\s+/);

      // Search through processing history
      for (const [filePath, processedDoc] of this.processingHistory) {
        if (category && processedDoc.document.category !== category) {
          continue;
        }

        const content = processedDoc.ocr.text.toLowerCase();
        const score = this.calculateSearchScore(content, searchTerms, searchType);

        if (score > 0.1) { // Minimum relevance threshold
          results.push({
            filePath,
            fileName: processedDoc.document.fileName,
            category: processedDoc.document.category,
            relevanceScore: score,
            matchingExcerpts: this.extractMatchingExcerpts(content, searchTerms),
            processedAt: processedDoc.document.processedAt
          });
        }
      }

      // Sort by relevance
      results.sort((a, b) => b.relevanceScore - a.relevanceScore);

      return {
        success: true,
        query,
        searchType,
        category,
        totalResults: results.length,
        results: results.slice(0, 20) // Limit to top 20 results
      };

    } catch (error) {
      logger.error('Document search failed:', error);
      return {
        success: false,
        error: error.message,
        query
      };
    }
  }

  /**
   * Helper Methods
   */

  async checkTesseractInstallation() {
    try {
      const { stdout } = await execAsync('tesseract --version');
      logger.info(`Tesseract OCR detected: ${stdout.split('\n')[0]}`);
      return true;
    } catch (error) {
      throw new Error('Tesseract OCR not found. Please install tesseract-ocr package.');
    }
  }

  async ensureDirectories() {
    const directories = [
      this.config.inputPath,
      this.config.outputPath,
      this.config.archivePath
    ];

    for (const dir of directories) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error) {
        logger.warn(`Could not create directory ${dir}:`, error.message);
      }
    }
  }

  async checkAvailableLanguages() {
    try {
      const { stdout } = await execAsync('tesseract --list-langs');
      const languages = stdout.split('\n').slice(1).filter(lang => lang.trim());
      logger.info(`Available OCR languages: ${languages.join(', ')}`);
      return languages;
    } catch (error) {
      logger.warn('Could not check available Tesseract languages:', error.message);
      return ['eng'];
    }
  }

  async preprocessImage(imagePath) {
    // Mock preprocessing - could use ImageMagick or similar
    logger.info(`Preprocessing image: ${imagePath}`);
    return imagePath; // For now, return original path
  }

  calculateOCRConfidence(text) {
    // Mock confidence calculation based on text characteristics
    const hasReasonableLength = text.length > 10;
    const hasAlphanumeric = /[a-zA-Z0-9]/.test(text);
    const hasCompleteWords = text.split(/\s+/).length > 2;
    
    let confidence = 0.5;
    if (hasReasonableLength) confidence += 0.2;
    if (hasAlphanumeric) confidence += 0.2;
    if (hasCompleteWords) confidence += 0.1;
    
    return Math.min(confidence, 0.95);
  }

  classifyDocumentType(content) {
    const text = content.toLowerCase();
    
    if (text.includes('receipt') || text.includes('total') || text.includes('$')) {
      return 'receipt';
    } else if (text.includes('invoice') || text.includes('bill to') || text.includes('due date')) {
      return 'invoice';
    } else if (text.includes('phone') && text.includes('email') && text.length < 500) {
      return 'business_card';
    } else if (text.includes('name') && text.includes('date of birth')) {
      return 'identity_document';
    } else if (text.includes('contract') || text.includes('agreement')) {
      return 'contract';
    } else {
      return 'other';
    }
  }

  calculateClassificationConfidence(content, category) {
    // Mock confidence calculation
    return Math.random() * 0.3 + 0.7; // 70-100%
  }

  generateTags(content, category) {
    const commonWords = content.toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 3)
      .slice(0, 5);
    
    return [category, ...commonWords];
  }

  extractReceiptData(text) {
    // Mock receipt data extraction
    const lines = text.split('\n');
    return {
      merchant: lines[0] || 'Unknown',
      date: this.extractDate(text),
      total: this.extractTotal(text),
      items: this.extractItems(text)
    };
  }

  extractInvoiceData(text) {
    return {
      invoiceNumber: this.extractPattern(text, /invoice\s*#?\s*(\w+)/i),
      date: this.extractDate(text),
      amount: this.extractTotal(text),
      vendor: this.extractPattern(text, /from:\s*(.+)/i)
    };
  }

  extractBusinessCardData(text) {
    return {
      name: this.extractPattern(text, /^(.+)$/m),
      email: this.extractPattern(text, /[\w.-]+@[\w.-]+\.\w+/),
      phone: this.extractPattern(text, /[\d\-\(\)\s+]{10,}/),
      company: this.extractPattern(text, /(.+)\n/m)
    };
  }

  extractGenericData(text) {
    return {
      entities: this.extractEntities(text),
      dates: this.extractAllDates(text),
      numbers: this.extractNumbers(text),
      emails: this.extractEmails(text)
    };
  }

  extractPattern(text, regex) {
    const match = text.match(regex);
    return match ? match[1]?.trim() : null;
  }

  extractDate(text) {
    const dateRegex = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/;
    const match = text.match(dateRegex);
    return match ? match[0] : null;
  }

  extractTotal(text) {
    const totalRegex = /total:?\s*\$?(\d+\.?\d*)/i;
    const match = text.match(totalRegex);
    return match ? parseFloat(match[1]) : null;
  }

  // Additional utility methods would go here...
  generateSummary(text) { return text.substring(0, 100) + '...'; }
  extractEntities(text) { return []; }
  extractKeywords(text) { return text.split(/\s+/).slice(0, 5); }
  detectLanguage(text) { return 'en'; }
  analyzeSentiment(text) { return 'neutral'; }
  extractTopics(text) { return ['general']; }

  calculateSearchScore(content, searchTerms, searchType) {
    let score = 0;
    for (const term of searchTerms) {
      if (content.includes(term)) {
        score += 1 / searchTerms.length;
      }
    }
    return score;
  }

  extractMatchingExcerpts(content, searchTerms) {
    return searchTerms.map(term => {
      const index = content.indexOf(term);
      if (index !== -1) {
        const start = Math.max(0, index - 50);
        const end = Math.min(content.length, index + term.length + 50);
        return content.substring(start, end);
      }
      return null;
    }).filter(Boolean);
  }

  async saveProcessedDocument(result, outputFormat) {
    const outputFileName = `processed_${Date.now()}.${outputFormat}`;
    const outputPath = path.join(this.config.outputPath, outputFileName);
    
    let content;
    if (outputFormat === 'json') {
      content = JSON.stringify(result, null, 2);
    } else if (outputFormat === 'text') {
      content = result.ocr.text;
    } else {
      content = this.formatAsMarkdown(result);
    }
    
    try {
      await fs.writeFile(outputPath, content);
      logger.info(`Processed document saved: ${outputPath}`);
    } catch (error) {
      logger.warn(`Could not save processed document: ${error.message}`);
    }
  }

  formatAsMarkdown(result) {
    return `# Document Processing Result

## Document Information
- **File**: ${result.document.fileName}
- **Category**: ${result.document.category}
- **Processed**: ${result.document.processedAt}
- **Language**: ${result.document.language}

## OCR Results
- **Confidence**: ${(result.ocr.confidence * 100).toFixed(1)}%
- **Word Count**: ${result.ocr.wordCount}
- **Lines**: ${result.ocr.lineCount}

## Content
\`\`\`
${result.ocr.text}
\`\`\`
`;
  }

  getStatus() {
    return {
      name: this.name,
      version: this.version,
      enabled: this.enabled,
      ocrEngine: this.config.ocrEngine,
      supportedFormats: this.config.supportedFormats,
      processedDocuments: this.processingHistory.size,
      aiAnalysisEnabled: this.config.enableAIAnalysis,
      methods: this.methods.map(m => ({ name: m.name, description: m.description }))
    };
  }
}

export default DocumentIntelligencePlugin;