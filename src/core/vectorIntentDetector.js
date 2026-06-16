import { logger } from '../utils/logger.js';
import { embeddingService } from '../services/embeddingService.js';
import { vectorStore } from '../services/vectorStore.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

/**
 * Vector-based intent detection using embeddings and similarity search
 */
export class VectorIntentDetector {
  constructor(agent = null) {
    this.agent = agent;
    this.enabled = false;
    this.initialized = false;
    // Use node-cache with 10-minute TTL
    this.cache = new NodeCache({ 
      stdTTL: 600, // 10 minutes
      checkperiod: 120, // Check for expired entries every 2 minutes
      useClones: false, // Don't clone for better performance
      maxKeys: 1000 // Limit cache size
    });
    this.cacheHits = 0;
    this.cacheMisses = 0;
    
    // Set up cache event logging
    this.cache.on('expired', (key, value) => {
      logger.debug(`Intent cache expired for: ${key}`);
    });
    
    logger.info('VectorIntentDetector constructed');
  }

  async initialize() {
    try {
      logger.info('Initializing VectorIntentDetector...');
      
      // Check if vector intent is enabled
      this.enabled = process.env.ENABLE_VECTOR_INTENT === 'true';
      
      if (!this.enabled) {
        logger.info('VectorIntentDetector is disabled (ENABLE_VECTOR_INTENT not true)');
        return;
      }
      
      this.initialized = true;
      logger.info('VectorIntentDetector initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize VectorIntentDetector:', error);
      this.enabled = false;
      throw error;
    }
  }

  async detectIntent(input, context = {}) {
    if (!this.enabled || !this.initialized) {
      logger.debug('VectorIntentDetector not enabled or initialized');
      return null;
    }

    logger.info(`VectorIntentDetector.detectIntent called with: "${input}"`);
    
    try {
      // Check cache first
      const cachedResult = this.cache.get(input);
      if (cachedResult !== undefined) {
        this.cacheHits++;
        logger.info(`Cache hit for input (hits: ${this.cacheHits}, misses: ${this.cacheMisses})`);
        return cachedResult;
      }
      
      this.cacheMisses++;
      
      // Generate embedding for the input with retry logic
      const embedding = await retryOperation(
        () => embeddingService.generateEmbedding(input),
        { retries: 3, context: 'embedding generation' }
      );
      logger.debug('Generated embedding for input');

      // Search for similar intents with retry logic
      const k = 5; // Top 5 candidates
      const results = await retryOperation(
        () => vectorStore.search(embedding, k),
        { retries: 3, context: 'vector search' }
      );
      
      if (!results || results.length === 0) {
        logger.info('No vector matches found');
        return null;
      }
      
      // Get the best match (lowest distance)
      const bestMatch = results[0];
      
      // Debug log the structure
      logger.info('Best match structure keys:', Object.keys(bestMatch));
      logger.info('Best match values:', {
        id: bestMatch.id,
        distance: bestMatch.distance,
        _distance: bestMatch._distance,
        similarity: bestMatch.similarity,
        hasMetadata: !!bestMatch.metadata
      });
      
      // The vectorStore returns transformed results with metadata
      const metadata = bestMatch.metadata || bestMatch;
      const distance = bestMatch.distance !== undefined ? bestMatch.distance : (bestMatch._distance || 2);
      const similarity = bestMatch.similarity !== undefined ? bestMatch.similarity : Math.max(0, 1 - distance);
      
      // Log metadata structure
      logger.debug('Metadata keys:', Object.keys(metadata));
      logger.debug('Full metadata:', JSON.stringify(metadata, null, 2));
      
      logger.info(`Best match: ${metadata.name}, distance: ${distance}, similarity: ${similarity}`);
      
      // Check if similarity meets threshold
      // Low-confidence matches fall back to AI intent detection for better accuracy.
      // Plugins with many similar CRUD actions (like dry-ai) need a higher threshold
      // because vector similarity often confuses create/update/delete/list operations.
      // The 'system' plugin (restart, redeploy, etc.) needs a higher threshold to prevent
      // accidental destructive actions from vague inputs like the agent's name.
      const isSystemPlugin = !metadata.plugin || metadata.plugin === '_system' || metadata.plugin === 'system';
      const isDangerousAction = metadata.action && /^(restart|redeploy|shutdown|stop)$/i.test(metadata.action);
      let threshold = isSystemPlugin ? 0.6 : 0.5;
      if (isDangerousAction) threshold = Math.max(threshold, 0.7);
      if (similarity < threshold) {
        logger.info(`Best match similarity ${similarity.toFixed(3)} below threshold ${threshold}${isDangerousAction ? ' (dangerous action)' : isSystemPlugin ? '' : ` (${metadata.plugin})`}, falling back to AI`);
        return null;
      }
      
      logger.info(`Vector match found: ${metadata.name} (similarity: ${similarity})`);

      // Override: song requests without "lyrics" should route to ytdlp, not lyrics plugin
      if (metadata.plugin === 'lyrics' && !/\blyrics?\b|\bwords\s+(to|of)\b/i.test(input)) {
        const downloadPattern = /\b(download|grab|save|get\s+me|send\s+me)\b.*\b(song|mp3|mp4|audio)\b|\b(song|video|music|track)\b.*\b(send\s+me|download|as\s+mp3|as\s+mp4)\b/i;
        const searchPattern = /\b(find|search|look\s*up|look\s+for)\b.*\b(song|video|music|track)\b/i;

        if (downloadPattern.test(input)) {
          // User wants to download — route to downloadAudio (which auto-searches when no URL)
          const wantsVideo = /\b(mp4|video)\b/i.test(input);
          logger.info(`Overriding lyrics match → ytdlp.${wantsVideo ? 'download' : 'audio'} (user wants to download, not get lyrics)`);
          metadata.name = wantsVideo ? 'downloadVideo' : 'downloadAudio';
          metadata.plugin = 'ytdlp';
          metadata.action = wantsVideo ? 'download' : 'audio';
          metadata.description = wantsVideo ? 'Download video from YouTube' : 'Download audio/MP3 from YouTube';
        } else if (searchPattern.test(input)) {
          // User wants to find/search — route to ytdlp.search
          logger.info(`Overriding lyrics match → ytdlp.search (user wants to find, not get lyrics)`);
          metadata.name = 'searchYoutube';
          metadata.plugin = 'ytdlp';
          metadata.action = 'search';
          metadata.description = 'Search YouTube for videos or songs by name';
        }
      }

      // Override: ytdlp.transcribe → ytdlp.download when user wants to download, not transcribe
      if (metadata.plugin === 'ytdlp' && metadata.action === 'transcribe') {
        const wantsDownload = /\b(send|download|grab|save|get\s+me|send\s+me|as\s+(an?\s+)?mp[34]|as\s+video|as\s+audio)\b/i.test(input);
        if (wantsDownload) {
          const wantsVideo = /\b(mp4|video)\b/i.test(input);
          logger.info(`Overriding ytdlp.transcribe → ytdlp.${wantsVideo ? 'download' : 'audio'} (user wants download, not transcript)`);
          metadata.name = wantsVideo ? 'downloadVideo' : 'downloadAudio';
          metadata.action = wantsVideo ? 'download' : 'audio';
          metadata.description = wantsVideo ? 'Download video from YouTube' : 'Download audio/MP3 from YouTube';
        }
      }

      // Upgrade: ytdlp.search → ytdlp.audio when user clearly wants to download
      if (metadata.plugin === 'ytdlp' && metadata.action === 'search') {
        const downloadPattern = /\b(download|grab|save|send\s+me|get\s+me)\b.*\b(mp3|mp4|audio|song|file)\b|\b(mp3|mp4|audio|song)\b.*\b(send|download|save)\b/i;
        if (downloadPattern.test(input)) {
          const wantsVideo = /\b(mp4|video)\b/i.test(input);
          logger.info(`Upgrading ytdlp.search → ytdlp.${wantsVideo ? 'download' : 'audio'} (user wants download, not just search)`);
          metadata.name = wantsVideo ? 'downloadVideo' : 'downloadAudio';
          metadata.action = wantsVideo ? 'download' : 'audio';
          metadata.description = wantsVideo ? 'Download video from YouTube' : 'Download audio/MP3 from YouTube';
        }
      }

      // Disambiguate *arr plugin actions — vector similarity groups same-plugin
      // intents too closely, so use action keywords to select the right handler
      if (['readarr', 'radarr', 'sonarr', 'lidarr', 'prowlarr'].includes(metadata.plugin)) {
        const lowerInput = input.toLowerCase();
        const addWords = /\b(add|put|grab|import|download)\b/i.test(input);
        const removeWords = /\b(remove|delete|drop|take\s+off|get\s+rid\s+of)\b/i.test(input);
        const searchWords = /\b(search|find|look\s*up|look\s+for|can\s+you\s+find)\b/i.test(input);
        const listWords = /\b(list|show|display|view|what\b.*\bdo\s+i\s+have|what\b.*\bi\s+have|who\s+is|how\s+many|my\s+(readarr|radarr|sonarr|lidarr)\s+(library|collection)|what('s|\s+is)\s+in)\b/i.test(input);

        // Map plugin to its content entity type
        const entityMap = {
          readarr: { list: 'get_authors', search: 'search_author', add: 'add_author', remove: 'delete_author' },
          radarr: { list: 'get_movies', search: 'search_movie', add: 'add_movie', remove: 'delete_movie' },
          sonarr: { list: 'get_series', search: 'search_series', add: 'add_series', remove: 'delete_series' },
          lidarr: { list: 'get_artists', search: 'search_artist', add: 'add_artist', remove: 'delete_artist' }
        };

        const actions = entityMap[metadata.plugin];
        if (actions) {
          let correctedAction = null;
          if (removeWords) correctedAction = actions.remove;
          else if (addWords && !listWords) correctedAction = actions.add;
          else if (searchWords && !listWords) correctedAction = actions.search;
          else if (listWords && !addWords && !searchWords) correctedAction = actions.list;

          if (correctedAction && correctedAction !== metadata.action) {
            logger.info(`Disambiguating ${metadata.plugin}: ${metadata.action} → ${correctedAction} (keyword match)`);
            metadata.action = correctedAction;
            metadata.name = `${metadata.plugin} ${correctedAction}`;
          }
        }
      }

      // Override: "upload" with dry/dry.ai context should route to dry-ai, not microcontroller
      if (metadata.plugin === 'microcontroller' && metadata.action === 'upload') {
        const dryContext = /\b(dry|dry\.ai|dry\s*ai|space|memories|folder)\b/i.test(input);
        const fileContext = /\b(file|photo|image|document|picture|attachment)\b/i.test(input);
        if (dryContext || fileContext) {
          logger.info(`Override: microcontroller.upload → dry-ai.uploadFile (dry/file context detected)`);
          metadata.plugin = 'dry-ai';
          metadata.action = 'uploadFile';
          metadata.name = 'dry-ai uploadFile';
          metadata.description = 'Upload a file to Dry.AI';
        }
      }

      // Dry-ai post-match disambiguation for CRUD action confusion
      if (metadata.plugin === 'dry-ai') {
        const deleteWords = /\b(delete|remove|trash|destroy|get\s+rid\s+of)\b/i.test(input);
        const createWords = /\b(create|make|set\s+up|build|new)\b/i.test(input);
        const addWords = /\b(add|save|store|put|remember|log|record|track)\b/i.test(input);
        const uploadWords = /\b(upload|send.*file|attach|file.*to)\b/i.test(input);
        const listWords = /\b(list|show|what.*items|what.*in)\b/i.test(input);
        const spaceTargetWords = /\b(to|in|into|on)\s+(my\s+|your\s+|the\s+)?\w+\s+(space|folder)\b/i.test(input);

        // Upload intent misrouted to list/create/update
        if (uploadWords && !listWords && metadata.action !== 'uploadFile') {
          logger.info(`Dry-ai safety: ${metadata.action} → uploadFile (upload words present)`);
          metadata.action = 'uploadFile';
          metadata.name = 'dry-ai uploadFile';
          metadata.description = 'Upload a file to Dry.AI';
        }
        // "Add X to Y space" misrouted to createSpace — user wants to add an item, not create a space
        // Only skip override if user explicitly wants to create/make a new space
        else if (addWords && spaceTargetWords && metadata.action === 'createSpace'
          && !/\b(create|make|build|set\s+up)\s+(a\s+)?(new\s+)?space\b/i.test(input)) {
          logger.info(`Dry-ai safety: createSpace → createItem (add-to-space pattern detected)`);
          metadata.action = 'createItem';
          metadata.name = 'dry-ai createItem';
          metadata.description = 'Create an item in a Dry.AI space';
        }
        // Delete intent misrouted to create/update
        else if (deleteWords && !createWords && metadata.action !== 'deleteItem' && metadata.action !== 'deleteByQuery') {
          logger.info(`Dry-ai safety: ${metadata.action} → deleteItem (delete words present)`);
          metadata.action = 'deleteItem';
          metadata.name = 'dry-ai deleteItem';
          metadata.description = 'Delete an item, space, or app from Dry.AI';
        }
      }

      // For parameter extraction, we'll use AI instead of brittle regex patterns
      // But provide defaults for known intents
      let parameters = {};

      // Pre-extract query or URL for ytdlp actions
      if (metadata.plugin === 'ytdlp' && ['search', 'audio', 'download'].includes(metadata.action) && !/(https?:\/\/)/i.test(input)) {
        // No URL in message — check if this is a follow-up referencing a previous URL
        const isFollowUp = /\b(like\s+i\s+(asked|said)|again|the\s+(same|video|mp[34])|that\s+(video|link|url)|it\b)/i.test(input);
        let foundUrlFromHistory = false;

        if (isFollowUp && this.agent?.memoryManager && context.userId) {
          try {
            const recent = await this.agent.memoryManager.getConversationContext(context.userId, 6);
            if (recent && recent.length > 0) {
              // Search recent messages for a URL
              for (const conv of recent) {
                const urlMatch = conv.content?.match(/(https?:\/\/[^\s]+)/);
                if (urlMatch) {
                  parameters.url = urlMatch[1];
                  logger.info(`Found URL from conversation history: ${parameters.url}`);
                  foundUrlFromHistory = true;
                  break;
                }
              }
            }
          } catch (err) {
            logger.debug('Could not check conversation history for URL:', err);
          }
        }

        if (!foundUrlFromHistory) {
          const searchQuery = input
            .replace(/^(send\s+me|play\s+me|play|search|find|look\s*up|look\s+for|search\s+for|search\s+youtube\s+for|find\s+me|get\s+me|download\s+me|download)\s*/i, '')
            .replace(/^(me\s+)?(a\s+|the\s+)?(song|video|music|music\s+video|track|mp3|mp4)\s*(called|named|titled|by\s+the\s+name\s+of)?\s*/i, '')
            .replace(/\s+and\s+(send|give|download|get)\s+.*$/i, '')
            .replace(/\s+(on|from)\s+youtube\b/i, '')
            .replace(/\s+(as|in)\s+(an?\s+)?(mp3|mp4|audio|video)\b/i, '')
            .replace(/\s+send\s+(it\s+)?(to\s+)?(me\s*)?$/i, '')
            .replace(/\s+send\s+(me\s+)?(the\s+)?(mp3|mp4|audio|file).*$/i, '')
            .trim();
          parameters.query = searchQuery || input;
          logger.info(`Pre-extracted search query: "${parameters.query}"`);
        }
      }

      // Set default parameters for specific intents
      if (metadata.action === 'getRecentChanges' || metadata.name === 'showChangelog') {
        // Default to 7 days for changelog queries
        parameters = { days: 7 };
      }

      // Add a flag to indicate this needs AI parameter extraction
      const needsAIExtraction = true;
      
      // Log the actual values we're about to return
      const result = {
        detected: true,
        intent: metadata.action || 'undefined_action',
        action: metadata.action || 'undefined_action',  // Agent expects 'action' field
        plugin: metadata.plugin || 'undefined_plugin',
        intentId: bestMatch.id || metadata.id || null,   // Unique intent ID for sub-agent matching
        confidence: similarity,
        parameters: parameters, // Empty for now, will be filled by AI
        needsParameterExtraction: true, // Tell agent to use AI for parameters
        metadata: {
          name: metadata.name,
          description: metadata.description,
          vectorMatch: true,
          originalInput: input,
          intentExamples: metadata.examples || []
        }
      };
      
      // Cache the result before returning
      this.cache.set(input, result);
      
      logger.info('Vector detector returning:', JSON.stringify(result));
      return result;
      
    } catch (error) {
      logger.error('Vector intent detection failed:', error);
      return null;
    }
  }

  getStats() {
    const cacheStats = this.cache.getStats();
    
    return {
      enabled: this.enabled,
      initialized: this.initialized,
      cache: {
        keys: cacheStats.keys,
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: this.cacheHits + this.cacheMisses > 0 
          ? (this.cacheHits / (this.cacheHits + this.cacheMisses) * 100).toFixed(2) + '%'
          : '0%',
        ksize: cacheStats.ksize,
        vsize: cacheStats.vsize
      }
    };
  }
}

// Export singleton instance
export const vectorIntentDetector = new VectorIntentDetector();