import NodeCache from 'node-cache';
import { logger } from './logger.js';
import { embeddingService } from '../services/embeddingService.js';
import { vectorStore } from '../services/vectorStore.js';
import { retryOperation } from './retryUtils.js';

export class IntentIndexer {
  constructor() {
    this.indexedIntents = new Set();
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
  }

  /**
   * Extract all intents from AIIntentDetector
   */
  async extractBaseIntents(aiIntentDetector) {
    const cachedIntents = this.cache.get('baseIntents');
    if (cachedIntents) {
      logger.info(`Loaded ${cachedIntents.length} base intents from cache`);
      return cachedIntents;
    }

    const intents = [];
    const baseIntents = aiIntentDetector.intents;

    for (const [id, intent] of Object.entries(baseIntents)) {
      intents.push({
        id: `base_${id}`,
        name: intent.name,
        description: intent.description,
        plugin: intent.plugin,
        action: intent.action,
        examples: intent.examples || [],
        type: 'base',
        category: this.categorizeIntent(intent)
      });
    }

    logger.info(`Extracted ${intents.length} base intents`);
    this.cache.set('baseIntents', intents);
    return intents;
  }

  /**
   * Extract plugin-specific intents
   */
  async extractPluginIntents(apiManager) {
    const cachedIntents = this.cache.get('pluginIntents');
    if (cachedIntents) {
      logger.info(`Loaded ${cachedIntents.length} plugin intents from cache`);
      return cachedIntents;
    }

    const intents = [];
    const plugins = apiManager.apis; // Use the Map directly

    for (const [pluginName, pluginWrapper] of plugins) {
      if (!pluginWrapper.enabled) continue;

      const plugin = pluginWrapper.instance;

      // Check if plugin has intent definitions
      if (plugin.intents) {
        for (const [intentId, intent] of Object.entries(plugin.intents)) {
          intents.push({
            id: `plugin_${pluginName}_${intentId}`,
            name: intent.name || `${pluginName}_${intentId}`,
            description: intent.description,
            plugin: pluginName,
            action: intent.action || intentId,
            examples: intent.examples || [],
            type: 'plugin',
            category: plugin.category || 'plugins'
          });
        }
      }

      // Also extract from commands if available
      if (plugin.commands && Array.isArray(plugin.commands)) {
        for (const command of plugin.commands) {
          intents.push({
            id: `plugin_${pluginName}_cmd_${command.command}`,
            name: `${pluginName} ${command.command}`,
            description: command.description,
            plugin: pluginName,
            action: command.command,
            examples: command.examples || (command.usage ? [command.usage] : []),
            type: 'plugin_command',
            category: plugin.category || 'plugins'
          });
        }
      }
    }

    logger.info(`Extracted ${intents.length} plugin intents`);
    this.cache.set('pluginIntents', intents);
    return intents;
  }

  /**
   * Categorize intent based on its properties
   */
  categorizeIntent(intent) {
    // Map plugins to categories
    const categoryMap = {
      system: ['system', 'process', 'monitor'],
      development: ['development', 'coding', 'git', 'test'],
      network: ['network', 'vpn', 'ssh', 'security'],
      communication: ['email', 'telegram', 'notification'],
      data: ['database', 'file', 'backup'],
      media: ['media', 'image', 'video', 'audio'],
      automation: ['task', 'schedule', 'workflow'],
      web: ['web', 'scraping', 'api', 'browser'],
      ai: ['ai', 'llm', 'analysis', 'generation']
    };

    const plugin = intent.plugin?.toLowerCase() || '';
    const name = intent.name?.toLowerCase() || '';
    const description = intent.description?.toLowerCase() || '';

    for (const [category, keywords] of Object.entries(categoryMap)) {
      if (keywords.some(keyword =>
        plugin.includes(keyword) ||
        name.includes(keyword) ||
        description.includes(keyword)
      )) {
        return category;
      }
    }

    return 'general';
  }

  /**
   * Generate embedding for an intent
   */
  async generateIntentEmbedding(intent) {
    try {
      // Create rich text representation
      const parts = [];

      if (intent.name) parts.push(`Intent: ${intent.name}`);
      if (intent.description) parts.push(`Description: ${intent.description}`);
      if (intent.plugin) parts.push(`Plugin: ${intent.plugin}`);
      if (intent.action) parts.push(`Action: ${intent.action}`);
      if (intent.category) parts.push(`Category: ${intent.category}`);

      // Add action-type semantic enrichment to separate similar intents
      // (e.g., get_authors vs add_author within the same plugin)
      const actionType = this.getActionType(intent.action);
      if (actionType) parts.push(`Operation: ${actionType}`);

      // Add examples with more weight
      if (intent.examples && intent.examples.length > 0) {
        const exampleText = intent.examples.join(', ');
        parts.push(`Examples: ${exampleText}`);
        // Add examples again for emphasis
        parts.push(`User might say: ${exampleText}`);
      }

      const text = parts.join(' | ');
      const embedding = await retryOperation(() => embeddingService.generateEmbedding(text));

      return {
        id: intent.id,
        embedding,
        metadata: {
          name: intent.name,
          description: intent.description,
          plugin: intent.plugin,
          action: intent.action,
          category: intent.category,
          type: intent.type,
          examples: intent.examples,
          enabled: true
        }
      };
    } catch (error) {
      logger.error(`Failed to generate embedding for intent ${intent.id}:`, error);
      throw error;
    }
  }

  /**
   * Derive semantic action type from action name to improve embedding discrimination
   */
  getActionType(action) {
    if (!action) return null;
    const a = action.toLowerCase();
    if (/^(get_|list_|show_|view_)/.test(a) || a === 'get_queue' || a === 'get_health' || a === 'get_status'
        || a === 'get_history' || a === 'get_calendar' || a === 'get_stats' || a === 'get_wanted'
        || a === 'get_indexers') {
      return 'retrieve view list show display existing data read-only query';
    }
    if (/^(add_|create_|import_|new_)/.test(a)) {
      return 'add create import new insert write mutate';
    }
    if (/^(delete_|remove_|drop_)/.test(a)) {
      return 'delete remove drop destroy erase mutate';
    }
    if (/^(search_|find_|lookup_|look_up_)/.test(a)) {
      return 'search find lookup discover query external';
    }
    if (/^(update_|edit_|modify_|set_)/.test(a)) {
      return 'update edit modify change alter mutate';
    }
    if (/^(refresh|sync|rescan)/.test(a)) {
      return 'refresh sync rescan reload update trigger';
    }
    return null;
  }

  /**
   * Extract intents from SubAgents (e.g., ServerMaintenanceAgent).
   * SubAgents with a getIntents() method dynamically generate intents
   * based on their configured servers, apps, and capabilities.
   */
  async extractSubAgentIntents(agent) {
    const intents = [];
    try {
      const orchestrator = agent.subAgentOrchestrator;
      if (!orchestrator) return intents;

      for (const [, handler] of orchestrator.agentHandlers || new Map()) {
        if (typeof handler.getIntents === 'function') {
          const agentIntents = handler.getIntents();
          for (const intent of agentIntents) {
            intents.push({
              id: `subagent_${intent.id}`,
              name: intent.name,
              description: intent.description,
              plugin: intent.plugin || '_subagent',
              action: intent.action,
              examples: intent.examples || [],
              type: 'subagent',
              category: intent.category || 'system',
              params: intent.params || {}
            });
          }
        }
      }
      logger.info(`Extracted ${intents.length} sub-agent intents`);
    } catch (error) {
      logger.debug('Sub-agent intent extraction failed:', error.message);
    }
    return intents;
  }

  /**
   * Index all intents into vector store
   */
  async indexAllIntents(agent) {
    try {
      logger.info('Starting intent indexing...');

      // Clear existing intents
      await vectorStore.clear();
      this.indexedIntents.clear();

      // Extract all intents
      const [baseIntents, pluginIntents, subAgentIntents] = await Promise.all([
        this.extractBaseIntents(agent.aiIntentDetector),
        this.extractPluginIntents(agent.apiManager),
        this.extractSubAgentIntents(agent)
      ]);
      const allIntents = [...baseIntents, ...pluginIntents, ...subAgentIntents];

      logger.info(`Total intents to index: ${allIntents.length}`);

      // Generate embeddings in batches
      const batchSize = 20;
      const embeddings = [];

      for (let i = 0; i < allIntents.length; i += batchSize) {
        const batch = allIntents.slice(i, i + batchSize);
        const batchEmbeddings = await Promise.all(
          batch.map(intent => this.generateIntentEmbedding(intent))
        );
        embeddings.push(...batchEmbeddings);

        logger.info(`Generated embeddings for ${Math.min(i + batchSize, allIntents.length)}/${allIntents.length} intents`);
      }

      // Store in vector database
      await vectorStore.addIntents(embeddings);

      // Track indexed intents
      embeddings.forEach(e => this.indexedIntents.add(e.id));

      logger.info(`Successfully indexed ${embeddings.length} intents`);

      // Get stats
      const stats = await vectorStore.getStats();
      logger.info('Vector store stats:', stats);

      return {
        success: true,
        totalIndexed: embeddings.length,
        baseIntents: baseIntents.length,
        pluginIntents: pluginIntents.length,
        stats
      };

    } catch (error) {
      logger.error('Failed to index intents:', error);
      throw error;
    }
  }

  /**
   * Update intent index for a specific plugin
   */
  async updatePluginIntents(agent, pluginName) {
    try {
      logger.info(`Updating intents for plugin: ${pluginName}`);

      // Remove old plugin intents
      const oldIntentIds = Array.from(this.indexedIntents)
        .filter(id => id.startsWith(`plugin_${pluginName}_`));

      if (oldIntentIds.length > 0) {
        await vectorStore.deleteIntents(oldIntentIds);
        oldIntentIds.forEach(id => this.indexedIntents.delete(id));
      }

      // Extract and index new plugin intents
      const pluginWrapper = agent.apiManager.apis.get(pluginName);
      if (!pluginWrapper || !pluginWrapper.enabled) {
        logger.info(`Plugin ${pluginName} not found or disabled`);
        return { success: true, updated: 0 };
      }

      const plugin = pluginWrapper.instance;

      const intents = [];

      // Extract from intent definitions
      if (plugin.intents) {
        for (const [intentId, intent] of Object.entries(plugin.intents)) {
          intents.push({
            id: `plugin_${pluginName}_${intentId}`,
            name: intent.name || `${pluginName}_${intentId}`,
            description: intent.description,
            plugin: pluginName,
            action: intent.action || intentId,
            examples: intent.examples || [],
            type: 'plugin',
            category: plugin.category || 'plugins'
          });
        }
      }

      // Also extract from commands if available
      if (plugin.commands && Array.isArray(plugin.commands)) {
        for (const command of plugin.commands) {
          intents.push({
            id: `plugin_${pluginName}_cmd_${command.command}`,
            name: `${pluginName} ${command.command}`,
            description: command.description,
            plugin: pluginName,
            action: command.command,
            examples: command.examples || (command.usage ? [command.usage] : []),
            type: 'plugin_command',
            category: plugin.category || 'plugins'
          });
        }
      }

      // Generate embeddings and store
      const embeddings = await Promise.all(
        intents.map(intent => this.generateIntentEmbedding(intent))
      );

      if (embeddings.length > 0) {
        await vectorStore.addIntents(embeddings);
        embeddings.forEach(e => this.indexedIntents.add(e.id));
      }

      logger.info(`Updated ${embeddings.length} intents for plugin ${pluginName}`);

      return {
        success: true,
        updated: embeddings.length
      };

    } catch (error) {
      logger.error(`Failed to update plugin intents for ${pluginName}:`, error);
      throw error;
    }
  }

  /**
   * Remove all intents for a specific plugin
   */
  async removePluginIntents(pluginName) {
    try {
      logger.info(`Removing all intents for plugin: ${pluginName}`);

      // Find all intent IDs for this plugin
      const intentIds = Array.from(this.indexedIntents)
        .filter(id => id.startsWith(`plugin_${pluginName}_`));

      if (intentIds.length === 0) {
        logger.info(`No intents found for plugin ${pluginName}`);
        return { success: true, removed: 0 };
      }

      // Delete from vector store
      await vectorStore.deleteIntents(intentIds);

      // Remove from indexed set
      intentIds.forEach(id => this.indexedIntents.delete(id));

      logger.info(`Removed ${intentIds.length} intents for plugin ${pluginName}`);

      return {
        success: true,
        removed: intentIds.length
      };

    } catch (error) {
      logger.error(`Failed to remove intents for plugin ${pluginName}:`, error);
      throw error;
    }
  }

  /**
   * Get index statistics
   */
  getIndexStats() {
    return {
      totalIndexed: this.indexedIntents.size,
      intents: Array.from(this.indexedIntents)
    };
  }
}

// Export singleton instance
export const intentIndexer = new IntentIndexer();