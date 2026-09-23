import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export default class NumverifyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'numverify';
    this.version = '1.0.0';
    this.description = 'Global Phone Number Validation & Lookup';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'NUMVERIFY_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'validatePhoneNumber',
        description: 'Validate a phone number and retrieve its details',
        usage: 'validatePhoneNumber({ number: "+14158586273" })',
        examples: [
          'validate the phone number +14158586273',
          'check if +447911123456 is a valid phone number',
          'get details for the number +33123456789'
        ]
      },
      {
        command: 'getCarrierInfo',
        description: 'Retrieve carrier information for a phone number',
        usage: 'getCarrierInfo({ number: "+14158586273" })',
        examples: [
          'find the carrier for +14158586273',
          'what is the carrier for +4915123456789',
          'get carrier details of +33123456789'
        ]
      },
      {
        command: 'batchValidatePhoneNumbers',
        description: 'Validate multiple phone numbers in a single batch operation (max 50)',
        usage: 'batchValidatePhoneNumbers({ numbers: ["+14158586273", "+447911123456"] })',
        examples: [
          'validate these phone numbers: +14158586273, +447911123456',
          'batch validate +33123456789 and +4915123456789'
        ]
      },
      {
        command: 'convertPhoneNumberFormat',
        description: 'Convert a phone number to a specified format',
        usage: 'convertPhoneNumberFormat({ number: "+14158586273", format: "E.164" })',
        examples: [
          'convert +14158586273 to E.164 format',
          'convert +447911123456 to national format',
          'convert +33123456789 to international format'
        ]
      },
      {
        command: 'detectPhoneNumberRegion',
        description: 'Detect the region of a given phone number',
        usage: 'detectPhoneNumberRegion({ number: "+14158586273" })',
        examples: [
          'detect the region for +14158586273',
          'find out the region of +447911123456',
          'get the region for +33123456789'
        ]
      },
      {
        command: 'assessPhoneNumberRisk',
        description: 'Assess the risk level of a phone number based on validity, carrier type, and region consistency',
        usage: 'assessPhoneNumberRisk({ number: "+14158586273" })',
        examples: [
          'assess risk for phone number +14158586273',
          'check fraud risk of +447911123456',
          'evaluate risk level of +33123456789'
        ]
      }
    ];

    this.config = {
      apiKey: null,
      baseUrl: 'http://apilayer.net/api/validate'
    };

    this.initialized = false;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL for phone validation results
  }

  /**
   * Get cached data or fetch and cache it
   */
  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.logger.debug(`Cache hit for ${key}`);
      return cached;
    }
    const data = await fetchFunc();
    // Never cache a failure. A bad access key or an exhausted quota used to be
    // stored like a real answer and served for the full TTL, so one bad response
    // poisoned every lookup of that number for five minutes.
    if (data?.success !== false) this.cache.set(key, data);
    return data;
  }

  /**
   * numverify answers an API error with HTTP 200 and `{success:false, error:{code, info}}`,
   * so axios never rejects and the envelope reads like data. Returns the vendor's own
   * message when the payload is an error, otherwise null.
   */
  _vendorError(payload) {
    if (payload && payload.success === false) {
      const info = payload.error?.info || payload.error?.type || 'unknown error';
      const code = payload.error?.code;
      return code ? `numverify error ${code}: ${info}` : `numverify error: ${info}`;
    }
    return null;
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.config.apiKey = credentials.apiKey;
      this.logger.info('Loaded API credentials');

      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        const { apiKey, ...otherConfig } = savedConfig;
        Object.assign(this.config, otherConfig);
        this.logger.info('Loaded cached configuration');
      }

      if (!this.config.apiKey) {
        this.logger.warn('API key not configured - plugin will have limited functionality');
      }

      const { apiKey, ...configToCache } = this.config;
      await PluginSettings.setCached(this.name, 'config', configToCache);

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
        case 'validatePhoneNumber':
          return await this.validatePhoneNumber(data);

        case 'batchValidatePhoneNumbers':
          return await this.batchValidatePhoneNumbers(data);

        case 'getCarrierInfo':
          return await this.getCarrierInfo(data);

        case 'convertPhoneNumberFormat':
          return await this.convertPhoneNumberFormat(data);

        case 'detectPhoneNumberRegion':
          return await this.detectPhoneNumberRegion(data);

        case 'assessPhoneNumberRisk':
          return await this.assessPhoneNumberRisk(data);

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

    const parsed = safeJsonParse(response.content, {});
    if (!parsed || Object.keys(parsed).length === 0) {
      this.logger.warn('Failed to parse AI parameters from response');
    }
    return parsed;
  }

  async validatePhoneNumber({ number }) {
    const cacheKey = `validate:${number}`;
    return await this.getCachedData(cacheKey, async () => {
      try {
        const response = await retryOperation(() =>
          axios.get(this.config.baseUrl, {
            params: {
              access_key: this.config.apiKey,
              number
            }
          }), { retries: 3, context: 'validatePhoneNumber API call' });

        const vendorError = this._vendorError(response.data);
        if (vendorError) {
          this.logger.error(`validatePhoneNumber rejected by numverify: ${vendorError}`);
          return { success: false, error: vendorError };
        }
        return { success: true, data: response.data };
      } catch (error) {
        this.logger.error('validatePhoneNumber failed:', error);
        return { success: false, error: 'Failed to validate phone number' };
      }
    });
  }

  async getCarrierInfo({ number }) {
    const cacheKey = `carrier:${number}`;
    return await this.getCachedData(cacheKey, async () => {
      try {
        const response = await retryOperation(() =>
          axios.get(this.config.baseUrl, {
            params: {
              access_key: this.config.apiKey,
              number
            }
          }), { retries: 3, context: 'getCarrierInfo API call' });

        const vendorError = this._vendorError(response.data);
        if (vendorError) {
          this.logger.error(`getCarrierInfo rejected by numverify: ${vendorError}`);
          return { success: false, error: vendorError };
        }
        const { carrier, line_type } = response.data;
        return { success: true, data: { carrier, line_type } };
      } catch (error) {
        this.logger.error('getCarrierInfo failed:', error);
        return { success: false, error: 'Failed to retrieve carrier information' };
      }
    });
  }

  async convertPhoneNumberFormat({ number, format }) {
    try {
      const phoneNumber = parsePhoneNumberFromString(number);
      if (!phoneNumber) {
        throw new Error('Invalid phone number');
      }

      let formattedNumber;
      switch (format.toLowerCase()) {
        case 'e.164':
          formattedNumber = phoneNumber.format('E.164');
          break;
        case 'national':
          formattedNumber = phoneNumber.format('NATIONAL');
          break;
        case 'international':
          formattedNumber = phoneNumber.format('INTERNATIONAL');
          break;
        default:
          throw new Error(`Unsupported format: ${format}`);
      }

      return { success: true, data: { formattedNumber } };
    } catch (error) {
      this.logger.error('convertPhoneNumberFormat failed:', error);
      return { success: false, error: error.message };
    }
  }

  async batchValidatePhoneNumbers({ numbers }) {
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return { success: false, error: 'numbers must be a non-empty array' };
    }
    if (numbers.length > 50) {
      return { success: false, error: `Too many numbers (${numbers.length}). Maximum is 50 per batch.` };
    }

    const BATCH_SIZE = 10;
    const results = [];

    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
      const chunk = numbers.slice(i, i + BATCH_SIZE);
      const chunkResults = await Promise.all(
        chunk.map(async (number) => {
          const result = await this.validatePhoneNumber({ number });
          return { number, ...result };
        })
      );
      results.push(...chunkResults);

      // Brief delay between batches to avoid API rate limits
      if (i + BATCH_SIZE < numbers.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    return {
      success: true,
      data: {
        total: results.length,
        successCount,
        failureCount,
        results
      }
    };
  }

  async detectPhoneNumberRegion({ number }) {
    try {
      const phoneNumber = parsePhoneNumberFromString(number);
      if (!phoneNumber) {
        throw new Error('Invalid phone number');
      }

      const region = phoneNumber.country || 'Unknown';
      return { success: true, data: { region } };
    } catch (error) {
      this.logger.error('detectPhoneNumberRegion failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Assess the risk level of a phone number from its validation record.
   *
   * Scoring is advisory only: it is derived entirely from the numverify
   * lookup plus a local libphonenumber parse. It makes no external call of
   * its own, so it costs one cached validatePhoneNumber lookup.
   */
  async assessPhoneNumberRisk({ number }) {
    try {
      const validationResponse = await this.validatePhoneNumber({ number });

      // numverify answers API-level failures with HTTP 200 and an error
      // envelope, so a truthy transport result is not proof of a lookup.
      const payload = validationResponse && validationResponse.data;
      const lookupFailed =
        !validationResponse ||
        validationResponse.success !== true ||
        !payload ||
        payload.success === false ||
        payload.error;

      if (lookupFailed) {
        const reason =
          (payload && payload.error && (payload.error.info || payload.error.type)) ||
          (validationResponse && validationResponse.error) ||
          'lookup unavailable';
        return {
          success: false,
          error: `Failed to validate phone number: ${reason}`,
          data: {
            riskScore: null,
            riskLevel: 'unknown',
            factors: ['validation_unavailable']
          }
        };
      }

      const { valid, carrier, country_code: countryCode, line_type: lineType } = payload;

      let riskScore = 0;
      const riskFactors = [];

      if (!valid) {
        riskScore += 40;
        riskFactors.push('invalid_number');
      }

      if (!carrier) {
        riskScore += 20;
        riskFactors.push('missing_carrier_info');
      }

      // numverify line_type values: landline, mobile, special_services,
      // toll_free, premium_rate, satellite, paging, voip. There is no
      // "prepaid" value, so do not test for one.
      const normalizedLineType = typeof lineType === 'string' ? lineType.toLowerCase() : '';

      if (normalizedLineType === 'voip') {
        riskScore += 25;
        riskFactors.push('voip_line');
      }

      if (normalizedLineType === 'premium_rate') {
        riskScore += 25;
        riskFactors.push('premium_rate_line');
      }

      if (!normalizedLineType) {
        riskScore += 10;
        riskFactors.push('unknown_line_type');
      }

      const phoneNumber = parsePhoneNumberFromString(number);
      if (phoneNumber) {
        // numverify country_code and libphonenumber country are both ISO 3166-1
        // alpha-2, so they are directly comparable once cased alike.
        const reportedCountry = typeof countryCode === 'string' ? countryCode.toUpperCase() : '';
        if (reportedCountry && phoneNumber.country && reportedCountry !== phoneNumber.country) {
          riskScore += 30;
          riskFactors.push('inconsistent_region');
        }

        // Dialable shape but not an allocated number for that country.
        if (phoneNumber.isPossible() && !phoneNumber.isValid()) {
          riskScore += 25;
          riskFactors.push('possible_but_invalid');
        }
      } else {
        riskScore += 35;
        riskFactors.push('unparseable_number');
      }

      let riskLevel;
      if (riskScore >= 70) {
        riskLevel = 'high';
      } else if (riskScore >= 40) {
        riskLevel = 'medium';
      } else if (riskScore >= 10) {
        riskLevel = 'low';
      } else {
        riskLevel = 'minimal';
      }

      return {
        success: true,
        data: {
          riskScore,
          riskLevel,
          factors: riskFactors,
          validated: valid === true,
          carrier: carrier || 'Unknown',
          lineType: lineType || 'Unknown',
          countryCode: countryCode || 'Unknown'
        }
      };
    } catch (error) {
      this.logger.error('assessPhoneNumberRisk failed:', error);
      return {
        success: false,
        error: error.message,
        data: {
          riskScore: null,
          riskLevel: 'unknown',
          factors: ['internal_error']
        }
      };
    }
  }

  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
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
