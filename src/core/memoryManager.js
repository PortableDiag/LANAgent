import { Memory } from "../models/Memory.js";
import { logger } from "../utils/logger.js";
import { safeJsonParse } from "../utils/jsonUtils.js";
import { memoryVectorStore } from "../services/memoryVectorStore.js";

export class MemoryManager {
  constructor(agent) {
    this.agent = agent;
    this.cache = new Map();
    this.maxCacheSize = 1000;
    this.settings = {
      autoAddEnabled: true,
      deduplicationEnabled: true,
      deduplicationThreshold: 0.85 // Similarity threshold for deduplication
    };
    this.vectorStoreReady = false;
  }

  async initialize() {
    logger.info("Initializing memory manager...");

    // Load settings
    await this.loadSettings();

    // Initialize vector store for semantic search
    try {
      await memoryVectorStore.initialize();
      this.vectorStoreReady = true;
      logger.info("Memory vector store initialized");

      // Check if we need to rebuild the index
      const stats = await memoryVectorStore.getStats();
      if (stats.totalMemories === 0) {
        await this.rebuildVectorIndex();
      }
    } catch (error) {
      logger.warn("Memory vector store initialization failed, falling back to text search:", error.message);
      this.vectorStoreReady = false;
    }

    // Load recent memories into cache
    await this.loadRecentMemories();

    // Set up periodic cleanup
    setInterval(() => this.cleanup(), 3600000); // Every hour
  }

  /**
   * Rebuild the vector index from existing memories
   */
  async rebuildVectorIndex() {
    if (!this.vectorStoreReady) {
      logger.warn("Cannot rebuild vector index - vector store not ready");
      return { indexed: 0 };
    }

    logger.info("Rebuilding memory vector index...");
    const result = await memoryVectorStore.rebuildIndex(async () => {
      return Memory.getMemoriesWithEmbeddings();
    });
    logger.info(`Memory vector index rebuilt: ${result.indexed} memories indexed`);
    return result;
  }

  async store(type, content, metadata = {}) {
    try {
      // Ensure content is a string - convert objects to JSON
      let contentStr = content;
      if (typeof content !== 'string') {
        if (content === null || content === undefined) {
          contentStr = '';
        } else if (typeof content === 'object') {
          try {
            // For very large objects (like scraped web content), summarize instead
            const jsonStr = JSON.stringify(content);
            if (jsonStr.length > 10000) {
              // Extract meaningful summary for large objects
              const keys = Object.keys(content);
              contentStr = `[Object with ${keys.length} keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}]`;
              logger.warn(`Converted large object (${jsonStr.length} chars) to summary for memory storage`);
            } else {
              contentStr = jsonStr;
            }
          } catch (e) {
            contentStr = String(content);
          }
        } else {
          contentStr = String(content);
        }
      }

      // Generate embedding if we have a provider that supports it
      let embedding = null;
      try {
        embedding = await this.agent.providerManager.generateEmbedding(contentStr);
      } catch (error) {
        logger.warn("Could not generate embedding:", error.message);
      }

      // Check for semantic duplicates if deduplication is enabled
      if (this.settings.deduplicationEnabled && embedding && this.vectorStoreReady) {
        const duplicate = await memoryVectorStore.findDuplicate(
          embedding,
          this.settings.deduplicationThreshold
        );

        if (duplicate) {
          logger.debug(`Skipping duplicate memory (similarity: ${duplicate.similarity.toFixed(3)}): ${contentStr.substring(0, 50)}...`);
          // Return the existing memory instead of creating a new one
          const existingMemory = await Memory.findById(duplicate.id);
          if (existingMemory) {
            // Update access count on the existing memory
            await existingMemory.access();
            return existingMemory;
          }
        }
      }

      const memory = new Memory({
        type,
        content: contentStr,
        embedding,
        isPermanent: metadata.isPermanent || false,
        metadata: {
          ...metadata,
          timestamp: new Date()
        }
      });

      await memory.save();

      // Add to vector store for semantic search - only for long-term knowledge types
      // Conversation history is temporal and shouldn't be in the semantic index
      const indexableTypes = ['knowledge', 'learned', 'preference', 'fact'];
      if (embedding && this.vectorStoreReady && indexableTypes.includes(type)) {
        try {
          await memoryVectorStore.addMemory(memory);
        } catch (error) {
          logger.warn("Failed to add memory to vector store:", error.message);
        }
      }

      // Add to cache
      this.addToCache(memory);

      logger.info(`Stored ${type} memory: ${contentStr.substring(0, 50)}...`);
      return memory;
    } catch (error) {
      logger.error("Failed to store memory:", error);
      throw error;
    }
  }

  async recall(query, options = {}) {
    const {
      type = null,
      limit = 10,
      userId = null,
      tags = [],
      useEmbedding = true,
      minSimilarity = 0.5
    } = options;

    try {
      // Try vector search first if available
      if (useEmbedding && query && this.vectorStoreReady) {
        try {
          const queryEmbedding = await this.agent.providerManager.generateEmbedding(query);
          if (queryEmbedding) {
            const vectorResults = await memoryVectorStore.search(queryEmbedding, {
              limit,
              minSimilarity,
              type,
              userId
            });

            if (vectorResults.length > 0) {
              // Fetch full memory documents from MongoDB
              const memoryIds = vectorResults.map(r => r.id);
              const memories = await Memory.find({ _id: { $in: memoryIds } });

              // Sort by vector similarity order and update access counts
              const memoriesMap = new Map(memories.map(m => [m._id.toString(), m]));
              const sortedMemories = [];

              for (const result of vectorResults) {
                const memory = memoriesMap.get(result.id);
                if (memory) {
                  memory._similarity = result.similarity; // Attach similarity score
                  await memory.access();
                  sortedMemories.push(memory);
                }
              }

              logger.debug(`Vector search returned ${sortedMemories.length} memories for query: ${query.substring(0, 50)}...`);
              return sortedMemories;
            }
          }
        } catch (error) {
          logger.warn("Vector search failed, falling back to text search:", error.message);
        }
      }

      // Fallback to text/keyword search
      const mongoQuery = {};
      if (type) mongoQuery.type = type;
      if (userId) mongoQuery["metadata.userId"] = userId;
      if (tags.length > 0) mongoQuery["metadata.tags"] = { $in: tags };

      if (query) {
        mongoQuery.$text = { $search: query };
      }

      const memories = await Memory.find(mongoQuery)
        .sort({ "metadata.importance": -1, createdAt: -1 })
        .limit(limit);

      // Update access count
      for (const memory of memories) {
        await memory.access();
      }

      logger.debug(`Text search returned ${memories.length} memories for query: ${query?.substring(0, 50) || 'none'}...`);
      return memories;
    } catch (error) {
      logger.error("Failed to recall memories:", error);
      throw error;
    }
  }

  async getConversationContext(userId, limit = 20) {
    return await Memory.find({
      type: "conversation",
      "metadata.userId": userId
    })
    .sort({ createdAt: -1 })
    .limit(limit);
  }

  async storeConversation(userId, userMessage, agentResponse, metadata = {}) {
    // Track in-memory conversation buffer for follow-up detection
    // (raw conversations are NOT stored in DB — only learnable knowledge is persisted)
    if (!this._conversationBuffer) this._conversationBuffer = new Map();
    const uid = userId || 'default';
    const buffer = this._conversationBuffer.get(uid) || [];
    const userContent = typeof userMessage === 'string' ? userMessage : (userMessage?.content || String(userMessage || ''));
    const agentContent = typeof agentResponse === 'string' ? agentResponse : (agentResponse?.content || String(agentResponse || ''));
    if (userContent) buffer.push({ role: 'user', content: userContent.substring(0, 1000), ts: Date.now() });
    if (agentContent) buffer.push({ role: 'assistant', content: agentContent.substring(0, 1000), ts: Date.now() });
    // Keep last 10 messages per user, expire after 30 min
    const now = Date.now();
    const filtered = buffer.filter(m => now - m.ts < 30 * 60 * 1000).slice(-10);
    this._conversationBuffer.set(uid, filtered);

    // Only analyze for learnable knowledge — don't store raw conversations as memories.
    // Raw conversation storage was creating 13K+ junk entries (every message and response
    // stored verbatim with no value for recall). The AI filter in analyzeAndLearn
    // extracts only genuinely useful personal facts, preferences, and instructions.
    if (userId === process.env.TELEGRAM_USER_ID || metadata.isAuthenticated || userId === 'admin' || userId === 'web-user') {
      await this.analyzeAndLearn(userMessage, metadata);
    }
  }
  
  async analyzeAndLearn(message, metadata = {}) {
    try {
      // Enhanced patterns to capture complete information
      // Tight regex fast-pass for obvious patterns only.
      // Removed: instruction, goal, routine, method, project (too broad — caught commands as knowledge).
      // The AI filter in aiAnalyzeForMemory handles subtle/ambiguous cases.
      const patterns = {
        name: /(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
        // Require "I like/love/hate X" at start or after punctuation — NOT inside questions
        preference: /(?:^|[.!?]\s+)i (?:prefer|like|love|enjoy|hate|dislike)\s+(.+?)(?=\.\s|!\s|$)/i,
        work: /i (?:work|job|profession|do for a living)(?:\s+(?:is|as|at|in))?\s+(.+?)(?=\.\s|!\s|$)/i,
        location: /i (?:live|stay|from|located)(?:\s+in)?\s+([A-Za-z\s,]+?)(?=\.\s|!\s|$)/i,
        fact: /(?:remember that|keep in mind|note that|important:|fact:)\s*(.+?)(?=\.\s|!\s|$)/i
      };
      
      const userId = process.env.TELEGRAM_USER_ID;
      
      for (const [type, pattern] of Object.entries(patterns)) {
        const match = message.match(pattern);
        if (match) {
          let content = match[1].trim();
          
          // Ensure we capture the complete sentence for context
          const sentencePattern = new RegExp(`[^.!?]*${match[0]}[^.!?]*[.!?]?`);
          const fullSentenceMatch = message.match(sentencePattern);
          const fullContext = fullSentenceMatch ? fullSentenceMatch[0].trim() : message;
          
          // Use a more descriptive key based on content hash
          const contentHash = content.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
          const key = `master_${type}_${contentHash}`;
          
          // Check if we already know this
          const existing = await Memory.findOne({
            type: "knowledge",
            "metadata.userId": userId,
            "metadata.key": key
          });
          
          if (!existing) {
            // Store the full content with context
            const memoryContent = content.length > 100 ? content : fullContext;
            
            await this.store("knowledge", memoryContent, {
              userId,
              category: `master_${type}`,
              key,
              importance: type === 'name' ? 9 : 8,
              isPermanent: true,
              source: "conversation_analysis",
              tags: ["master_info", type],
              originalMessage: message.substring(0, 500), // Store original for context
              extractedValue: content // Store the extracted value separately
            });
            
            logger.info(`Learned about master's ${type}: ${content}`);
            
            // If this is a name detection for the master user, update their contact record
            if (type === 'name' && content) {
              const masterEmail = process.env.EMAIL_OF_MASTER;
              if (masterEmail && this.agent.apiManager && this.agent.apiManager.apis.has('email')) {
                try {
                  // Use executeAPI method instead of direct method call
                  await this.agent.apiManager.executeAPI('email', 'updateContact', {
                    email: masterEmail,
                    name: content
                  });
                  logger.info(`Updated master contact name to: ${content}`);
                } catch (error) {
                  logger.error('Failed to update master contact name:', error);
                }
              }
            }
          }
        }
      }
      
      // Run AI-based relevance filter for anything the regex didn't catch
      await this.aiAnalyzeForMemory(message, metadata);
    } catch (error) {
      logger.error("Failed to analyze and learn:", error);
    }
  }

  async aiAnalyzeForMemory(message, metadata = {}) {
    try {
      // Quick pre-filters — skip obvious non-knowledge messages
      if (!message || message.trim().length < 30) return;
      if (message.startsWith('/')) return;

      // Skip URL-only messages (e.g. "send me this as mp4 https://...")
      const urlPattern = /https?:\/\/\S+/g;
      const withoutUrls = message.replace(urlPattern, '').trim();
      if (withoutUrls.length < 20) return;

      // Skip obvious commands/requests (cheap string check before AI call)
      // Only skip unambiguous action verbs — NOT question words (what/who/how/why/where)
      // which can contain personal info like "what I like is..." or "who I work with"
      const commandStarts = /^(send|show|check|download|get|play|open|run|deploy|restart|stop|start|list|delete|remove|find|search|create|make|set|update|can you|could you|please)\b/i;
      if (commandStarts.test(withoutUrls)) return;

      const userId = process.env.TELEGRAM_USER_ID;

      const prompt = `You are a memory relevance filter for a personal AI assistant. Analyze this user message and decide if it contains personal information worth remembering permanently.

REMEMBER (return worth_remembering=true):
- Personal facts about the user (name, age, family, pets, relationships)
- Preferences, opinions, likes/dislikes (food, music, habits, pet peeves)
- Explicit instructions for how the assistant should behave
- Important project context or ongoing situations
- Corrections to previously known information

IGNORE (return worth_remembering=false):
- Commands or requests (download X, send Y, show Z, check status)
- Questions or queries (what is X, how do I Y)
- Transient tasks (one-off operations, temporary instructions)
- URLs being shared for processing (not for remembering)
- Operational confirmations or status updates
- Greetings, small talk, acknowledgements

User message: "${message.substring(0, 500)}"

Respond with ONLY valid JSON, no other text:
{"worth_remembering": true/false, "type": "preference|fact|instruction|relationship|context", "summary": "concise fact to remember", "importance": 1-10}`;

      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 150,
        temperature: 0.1
      });

      if (!response) return;

      // Parse the AI response — extract JSON from potentially noisy output
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return;

      let result;
      try {
        result = JSON.parse(jsonMatch[0]);
      } catch {
        return; // Malformed JSON, skip silently
      }

      if (!result.worth_remembering || !result.summary) return;

      const contentHash = result.summary.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const key = `ai_learned_${result.type || 'general'}_${contentHash}`;

      const existing = await Memory.findOne({
        type: "knowledge",
        "metadata.userId": userId,
        "metadata.key": key
      });

      if (!existing) {
        await this.store("knowledge", result.summary, {
          userId,
          category: `ai_${result.type || 'general'}`,
          key,
          importance: Math.min(Math.max(result.importance || 6, 1), 10),
          isPermanent: true,
          source: "ai_conversation_analysis",
          tags: ["ai_learned", result.type || "general"],
          originalMessage: message.substring(0, 500)
        });

        logger.info(`AI memory filter stored (${result.type}): ${result.summary}`);
      }
    } catch (error) {
      // AI filter failures must never break conversation flow
      logger.debug("AI memory filter skipped:", error.message);
    }
  }

  async getUserPreferences(userId) {
    const preferences = await Memory.find({
      type: "preference",
      "metadata.userId": userId
    });
    
    // Convert to object
    const prefObject = {};
    preferences.forEach(pref => {
      const key = pref.metadata.key || pref.metadata.category;
      if (key) {
        prefObject[key] = pref.content;
      }
    });
    
    return prefObject;
  }

  async storePreference(userId, key, value) {
    // Check if preference exists
    const existing = await Memory.findOne({
      type: "preference",
      "metadata.userId": userId,
      "metadata.key": key
    });

    if (existing) {
      existing.content = value;
      await existing.save();
      return existing;
    }

    return await this.store("preference", value, {
      userId,
      key,
      isPermanent: true
    });
  }

  async getSystemKnowledge(category = null) {
    const query = {
      type: "knowledge",
      isPermanent: true
    };
    
    if (category) {
      query["metadata.category"] = category;
    }
    
    return await Memory.find(query)
      .sort({ "metadata.importance": -1 });
  }

  async storeKnowledge(content, category, metadata = {}) {
    return await this.store("knowledge", content, {
      category,
      isPermanent: true,
      importance: metadata.importance || 7,
      ...metadata
    });
  }

  async summarizeMemories(userId, timeRange = 86400000) { // 24 hours
    const since = new Date(Date.now() - timeRange);
    
    const memories = await Memory.find({
      "metadata.userId": userId,
      createdAt: { $gte: since }
    }).sort({ createdAt: 1 });

    if (memories.length === 0) {
      return "No recent memories found.";
    }

    // Group by type
    const grouped = {};
    memories.forEach(memory => {
      if (!grouped[memory.type]) {
        grouped[memory.type] = [];
      }
      grouped[memory.type].push(memory);
    });

    // Create summary
    let summary = `Memory summary for the last ${timeRange / 3600000} hours:\n\n`;
    
    for (const [type, mems] of Object.entries(grouped)) {
      summary += `**${type.charAt(0).toUpperCase() + type.slice(1)} (${mems.length})**:\n`;
      
      // Get top 3 most important/recent
      const topMems = mems
        .sort((a, b) => b.metadata.importance - a.metadata.importance)
        .slice(0, 3);
      
      topMems.forEach(mem => {
        summary += `- ${mem.content.substring(0, 100)}...\n`;
      });
      
      summary += "\n";
    }

    return summary;
  }

  addToCache(memory) {
    if (this.cache.size >= this.maxCacheSize) {
      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(memory._id.toString(), memory);
  }

  getCached(id) {
    return this.cache.get(id);
  }

  async loadRecentMemories(limit = 100) {
    try {
      const memories = await Memory.find({})
        .sort({ lastAccessedAt: -1, createdAt: -1 })
        .limit(limit);
      
      memories.forEach(memory => {
        this.addToCache(memory);
      });
      
      logger.info(`Loaded ${memories.length} memories into cache`);
    } catch (error) {
      logger.error("Failed to load memories into cache:", error);
    }
  }

  async cleanup() {
    try {
      const result = await Memory.cleanupExpired();
      if (result.deletedCount > 0) {
        logger.info(`Cleaned up ${result.deletedCount} expired memories`);
      }
    } catch (error) {
      logger.error("Memory cleanup failed:", error);
    }
  }

  // Advanced retrieval methods
  async searchByTimeRange(startDate, endDate, options = {}) {
    const query = {
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      }
    };

    if (options.type) query.type = options.type;
    if (options.userId) query["metadata.userId"] = options.userId;

    return await Memory.find(query)
      .sort({ createdAt: -1 })
      .limit(options.limit || 50);
  }

  async getRelatedMemories(memoryId, limit = 10) {
    const memory = await Memory.findById(memoryId);
    if (!memory) return [];

    // Find memories with similar tags, same conversation, or same category
    const relatedQueries = [
      { "metadata.conversationId": memory.metadata.conversationId },
      { "metadata.tags": { $in: memory.metadata.tags || [] } },
      { "metadata.category": memory.metadata.category }
    ];

    const related = await Memory.find({
      $or: relatedQueries,
      _id: { $ne: memoryId }
    })
    .sort({ "metadata.importance": -1, createdAt: -1 })
    .limit(limit);

    return related;
  }

  async searchByImportance(minImportance = 5, options = {}) {
    const query = {
      "metadata.importance": { $gte: minImportance }
    };

    if (options.type) query.type = options.type;
    if (options.category) query["metadata.category"] = options.category;

    return await Memory.find(query)
      .sort({ "metadata.importance": -1, createdAt: -1 })
      .limit(options.limit || 20);
  }

  async getMostAccessed(limit = 10, type = null) {
    const query = type ? { type } : {};
    
    return await Memory.find(query)
      .sort({ accessCount: -1, lastAccessedAt: -1 })
      .limit(limit);
  }

  async fullTextSearch(searchText, options = {}) {
    const results = await Memory.aggregate([
      {
        $match: {
          $text: { $search: searchText },
          ...(options.type && { type: options.type }),
          ...(options.userId && { "metadata.userId": options.userId })
        }
      },
      {
        $addFields: {
          score: { $meta: "textScore" }
        }
      },
      {
        $sort: {
          score: { $meta: "textScore" },
          createdAt: -1
        }
      },
      {
        $limit: options.limit || 20
      }
    ]);

    return results;
  }

  async getMemoryStats(userId = null) {
    const matchStage = userId ? { "metadata.userId": userId } : {};

    const stats = await Memory.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          avgImportance: { $avg: "$metadata.importance" },
          totalAccessCount: { $sum: "$accessCount" }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    const totalMemories = await Memory.countDocuments(matchStage);
    const oldestMemory = await Memory.findOne(matchStage).sort({ createdAt: 1 });
    const newestMemory = await Memory.findOne(matchStage).sort({ createdAt: -1 });

    // Get vector store stats
    let vectorStoreStats = { initialized: false };
    if (this.vectorStoreReady) {
      try {
        vectorStoreStats = await memoryVectorStore.getStats();
      } catch (error) {
        logger.warn("Failed to get vector store stats:", error.message);
      }
    }

    return {
      total: totalMemories,
      byType: stats,
      dateRange: {
        oldest: oldestMemory?.createdAt,
        newest: newestMemory?.createdAt
      },
      vectorStore: vectorStoreStats,
      settings: this.settings
    };
  }

  async exportMemories(userId, format = 'json') {
    const memories = await Memory.find({ "metadata.userId": userId })
      .sort({ createdAt: -1 });

    if (format === 'json') {
      return memories;
    } else if (format === 'text') {
      let text = `Memory Export for User ${userId}\n`;
      text += `Generated: ${new Date().toISOString()}\n\n`;

      memories.forEach(mem => {
        text += `[${mem.type.toUpperCase()}] ${mem.createdAt.toISOString()}\n`;
        text += `${mem.content}\n`;
        if (mem.metadata.tags?.length) {
          text += `Tags: ${mem.metadata.tags.join(', ')}\n`;
        }
        text += `---\n\n`;
      });

      return text;
    }
  }

  async consolidateMemories(userId, olderThan = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThan);

    const oldMemories = await Memory.find({
      "metadata.userId": userId,
      type: "conversation",
      createdAt: { $lt: cutoffDate }
    }).sort({ createdAt: 1 });

    if (oldMemories.length < 10) return null;

    // Group by conversation
    const conversations = {};
    oldMemories.forEach(mem => {
      const convId = mem.metadata.conversationId || 'default';
      if (!conversations[convId]) conversations[convId] = [];
      conversations[convId].push(mem);
    });

    // Create summaries
    const summaries = [];
    for (const [convId, mems] of Object.entries(conversations)) {
      if (mems.length < 5) continue;

      const summary = `Conversation summary from ${mems[0].createdAt.toLocaleDateString()}: ${mems.length} exchanges covering: ${this.extractTopics(mems).join(', ')}`;
      
      const summaryMem = await this.store('summary', summary, {
        userId,
        conversationId: convId,
        sourceMemories: mems.map(m => m._id),
        importance: 6
      });

      summaries.push(summaryMem);
    }

    return summaries;
  }

  extractTopics(memories) {
    // Simple topic extraction - could be enhanced with NLP
    const words = {};
    memories.forEach(mem => {
      const content = mem.content.toLowerCase();
      const importantWords = content.match(/\b\w{4,}\b/g) || [];
      importantWords.forEach(word => {
        if (!['that', 'this', 'with', 'from', 'have', 'will', 'what', 'when', 'where'].includes(word)) {
          words[word] = (words[word] || 0) + 1;
        }
      });
    });

    return Object.entries(words)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  // Get recent conversations for admin dashboard
  async getRecentConversations(limit = 20) {
    try {
      const conversations = await Memory.find({
        type: 'conversation'
      })
      .sort({ createdAt: -1 })
      .limit(limit);

      // Group by conversation pairs (user message + agent response)
      const conversationPairs = [];
      for (let i = 0; i < conversations.length; i += 2) {
        const userMsg = conversations[i];
        const agentMsg = conversations[i + 1];
        
        if (userMsg && agentMsg) {
          conversationPairs.push({
            id: userMsg._id,
            userMessage: userMsg.content || 'No content',
            agentMessage: agentMsg.content || 'No response',
            timestamp: userMsg.createdAt,
            userId: userMsg.metadata?.userId || 'Unknown',
            userName: userMsg.metadata?.userName || 'Unknown User',
            role: userMsg.metadata?.role || 'user'
          });
        } else if (userMsg) {
          // Single message without pair
          conversationPairs.push({
            id: userMsg._id,
            userMessage: userMsg.content || 'No content',
            agentMessage: 'No response',
            timestamp: userMsg.createdAt,
            userId: userMsg.metadata?.userId || 'Unknown',
            userName: userMsg.metadata?.userName || 'Unknown User',
            role: userMsg.metadata?.role || 'user'
          });
        }
      }

      return conversationPairs.slice(0, limit / 2); // Return half since we're pairing
    } catch (error) {
      logger.error('Failed to get recent conversations:', error);
      return [];
    }
  }

  // Method for agent to retrieve its own operational knowledge
  async getAgentKnowledge(category = null) {
    const query = {
      type: 'knowledge',
      'metadata.isAgentKnowledge': true
    };

    if (category) {
      query['metadata.category'] = category;
    }

    return await Memory.find(query)
      .sort({ 'metadata.importance': -1, lastAccessedAt: -1 });
  }

  // Store learned patterns or behaviors
  async learnPattern(pattern, context, success = true) {
    return await this.store('pattern', pattern, {
      context,
      success,
      isAgentKnowledge: true,
      category: 'behavioral_pattern',
      importance: success ? 8 : 4
    });
  }

  // Clear conversation history for a user
  async clearConversationHistory(userId) {
    try {
      // Get memory IDs before deleting (for vector store cleanup)
      const memoriesToDelete = await Memory.find({
        type: 'conversation',
        'metadata.userId': userId,
        isPermanent: { $ne: true }
      }).select('_id');

      const memoryIds = memoriesToDelete.map(m => m._id.toString());

      const result = await Memory.deleteMany({
        type: 'conversation',
        'metadata.userId': userId,
        isPermanent: { $ne: true } // Don't delete permanent memories
      });

      logger.info(`Cleared ${result.deletedCount} conversation memories for user ${userId}`);

      // Clear from vector store
      if (this.vectorStoreReady && memoryIds.length > 0) {
        try {
          await memoryVectorStore.deleteMemories(memoryIds);
        } catch (error) {
          logger.warn('Failed to clear memories from vector store:', error.message);
        }
      }

      // Clear from cache as well
      for (const [key, memory] of this.cache.entries()) {
        if (memory.type === 'conversation' && memory.metadata.userId === userId) {
          this.cache.delete(key);
        }
      }

      return result;
    } catch (error) {
      logger.error('Failed to clear conversation history:', error);
      throw error;
    }
  }

  // Get current memory settings
  getSettings() {
    return { ...this.settings };
  }

  // Update memory settings
  async updateSettings(updates) {
    this.settings = {
      ...this.settings,
      ...updates
    };
    
    // Store settings in database for persistence
    try {
      await Memory.findOneAndUpdate(
        { type: 'system_settings', 'metadata.key': 'memory_settings' },
        {
          type: 'system_settings',
          content: JSON.stringify(this.settings),
          metadata: {
            key: 'memory_settings',
            updatedAt: new Date()
          }
        },
        { upsert: true, new: true }
      );
      logger.info('Memory settings updated:', this.settings);
    } catch (error) {
      logger.error('Failed to save memory settings:', error);
    }
    
    return this.settings;
  }

  // Load settings from database
  async loadSettings() {
    try {
      const savedSettings = await Memory.findOne({
        type: 'system_settings',
        'metadata.key': 'memory_settings'
      });
      
      if (savedSettings) {
        const parsedSettings = safeJsonParse(savedSettings.content, this.settings);
        if (parsedSettings) {
          this.settings = parsedSettings;
          logger.info('Loaded memory settings:', this.settings);
        }
      }
    } catch (error) {
      logger.error('Failed to load memory settings:', error);
    }
  }
}