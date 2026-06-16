import { logger } from '../../utils/logger.js';

/**
 * Base Retriever class - abstract interface for document retrieval
 */
export class Retriever {
  constructor(options = {}) {
    this.k = options.k || 5;
    this.scoreThreshold = options.scoreThreshold || 0;
    this.filter = options.filter || null;
  }

  /**
   * Retrieve relevant documents for a query
   * @param {string} query - The search query
   * @param {Object} options - Additional retrieval options
   * @returns {Promise<Array>} - Retrieved documents with scores
   */
  async retrieve(query, options = {}) {
    throw new Error('retrieve() must be implemented by subclass');
  }

  /**
   * Get relevant documents (alias for retrieve)
   */
  async getRelevantDocuments(query, options = {}) {
    return this.retrieve(query, options);
  }
}

/**
 * SimilarityRetriever - Basic vector similarity search
 * Wraps the existing VectorStoreService search functionality
 */
export class SimilarityRetriever extends Retriever {
  constructor(vectorStore, embeddingProvider, options = {}) {
    super(options);
    this.vectorStore = vectorStore;
    this.embeddingProvider = embeddingProvider;
  }

  async retrieve(query, options = {}) {
    const k = options.k || this.k;
    const filter = options.filter || this.filter;

    try {
      // Generate embedding for query
      const queryEmbedding = await this.embeddingProvider.generateEmbedding(query);

      // Search vector store
      const results = await this.vectorStore.search(queryEmbedding, k, filter);

      // Filter by score threshold
      return results.filter(r => r.similarity >= this.scoreThreshold);
    } catch (error) {
      logger.error('SimilarityRetriever error:', error.message);
      throw error;
    }
  }
}

/**
 * MMRRetriever - Maximal Marginal Relevance
 * Balances relevance with diversity to reduce redundancy
 */
export class MMRRetriever extends Retriever {
  constructor(vectorStore, embeddingProvider, options = {}) {
    super(options);
    this.vectorStore = vectorStore;
    this.embeddingProvider = embeddingProvider;
    this.lambda = options.lambda || 0.5; // Balance: 1 = relevance only, 0 = diversity only
    this.fetchK = options.fetchK || 20; // Number of candidates to fetch
  }

  async retrieve(query, options = {}) {
    const k = options.k || this.k;
    const lambda = options.lambda || this.lambda;
    const fetchK = options.fetchK || this.fetchK;
    const filter = options.filter || this.filter;

    try {
      // Generate embedding for query
      const queryEmbedding = await this.embeddingProvider.generateEmbedding(query);

      // Fetch more candidates than needed
      const candidates = await this.vectorStore.search(queryEmbedding, fetchK, filter);

      if (candidates.length === 0) {
        return [];
      }

      // Apply MMR algorithm
      const selected = [];
      const remaining = [...candidates];

      // Select first document (most relevant)
      selected.push(remaining.shift());

      while (selected.length < k && remaining.length > 0) {
        let bestScore = -Infinity;
        let bestIndex = 0;

        for (let i = 0; i < remaining.length; i++) {
          const candidate = remaining[i];

          // Calculate relevance to query
          const relevance = candidate.similarity;

          // Calculate maximum similarity to already selected documents
          let maxSimToSelected = 0;
          for (const sel of selected) {
            const sim = this.cosineSimilarity(
              candidate.embedding || [],
              sel.embedding || []
            );
            maxSimToSelected = Math.max(maxSimToSelected, sim);
          }

          // MMR score: λ * relevance - (1 - λ) * max_sim_to_selected
          const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;

          if (mmrScore > bestScore) {
            bestScore = mmrScore;
            bestIndex = i;
          }
        }

        selected.push(remaining.splice(bestIndex, 1)[0]);
      }

      return selected;
    } catch (error) {
      logger.error('MMRRetriever error:', error.message);
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

/**
 * HybridRetriever - Combines vector similarity with keyword search
 * Uses score fusion to combine results from multiple retrieval methods
 */
export class HybridRetriever extends Retriever {
  constructor(vectorStore, embeddingProvider, mongoCollection, options = {}) {
    super(options);
    this.vectorStore = vectorStore;
    this.embeddingProvider = embeddingProvider;
    this.mongoCollection = mongoCollection;
    this.vectorWeight = options.vectorWeight || 0.7;
    this.keywordWeight = options.keywordWeight || 0.3;
  }

  async retrieve(query, options = {}) {
    const k = options.k || this.k;
    const filter = options.filter || this.filter;

    try {
      // Parallel: Vector search and keyword search
      const [vectorResults, keywordResults] = await Promise.all([
        this.vectorSearch(query, k * 2, filter),
        this.keywordSearch(query, k * 2, filter)
      ]);

      // Fuse results using Reciprocal Rank Fusion (RRF)
      const fused = this.reciprocalRankFusion(vectorResults, keywordResults, k);

      return fused;
    } catch (error) {
      logger.error('HybridRetriever error:', error.message);
      throw error;
    }
  }

  async vectorSearch(query, k, filter) {
    try {
      const queryEmbedding = await this.embeddingProvider.generateEmbedding(query);
      return await this.vectorStore.search(queryEmbedding, k, filter);
    } catch (error) {
      logger.warn('Vector search failed in hybrid retriever:', error.message);
      return [];
    }
  }

  async keywordSearch(query, k, filter) {
    if (!this.mongoCollection) {
      return [];
    }

    try {
      // Use MongoDB text search if available
      const searchQuery = {
        $text: { $search: query }
      };

      if (filter) {
        Object.assign(searchQuery, filter);
      }

      const results = await this.mongoCollection
        .find(searchQuery)
        .project({ score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(k)
        .toArray();

      // Normalize scores to 0-1 range
      const maxScore = Math.max(...results.map(r => r.score || 0), 1);
      return results.map(r => ({
        id: r._id?.toString() || r.id,
        metadata: r,
        similarity: (r.score || 0) / maxScore,
        source: 'keyword'
      }));
    } catch (error) {
      logger.warn('Keyword search failed in hybrid retriever:', error.message);
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF) to combine ranked lists
   * score = sum(1 / (k + rank)) for each list where document appears
   */
  reciprocalRankFusion(vectorResults, keywordResults, k, fusionK = 60) {
    const scores = new Map();

    // Add vector results with weights
    vectorResults.forEach((result, rank) => {
      const id = result.id;
      const score = this.vectorWeight / (fusionK + rank + 1);
      scores.set(id, (scores.get(id) || 0) + score);

      if (!scores.has(`_doc_${id}`)) {
        scores.set(`_doc_${id}`, result);
      }
    });

    // Add keyword results with weights
    keywordResults.forEach((result, rank) => {
      const id = result.id;
      const score = this.keywordWeight / (fusionK + rank + 1);
      scores.set(id, (scores.get(id) || 0) + score);

      if (!scores.has(`_doc_${id}`)) {
        scores.set(`_doc_${id}`, result);
      }
    });

    // Sort by fused score and return top k
    const ids = Array.from(scores.keys()).filter(key => !key.startsWith('_doc_'));
    ids.sort((a, b) => scores.get(b) - scores.get(a));

    return ids.slice(0, k).map(id => {
      const doc = scores.get(`_doc_${id}`);
      return {
        ...doc,
        fusedScore: scores.get(id)
      };
    });
  }
}

/**
 * ContextualCompressionRetriever - Compresses retrieved documents
 * Extracts only the most relevant parts of each document
 */
export class ContextualCompressionRetriever extends Retriever {
  constructor(baseRetriever, llmProvider, options = {}) {
    super(options);
    this.baseRetriever = baseRetriever;
    this.llmProvider = llmProvider;
    this.compressionPrompt = options.compressionPrompt || this.getDefaultCompressionPrompt();
  }

  getDefaultCompressionPrompt() {
    return `Given the following question and document, extract only the parts of the document that are directly relevant to answering the question. If no part is relevant, respond with "NOT_RELEVANT".

Question: {question}

Document:
{document}

Relevant Extract:`;
  }

  async retrieve(query, options = {}) {
    const k = options.k || this.k;

    try {
      // Get initial documents from base retriever
      const documents = await this.baseRetriever.retrieve(query, { ...options, k: k * 2 });

      // Compress each document in parallel
      const compressedDocs = await Promise.all(
        documents.map(doc => this.compressDocument(query, doc))
      );

      // Filter out non-relevant documents and take top k
      return compressedDocs
        .filter(doc => doc !== null && doc.compressedContent !== 'NOT_RELEVANT')
        .slice(0, k);
    } catch (error) {
      logger.error('ContextualCompressionRetriever error:', error.message);
      throw error;
    }
  }

  async compressDocument(query, document) {
    try {
      const content = document.metadata?.pageContent ||
                      document.metadata?.content ||
                      document.metadata?.description ||
                      JSON.stringify(document.metadata);

      const prompt = this.compressionPrompt
        .replace('{question}', query)
        .replace('{document}', content);

      const response = await this.llmProvider.generateResponse(prompt, {
        maxTokens: 500,
        temperature: 0
      });

      const compressedContent = response.content || response;

      if (compressedContent.trim() === 'NOT_RELEVANT') {
        return null;
      }

      return {
        ...document,
        compressedContent,
        originalContent: content
      };
    } catch (error) {
      logger.warn('Document compression failed:', error.message);
      return document; // Return original if compression fails
    }
  }
}

/**
 * MultiQueryRetriever - Generates multiple query variations
 * Retrieves documents for each variation and combines results
 */
export class MultiQueryRetriever extends Retriever {
  constructor(baseRetriever, llmProvider, options = {}) {
    super(options);
    this.baseRetriever = baseRetriever;
    this.llmProvider = llmProvider;
    this.numQueries = options.numQueries || 3;
  }

  async retrieve(query, options = {}) {
    const k = options.k || this.k;

    try {
      // Generate query variations
      const queryVariations = await this.generateQueryVariations(query);

      // Include original query
      const allQueries = [query, ...queryVariations];

      // Retrieve for all queries in parallel
      const allResults = await Promise.all(
        allQueries.map(q => this.baseRetriever.retrieve(q, { ...options, k }))
      );

      // Deduplicate and combine results
      const seen = new Set();
      const combined = [];

      for (const results of allResults) {
        for (const result of results) {
          if (!seen.has(result.id)) {
            seen.add(result.id);
            combined.push(result);
          }
        }
      }

      // Sort by similarity and return top k
      combined.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
      return combined.slice(0, k);
    } catch (error) {
      logger.error('MultiQueryRetriever error:', error.message);
      // Fallback to base retriever on error
      return this.baseRetriever.retrieve(query, options);
    }
  }

  async generateQueryVariations(query) {
    const prompt = `Generate ${this.numQueries} different versions of the following question to help retrieve relevant documents. Each version should capture the same intent but use different wording or perspectives.

Original question: ${query}

Provide the variations as a JSON array of strings, like: ["variation1", "variation2", "variation3"]

Variations:`;

    try {
      const response = await this.llmProvider.generateResponse(prompt, {
        maxTokens: 300,
        temperature: 0.7
      });

      const content = response.content || response;

      // Extract JSON array from response
      const match = content.match(/\[[\s\S]*?\]/);
      if (match) {
        return JSON.parse(match[0]);
      }

      return [];
    } catch (error) {
      logger.warn('Failed to generate query variations:', error.message);
      return [];
    }
  }
}

/**
 * ParentDocumentRetriever - Retrieves parent documents of matched chunks
 * Useful when you want full context around matched segments
 */
export class ParentDocumentRetriever extends Retriever {
  constructor(vectorStore, embeddingProvider, documentStore, options = {}) {
    super(options);
    this.vectorStore = vectorStore;
    this.embeddingProvider = embeddingProvider;
    this.documentStore = documentStore; // MongoDB collection or similar
    this.childK = options.childK || 10; // Number of child chunks to retrieve
  }

  async retrieve(query, options = {}) {
    const k = options.k || this.k;
    const childK = options.childK || this.childK;
    const filter = options.filter || this.filter;

    try {
      // Get embedding for query
      const queryEmbedding = await this.embeddingProvider.generateEmbedding(query);

      // Search for relevant chunks
      const chunks = await this.vectorStore.search(queryEmbedding, childK, filter);

      // Get unique parent document IDs
      const parentIds = [...new Set(chunks.map(c => c.metadata?.parentId).filter(Boolean))];

      if (parentIds.length === 0) {
        // No parent references, return chunks as-is
        return chunks.slice(0, k);
      }

      // Fetch parent documents
      const parents = await this.fetchParentDocuments(parentIds);

      // Score parents based on their children's scores
      const parentScores = new Map();
      for (const chunk of chunks) {
        const parentId = chunk.metadata?.parentId;
        if (parentId) {
          const currentScore = parentScores.get(parentId) || 0;
          parentScores.set(parentId, currentScore + (chunk.similarity || 0));
        }
      }

      // Sort parents by aggregated score
      const sortedParents = parents
        .map(parent => ({
          ...parent,
          aggregatedScore: parentScores.get(parent.id) || 0
        }))
        .sort((a, b) => b.aggregatedScore - a.aggregatedScore);

      return sortedParents.slice(0, k);
    } catch (error) {
      logger.error('ParentDocumentRetriever error:', error.message);
      throw error;
    }
  }

  async fetchParentDocuments(parentIds) {
    if (!this.documentStore) {
      return [];
    }

    try {
      // Assuming MongoDB-like interface
      const docs = await this.documentStore.find({
        _id: { $in: parentIds }
      }).toArray();

      return docs.map(doc => ({
        id: doc._id?.toString() || doc.id,
        metadata: doc,
        similarity: 1 // Will be replaced with aggregated score
      }));
    } catch (error) {
      logger.warn('Failed to fetch parent documents:', error.message);
      return [];
    }
  }
}

/**
 * Create a retriever based on type
 */
export function createRetriever(type, vectorStore, embeddingProvider, options = {}) {
  const retrievers = {
    similarity: () => new SimilarityRetriever(vectorStore, embeddingProvider, options),
    mmr: () => new MMRRetriever(vectorStore, embeddingProvider, options),
    hybrid: () => new HybridRetriever(vectorStore, embeddingProvider, options.mongoCollection, options),
    compression: () => {
      const base = new SimilarityRetriever(vectorStore, embeddingProvider, options);
      return new ContextualCompressionRetriever(base, options.llmProvider, options);
    },
    multiquery: () => {
      const base = new SimilarityRetriever(vectorStore, embeddingProvider, options);
      return new MultiQueryRetriever(base, options.llmProvider, options);
    },
    parent: () => new ParentDocumentRetriever(vectorStore, embeddingProvider, options.documentStore, options)
  };

  const factory = retrievers[type] || retrievers.similarity;
  return factory();
}

export default {
  Retriever,
  SimilarityRetriever,
  MMRRetriever,
  HybridRetriever,
  ContextualCompressionRetriever,
  MultiQueryRetriever,
  ParentDocumentRetriever,
  createRetriever
};
