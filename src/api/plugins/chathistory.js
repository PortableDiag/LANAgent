import { BasePlugin } from '../core/basePlugin.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

/**
 * Search and review past conversations from the verbatim transcript
 * (memoryManager.searchConversations / recentConversations, Transcript model).
 * Answers "what did we talk about regarding X", "what did you tell me about Y last week".
 */
export default class ChatHistoryPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'chathistory';
    this.version = '1.0.0';
    this.description = 'Search and review past conversations with the agent';

    this.commands = [
      {
        command: 'search',
        description: 'Search past conversations for a topic, word or phrase',
        usage: 'search({ query: "backup schedule", days: 30 })',
        examples: [
          'what did we talk about regarding the backup schedule',
          'search our chat history for docker',
          'what did you tell me about the VPN last week',
          'find the conversation where I asked about disk space'
        ]
      },
      {
        command: 'recent',
        description: 'Show the most recent conversation messages',
        usage: 'recent({ limit: 20 })',
        examples: ['show our recent conversation history', 'what were we just talking about']
      }
    ];
  }

  async initialize() {
    this.initialized = true;
  }

  // Local server time as "YYYY-MM-DD HH:mm" (sv-SE renders ISO-style order)
  format(when) {
    return new Date(when).toLocaleString('sv-SE').substring(0, 16);
  }

  async execute(params) {
    const { action, ...data } = params;
    this.validateParams(params, {
      action: { required: true, type: 'string', enum: this.commands.map(c => c.command) }
    });

    const memory = this.agent?.memoryManager;
    if (!memory?.searchConversations) {
      return { success: false, error: 'Conversation history is not available' };
    }

    // Intent detection sometimes passes the whole request as the query ("search our chat
    // history for uptime"); reduce it to the topic words before searching.
    const rawInput = params.originalInput || params.input;
    const queryIsWholeRequest = data.query && rawInput && data.query.trim() === String(rawInput).trim();
    if (this.agent.providerManager && action === 'search' && (!data.query || queryIsWholeRequest || params.needsParameterExtraction)) {
      Object.assign(data, await this.extractQuery(params.originalInput || params.input));
    }

    try {
      if (action === 'search') {
        this.validateParams(data, { query: { required: true, type: 'string' } });
        const days = Number(data.days) || 90;
        const hits = await memory.searchConversations(data.query, { days, limit: data.limit || 8 });
        if (!hits.length) {
          return { success: true, count: 0, result: `No conversations in the last ${days} days mention "${data.query}".` };
        }
        const lines = hits.map(h => {
          const who = h.role === 'user' ? 'You' : 'Me';
          const ctx = h.context ? `\n   ↳ ${h.context.role === 'user' ? 'You' : 'Me'}: ${h.context.content.substring(0, 200)}` : '';
          return `• ${this.format(h.when)} (${h.interface}) ${who}: ${h.content.substring(0, 300)}${ctx}`;
        });
        return { success: true, count: hits.length, hits, result: `Found ${hits.length} message(s) about "${data.query}":\n\n${lines.join('\n\n')}` };
      }

      if (action === 'recent') {
        const rows = await memory.recentConversations({ limit: data.limit || 20 });
        if (!rows.length) return { success: true, count: 0, result: 'No conversation history yet.' };
        const lines = rows.map(r => `${this.format(r.when)} ${r.role === 'user' ? 'You' : 'Me'}: ${r.content.substring(0, 200)}`);
        return { success: true, count: rows.length, result: lines.join('\n') };
      }

      throw new Error(`Unknown action: ${action}`);
    } catch (error) {
      this.logger.error(`chathistory ${action} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  async extractQuery(input) {
    const prompt = `From this request, extract what to search past conversations for.
Request: "${input}"
Return JSON only: {"query": "<2-5 key words>", "days": <number of days back, default 90>}`;
    const response = await this.agent.providerManager.generateAux(prompt, { maxTokens: 60, temperature: 0.1 });
    return safeJsonParse(response.content, {}) || {};
  }

  async getAICapabilities() {
    return { enabled: true, examples: this.commands.flatMap(cmd => cmd.examples || []) };
  }
}
