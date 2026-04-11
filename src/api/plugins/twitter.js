import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
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
    this.version = '2.0.0';
    this.description = 'Twitter/X integration — read via FxTwitter, post/interact via X API v2';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'TWITTER_API_KEY', required: false },
      { key: 'apiSecret', label: 'API Secret', envVar: 'TWITTER_API_SECRET', required: false },
      { key: 'accessToken', label: 'Access Token', envVar: 'TWITTER_ACCESS_TOKEN', required: false },
      { key: 'accessTokenSecret', label: 'Access Token Secret', envVar: 'TWITTER_ACCESS_TOKEN_SECRET', required: false },
      { key: 'bearerToken', label: 'Bearer Token', envVar: 'TWITTER_BEARER_TOKEN', required: false }
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
      }
    ];

    this.config = {
      apiKey: null,
      apiSecret: null,
      accessToken: null,
      accessTokenSecret: null,
      bearerToken: null
    };

    this.tempDir = path.join(os.tmpdir(), 'lanagent-twitter');
    this.MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB Telegram limit
    this.TWITTER_URL_REGEX = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/\d+/i;
    this.FXTWITTER_API = 'https://api.fxtwitter.com';
    this.X_API_BASE = 'https://api.x.com/2';
    this.authenticatedUserId = null;
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
        this.config.bearerToken = credentials.bearerToken;

        if (this.hasWriteCredentials()) {
          this.logger.info('Twitter plugin initialized with X API v2 write access');
        } else if (this.config.bearerToken) {
          this.logger.info('Twitter plugin initialized with bearer token (read-only API access)');
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
      throw new Error('X API credentials not configured. Set TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_TOKEN_SECRET.');
    }

    const url = `${this.X_API_BASE}${endpoint}`;
    const authHeader = this.generateOAuthHeader(method, url);

    const config = {
      method,
      url,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'LANAgent/2.0'
      }
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      config.data = body;
    }

    const response = await axios(config);
    return response.data;
  }

  /**
   * Make a read request using bearer token (cheaper, app-level auth)
   */
  async xApiBearerRequest(endpoint, params = {}) {
    const token = this.config.bearerToken;
    if (!token) {
      throw new Error('Bearer token not configured. Set TWITTER_BEARER_TOKEN.');
    }

    const url = `${this.X_API_BASE}${endpoint}`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'LANAgent/2.0'
      },
      params
    });
    return response.data;
  }

  // ─── Write Commands (X API v2) ────────────────────────────────────────

  async postTweet({ text, pollOptions, pollDuration, quoteTweetId, replySettings }) {
    if (!text || text.trim().length === 0) {
      return { success: false, error: 'Tweet text is required' };
    }
    if (text.length > 280) {
      return { success: false, error: `Tweet too long (${text.length}/280 characters)` };
    }

    const body = { text: text.trim() };

    if (pollOptions && Array.isArray(pollOptions) && pollOptions.length >= 2) {
      body.poll = {
        options: pollOptions.map(o => ({ label: String(o) })),
        duration_minutes: pollDuration || 1440 // default 24 hours
      };
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

  async replyToTweet({ text, replyToId, url }) {
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

    const body = {
      text: text.trim(),
      reply: { in_reply_to_tweet_id: String(replyToId) }
    };

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
    return {
      enabled: true,
      canPost: hasWrite,
      canRead: true,
      examples: this.commands
        .filter(cmd => hasWrite || !['post', 'reply', 'deleteTweet', 'like', 'getMe'].includes(cmd.command))
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
