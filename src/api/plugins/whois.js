import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import NodeCache from 'node-cache';

export default class WhoisPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'whois';
    this.version = '1.0.0';
    this.description = 'Domain WHOIS lookup using WhoisJSON API';
    this.commands = [
      {
        command: 'lookup',
        description: 'Get WHOIS information for a domain',
        usage: 'lookup [domain]'
      },
      {
        command: 'dns',
        description: 'Get DNS records for a domain',
        usage: 'dns [domain]'
      },
      {
        command: 'ssl',
        description: 'Get SSL certificate information for a domain',
        usage: 'ssl [domain]'
      },
      {
        command: 'availability',
        description: 'Check if a domain is available for registration',
        usage: 'availability [domain]'
      }
    ];
    
    // Initialize whoisjson - will be imported dynamically
    this.whoisjson = null;
    this.apiKey = process.env.WHOISJSON_API_KEY;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL for WHOIS data
  }

  /**
   * Get cached data or fetch and cache it
   */
  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      logger.debug(`Cache hit for ${key}`);
      return cached;
    }
    const data = await fetchFunc();
    this.cache.set(key, data);
    return data;
  }

  async initialize() {
    try {
      if (!this.apiKey) {
        throw new Error('Missing required credentials: WHOISJSON_API_KEY environment variable not set');
      }
      
      const { WhoisJson } = await import('@whoisjson/whoisjson');
      this.whoisjson = new WhoisJson({
        apiKey: this.apiKey
      });
      logger.info('WhoisJSON initialized successfully');
    } catch (error) {
      throw error;
    }
  }

  async execute(params) {
    const { action, domain } = params;
    
    if (!this.whoisjson) {
      await this.initialize();
    }
    
    try {
      switch (action) {
        case 'lookup':
          return await this.lookupDomain(domain);
        case 'dns':
          return await this.getDnsRecords(domain);
        case 'ssl':
          return await this.getSslInfo(domain);
        case 'availability':
          return await this.checkAvailability(domain);
        default:
          return { success: false, error: 'Unknown action. Use: lookup, dns, ssl, or availability' };
      }
    } catch (error) {
      logger.error('Whois plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async lookupDomain(domain) {
    this.validateParams({ domain }, {
      domain: { required: true, type: 'string' }
    });

    const cacheKey = `whois:${domain}`;
    return await this.getCachedData(cacheKey, async () => {
      try {
        logger.info(`Performing WHOIS lookup for domain: ${domain}`);
        const result = await this.whoisjson.lookup(domain);

        return {
          success: true,
          data: {
            domain: result.name,
            status: result.status,
            nameservers: result.nameserver,
            created: result.created,
            changed: result.changed,
            expires: result.expires,
            registered: result.registered,
            dnssec: result.dnssec,
            registrar: result.registrar,
            contacts: result.contacts,
            ips: result.ips
          },
          message: `WHOIS information retrieved for ${domain}`
        };
      } catch (error) {
        logger.error('Error looking up domain:', error);
        return { success: false, error: `Failed to lookup domain: ${error.message}` };
      }
    });
  }

  async getDnsRecords(domain) {
    this.validateParams({ domain }, {
      domain: { required: true, type: 'string' }
    });

    const cacheKey = `dns:${domain}`;
    return await this.getCachedData(cacheKey, async () => {
      try {
        logger.info(`Getting DNS records for domain: ${domain}`);
        const result = await this.whoisjson.nslookup(domain);

        return {
          success: true,
          data: {
            domain: result.domain,
            records: result.records
          },
          message: `DNS records retrieved for ${domain}`
        };
      } catch (error) {
        logger.error('Error getting DNS records:', error);
        return { success: false, error: `Failed to get DNS records: ${error.message}` };
      }
    });
  }

  async getSslInfo(domain) {
    this.validateParams({ domain }, {
      domain: { required: true, type: 'string' }
    });

    const cacheKey = `ssl:${domain}`;
    return await this.getCachedData(cacheKey, async () => {
      try {
        logger.info(`Getting SSL certificate information for domain: ${domain}`);
        const result = await this.whoisjson.ssl(domain);

        return {
          success: true,
          data: {
            domain: result.domain,
            valid: result.valid,
            issuer: result.issuer,
            subject: result.subject,
            validFrom: result.validFrom,
            validTo: result.validTo,
            serialNumber: result.serialNumber,
            version: result.version,
            signatureAlgorithm: result.signatureAlgorithm,
            subjectAlternativeNames: result.subjectAlternativeNames
          },
          message: `SSL certificate information retrieved for ${domain}`
        };
      } catch (error) {
        logger.error('Error getting SSL certificate info:', error);
        return { success: false, error: `Failed to get SSL certificate info: ${error.message}` };
      }
    });
  }

  async checkAvailability(domain) {
    this.validateParams({ domain }, {
      domain: { required: true, type: 'string' }
    });

    const cacheKey = `availability:${domain}`;
    return await this.getCachedData(cacheKey, async () => {
      try {
        logger.info(`Checking availability for domain: ${domain}`);
        const result = await this.whoisjson.checkDomainAvailability(domain);

        return {
          success: true,
          data: {
            domain: result.domain,
            available: result.available
          },
          message: result.available ? `${domain} is available for registration` : `${domain} is already registered`
        };
      } catch (error) {
        logger.error('Error checking domain availability:', error);
        return { success: false, error: `Failed to check availability: ${error.message}` };
      }
    });
  }
}