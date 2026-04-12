import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { filterSensitiveCommits, getExcludedPathspecs, getSensitiveContentRules } from '../../utils/autoPostFilter.js';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';

export default class TwitterPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'twitter';
    this.version = '3.0.0';
    this.description = 'Twitter/X integration — read via FxTwitter, post/interact via X API v2, auto-post, profile management';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'Consumer Key', envVar: 'TWITTER_CONSUMER_KEY', required: false },
      { key: 'apiSecret', label: 'Consumer Key Secret', envVar: 'TWITTER_CONSUMER_SECRET', required: false },
      { key: 'accessToken', label: 'Access Token', envVar: 'TWITTER_ACCESS_TOKEN', required: false },
      { key: 'accessTokenSecret', label: 'Access Token Secret', envVar: 'TWITTER_ACCESS_TOKEN_SECRET', required: false }
    ];

    this.commands = [
      // --- Read commands (FxTwitter, free, no auth) ---
      {
        command: 'download',
        description: 'Download a tweet/post from Twitter/X by URL',
        usage: 'download({ url: "https://x.com/user/status/123456" })',
        examples: [
          'download tweet https://x.com/...',
          'get this tweet',
          'show me this twitter post',
          'download this x post',
          'https://x.com/user/status/123456',
          'https://twitter.com/user/status/123456',
          'check out this tweet https://x.com/user/status/123'
        ]
      },
      {
        command: 'extract',
        description: 'Extract text and metadata from a tweet without downloading media',
        usage: 'extract({ url: "https://twitter.com/user/status/123" })',
        examples: [
          'what does this tweet say',
          'extract text from tweet',
          'read this tweet'
        ]
      },
      {
        command: 'fetchPollResults',
        description: 'Fetch poll results from a Twitter/X post',
        usage: 'fetchPollResults({ url: "https://x.com/user/status/123456" })',
        examples: [
          'get poll results https://x.com/...',
          'show poll from this tweet'
        ]
      },
      {
        command: 'downloadThread',
        description: 'Download a full Twitter/X thread starting from a given tweet URL',
        usage: 'downloadThread({ url: "https://x.com/user/status/123456" })',
        examples: [
          'download thread https://x.com/...',
          'get this twitter thread'
        ]
      },
      {
        command: 'fetchUserProfile',
        description: 'Fetch and display Twitter/X user profile information',
        usage: 'fetchUserProfile({ username: "user" })',
        examples: [
          'fetch profile for user',
          'show me the profile of user'
        ]
      },
      // --- Write commands (X API v2, requires credentials) ---
      {
        command: 'post',
        description: 'Post a new tweet/post to X (requires API credentials)',
        usage: 'post({ text: "Hello world!" })',
        examples: [
          'tweet "Hello from ALICE"',
          'post to twitter: check out our latest update',
          'send a tweet saying hello world'
        ]
      },
      {
        command: 'reply',
        description: 'Reply to an existing tweet (requires API credentials)',
        usage: 'reply({ text: "Great point!", replyToId: "123456789" })',
        examples: [
          'reply to this tweet saying thanks',
          'respond to tweet 123456789'
        ]
      },
      {
        command: 'deleteTweet',
        description: 'Delete a tweet by ID (requires API credentials)',
        usage: 'deleteTweet({ tweetId: "123456789" })',
        examples: [
          'delete tweet 123456789',
          'remove my last tweet'
        ]
      },
      {
        command: 'like',
        description: 'Like a tweet by ID (requires API credentials)',
        usage: 'like({ tweetId: "123456789" })',
        examples: [
          'like tweet 123456789',
          'like this tweet'
        ]
      },
      {
        command: 'getMe',
        description: 'Get the authenticated user profile (requires API credentials)',
        usage: 'getMe()',
        examples: [
          'who am I on twitter',
          'get my twitter profile',
          'show my x account'
        ]
      },
      // --- Profile management (v1.1 API) ---
      {
        command: 'updateProfile',
        description: 'Update Twitter/X profile name, bio, url, or location',
        usage: 'updateProfile({ name: "ALICE", description: "Autonomous AI agent", url: "https://lanagent.net", location: "The Cloud" })',
        examples: [
          'update my twitter bio',
          'set my twitter name to ALICE',
          'update my x profile description'
        ]
      },
      {
        command: 'updateAvatar',
        description: 'Upload a new profile picture to Twitter/X',
        usage: 'updateAvatar({ imagePath: "/path/to/avatar.png" })',
        examples: [
          'set my twitter avatar',
          'update my x profile picture'
        ]
      },
      {
        command: 'updateBanner',
        description: 'Upload a new profile banner to Twitter/X',
        usage: 'updateBanner({ imagePath: "/path/to/banner.png" })',
        examples: [
          'set my twitter banner',
          'update my x profile banner'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      apiSecret: null,
      accessToken: null,
      accessTokenSecret: null
    };

    this.tempDir = path.join(os.tmpdir(), 'lanagent-twitter');
    this.MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB Telegram limit
    this.TWITTER_URL_REGEX = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/\d+/i;
    this.FXTWITTER_API = 'https://api.fxtwitter.com';
    this.X_API_BASE = 'https://api.x.com/2';
    this.X_API_V1_BASE = 'https://api.twitter.com/1.1';
    this.authenticatedUserId = null;
    this.authenticatedUsername = null;

    // Auto-posting config
    this._autoPostConfig = {
      enabled: true,
      maxAutoPostsPerDay: 2,
      minGapHours: 4,
      wakingHoursStart: 8,
      wakingHoursEnd: 22
    };
  }

  async initialize() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });

      // Try to load API credentials (all optional — read-only mode works without them)
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.apiKey = credentials.apiKey;
        this.config.apiSecret = credentials.apiSecret;
        this.config.accessToken = credentials.accessToken;
        this.config.accessTokenSecret = credentials.accessTokenSecret;

        if (this.hasWriteCredentials()) {
          this.logger.info('Twitter plugin initialized with X API v2 write access');
        } else {
          this.logger.info('Twitter plugin initialized in read-only mode (FxTwitter only)');
        }
      } catch {
        this.logger.info('Twitter plugin initialized in read-only mode (no API credentials)');
      }
    } catch (error) {
      this.logger.error('Failed to initialize twitter plugin:', error);
    }
  }

  /**
   * Check if we have OAuth 1.0a credentials for write operations
   */
  hasWriteCredentials() {
    return !!(this.config.apiKey && this.config.apiSecret &&
              this.config.accessToken && this.config.accessTokenSecret);
  }

  async execute(params = {}) {
    const { action, ...data } = params;

    try {
      switch (action) {
        // Read commands (FxTwitter)
        case 'download':
          return await this.downloadTweet(data);
        case 'extract':
          return await this.extractTweet(data);
        case 'fetchPollResults':
          return await this.fetchPollResults(data);
        case 'downloadThread':
          return await this.downloadThread(data);
        case 'fetchUserProfile':
          return await this.fetchUserProfile(data);

        // Write commands (X API v2)
        case 'post':
          return await this.postTweet(data);
        case 'reply':
          return await this.replyToTweet(data);
        case 'deleteTweet':
          return await this.deleteTweet(data);
        case 'like':
          return await this.likeTweet(data);
        case 'getMe':
          return await this.getAuthenticatedUser();
        case 'uploadMedia':
          return await this.uploadMedia(data);

        // Profile management (v1.1)
        case 'updateProfile':
          return await this.updateProfile(data);
        case 'updateAvatar':
          return await this.updateAvatar(data);
        case 'updateBanner':
          return await this.updateBanner(data);

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      this.logger.error('Twitter plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  // ─── OAuth 1.0a Signature ─────────────────────────────────────────────

  /**
   * Generate OAuth 1.0a authorization header for X API v2 requests.
   * Implements RFC 5849 HMAC-SHA1 signature.
   */
  generateOAuthHeader(method, url, bodyParams = {}) {
    const oauthParams = {
      oauth_consumer_key: this.config.apiKey,
      oauth_nonce: crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: this.config.accessToken,
      oauth_version: '1.0'
    };

    // Combine oauth params + body params for signature base
    const allParams = { ...oauthParams, ...bodyParams };
    const paramString = Object.keys(allParams)
      .sort()
      .map(k => `${this.percentEncode(k)}=${this.percentEncode(allParams[k])}`)
      .join('&');

    const signatureBase = [
      method.toUpperCase(),
      this.percentEncode(url),
      this.percentEncode(paramString)
    ].join('&');

    const signingKey = `${this.percentEncode(this.config.apiSecret)}&${this.percentEncode(this.config.accessTokenSecret)}`;
    const signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');

    oauthParams.oauth_signature = signature;

    const header = 'OAuth ' + Object.keys(oauthParams)
      .sort()
      .map(k => `${this.percentEncode(k)}="${this.percentEncode(oauthParams[k])}"`)
      .join(', ');

    return header;
  }

  percentEncode(str) {
    return encodeURIComponent(String(str))
      .replace(/!/g, '%21')
      .replace(/\*/g, '%2A')
      .replace(/'/g, '%27')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29');
  }

  /**
   * Make an authenticated request to X API v2
   */
  async xApiRequest(method, endpoint, body = null) {
    if (!this.hasWriteCredentials()) {
      throw new Error('X API credentials not configured. Set Consumer Key, Consumer Key Secret, Access Token, and Access Token Secret.');
    }

    const fullUrl = endpoint.startsWith('http') ? endpoint : `${this.X_API_BASE}${endpoint}`;
    const [url, queryString] = fullUrl.split('?');
    // Query params must be included in the OAuth signature
    const queryParams = {};
    if (queryString) {
      for (const pair of queryString.split('&')) {
        const [k, v] = pair.split('=');
        queryParams[decodeURIComponent(k)] = decodeURIComponent(v || '');
      }
    }
    const authHeader = this.generateOAuthHeader(method, url, queryParams);

    const config = {
      method,
      url: fullUrl,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'LANAgent/3.0'
      }
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      config.data = body;
    }

    try {
      const response = await axios(config);
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail || err.response?.data?.errors?.[0]?.message || err.response?.data?.title || err.message;

      // Alert on payment/rate limit issues
      if (status === 402 || status === 429 || (detail && detail.toLowerCase().includes('credit'))) {
        this._alertLowCredits(status, detail);
      }

      throw new Error(`X API ${method} ${endpoint} failed (${status}): ${detail}`);
    }
  }

  /**
   * Make an authenticated request to X API v1.1 (form-encoded).
   * Used for profile management endpoints not yet in v2.
   */
  async xApiV1Request(method, endpoint, params = {}) {
    if (!this.hasWriteCredentials()) {
      throw new Error('X API credentials not configured.');
    }

    const url = `${this.X_API_V1_BASE}${endpoint}`;
    // v1.1 form params must be included in OAuth signature
    const authHeader = this.generateOAuthHeader(method, url, params);

    const config = {
      method,
      url,
      headers: {
        'Authorization': authHeader,
        'User-Agent': 'LANAgent/3.0'
      }
    };

    if (method === 'POST' || method === 'PUT') {
      config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      config.data = new URLSearchParams(params).toString();
    }

    try {
      const response = await axios(config);
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.errors?.[0]?.message || err.response?.data?.error || err.message;
      throw new Error(`X API v1.1 ${endpoint} failed (${status}): ${detail}`);
    }
  }

  // Bearer token removed — all API calls use OAuth 1.0a

  // ─── Write Commands (X API v2) ────────────────────────────────────────

  async postTweet({ text, pollOptions, pollDuration, quoteTweetId, replySettings, mediaIds, filePath }) {
    if (!text || text.trim().length === 0) {
      return { success: false, error: 'Tweet text is required' };
    }
    if (text.length > 280) {
      return { success: false, error: `Tweet too long (${text.length}/280 characters)` };
    }

    // Auto-upload image if filePath provided
    if (filePath && !mediaIds) {
      try {
        const uploaded = await this.uploadMedia({ filePath });
        mediaIds = [uploaded.mediaId];
      } catch (err) {
        this.logger.warn('Media upload failed, posting without image:', err.message);
      }
    }

    const body = { text: text.trim() };

    if (pollOptions && Array.isArray(pollOptions) && pollOptions.length >= 2) {
      body.poll = {
        options: pollOptions.map(o => ({ label: String(o) })),
        duration_minutes: pollDuration || 1440 // default 24 hours
      };
    }

    if (mediaIds && Array.isArray(mediaIds) && mediaIds.length > 0) {
      body.media = { media_ids: mediaIds.map(String) };
    }

    if (quoteTweetId) {
      body.quote_tweet_id = String(quoteTweetId);
    }

    if (replySettings) {
      body.reply_settings = replySettings;
    }

    const result = await this.xApiRequest('POST', '/tweets', body);

    this.logger.info('Tweet posted', { tweetId: result.data?.id });
    return {
      success: true,
      result: `Tweet posted: ${result.data?.text}`,
      data: {
        id: result.data?.id,
        text: result.data?.text,
        url: `https://x.com/i/status/${result.data?.id}`
      }
    };
  }

  async replyToTweet({ text, replyToId, url, filePath, mediaIds }) {
    // Extract tweet ID from URL if provided instead of raw ID
    if (!replyToId && url) {
      replyToId = this.extractPostId(url);
    }
    if (!replyToId || replyToId === 'unknown') {
      return { success: false, error: 'replyToId or tweet URL is required' };
    }
    if (!text || text.trim().length === 0) {
      return { success: false, error: 'Reply text is required' };
    }
    if (text.length > 280) {
      return { success: false, error: `Reply too long (${text.length}/280 characters)` };
    }

    // Auto-upload image if filePath provided
    if (filePath && !mediaIds) {
      try {
        const uploaded = await this.uploadMedia({ filePath });
        mediaIds = [uploaded.mediaId];
      } catch (err) {
        this.logger.warn('Media upload failed for reply, posting without image:', err.message);
      }
    }

    const body = {
      text: text.trim(),
      reply: { in_reply_to_tweet_id: String(replyToId) }
    };

    if (mediaIds && Array.isArray(mediaIds) && mediaIds.length > 0) {
      body.media = { media_ids: mediaIds.map(String) };
    }

    const result = await this.xApiRequest('POST', '/tweets', body);

    this.logger.info('Reply posted', { tweetId: result.data?.id, replyTo: replyToId });
    return {
      success: true,
      result: `Reply posted: ${result.data?.text}`,
      data: {
        id: result.data?.id,
        text: result.data?.text,
        replyTo: replyToId,
        url: `https://x.com/i/status/${result.data?.id}`
      }
    };
  }

  async deleteTweet({ tweetId, url }) {
    if (!tweetId && url) {
      tweetId = this.extractPostId(url);
    }
    if (!tweetId || tweetId === 'unknown') {
      return { success: false, error: 'tweetId or tweet URL is required' };
    }

    const result = await this.xApiRequest('DELETE', `/tweets/${tweetId}`);

    this.logger.info('Tweet deleted', { tweetId });
    return {
      success: true,
      result: `Tweet ${tweetId} deleted`,
      data: { deleted: result.data?.deleted }
    };
  }

  async likeTweet({ tweetId, url }) {
    if (!tweetId && url) {
      tweetId = this.extractPostId(url);
    }
    if (!tweetId || tweetId === 'unknown') {
      return { success: false, error: 'tweetId or tweet URL is required' };
    }

    // Need the authenticated user's ID
    const userId = await this.getMyUserId();

    const result = await this.xApiRequest('POST', `/users/${userId}/likes`, {
      tweet_id: String(tweetId)
    });

    this.logger.info('Tweet liked', { tweetId });
    return {
      success: true,
      result: `Liked tweet ${tweetId}`,
      data: { liked: result.data?.liked }
    };
  }

  async getAuthenticatedUser() {
    const result = await this.xApiRequest('GET', '/users/me');

    this.authenticatedUserId = result.data?.id;
    this.authenticatedUsername = result.data?.username;
    return {
      success: true,
      result: `Authenticated as @${result.data?.username} (${result.data?.name})`,
      data: result.data
    };
  }

  async getMyUserId() {
    if (this.authenticatedUserId) return this.authenticatedUserId;
    const result = await this.getAuthenticatedUser();
    if (!result.success) throw new Error('Failed to get authenticated user ID');
    return this.authenticatedUserId;
  }

  async getMyUsername() {
    if (this.authenticatedUsername) return this.authenticatedUsername;
    await this.getAuthenticatedUser();
    return this.authenticatedUsername;
  }

  // ─── Profile Management (v1.1 API) ────────────────────────────────────

  async updateProfile({ name, description, url, location }) {
    if (!name && !description && !url && !location) {
      return { success: false, error: 'Provide at least one of: name, description, url, location' };
    }

    const params = {};
    if (name) params.name = name.substring(0, 50);
    if (description) params.description = description.substring(0, 160);
    if (url) params.url = url;
    if (location) params.location = location.substring(0, 30);

    const result = await this.xApiV1Request('POST', '/account/update_profile.json', params);

    this.logger.info('Profile updated', { name: result.name, description: result.description?.substring(0, 50) });
    return {
      success: true,
      result: `Profile updated: @${result.screen_name}`,
      data: {
        name: result.name,
        description: result.description,
        url: result.url,
        location: result.location,
        profileImageUrl: result.profile_image_url_https
      }
    };
  }

  async updateAvatar({ imagePath }) {
    if (!imagePath) {
      return { success: false, error: 'imagePath is required' };
    }

    const imageData = await fs.readFile(imagePath);
    const base64 = imageData.toString('base64');

    const result = await this.xApiV1Request('POST', '/account/update_profile_image.json', {
      image: base64
    });

    this.logger.info('Avatar updated', { url: result.profile_image_url_https });
    return {
      success: true,
      result: `Avatar updated for @${result.screen_name}`,
      data: { profileImageUrl: result.profile_image_url_https }
    };
  }

  async updateBanner({ imagePath }) {
    if (!imagePath) {
      return { success: false, error: 'imagePath is required' };
    }

    const imageData = await fs.readFile(imagePath);
    const base64 = imageData.toString('base64');

    // v1.1 banner endpoint returns 200 with empty body on success
    await this.xApiV1Request('POST', '/account/update_profile_banner.json', {
      banner: base64
    });

    this.logger.info('Banner updated');
    return { success: true, result: 'Profile banner updated' };
  }

  // ─── Media Upload (v2 API) ────────────────────────────────────────────

  /**
   * Upload media for use in tweets. Returns media_id string.
   * Uses chunked upload: INIT → APPEND → FINALIZE
   */
  async uploadMedia({ filePath, mediaType, mediaCategory = 'tweet_image' }) {
    if (!filePath) throw new Error('filePath is required');

    const fileData = await fs.readFile(filePath);
    const totalBytes = fileData.length;
    if (!mediaType) {
      const ext = path.extname(filePath).toLowerCase();
      mediaType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4' }[ext] || 'image/jpeg';
    }

    // X API v2 simple media upload — POST /2/media/upload with multipart
    const uploadUrl = `${this.X_API_BASE}/media/upload`;
    const authHeader = this.generateOAuthHeader('POST', uploadUrl);

    // Build multipart body manually (no form-data dependency needed)
    const boundary = '----LANAgent' + crypto.randomBytes(8).toString('hex');
    const filename = path.basename(filePath);
    const parts = [];
    // media file
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
    const mediaBuffer = Buffer.concat([Buffer.from(parts[0]), fileData, Buffer.from('\r\n')]);
    // media_category
    const catPart = `--${boundary}\r\nContent-Disposition: form-data; name="media_category"\r\n\r\n${mediaCategory}\r\n`;
    // media_type
    const typePart = `--${boundary}\r\nContent-Disposition: form-data; name="media_type"\r\n\r\n${mediaType}\r\n`;
    // closing
    const closePart = `--${boundary}--\r\n`;

    const body = Buffer.concat([mediaBuffer, Buffer.from(catPart), Buffer.from(typePart), Buffer.from(closePart)]);

    try {
      const response = await axios.post(uploadUrl, body, {
        headers: {
          'Authorization': authHeader,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'User-Agent': 'LANAgent/3.0'
        },
        maxContentLength: 100 * 1024 * 1024,
        maxBodyLength: 100 * 1024 * 1024,
        timeout: 60000
      });

      const mediaId = response.data?.data?.media_id || response.data?.data?.id || response.data?.media_id_string;
      if (!mediaId) throw new Error('No media_id in response: ' + JSON.stringify(response.data));

      this.logger.info('Media uploaded', { mediaId, mediaType, bytes: totalBytes });
      return { mediaId, size: totalBytes };
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail || err.response?.data?.errors?.[0]?.message || err.response?.data?.error || err.message;
      throw new Error(`Media upload failed (${status}): ${detail}`);
    }
  }

  // ─── Auto-Posting ────────────────────────────────────────────────────

  /**
   * Daily auto-post to Twitter/X. Called by the scheduler every 10 minutes.
   * Posts up to 2 tweets per day during waking hours with a 4-hour gap.
   */
  async _dailyAutoPost() {
    try {
      if (!this.hasWriteCredentials()) return;

      const tz = process.env.TZ || 'America/Los_Angeles';
      const now = new Date();
      const localTime = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const today = localTime.toISOString().slice(0, 10);
      const hour = localTime.getHours();

      const { wakingHoursStart, wakingHoursEnd, maxAutoPostsPerDay, minGapHours } = this._autoPostConfig;
      if (hour < wakingHoursStart || hour > wakingHoursEnd) return;

      const postState = await PluginSettings.getCached(this.name, 'autoPostState');
      const postsToday = (postState?.date === today) ? (postState?.count || 0) : 0;
      const lastPostTime = postState?.lastPostTime || 0;

      if (postsToday >= maxAutoPostsPerDay) return;

      const minGapMs = minGapHours * 60 * 60 * 1000;
      if (lastPostTime && (Date.now() - lastPostTime) < minGapMs) return;

      this.logger.info(`Twitter auto-post check: today=${today}, posts=${postsToday}/${maxAutoPostsPerDay}, hour=${hour}`);

      const context = await this._gatherPostContext();
      if (!context.hasContent) {
        this.logger.debug('Twitter auto-post: no meaningful context, skipping');
        return;
      }

      const agentName = this.agent.config?.name || process.env.AGENT_NAME || 'LANAgent';
      const username = await this.getMyUsername().catch(() => null);

      const prompt = `You are ${agentName} (@${username || agentName}), an autonomous AI agent posting on Twitter/X.

Here are real things that happened recently or that you're currently doing. Pick ONE that's genuinely interesting and write a tweet about it:

${context.items}

TWEET RULES:
- Write 1-3 sentences about ONE specific thing from the context above
- Be specific — reference actual numbers, names, or events
- Share your perspective or what you found interesting
- Sound natural, like a tech-savvy AI sharing its work
- You CAN mention services you offer (scraping, image generation, code execution, etc.)
- Add 1-2 relevant hashtags
- MUST stay under 270 characters (hard limit, leave room for safety)
- NEVER mention trades, positions, P&L, profits, losses, token prices, or portfolio details
- NEVER mention dollar amounts, wallet addresses, or balances
- NEVER share private information about your operator or users
${getSensitiveContentRules()}
- Do NOT be generic or vague — "working on cool stuff" is slop
- Do NOT start with "Just" or "Excited to" or "Been"
- You're an AI agent and that's fine — own it
${context.recentTweets ? '\nYOUR RECENT TWEETS (pick a DIFFERENT topic than ALL of these):\n' + context.recentTweets + '\n' : ''}
Return ONLY the tweet text, nothing else.`;

      const result = await this.agent.providerManager.generateResponse(prompt, {
        temperature: 0.85, maxTokens: 120
      });

      let tweetText = (result?.content || result?.text || '').toString().trim()
        .replace(/^["']|["']$/g, '');

      if (!tweetText || tweetText.length < 15 || tweetText.length > 280) {
        this.logger.debug(`Twitter auto-post: invalid content length (${tweetText?.length}), skipping`);
        return;
      }

      const postResult = await this.postTweet({ text: tweetText });
      if (!postResult.success) {
        this.logger.warn(`Twitter auto-post failed: ${postResult.error}`);
        return;
      }

      await PluginSettings.setCached(this.name, 'autoPostState', {
        date: today,
        count: postsToday + 1,
        lastPostTime: Date.now()
      });
      this.logger.info(`Twitter auto-post (${postsToday + 1}/${maxAutoPostsPerDay}): "${tweetText.substring(0, 80)}..."`);

      // Notify owner via Telegram
      try {
        const telegram = this.agent?.interfaces?.get('telegram');
        if (telegram?.sendNotification) {
          const tweetUrl = postResult.data?.url || `https://x.com/${username}`;
          await telegram.sendNotification(
            `*Twitter post (${postsToday + 1}/${maxAutoPostsPerDay}):*\n\n${tweetText}\n\n[View tweet](${tweetUrl})`,
            { disable_notification: false }
          );
        }
      } catch { /* non-critical */ }
    } catch (err) {
      this.logger.warn(`Twitter auto-post error: ${err.message}`);
    }
  }

  /**
   * Gather real agent activity context for auto-post content generation.
   */
  async _gatherPostContext() {
    const items = [];

    // Scam detection
    try {
      const scammerRegistry = (await import('../../services/crypto/scammerRegistryService.js')).default;
      if (scammerRegistry.isAvailable()) {
        const cacheSize = scammerRegistry._scammerCache?.size || 0;
        if (cacheSize > 0) items.push(`Protecting the network: ${cacheSize} scammer addresses flagged on-chain with soulbound badges`);
      }
    } catch { /* ignore */ }

    // Staking
    try {
      const stakingService = (await import('../../services/crypto/skynetStakingService.js')).default;
      if (stakingService.isAvailable()) {
        const info = await stakingService.getStakeInfo();
        if (info.available && info.stakedAmount > 0) {
          items.push('Staking SKYNET tokens to help secure the on-chain reputation network');
        }
      }
    } catch { /* ignore */ }

    // Self-modification PRs
    try {
      const { default: SubAgent } = await import('../../models/SubAgent.js');
      const selfMod = await SubAgent.findOne({ domain: 'self-modification' });
      const prs = selfMod?.state?.domainState?.prsCreated || 0;
      const analyzed = selfMod?.state?.domainState?.filesAnalyzed || 0;
      if (prs > 0) items.push(`Self-improvement: analyzed ${analyzed} source files and generated ${prs} pull requests to upgrade my own code`);
    } catch { /* ignore */ }

    // Services offered
    try {
      const pluginCount = this.agent?.apiManager?.apis?.size || 0;
      if (pluginCount > 50) {
        items.push(`Running ${pluginCount} plugins — web scraping, media transcoding, image generation, code execution, and more`);
      }
    } catch { /* ignore */ }

    // P2P federation
    try {
      const p2pService = this.agent.services?.p2pFederation || this.agent.services?.p2p;
      if (p2pService?.isConnected?.()) {
        const peerCount = p2pService.getPeerCount?.() || 0;
        items.push(`Connected to the P2P agent federation${peerCount > 0 ? ` with ${peerCount} peer(s) online` : ''}`);
      }
    } catch { /* ignore */ }

    // Uptime
    const uptimeDays = Math.floor(process.uptime() / 86400);
    if (uptimeDays >= 7) {
      items.push(`${uptimeDays} days of continuous uptime — running 24/7 on dedicated hardware`);
    }

    // Recent git commits
    try {
      const { execSync } = await import('child_process');
      const repoPath = process.env.AGENT_REPO_PATH || '/root/lanagent-repo';
      const excludedPaths = getExcludedPathspecs();
      const recentCommits = execSync(
        `cd ${repoPath} && git log --oneline --since="3 days ago" --no-merges -- ${excludedPaths} 2>/dev/null | head -5`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      if (recentCommits) {
        const features = filterSensitiveCommits(
          recentCommits.split('\n')
            .map(l => l.replace(/^[a-f0-9]+ /, '').replace(/^(feat|fix|docs|refactor): /, ''))
            .filter(l => !l.includes('merge') && l.length > 10)
        );
        if (features.length > 0) {
          items.push(`Recent upgrades: ${features.slice(0, 3).join('; ')}`);
        }
      }
    } catch { /* ignore */ }

    // Email stats
    try {
      const emailPlugin = this.agent?.apiManager?.apis?.get('email')?.instance;
      if (emailPlugin?.getStats) {
        const stats = emailPlugin.getStats();
        if (stats.processedToday > 0) {
          items.push(`Processed ${stats.processedToday} emails today — auto-replying, filtering, and routing`);
        }
      }
    } catch { /* ignore */ }

    // Dedup against recent tweets
    let recentTweets = null;
    const recentTopics = new Set();
    try {
      const userId = await this.getMyUserId();
      const tweetsRes = await this.xApiRequest('GET', `/users/${userId}/tweets?max_results=10`);
      const tweets = tweetsRes.data || [];
      if (tweets.length > 0) {
        recentTweets = tweets.slice(0, 8).map(t => `- ${(t.text || '').substring(0, 150)}`).join('\n');

        for (const t of tweets.slice(0, 8)) {
          const text = (t.text || '').toLowerCase();
          if (text.includes('scammer') || text.includes('flagg')) recentTopics.add('scammer');
          if (text.includes('stak')) recentTopics.add('staking');
          if (text.includes('plugin') || text.includes('service')) recentTopics.add('plugins');
          if (text.includes('p2p') || text.includes('federation')) recentTopics.add('p2p');
          if (text.includes('uptime') || text.includes('24/7')) recentTopics.add('uptime');
          if (text.includes('pull request') || text.includes('self-improv')) recentTopics.add('selfmod');
          if (text.includes('email') || text.includes('processed')) recentTopics.add('email');
          if (text.includes('upgrade') || text.includes('commit')) recentTopics.add('upgrades');
        }
      }
    } catch { /* no recent tweets to dedup against — fine */ }

    // Filter out recently-posted topics
    const topicKeywords = {
      scammer: ['scammer', 'flagged on-chain'], staking: ['Staking SKYNET'],
      plugins: ['Running', 'plugins'], p2p: ['P2P', 'federation'],
      uptime: ['uptime', '24/7'], selfmod: ['Self-improvement', 'pull requests'],
      email: ['Processed', 'emails'], upgrades: ['Recent upgrades']
    };

    let filteredItems = items;
    if (recentTopics.size > 0) {
      filteredItems = items.filter(item => {
        for (const [topic, kws] of Object.entries(topicKeywords)) {
          if (recentTopics.has(topic) && kws.some(kw => item.includes(kw))) return false;
        }
        return true;
      });
      if (filteredItems.length === 0) filteredItems = items;
    }

    // Shuffle for variety
    for (let i = filteredItems.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [filteredItems[i], filteredItems[j]] = [filteredItems[j], filteredItems[i]];
    }

    return {
      hasContent: filteredItems.length > 0,
      items: filteredItems.length > 0
        ? filteredItems.map((item, i) => `${i + 1}. ${item}`).join('\n')
        : 'No specific activity to report',
      recentTweets
    };
  }

  // ─── Credit / Rate Limit Alerts ────────────────────────────────────────

  /**
   * Alert when X API returns payment or rate limit errors.
   * Sends Telegram notification and disables auto-posting to avoid wasting calls.
   */
  async _alertLowCredits(status, detail) {
    // Cooldown — don't spam alerts
    const now = Date.now();
    if (this._lastCreditAlert && (now - this._lastCreditAlert) < 4 * 60 * 60 * 1000) return;
    this._lastCreditAlert = now;

    const msg = status === 429
      ? `Twitter/X API rate limit hit. Auto-posting paused.\n\nDetail: ${detail}`
      : `Twitter/X API payment issue (${status}). Auto-posting paused. Add credits at developer.x.com.\n\nDetail: ${detail}`;

    this.logger.warn(`Twitter credit/rate alert: ${status} — ${detail}`);

    // Pause auto-posting
    this._autoPostConfig.enabled = false;

    // Notify via Telegram
    try {
      const telegram = this.agent?.interfaces?.get('telegram');
      if (telegram?.sendNotification) {
        await telegram.sendNotification(msg);
      }
    } catch { /* non-critical */ }
  }

  // ─── Read Commands (FxTwitter, free) ──────────────────────────────────

  async fetchTweet(url) {
    const username = this.extractUsername(url);
    const postId = this.extractPostId(url);

    if (!username || !postId || postId === 'unknown') {
      return { success: false, error: 'Could not extract username/post ID from URL' };
    }

    const apiUrl = `${this.FXTWITTER_API}/${username}/status/${postId}`;
    this.logger.info(`Fetching tweet via FxTwitter: ${apiUrl}`);

    let response;
    try {
      response = await axios.get(apiUrl, {
        headers: { 'User-Agent': 'LANAgent/2.0' },
        timeout: 15000
      });
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Failed to fetch tweet';
      return { success: false, error: msg };
    }

    if (response.data?.code !== 200 || !response.data?.tweet) {
      return { success: false, error: response.data?.message || 'Tweet not found' };
    }

    return { success: true, tweet: response.data.tweet };
  }

  async downloadTweet(data) {
    const url = this.findTwitterUrl(data.url || data.input || data.query || '');
    if (!url) {
      return { success: false, error: 'Valid Twitter/X URL required (must contain /status/)' };
    }

    if (url.includes('/i/spaces/')) {
      return { success: false, error: 'Twitter Spaces are not supported' };
    }

    const fetchResult = await this.fetchTweet(url);
    if (!fetchResult.success) {
      return { success: false, error: fetchResult.error };
    }

    const tweet = fetchResult.tweet;
    const username = tweet.author?.screen_name || 'unknown';
    const description = this.cleanDescription(tweet.text || '');
    const postId = this.extractPostId(url);
    const caption = `@${username}: ${description}`;

    const media = tweet.media;
    if (media) {
      if (media.videos && media.videos.length > 0) {
        return await this.handleVideo(media.videos[0], caption, postId);
      }
      if (media.photos && media.photos.length > 0) {
        return await this.handlePhoto(media.photos[0], caption, postId);
      }
    }

    return { success: true, result: caption };
  }

  async extractTweet(data) {
    const url = this.findTwitterUrl(data.url || data.input || data.query || '');
    if (!url) {
      return { success: false, error: 'Valid Twitter/X URL required (must contain /status/)' };
    }

    const fetchResult = await this.fetchTweet(url);
    if (!fetchResult.success) {
      return { success: false, error: fetchResult.error };
    }

    const tweet = fetchResult.tweet;
    const username = tweet.author?.screen_name || 'unknown';
    const description = this.cleanDescription(tweet.text || '');

    const allMedia = tweet.media?.all || [];
    const mediaCount = allMedia.length;
    const mediaTypes = allMedia.map(m => m.type);

    let text = `@${username}: ${description}`;
    if (mediaCount > 0) {
      text += `\n\n[${mediaCount} media: ${mediaTypes.join(', ')}]`;
    }

    return {
      success: true,
      result: text,
      data: { author: username, description, mediaCount, mediaTypes, url }
    };
  }

  async fetchPollResults(data) {
    const url = this.findTwitterUrl(data.url || data.input || data.query || '');
    if (!url) {
      return { success: false, error: 'Valid Twitter/X URL required (must contain /status/)' };
    }

    const fetchResult = await this.fetchTweet(url);
    if (!fetchResult.success) {
      return { success: false, error: fetchResult.error };
    }

    const tweet = fetchResult.tweet;
    if (!tweet.poll) {
      return { success: false, error: 'No poll found in this tweet' };
    }

    const poll = tweet.poll;
    const pollResults = poll.choices.map(choice => `${choice.label}: ${choice.count} votes`).join('\n');
    const status = poll.time_left_en || 'Poll ended';

    return {
      success: true,
      result: `Poll Results (${poll.total_votes} total votes — ${status}):\n${pollResults}`
    };
  }

  async downloadThread(data) {
    const url = this.findTwitterUrl(data.url || data.input || data.query || '');
    if (!url) {
      return { success: false, error: 'Valid Twitter/X URL required (must contain /status/)' };
    }

    const thread = [];
    let nextUrl = url;

    while (nextUrl) {
      const fetchResult = await this.fetchTweet(nextUrl);
      if (!fetchResult.success) {
        return { success: false, error: fetchResult.error };
      }

      const tweet = fetchResult.tweet;
      const username = tweet.author?.screen_name || 'unknown';
      const description = this.cleanDescription(tweet.text || '');
      const caption = `@${username}: ${description}`;

      thread.push(caption);

      nextUrl = tweet.in_reply_to_status_id_str
        ? `https://x.com/${username}/status/${tweet.in_reply_to_status_id_str}`
        : null;
    }

    return { success: true, result: thread.join('\n\n') };
  }

  async fetchUserProfile(data) {
    const username = data.username;
    if (!username) {
      return { success: false, error: 'Username is required to fetch profile' };
    }

    const apiUrl = `${this.FXTWITTER_API}/${username}`;
    this.logger.info(`Fetching user profile via FxTwitter: ${apiUrl}`);

    let response;
    try {
      response = await axios.get(apiUrl, {
        headers: { 'User-Agent': 'LANAgent/2.0' },
        timeout: 15000
      });
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Failed to fetch user profile';
      return { success: false, error: msg };
    }

    if (response.data?.code !== 200 || !response.data?.user) {
      return { success: false, error: response.data?.message || 'User profile not found' };
    }

    const user = response.data.user;
    return {
      success: true,
      result: {
        username: user.screen_name,
        name: user.name,
        bio: user.description,
        followers: user.followers,
        following: user.following,
        tweets: user.tweets,
        profileImage: user.avatar_url,
        bannerUrl: user.banner_url,
        url: user.url,
        joined: user.joined
      }
    };
  }

  // ─── Media Helpers ────────────────────────────────────────────────────

  async handlePhoto(photo, caption, postId) {
    const imageUrl = photo.url;
    if (!imageUrl) {
      return { success: true, result: caption };
    }

    try {
      const ext = this.getExtFromUrl(imageUrl, '.jpg');
      const filename = `tweet_${postId}${ext}`;
      const filePath = path.join(this.tempDir, filename);
      await this.downloadFile(imageUrl, filePath);
      return { success: true, result: caption, file: { path: filePath, filename } };
    } catch (err) {
      this.logger.error('Photo download failed:', err.message);
      return { success: true, result: `${caption}\n\nImage: ${imageUrl}` };
    }
  }

  async handleVideo(video, caption, postId) {
    const videoUrl = video.url;
    if (!videoUrl) {
      return { success: true, result: caption };
    }

    const videoSize = await this.getVideoSize(videoUrl);
    if (videoSize > this.MAX_VIDEO_SIZE) {
      const sizeMB = (videoSize / (1024 * 1024)).toFixed(1);
      return {
        success: true,
        result: `${caption}\n\nVideo too large for Telegram (${sizeMB}MB). Direct link:\n${videoUrl}`
      };
    }

    try {
      const filename = `tweet_${postId}.mp4`;
      const filePath = path.join(this.tempDir, filename);
      await this.downloadFile(videoUrl, filePath);
      return { success: true, result: caption, file: { path: filePath, filename } };
    } catch (err) {
      this.logger.error('Video download failed:', err.message);
      return { success: true, result: `${caption}\n\nVideo failed to download. Direct link:\n${videoUrl}` };
    }
  }

  // ─── URL / String Helpers ─────────────────────────────────────────────

  findTwitterUrl(text) {
    const match = text.match(this.TWITTER_URL_REGEX);
    return match ? match[0] : null;
  }

  extractPostId(url) {
    const match = url.match(/\/status\/(\d+)/);
    return match ? match[1] : 'unknown';
  }

  extractUsername(url) {
    const match = url.match(/(?:twitter\.com|x\.com)\/(\w+)\/status/);
    return match ? match[1] : null;
  }

  cleanDescription(text) {
    if (!text) return '';
    let cleaned = text;
    cleaned = cleaned.replace(/\\"/g, '"');
    cleaned = cleaned.replace(/\\n/g, '\n');
    cleaned = cleaned.replace(/https?:\/\/t\.co\/\w+/g, '');
    cleaned = cleaned.replace(/\s+$/, '').trim();
    return cleaned;
  }

  getExtFromUrl(url, fallback = '.jpg') {
    try {
      const pathname = new URL(url).pathname;
      const ext = path.extname(pathname);
      return ext || fallback;
    } catch {
      return fallback;
    }
  }

  async downloadFile(url, destPath) {
    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      timeout: 60000
    });
    await pipeline(response.data, createWriteStream(destPath));
  }

  async getVideoSize(url) {
    try {
      const response = await axios.head(url, { timeout: 10000 });
      const contentLength = response.headers['content-length'];
      return contentLength ? parseInt(contentLength, 10) : 0;
    } catch {
      return 0;
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async cleanup() {
    this.logger.info('Cleaning up twitter plugin temp files');
    try {
      const files = await fs.readdir(this.tempDir);
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < oneHourAgo) {
          await fs.unlink(filePath);
        }
      }
    } catch (err) {
      this.logger.warn('Cleanup error:', err.message);
    }
  }

  async getAICapabilities() {
    const hasWrite = this.hasWriteCredentials();
    const writeOnly = ['post', 'reply', 'deleteTweet', 'like', 'getMe', 'updateProfile', 'updateAvatar', 'updateBanner'];
    return {
      enabled: true,
      canPost: hasWrite,
      canRead: true,
      canManageProfile: hasWrite,
      autoPostEnabled: hasWrite && this._autoPostConfig.enabled,
      examples: this.commands
        .filter(cmd => hasWrite || !writeOnly.includes(cmd.command))
        .flatMap(cmd => cmd.examples || [])
    };
  }

  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}
