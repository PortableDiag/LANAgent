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
