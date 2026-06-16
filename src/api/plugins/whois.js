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
      },
      {
        command: 'bulkLookup',
        description: 'Perform WHOIS lookups for multiple domains at once (max 20)',
        usage: 'bulkLookup({ domains: ["example.com", "test.org"] })'
      },
      {
        command: 'setExpirationAlert',
        description: 'Schedule a notification N days before a domain expires',
        usage: 'setExpirationAlert({ domain: "example.com", daysBefore: 30 })'
      },
      {
        command: 'cancelExpirationAlert',
        description: 'Cancel any pending expiration alerts for a domain',
        usage: 'cancelExpirationAlert({ domain: "example.com" })'
      }
    ];

    // Initialize whoisjson - will be imported dynamically
    this.whoisjson = null;
    this.apiKey = process.env.WHOISJSON_API_KEY;
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL for WHOIS data
    this.scheduler = this.agent?.services?.get('taskScheduler');

    if (this.scheduler?.agenda) {
      this.scheduler.agenda.define('whois-expiration-alert', async (job) => {
        const { domain, expiresAt, daysBefore } = job.attrs.data || {};
        const message = `🔔 Domain expiration warning: ${domain} expires on ${expiresAt} (~${daysBefore} days from this alert).`;
        try {
          if (this.agent?.notify) {
            await this.agent.notify(message);
          } else {
            logger.warn(`whois-expiration-alert fired but agent.notify is not available — ${message}`);
          }
        } catch (error) {
          logger.error('Failed to dispatch whois-expiration-alert:', error.message);
        }
      });
    }
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
    const { action, domain, daysBefore } = params;

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
        case 'bulkLookup':
          return await this.bulkLookup(params);
        case 'setExpirationAlert':
          return await this.setExpirationAlert(domain, daysBefore);
        case 'cancelExpirationAlert':
          return await this.cancelExpirationAlert(domain);
        default:
          return { success: false, error: 'Unknown action. Use: lookup, dns, ssl, availability, bulkLookup, setExpirationAlert, or cancelExpirationAlert' };
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

  async bulkLookup({ domains }) {
    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return { success: false, error: 'domains array is required' };
    }
    if (domains.length > 20) {
      return { success: false, error: 'Maximum 20 domains per bulk lookup' };
    }

    const results = [];
    // Process in chunks of 5 to avoid API rate limits
    const CHUNK_SIZE = 5;
    for (let i = 0; i < domains.length; i += CHUNK_SIZE) {
      const chunk = domains.slice(i, i + CHUNK_SIZE);
      const chunkResults = await Promise.allSettled(
        chunk.map(d => this.lookupDomain(d))
      );
      for (let j = 0; j < chunk.length; j++) {
        const r = chunkResults[j];
        results.push({
          domain: chunk[j],
          ...(r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message || 'Lookup failed' })
        });
      }
    }

    return {
      success: true,
      data: {
        total: domains.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      },
      message: `Bulk WHOIS lookup completed for ${domains.length} domains`
    };
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

  /**
   * Schedule a one-shot Agenda job that fires N days before the domain's
   * registered expiration date (read from WHOIS). Persisted via Agenda's
   * MongoDB store, so alerts survive restarts.
   */
  async setExpirationAlert(domain, daysBefore) {
    this.validateParams({ domain, daysBefore }, {
      domain: { required: true, type: 'string' },
      daysBefore: { required: true, type: 'number' }
    });

    if (!this.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available — cannot persist alert' };
    }

    const whoisResult = await this.lookupDomain(domain);
    if (!whoisResult.success || !whoisResult.data?.expires) {
      return { success: false, error: `Failed to read expiration date for ${domain}: ${whoisResult.error || 'no expires field in WHOIS data'}` };
    }

    const expirationDate = new Date(whoisResult.data.expires);
    if (isNaN(expirationDate.getTime())) {
      return { success: false, error: `WHOIS expires field is not a valid date: ${whoisResult.data.expires}` };
    }

    const alertDate = new Date(expirationDate.getTime() - daysBefore * 24 * 60 * 60 * 1000);
    if (alertDate <= new Date()) {
      return { success: false, error: 'Alert date is in the past. Choose a smaller daysBefore or this domain is already too close to expiry.' };
    }

    // Cancel any existing alert for this domain to avoid duplicates
    await this.scheduler.agenda.cancel({ name: 'whois-expiration-alert', 'data.domain': domain });

    await this.scheduler.agenda.schedule(alertDate, 'whois-expiration-alert', {
      domain,
      expiresAt: expirationDate.toISOString(),
      daysBefore
    });

    return {
      success: true,
      message: `Expiration alert scheduled for ${domain} at ${alertDate.toISOString()} (${daysBefore} days before ${expirationDate.toISOString()}).`
    };
  }

  async cancelExpirationAlert(domain) {
    this.validateParams({ domain }, { domain: { required: true, type: 'string' } });
    if (!this.scheduler?.agenda) {
      return { success: false, error: 'Scheduler not available' };
    }
    const cancelled = await this.scheduler.agenda.cancel({ name: 'whois-expiration-alert', 'data.domain': domain });
    return { success: true, cancelled, message: `Cancelled ${cancelled || 0} alert(s) for ${domain}` };
  }
}