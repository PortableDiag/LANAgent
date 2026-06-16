import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';

export default class JsonplaceholderPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'jsonplaceholder';
    this.version = '1.0.0';
    this.description = 'Free fake REST API for testing and prototyping';

    this.commands = [
      {
        command: 'getPosts',
        description: 'Retrieve posts with optional filtering by user',
        usage: 'getPosts({ userId: 1, limit: 10 })',
        examples: [
          'show me all posts',
          'get posts from user 1',
          'list the latest blog posts',
          'fetch posts by user id 5'
        ]
      },
      {
        command: 'getPost',
        description: 'Get details of a specific post by ID',
        usage: 'getPost({ id: 1 })',
        examples: [
          'show me post number 5',
          'get the post with id 10',
          'retrieve post 42',
          'fetch post details for id 7'
        ]
      },
      {
        command: 'getComments',
        description: 'Get comments, optionally filtered by post',
        usage: 'getComments({ postId: 1 })',
        examples: [
          'show all comments',
          'get comments for post 3',
          'list comments on post 15',
          'fetch all user comments'
        ]
      },
      {
        command: 'getUsers',
        description: 'Get a list of all users or a specific user',
        usage: 'getUsers({ id: 1 })',
        examples: [
          'show me all users',
          'get user with id 3',
          'list all registered users',
          'fetch user profile for id 8'
        ]
      },
      {
        command: 'createPost',
        description: 'Create a new post with title and body',
        usage: 'createPost({ title: "My Title", body: "Content", userId: 1 })',
        examples: [
          'create a new post titled hello world',
          'add a post about javascript',
          'publish a new blog entry',
          'post an article about coding'
        ]
      },
      {
        command: 'updatePost',
        description: 'Update an existing post by ID',
        usage: 'updatePost({ id: 1, title: "Updated Title", body: "Updated Content" })',
        examples: [
          'update post 5 with new title and content',
          'change the content of post 10',
          'modify post 42',
          'edit post details for id 7'
        ]
      },
      {
        command: 'deletePost',
        description: 'Delete a post by ID',
        usage: 'deletePost({ id: 1 })',
        examples: [
          'remove post number 5',
          'delete the post with id 10',
          'erase post 42',
          'discard post with id 7'
        ]
      },
      {
        command: 'getAlbums',
        description: 'Retrieve albums with optional filtering by user',
        usage: 'getAlbums({ userId: 1 })',
        examples: [
          'show me all albums',
          'get albums from user 1',
          'list all photo albums',
          'fetch albums by user id 5'
        ]
      },
      {
        command: 'getPhotos',
        description: 'Retrieve photos with optional filtering by album',
        usage: 'getPhotos({ albumId: 1 })',
        examples: [
          'show me all photos',
          'get photos from album 1',
          'list all images',
          'fetch photos by album id 5'
        ]
      }
    ];

    this.config = {
      baseUrl: 'https://jsonplaceholder.typicode.com',
      timeout: 10000,
      retryAttempts: 3,
      cacheTimeout: 300
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: this.config.cacheTimeout, checkperiod: 60 });
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        Object.assign(this.config, savedConfig);
        this.logger.info('Loaded cached configuration');
      }

      const testResponse = await retryOperation(
        () => axios.get(`${this.config.baseUrl}/posts/1`, { timeout: this.config.timeout }),
        { retries: 2, context: 'jsonplaceholder:initialize' }
      );

      if (testResponse.status !== 200) {
        throw new Error('API connection test failed');
      }

      await PluginSettings.setCached(this.name, 'config', this.config);

      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized successfully`);
    } catch (error) {
      if (error && error.message && (error.message.includes('Missing required credentials') || /API[_-]?KEY.*(required|missing|not configured)/i.test(error.message) || /environment variable .* (required|not set)/i.test(error.message) || /credentials? (not configured|missing|required)/i.test(error.message))) {
        this.logger.warn(`Failed to initialize ${this.name} plugin: ${error.message}`);
      } else {
        this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
      }
      throw error;
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: this.commands.map(c => c.command)
      }
    });

    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }

    try {
      switch (action) {
        case 'getPosts':
          return await this.getPosts(data);
        case 'getPost':
          return await this.getPost(data);
        case 'getComments':
          return await this.getComments(data);
        case 'getUsers':
          return await this.getUsers(data);
        case 'createPost':
          return await this.createPost(data);
        case 'updatePost':
          return await this.updatePost(data);
        case 'deletePost':
          return await this.deletePost(data);
        case 'getAlbums':
          return await this.getAlbums(data);
        case 'getPhotos':
          return await this.getPhotos(data);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async extractParameters(input, action) {
    const prompt = `Extract parameters from: "${input}"
    For ${this.name} plugin action: ${action}

    Based on the action type:
    - getPosts: extract userId (number) if mentioned, limit (number) if specified
    - getPost: extract id (number) of the post
    - getComments: extract postId (number) if filtering by post
    - getUsers: extract id (number) if getting specific user
    - createPost: extract title (string), body (string), and optionally userId (number)
    - updatePost: extract id (number), title (string), and body (string)
    - deletePost: extract id (number)
    - getAlbums: extract userId (number) if filtering by user
    - getPhotos: extract albumId (number) if filtering by album

    Return JSON with appropriate parameters based on the action.`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    try {
      return JSON.parse(response.content);
    } catch (error) {
      this.logger.warn('Failed to parse AI parameters:', error);
      return {};
    }
  }

  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }

  async getPosts(params = {}) {
    const { userId, limit = 100 } = params;

    const cacheKey = `posts_${userId || 'all'}_${limit}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      this.logger.debug('Returning cached posts data');
      return { success: true, data: cachedData };
    }

    try {
      let url = `${this.config.baseUrl}/posts`;
      if (userId) {
        url += `?userId=${userId}`;
      }

      const response = await retryOperation(
        () => axios.get(url, { timeout: this.config.timeout }),
        { retries: this.config.retryAttempts, context: 'jsonplaceholder:getPosts' }
      );

      let posts = response.data;
      if (limit && posts.length > limit) {
        posts = posts.slice(0, limit);
      }

      this.cache.set(cacheKey, posts);

      return {
        success: true,
        data: posts,
        count: posts.length,
        filtered: userId ? `by user ${userId}` : 'all users'
      };
    } catch (error) {
      throw new Error(`Failed to fetch posts: ${error.message}`);
    }
  }

  async getPost(params) {
    this.validateParams(params, {
      id: { required: true, type: 'number' }
    });

    const { id } = params;

    const cacheKey = `post_${id}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      this.logger.debug(`Returning cached post ${id}`);
      return { success: true, data: cachedData };
    }

    try {
      const response = await retryOperation(
        () => axios.get(`${this.config.baseUrl}/posts/${id}`, { timeout: this.config.timeout }),
        { retries: this.config.retryAttempts, context: 'jsonplaceholder:getPost' }
      );

      this.cache.set(cacheKey, response.data);

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        throw new Error(`Post with id ${id} not found`);
      }
      throw new Error(`Failed to fetch post: ${error.message}`);
    }
  }

  async getComments(params = {}) {
    const { postId } = params;

    const cacheKey = `comments_${postId || 'all'}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      this.logger.debug('Returning cached comments');
      return { success: true, data: cachedData };
    }

    try {
      let url = `${this.config.baseUrl}/comments`;
      if (postId) {
        url += `?postId=${postId}`;
      }

      const response = await retryOperation(
        () => axios.get(url, { timeout: this.config.timeout }),
        { retries: this.config.retryAttempts, context: 'jsonplaceholder:getComments' }
      );

      this.cache.set(cacheKey, response.data);

      return {
        success: true,
        data: response.data,
        count: response.data.length,
        filtered: postId ? `for post ${postId}` : 'all comments'
      };
    } catch (error) {
      throw new Error(`Failed to fetch comments: ${error.message}`);
    }
  }

  async getUsers(params = {}) {
    const { id } = params;

    if (id) {
      const cacheKey = `user_${id}`;
      const cachedData = this.cache.get(cacheKey);
      if (cachedData) {
        this.logger.debug(`Returning cached user ${id}`);
        return { success: true, data: cachedData };
      }

      try {
        const response = await retryOperation(
          () => axios.get(`${this.config.baseUrl}/users/${id}`, { timeout: this.config.timeout }),
          { retries: this.config.retryAttempts, context: 'jsonplaceholder:getUser' }
        );

        this.cache.set(cacheKey, response.data);

        return {
          success: true,
          data: response.data
        };
      } catch (error) {
        if (error.response && error.response.status === 404) {
          throw new Error(`User with id ${id} not found`);
        }
        throw new Error(`Failed to fetch user: ${error.message}`);
      }
    } else {
      const cacheKey = 'users_all';
      const cachedData = this.cache.get(cacheKey);
      if (cachedData) {
        this.logger.debug('Returning cached users list');
        return { success: true, data: cachedData };
      }

      try {
        const response = await retryOperation(
          () => axios.get(`${this.config.baseUrl}/users`, { timeout: this.config.timeout }),
          { retries: this.config.retryAttempts, context: 'jsonplaceholder:getUsers' }
        );

        this.cache.set(cacheKey, response.data);

        return {
          success: true,
          data: response.data,
          count: response.data.length
        };
      } catch (error) {
        throw new Error(`Failed to fetch users: ${error.message}`);
      }
    }
  }

  async createPost(params) {
    this.validateParams(params, {
      title: { required: true, type: 'string' },
      body: { required: true, type: 'string' },
      userId: { required: false, type: 'number' }
    });

    const { title, body, userId = 1 } = params;

    try {
      const response = await retryOperation(
        () => axios.post(`${this.config.baseUrl}/posts`, {
          title, body, userId
        }, {
          timeout: this.config.timeout,
          headers: { 'Content-Type': 'application/json' }
        }),
        { retries: this.config.retryAttempts, context: 'jsonplaceholder:createPost' }
      );

      const keys = this.cache.keys().filter(k => k.startsWith('posts_'));
      keys.forEach(k => this.cache.del(k));

      return {
        success: true,
        data: response.data,
        message: 'Post created successfully'
      };
    } catch (error) {
      throw new Error(`Failed to create post: ${error.message}`);
    }
  }

  async updatePost(params) {
    this.validateParams(params, {
      id: { required: true, type: 'number' },
      title: { required: false, type: 'string' },
      body: { required: false, type: 'string' }
    });

    const { id, title, body } = params;

    try {
      const response = await retryOperation(
        () => axios.put(`${this.config.baseUrl}/posts/${id}`, {
          ...(title && { title }),
          ...(body && { body })
        }, {
          timeout: this.config.timeout,
          headers: { 'Content-Type': 'application/json' }
        }),
        { retries: this.config.retryAttempts, context: 'jsonplaceholder:updatePost' }
      );

      this.cache.del(`post_${id}`);

      return {
        success: true,
        data: response.data,
        message: 'Post updated successfully'
      };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        throw new Error(`Post with id ${id} not found`);
      }
      throw new Error(`Failed to update post: ${error.message}`);
    }
  }

  async deletePost(params) {
    this.validateParams(params, {
      id: { required: true, type: 'number' }
    });

    const { id } = params;

    try {
      await retryOperation(
        () => axios.delete(`${this.config.baseUrl}/posts/${id}`, { timeout: this.config.timeout }),
        { retries: this.config.retryAttempts, context: 'jsonplaceholder:deletePost' }
      );

      this.cache.del(`post_${id}`);

      return {
        success: true,
        message: 'Post deleted successfully'
      };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        throw new Error(`Post with id ${id} not found`);
      }
      throw new Error(`Failed to delete post: ${error.message}`);
    }
  }

  async getAlbums(params = {}) {
    const { userId } = params;

    const cacheKey = `albums_${userId || 'all'}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      this.logger.debug('Returning cached albums data');
      return { success: true, data: cachedData };
    }

    try {
      let url = `${this.config.baseUrl}/albums`;
      if (userId) {
        url += `?userId=${userId}`;
      }

      const response = await retryOperation(
        () => axios.get(url, { timeout: this.config.timeout }),
        { retries: this.config.retryAttempts, context: 'jsonplaceholder:getAlbums' }
      );

      this.cache.set(cacheKey, response.data);

      return {
        success: true,
        data: response.data,
        count: response.data.length,
        filtered: userId ? `by user ${userId}` : 'all users'
      };
    } catch (error) {
      throw new Error(`Failed to fetch albums: ${error.message}`);
    }
  }

  async getPhotos(params = {}) {
    const { albumId } = params;

    const cacheKey = `photos_${albumId || 'all'}`;
    const cachedData = this.cache.get(cacheKey);
    if (cachedData) {
      this.logger.debug('Returning cached photos data');
      return { success: true, data: cachedData };
    }

    try {
      let url = `${this.config.baseUrl}/photos`;
      if (albumId) {
        url += `?albumId=${albumId}`;
      }

      const response = await retryOperation(
        () => axios.get(url, { timeout: this.config.timeout }),
        { retries: this.config.retryAttempts, context: 'jsonplaceholder:getPhotos' }
      );

      this.cache.set(cacheKey, response.data);

      return {
        success: true,
        data: response.data,
        count: response.data.length,
        filtered: albumId ? `for album ${albumId}` : 'all albums'
      };
    } catch (error) {
      throw new Error(`Failed to fetch photos: ${error.message}`);
    }
  }

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    this.cache.flushAll();
    await PluginSettings.clearCache(this.name);
    this.initialized = false;
  }

  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}
