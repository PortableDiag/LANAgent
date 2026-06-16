import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';

export class ModelUpdaterService extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.lastUpdate = null;
    this.modelCache = new Map();
    
    // Provider-specific configurations
    this.providerConfigs = {
      openai: {
        modelsUrl: 'https://platform.openai.com/docs/models',
        apiDocsUrl: 'https://platform.openai.com/docs/api-reference',
        selector: {
          models: 'table tbody tr',
          modelName: 'td:first-child code',
          description: 'td:nth-child(2)',
          contextWindow: 'td:nth-child(3)'
        }
      },
      anthropic: {
        modelsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
        apiDocsUrl: 'https://platform.claude.com/docs/en/api',
        selector: {
          models: '.model-card, table tbody tr',
          modelName: 'h3, td:first-child',
          description: '.description, td:nth-child(2)',
          contextWindow: '.context-length, td:nth-child(3)'
        }
      },
      huggingface: {
        apiUrl: 'https://huggingface.co/api/models',
        modelsUrl: 'https://huggingface.co/models',
        modelsPageUrl: 'https://huggingface.co/models?pipeline_tag=text-generation&inference_provider=all&sort=likes',
        modelsPageDownloadsUrl: 'https://huggingface.co/models?pipeline_tag=text-generation&inference_provider=all&sort=downloads',
        filters: {
          task: 'text-generation',
          library: 'transformers',
          sort: 'likes',
          limit: 50
        }
      },
      gab: {
        modelsUrl: 'https://gab.ai/models?initial=false',
        apiUrl: 'https://gab.ai/api/models',
        docsUrl: 'https://gab.ai/docs'
      }
    };
  }

  async initialize() {
    logger.info('Initializing Model Updater Service...');
    
    // Load cached models from database
    await this.loadCachedModels();
    
    // Perform initial update
    await this.updateAllProviders();
    
    logger.info('Model Updater Service initialized');
  }

  async loadCachedModels() {
    try {
      const { ModelCache } = await import('../models/ModelCache.js');
      const cachedModels = await ModelCache.find({});
      
      for (const cache of cachedModels) {
        this.modelCache.set(cache.provider, {
          models: cache.models,
          lastUpdated: cache.updatedAt,
          apiFormat: cache.apiFormat
        });
      }
      
      logger.info(`Loaded ${cachedModels.length} provider model caches`);
    } catch (error) {
      logger.debug('No cached models found:', error.message);
    }
  }

  async updateAllProviders() {
    logger.info('Updating all provider models...');
    
    const results = {
      success: [],
      failed: []
    };
    
    for (const provider of ['openai', 'anthropic', 'huggingface', 'gab']) {
      try {
        logger.info(`Updating ${provider} models...`);
        const updated = await this.updateProviderModels(provider);
        
        if (updated) {
          results.success.push(provider);
          this.emit('provider-updated', { provider, models: updated.models });
        }
      } catch (error) {
        logger.error(`Failed to update ${provider} models:`, error);
        results.failed.push({ provider, error: error.message });
      }
    }
    
    logger.info('Model update completed:', results);
    this.lastUpdate = new Date();
    
    return results;
  }

  async updateProviderModels(provider) {
    try {
      switch (provider) {
        case 'openai':
          return await this.scrapeOpenAIModels();
        case 'anthropic':
          return await this.scrapeAnthropicModels();
        case 'huggingface':
          return await this.fetchHuggingFaceModels();
        case 'gab':
          return await this.scrapeGabModels();
        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
    } catch (error) {
      logger.warn(`Primary update failed for ${provider}, trying fallback: ${error.message}`);
      return await this.updateProviderWithFallback(provider, error);
    }
  }

  async updateProviderWithFallback(provider, originalError) {
    try {
      // Try to find alternative URLs via web search
      const searchQuery = `${provider} API models documentation pricing ${new Date().getFullYear()}`;
      const searchResult = await this.searchForProviderInfo(provider, searchQuery);
      
      if (searchResult && searchResult.url) {
        logger.info(`Found alternative URL for ${provider}: ${searchResult.url}`);
        // Update the config with new URL
        this.providerConfigs[provider].modelsUrl = searchResult.url;
        
        // Retry with new URL
        return await this.updateProviderModels(provider);
      }
    } catch (fallbackError) {
      logger.error(`Fallback also failed for ${provider}:`, fallbackError);
    }
    
    // If all else fails, return cached data
    const cached = this.modelCache.get(provider);
    if (cached) {
      logger.info(`Returning cached data for ${provider}`);
      return cached;
    }
    
    throw originalError;
  }

  async searchForProviderInfo(provider, query) {
    try {
      // Use the agent's web search capabilities if available
      const webSearchPlugin = this.agent.apiManager?.getPlugin('websearch');
      if (webSearchPlugin?.enabled) {
        const result = await webSearchPlugin.execute({
          action: 'search',
          query: query,
          limit: 5
        });
        
        if (result.success && result.results?.length > 0) {
          // Find the most relevant result
          for (const item of result.results) {
            if (item.url && (
              item.url.includes('docs') || 
              item.url.includes('api') || 
              item.url.includes('models') ||
              item.url.includes('pricing')
            )) {
              return { url: item.url, title: item.title };
            }
          }
        }
      }
    } catch (error) {
      logger.debug(`Web search failed for ${provider}:`, error);
    }
    
    return null;
  }

  async scrapeOpenAIModels() {
    const config = this.providerConfigs.openai;
    let browser;
    
    try {
      // First try to fetch models via API if we have an API key
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey) {
        try {
          const response = await fetch('https://api.openai.com/v1/models', {
            headers: {
              'Authorization': `Bearer ${apiKey}`
            }
          });
          
          if (response.ok) {
            const data = await response.json();
            const models = data.data
              .filter(m => m.id.includes('gpt') || m.id.startsWith('o1') || m.id.startsWith('o3') || m.id.startsWith('o4') ||
                          m.id.includes('chatgpt') || m.id.includes('embedding') || m.id.includes('whisper') ||
                          m.id.includes('tts') || m.id.includes('dall'))
              .map(m => ({
                id: m.id,
                name: this.formatModelName(m.id),
                category: this.categorizeModel(m.id),
                created: new Date(m.created * 1000),
                owned_by: m.owned_by
              }))
              .sort((a, b) => b.created - a.created);
            
            logger.info(`Fetched ${models.length} models from OpenAI API`);
            await this.saveModelCache('openai', models, {});
            return { models, apiFormat: {} };
          }
        } catch (apiError) {
          logger.debug('Failed to fetch models via API:', apiError.message);
        }
      }
      
      // Try web scraping if API fails
      const scraperPlugin = this.agent.apiManager?.getPlugin('webScraper');
      
      if (scraperPlugin?.enabled) {
        // Use web scraper plugin
        const result = await scraperPlugin.execute({
          action: 'scrape',
          url: config.modelsUrl,
          selector: config.selector.models,
          extract: ['text', 'html']
        });
        
        if (result.success && result.data) {
          return this.parseOpenAIModels(result.data);
        }
      }
      
      // For now, return known models - web scraping can be enhanced later
      const knownModels = [
        { id: 'gpt-5.2-pro', name: 'GPT-5.2 Pro', contextWindow: 400000, category: 'chat' },
        { id: 'gpt-5.2', name: 'GPT-5.2 Thinking', contextWindow: 400000, category: 'chat' },
        { id: 'gpt-5.2-chat-latest', name: 'GPT-5.2 Instant', contextWindow: 400000, category: 'chat' },
        { id: 'gpt-5.1', name: 'GPT-5.1', contextWindow: 256000, category: 'chat' },
        { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', contextWindow: 256000, category: 'chat' },
        { id: 'gpt-5', name: 'GPT-5', contextWindow: 256000, category: 'chat' },
        { id: 'gpt-5-pro', name: 'GPT-5 Pro', contextWindow: 256000, category: 'chat' },
        { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 128000, category: 'chat' },
        { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', contextWindow: 128000, category: 'chat' },
        { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', contextWindow: 64000, category: 'chat' },
        { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, category: 'chat' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, category: 'chat' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextWindow: 128000, category: 'chat' },
        { id: 'gpt-4', name: 'GPT-4', contextWindow: 8192, category: 'chat' },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', contextWindow: 16385, category: 'chat' },
        { id: 'o1', name: 'O1', contextWindow: 200000, category: 'chat' },
        { id: 'o1-pro', name: 'O1 Pro', contextWindow: 200000, category: 'chat' },
        { id: 'text-embedding-3-small', name: 'Text Embedding 3 Small', category: 'embedding' },
        { id: 'text-embedding-3-large', name: 'Text Embedding 3 Large', category: 'embedding' },
        { id: 'text-embedding-ada-002', name: 'Text Embedding Ada v2', category: 'embedding' },
        { id: 'whisper-1', name: 'Whisper v1', category: 'whisper' },
        { id: 'tts-1', name: 'TTS v1', category: 'tts' },
        { id: 'tts-1-hd', name: 'TTS v1 HD', category: 'tts' },
        { id: 'dall-e-3', name: 'DALL-E 3', category: 'vision' },
        { id: 'dall-e-2', name: 'DALL-E 2', category: 'vision' }
      ];
      
      // Save to cache
      await this.saveModelCache('openai', knownModels, {});
      
      return { models: knownModels, apiFormat: {} };
      
    } catch (error) {
      if (browser) await browser.close();
      throw error;
    }
  }

  async scrapeAnthropicModels() {
    const config = this.providerConfigs.anthropic;
    
    try {
      // First try to fetch models via API if we have an API key
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const response = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'anthropic-version': '2023-06-01',
              'X-Api-Key': apiKey
            }
          });
          
          if (response.ok) {
            const data = await response.json();
            const apiModels = (data.data || [])
              .filter(m => m.id && m.id.includes('claude'))
              .map(m => ({
                id: m.id,
                name: m.display_name || this.formatModelName(m.id),
                category: this.categorizeModel(m.id),
                created: m.created_at ? new Date(m.created_at) : new Date(),
                contextWindow: this.getAnthropicContextWindow(m.id),
                available: true
              }));

            // Merge with known models (API may not return all models for this key tier)
            const knownExtras = [
              { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 1000000 },
              { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1000000 },
              { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
              { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
              { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
              { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', contextWindow: 200000 },
              { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', contextWindow: 200000 },
              { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', contextWindow: 200000 },
            ];
            const apiIds = new Set(apiModels.map(m => m.id));
            for (const known of knownExtras) {
              if (!apiIds.has(known.id)) {
                apiModels.push({ ...known, category: 'chat', available: false });
              }
            }
            apiModels.sort((a, b) => (b.created || 0) - (a.created || 0));

            logger.info(`Fetched ${apiModels.length} models from Anthropic API (${apiIds.size} from API + ${apiModels.length - apiIds.size} known)`);
            await this.saveModelCache('anthropic', apiModels, {});
            return { models: apiModels, apiFormat: {} };
          }
        } catch (apiError) {
          logger.debug('Failed to fetch models via Anthropic API:', apiError.message);
        }
      }
      
      // Try web scraping if API fails
      const scraperPlugin = this.agent.apiManager?.getPlugin('webScraper');
      
      if (scraperPlugin?.enabled) {
        const result = await scraperPlugin.execute({
          action: 'scrape',
          url: config.modelsUrl,
          waitFor: config.selector.models,
          extract: ['text', 'html']
        });
        
        if (result.success && result.data) {
          return this.parseAnthropicModels(result.data);
        }
      }
      
      // Fallback to known models
      const models = [];
      
      // Add known models if not found
      const knownModels = [
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 1000000 },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1000000 },
        { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
        { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
        { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', contextWindow: 200000 },
        { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', contextWindow: 200000 },
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', contextWindow: 200000 },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: 200000 },
        { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000 }
      ];
      
      knownModels.forEach(known => {
        if (!models.find(m => m.id === known.id)) {
          models.push({
            ...known,
            description: `${known.name} model`,
            category: 'chat',
            available: true
          });
        }
      });
      
      await this.saveModelCache('anthropic', models, {});
      return { models, apiFormat: {} };
      
    } catch (error) {
      logger.error('Failed to scrape Anthropic models:', error);
      // Return cached or default models
      return this.modelCache.get('anthropic') || { models: [], apiFormat: {} };
    }
  }

  async fetchHuggingFaceModels() {
    const config = this.providerConfigs.huggingface;
    
    try {
      // Fetch popular text generation models from HuggingFace API
      const params = new URLSearchParams({
        task: config.filters.task,
        library: config.filters.library,
        sort: config.filters.sort,
        limit: config.filters.limit,
        full: true
      });
      
      const response = await fetch(`${config.apiUrl}?${params}`);
      const data = await response.json();
      
      const models = data.map(model => ({
        id: model.modelId || model.id,
        name: model.modelId || model.id,
        description: model.description || `${model.downloads || 0} downloads`,
        likes: model.likes || 0,
        downloads: model.downloads || 0,
        category: this.categorizeHFModel(model),
        available: !model.private,
        lastModified: model.lastModified,
        tags: model.tags || []
      }));
      
      // Sort by popularity (likes + downloads)
      models.sort((a, b) => {
        const scoreA = (a.likes || 0) + (a.downloads || 0) / 1000;
        const scoreB = (b.likes || 0) + (b.downloads || 0) / 1000;
        return scoreB - scoreA;
      });
      
      // Also fetch specialized models for different tasks
      const specializedModels = await this.fetchSpecializedHFModels();
      
      // Include known good chat models if API doesn't return enough
      const knownChatModels = [
        'meta-llama/Llama-3.3-70B-Instruct',
        'meta-llama/Llama-3.2-11B-Vision-Instruct', 
        'meta-llama/Llama-3.2-3B-Instruct',
        'meta-llama/Llama-3.2-1B-Instruct',
        'deepseek-ai/DeepSeek-V3',
        'Qwen/QwQ-32B-Preview',
        'Qwen/Qwen2.5-72B-Instruct',
        'google/gemma-2-27b-it',
        'mistralai/Mistral-7B-Instruct-v0.3',
        'microsoft/Phi-3.5-mini-instruct',
        'HuggingFaceH4/zephyr-7b-beta',
        'openchat/openchat-3.5-0106',
        'NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO',
        'cognitivecomputations/dolphin-2.9.4-llama3.2-3b'
      ];
      
      const chatModels = models.filter(m => m.category === 'chat').slice(0, 20);
      
      // Ensure we have the known good models
      knownChatModels.forEach(modelId => {
        if (!chatModels.find(m => (m.id || m) === modelId)) {
          chatModels.push(modelId);
        }
      });
      
      const allModels = {
        chat: chatModels,
        embedding: specializedModels.embedding || [],
        vision: specializedModels.vision || [],
        whisper: specializedModels.whisper || [],
        summarization: specializedModels.summarization || [],
        translation: specializedModels.translation || []
      };
      
      await this.saveModelCache('huggingface', allModels, {});
      return { models: allModels, apiFormat: {} };
      
    } catch (error) {
      logger.error('Failed to fetch HuggingFace models:', error);
      return this.modelCache.get('huggingface') || { models: {}, apiFormat: {} };
    }
  }

  async fetchSpecializedHFModels() {
    const specialized = {
      embedding: [
        'sentence-transformers/all-MiniLM-L6-v2',
        'sentence-transformers/all-mpnet-base-v2',
        'BAAI/bge-large-en-v1.5',
        'BAAI/bge-base-en-v1.5',
        'intfloat/e5-large-v2',
        'intfloat/multilingual-e5-large'
      ],
      vision: [
        'Salesforce/blip-image-captioning-large',
        'microsoft/git-base',
        'nlpconnect/vit-gpt2-image-captioning',
        'microsoft/Florence-2-large',
        'google/pix2struct-large'
      ],
      whisper: [
        'openai/whisper-large-v3',
        'openai/whisper-medium',
        'openai/whisper-small',
        'openai/whisper-base',
        'facebook/wav2vec2-large-960h'
      ],
      summarization: [
        'facebook/bart-large-cnn',
        'google/pegasus-xsum',
        'philschmid/bart-large-cnn-samsum',
        'google/pegasus-multi_news'
      ],
      translation: [
        'Helsinki-NLP/opus-mt-en-es',
        'Helsinki-NLP/opus-mt-en-fr',
        'Helsinki-NLP/opus-mt-en-de',
        'facebook/mbart-large-50-many-to-many-mmt'
      ]
    };
    
    return specialized;
  }

  async scrapeGabModels() {
    try {
      // Try API endpoint — Gab's /api/models returns HTML, use /api/chat/models if available
      const apiKey = process.env.GAB_API_KEY;
      const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
      const response = await fetch('https://gab.ai/api/chat/models', { headers });

      if (response.ok) {
        const text = await response.text();
        // Only parse if it's actually JSON (Gab sometimes returns HTML)
        if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
          const data = JSON.parse(text);
          const models = data.data || data.models || (Array.isArray(data) ? data : []);

          const formattedModels = models.map(model => ({
            id: model.id || model,
            name: model.name || model.id || model,
            description: model.description || 'Gab AI model',
            category: 'chat',
            available: model.available !== false
          }));

          if (formattedModels.length > 0) {
            await this.saveModelCache('gab', formattedModels, {});
            return { models: formattedModels, apiFormat: {} };
          }
        }
      }
    } catch (error) {
      logger.debug('Failed to fetch Gab models from API:', error.message);
    }

    // Fallback to known models
    const knownModels = [
      { id: 'arya', name: 'Arya', description: 'Gab AI default model', category: 'chat' },
      { id: 'gpt-4o', name: 'GPT-4o via Gab', description: 'OpenAI GPT-4o via Gab', category: 'chat' }
    ];
    
    await this.saveModelCache('gab', knownModels, {});
    return { models: knownModels, apiFormat: {} };
  }

  parseContextWindow(text) {
    if (!text) return null;
    
    const match = text.match(/(\d+)k?/i);
    if (match) {
      const num = parseInt(match[1]);
      return text.toLowerCase().includes('k') ? num * 1000 : num;
    }
    
    return null;
  }

  formatModelName(modelId) {
    // Convert model ID to readable name
    const parts = modelId.split('-');
    
    // Special cases
    if (modelId.includes('gpt-5.2')) return modelId.replace('gpt-5.2', 'GPT-5.2').replace(/-/g, ' ').replace(/\s+/, ' ');
    if (modelId.includes('gpt-5.1')) return modelId.replace('gpt-5.1', 'GPT-5.1').replace(/-/g, ' ').replace(/\s+/, ' ');
    if (modelId.includes('gpt-5')) return modelId.replace('gpt-5', 'GPT-5').replace(/-/g, ' ').replace(/\s+/, ' ');
    if (modelId.includes('gpt-4.1')) return modelId.replace('gpt-4.1', 'GPT-4.1').replace(/-/g, ' ').replace(/\s+/, ' ');
    if (modelId.includes('gpt-4o')) return modelId.replace('gpt-4o', 'GPT-4o').replace(/-/g, ' ').replace(/\s+/, ' ');
    if (modelId.includes('o1')) return modelId.replace('o1', 'O1').replace(/-/g, ' ').replace(/\s+/, ' ');
    if (modelId.includes('claude')) return modelId.replace('claude', 'Claude').replace(/-/g, ' ').replace(/\s+/, ' ');
    
    // General formatting
    return modelId
      .replace(/gpt/i, 'GPT')
      .replace(/dall-e/i, 'DALL-E')
      .replace(/tts/i, 'TTS')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase())
      .replace(/\s+/, ' ')
      .trim();
  }

  getAnthropicContextWindow(modelId) {
    // Return known context windows for Anthropic models
    if (modelId.includes('4-5')) return 200000; // Claude 4.5 models
    if (modelId.includes('3-5')) return 200000; // Claude 3.5 models
    if (modelId.includes('opus') || modelId.includes('sonnet') || modelId.includes('haiku')) return 200000;
    if (modelId.includes('2.1')) return 200000;
    if (modelId.includes('2.0') || modelId.includes('instant')) return 100000;
    return 200000; // Default for newer models
  }

  categorizeModel(modelName) {
    const lowerName = modelName.toLowerCase();
    
    if (lowerName.includes('embed')) return 'embedding';
    if (lowerName.includes('whisper')) return 'whisper';
    if (lowerName.includes('dall-e') || lowerName.includes('vision')) return 'vision';
    if (lowerName.includes('tts')) return 'tts';
    
    return 'chat';
  }

  categorizeHFModel(model) {
    const tags = model.tags || [];
    const name = (model.modelId || model.id || '').toLowerCase();
    
    if (tags.includes('sentence-transformers') || name.includes('embed')) return 'embedding';
    if (tags.includes('automatic-speech-recognition') || name.includes('whisper')) return 'whisper';
    if (tags.includes('image-to-text') || tags.includes('visual-question-answering')) return 'vision';
    if (tags.includes('summarization')) return 'summarization';
    if (tags.includes('translation')) return 'translation';
    
    return 'chat';
  }

  extractDescription($element) {
    return $element.find('.description, p, .model-description').first().text().trim() || '';
  }

  extractContextWindow($element) {
    const text = $element.text();
    const contextMatch = text.match(/(\d+)k?\s*(?:tokens|context)/i);
    
    if (contextMatch) {
      const num = parseInt(contextMatch[1]);
      return contextMatch[0].toLowerCase().includes('k') ? num * 1000 : num;
    }
    
    return null;
  }

  extractAPIFormat(html, provider) {
    // Extract API format changes from documentation
    // For now, return empty - can be enhanced later
    return {};
  }

  async saveModelCache(provider, models, apiFormat) {
    try {
      const { ModelCache } = await import('../models/ModelCache.js');
      
      await ModelCache.findOneAndUpdate(
        { provider },
        {
          provider,
          models,
          apiFormat,
          lastChecked: new Date()
        },
        { upsert: true, new: true }
      );
      
      // Update in-memory cache
      this.modelCache.set(provider, {
        models,
        apiFormat,
        lastUpdated: new Date()
      });
      
      logger.info(`Saved ${provider} model cache with ${Array.isArray(models) ? models.length : Object.keys(models).length} models`);
    } catch (error) {
      logger.error(`Failed to save ${provider} model cache:`, error);
    }
  }

  async getProviderModels(provider) {
    // Check cache first
    const cached = this.modelCache.get(provider);
    
    if (cached && this.isCacheValid(cached.lastUpdated)) {
      return cached;
    }
    
    // Update if cache is stale
    try {
      const updated = await this.updateProviderModels(provider);
      return updated || cached || { models: [], apiFormat: {} };
    } catch (error) {
      logger.error(`Failed to get ${provider} models:`, error);
      return cached || { models: [], apiFormat: {} };
    }
  }

  isCacheValid(lastUpdated) {
    if (!lastUpdated) return false;
    
    const age = Date.now() - new Date(lastUpdated).getTime();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    return age < maxAge;
  }

  async updateProviderConfiguration(provider) {
    const providerData = await this.getProviderModels(provider);
    
    if (!providerData || !providerData.models) {
      logger.warn(`No models found for ${provider}`);
      return false;
    }
    
    // Update the provider's available models
    const providerInstance = this.agent.providerManager.providers.get(provider);
    
    if (providerInstance && providerInstance.updateAvailableModels) {
      providerInstance.updateAvailableModels(providerData.models);
      logger.info(`Updated ${provider} with latest models`);
      return true;
    }
    
    return false;
  }
}

export default ModelUpdaterService;