import { BasePlugin } from '../core/basePlugin.js';
import { Journal } from '../../models/Journal.js';

export default class JournalPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'journal';
    this.version = '1.0.0';
    this.description = 'Personal journal and captain\'s log for recording thoughts, events, and reflections';
    this.category = 'personal';

    this.commands = [
      {
        command: 'start',
        description: 'Start a new journal session (enter journal mode)',
        usage: 'start()',
        examples: [
          'enter journal mode',
          'start journal',
          'begin journal entry',
          'I want to journal',
          'open my journal',
          'captain\'s log',
          'start recording my thoughts',
          'let me journal'
        ]
      },
      {
        command: 'stop',
        description: 'Stop the current journal session and save',
        usage: 'stop()',
        examples: [
          'stop journal',
          'end journal mode',
          'close journal',
          'done journaling',
          'finish journal entry',
          'save and close journal'
        ]
      },
      {
        command: 'add',
        description: 'Add an entry to the current journal session',
        usage: 'add({ content: "text", source: "text|voice" })'
      },
      {
        command: 'list',
        description: 'List recent journal entries',
        usage: 'list({ limit: 10 })',
        examples: [
          'show my journals',
          'list journal entries',
          'show me my recent journals',
          'journal history'
        ]
      },
      {
        command: 'view',
        description: 'View a specific journal session',
        usage: 'view({ journalId: "id" })',
        examples: [
          'show me my journal from today',
          'read my last journal',
          'view journal entry',
          'open my latest journal'
        ]
      },
      {
        command: 'search',
        description: 'Search journal entries by keyword or date',
        usage: 'search({ query: "text", startDate: "date", endDate: "date" })',
        examples: [
          'search my journal for work',
          'find journal entries about project',
          'show me my journal from last week',
          'journal entries from January',
          'what did I write about meetings'
        ]
      },
      {
        command: 'summarize',
        description: 'Get an AI summary of journal entries over a period',
        usage: 'summarize({ period: "week|month", journalId: "id" })',
        examples: [
          'summarize my journals from this week',
          'give me a journal summary',
          'what have I been journaling about'
        ]
      }
    ];

    this.intents = {
      startJournal: {
        name: 'Start Journal Session',
        description: 'Enter journal mode to start recording thoughts and reflections',
        action: 'start',
        examples: [
          'enter journal mode', 'start journaling', 'open my journal',
          'I want to write in my journal', 'captain\'s log',
          'begin journal entry', 'let me record my thoughts',
          'start my diary', 'time to journal'
        ]
      },
      stopJournal: {
        name: 'Stop Journal Session',
        description: 'End the current journal recording session',
        action: 'stop',
        examples: [
          'stop journaling', 'end journal mode', 'close my journal',
          'done journaling', 'finish journal', 'save journal',
          'exit journal mode'
        ]
      },
      viewJournal: {
        name: 'View Journal Entries',
        description: 'View or retrieve past journal entries',
        action: 'list',
        examples: [
          'show my journal', 'read my journal entries',
          'what did I journal about', 'show me my journal from last week',
          'journal entries from yesterday', 'show journal history',
          'read my diary'
        ]
      },
      searchJournal: {
        name: 'Search Journal',
        description: 'Search through journal entries for specific content',
        action: 'search',
        examples: [
          'search my journal for meetings', 'find journal entries about work',
          'what did I write about the project', 'search journal for ideas'
        ]
      }
    };
  }

  async execute(params = {}) {
    const { action, ...data } = params;

    switch (action) {
      case 'start':
        return await this.startSession(data);
      case 'stop':
        return await this.stopSession(data);
      case 'add':
        return await this.addEntry(data);
      case 'list':
        return await this.listJournals(data);
      case 'view':
        return await this.viewJournal(data);
      case 'search':
        return await this.searchJournals(data);
      case 'summarize':
        return await this.summarizeJournals(data);
      default:
        return { success: false, error: 'Unknown action. Use: start, stop, add, list, view, search, summarize' };
    }
  }

  async startSession(data) {
    const userId = data.userId || data.query || 'default';

    const existing = await Journal.findActiveSession(userId);
    if (existing) {
      return {
        success: false,
        result: 'You already have an active journal session. Say "done journaling" to close it first.'
      };
    }

    const journal = new Journal({
      userId,
      title: `Journal - ${new Date().toLocaleDateString()}`,
      status: 'active'
    });
    await journal.save();

    this.logger.info(`Journal session started for user ${userId}: ${journal._id}`);

    return {
      success: true,
      result: 'Journal mode started. Everything you say will be recorded. Say "done journaling" or /cancel to stop.',
      enterMode: true,
      journalId: journal._id.toString()
    };
  }

  async addEntry(data) {
    const content = data.content;
    if (!content) {
      return { success: false, error: 'Content required' };
    }

    const userId = data.userId || 'default';
    const journal = await Journal.findActiveSession(userId);
    if (!journal) {
      return {
        success: false,
        result: 'No active journal session. Say "start journal" to begin.'
      };
    }

    await journal.addEntry(content, data.source || 'text');

    // Extract memories in background
    this.extractMemoriesFromEntry(content, userId).catch(err => {
      this.logger.error('Background memory extraction failed:', err.message);
    });

    return {
      success: true,
      entryNumber: journal.entries.length,
      wordCount: journal.metadata.totalWordCount
    };
  }

  async stopSession(data) {
    const userId = data.userId || 'default';
    const journal = await Journal.findActiveSession(userId);
    if (!journal) {
      return {
        success: false,
        result: 'No active journal session to close.'
      };
    }

    const fullText = journal.getFullText();
    let summary = '';
    let title = journal.title;
    let tags = [];
    let mood = '';

    // Generate AI summary if there's enough content
    if (fullText.length > 20 && this.agent.providerManager) {
      try {
        const aiResult = await this.processWithAI(
          `Analyze this journal entry and provide:\n` +
          `1. A concise title (max 60 chars)\n` +
          `2. A 2-3 sentence summary\n` +
          `3. Up to 5 topic tags (single words)\n` +
          `4. Overall mood/tone (one word)\n\n` +
          `Format your response as JSON: {"title":"...","summary":"...","tags":["..."],"mood":"..."}\n\n` +
          `Journal content:\n${fullText.substring(0, 3000)}`
        );
        const parsed = this.parseAIResponse(aiResult);
        if (parsed) {
          summary = parsed.summary || '';
          title = parsed.title || title;
          tags = parsed.tags || [];
          mood = parsed.mood || '';
        }
      } catch (err) {
        this.logger.warn('AI summary generation failed:', err.message);
        summary = `${journal.entries.length} entries recorded.`;
      }
    } else {
      summary = `${journal.entries.length} entries recorded.`;
    }

    // Extract memories from full session
    await this.extractSessionMemories(fullText, userId, journal._id).catch(err => {
      this.logger.error('Session memory extraction failed:', err.message);
    });

    // Update journal metadata and close
    journal.title = title;
    journal.tags = tags;
    journal.mood = mood;
    await journal.close(summary);

    const durationMinutes = Math.round((journal.metadata.sessionDuration || 0) / 60000);

    const resultText = `Journal session saved.\n\n` +
      `Title: ${title}\n` +
      `Entries: ${journal.entries.length}\n` +
      `Words: ${journal.metadata.totalWordCount}\n` +
      `Duration: ${durationMinutes} min` +
      (summary ? `\n\nSummary: ${summary}` : '') +
      (tags.length > 0 ? `\nTags: ${tags.join(', ')}` : '') +
      (mood ? `\nMood: ${mood}` : '');

    return {
      success: true,
      result: resultText,
      exitMode: true,
      journalId: journal._id.toString()
    };
  }

  async listJournals(data) {
    const userId = data.userId || data.query || 'default';
    const limit = data.limit || 10;

    const journals = await Journal.findRecent(userId, limit);

    if (journals.length === 0) {
      return { success: true, result: 'No journal entries found.' };
    }

    let text = `Your recent journals (${journals.length}):\n\n`;
    for (const j of journals) {
      const date = j.createdAt.toLocaleDateString();
      const status = j.status === 'active' ? ' [ACTIVE]' : '';
      const entryCount = j.metadata?.entryCount || j.entries.length;
      const words = j.metadata?.totalWordCount || 0;
      text += `- ${date}: ${j.title || 'Untitled'}${status} (${entryCount} entries, ${words} words)`;
      if (j.mood) text += ` [${j.mood}]`;
      text += '\n';
    }

    return { success: true, result: text.trim() };
  }

  async viewJournal(data) {
    const userId = data.userId || 'default';
    let journal;

    if (data.journalId) {
      journal = await Journal.findById(data.journalId);
    } else {
      // Show latest journal
      const journals = await Journal.findRecent(userId, 1);
      journal = journals[0];
    }

    if (!journal) {
      return { success: true, result: 'No journal found.' };
    }

    let text = `${journal.title || 'Untitled Journal'}\n`;
    text += `Date: ${journal.createdAt.toLocaleDateString()}\n`;
    text += `Status: ${journal.status}\n`;
    if (journal.mood) text += `Mood: ${journal.mood}\n`;
    if (journal.tags?.length) text += `Tags: ${journal.tags.join(', ')}\n`;
    text += '\n---\n\n';

    for (const entry of journal.entries) {
      const time = entry.timestamp.toLocaleTimeString();
      const source = entry.source === 'voice' ? ' [voice]' : '';
      text += `[${time}]${source} ${entry.content}\n\n`;
    }

    if (journal.summary) {
      text += `---\nSummary: ${journal.summary}`;
    }

    return { success: true, result: text.trim() };
  }

  async searchJournals(data) {
    const userId = data.userId || 'default';
    const query = data.query || data.input || '';
    const startDate = data.startDate;
    const endDate = data.endDate;

    let journals;

    if (startDate || endDate) {
      const start = startDate || '2020-01-01';
      const end = endDate || new Date().toISOString();
      journals = await Journal.findByDateRange(userId, start, end);
    } else if (query) {
      try {
        journals = await Journal.searchContent(userId, query);
      } catch {
        // Text index may not exist yet, fall back to regex
        journals = await Journal.find({
          userId,
          $or: [
            { 'entries.content': { $regex: query, $options: 'i' } },
            { title: { $regex: query, $options: 'i' } },
            { summary: { $regex: query, $options: 'i' } }
          ]
        }).sort({ createdAt: -1 }).limit(20);
      }
    } else {
      return { success: true, result: 'Please provide a search query or date range.' };
    }

    if (!journals || journals.length === 0) {
      return { success: true, result: `No journal entries found matching "${query || 'date range'}".` };
    }

    let text = `Found ${journals.length} journal(s):\n\n`;
    for (const j of journals) {
      const date = j.createdAt.toLocaleDateString();
      text += `- ${date}: ${j.title || 'Untitled'} (${j.metadata?.entryCount || j.entries.length} entries)\n`;
      if (j.summary) text += `  Summary: ${j.summary.substring(0, 100)}...\n`;
    }

    return { success: true, result: text.trim() };
  }

  async summarizeJournals(data) {
    const userId = data.userId || 'default';
    const period = data.period || 'week';
    const journalId = data.journalId;

    let journals;

    if (journalId) {
      const journal = await Journal.findById(journalId);
      journals = journal ? [journal] : [];
    } else {
      const now = new Date();
      let startDate;
      if (period === 'month') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      } else {
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
      journals = await Journal.findByDateRange(userId, startDate, now);
    }

    if (!journals || journals.length === 0) {
      return { success: true, result: `No journals found for the past ${period}.` };
    }

    const allText = journals.map(j => {
      const date = j.createdAt.toLocaleDateString();
      return `[${date}] ${j.getFullText()}`;
    }).join('\n\n---\n\n');

    if (!this.agent.providerManager) {
      return { success: true, result: `Found ${journals.length} journals but AI provider not available for summarization.` };
    }

    try {
      const aiResult = await this.processWithAI(
        `Summarize these journal entries from the past ${period}. ` +
        `Identify key themes, recurring topics, mood trends, and notable events. ` +
        `Keep the summary concise but insightful.\n\n` +
        `Journals:\n${allText.substring(0, 4000)}`
      );

      const content = typeof aiResult === 'string' ? aiResult : aiResult?.content || aiResult?.text || '';
      return {
        success: true,
        result: `Journal Summary (past ${period}, ${journals.length} sessions):\n\n${content}`
      };
    } catch (err) {
      this.logger.error('Journal summarization failed:', err.message);
      return { success: false, error: `Summarization failed: ${err.message}` };
    }
  }

  async extractMemoriesFromEntry(content, userId) {
    if (!this.agent.memoryManager) return;
    await this.agent.memoryManager.analyzeAndLearn(content, {
      userId,
      source: 'journal'
    });
  }

  async extractSessionMemories(fullText, userId, journalId) {
    if (!this.agent.memoryManager || !this.agent.providerManager) return;
    if (fullText.length < 30) return;

    try {
      const aiResult = await this.processWithAI(
        `Extract useful facts, preferences, goals, and personal information from this journal entry ` +
        `that would be helpful for a personal assistant to remember about its user.\n\n` +
        `Return a JSON array of objects: [{"type":"preference|goal|fact|routine","content":"..."}]\n` +
        `Only include genuinely useful information. Return [] if nothing noteworthy.\n\n` +
        `Journal:\n${fullText.substring(0, 3000)}`
      );

      const memories = this.parseAIResponse(aiResult);
      if (Array.isArray(memories) && memories.length > 0) {
        const storedIds = [];
        for (const mem of memories) {
          if (!mem.content) continue;
          try {
            const stored = await this.agent.memoryManager.store('knowledge', mem.content, {
              userId,
              category: `journal_${mem.type || 'fact'}`,
              importance: 7,
              isPermanent: true,
              source: 'journal_extraction',
              tags: ['journal', mem.type || 'fact'],
              journalId: journalId.toString()
            });
            if (stored?._id) storedIds.push(stored._id);
          } catch (err) {
            this.logger.warn('Failed to store journal memory:', err.message);
          }
        }
        if (storedIds.length > 0) {
          await Journal.findByIdAndUpdate(journalId, {
            $push: { extractedMemories: { $each: storedIds } }
          });
          this.logger.info(`Extracted ${storedIds.length} memories from journal ${journalId}`);
        }
      }
    } catch (err) {
      this.logger.error('Session memory extraction failed:', err.message);
    }
  }

  parseAIResponse(response) {
    try {
      const content = typeof response === 'string' ? response : response?.content || response?.text || '';
      const jsonMatch = content.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return null;
    } catch {
      return null;
    }
  }

  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}
