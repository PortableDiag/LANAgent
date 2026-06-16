import { Document } from './documentLoader.js';
import { logger } from '../../utils/logger.js';

/**
 * Base TextSplitter class - abstract interface for splitting text into chunks
 */
export class TextSplitter {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize || 1000;
    this.chunkOverlap = options.chunkOverlap || 200;
    this.lengthFunction = options.lengthFunction || (text => text.length);
  }

  /**
   * Split text into chunks
   */
  splitText(text) {
    throw new Error('splitText() must be implemented by subclass');
  }

  /**
   * Split documents into chunks, preserving metadata
   */
  splitDocuments(documents) {
    const chunks = [];

    for (const doc of documents) {
      const textChunks = this.splitText(doc.pageContent);

      textChunks.forEach((chunk, index) => {
        chunks.push(new Document(chunk, {
          ...doc.metadata,
          chunkIndex: index,
          totalChunks: textChunks.length
        }));
      });
    }

    return chunks;
  }

  /**
   * Create documents from text chunks
   */
  createDocuments(texts, metadatas = []) {
    const documents = [];

    texts.forEach((text, i) => {
      const textChunks = this.splitText(text);
      const metadata = metadatas[i] || {};

      textChunks.forEach((chunk, index) => {
        documents.push(new Document(chunk, {
          ...metadata,
          chunkIndex: index,
          totalChunks: textChunks.length
        }));
      });
    });

    return documents;
  }

  /**
   * Merge splits with overlap
   */
  mergeSplits(splits, separator) {
    const merged = [];
    let currentChunk = [];
    let currentLength = 0;

    for (const split of splits) {
      const splitLength = this.lengthFunction(split);

      if (currentLength + splitLength > this.chunkSize && currentChunk.length > 0) {
        // Save current chunk
        merged.push(currentChunk.join(separator));

        // Keep overlap from end
        while (currentLength > this.chunkOverlap && currentChunk.length > 0) {
          currentLength -= this.lengthFunction(currentChunk[0]) + separator.length;
          currentChunk.shift();
        }
      }

      currentChunk.push(split);
      currentLength += splitLength + separator.length;
    }

    // Add last chunk
    if (currentChunk.length > 0) {
      merged.push(currentChunk.join(separator));
    }

    return merged;
  }
}

/**
 * CharacterTextSplitter - Split by character count with separator
 */
export class CharacterTextSplitter extends TextSplitter {
  constructor(options = {}) {
    super(options);
    this.separator = options.separator || '\n\n';
  }

  splitText(text) {
    if (!text) return [];

    // Split by separator
    const splits = text.split(this.separator);

    // Merge back with overlap
    return this.mergeSplits(splits, this.separator);
  }
}

/**
 * RecursiveCharacterSplitter - Smart splitting using multiple separators
 * Tries to split by natural boundaries: paragraphs -> sentences -> words
 */
export class RecursiveCharacterSplitter extends TextSplitter {
  constructor(options = {}) {
    super(options);
    this.separators = options.separators || ['\n\n', '\n', '. ', ', ', ' ', ''];
  }

  splitText(text) {
    if (!text) return [];
    return this._splitText(text, this.separators);
  }

  _splitText(text, separators) {
    const finalChunks = [];
    const separator = separators[0];
    const newSeparators = separators.slice(1);

    let splits;
    if (separator === '') {
      // Character-level split
      splits = text.split('');
    } else {
      splits = text.split(separator);
    }

    let goodSplits = [];

    for (const split of splits) {
      if (this.lengthFunction(split) < this.chunkSize) {
        goodSplits.push(split);
      } else {
        if (goodSplits.length > 0) {
          const mergedText = this.mergeSplits(goodSplits, separator);
          finalChunks.push(...mergedText);
          goodSplits = [];
        }

        if (newSeparators.length === 0) {
          finalChunks.push(split);
        } else {
          const otherChunks = this._splitText(split, newSeparators);
          finalChunks.push(...otherChunks);
        }
      }
    }

    if (goodSplits.length > 0) {
      const mergedText = this.mergeSplits(goodSplits, separator);
      finalChunks.push(...mergedText);
    }

    return finalChunks;
  }
}

/**
 * TokenTextSplitter - Split by token count (approximation)
 */
export class TokenTextSplitter extends TextSplitter {
  constructor(options = {}) {
    super(options);
    this.encodingName = options.encoding || 'cl100k_base';
    // Approximate tokens: ~4 chars per token for English
    this.charsPerToken = options.charsPerToken || 4;
  }

  splitText(text) {
    if (!text) return [];

    // Convert chunk size from tokens to approximate characters
    const charChunkSize = this.chunkSize * this.charsPerToken;
    const charOverlap = this.chunkOverlap * this.charsPerToken;

    const chunks = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + charChunkSize, text.length);
      let chunk = text.slice(start, end);

      // Try to end at a word boundary
      if (end < text.length) {
        const lastSpace = chunk.lastIndexOf(' ');
        if (lastSpace > charChunkSize * 0.8) {
          chunk = chunk.slice(0, lastSpace);
        }
      }

      chunks.push(chunk.trim());

      // Move start with overlap
      start += chunk.length - charOverlap;
      if (start <= chunks[chunks.length - 1]?.length) {
        start = end; // Prevent infinite loop
      }
    }

    return chunks.filter(c => c.length > 0);
  }
}

/**
 * CodeSplitter - Language-aware code splitting
 */
export class CodeSplitter extends TextSplitter {
  constructor(options = {}) {
    super(options);
    this.language = options.language || 'javascript';
    this.separators = this.getSeparatorsForLanguage(this.language);
  }

  getSeparatorsForLanguage(language) {
    const languageSeparators = {
      javascript: [
        // Functions and classes
        '\nfunction ', '\nclass ', '\nconst ', '\nlet ', '\nvar ',
        '\nexport ', '\nimport ',
        // Control structures
        '\nif ', '\nfor ', '\nwhile ', '\nswitch ',
        // General
        '\n\n', '\n', ' ', ''
      ],
      python: [
        '\ndef ', '\nclass ', '\nasync def ',
        '\nif ', '\nfor ', '\nwhile ', '\nwith ', '\ntry:',
        '\n\n', '\n', ' ', ''
      ],
      typescript: [
        '\nfunction ', '\nclass ', '\ninterface ', '\ntype ',
        '\nconst ', '\nlet ', '\nvar ',
        '\nexport ', '\nimport ',
        '\nif ', '\nfor ', '\nwhile ',
        '\n\n', '\n', ' ', ''
      ],
      go: [
        '\nfunc ', '\ntype ', '\nvar ', '\nconst ',
        '\nif ', '\nfor ', '\nswitch ',
        '\n\n', '\n', ' ', ''
      ],
      rust: [
        '\nfn ', '\nstruct ', '\nenum ', '\nimpl ', '\ntrait ',
        '\nlet ', '\nconst ',
        '\nif ', '\nfor ', '\nwhile ', '\nmatch ',
        '\n\n', '\n', ' ', ''
      ]
    };

    return languageSeparators[language] || languageSeparators.javascript;
  }

  splitText(text) {
    if (!text) return [];
    return this._recursiveSplit(text, this.separators);
  }

  _recursiveSplit(text, separators) {
    const finalChunks = [];
    const separator = separators[0];
    const newSeparators = separators.slice(1);

    let splits;
    if (separator === '') {
      splits = text.split('');
    } else {
      // Keep the separator with the following text
      const regex = new RegExp(`(${separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'g');
      splits = text.split(regex).reduce((acc, part, i, arr) => {
        if (i % 2 === 0) {
          acc.push((arr[i - 1] || '') + part);
        }
        return acc;
      }, []).filter(s => s);
    }

    let goodSplits = [];

    for (const split of splits) {
      if (this.lengthFunction(split) < this.chunkSize) {
        goodSplits.push(split);
      } else {
        if (goodSplits.length > 0) {
          finalChunks.push(goodSplits.join(''));
          goodSplits = [];
        }

        if (newSeparators.length === 0) {
          finalChunks.push(split);
        } else {
          finalChunks.push(...this._recursiveSplit(split, newSeparators));
        }
      }
    }

    if (goodSplits.length > 0) {
      finalChunks.push(goodSplits.join(''));
    }

    return finalChunks;
  }
}

/**
 * MarkdownSplitter - Split markdown by headers
 */
export class MarkdownSplitter extends TextSplitter {
  constructor(options = {}) {
    super(options);
    this.headersToSplitOn = options.headersToSplitOn || [
      ['#', 'Header 1'],
      ['##', 'Header 2'],
      ['###', 'Header 3']
    ];
  }

  splitText(text) {
    if (!text) return [];

    const lines = text.split('\n');
    const chunks = [];
    let currentChunk = [];
    let currentHeaders = {};

    for (const line of lines) {
      // Check if line is a header
      let foundHeader = null;
      for (const [marker, name] of this.headersToSplitOn) {
        if (line.startsWith(marker + ' ') && !line.startsWith(marker + '#')) {
          foundHeader = { marker, name, text: line.slice(marker.length + 1).trim() };
          break;
        }
      }

      if (foundHeader) {
        // Save current chunk if not empty
        if (currentChunk.length > 0) {
          const chunkText = currentChunk.join('\n').trim();
          if (chunkText.length > 0) {
            chunks.push(chunkText);
          }
          currentChunk = [];
        }

        // Update current headers
        currentHeaders[foundHeader.name] = foundHeader.text;

        // Reset lower-level headers
        const headerIndex = this.headersToSplitOn.findIndex(([m]) => m === foundHeader.marker);
        for (let i = headerIndex + 1; i < this.headersToSplitOn.length; i++) {
          delete currentHeaders[this.headersToSplitOn[i][1]];
        }
      }

      currentChunk.push(line);

      // Check if chunk is too large
      const currentText = currentChunk.join('\n');
      if (this.lengthFunction(currentText) > this.chunkSize) {
        // Use recursive splitter for large chunks
        const subSplitter = new RecursiveCharacterSplitter({
          chunkSize: this.chunkSize,
          chunkOverlap: this.chunkOverlap
        });
        const subChunks = subSplitter.splitText(currentText);
        chunks.push(...subChunks);
        currentChunk = [];
      }
    }

    // Add remaining content
    if (currentChunk.length > 0) {
      const chunkText = currentChunk.join('\n').trim();
      if (chunkText.length > 0) {
        chunks.push(chunkText);
      }
    }

    return chunks;
  }
}

/**
 * SentenceSplitter - Split by sentences
 */
export class SentenceSplitter extends TextSplitter {
  constructor(options = {}) {
    super(options);
    // Regex to split by sentence boundaries
    this.sentenceRegex = /(?<=[.!?])\s+(?=[A-Z])/;
  }

  splitText(text) {
    if (!text) return [];

    const sentences = text.split(this.sentenceRegex);
    return this.mergeSplits(sentences, ' ');
  }
}

/**
 * LanguageAwareSplitter - Split text using language-specific tokenization
 */
export class LanguageAwareSplitter extends TextSplitter {
  constructor(options = {}) {
    super(options);
    this.language = options.language || 'en';
    this.tokenizer = this.getTokenizerForLanguage(this.language);
  }

  getTokenizerForLanguage(language) {
    const tokenizers = {
      en: text => text.split(/(?<=[.!?])\s+/),
      es: text => text.split(/(?<=[.!?])\s+/),
      fr: text => text.split(/(?<=[.!?])\s+/),
      de: text => text.split(/(?<=[.!?])\s+/),
      ja: text => text.split(/(?<=[。！？])/),
      zh: text => text.split(/(?<=[。！？])/),
    };

    return tokenizers[language] || tokenizers.en;
  }

  splitText(text) {
    if (!text) return [];

    const tokens = this.tokenizer(text);
    return this.mergeSplits(tokens, ' ');
  }
}

/**
 * Create splitter based on type
 */
export function createSplitter(type, options = {}) {
  const splitters = {
    character: CharacterTextSplitter,
    recursive: RecursiveCharacterSplitter,
    token: TokenTextSplitter,
    code: CodeSplitter,
    markdown: MarkdownSplitter,
    sentence: SentenceSplitter,
    languageAware: LanguageAwareSplitter
  };

  const SplitterClass = splitters[type] || RecursiveCharacterSplitter;
  return new SplitterClass(options);
}

export default {
  TextSplitter,
  CharacterTextSplitter,
  RecursiveCharacterSplitter,
  TokenTextSplitter,
  CodeSplitter,
  MarkdownSplitter,
  SentenceSplitter,
  LanguageAwareSplitter,
  createSplitter
};
