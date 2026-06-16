import { logger } from '../../utils/logger.js';
import { createLoader, DirectoryLoader, Document } from './documentLoader.js';
import { createSplitter } from './textSplitter.js';
import { createRetriever, SimilarityRetriever } from './retriever.js';

/**
 * RAGChain - Main orchestration class for Retrieval-Augmented Generation
 * Handles document ingestion, retrieval, and augmented response generation
 */
export class RAGChain {
  constructor(options = {}) {
    this.vectorStore = options.vectorStore;
    this.embeddingProvider = options.embeddingProvider;
    this.llmProvider = options.llmProvider;
    this.memoryManager = options.memoryManager;

    // Default configurations
    this.defaultSplitterType = options.defaultSplitterType || 'recursive';
    this.defaultRetrieverType = options.defaultRetrieverType || 'similarity';
    this.defaultChunkSize = options.chunkSize || 1000;
    this.defaultChunkOverlap = options.chunkOverlap || 200;
    this.defaultK = options.k || 5;

    // Prompt templates
    this.qaPromptTemplate = options.qaPromptTemplate || this.getDefaultQAPrompt();
    this.condensePromptTemplate = options.condensePromptTemplate || this.getDefaultCondensePrompt();

    // State
    this.retriever = null;
    this.initialized = false;
  }

  /**
   * Initialize the RAG chain
   */
  async initialize() {
    if (!this.vectorStore) {
      throw new Error('RAGChain requires a vector store');
    }

    if (!this.embeddingProvider) {
      throw new Error('RAGChain requires an embedding provider');
    }

    // Create default retriever
    this.retriever = createRetriever(
      this.defaultRetrieverType,
      this.vectorStore,
      this.embeddingProvider,
      {
        k: this.defaultK,
        llmProvider: this.llmProvider
      }
    );

    this.initialized = true;
    logger.info('RAGChain initialized');
  }

  /**
   * Ingest a document into the knowledge base
   */
  async ingestDocument(source, options = {}) {
    const {
      splitterType = this.defaultSplitterType,
      chunkSize = this.defaultChunkSize,
      chunkOverlap = this.defaultChunkOverlap,
      metadata = {},
      loaderOptions = {}
    } = options;

    try {
      // Create loader based on source type
      const loader = createLoader(source, loaderOptions);

      // Load document
      logger.info(`Loading document from: ${source}`);
      const documents = await loader.load();

      if (documents.length === 0) {
        return { success: false, message: 'No content loaded from source' };
      }

      // Create splitter
      const splitter = createSplitter(splitterType, {
        chunkSize,
        chunkOverlap,
        language: options.language // For code splitter
      });

      // Split documents into chunks
      const chunks = splitter.splitDocuments(documents);
      logger.info(`Split into ${chunks.length} chunks`);

      // Generate embeddings and store
      const stored = await this.storeChunks(chunks, {
        source,
        ...metadata
      });

      return {
        success: true,
        source,
        totalChunks: chunks.length,
        storedChunks: stored.length,
        documentIds: stored.map(s => s.id)
      };
    } catch (error) {
      logger.error('Document ingestion failed:', error.message);
      return {
        success: false,
        error: error.message,
        source
      };
    }
  }

  /**
   * Ingest multiple documents from a directory
   */
  async ingestDirectory(dirPath, options = {}) {
    const {
      glob = '**/*',
      recursive = true,
      loaderMapping,
      ...ingestOptions
    } = options;

    try {
      const loader = new DirectoryLoader(dirPath, {
        glob,
        recursive,
        loaderMapping
      });

      const documents = await loader.load();
      logger.info(`Loaded ${documents.length} documents from ${dirPath}`);

      if (documents.length === 0) {
        return { success: false, message: 'No documents found in directory' };
      }

      // Create splitter
      const splitter = createSplitter(ingestOptions.splitterType || this.defaultSplitterType, {
        chunkSize: ingestOptions.chunkSize || this.defaultChunkSize,
        chunkOverlap: ingestOptions.chunkOverlap || this.defaultChunkOverlap
      });

      // Split all documents
      const chunks = splitter.splitDocuments(documents);
      logger.info(`Split into ${chunks.length} total chunks`);

      // Store chunks
      const stored = await this.storeChunks(chunks, {
        sourceDirectory: dirPath,
        ...ingestOptions.metadata
      });

      return {
        success: true,
        directory: dirPath,
        documentsLoaded: documents.length,
        totalChunks: chunks.length,
        storedChunks: stored.length
      };
    } catch (error) {
      logger.error('Directory ingestion failed:', error.message);
      return {
        success: false,
        error: error.message,
        directory: dirPath
      };
    }
  }

  /**
   * Store document chunks in the vector store
   */
  async storeChunks(chunks, additionalMetadata = {}) {
    const stored = [];

    for (const chunk of chunks) {
      try {
        // Generate embedding
        const embedding = await this.embeddingProvider.generateEmbedding(chunk.pageContent);

        if (!embedding) {
          logger.warn('Failed to generate embedding for chunk');
          continue;
        }

        // Create unique ID for the chunk
        const id = `rag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store in vector store
        const record = {
          id,
          vector: embedding,
          content: chunk.pageContent,
          type: 'rag_document',
          ...chunk.metadata,
          ...additionalMetadata,
          ingestedAt: new Date().toISOString()
        };

        // Use vectorStore.addIntent or similar method
        if (this.vectorStore.addDocument) {
          await this.vectorStore.addDocument(record);
        } else if (this.vectorStore.addIntent) {
          // Adapt to existing intent-based storage
          await this.vectorStore.addIntent({
            id,
            embedding,
            metadata: {
              name: chunk.metadata.source || 'Unknown',
              description: chunk.pageContent.substring(0, 200),
              plugin: 'knowledge',
              action: 'retrieve',
              category: 'rag_document',
              type: 'document_chunk',
              examples: [],
              enabled: true,
              ...chunk.metadata,
              ...additionalMetadata,
              fullContent: chunk.pageContent
            }
          });
        }

        // Also store in memory manager if available (for persistence)
        if (this.memoryManager) {
          await this.memoryManager.store('knowledge', chunk.pageContent, {
            category: 'rag_document',
            source: chunk.metadata.source,
            chunkIndex: chunk.metadata.chunkIndex,
            totalChunks: chunk.metadata.totalChunks,
            vectorId: id,
            ...additionalMetadata
          });
        }

        stored.push({ id, ...chunk.metadata });
      } catch (error) {
        logger.warn('Failed to store chunk:', error.message);
      }
    }

    return stored;
  }

  /**
   * Query the knowledge base with RAG augmentation
   */
  async query(question, options = {}) {
    const {
      k = this.defaultK,
      retrieverType = this.defaultRetrieverType,
      includeSourceDocuments = true,
      condensePreviousQuestions = false,
      chatHistory = [],
      filter = null
    } = options;

    try {
      // Optionally condense question with chat history
      let effectiveQuestion = question;
      if (condensePreviousQuestions && chatHistory.length > 0) {
        effectiveQuestion = await this.condenseQuestion(question, chatHistory);
      }

      // Retrieve relevant documents
      let retriever = this.retriever;
      if (retrieverType !== this.defaultRetrieverType) {
        retriever = createRetriever(
          retrieverType,
          this.vectorStore,
          this.embeddingProvider,
          { k, llmProvider: this.llmProvider, filter }
        );
      }

      const relevantDocs = await retriever.retrieve(effectiveQuestion, { k, filter });

      if (relevantDocs.length === 0) {
        return {
          answer: "I couldn't find any relevant information in the knowledge base to answer your question.",
          sourceDocuments: [],
          question: effectiveQuestion
        };
      }

      // Format context from retrieved documents
      const context = this.formatContext(relevantDocs);

      // Generate response with augmented context
      const answer = await this.generateAnswer(effectiveQuestion, context);

      return {
        answer,
        sourceDocuments: includeSourceDocuments ? relevantDocs : [],
        question: effectiveQuestion,
        contextUsed: relevantDocs.length
      };
    } catch (error) {
      logger.error('RAG query failed:', error.message);
      throw error;
    }
  }

  /**
   * Get context for a query without generating an answer
   * Useful for augmenting other prompts
   */
  async getContext(query, options = {}) {
    const {
      k = this.defaultK,
      retrieverType = this.defaultRetrieverType,
      filter = null,
      formatAsString = true
    } = options;

    try {
      let retriever = this.retriever;
      if (retrieverType !== this.defaultRetrieverType) {
        retriever = createRetriever(
          retrieverType,
          this.vectorStore,
          this.embeddingProvider,
          { k, llmProvider: this.llmProvider, filter }
        );
      }

      const relevantDocs = await retriever.retrieve(query, { k, filter });

      if (formatAsString) {
        return {
          context: this.formatContext(relevantDocs),
          sources: relevantDocs.map(d => d.metadata?.source || 'Unknown'),
          documentCount: relevantDocs.length
        };
      }

      return {
        documents: relevantDocs,
        documentCount: relevantDocs.length
      };
    } catch (error) {
      logger.error('Failed to get RAG context:', error.message);
      return {
        context: '',
        sources: [],
        documentCount: 0
      };
    }
  }

  /**
   * Condense a question with chat history for better retrieval
   */
  async condenseQuestion(question, chatHistory) {
    if (!this.llmProvider || chatHistory.length === 0) {
      return question;
    }

    try {
      const historyText = chatHistory
        .slice(-4) // Last 4 exchanges
        .map(h => `Human: ${h.human}\nAssistant: ${h.assistant}`)
        .join('\n');

      const prompt = this.condensePromptTemplate
        .replace('{chat_history}', historyText)
        .replace('{question}', question);

      const response = await this.llmProvider.generateResponse(prompt, {
        maxTokens: 200,
        temperature: 0
      });

      return response.content || response || question;
    } catch (error) {
      logger.warn('Failed to condense question:', error.message);
      return question;
    }
  }

  /**
   * Format retrieved documents into context string
   */
  formatContext(documents) {
    if (!documents || documents.length === 0) {
      return '';
    }

    return documents.map((doc, index) => {
      const content = doc.compressedContent ||
                      doc.metadata?.fullContent ||
                      doc.metadata?.content ||
                      doc.metadata?.description ||
                      '';

      const source = doc.metadata?.source || 'Unknown';
      const similarity = doc.similarity ? ` (relevance: ${(doc.similarity * 100).toFixed(1)}%)` : '';

      return `[Document ${index + 1}]${similarity}\nSource: ${source}\n${content}`;
    }).join('\n\n---\n\n');
  }

  /**
   * Generate an answer using the LLM with context
   */
  async generateAnswer(question, context) {
    if (!this.llmProvider) {
      return context; // Just return context if no LLM
    }

    const prompt = this.qaPromptTemplate
      .replace('{context}', context)
      .replace('{question}', question);

    try {
      const response = await this.llmProvider.generateResponse(prompt, {
        maxTokens: 1000,
        temperature: 0.3
      });

      return response.content || response;
    } catch (error) {
      logger.error('Failed to generate answer:', error.message);
      return `Based on the retrieved documents:\n\n${context}`;
    }
  }

  /**
   * List all ingested documents
   */
  async listDocuments(options = {}) {
    const { limit = 50, offset = 0, source = null } = options;

    try {
      if (this.memoryManager) {
        const query = {
          type: 'knowledge',
          'metadata.category': 'rag_document'
        };

        if (source) {
          query['metadata.source'] = source;
        }

        const { Memory } = await import('../../models/Memory.js');
        const documents = await Memory.find(query)
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(limit);

        const total = await Memory.countDocuments(query);

        // Group by source
        const sourceMap = new Map();
        documents.forEach(doc => {
          const src = doc.metadata?.source || 'Unknown';
          if (!sourceMap.has(src)) {
            sourceMap.set(src, {
              source: src,
              chunks: 0,
              firstIngested: doc.createdAt,
              lastIngested: doc.createdAt
            });
          }
          const entry = sourceMap.get(src);
          entry.chunks++;
          if (doc.createdAt < entry.firstIngested) {
            entry.firstIngested = doc.createdAt;
          }
          if (doc.createdAt > entry.lastIngested) {
            entry.lastIngested = doc.createdAt;
          }
        });

        return {
          documents: Array.from(sourceMap.values()),
          total,
          offset,
          limit
        };
      }

      return { documents: [], total: 0, offset, limit };
    } catch (error) {
      logger.error('Failed to list documents:', error.message);
      return { documents: [], total: 0, offset, limit };
    }
  }

  /**
   * Delete a document from the knowledge base
   */
  async deleteDocument(source) {
    try {
      const deleted = {
        vectorStore: 0,
        memory: 0
      };

      // Delete from memory
      if (this.memoryManager) {
        const { Memory } = await import('../../models/Memory.js');
        const result = await Memory.deleteMany({
          type: 'knowledge',
          'metadata.category': 'rag_document',
          'metadata.source': source
        });
        deleted.memory = result.deletedCount;
      }

      // Delete from vector store
      if (this.vectorStore && this.vectorStore.deleteByFilter) {
        await this.vectorStore.deleteByFilter({ source });
      }

      logger.info(`Deleted document: ${source} (${deleted.memory} chunks)`);
      return {
        success: true,
        source,
        deletedChunks: deleted.memory
      };
    } catch (error) {
      logger.error('Failed to delete document:', error.message);
      return {
        success: false,
        error: error.message,
        source
      };
    }
  }

  /**
   * Get statistics about the knowledge base
   */
  async getStats() {
    try {
      const stats = {
        totalDocuments: 0,
        totalChunks: 0,
        sources: [],
        vectorStoreStats: null
      };

      if (this.memoryManager) {
        const { Memory } = await import('../../models/Memory.js');

        stats.totalChunks = await Memory.countDocuments({
          type: 'knowledge',
          'metadata.category': 'rag_document'
        });

        // Get unique sources
        const sources = await Memory.distinct('metadata.source', {
          type: 'knowledge',
          'metadata.category': 'rag_document'
        });
        stats.sources = sources.filter(s => s);
        stats.totalDocuments = stats.sources.length;
      }

      if (this.vectorStore && this.vectorStore.getStats) {
        stats.vectorStoreStats = await this.vectorStore.getStats();
      }

      return stats;
    } catch (error) {
      logger.error('Failed to get RAG stats:', error.message);
      return {
        totalDocuments: 0,
        totalChunks: 0,
        sources: [],
        error: error.message
      };
    }
  }

  /**
   * Default QA prompt template
   */
  getDefaultQAPrompt() {
    return `Use the following pieces of context to answer the question at the end. If you don't know the answer based on the context, say that you don't know - don't try to make up an answer.

Context:
{context}

Question: {question}

Answer: `;
  }

  /**
   * Default condense question prompt template
   */
  getDefaultCondensePrompt() {
    return `Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question that captures all relevant context.

Chat History:
{chat_history}

Follow Up Input: {question}
Standalone question:`;
  }

  /**
   * Set a custom retriever
   */
  setRetriever(retriever) {
    this.retriever = retriever;
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    if (config.defaultSplitterType) this.defaultSplitterType = config.defaultSplitterType;
    if (config.defaultRetrieverType) this.defaultRetrieverType = config.defaultRetrieverType;
    if (config.chunkSize) this.defaultChunkSize = config.chunkSize;
    if (config.chunkOverlap) this.defaultChunkOverlap = config.chunkOverlap;
    if (config.k) this.defaultK = config.k;
    if (config.qaPromptTemplate) this.qaPromptTemplate = config.qaPromptTemplate;
    if (config.condensePromptTemplate) this.condensePromptTemplate = config.condensePromptTemplate;

    // Recreate retriever with new config
    if (this.initialized) {
      this.retriever = createRetriever(
        this.defaultRetrieverType,
        this.vectorStore,
        this.embeddingProvider,
        { k: this.defaultK, llmProvider: this.llmProvider }
      );
    }

    logger.info('RAGChain configuration updated');
  }
}

/**
 * Create a RAG chain with common configurations
 */
export function createRAGChain(options) {
  return new RAGChain(options);
}

export default {
  RAGChain,
  createRAGChain
};
