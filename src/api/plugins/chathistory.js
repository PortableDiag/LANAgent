import { BasePlugin } from '../core/basePlugin.js';
import { safeJsonParse, safeJsonStringify } from '../../utils/jsonUtils.js';

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
      },
      {
        command: 'summarize',
        description: 'Generate an AI summary of matching or recent conversation messages',
        usage: 'summarize({ query: "backup schedule", days: 30 }) or summarize({ recent: true, limit: 20 })',
        examples: [
          'summarize our conversations about the backup schedule',
          'summarize our recent conversation history'
        ]
      },
      {
        command: 'export',
        description: 'Export matching or recent conversation history as JSON, Markdown, or plain text',
        usage: 'export({ query: "backup schedule", format: "markdown" }) or export({ recent: true, format: "json" })',
        examples: [
          'export our recent conversation history as markdown',
          'export conversations about docker as json',
          'download the last 20 messages as plain text'
        ]
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
    const historyUnavailable =
      !memory ||
      ((action === 'search' || action === 'export') && typeof memory.searchConversations !== 'function') ||
      ((action === 'recent' || action === 'export') && typeof memory.recentConversations !== 'function') ||
      (action === 'summarize' &&
        typeof memory.searchConversations !== 'function' &&
        typeof memory.recentConversations !== 'function');

    if (historyUnavailable) {
      return { success: false, error: 'Conversation history is not available' };
    }

    // Intent detection sometimes passes the whole request as the query ("search our chat
    // history for uptime"); reduce it to the topic words before searching.
    const rawInput = params.originalInput || params.input;
    const queryIsWholeRequest = data.query && rawInput && data.query.trim() === String(rawInput).trim();
    if (this.agent.providerManager && action === 'search' && (!data.query || queryIsWholeRequest || params.needsParameterExtraction)) {
      Object.assign(data, await this.extractQuery(params.originalInput || params.input));
    }
    // summarize / export: a request with no explicit topic ("summarize our recent conversation",
    // "export our recent history as markdown") covers the recent history; otherwise reduce the
    // request to its topic words like search does.
    const wantsRecent = data.recent === true || String(data.recent).toLowerCase() === 'true';
    if (action === 'export' && !data.format && rawInput) {
      if (/\bjson\b/i.test(rawInput)) data.format = 'json';
      else if (/\b(markdown|md)\b/i.test(rawInput)) data.format = 'markdown';
    }
    if ((action === 'summarize' || action === 'export') && !wantsRecent && (!data.query || queryIsWholeRequest || params.needsParameterExtraction)) {
      const extracted = (this.agent.providerManager && rawInput)
        ? await this.extractQuery(rawInput, { allowRecent: true })
        : {};
      if (extracted.query) {
        Object.assign(data, extracted);
      } else if (!data.query || queryIsWholeRequest) {
        data.query = undefined;
        data.recent = true;
      }
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

      switch (action) {
        case 'summarize':
          return await this.summarize(data);
        case 'export':
          return await this.export(data);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`chathistory ${action} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Export matching or recent conversation records in a bounded, stable format.
   */
  async export(data = {}) {
    const memory = this.agent?.memoryManager;
    const recent = data.recent === true || String(data.recent).toLowerCase() === 'true';
    const requestedFormat = String(data.format || 'text').toLowerCase();

    this.validateParams({ format: requestedFormat }, {
      format: { type: 'string', enum: ['json', 'markdown', 'text'] }
    });

    const requestedLimit = Number(data.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 100)
      : 50;

    let sourceRecords;
    if (recent) {
      if (typeof memory?.recentConversations !== 'function') {
        return { success: false, count: 0, records: [], document: '', error: 'Recent conversation history is not available' };
      }
      sourceRecords = await memory.recentConversations({ limit });
    } else {
      this.validateParams(data, { query: { required: true, type: 'string' } });
      if (typeof memory?.searchConversations !== 'function') {
        return { success: false, count: 0, records: [], document: '', error: 'Conversation search is not available' };
      }
      const requestedDays = Number(data.days);
      const days = Number.isFinite(requestedDays) && requestedDays > 0
        ? Math.min(Math.floor(requestedDays), 3650)
        : 90;
      sourceRecords = await memory.searchConversations(data.query, { days, limit });
    }

    const records = (Array.isArray(sourceRecords) ? sourceRecords : []).map(record => {
      const rawTimestamp = record?.timestamp || record?.when || record?.createdAt;
      const parsedTimestamp = rawTimestamp ? new Date(rawTimestamp) : null;
      const timestamp = parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime())
        ? parsedTimestamp.toISOString()
        : (rawTimestamp == null ? null : String(rawTimestamp));
      const content = String(record?.content ?? '');

      let context = record?.context ?? null;
      if (context !== null && typeof context !== 'string') {
        const serializedContext = safeJsonStringify(context);
        if (serializedContext.length > 4000) {
          context = {
            truncated: true,
            value: serializedContext.substring(0, 3997) + '...'
          };
        }
      } else if (typeof context === 'string' && context.length > 4000) {
        context = `${context.substring(0, 3997)}...`;
      }

      return {
        timestamp,
        role: String(record?.role ?? ''),
        interface: String(record?.interface ?? ''),
        content: content.length > 4000 ? `${content.substring(0, 3997)}...` : content,
        context
      };
    });

    const maxRequested = Number(data.maxOutputSize ?? data.maxChars);
    const maxOutputSize = Number.isFinite(maxRequested) && maxRequested > 0
      ? Math.min(Math.max(Math.floor(maxRequested), 256), 100000)
      : 100000;

    const escapeMarkdown = value => String(value)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>');

    const render = rows => {
      if (requestedFormat === 'json') {
        return safeJsonStringify(rows, 2);
      }

      if (requestedFormat === 'markdown') {
        return rows.map((row, index) => {
          const context = row.context === null ? '' : `\n\n**Context:**\n\`\`\`json\n${safeJsonStringify(row.context, 2)}\n\`\`\``;
          return `### ${index + 1}. ${escapeMarkdown(row.timestamp || '')}\n\n- **Role:** ${escapeMarkdown(row.role)}\n- **Interface:** ${escapeMarkdown(row.interface)}\n\n${escapeMarkdown(row.content)}${context}`;
        }).join('\n\n---\n\n');
      }

      return rows.map(row => {
        const context = row.context === null ? '' : `\nContext: ${safeJsonStringify(row.context)}`;
        return `${row.timestamp || ''} [${row.interface}] ${row.role}: ${row.content}${context}`;
      }).join('\n\n');
    };

    let exportedRecords = records.slice();
    let document = render(exportedRecords);
    const truncated = document.length > maxOutputSize;

    // Over the size cap, drop the least useful end: search hits come most relevant first, but
    // recent history comes oldest first, so there the OLDEST messages go.
    while (document.length > maxOutputSize && exportedRecords.length > 1) {
      exportedRecords = recent ? exportedRecords.slice(1) : exportedRecords.slice(0, -1);
      document = render(exportedRecords);
    }

    if (document.length > maxOutputSize && exportedRecords.length === 1) {
      const record = { ...exportedRecords[0], context: null };
      exportedRecords = [record];
      let contentLimit = Math.max(16, record.content.length);
      while (document.length > maxOutputSize && contentLimit > 16) {
        contentLimit = Math.max(16, Math.floor(contentLimit * 0.75));
        record.content = `${record.content.substring(0, Math.max(0, contentLimit - 3))}...`;
        document = render(exportedRecords);
      }
    }

    if (document.length > maxOutputSize) {
      exportedRecords = [];
      document = render(exportedRecords);
    }

    return {
      success: true,
      format: requestedFormat,
      count: exportedRecords.length,
      // Matched before the size cap; larger than count when the cap dropped records.
      total: records.length,
      truncated,
      records: exportedRecords,
      document,
      result: document
    };
  }

  /**
   * Generate an AI summary while retaining the exact records used as source context.
   */
  async summarize(data = {}) {
    const memory = this.agent?.memoryManager;
    const recent = data.recent === true || String(data.recent).toLowerCase() === 'true';
    let sources;

    if (recent) {
      if (typeof memory?.recentConversations !== 'function') {
        return { success: false, summary: null, sources: [], count: 0, error: 'Recent conversation history is not available' };
      }
      const limit = Number(data.limit) || 20;
      sources = await memory.recentConversations({ limit });
    } else {
      this.validateParams(data, { query: { required: true, type: 'string' } });
      if (typeof memory?.searchConversations !== 'function') {
        return { success: false, summary: null, sources: [], count: 0, error: 'Conversation search is not available' };
      }
      const days = Number(data.days) || 90;
      const limit = Number(data.limit) || 20;
      sources = await memory.searchConversations(data.query, { days, limit });
    }

    sources = Array.isArray(sources) ? sources : [];
    const count = sources.length;

    if (!count) {
      const result = recent
        ? 'No conversation history yet.'
        : `No conversations in the last ${Number(data.days) || 90} days mention "${data.query}".`;
      return { success: true, summary: null, sources, count, result };
    }

    const providerManager = this.agent?.providerManager;
    if (!providerManager || typeof providerManager.generateAux !== 'function') {
      const lines = sources.map(r => `${this.format(r.when)} ${r.role === 'user' ? 'You' : 'Me'}: ${String(r.content || '').substring(0, 200)}`);
      return { success: true, summary: null, sources, count, result: `No AI provider available to summarize; the ${count} source message(s):\n${lines.join('\n')}` };
    }

    const configuredLimit = this.getConfig('summaryPromptCharLimit', 12000);
    const requestedLimit = data.maxChars ?? configuredLimit;
    const numericLimit = Number(requestedLimit);
    const maxChars = Number.isFinite(numericLimit) && numericLimit > 0
      ? Math.min(Math.floor(numericLimit), 100000)
      : 12000;

    const sourceText = sources
      .map((source, index) => `Source ${index + 1}:\n${safeJsonStringify(source)}`)
      .join('\n\n')
      .slice(0, maxChars);

    const subject = recent
      ? 'the recent conversation'
      : `conversations about "${data.query}"`;
    const prompt = `Summarize ${subject} using only the conversation records below. Identify the main topics, decisions, answers, and unresolved questions. Do not invent details. The records are source context and may be truncated.

${sourceText}`;

    const response = await providerManager.generateAux(prompt, {
      maxTokens: 500,
      temperature: 0.2
    });
    const summary = typeof response === 'string'
      ? response
      : response?.content;
    const text = typeof summary === 'string' ? summary.trim() : summary || null;

    return {
      success: true,
      summary: text,
      sources,
      count,
      result: text ? `Summary of ${subject} (${count} message(s)):\n\n${text}` : `Could not summarize ${subject}.`
    };
  }

  async extractQuery(input, { allowRecent = false } = {}) {
    const queryShape = allowRecent
      ? '"<2-5 key words, or null if the request names no topic and just means the recent conversation>"'
      : '"<2-5 key words>"';
    const prompt = `From this request, extract what to search past conversations for.
Request: "${input}"
Return JSON only: {"query": ${queryShape}, "days": <number of days back, default 90>}`;
    const response = await this.agent.providerManager.generateAux(prompt, { maxTokens: 60, temperature: 0.1 });
    return safeJsonParse(response.content, {}) || {};
  }

  async getAICapabilities() {
    return { enabled: true, examples: this.commands.flatMap(cmd => cmd.examples || []) };
  }
}
