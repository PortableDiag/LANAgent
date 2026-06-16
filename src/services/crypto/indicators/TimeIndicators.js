/**
 * Time Indicators
 *
 * Time and date-based indicators for rule-based strategies.
 */

export class TimeIndicators {
  constructor() {
    this.indicators = new Map();
    this.metadataMap = new Map();
    this.registerIndicators();
  }

  registerIndicators() {
    // Hour of day (UTC)
    this.register('hour_of_day', async () => {
      return new Date().getUTCHours();
    }, {
      type: 'number',
      description: 'Current hour (0-23, UTC)',
      category: 'time'
    });

    // Day of week
    this.register('day_of_week', async () => {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      return days[new Date().getUTCDay()];
    }, {
      type: 'string',
      description: 'Current day of week (lowercase)',
      category: 'time'
    });

    // Day of month
    this.register('day_of_month', async () => {
      return new Date().getUTCDate();
    }, {
      type: 'number',
      description: 'Day of month (1-31)',
      category: 'time'
    });

    // Month
    this.register('month', async () => {
      const months = ['january', 'february', 'march', 'april', 'may', 'june',
                      'july', 'august', 'september', 'october', 'november', 'december'];
      return months[new Date().getUTCMonth()];
    }, {
      type: 'string',
      description: 'Current month (lowercase)',
      category: 'time'
    });

    // Is weekend
    this.register('is_weekend', async () => {
      const day = new Date().getUTCDay();
      return day === 0 || day === 6;
    }, {
      type: 'boolean',
      description: 'True if Saturday or Sunday',
      category: 'time'
    });

    // Week of year
    this.register('week_of_year', async () => {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const diff = now - start;
      const oneWeek = 1000 * 60 * 60 * 24 * 7;
      return Math.ceil(diff / oneWeek);
    }, {
      type: 'number',
      description: 'Week number of the year (1-52)',
      category: 'time'
    });

    // Quarter
    this.register('quarter', async () => {
      return Math.ceil((new Date().getUTCMonth() + 1) / 3);
    }, {
      type: 'number',
      description: 'Current quarter (1-4)',
      category: 'time'
    });

    // Minutes since midnight
    this.register('minutes_since_midnight', async () => {
      const now = new Date();
      return now.getUTCHours() * 60 + now.getUTCMinutes();
    }, {
      type: 'number',
      description: 'Minutes since midnight UTC (0-1439)',
      category: 'time'
    });

    // Is market hours (9:30am-4pm ET, Mon-Fri) - DST aware
    this.register('is_us_market_hours', async () => {
      const now = new Date();
      const day = now.getUTCDay();
      if (day === 0 || day === 6) return false;

      // Use Intl to get actual Eastern Time hour/minute
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', hour12: false
      }).formatToParts(now);
      const etHour = parseInt(etParts.find(p => p.type === 'hour')?.value || '0');
      const etMinute = parseInt(etParts.find(p => p.type === 'minute')?.value || '0');
      const etTime = etHour * 60 + etMinute; // minutes since midnight ET

      // Market: 9:30 (570) to 16:00 (960) ET
      return etTime >= 570 && etTime < 960;
    }, {
      type: 'boolean',
      description: 'True during US market hours (9:30am-4pm ET, DST-aware)',
      category: 'time'
    });

    // Is Asian market hours
    this.register('is_asian_market_hours', async () => {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const day = now.getUTCDay();

      // Tokyo: 9:00-15:00 JST = 0:00-6:00 UTC
      if (day === 0 || day === 6) return false;
      return utcHour >= 0 && utcHour < 7;
    }, {
      type: 'boolean',
      description: 'True during Asian market hours (approximate)',
      category: 'time'
    });

    // ---- Internal helpers shared by composite indicators ----

    // Returns the extended-hours ET period string:
    // 'pre_market' | 'regular_market' | 'after_hours' | 'closed' | 'weekend'
    const computeExtendedMarketPeriod = () => {
      const now = new Date();
      const day = now.getUTCDay();
      if (day === 0 || day === 6) return 'weekend';

      // Use Intl to get actual Eastern Time hour/minute (DST-aware)
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', hour12: false
      }).formatToParts(now);
      const etHour = parseInt(etParts.find(p => p.type === 'hour')?.value || '0');
      const etMinute = parseInt(etParts.find(p => p.type === 'minute')?.value || '0');
      const etTime = etHour * 60 + etMinute; // minutes since midnight ET

      // Pre-market: 4:00 (240) to 9:30 (570) ET
      // Regular:    9:30 (570) to 16:00 (960) ET
      // After-hours:16:00 (960) to 20:00 (1200) ET
      if (etTime >= 240 && etTime < 570) return 'pre_market';
      if (etTime >= 570 && etTime < 960) return 'regular_market';
      if (etTime >= 960 && etTime < 1200) return 'after_hours';
      return 'closed';
    };

    // Returns the list of active global market names for "now"
    const computeActiveMarkets = () => {
      const now = new Date();
      const day = now.getUTCDay();
      if (day === 0 || day === 6) return [];

      const utcHour = now.getUTCHours();
      const markets = {
        asian: { active: utcHour >= 0 && utcHour < 7, name: 'Asian' },
        european: { active: utcHour >= 7 && utcHour < 15, name: 'European' },
        us: { active: utcHour >= 13 && utcHour < 21, name: 'US' } // 13:00-21:00 UTC covers NY open to after close
      };
      return Object.values(markets).filter(m => m.active).map(m => m.name);
    };

    // True during the approximate European/US overlap window (13:30-16:00 UTC)
    const computeEuropeanUsOverlap = () => {
      const now = new Date();
      const day = now.getUTCDay();
      if (day === 0 || day === 6) return false;
      const utcTime = now.getUTCHours() * 60 + now.getUTCMinutes();
      return utcTime >= 810 && utcTime < 960;
    };

    // Composite indicator: European market overlap with US market (object)
    this.register('is_european_market_overlap', async () => {
      const now = new Date();
      const day = now.getUTCDay();
      if (day === 0 || day === 6) return { status: 'closed', reason: 'weekend' };

      // London: 8:00-16:00 GMT/BST = varies in UTC
      // New York: 9:30-16:00 ET = varies in UTC
      // Overlap is roughly 13:30-16:00 UTC (varies with DST)

      const utcHour = now.getUTCHours();
      const utcMinute = now.getUTCMinutes();
      const utcTime = utcHour * 60 + utcMinute;

      // Approximate overlap window: 13:30-16:00 UTC (810-960 minutes since midnight)
      const isOverlap = utcTime >= 810 && utcTime < 960;

      return {
        status: isOverlap ? 'active' : 'inactive',
        us_market: utcTime >= 570 && utcTime < 960,
        european_market: utcTime >= 810 && utcTime < 960,
        current_utc: `${utcHour}:${utcMinute.toString().padStart(2, '0')}`,
        overlap_window: '13:30-16:00 UTC'
      };
    }, {
      type: 'object',
      description: 'European market overlap with US market hours',
      category: 'time',
      returns: {
        status: 'string', // 'active' or 'inactive'
        us_market: 'boolean',
        european_market: 'boolean',
        current_utc: 'string',
        overlap_window: 'string'
      }
    });

    // Composite indicator: Multi-market session status (object)
    this.register('multi_market_session_indicator', async () => {
      const now = new Date();
      const day = now.getUTCDay();
      if (day === 0 || day === 6) return { status: 'closed', active_markets: [], reason: 'weekend' };

      const activeMarkets = computeActiveMarkets();

      return {
        status: activeMarkets.length > 0 ? 'active' : 'inactive',
        active_markets: activeMarkets,
        total_active: activeMarkets.length,
        timestamp: now.toISOString()
      };
    }, {
      type: 'object',
      description: 'Shows which global markets are currently active',
      category: 'time',
      returns: {
        status: 'string', // 'active' or 'inactive'
        active_markets: 'array',
        total_active: 'number',
        timestamp: 'string'
      }
    });

    // Composite indicator: Extended market hours (object)
    this.register('extended_market_hours', async () => {
      const period = computeExtendedMarketPeriod();
      if (period === 'weekend') return { status: 'closed', period: 'weekend', reason: 'weekend' };

      const now = new Date();
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', hour12: false
      }).formatToParts(now);
      const etHour = parseInt(etParts.find(p => p.type === 'hour')?.value || '0');
      const etMinute = parseInt(etParts.find(p => p.type === 'minute')?.value || '0');

      return {
        status: period === 'closed' ? 'inactive' : 'active',
        period: period,
        current_et: `${etHour}:${etMinute.toString().padStart(2, '0')}`,
        regular_hours: '9:30-16:00 ET',
        pre_market: '4:00-9:30 ET',
        after_hours: '16:00-20:00 ET'
      };
    }, {
      type: 'object',
      description: 'Extended market hours indicator (pre-market, regular, after-hours)',
      category: 'time',
      returns: {
        status: 'string', // 'active' or 'inactive'
        period: 'string', // 'pre_market', 'regular_market', 'after_hours', or 'closed'
        current_et: 'string',
        regular_hours: 'string',
        pre_market: 'string',
        after_hours: 'string'
      }
    });

    // ---- Scalar companions (usable directly in rule conditions) ----
    // The object indicators above are inert in RuleBasedStrategy.evaluateSingleCondition,
    // which compares with scalar operators (equals/in/greaterThan/...). These expose the
    // useful fields as scalars so they can actually drive rules.

    // Scalar companion for extended_market_hours: the ET period as a string.
    // Use with equals/in, e.g. { indicator: 'extended_market_period', in: ['pre_market','after_hours'] }
    this.register('extended_market_period', async () => {
      return computeExtendedMarketPeriod();
    }, {
      type: 'string',
      description: "Extended-hours ET period: 'pre_market', 'regular_market', 'after_hours', 'closed', or 'weekend'",
      category: 'time'
    });

    // Scalar companion for multi_market_session_indicator: number of active global markets.
    // Use with greaterThan/equals, e.g. { indicator: 'active_market_count', greaterThan: 1 }
    this.register('active_market_count', async () => {
      return computeActiveMarkets().length;
    }, {
      type: 'number',
      description: 'Number of global markets (Asian/European/US) currently active (0-3)',
      category: 'time'
    });

    // Scalar companion for is_european_market_overlap: boolean overlap flag.
    // Use with equals, e.g. { indicator: 'is_european_us_overlap', equals: true }
    this.register('is_european_us_overlap', async () => {
      return computeEuropeanUsOverlap();
    }, {
      type: 'boolean',
      description: 'True during the approximate European/US market overlap (13:30-16:00 UTC, weekdays)',
      category: 'time'
    });
  }

  register(name, fn, metadata) {
    this.indicators.set(name, fn);
    this.metadataMap.set(name, metadata);
  }

  getIndicators() {
    return this.indicators;
  }

  getMetadata(name) {
    return this.metadataMap.get(name);
  }
}

export default TimeIndicators;
