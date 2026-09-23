import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { DATA_PATH } from '../../utils/paths.js';
import fs from 'fs';
import path from 'path';

export default class KagglePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'kaggle';
    this.version = '1.0.0';
    this.description = 'Interact with Kaggle datasets, competitions, and kernels';

    // Define required credentials for this plugin
    this.requiredCredentials = [
      { key: 'username', label: 'Username', envVar: 'KAGGLE_USERNAME', required: true },
      { key: 'apiKey', label: 'API Key', envVar: 'KAGGLE_API_KEY', required: true }
    ];

    // Commands array - CRITICAL for AI natural language support
    this.commands = [
      {
        command: 'list_datasets',
        description: 'List public datasets with optional search filter',
        usage: 'list_datasets({ search: "machine learning", page: 1, sortBy: "hottest" })',
        examples: [
          'show me machine learning datasets',
          'find datasets about climate change',
          'list popular data science datasets',
          'browse datasets with python code'
        ]
      },
      {
        command: 'download_dataset',
        description: 'Download a dataset archive by owner and slug into the agent data directory',
        usage: 'download_dataset({ ownerSlug: "owner", datasetSlug: "dataset-name", fileName: "titanic.zip" })',
        examples: [
          'download the titanic dataset',
          'get the house prices dataset',
          'fetch the covid-19 data files',
          'download mnist handwritten digits dataset'
        ]
      },
      {
        command: 'list_competitions',
        description: 'List active competitions',
        usage: 'list_competitions({ category: "featured", page: 1, sortBy: "latestDeadline" })',
        examples: [
          'show current Kaggle competitions',
          'find featured data science contests',
          'list ongoing machine learning competitions',
          'what competitions are available now?'
        ]
      },
      {
        command: 'list_kernels',
        description: 'List public kernels (notebooks)',
        usage: 'list_kernels({ search: "python", page: 1, pageSize: 20, sortBy: "hotness" })',
        examples: [
          'find popular Python notebooks',
          'show me tensorflow examples',
          'list jupyter notebooks on image classification',
          'browse data visualization kernels'
        ]
      }
    ];

    // Configuration - API key loaded dynamically via loadCredentials()
    this.config = {
      username: null,
      apiKey: null,
      baseUrl: 'https://www.kaggle.com/api/v1',
      // Downloads land here and nowhere else. A dataset slug arrives from natural
      // language, so the caller never supplies a directory — see downloadDataset().
      downloadDir: path.join(DATA_PATH, 'kaggle'),
      // Kaggle datasets run to tens of GB. Filling the disk takes mongod down with
      // it, so an oversized archive is refused rather than streamed.
      maxDownloadBytes: 2 * 1024 * 1024 * 1024
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 minute cache
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      // Load credentials using BasePlugin helper
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.username = credentials.username;
        this.config.apiKey = credentials.apiKey;
        this.logger.info('Loaded API credentials');
      } catch (credError) {
        this.logger.warn(`Credentials not configured: ${credError.message}`);
      }

      // Load other cached configuration
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { username, apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
        this.logger.info('Loaded cached configuration');
      }

      // Check if API key is configured
      if (!this.config.apiKey || !this.config.username) {
        this.logger.warn('API credentials not fully configured - plugin will have limited functionality');
      }

      // Save non-credential config to cache
      const { username, apiKey, ...configToCache } = this.config;
      await PluginSettings.setCached(this.name, 'config', configToCache);

      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized successfully`);
    } catch (error) {
      this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
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
    
    // Handle AI parameter extraction
    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }
    
    try {
      switch (action) {
        case 'list_datasets':
          return await this.listDatasets(data);
        case 'download_dataset':
          return await this.downloadDataset(data);
        case 'list_competitions':
          return await this.listCompetitions(data);
        case 'list_kernels':
          return await this.listKernels(data);
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

    Return JSON with appropriate parameters based on the action.`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    // Use safeJsonParse to avoid throwing on malformed JSON
    const parsed = safeJsonParse(response.content, {});
    if (!parsed || Object.keys(parsed).length === 0) {
      this.logger.warn('Failed to parse AI parameters from response');
    }
    return parsed;
  }
  
  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }
  
  // Valid enum values, copied from Kaggle's own client (kaggle_api_extended.py).
  // Checking locally turns a confusing upstream 400 into a message that names the
  // options.
  static VALID_DATASET_SORT_BY = ['hottest', 'votes', 'updated', 'active', 'published'];
  static VALID_DATASET_FILE_TYPES = ['all', 'csv', 'sqlite', 'json', 'bigQuery'];
  static VALID_DATASET_LICENSES = ['all', 'cc', 'gpl', 'odb', 'other'];
  static VALID_COMPETITION_CATEGORIES = [
    'all', 'featured', 'research', 'recruitment', 'gettingStarted', 'masters', 'playground'
  ];
  static VALID_COMPETITION_GROUPS = ['general', 'entered', 'inClass'];
  static VALID_COMPETITION_SORT_BY = [
    'grouped', 'prize', 'earliestDeadline', 'latestDeadline', 'numberOfTeams', 'recentlyCreated'
  ];
  static VALID_KERNEL_SORT_BY = [
    'hotness', 'commentCount', 'dateCreated', 'dateRun', 'relevance',
    'scoreAscending', 'scoreDescending', 'viewCount', 'voteCount'
  ];

  _requireCredentials() {
    if (!this.config.username || !this.config.apiKey) {
      throw new Error('Kaggle credentials are not configured (username + API key)');
    }
  }

  _authConfig() {
    return {
      auth: {
        username: this.config.username,
        password: this.config.apiKey
      }
    };
  }

  _checkEnum(name, value, allowed) {
    if (value !== undefined && value !== null && !allowed.includes(value)) {
      throw new Error(`Invalid ${name} "${value}". Valid options: ${allowed.join(', ')}`);
    }
  }

  // Implementation methods for each action
  async listDatasets(params = {}) {
    const { search, page = 1, sortBy, user, fileType, license, minSize, maxSize } = params;

    this._requireCredentials();
    this._checkEnum('sortBy', sortBy, KagglePlugin.VALID_DATASET_SORT_BY);
    this._checkEnum('fileType', fileType, KagglePlugin.VALID_DATASET_FILE_TYPES);
    this._checkEnum('license', license, KagglePlugin.VALID_DATASET_LICENSES);

    // Check cache first
    const cacheKey = `datasets_${search || ''}_${page}_${sortBy || ''}_${user || ''}_${fileType || ''}_${license || ''}_${minSize || ''}_${maxSize || ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }

    try {
      // /datasets/list has no page-size parameter: Kaggle returns a fixed 20 per
      // page and silently ignores anything else, so asking for more here would be
      // a promise the API does not keep. Walk `page` instead.
      const config = {
        ...this._authConfig(),
        params: this._pruneParams({
          page,
          search,
          sortBy,
          user,
          filetype: fileType,
          license,
          minSize,
          maxSize
        })
      };

      const response = await retryOperation(() =>
        axios.get(`${this.config.baseUrl}/datasets/list`, config),
        { retries: 3, context: 'list datasets' }
      );

      // Cache the result
      this.cache.set(cacheKey, response.data);

      return { success: true, data: response.data };
    } catch (error) {
      throw new Error(`Failed to list datasets: ${error.message}`);
    }
  }

  /**
   * Drop keys Kaggle was not given a value for. Sending `sortBy=undefined` as a
   * literal is not the same as omitting it.
   */
  _pruneParams(params) {
    return Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
  }

  async downloadDataset(params = {}) {
    this.validateParams(params, {
      ownerSlug: { required: true, type: 'string' },
      datasetSlug: { required: true, type: 'string' },
      fileName: { required: false, type: 'string' }
    });

    const { ownerSlug, datasetSlug } = params;
    this._requireCredentials();

    // The slugs and any filename reach this method from natural language, so none of
    // them is allowed to steer where the bytes land. Everything is written inside
    // config.downloadDir under a name derived from the slugs with separators
    // stripped; a caller-supplied path is not accepted at all.
    const safe = (v) => String(v).replace(/[^A-Za-z0-9._-]/g, '_');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ownerSlug) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(datasetSlug)) {
      throw new Error('ownerSlug and datasetSlug must be Kaggle slugs (letters, digits, . _ -)');
    }

    const destDir = this.config.downloadDir;
    const destFile = path.join(destDir, `${safe(ownerSlug)}__${safe(datasetSlug)}.zip`);
    await fs.promises.mkdir(destDir, { recursive: true });

    let response;
    try {
      response = await retryOperation(() =>
        axios.get(
          `${this.config.baseUrl}/datasets/download/${encodeURIComponent(ownerSlug)}/${encodeURIComponent(datasetSlug)}`,
          {
            ...this._authConfig(),
            responseType: 'stream',
            maxRedirects: 5
          }
        ),
        { retries: 3, context: 'download dataset' }
      );
    } catch (error) {
      throw new Error(`Failed to download dataset: ${error.message}`);
    }

    // From here the response body is an open socket. Every exit path below has to
    // destroy it, or the connection is held until the server gives up — the previous
    // version of this method returned "download initiated" without ever reading the
    // stream, which both leaked the socket and reported a success that had not
    // happened.
    const declared = Number(response.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > this.config.maxDownloadBytes) {
      response.data.destroy();
      throw new Error(
        `Failed to download dataset: archive is ${declared} bytes, over the ${this.config.maxDownloadBytes} byte limit`
      );
    }

    try {
      const bytes = await this._streamToFile(response.data, destFile);
      this.logger.info(`Downloaded ${ownerSlug}/${datasetSlug} (${bytes} bytes) to ${destFile}`);
      return {
        success: true,
        data: {
          ownerSlug,
          datasetSlug,
          file: destFile,
          bytes
        }
      };
    } catch (error) {
      await fs.promises.rm(destFile, { force: true }).catch(() => {});
      throw new Error(`Failed to download dataset: ${error.message}`);
    }
  }

  /**
   * Pipe a response stream to disk and resolve with the byte count actually written.
   * The running total is checked against the cap because content-length is absent on
   * a chunked response, which is exactly the case a size limit needs to cover.
   */
  _streamToFile(stream, destFile) {
    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(destFile);
      let bytes = 0;
      let aborted = false;

      const fail = (err) => {
        if (aborted) return;
        aborted = true;
        stream.destroy();
        writer.destroy();
        reject(err);
      };

      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > this.config.maxDownloadBytes) {
          fail(new Error(`archive exceeded the ${this.config.maxDownloadBytes} byte limit`));
        }
      });
      stream.on('error', fail);
      writer.on('error', fail);
      writer.on('finish', () => {
        if (!aborted) resolve(bytes);
      });

      stream.pipe(writer);
    });
  }

  async listCompetitions(params = {}) {
    const { category = 'all', group, sortBy, search, page = 1 } = params;

    this._requireCredentials();
    this._checkEnum('category', category, KagglePlugin.VALID_COMPETITION_CATEGORIES);
    this._checkEnum('group', group, KagglePlugin.VALID_COMPETITION_GROUPS);
    this._checkEnum('sortBy', sortBy, KagglePlugin.VALID_COMPETITION_SORT_BY);

    // Check cache first
    const cacheKey = `competitions_${category}_${group || ''}_${sortBy || ''}_${search || ''}_${page}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }

    try {
      const response = await retryOperation(() =>
        axios.get(
          `${this.config.baseUrl}/competitions/list`,
          {
            ...this._authConfig(),
            params: this._pruneParams({ category, group, sortBy, search, page })
          }
        ),
        { retries: 3, context: 'list competitions' }
      );

      // Cache the result
      this.cache.set(cacheKey, response.data);

      return { success: true, data: response.data };
    } catch (error) {
      throw new Error(`Failed to list competitions: ${error.message}`);
    }
  }

  async listKernels(params = {}) {
    const { search, page = 1, pageSize = 20, sortBy, user, language, kernelType } = params;

    this._requireCredentials();
    this._checkEnum('sortBy', sortBy, KagglePlugin.VALID_KERNEL_SORT_BY);

    // Check cache first
    const cacheKey = `kernels_${search || ''}_${page}_${pageSize}_${sortBy || ''}_${user || ''}_${language || ''}_${kernelType || ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: cached, fromCache: true };
    }

    try {
      // Kaggle spells the page size `pageSize` on this endpoint (and has no such
      // parameter at all on /datasets/list).
      const config = {
        ...this._authConfig(),
        params: this._pruneParams({ page, pageSize, search, sortBy, user, language, kernelType })
      };

      const response = await retryOperation(() =>
        axios.get(`${this.config.baseUrl}/kernels/list`, config),
        { retries: 3, context: 'list kernels' }
      );

      // Cache the result
      this.cache.set(cacheKey, response.data);

      return { success: true, data: response.data };
    } catch (error) {
      throw new Error(`Failed to list kernels: ${error.message}`);
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