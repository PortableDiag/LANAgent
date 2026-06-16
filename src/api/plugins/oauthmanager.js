import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import crypto from 'crypto';
import { retryOperation } from '../../utils/retryUtils.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { PluginSettings } from '../../models/PluginSettings.js';

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomString(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function sha256Base64Url(input) {
  const hash = crypto.createHash('sha256').update(input).digest();
  return base64url(hash);
}

function asUrlEncoded(obj) {
  const params = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null) params.append(k, Array.isArray(v) ? v.join(' ') : String(v));
  });
  return params.toString();
}

export default class OAuthManagerPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'oauthmanager';
    this.version = '1.0.0';
    this.description = 'Runtime OAuth flow management: generate auth URLs, exchange/refresh/revoke tokens, list providers';
    this.commands = [
      {
        command: 'getAuthUrl',
        description: 'Generate an OAuth authorization URL for a provider',
        usage: 'getAuthUrl [provider] [userId] (scopes?) (prompt?) (state?)',
        examples: ['getAuthUrl google alice', 'start oauth for github']
      },
      {
        command: 'exchangeCode',
        description: 'Exchange an authorization code for access/refresh tokens',
        usage: 'exchangeCode [provider] [userId] [code] [state]',
        examples: ['exchangeCode google alice abc123 state456']
      },
      {
        command: 'refreshToken',
        description: 'Refresh an access token using stored refresh token',
        usage: 'refreshToken [provider] [userId]',
        examples: ['refreshToken google alice', 'refresh my github token']
      },
      {
        command: 'getToken',
        description: 'Get a valid access token (auto-refresh if expired and refresh token available)',
        usage: 'getToken [provider] [userId]',
        examples: ['getToken google alice', 'what is my github access token']
      },
      {
        command: 'revoke',
        description: 'Revoke stored tokens for a provider and user (requires revokeUrl in provider config)',
        usage: 'revoke [provider] [userId]',
        examples: ['revoke google alice', 'revoke my github oauth']
      },
      {
        command: 'providers',
        description: 'List configured OAuth providers',
        usage: 'providers',
        examples: ['providers', 'list oauth providers']
      }
    ];

    // Caches:
    // - stateCache: ephemeral CSRF state + PKCE verifiers, 10 min TTL
    // - tokenStore: in-memory cache of decrypted tokens for hot path; persistent
    //   copies live in PluginSettings (encrypted at rest). The in-memory copy is
    //   warmed lazily on first access per (provider, userId).
    this.stateCache = new NodeCache({ stdTTL: 600, useClones: false });
    this.tokenStore = new NodeCache({ stdTTL: 0, useClones: false });

    // Only the providers.<name>.* entries are credential-bearing — getPluginConfig
    // already redacts them by key-name pattern, but be explicit about what's safe.
    this.safeConfigKeys = ['providerCount'];
  }

  async initialize() {
    const providers = this.agent?.serviceConfigs?.oauthmanager?.providers
      || this.agent?.config?.serviceConfigs?.oauthmanager?.providers
      || {};
    this.config = { providers, providerCount: Object.keys(providers).length };
    if (!this.config.providerCount) {
      this.logger.warn('oauthmanager: no providers configured at serviceConfigs.oauthmanager.providers');
    } else {
      this.logger.info(`oauthmanager: ${this.config.providerCount} provider(s) configured`);
    }
  }

  async execute(params = {}) {
    const { action, provider, userId, scopes, prompt, state, code } = params;
    try {
      switch (action) {
        case 'getAuthUrl':
          return await this.getAuthUrl(provider, userId, scopes, prompt, state);
        case 'exchangeCode':
          return await this.exchangeCode(provider, userId, code, state);
        case 'refreshToken':
          return await this.refreshTokenAction(provider, userId);
        case 'getToken':
          return await this.getToken(provider, userId);
        case 'revoke':
          return await this.revoke(provider, userId);
        case 'providers':
          return this.listProviders();
        case 'getPluginConfig':
          return this.getPluginConfig();
        default:
          return { success: false, error: 'Unknown action. See this.commands for supported actions.' };
      }
    } catch (err) {
      const details = err?.response?.data || err?.data;
      this.logger.error(`oauthmanager error: ${err?.message}`, details || '');
      return { success: false, error: err?.message || 'Unhandled error', details };
    }
  }

  listProviders() {
    return { success: true, providers: Object.keys(this.config?.providers || {}) };
  }

  getProviderConfig(name) {
    const cfg = this.config?.providers?.[name];
    if (!cfg) {
      throw new Error(`Provider '${name}' is not configured. Add it under serviceConfigs.oauthmanager.providers`);
    }
    const required = ['clientId', 'authUrl', 'tokenUrl', 'redirectUri'];
    const missing = required.filter((k) => !cfg[k]);
    if (missing.length) {
      throw new Error(`Provider '${name}' missing required fields: ${missing.join(', ')}`);
    }
    return cfg;
  }

  tokenKey(provider, userId) {
    return `${provider}:${userId || 'default'}`;
  }

  settingsKey(provider, userId) {
    return `tokens:${provider}:${userId || 'default'}`;
  }

  async loadTokensFromDb(provider, userId) {
    try {
      const value = await PluginSettings.getCached(this.name, this.settingsKey(provider, userId));
      if (!value?.encrypted) return null;
      const decrypted = decrypt(value.encrypted);
      return JSON.parse(decrypted);
    } catch (err) {
      this.logger.warn(`oauthmanager: failed to load persisted tokens for ${provider}:${userId || 'default'}: ${err.message}`);
      return null;
    }
  }

  async saveTokensToDb(provider, userId, payload) {
    try {
      const encrypted = encrypt(JSON.stringify(payload));
      await PluginSettings.setCached(this.name, this.settingsKey(provider, userId), { encrypted });
    } catch (err) {
      this.logger.error(`oauthmanager: failed to persist tokens for ${provider}:${userId || 'default'}: ${err.message}`);
    }
  }

  async deleteTokensFromDb(provider, userId) {
    try {
      await PluginSettings.deleteOne({
        pluginName: this.name,
        settingsKey: this.settingsKey(provider, userId)
      });
    } catch (err) {
      this.logger.warn(`oauthmanager: failed to delete persisted tokens for ${provider}:${userId || 'default'}: ${err.message}`);
    }
  }

  async getStoredTokens(provider, userId) {
    const key = this.tokenKey(provider, userId);
    const cached = this.tokenStore.get(key);
    if (cached) return cached;
    const fromDb = await this.loadTokensFromDb(provider, userId);
    if (fromDb) this.tokenStore.set(key, fromDb);
    return fromDb;
  }

  async setStoredTokens(provider, userId, payload) {
    this.tokenStore.set(this.tokenKey(provider, userId), payload);
    await this.saveTokensToDb(provider, userId, payload);
  }

  async clearStoredTokens(provider, userId) {
    this.tokenStore.del(this.tokenKey(provider, userId));
    await this.deleteTokensFromDb(provider, userId);
  }

  async getAuthUrl(provider, userId, scopes, promptParam, incomingState) {
    if (!provider) throw new Error('provider is required');
    const cfg = this.getProviderConfig(provider);

    const scopeList = Array.isArray(scopes)
      ? scopes
      : scopes
      ? String(scopes).split(/[,\s]+/).filter(Boolean)
      : Array.isArray(cfg.scopes)
      ? cfg.scopes
      : (cfg.scopes || '').split(/[,\s]+/).filter(Boolean);

    const stateValue = incomingState || randomString(24);
    const usePkce = !!cfg.pkce;
    let codeChallenge;
    if (usePkce) {
      const codeVerifier = randomString(48);
      codeChallenge = sha256Base64Url(codeVerifier);
      this.stateCache.set(`pkce:${stateValue}`, { provider, userId, codeVerifier }, 600);
    }

    this.stateCache.set(`state:${stateValue}`, { provider, userId, ts: Date.now() }, 600);

    const baseParams = {
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: scopeList.length ? scopeList.join(' ') : undefined,
      state: stateValue,
      prompt: promptParam || cfg.prompt
    };

    if (usePkce) {
      baseParams.code_challenge = codeChallenge;
      baseParams.code_challenge_method = 'S256';
    }

    const extra = cfg.extraAuthParams || {};
    const query = asUrlEncoded({ ...extra, ...baseParams });
    const separator = cfg.authUrl.includes('?') ? '&' : '?';
    const url = `${cfg.authUrl}${separator}${query}`;

    this.logger.info(`oauthmanager: generated auth URL for provider=${provider}, user=${userId || 'default'}`);
    return { success: true, provider, userId: userId || 'default', url, state: stateValue, pkce: usePkce, scopes: scopeList };
  }

  async exchangeCode(provider, userId, code, stateValue) {
    if (!provider) throw new Error('provider is required');
    if (!code) throw new Error('code is required');
    if (!stateValue) throw new Error('state is required');
    const cfg = this.getProviderConfig(provider);

    const stateRecord = this.stateCache.get(`state:${stateValue}`);
    if (!stateRecord || stateRecord.provider !== provider || (userId && stateRecord.userId !== userId)) {
      throw new Error('Invalid or expired OAuth state');
    }
    this.stateCache.del(`state:${stateValue}`);

    const pkceRecord = this.stateCache.get(`pkce:${stateValue}`);
    if (cfg.pkce && !pkceRecord) {
      throw new Error('PKCE verifier not found or expired for this state');
    }

    const useBasicAuth = cfg.tokenAuthMethod === 'basic';
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (useBasicAuth) {
      if (!cfg.clientSecret) throw new Error('clientSecret required for basic token auth');
      const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
      headers.Authorization = `Basic ${creds}`;
    }

    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri
    };

    if (!useBasicAuth) {
      body.client_id = cfg.clientId;
      if (cfg.clientSecret && !cfg.pkce) {
        body.client_secret = cfg.clientSecret;
      }
    }

    if (cfg.pkce && pkceRecord?.codeVerifier) {
      body.code_verifier = pkceRecord.codeVerifier;
      this.stateCache.del(`pkce:${stateValue}`);
    }

    const resp = await retryOperation(() =>
      axios.post(cfg.tokenUrl, asUrlEncoded(body), { headers })
    );

    const data = resp?.data || {};
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = Number(data.expires_in) || 3600;
    const expiresAt = now + expiresIn;

    const tokenPayload = {
      provider,
      userId: userId || 'default',
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope,
      expiresAt,
      obtainedAt: now
    };

    await this.setStoredTokens(provider, userId, tokenPayload);
    this.logger.info(`oauthmanager: exchanged code and stored tokens for provider=${provider}, user=${userId || 'default'}`);

    return {
      success: true,
      provider,
      userId: userId || 'default',
      accessToken: tokenPayload.accessToken,
      tokenType: tokenPayload.tokenType,
      scope: tokenPayload.scope,
      expiresAt
    };
  }

  async refreshTokenAction(provider, userId) {
    if (!provider) throw new Error('provider is required');
    const cfg = this.getProviderConfig(provider);

    const existing = await this.getStoredTokens(provider, userId);
    if (!existing?.refreshToken) {
      throw new Error('No refresh token available. Re-authentication required.');
    }

    const useBasicAuth = cfg.tokenAuthMethod === 'basic';
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (useBasicAuth) {
      if (!cfg.clientSecret) throw new Error('clientSecret required for basic token auth');
      const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
      headers.Authorization = `Basic ${creds}`;
    }

    const body = {
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken
    };

    if (!useBasicAuth) {
      body.client_id = cfg.clientId;
      if (cfg.clientSecret && !cfg.pkce) {
        body.client_secret = cfg.clientSecret;
      }
    }

    const resp = await retryOperation(() =>
      axios.post(cfg.tokenUrl, asUrlEncoded(body), { headers })
    );
    const data = resp?.data || {};
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = Number(data.expires_in) || 3600;
    const expiresAt = now + expiresIn;

    const updated = {
      ...existing,
      accessToken: data.access_token || existing.accessToken,
      refreshToken: data.refresh_token || existing.refreshToken,
      tokenType: data.token_type || existing.tokenType || 'Bearer',
      scope: data.scope || existing.scope,
      expiresAt,
      obtainedAt: now
    };

    await this.setStoredTokens(provider, userId, updated);
    this.logger.info(`oauthmanager: refreshed token for provider=${provider}, user=${userId || 'default'}`);

    return {
      success: true,
      provider,
      userId: userId || 'default',
      accessToken: updated.accessToken,
      tokenType: updated.tokenType,
      scope: updated.scope,
      expiresAt
    };
  }

  async getToken(provider, userId) {
    if (!provider) throw new Error('provider is required');
    this.getProviderConfig(provider);

    const record = await this.getStoredTokens(provider, userId);
    if (!record) {
      return { success: false, error: 'No token found. Initiate OAuth flow first.' };
    }

    const now = Math.floor(Date.now() / 1000);
    const isExpired = !record.expiresAt || record.expiresAt - now <= 30;
    if (isExpired && record.refreshToken) {
      try {
        const refreshed = await this.refreshTokenAction(provider, userId);
        return { ...refreshed, refreshed: true };
      } catch (e) {
        this.logger.warn(`oauthmanager: auto-refresh failed for provider=${provider}, user=${userId || 'default'}: ${e.message}`);
        return { success: false, error: `Token expired and refresh failed: ${e.message}` };
      }
    }

    return {
      success: true,
      provider,
      userId: userId || 'default',
      accessToken: record.accessToken,
      tokenType: record.tokenType || 'Bearer',
      scope: record.scope,
      expiresAt: record.expiresAt,
      refreshed: false
    };
  }

  async revoke(provider, userId) {
    if (!provider) throw new Error('provider is required');
    const cfg = this.getProviderConfig(provider);

    const record = await this.getStoredTokens(provider, userId);
    if (!record) {
      return { success: true, message: 'No tokens stored for this user/provider' };
    }

    if (cfg.revokeUrl) {
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      const useBasicAuth = cfg.tokenAuthMethod === 'basic';
      if (useBasicAuth) {
        if (!cfg.clientSecret) throw new Error('clientSecret required for basic token auth');
        const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
        headers.Authorization = `Basic ${creds}`;
      }

      const tokenToRevoke = record.refreshToken || record.accessToken;
      const body = {
        token: tokenToRevoke,
        token_type_hint: record.refreshToken ? 'refresh_token' : 'access_token'
      };

      if (!useBasicAuth) {
        body.client_id = cfg.clientId;
        if (cfg.clientSecret) {
          body.client_secret = cfg.clientSecret;
        }
      }

      await retryOperation(() =>
        axios.post(cfg.revokeUrl, asUrlEncoded(body), { headers })
      ).catch((err) => {
        this.logger.warn(`oauthmanager: revoke call failed (will still drop local tokens): ${err.message}`);
      });
    } else {
      this.logger.info(`oauthmanager: no revokeUrl for provider=${provider}; dropping local tokens only`);
    }

    await this.clearStoredTokens(provider, userId);
    this.logger.info(`oauthmanager: revoked tokens and cleared store for provider=${provider}, user=${userId || 'default'}`);
    return { success: true, provider, userId: userId || 'default', message: 'Tokens revoked' };
  }
}
