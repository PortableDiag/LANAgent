/**
 * Moon Indicators
 *
 * Lunar phase indicators for rule-based strategies.
 * Based on astronomical calculations for moon phase.
 */

export class MoonIndicators {
  constructor() {
    this.indicators = new Map();
    this.metadataMap = new Map();
    this.registerIndicators();
  }

  /**
   * Calculate moon phase for a given date
   */
  calculateMoonPhase(date = new Date()) {
    // Lunar cycle is approximately 29.53 days
    const LUNAR_CYCLE = 29.53058867;

    // Known new moon date (reference point)
    const KNOWN_NEW_MOON = new Date('2000-01-06T18:14:00Z');

    // Calculate days since known new moon
    const daysSinceKnown = (date - KNOWN_NEW_MOON) / (1000 * 60 * 60 * 24);

    // Get position in current cycle (0 to 1)
    const cyclePosition = ((daysSinceKnown % LUNAR_CYCLE) + LUNAR_CYCLE) % LUNAR_CYCLE / LUNAR_CYCLE;

    // Calculate illumination (0 to 100%)
    const illumination = Math.round((1 - Math.cos(cyclePosition * 2 * Math.PI)) / 2 * 100);

    // Determine phase name
    const phases = [
      { name: 'new', min: 0, max: 0.0625 },
      { name: 'waxing_crescent', min: 0.0625, max: 0.1875 },
      { name: 'first_quarter', min: 0.1875, max: 0.3125 },
      { name: 'waxing_gibbous', min: 0.3125, max: 0.4375 },
      { name: 'full', min: 0.4375, max: 0.5625 },
      { name: 'waning_gibbous', min: 0.5625, max: 0.6875 },
      { name: 'last_quarter', min: 0.6875, max: 0.8125 },
      { name: 'waning_crescent', min: 0.8125, max: 1.0001 } // Slight buffer for floating point
    ];

    const phase = phases.find(p => cyclePosition >= p.min && cyclePosition < p.max) || phases[0];

    // Calculate days until/since full moon
    let daysUntilFull, daysSinceFull;

    if (cyclePosition < 0.5) {
      // Before full moon
      daysUntilFull = Math.round((0.5 - cyclePosition) * LUNAR_CYCLE);
      daysSinceFull = Math.round((cyclePosition + 0.5) * LUNAR_CYCLE);
    } else {
      // After full moon
      daysUntilFull = Math.round((1.5 - cyclePosition) * LUNAR_CYCLE);
      daysSinceFull = Math.round((cyclePosition - 0.5) * LUNAR_CYCLE);
    }

    // Days until/since new moon
    let daysUntilNew, daysSinceNew;

    daysUntilNew = Math.round((1 - cyclePosition) * LUNAR_CYCLE);
    daysSinceNew = Math.round(cyclePosition * LUNAR_CYCLE);

    return {
      name: phase.name,
      illumination,
      cyclePosition,
      daysUntilFull,
      daysSinceFull,
      daysUntilNew,
      daysSinceNew,
      isWaxing: cyclePosition < 0.5,
      isWaning: cyclePosition >= 0.5
    };
  }

  registerIndicators() {
    // Moon phase name
    this.register('moon_phase', async () => {
      return this.calculateMoonPhase().name;
    }, {
      type: 'string',
      description: 'Current moon phase (new, waxing_crescent, first_quarter, waxing_gibbous, full, waning_gibbous, last_quarter, waning_crescent)',
      category: 'moon'
    });

    // Moon illumination
    this.register('moon_illumination', async () => {
      return this.calculateMoonPhase().illumination;
    }, {
      type: 'number',
      description: 'Moon illumination percentage (0-100)',
      category: 'moon'
    });

    // Days until full moon
    this.register('days_until_full_moon', async () => {
      return this.calculateMoonPhase().daysUntilFull;
    }, {
      type: 'number',
      description: 'Days until next full moon',
      category: 'moon'
    });

    // Days since full moon
    this.register('days_since_full_moon', async () => {
      return this.calculateMoonPhase().daysSinceFull;
    }, {
      type: 'number',
      description: 'Days since last full moon',
      category: 'moon'
    });

    // Days until new moon
    this.register('days_until_new_moon', async () => {
      return this.calculateMoonPhase().daysUntilNew;
    }, {
      type: 'number',
      description: 'Days until next new moon',
      category: 'moon'
    });

    // Days since new moon
    this.register('days_since_new_moon', async () => {
      return this.calculateMoonPhase().daysSinceNew;
    }, {
      type: 'number',
      description: 'Days since last new moon',
      category: 'moon'
    });

    // Is waxing
    this.register('is_moon_waxing', async () => {
      return this.calculateMoonPhase().isWaxing;
    }, {
      type: 'boolean',
      description: 'True if moon is waxing (growing)',
      category: 'moon'
    });

    // Is waning
    this.register('is_moon_waning', async () => {
      return this.calculateMoonPhase().isWaning;
    }, {
      type: 'boolean',
      description: 'True if moon is waning (shrinking)',
      category: 'moon'
    });

    // Is full moon (within 1 day)
    this.register('is_full_moon', async () => {
      const phase = this.calculateMoonPhase();
      return phase.name === 'full' || phase.daysUntilFull <= 1 || phase.daysSinceFull <= 1;
    }, {
      type: 'boolean',
      description: 'True if within 1 day of full moon',
      category: 'moon'
    });

    // Is new moon (within 1 day)
    this.register('is_new_moon', async () => {
      const phase = this.calculateMoonPhase();
      return phase.name === 'new' || phase.daysUntilNew <= 1 || phase.daysSinceNew <= 1;
    }, {
      type: 'boolean',
      description: 'True if within 1 day of new moon',
      category: 'moon'
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

export default MoonIndicators;
