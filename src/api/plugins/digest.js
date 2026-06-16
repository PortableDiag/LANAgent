import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

const DEFAULT_SETTINGS = {
  deliveryMethod: 'telegram',
  researchDepth: 'quick',
  summaryFormat: 'bullets',
  maxRelatedResults: 5,
  includeSourceLink: true,
  autoDeliver: true
};

export default class DigestPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'digest';
    this.version = '1.0.0';
    this.description = 'Extract, summarize, and research content from URLs (articles, YouTube, PDFs)';

    this.commands = [
      {
        command: 'digest',
        description: 'Create a full digest of a URL with summary and related research',
        usage: 'digest({ url: "https://..." })',
        examples: [
          'digest this article',
          'summarize this link',
          'give me a digest of this URL',
          'what is this article about',
          'break down this video for me'
        ]
      },
      {
        command: 'extract',
        description: 'Extract content from a URL without summarizing',
        usage: 'extract({ url: "https://..." })',
        examples: [
          'extract content from this URL',
          'get the text from this page'
        ]
      },
      {
        command: 'summarize',
        description: 'Summarize provided text with AI',
        usage: 'summarize({ text: "..." })',
        examples: [
          'summarize this text',
          'create an executive summary of this'
        ]
      },
      {
        command: 'research',
        description: 'Find related content on a topic',
        usage: 'research({ topic: "..." })',
        examples: [
          'find related articles about this topic',
          'research this subject for me'
        ]
      }
    ];

    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  async initialize() {
    this.logger.info('Digest plugin initialized');
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: ['digest', 'extract', 'summarize', 'research', 'settings', 'saveSettings', 'history', 'getSources', 'addSource', 'removeSource', 'scheduleDigest', 'getSchedules', 'removeSchedule', 'runScheduledDigest']
      }
    });

    switch (action) {
      case 'digest':           return await this.fullDigest(data);
      case 'extract':          return await this.extractContent(data);
      case 'summarize':        return await this.summarizeText(data);
      case 'research':         return await this.researchTopic(data);
      case 'settings':         return await this.getSettings();
      case 'saveSettings':     return await this.saveSettingsData(data);
      case 'history':          return await this.getDigestHistory(data);
      case 'getSources':       return await this.getPreferredSources();
      case 'addSource':        return await this.addPreferredSource(data);
      case 'removeSource':     return await this.removePreferredSource(data);
      case 'scheduleDigest':   return await this.scheduleDigest(data);
      case 'getSchedules':     return await this.getSchedules();
      case 'removeSchedule':   return await this.removeSchedule(data);
      case 'runScheduledDigest': return await this.runScheduledDigest(data);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // ─── Full Digest Pipeline ────────────────────────────────────────

  async fullDigest(data) {
    const { url, depth, deliveryMethod, format } = data;
    if (!url) throw new Error('URL is required');

    this.logger.info(`Starting full digest for: ${url}`);
    const settings = await this.getSettings();
    const results = { url, steps: {} };

    // Step 1: Extract
    let extraction;
    try {
      extraction = await this.extractContent({ url });
      results.steps.extract = 'success';
      results.title = extraction.title;
      results.sourceType = extraction.sourceType;
      results.metadata = extraction.metadata;
    } catch (error) {
      this.logger.error('Extraction failed:', error);
      return { success: false, error: `Content extraction failed: ${error.message}`, url };
    }

    // Step 2: Summarize
    let summary;
    try {
      summary = await this.summarizeText({
        text: extraction.text,
        format: format || settings.summaryFormat,
        title: extraction.title,
        sourceType: extraction.sourceType
      });
      results.steps.summarize = 'success';
      results.summary = summary.summary;
      results.summaryFormat = summary.format;
    } catch (error) {
      this.logger.error('Summarization failed:', error);
      results.steps.summarize = 'failed';
      results.summary = null;
      results.summaryError = error.message;
    }

    // Step 3: Research
    let research;
    try {
      const topic = extraction.title || extraction.text.substring(0, 200);
      research = await this.researchTopic({
        topic,
        depth: depth || settings.researchDepth
      });
      results.steps.research = 'success';
      results.related = research;
    } catch (error) {
      this.logger.error('Research failed:', error);
      results.steps.research = 'failed';
      results.related = null;
      results.researchError = error.message;
    }

    // Step 4: Save to history
    try {
      await this.saveToHistory(results);
    } catch (error) {
      this.logger.warn('Failed to save digest history:', error.message);
    }

    // Step 5: Deliver
    const deliverMethod = deliveryMethod || settings.deliveryMethod;
    if (settings.autoDeliver) {
      try {
        await this.deliverDigest(results, deliverMethod);
        results.steps.deliver = 'success';
        results.deliveredVia = deliverMethod;
      } catch (error) {
        this.logger.error('Delivery failed:', error);
        results.steps.deliver = 'failed';
        results.deliveryError = error.message;
      }
    }

    results.success = true;
    return results;
  }

  // ─── Content Extraction ──────────────────────────────────────────

  async extractContent(data) {
    const { url } = data;
    if (!url) throw new Error('URL is required');

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    const sourceType = this.detectUrlType(parsedUrl);
    this.logger.info(`Detected source type: ${sourceType} for ${url}`);

    switch (sourceType) {
      case 'youtube':
        return await this.extractYouTube(url);
      case 'pdf':
        return await this.extractPdf(url);
      default:
        return await this.extractArticle(url, parsedUrl);
    }
  }

  detectUrlType(parsedUrl) {
    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname.toLowerCase();

    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      return 'youtube';
    }
    if (pathname.endsWith('.pdf')) {
      return 'pdf';
    }
    return 'article';
  }

  async extractArticle(url, parsedUrl) {
    const response = await axios.get(url, {
      headers: { 'User-Agent': this.userAgent },
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024
    });

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('application/pdf')) {
      return await this.extractPdf(url);
    }

    const $ = cheerio.load(response.data);

    // Remove non-content elements
    $('script, style, nav, header, footer, aside, iframe, noscript, .ad, .ads, .advertisement, .sidebar, .menu, .nav').remove();

    // Extract title
    const title = $('meta[property="og:title"]').attr('content')
      || $('title').text().trim()
      || $('h1').first().text().trim()
      || parsedUrl.hostname;

    // Extract description
    const description = $('meta[property="og:description"]').attr('content')
      || $('meta[name="description"]').attr('content')
      || '';

    // Extract author
    const author = $('meta[name="author"]').attr('content')
      || $('meta[property="article:author"]').attr('content')
      || '';

    // Extract main content
    const contentSelectors = [
      'article', 'main', '[role="main"]',
      '.post-content', '.article-body', '.article-content',
      '.entry-content', '.story-body', '#article-body',
      '.content-body', '.post-body', '#content'
    ];

    let text = '';
    for (const selector of contentSelectors) {
      const el = $(selector);
      if (el.length && el.text().trim().length > 200) {
        text = el.text().trim();
        break;
      }
    }

    if (!text || text.length < 200) {
      text = $('body').text().trim();
    }

    // Clean whitespace
    text = text.replace(/\s+/g, ' ').trim();

    // Truncate for AI
    const truncated = text.length > 10000;
    if (truncated) text = text.substring(0, 10000);

    return {
      success: true,
      sourceType: 'article',
      title,
      text,
      truncated,
      metadata: {
        description,
        author,
        url,
        hostname: parsedUrl.hostname,
        charCount: text.length
      }
    };
  }

  async extractYouTube(url) {
    // Get video info via yt-dlp
    let videoInfo;
    try {
      const { stdout } = await execAsync(
        `yt-dlp --js-runtimes node -j "${url}"`,
        { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }
      );
      videoInfo = JSON.parse(stdout);
    } catch (error) {
      this.logger.error('yt-dlp info extraction failed:', error.message);
      throw new Error(`Failed to get YouTube video info: ${error.message}`);
    }

    const title = videoInfo.title || 'Untitled Video';
    const description = videoInfo.description || '';
    const channel = videoInfo.channel || videoInfo.uploader || '';
    const duration = videoInfo.duration || 0;
    const videoId = videoInfo.id || '';

    // Try to get subtitles
    let transcript = '';
    let transcriptAvailable = false;
    const tmpDir = os.tmpdir();
    const tmpBase = path.join(tmpDir, `digest-${videoId}`);

    try {
      await execAsync(
        `yt-dlp --js-runtimes node --write-auto-subs --write-subs --sub-langs "en.*,en" --skip-download -o "${tmpBase}" "${url}"`,
        { timeout: 60000 }
      );

      // Look for subtitle files
      const subtitleFiles = [];
      const tmpFiles = fs.readdirSync(tmpDir);
      for (const f of tmpFiles) {
        if (f.startsWith(`digest-${videoId}`) && (f.endsWith('.vtt') || f.endsWith('.srt'))) {
          subtitleFiles.push(path.join(tmpDir, f));
        }
      }

      if (subtitleFiles.length > 0) {
        const subContent = fs.readFileSync(subtitleFiles[0], 'utf-8');
        transcript = this.parseSubtitles(subContent);
        transcriptAvailable = true;

        // Clean up subtitle files
        for (const f of subtitleFiles) {
          try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
      }
    } catch (error) {
      this.logger.warn('Subtitle extraction failed, using description:', error.message);
    }

    const text = transcriptAvailable
      ? transcript
      : `${title}\n\n${description}`;

    const truncated = text.length > 10000;

    return {
      success: true,
      sourceType: 'youtube',
      title,
      text: truncated ? text.substring(0, 10000) : text,
      truncated,
      transcriptAvailable,
      metadata: {
        channel,
        duration,
        videoId,
        url,
        description: description.substring(0, 500)
      }
    };
  }

  parseSubtitles(content) {
    // Strip VTT/SRT formatting: timestamps, sequence numbers, tags
    return content
      .replace(/^WEBVTT[\s\S]*?\n\n/, '') // VTT header
      .replace(/^\d+\s*\n/gm, '') // SRT sequence numbers
      .replace(/\d{2}:\d{2}[:\.,]\d{2,3}\s*-->\s*\d{2}:\d{2}[:\.,]\d{2,3}.*\n/g, '') // Timestamps
      .replace(/<[^>]+>/g, '') // HTML tags
      .replace(/\{[^}]+\}/g, '') // SSA tags
      .replace(/\n{3,}/g, '\n\n') // Collapse blank lines
      .trim();
  }

  async extractPdf(url) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024
    });

    const sizeMB = response.data.byteLength / (1024 * 1024);
    if (sizeMB > 50) {
      throw new Error(`PDF too large (${sizeMB.toFixed(1)}MB). Maximum supported size is 50MB.`);
    }

    // Dynamic import pdf-parse (it uses CommonJS require internally)
    const pdfParse = (await import('pdf-parse')).default;
    const pdfData = await pdfParse(Buffer.from(response.data));

    let text = pdfData.text || '';
    text = text.replace(/\s+/g, ' ').trim();
    const truncated = text.length > 10000;
    if (truncated) text = text.substring(0, 10000);

    return {
      success: true,
      sourceType: 'pdf',
      title: pdfData.info?.Title || new URL(url).pathname.split('/').pop() || 'PDF Document',
      text,
      truncated,
      metadata: {
        pages: pdfData.numpages,
        author: pdfData.info?.Author || '',
        url,
        charCount: text.length,
        sizeMB: sizeMB.toFixed(1)
      }
    };
  }

  // ─── AI Summarization ────────────────────────────────────────────

  async summarizeText(data) {
    const { text, format, title, sourceType } = data;
    if (!text) throw new Error('Text is required for summarization');

    const settings = await this.getSettings();
    const summaryFormat = format || settings.summaryFormat || 'bullets';

    let formatInstruction;
    switch (summaryFormat) {
      case 'bullets':
        formatInstruction = 'Provide an executive summary as 5-8 concise bullet points. Use "- " for each bullet. Focus on the most important takeaways.';
        break;
      case 'paragraph':
        formatInstruction = 'Provide a concise executive summary in 2-3 short paragraphs. No fluff.';
        break;
      case 'detailed':
        formatInstruction = 'Provide a detailed analysis with these sections:\n**Key Points:**\n**Main Arguments:**\n**Notable Details:**\n**Conclusion:**';
        break;
      default:
        formatInstruction = 'Provide an executive summary as 5-8 concise bullet points.';
    }

    const prompt = `Summarize the following content. Be concise and focus on what matters most. ${formatInstruction}

${title ? `Title: "${title}"` : ''}
${sourceType ? `Source: ${sourceType}` : ''}

Content:
${text.substring(0, 10000)}`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      maxTokens: 1000,
      temperature: 0.3
    });

    return {
      success: true,
      summary: response.content,
      format: summaryFormat,
      wordCount: response.content.split(/\s+/).length
    };
  }

  // ─── Related Research ────────────────────────────────────────────

  async researchTopic(data) {
    const { topic, depth, deliveryMethod } = data;
    if (!topic) throw new Error('Topic is required for research');

    const settings = await this.getSettings();
    const researchDepth = depth || settings.researchDepth || 'quick';
    const maxResults = settings.maxRelatedResults || 5;

    let research;
    if (researchDepth === 'quick') {
      research = await this.quickResearch(topic, maxResults);
    } else {
      research = await this.deepResearch(topic, maxResults);
    }

    // If delivery method is specified, deliver the research as a digest
    if (deliveryMethod) {
      const digest = {
        title: `News Digest: ${topic.substring(0, 100)}`,
        sourceType: 'research',
        summary: `Latest coverage on: ${topic}`,
        related: research,
        url: null
      };
      await this.deliverDigest(digest, deliveryMethod);
      await this.saveToHistory(digest);
      research.delivered = true;
      research.deliveryMethod = deliveryMethod;
    }

    return research;
  }

  async quickResearch(topic, maxResults) {
    const { directive: sourceDirective } = await this.getSourceDirective();
    const prompt = `Search the web and find ${maxResults} related and recent news articles about: "${topic.substring(0, 200)}"

For EACH article found, you MUST provide ALL of the following:
1. **Title**: The exact article headline
2. **Source**: Publication name (e.g., Reuters, Ars Technica, etc.)
3. **URL**: The full article URL (REQUIRED - include the complete https:// link)
4. **Summary**: 2-3 sentence summary of key points

Format each article clearly with all 4 elements. Be specific and use real, current information from the web.${sourceDirective}`;

    // Use the currently selected provider with web search enabled
    const currentProvider = this.agent.providerManager.getCurrentProvider()?.name;
    this.logger.info(`Using ${currentProvider} for web search research`);

    const response = await this.agent.providerManager.generateResponse(prompt, {
      maxTokens: 1500,
      temperature: 0.5,
      enableWebSearch: true,
      maxSearches: 5
    });

    return {
      success: true,
      topic: topic.substring(0, 200),
      depth: 'quick',
      relatedContent: response.content,
      provider: currentProvider
    };
  }

  async deepResearch(topic, maxResults) {
    const { directive: sourceDirective } = await this.getSourceDirective();

    // Generate search queries from different angles
    const queryPrompt = `Given the topic "${topic.substring(0, 200)}", generate exactly 3 different search queries that would find related news content from different angles (e.g., latest developments, analysis, different perspectives). Return only the queries, one per line, no numbering.`;

    const queryResponse = await this.agent.providerManager.generateResponse(queryPrompt, {
      maxTokens: 200,
      temperature: 0.7
    });

    const queries = queryResponse.content.split('\n').filter(q => q.trim()).slice(0, 3);
    const searches = [];

    // Use the currently selected provider with web search enabled
    const currentProvider = this.agent.providerManager.getCurrentProvider()?.name;
    this.logger.info(`Using ${currentProvider} for web search deep research`);

    for (const query of queries) {
      try {
        const searchPrompt = `Search the web and find the top 2 most relevant and recent articles about: "${query.trim()}"

For EACH article, provide ALL of:
1. **Title**: The exact headline
2. **Source**: Publication name
3. **URL**: Full article URL (REQUIRED)
4. **Summary**: 2-3 sentence summary

Use real, current information from the web.${sourceDirective}`;

        const searchResponse = await this.agent.providerManager.generateResponse(searchPrompt, {
          maxTokens: 600,
          temperature: 0.5,
          enableWebSearch: true,
          maxSearches: 3
        });

        searches.push({
          query: query.trim(),
          results: searchResponse.content
        });
      } catch (error) {
        this.logger.warn(`Deep research query failed: "${query}"`, error.message);
        searches.push({ query: query.trim(), results: 'Search failed', error: error.message });
      }
    }

    return {
      success: true,
      topic: topic.substring(0, 200),
      depth: 'deep',
      searches,
      provider: currentProvider
    };
  }

  // ─── Delivery ────────────────────────────────────────────────────

  async deliverDigest(digest, method) {
    const methods = method === 'both' ? ['telegram', 'email'] : [method || 'telegram'];

    for (const m of methods) {
      try {
        if (m === 'telegram') {
          await this.deliverViaTelegram(digest);
        } else if (m === 'email') {
          await this.deliverViaEmail(digest);
        }
      } catch (error) {
        this.logger.error(`Delivery via ${m} failed:`, error);
      }
    }
  }

  async deliverViaTelegram(digest) {
    const settings = await this.getSettings();
    const telegram = this.getInterface('telegram');

    // Build the executive briefing message
    let msg = `📋 *EXECUTIVE BRIEFING*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*${this.escapeMarkdown(digest.title || 'News Digest')}*\n`;
    msg += `_${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}_\n\n`;

    if (digest.summary) {
      msg += `*📝 KEY POINTS:*\n${digest.summary}\n\n`;
    }

    if (settings.includeSourceLink && digest.url) {
      msg += `🔗 *Source:* ${digest.url}\n\n`;
    }

    if (digest.related) {
      msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `*🔍 RELATED COVERAGE:*\n\n`;
      if (digest.related.relatedContent) {
        // Don't truncate - send full content
        msg += digest.related.relatedContent;
      } else if (digest.related.searches) {
        for (const s of digest.related.searches) {
          msg += `\n*${this.escapeMarkdown(s.query)}:*\n${s.results}\n`;
        }
      }
    }

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `_Delivered by LANAgent Digest_`;

    // Send using telegram's smart splitting for long messages
    // Disable link previews to keep message clean
    if (telegram && typeof telegram.sendLargeNotification === 'function') {
      await telegram.sendLargeNotification(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } else if (telegram && typeof telegram.sendLargeMessage === 'function') {
      // Use the large message method if available via direct bot access
      const telegramBot = telegram.bot;
      const userId = telegram.authorizedUserId;
      if (telegramBot && userId) {
        await this.sendLongTelegramMessage(telegramBot, userId, msg);
      } else {
        await this.notify(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }
    } else {
      // Fallback: split manually if too long
      await this.sendSplitTelegramMessages(msg);
    }
  }

  async sendLongTelegramMessage(bot, userId, message) {
    const MAX_LENGTH = 4000;
    if (message.length <= MAX_LENGTH) {
      await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      return;
    }

    // Split at newlines to preserve formatting
    let remaining = message;
    while (remaining.length > 0) {
      let chunk;
      if (remaining.length <= MAX_LENGTH) {
        chunk = remaining;
        remaining = '';
      } else {
        let splitIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
        if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', MAX_LENGTH);
        if (splitIndex <= 0) splitIndex = MAX_LENGTH;
        chunk = remaining.substring(0, splitIndex);
        remaining = remaining.substring(splitIndex).trim();
      }
      await bot.telegram.sendMessage(userId, chunk, { parse_mode: 'Markdown', disable_web_page_preview: true });
      if (remaining.length > 0) await new Promise(r => setTimeout(r, 300)); // Rate limit
    }
  }

  async sendSplitTelegramMessages(message) {
    const MAX_LENGTH = 4000;
    if (message.length <= MAX_LENGTH) {
      await this.notify(message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      return;
    }

    // Split at newlines
    let remaining = message;
    let part = 1;
    while (remaining.length > 0) {
      let chunk;
      if (remaining.length <= MAX_LENGTH) {
        chunk = remaining;
        remaining = '';
      } else {
        let splitIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
        if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', MAX_LENGTH);
        if (splitIndex <= 0) splitIndex = MAX_LENGTH;
        chunk = remaining.substring(0, splitIndex);
        remaining = remaining.substring(splitIndex).trim();
      }
      if (part > 1) chunk = `_(continued...)_\n\n${chunk}`;
      await this.notify(chunk, { parse_mode: 'Markdown', disable_web_page_preview: true });
      if (remaining.length > 0) await new Promise(r => setTimeout(r, 500));
      part++;
    }
  }

  escapeMarkdown(text) {
    return (text || '').replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }

  async deliverViaEmail(digest) {
    const emailPlugin = this.agent.apiManager?.getPlugin('email');
    if (!emailPlugin) {
      throw new Error('Email plugin not available');
    }

    const masterEmail = process.env.EMAIL_OF_MASTER;
    if (!masterEmail) {
      throw new Error('No master email configured');
    }

    const settings = await this.getSettings();
    let body = `DIGEST: ${digest.title || 'Content Summary'}\n`;
    body += `Type: ${digest.sourceType || 'article'}\n\n`;

    if (digest.summary) {
      body += `SUMMARY:\n${digest.summary}\n\n`;
    }

    if (settings.includeSourceLink && digest.url) {
      body += `Source: ${digest.url}\n\n`;
    }

    if (digest.related) {
      body += `RELATED CONTENT:\n`;
      if (digest.related.relatedContent) {
        body += digest.related.relatedContent;
      } else if (digest.related.searches) {
        for (const s of digest.related.searches) {
          body += `\n[${s.query}]\n${s.results}\n`;
        }
      }
    }

    await emailPlugin.execute({
      action: 'send',
      to: masterEmail,
      subject: `Digest: ${(digest.title || 'Content Summary').substring(0, 60)}`,
      text: body
    });
  }

  // ─── History ─────────────────────────────────────────────────────

  async saveToHistory(digest) {
    try {
      const existing = await PluginSettings.getCached(this.name, 'history') || [];
      const entry = {
        id: Date.now().toString(36),
        url: digest.url,
        title: digest.title || 'Untitled',
        sourceType: digest.sourceType || 'article',
        summary: (digest.summary || '').substring(0, 300),
        timestamp: new Date().toISOString(),
        steps: digest.steps
      };
      existing.unshift(entry);
      // Keep last 50 entries
      if (existing.length > 50) existing.length = 50;
      await PluginSettings.setCached(this.name, 'history', existing);
    } catch (error) {
      this.logger.warn('Failed to save history:', error.message);
    }
  }

  async getDigestHistory(data = {}) {
    const limit = data.limit || 20;
    const history = await PluginSettings.getCached(this.name, 'history') || [];
    return {
      success: true,
      count: history.length,
      history: history.slice(0, limit)
    };
  }

  // ─── Preferred Sources ──────────────────────────────────────────

  async getPreferredSources() {
    const sources = await PluginSettings.getCached(this.name, 'preferredSources') || [];
    return { success: true, sources };
  }

  async addPreferredSource(data) {
    const { name, url } = data;
    if (!name || !name.trim()) throw new Error('Source name is required');

    const sources = await PluginSettings.getCached(this.name, 'preferredSources') || [];

    if (sources.length >= 20) {
      throw new Error('Maximum of 20 preferred sources allowed');
    }

    const trimmedName = name.trim();
    if (sources.some(s => s.name.toLowerCase() === trimmedName.toLowerCase())) {
      throw new Error(`Source "${trimmedName}" already exists`);
    }

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      name: trimmedName,
      url: (url || '').trim() || null
    };

    sources.push(entry);
    await PluginSettings.setCached(this.name, 'preferredSources', sources);
    this.logger.info(`Added preferred source: ${entry.name}`);

    return { success: true, message: `Source "${entry.name}" added`, source: entry, sources };
  }

  async removePreferredSource(data) {
    const { id } = data;
    if (!id) throw new Error('Source ID is required');

    const sources = await PluginSettings.getCached(this.name, 'preferredSources') || [];
    const before = sources.length;
    const filtered = sources.filter(s => s.id !== id);

    if (filtered.length === before) {
      throw new Error('Source not found');
    }

    await PluginSettings.setCached(this.name, 'preferredSources', filtered);
    this.logger.info(`Removed preferred source: ${id}`);

    return { success: true, message: 'Source removed', sources: filtered };
  }

  // ─── Schedule Management ───────────────────────────────────────

  async scheduleDigest(data) {
    const { topic, cron, name } = data;
    if (!topic) throw new Error('Topic is required for scheduled digest');
    if (!cron) throw new Error('Cron expression is required (e.g., "0 8 * * *" for daily at 8am)');

    const schedules = await PluginSettings.getCached(this.name, 'schedules') || [];

    if (schedules.length >= 10) {
      throw new Error('Maximum of 10 scheduled digests allowed');
    }

    const schedule = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      name: (name || topic).substring(0, 50),
      topic: topic.substring(0, 200),
      cron,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null
    };

    schedules.push(schedule);
    await PluginSettings.setCached(this.name, 'schedules', schedules);
    this.logger.info(`Scheduled digest created: ${schedule.name} (${cron})`);

    // Register with scheduler service if available
    await this.registerScheduleWithAgenda(schedule);

    return { success: true, message: `Digest scheduled: "${schedule.name}"`, schedule, schedules };
  }

  async getSchedules() {
    const schedules = await PluginSettings.getCached(this.name, 'schedules') || [];
    return { success: true, schedules };
  }

  async removeSchedule(data) {
    const { id } = data;
    if (!id) throw new Error('Schedule ID is required');

    const schedules = await PluginSettings.getCached(this.name, 'schedules') || [];
    const schedule = schedules.find(s => s.id === id);
    const filtered = schedules.filter(s => s.id !== id);

    if (filtered.length === schedules.length) {
      throw new Error('Schedule not found');
    }

    await PluginSettings.setCached(this.name, 'schedules', filtered);
    this.logger.info(`Removed scheduled digest: ${id}`);

    // Unregister from scheduler
    if (schedule) {
      await this.unregisterScheduleFromAgenda(schedule);
    }

    return { success: true, message: 'Schedule removed', schedules: filtered };
  }

  async runScheduledDigest(data) {
    const { id, topic } = data;
    let targetTopic = topic;

    if (id) {
      const schedules = await PluginSettings.getCached(this.name, 'schedules') || [];
      const schedule = schedules.find(s => s.id === id);
      if (!schedule) throw new Error('Schedule not found');
      targetTopic = schedule.topic;

      // Update lastRun
      schedule.lastRun = new Date().toISOString();
      await PluginSettings.setCached(this.name, 'schedules', schedules);
    }

    if (!targetTopic) throw new Error('Topic is required');

    this.logger.info(`Running scheduled digest for: ${targetTopic}`);

    // Do research on the topic and deliver
    const settings = await this.getSettings();
    const research = await this.researchTopic({ topic: targetTopic, depth: settings.researchDepth || 'quick' });

    const digest = {
      title: `Daily Digest: ${targetTopic}`,
      sourceType: 'scheduled-digest',
      summary: `Latest news and updates on: ${targetTopic}`,
      related: research,
      url: null
    };

    // Deliver the digest
    await this.deliverDigest(digest, settings.deliveryMethod || 'telegram');
    await this.saveToHistory(digest);

    return { success: true, message: 'Scheduled digest delivered', topic: targetTopic };
  }

  async registerScheduleWithAgenda(schedule) {
    try {
      const scheduler = this.agent?.scheduler;
      if (!scheduler || !scheduler.agenda) {
        this.logger.warn('Scheduler not available for digest scheduling');
        return;
      }

      const jobName = `digest-${schedule.id}`;
      scheduler.agenda.define(jobName, async () => {
        this.logger.info(`Agenda running scheduled digest: ${schedule.name}`);
        await this.runScheduledDigest({ id: schedule.id });
      });

      await scheduler.agenda.every(schedule.cron, jobName);
      this.logger.info(`Registered digest schedule with Agenda: ${schedule.name}`);
    } catch (error) {
      this.logger.warn(`Could not register schedule with Agenda: ${error.message}`);
    }
  }

  async unregisterScheduleFromAgenda(schedule) {
    try {
      const scheduler = this.agent?.scheduler;
      if (!scheduler || !scheduler.agenda) return;

      const jobName = `digest-${schedule.id}`;
      await scheduler.agenda.cancel({ name: jobName });
      this.logger.info(`Unregistered digest schedule from Agenda: ${schedule.name}`);
    } catch (error) {
      this.logger.warn(`Could not unregister schedule from Agenda: ${error.message}`);
    }
  }

  async getSourceDirective() {
    const sources = await PluginSettings.getCached(this.name, 'preferredSources') || [];
    if (sources.length === 0) return { directive: '' };

    const list = sources.map(s => s.name).join(', ');
    const directive = `\n\n**IMPORTANT: When possible, prioritize and include content from these trusted publications:** ${list}. If articles from these sources are available on the topic, include them prominently.`;

    return { directive };
  }

  // ─── Settings ────────────────────────────────────────────────────

  async getSettings() {
    try {
      const saved = await PluginSettings.getCached(this.name, 'settings');
      if (saved) return { success: true, ...DEFAULT_SETTINGS, ...saved };
    } catch (error) {
      this.logger.debug('Could not load digest settings:', error.message);
    }
    return { success: true, ...DEFAULT_SETTINGS };
  }

  async saveSettingsData(data) {
    const current = await this.getSettings();
    const updated = { ...current };
    delete updated.success;

    if (data.deliveryMethod && ['telegram', 'email', 'both'].includes(data.deliveryMethod)) {
      updated.deliveryMethod = data.deliveryMethod;
    }
    if (data.researchDepth && ['quick', 'deep'].includes(data.researchDepth)) {
      updated.researchDepth = data.researchDepth;
    }
    if (data.summaryFormat && ['bullets', 'paragraph', 'detailed'].includes(data.summaryFormat)) {
      updated.summaryFormat = data.summaryFormat;
    }
    if (data.maxRelatedResults !== undefined) {
      updated.maxRelatedResults = Math.min(10, Math.max(1, parseInt(data.maxRelatedResults) || 5));
    }
    if (data.includeSourceLink !== undefined) {
      updated.includeSourceLink = !!data.includeSourceLink;
    }
    if (data.autoDeliver !== undefined) {
      updated.autoDeliver = !!data.autoDeliver;
    }

    await PluginSettings.setCached(this.name, 'settings', updated);
    this.logger.info('Digest settings saved');

    return { success: true, message: 'Settings saved', settings: updated };
  }

  // ─── API Routes ──────────────────────────────────────────────────

  getRoutes() {
    return [
      {
        method: 'POST',
        path: '/digest',
        handler: async (data) => await this.fullDigest(data)
      },
      {
        method: 'POST',
        path: '/extract',
        handler: async (data) => await this.extractContent(data)
      },
      {
        method: 'POST',
        path: '/summarize',
        handler: async (data) => await this.summarizeText(data)
      },
      {
        method: 'POST',
        path: '/research',
        handler: async (data) => await this.researchTopic(data)
      },
      {
        method: 'GET',
        path: '/settings',
        handler: async () => await this.getSettings()
      },
      {
        method: 'POST',
        path: '/settings',
        handler: async (data) => await this.saveSettingsData(data)
      },
      {
        method: 'GET',
        path: '/history',
        handler: async (data, req) => await this.getDigestHistory({ limit: parseInt(req?.query?.limit) || 20 })
      }
    ];
  }

  // ─── WebUI ───────────────────────────────────────────────────────

  getUIConfig() {
    return {
      menuItem: {
        id: 'digest',
        title: 'Digest',
        icon: 'fas fa-book-reader',
        order: 70,
        section: 'main'
      },
      hasUI: true
    };
  }

  getUIContent() {
    return `
<style>
  .digest-container { max-width: 900px; margin: 0 auto; padding: 20px; font-family: inherit; }
  .digest-card { background: var(--bg-secondary, #1e1e2e); border: 1px solid var(--border, #333); border-radius: 10px; padding: 20px; margin-bottom: 20px; overflow: hidden; }
  .digest-card h3 { margin: 0 0 15px 0; color: var(--text-primary, #e0e0e0); display: flex; align-items: center; gap: 8px; }
  .digest-card h3 i { color: var(--accent, #7c3aed); }
  .digest-input-row { display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .digest-input-row input { flex: 1; min-width: 0; padding: 10px 14px; border: 1px solid var(--border, #333); border-radius: 8px; background: var(--bg-primary, #121220); color: var(--text-primary, #e0e0e0); font-size: 14px; }
  .digest-input-row input::placeholder { color: var(--text-secondary, #888); }
  @media (max-width: 640px) {
    .digest-input-row input { flex-basis: 100%; }
    .digest-input-row .digest-btn { flex: 1; }
  }
  .digest-btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: opacity 0.2s; }
  .digest-btn:hover { opacity: 0.85; }
  .digest-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .digest-btn-primary { background: var(--accent, #7c3aed); color: #fff; }
  .digest-btn-secondary { background: var(--bg-tertiary, #2a2a3e); color: var(--text-primary, #e0e0e0); border: 1px solid var(--border, #333); }
  .digest-btn-sm { padding: 6px 14px; font-size: 13px; }
  .digest-spinner { display: none; text-align: center; padding: 20px; color: var(--text-secondary, #888); }
  .digest-spinner.active { display: block; }
  .digest-spinner i { animation: digest-spin 1s linear infinite; margin-right: 8px; }
  @keyframes digest-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .digest-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 640px) { .digest-settings-grid { grid-template-columns: 1fr; } }
  .digest-field { margin-bottom: 12px; }
  .digest-field label { display: block; font-size: 13px; font-weight: 500; color: var(--text-secondary, #aaa); margin-bottom: 6px; }
  .digest-field select, .digest-field input[type="number"] {
    width: 100%; padding: 8px 12px; border: 1px solid var(--border, #333); border-radius: 6px;
    background: var(--bg-primary, #121220); color: var(--text-primary, #e0e0e0); font-size: 13px;
  }
  .digest-radio-group { display: flex; gap: 12px; flex-wrap: wrap; }
  .digest-radio-group label { display: flex; align-items: center; gap: 5px; cursor: pointer; font-size: 13px; color: var(--text-primary, #e0e0e0); }
  .digest-toggle { display: flex; align-items: center; gap: 10px; }
  .digest-toggle input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent, #7c3aed); cursor: pointer; }
  .digest-toggle span { font-size: 13px; color: var(--text-primary, #e0e0e0); }
  .digest-btn-row { display: flex; gap: 10px; margin-top: 16px; }

  .digest-results { display: none; }
  .digest-results.active { display: block; }
  .digest-result-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .digest-badge-article { background: #2563eb22; color: #60a5fa; }
  .digest-badge-youtube { background: #dc262622; color: #f87171; }
  .digest-badge-pdf { background: #d9770622; color: #fb923c; }
  .digest-source-meta { font-size: 13px; color: var(--text-secondary, #888); margin-top: 6px; }
  .digest-source-meta a { color: var(--accent, #7c3aed); text-decoration: none; word-break: break-all; }
  .digest-source-meta a:hover { text-decoration: underline; }
  .digest-summary-text { white-space: pre-wrap; line-height: 1.6; font-size: 14px; color: var(--text-primary, #e0e0e0); overflow-wrap: break-word; word-break: break-word; }
  .digest-related-text { white-space: pre-wrap; line-height: 1.6; font-size: 13px; color: var(--text-primary, #e0e0e0); overflow-wrap: break-word; word-break: break-word; }

  .digest-history-list { list-style: none; padding: 0; margin: 0; }
  .digest-history-item { padding: 12px; border-bottom: 1px solid var(--border, #222); display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; min-width: 0; }
  .digest-history-item > div:first-child { min-width: 0; flex: 1; overflow: hidden; }
  .digest-history-item:last-child { border-bottom: none; }
  .digest-history-title { font-weight: 500; color: var(--text-primary, #e0e0e0); font-size: 14px; }
  .digest-history-meta { font-size: 12px; color: var(--text-secondary, #888); margin-top: 4px; }
  .digest-history-summary { font-size: 12px; color: var(--text-secondary, #999); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .digest-empty { text-align: center; padding: 30px; color: var(--text-secondary, #888); font-size: 14px; }

  .digest-section-toggle { cursor: pointer; user-select: none; }
  .digest-section-toggle i.fa-chevron-down { transition: transform 0.2s; }
  .digest-section-toggle.collapsed i.fa-chevron-down { transform: rotate(-90deg); }
  .digest-collapsible { overflow: hidden; transition: max-height 0.3s ease; }
  .digest-collapsible.collapsed { max-height: 0 !important; }

  .digest-source-list { list-style: none; padding: 0; margin: 8px 0 0 0; }
  .digest-source-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--border, #333); border-radius: 6px; margin-bottom: 6px; background: var(--bg-primary, #121220); }
  .digest-source-item .source-name { font-weight: 500; color: var(--text-primary, #e0e0e0); font-size: 14px; }
  .digest-source-item .source-url { font-size: 12px; color: var(--text-secondary, #888); margin-left: 4px; }
  .digest-source-item .source-remove { margin-left: auto; background: none; border: none; color: var(--text-secondary, #888); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .digest-source-item .source-remove:hover { color: #f87171; background: #f8717122; }
</style>

<div class="digest-container">

  <!-- Input -->
  <div class="digest-card">
    <h3><i class="fas fa-book-reader"></i> Content Digest</h3>
    <div class="digest-input-row">
      <input type="text" id="digestUrl" placeholder="Enter article, YouTube, or PDF URL..." />
      <button class="digest-btn digest-btn-primary" onclick="digestRun()" id="digestRunBtn">
        <i class="fas fa-magic"></i> Digest
      </button>
      <button class="digest-btn digest-btn-secondary" onclick="digestExtract()" id="digestExtractBtn">
        <i class="fas fa-file-alt"></i> Extract Only
      </button>
    </div>
    <div class="digest-spinner" id="digestSpinner">
      <i class="fas fa-circle-notch"></i> <span id="digestSpinnerText">Processing...</span>
    </div>
  </div>

  <!-- Results -->
  <div class="digest-results" id="digestResults">
    <div class="digest-card">
      <h3><i class="fas fa-info-circle"></i> Source</h3>
      <div>
        <span class="digest-result-badge" id="digestBadge">ARTICLE</span>
        <strong id="digestResultTitle" style="margin-left:8px;"></strong>
      </div>
      <div class="digest-source-meta" id="digestResultMeta"></div>
    </div>

    <div class="digest-card">
      <h3><i class="fas fa-clipboard-list"></i> Summary</h3>
      <div class="digest-summary-text" id="digestSummaryText"></div>
    </div>

    <div class="digest-card" id="digestRelatedCard" style="display:none;">
      <h3><i class="fas fa-search"></i> Related Content</h3>
      <div class="digest-related-text" id="digestRelatedText"></div>
    </div>
  </div>

  <!-- Settings -->
  <div class="digest-card">
    <h3 class="digest-section-toggle" onclick="digestToggleSection('settingsBody')">
      <i class="fas fa-cog"></i> Settings <i class="fas fa-chevron-down" style="margin-left:auto;font-size:12px;"></i>
    </h3>
    <div id="settingsBody" class="digest-collapsible" style="max-height:500px;">
      <div class="digest-settings-grid">
        <div class="digest-field">
          <label>Delivery Method</label>
          <div class="digest-radio-group">
            <label><input type="radio" name="deliveryMethod" value="telegram" checked /> Telegram</label>
            <label><input type="radio" name="deliveryMethod" value="email" /> Email</label>
            <label><input type="radio" name="deliveryMethod" value="both" /> Both</label>
          </div>
        </div>
        <div class="digest-field">
          <label>Research Depth</label>
          <div class="digest-radio-group">
            <label><input type="radio" name="researchDepth" value="quick" checked /> Quick</label>
            <label><input type="radio" name="researchDepth" value="deep" /> Deep</label>
          </div>
        </div>
        <div class="digest-field">
          <label>Summary Format</label>
          <select id="summaryFormat">
            <option value="bullets">Bullet Points</option>
            <option value="paragraph">Paragraph</option>
            <option value="detailed">Detailed Analysis</option>
          </select>
        </div>
        <div class="digest-field">
          <label>Max Related Results</label>
          <input type="number" id="maxRelatedResults" min="1" max="10" value="5" />
        </div>
        <div class="digest-field">
          <div class="digest-toggle">
            <input type="checkbox" id="includeSourceLink" checked />
            <span>Include source link in delivery</span>
          </div>
        </div>
        <div class="digest-field">
          <div class="digest-toggle">
            <input type="checkbox" id="autoDeliver" checked />
            <span>Auto-deliver after digest</span>
          </div>
        </div>
      </div>
      <div class="digest-btn-row">
        <button class="digest-btn digest-btn-primary digest-btn-sm" onclick="digestSaveSettings()">
          <i class="fas fa-save"></i> Save Settings
        </button>
        <button class="digest-btn digest-btn-secondary digest-btn-sm" onclick="digestTestDelivery()">
          <i class="fas fa-paper-plane"></i> Test Delivery
        </button>
      </div>
    </div>
  </div>

  <!-- Preferred Sources -->
  <div class="digest-card">
    <h3 class="digest-section-toggle" onclick="digestToggleSection('sourcesBody')">
      <i class="fas fa-star"></i> Preferred Sources <i class="fas fa-chevron-down" style="margin-left:auto;font-size:12px;"></i>
    </h3>
    <div id="sourcesBody" class="digest-collapsible" style="max-height:600px;">
      <div class="digest-input-row">
        <input type="text" id="digestSourceInput" placeholder="Site name or URL (e.g. Reuters, arstechnica.com)" />
        <button class="digest-btn digest-btn-primary digest-btn-sm" onclick="digestAddSource()">
          <i class="fas fa-plus"></i> Add Source
        </button>
      </div>
      <ul class="digest-source-list" id="digestSourceList">
        <li class="digest-empty">Loading sources...</li>
      </ul>
      <div style="font-size:12px;color:var(--text-secondary, #888);margin-top:10px;">
        These sources will be prioritized during the research phase of your digests.
      </div>
    </div>
  </div>

  <!-- History -->
  <div class="digest-card">
    <h3>
      <i class="fas fa-history"></i> Recent Digests
      <button class="digest-btn digest-btn-secondary digest-btn-sm" onclick="digestLoadHistory()" style="margin-left:auto;">
        <i class="fas fa-sync-alt"></i> Refresh
      </button>
    </h3>
    <ul class="digest-history-list" id="digestHistoryList">
      <li class="digest-empty">Loading history...</li>
    </ul>
  </div>

</div>

<script>
(function() {
  const apiToken = localStorage.getItem('lanagent_token');

  function notify(msg, type) {
    if (window.dashboard && window.dashboard.showNotification) {
      window.dashboard.showNotification(msg, type);
    } else {
      console.log('[Digest]', type, msg);
    }
  }

  async function api(action, data) {
    try {
      const resp = await fetch('/api/plugin', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ plugin: 'digest', action, ...data })
      });
      return await resp.json();
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function showSpinner(text) {
    const sp = document.getElementById('digestSpinner');
    const st = document.getElementById('digestSpinnerText');
    if (sp) { sp.classList.add('active'); }
    if (st) { st.textContent = text || 'Processing...'; }
  }

  function hideSpinner() {
    const sp = document.getElementById('digestSpinner');
    if (sp) { sp.classList.remove('active'); }
  }

  function setButtonsDisabled(disabled) {
    const ids = ['digestRunBtn', 'digestExtractBtn'];
    ids.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = disabled;
    });
  }

  function showResults(data) {
    const el = document.getElementById('digestResults');
    if (!el) return;
    el.classList.add('active');

    // Badge
    const badge = document.getElementById('digestBadge');
    if (badge) {
      const type = data.sourceType || 'article';
      badge.textContent = type.toUpperCase();
      badge.className = 'digest-result-badge digest-badge-' + type;
    }

    // Title
    const titleEl = document.getElementById('digestResultTitle');
    if (titleEl) titleEl.textContent = data.title || 'Untitled';

    // Meta
    const metaEl = document.getElementById('digestResultMeta');
    if (metaEl) {
      let meta = '';
      if (data.url) meta += '<a href="' + data.url + '" target="_blank">' + data.url + '</a>';
      if (data.metadata) {
        if (data.metadata.author) meta += ' &middot; ' + data.metadata.author;
        if (data.metadata.channel) meta += ' &middot; ' + data.metadata.channel;
        if (data.metadata.pages) meta += ' &middot; ' + data.metadata.pages + ' pages';
      }
      metaEl.innerHTML = meta;
    }

    // Summary
    const sumEl = document.getElementById('digestSummaryText');
    if (sumEl) sumEl.textContent = data.summary || '(No summary available)';

    // Related
    const relCard = document.getElementById('digestRelatedCard');
    const relEl = document.getElementById('digestRelatedText');
    if (data.related && relCard && relEl) {
      relCard.style.display = 'block';
      if (data.related.relatedContent) {
        relEl.textContent = data.related.relatedContent;
      } else if (data.related.searches) {
        let text = '';
        data.related.searches.forEach(s => {
          text += '--- ' + s.query + ' ---\\n' + s.results + '\\n\\n';
        });
        relEl.textContent = text;
      }
    } else if (relCard) {
      relCard.style.display = 'none';
    }
  }

  // ─── Button Handlers ───────────────────────────────────

  window.digestRun = async function() {
    const url = document.getElementById('digestUrl')?.value?.trim();
    if (!url) { notify('Please enter a URL', 'warning'); return; }

    setButtonsDisabled(true);
    showSpinner('Extracting, summarizing, and researching...');
    document.getElementById('digestResults')?.classList.remove('active');

    const result = await api('digest', { url });
    hideSpinner();
    setButtonsDisabled(false);

    if (result.success) {
      showResults(result);
      notify('Digest complete!', 'success');
    } else {
      notify('Digest failed: ' + (result.error || 'Unknown error'), 'error');
    }
  };

  window.digestExtract = async function() {
    const url = document.getElementById('digestUrl')?.value?.trim();
    if (!url) { notify('Please enter a URL', 'warning'); return; }

    setButtonsDisabled(true);
    showSpinner('Extracting content...');
    document.getElementById('digestResults')?.classList.remove('active');

    const result = await api('extract', { url });
    hideSpinner();
    setButtonsDisabled(false);

    if (result.success) {
      showResults({ ...result, summary: result.text?.substring(0, 2000) + (result.text?.length > 2000 ? '...' : '') });
      notify('Content extracted (' + (result.text?.length || 0) + ' chars)', 'success');
    } else {
      notify('Extraction failed: ' + (result.error || 'Unknown error'), 'error');
    }
  };

  window.digestSaveSettings = async function() {
    const data = {
      deliveryMethod: document.querySelector('input[name="deliveryMethod"]:checked')?.value || 'telegram',
      researchDepth: document.querySelector('input[name="researchDepth"]:checked')?.value || 'quick',
      summaryFormat: document.getElementById('summaryFormat')?.value || 'bullets',
      maxRelatedResults: parseInt(document.getElementById('maxRelatedResults')?.value) || 5,
      includeSourceLink: document.getElementById('includeSourceLink')?.checked ?? true,
      autoDeliver: document.getElementById('autoDeliver')?.checked ?? true
    };

    const result = await api('saveSettings', data);
    if (result.success) {
      notify('Settings saved', 'success');
    } else {
      notify('Failed to save settings: ' + (result.error || 'Unknown error'), 'error');
    }
  };

  window.digestTestDelivery = async function() {
    const method = document.querySelector('input[name="deliveryMethod"]:checked')?.value || 'telegram';
    notify('Sending test digest via ' + method + '...', 'info');

    const result = await api('digest', {
      url: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
      deliveryMethod: method
    });

    if (result.success) {
      showResults(result);
      notify('Test digest delivered via ' + method, 'success');
    } else {
      notify('Test delivery failed: ' + (result.error || 'Unknown error'), 'error');
    }
  };

  window.digestLoadHistory = async function() {
    const list = document.getElementById('digestHistoryList');
    if (!list) return;

    const result = await api('history', { limit: 20 });
    if (!result.success || !result.history || result.history.length === 0) {
      list.innerHTML = '<li class="digest-empty">No digests yet. Enter a URL above to get started.</li>';
      return;
    }

    list.innerHTML = result.history.map(h => {
      const date = new Date(h.timestamp).toLocaleString();
      const badge = h.sourceType || 'article';
      return '<li class="digest-history-item">' +
        '<div>' +
          '<div class="digest-history-title">' +
            '<span class="digest-result-badge digest-badge-' + badge + '" style="font-size:10px;margin-right:6px;">' + badge.toUpperCase() + '</span>' +
            (h.title || 'Untitled') +
          '</div>' +
          '<div class="digest-history-meta">' + date + '</div>' +
          (h.summary ? '<div class="digest-history-summary">' + h.summary.substring(0, 120) + '</div>' : '') +
        '</div>' +
        '<div style="flex-shrink:0;">' +
          '<a href="' + (h.url || '#') + '" target="_blank" style="color:var(--accent);font-size:12px;">' +
            '<i class="fas fa-external-link-alt"></i>' +
          '</a>' +
        '</div>' +
      '</li>';
    }).join('');
  };

  window.digestAddSource = async function() {
    const input = document.getElementById('digestSourceInput');
    const raw = (input?.value || '').trim();
    if (!raw) { notify('Enter a site name or URL', 'warning'); return; }

    let name = raw;
    let url = '';
    // If it looks like a URL or domain, extract parts
    if (raw.includes('.')) {
      url = raw.replace(/^https?:[/][/]/, '').replace(/[/].*$/, '');
      // Use domain minus TLD as display name if no obvious name
      const parts = url.split('.');
      if (parts.length >= 2 && raw === url) {
        name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      }
    }

    const result = await api('addSource', { name, url: url || null });
    if (result.success) {
      notify('Source added: ' + name, 'success');
      if (input) input.value = '';
      renderSources(result.sources);
    } else {
      notify(result.error || 'Failed to add source', 'error');
    }
  };

  window.digestRemoveSource = async function(id) {
    const result = await api('removeSource', { id });
    if (result.success) {
      notify('Source removed', 'success');
      renderSources(result.sources);
    } else {
      notify(result.error || 'Failed to remove source', 'error');
    }
  };

  function renderSources(sources) {
    const list = document.getElementById('digestSourceList');
    if (!list) return;
    if (!sources || sources.length === 0) {
      list.innerHTML = '<li class="digest-empty">No preferred sources. Add sites you want prioritized in research.</li>';
      return;
    }
    list.innerHTML = sources.map(function(s) {
      return '<li class="digest-source-item">' +
        '<span class="source-name">' + escapeHtml(s.name) + '</span>' +
        (s.url ? '<span class="source-url">' + escapeHtml(s.url) + '</span>' : '') +
        '<button class="source-remove" onclick="digestRemoveSource(&#39;' + s.id + '&#39;)" title="Remove">' +
          '<i class="fas fa-times"></i>' +
        '</button>' +
      '</li>';
    }).join('');
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  window.digestLoadSources = async function() {
    const result = await api('getSources', {});
    if (result.success) {
      renderSources(result.sources);
    }
  };

  window.digestToggleSection = function(id) {
    const el = document.getElementById(id);
    const toggle = el?.previousElementSibling;
    if (el) {
      el.classList.toggle('collapsed');
      toggle?.classList.toggle('collapsed');
    }
  };

  // ─── Init ──────────────────────────────────────────────

  async function loadSettings() {
    const result = await api('settings', {});
    if (result.success) {
      const s = result;
      // Delivery method
      const dmRadio = document.querySelector('input[name="deliveryMethod"][value="' + (s.deliveryMethod || 'telegram') + '"]');
      if (dmRadio) dmRadio.checked = true;
      // Research depth
      const rdRadio = document.querySelector('input[name="researchDepth"][value="' + (s.researchDepth || 'quick') + '"]');
      if (rdRadio) rdRadio.checked = true;
      // Summary format
      const sfSelect = document.getElementById('summaryFormat');
      if (sfSelect) sfSelect.value = s.summaryFormat || 'bullets';
      // Max results
      const mrInput = document.getElementById('maxRelatedResults');
      if (mrInput) mrInput.value = s.maxRelatedResults || 5;
      // Toggles
      const islCheck = document.getElementById('includeSourceLink');
      if (islCheck) islCheck.checked = s.includeSourceLink !== false;
      const adCheck = document.getElementById('autoDeliver');
      if (adCheck) adCheck.checked = s.autoDeliver !== false;
    }
  }

  loadSettings();
  window.digestLoadSources();
  window.digestLoadHistory();
})();
</script>
`;
  }
}
