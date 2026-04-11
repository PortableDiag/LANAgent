import { BasePlugin } from '../core/basePlugin.js';
import { RAGChain } from '../../services/rag/ragChain.js';
import { createLoader, DirectoryLoader } from '../../services/rag/documentLoader.js';
import { createSplitter } from '../../services/rag/textSplitter.js';
import { createRetriever } from '../../services/rag/retriever.js';
import { logger } from '../../utils/logger.js';

export default class KnowledgePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'knowledge';
    this.version = '1.0.0';
    this.description = 'Knowledge base management with RAG (Retrieval-Augmented Generation) capabilities';
    this.commands = [
      {
        command: 'ingest',
        description: 'Add a document to the knowledge base',
        usage: 'ingest({ source: "/path/to/file.pdf", splitterType: "recursive", chunkSize: 1000 })'
      },
      {
        command: 'ingestUrl',
        description: 'Add a web page to the knowledge base',
        usage: 'ingestUrl({ url: "https://example.com/page", selector: "article" })'
      },
      {
        command: 'ingestDirectory',
        description: 'Add all documents from a directory',
        usage: 'ingestDirectory({ path: "/path/to/docs", recursive: true })'
      },
      {
        command: 'query',
        description: 'Query the knowledge base with RAG augmentation',
        usage: 'query({ question: "What is the installation process?", k: 5 })'
      },
      {
        command: 'search',
        description: 'Search the knowledge base without generating an answer',
        usage: 'search({ query: "installation", k: 10, retrieverType: "mmr" })'
      },
      {
        command: 'list',
        description: 'List all ingested documents',
        usage: 'list({ limit: 50 })'
      },
      {
        command: 'delete',
        description: 'Remove a document from the knowledge base',
        usage: 'delete({ source: "/path/to/file.pdf" })'
      },
      {
        command: 'stats',
        description: 'Get knowledge base statistics',
        usage: 'stats()'
      },
      {
        command: 'configure',
        description: 'Update RAG configuration',
        usage: 'configure({ chunkSize: 1500, retrieverType: "mmr", k: 10 })'
      }
    ];

    this.ragChain = null;
    this.config = {
      defaultSplitterType: 'recursive',
      defaultRetrieverType: 'similarity',
      chunkSize: 1000,
      chunkOverlap: 200,
      k: 5
    };
  }

  async initialize() {
    try {
      // Initialize RAG chain with agent's resources
      const vectorStore = this.agent.vectorStore || this.agent.vectorStoreService;
      const providerManager = this.agent.providerManager;
      const memoryManager = this.agent.memoryManager;

      if (!vectorStore) {
        this.logger.warn('Knowledge plugin: Vector store not available, some features may be limited');
      }

      // Create embedding provider wrapper
      const embeddingProvider = {
        generateEmbedding: async (text) => {
          return await providerManager.generateEmbedding(text);
        }
      };

      // Create LLM provider wrapper
      const llmProvider = {
        generateResponse: async (prompt, options = {}) => {
          return await providerManager.generateResponse(prompt, options);
        }
      };

      this.ragChain = new RAGChain({
        vectorStore,
        embeddingProvider,
        llmProvider,
        memoryManager,
        ...this.config
      });

      await this.ragChain.initialize();
      this.logger.info('Knowledge plugin initialized with RAG capabilities');
    } catch (error) {
      this.logger.error('Knowledge plugin initialization error:', error.message);
      // Plugin can still work in degraded mode
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: ['ingest', 'ingestUrl', 'ingestDirectory', 'query', 'search', 'list', 'delete', 'stats', 'configure']
      }
    });

    switch (action) {
      case 'ingest':
        return await this.ingestDocument(data);
      case 'ingestUrl':
        return await this.ingestUrl(data);
      case 'ingestDirectory':
        return await this.ingestDirectory(data);
      case 'query':
        return await this.queryKnowledgeBase(data);
      case 'search':
        return await this.searchKnowledgeBase(data);
      case 'list':
        return await this.listDocuments(data);
      case 'delete':
        return await this.deleteDocument(data);
      case 'stats':
        return await this.getStats();
      case 'configure':
        return await this.updateConfiguration(data);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async ingestDocument(data) {
    this.validateParams(data, {
      source: { required: true, type: 'string' },
      splitterType: { type: 'string', enum: ['character', 'recursive', 'token', 'code', 'markdown', 'sentence'] },
      chunkSize: { type: 'number' },
      chunkOverlap: { type: 'number' },
      language: { type: 'string' }, // For code splitter
      metadata: { type: 'object' }
    });

    if (!this.ragChain) {
      throw new Error('RAG system not initialized');
    }

    const result = await this.ragChain.ingestDocument(data.source, {
      splitterType: data.splitterType || this.config.defaultSplitterType,
      chunkSize: data.chunkSize || this.config.chunkSize,
      chunkOverlap: data.chunkOverlap || this.config.chunkOverlap,
      language: data.language,
      metadata: data.metadata || {}
    });

    if (result.success) {
      await this.notify(
        `📚 Document ingested successfully!\n\n` +
        `*Source:* ${result.source}\n` +
        `*Chunks:* ${result.totalChunks} created, ${result.storedChunks} stored`
      );
    }

    return result;
  }

  async ingestUrl(data) {
    this.validateParams(data, {
      url: { required: true, type: 'string' },
      selector: { type: 'string' },
      removeSelectors: { type: 'array' },
      splitterType: { type: 'string' },
      chunkSize: { type: 'number' },
      metadata: { type: 'object' }
    });

    if (!this.ragChain) {
      throw new Error('RAG system not initialized');
    }

    const result = await this.ragChain.ingestDocument(data.url, {
      splitterType: data.splitterType || this.config.defaultSplitterType,
      chunkSize: data.chunkSize || this.config.chunkSize,
      chunkOverlap: data.chunkOverlap || this.config.chunkOverlap,
      metadata: data.metadata || {},
      loaderOptions: {
        selector: data.selector,
        removeSelectors: data.removeSelectors
      }
    });

    if (result.success) {
      await this.notify(
        `🌐 Web page ingested successfully!\n\n` +
        `*URL:* ${data.url}\n` +
        `*Chunks:* ${result.totalChunks} created`
      );
    }

    return result;
  }

  async ingestDirectory(data) {
    this.validateParams(data, {
      path: { required: true, type: 'string' },
      recursive: { type: 'boolean' },
      glob: { type: 'string' },
      splitterType: { type: 'string' },
      chunkSize: { type: 'number' },
      metadata: { type: 'object' }
    });

    if (!this.ragChain) {
      throw new Error('RAG system not initialized');
    }

    await this.notify(`📁 Starting directory ingestion: ${data.path}`);

    const result = await this.ragChain.ingestDirectory(data.path, {
      recursive: data.recursive !== false,
      glob: data.glob,
      splitterType: data.splitterType || this.config.defaultSplitterType,
      chunkSize: data.chunkSize || this.config.chunkSize,
      chunkOverlap: data.chunkOverlap || this.config.chunkOverlap,
      metadata: data.metadata || {}
    });

    if (result.success) {
      await this.notify(
        `📚 Directory ingested successfully!\n\n` +
        `*Path:* ${result.directory}\n` +
        `*Documents:* ${result.documentsLoaded}\n` +
        `*Total Chunks:* ${result.totalChunks}`
      );
    }

    return result;
  }

  async queryKnowledgeBase(data) {
    this.validateParams(data, {
      question: { required: true, type: 'string' },
      k: { type: 'number' },
      retrieverType: { type: 'string', enum: ['similarity', 'mmr', 'hybrid', 'compression', 'multiquery'] },
      includeSourceDocuments: { type: 'boolean' },
      chatHistory: { type: 'array' }
    });

    if (!this.ragChain) {
      throw new Error('RAG system not initialized');
    }

    const result = await this.ragChain.query(data.question, {
      k: data.k || this.config.k,
      retrieverType: data.retrieverType || this.config.defaultRetrieverType,
      includeSourceDocuments: data.includeSourceDocuments !== false,
      chatHistory: data.chatHistory || []
    });

    // Format response for user
    let response = result.answer;

    if (result.sourceDocuments && result.sourceDocuments.length > 0) {
      const sources = [...new Set(result.sourceDocuments.map(d =>
        d.metadata?.source || 'Unknown'
      ))];

      response += `\n\n📖 *Sources:*\n${sources.map(s => `• ${s}`).join('\n')}`;
    }

    return {
      success: true,
      answer: result.answer,
      response,
      sourceDocuments: result.sourceDocuments,
      question: result.question,
      contextUsed: result.contextUsed
    };
  }

  async searchKnowledgeBase(data) {
    this.validateParams(data, {
      query: { required: true, type: 'string' },
      k: { type: 'number' },
      retrieverType: { type: 'string', enum: ['similarity', 'mmr', 'hybrid', 'compression', 'multiquery'] },
      filter: { type: 'object' }
    });

    if (!this.ragChain) {
      throw new Error('RAG system not initialized');
    }

    const result = await this.ragChain.getContext(data.query, {
      k: data.k || this.config.k,
      retrieverType: data.retrieverType || this.config.defaultRetrieverType,
      filter: data.filter,
      formatAsString: false
    });

    return {
      success: true,
      query: data.query,
      results: result.documents?.map(doc => ({
        content: doc.metadata?.fullContent || doc.metadata?.content || doc.metadata?.description,
        source: doc.metadata?.source,
        similarity: doc.similarity,
        metadata: doc.metadata
      })) || [],
      totalFound: result.documentCount
    };
  }

  async listDocuments(data) {
    if (!this.ragChain) {
      throw new Error('RAG system not initialized');
    }

    const result = await this.ragChain.listDocuments({
      limit: data.limit || 50,
      offset: data.offset || 0,
      source: data.source
    });

    return {
      success: true,
      documents: result.documents,
      total: result.total,
      pagination: {
        limit: result.limit,
        offset: result.offset
      }
    };
  }

  async deleteDocument(data) {
    this.validateParams(data, {
      source: { required: true, type: 'string' }
    });

    if (!this.ragChain) {
      throw new Error('RAG system not initialized');
    }

    const result = await this.ragChain.deleteDocument(data.source);

    if (result.success) {
      await this.notify(
        `🗑️ Document deleted from knowledge base\n\n` +
        `*Source:* ${result.source}\n` +
        `*Chunks removed:* ${result.deletedChunks}`
      );
    }

    return result;
  }

  async getStats() {
    if (!this.ragChain) {
      return {
        success: true,
        initialized: false,
        message: 'RAG system not initialized'
      };
    }

    const stats = await this.ragChain.getStats();

    return {
      success: true,
      initialized: true,
      ...stats,
      configuration: this.config
    };
  }

  async updateConfiguration(data) {
    const validKeys = ['defaultSplitterType', 'defaultRetrieverType', 'chunkSize', 'chunkOverlap', 'k'];

    const updates = {};
    for (const key of validKeys) {
      if (data[key] !== undefined) {
        updates[key] = data[key];
      }
    }

    // Validate splitter type
    if (updates.defaultSplitterType) {
      const validSplitters = ['character', 'recursive', 'token', 'code', 'markdown', 'sentence'];
      if (!validSplitters.includes(updates.defaultSplitterType)) {
        throw new Error(`Invalid splitter type. Valid options: ${validSplitters.join(', ')}`);
      }
    }

    // Validate retriever type
    if (updates.defaultRetrieverType) {
      const validRetrievers = ['similarity', 'mmr', 'hybrid', 'compression', 'multiquery'];
      if (!validRetrievers.includes(updates.defaultRetrieverType)) {
        throw new Error(`Invalid retriever type. Valid options: ${validRetrievers.join(', ')}`);
      }
    }

    // Update local config
    this.config = {
      ...this.config,
      ...updates
    };

    // Update RAG chain config
    if (this.ragChain) {
      this.ragChain.updateConfig(updates);
    }

    return {
      success: true,
      message: 'Configuration updated',
      configuration: this.config
    };
  }

  // Quick access methods for other plugins/services
  async quickQuery(question, options = {}) {
    return await this.queryKnowledgeBase({
      question,
      ...options
    });
  }

  async quickSearch(query, k = 5) {
    return await this.searchKnowledgeBase({
      query,
      k
    });
  }

  async getRAGContext(query, k = 5) {
    if (!this.ragChain) {
      return { context: '', sources: [], documentCount: 0 };
    }

    return await this.ragChain.getContext(query, {
      k,
      formatAsString: true
    });
  }

  // Integration with memory manager - augment prompts with knowledge
  async augmentPromptWithKnowledge(prompt, options = {}) {
    const { query, k = 3, threshold = 0.5 } = options;

    try {
      const contextResult = await this.ragChain.getContext(query || prompt, {
        k,
        formatAsString: true
      });

      if (contextResult.documentCount > 0 && contextResult.context) {
        return `Relevant knowledge from the knowledge base:\n${contextResult.context}\n\n---\n\n${prompt}`;
      }

      return prompt;
    } catch (error) {
      this.logger.warn('Failed to augment prompt with knowledge:', error.message);
      return prompt;
    }
  }
}
