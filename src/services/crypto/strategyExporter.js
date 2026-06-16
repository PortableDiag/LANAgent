/**
 * Strategy Exporter/Importer Service
 *
 * Handles import/export of trading strategies in Universal Strategy Format (USF).
 * Supports single strategies (.strategy.json) and bundles (.strategies.json).
 */

import { logger as baseLogger } from '../../utils/logger.js';
import { strategyRegistry } from './strategies/StrategyRegistry.js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json at load time
let APP_VERSION;
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
  APP_VERSION = pkg.version;
} catch {
  APP_VERSION = '2.10.63';
}

const logger = baseLogger.child ? baseLogger.child({ service: 'strategy-exporter' }) : baseLogger;

// Current format version
const FORMAT_VERSION = '1.0.0';
const MIN_COMPATIBLE_VERSION = '1.0.0';

// Known capabilities by tier
const CAPABILITIES = {
  core: ['basic_thresholds', 'per_asset_config', 'position_tracking'],
  standard: ['dca_intervals', 'grid_levels', 'moving_averages', 'cooldown_periods'],
  advanced: ['regime_detection', 'scale_out', 'trailing_stop', 'volatility_adjustment', 'gas_profitability'],
  rules: ['basic_rules', 'compound_conditions', 'price_indicators', 'time_indicators', 'technical_indicators',
          'moon_indicators', 'market_indicators', 'position_indicators', 'custom_indicators']
};

// Strategy type to capabilities mapping
const STRATEGY_CAPABILITIES = {
  native_maximizer: ['basic_thresholds', 'per_asset_config', 'position_tracking'],
  dca: ['basic_thresholds', 'dca_intervals', 'position_tracking'],
  grid_trading: ['basic_thresholds', 'grid_levels', 'position_tracking'],
  mean_reversion: ['basic_thresholds', 'moving_averages', 'position_tracking'],
  momentum: ['basic_thresholds', 'moving_averages', 'position_tracking'],
  volatility_adjusted: ['basic_thresholds', 'volatility_adjustment', 'regime_detection', 'position_tracking'],
  dollar_maximizer: ['basic_thresholds', 'regime_detection', 'position_tracking', 'gas_profitability'],
  token_trader: ['basic_thresholds', 'regime_detection', 'scale_out', 'trailing_stop', 'cooldown_periods', 'position_tracking'],
  rule_based: ['basic_rules', 'compound_conditions', 'price_indicators', 'time_indicators', 'position_tracking']
};

// Required fields for validation
const REQUIRED_FIELDS = {
  root: ['formatVersion', 'strategy'],
  metadata: ['name'],
  strategy: ['type', 'config']
};

// Type-specific required config fields
const STRATEGY_REQUIRED_CONFIG = {
  token_trader: ['tokenAddress', 'tokenNetwork', 'tokenSymbol'],
  native_maximizer: [],
  dca: ['buyAmountUSD', 'buyIntervalHours'],
  grid_trading: ['gridLevels', 'gridSpacing'],
  mean_reversion: ['maPeriodHours'],
  momentum: ['fastMAPeriodHours', 'slowMAPeriodHours'],
  dollar_maximizer: [],
  rule_based: ['rules']
};

/**
 * Export a single strategy to USF format
 * @param {string} strategyName - Name of strategy to export
 * @param {object} options - Export options
 * @param {string} options.type - 'config' (shareable) or 'full' (with state)
 * @param {string} options.displayName - Optional display name
 * @param {string} options.description - Optional description
 * @param {string} options.author - Optional author name
 * @param {string[]} options.tags - Optional tags
 * @returns {object} Exported strategy in USF format
 */
export function exportStrategy(strategyName, options = {}) {
  const { type = 'config', displayName, description, author, tags } = options;

  const strategy = strategyRegistry.get(strategyName);
  if (!strategy) {
    throw new Error(`Strategy not found: ${strategyName}`);
  }

  const strategyState = strategy.exportState();
  const now = new Date().toISOString();

  const exported = {
    formatVersion: FORMAT_VERSION,
    minCompatibleVersion: MIN_COMPATIBLE_VERSION,
    capabilities: STRATEGY_CAPABILITIES[strategyState.name] || ['basic_thresholds'],
    metadata: {
      name: strategyName,
      displayName: displayName || strategyName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: description || strategy.description || '',
      author: author || 'anonymous',
      createdAt: now,
      exportedAt: now,
      exportedFrom: 'LANAgent',
      sourceVersion: APP_VERSION,
      tags: tags || []
    },
    strategy: {
      type: strategyState.name,
      enabled: strategyState.enabled,
      config: sanitizeConfig(strategyState.config, strategyState.name),
      configVersion: strategyState.config?._configVersion || 1
    }
  };

  // Include state for full exports
  if (type === 'full') {
    exported.strategy.state = sanitizeState(strategyState.state);
    exported.checksum = generateChecksum(exported);
  }

  logger.info(`Exported strategy: ${strategyName} (type: ${type})`);
  return exported;
}

/**
 * Export all strategies to a bundle
 * @param {object} options - Export options
 * @returns {object} Multi-strategy bundle
 */
export function exportAllStrategies(options = {}) {
  const { type = 'config' } = options;
  const now = new Date().toISOString();

  const strategies = [];
  const strategyNames = strategyRegistry.getNames();

  for (const name of strategyNames) {
    try {
      const exported = exportStrategy(name, { ...options, type });
      strategies.push({
        metadata: exported.metadata,
        strategy: exported.strategy
      });
    } catch (error) {
      logger.warn(`Failed to export strategy ${name}: ${error.message}`);
    }
  }

  const active = strategyRegistry.getActive();
  const secondary = strategyRegistry.getSecondary();

  const bundle = {
    formatVersion: FORMAT_VERSION,
    minCompatibleVersion: MIN_COMPATIBLE_VERSION,
    metadata: {
      name: 'LANAgent Strategy Bundle',
      description: `Complete strategy backup - ${strategies.length} strategies`,
      exportedAt: now,
      exportedFrom: 'LANAgent',
      sourceVersion: APP_VERSION,
      strategyCount: strategies.length
    },
    strategies,
    registry: {
      activeStrategy: active?.name || null,
      secondaryStrategy: secondary?.name || null
    }
  };

  if (type === 'full') {
    bundle.checksum = generateChecksum(bundle);
  }

  logger.info(`Exported ${strategies.length} strategies to bundle`);
  return bundle;
}

/**
 * Validate a strategy file before import
 * @param {object} data - Strategy data to validate
 * @returns {object} Validation result with errors and warnings
 */
export function validateStrategy(data, _depth = 0) {
  const result = {
    valid: true,
    errors: [],
    warnings: [],
    normalized: null
  };

  // Check if it's a bundle (only at top level to prevent infinite recursion)
  if (_depth === 0 && data.strategies && Array.isArray(data.strategies)) {
    return validateBundle(data);
  }

  // Check required root fields
  for (const field of REQUIRED_FIELDS.root) {
    if (!(field in data)) {
      result.errors.push(`Missing required field: ${field}`);
      result.valid = false;
    }
  }

  // Check metadata
  if (data.metadata) {
    for (const field of REQUIRED_FIELDS.metadata) {
      if (!(field in data.metadata)) {
        result.warnings.push(`Missing metadata.${field}, will use default`);
      }
    }
  } else {
    result.warnings.push('Missing metadata section, will use defaults');
  }

  // Check strategy section
  if (data.strategy) {
    for (const field of REQUIRED_FIELDS.strategy) {
      if (!(field in data.strategy)) {
        result.errors.push(`Missing required field: strategy.${field}`);
        result.valid = false;
      }
    }

    // Check strategy type
    const validTypes = [...strategyRegistry.getNames(), 'rule_based'];
    if (data.strategy.type && !validTypes.includes(data.strategy.type)) {
      result.errors.push(`Unknown strategy type: ${data.strategy.type}`);
      result.valid = false;
    }

    // Check type-specific required config
    if (data.strategy.type && data.strategy.config) {
      const requiredConfig = STRATEGY_REQUIRED_CONFIG[data.strategy.type] || [];
      for (const field of requiredConfig) {
        if (!hasNestedField(data.strategy.config, field)) {
          result.errors.push(`Missing required config for ${data.strategy.type}: ${field}`);
          result.valid = false;
        }
      }
    }

    // Semantic validation
    const semanticResult = validateSemantics(data.strategy);
    result.errors.push(...semanticResult.errors);
    result.warnings.push(...semanticResult.warnings);
    if (semanticResult.errors.length > 0) {
      result.valid = false;
    }
  }

  // Version compatibility check
  if (data.minCompatibleVersion) {
    const compatible = isVersionCompatible(data.minCompatibleVersion, FORMAT_VERSION);
    if (!compatible) {
      result.errors.push(`Incompatible format version: requires ${data.minCompatibleVersion}+, have ${FORMAT_VERSION}`);
      result.valid = false;
    }
  }

  // Capability check
  if (data.capabilities) {
    const allCaps = Object.values(CAPABILITIES).flat();
    const unsupported = data.capabilities.filter(cap => !allCaps.includes(cap));
    if (unsupported.length > 0) {
      result.warnings.push(`Unsupported capabilities (will be ignored): ${unsupported.join(', ')}`);
    }
  }

  // Checksum verification for full exports
  if (data.checksum) {
    const verified = verifyChecksum(data);
    if (!verified) {
      result.warnings.push('Checksum verification failed - file may have been modified');
    }
  }

  // Normalize if valid
  if (result.valid) {
    result.normalized = normalizeStrategy(data);
  }

  return result;
}

/**
 * Validate a multi-strategy bundle
 */
function validateBundle(data) {
  const result = {
    valid: true,
    errors: [],
    warnings: [],
    normalized: null,
    strategies: []
  };

  if (!data.strategies || !Array.isArray(data.strategies)) {
    result.errors.push('Invalid bundle: missing strategies array');
    result.valid = false;
    return result;
  }

  for (let i = 0; i < data.strategies.length; i++) {
    const strategyData = {
      formatVersion: data.formatVersion,
      ...data.strategies[i]
    };
    const strategyResult = validateStrategy(strategyData, 1);

    result.strategies.push({
      index: i,
      name: strategyData.metadata?.name || `strategy_${i}`,
      valid: strategyResult.valid,
      errors: strategyResult.errors,
      warnings: strategyResult.warnings
    });

    if (!strategyResult.valid) {
      result.valid = false;
    }
    result.warnings.push(...strategyResult.warnings.map(w => `[${i}] ${w}`));
  }

  if (result.valid) {
    result.normalized = {
      ...data,
      strategies: data.strategies.map(s => normalizeStrategy({ formatVersion: data.formatVersion, ...s }))
    };
  }

  return result;
}

/**
 * Import a strategy into the registry
 * @param {object} data - Strategy data (already validated)
 * @param {object} options - Import options
 * @param {string} options.mode - 'merge' or 'replace'
 * @param {boolean} options.activate - Whether to activate after import
 * @returns {object} Import result
 */
export function importStrategy(data, options = {}) {
  const { mode = 'merge', activate = false } = options;

  // Validate first
  const validation = validateStrategy(data);
  if (!validation.valid) {
    return {
      success: false,
      errors: validation.errors,
      warnings: validation.warnings
    };
  }

  const normalized = validation.normalized;
  const result = {
    success: true,
    imported: [],
    warnings: validation.warnings,
    activationRequired: !activate
  };

  // Handle bundle
  if (normalized.strategies) {
    for (const strategyData of normalized.strategies) {
      const importResult = importSingleStrategy(strategyData, mode);
      result.imported.push(importResult);
      if (!importResult.success) {
        result.success = false;
      }
    }

    // Restore registry settings if present
    if (normalized.registry) {
      if (normalized.registry.activeStrategy && activate) {
        try {
          strategyRegistry.setActive(normalized.registry.activeStrategy);
        } catch (e) {
          result.warnings.push(`Could not set active strategy: ${e.message}`);
        }
      }
      if (normalized.registry.secondaryStrategy && activate) {
        try {
          strategyRegistry.setSecondary(normalized.registry.secondaryStrategy);
        } catch (e) {
          result.warnings.push(`Could not set secondary strategy: ${e.message}`);
        }
      }
    }
  } else {
    // Single strategy
    const importResult = importSingleStrategy(normalized, mode);
    result.imported.push(importResult);
    result.success = importResult.success;

    if (activate && importResult.success) {
      try {
        strategyRegistry.setActive(importResult.name);
        result.activationRequired = false;
      } catch (e) {
        result.warnings.push(`Could not activate strategy: ${e.message}`);
      }
    }
  }

  logger.info(`Imported ${result.imported.length} strategy(ies)`, {
    names: result.imported.map(i => i.name),
    mode,
    activate
  });

  return result;
}

/**
 * Import a single strategy
 */
function importSingleStrategy(data, mode) {
  const strategyType = data.strategy.type;
  const strategyName = data.metadata?.name || strategyType;
  const slug = slugify(strategyName);

  const result = {
    name: slug,
    type: strategyType,
    displayName: data.metadata?.displayName || strategyName,
    success: true,
    status: 'created'
  };

  try {
    const existingStrategy = strategyRegistry.get(strategyType);

    if (!existingStrategy) {
      // Strategy type doesn't exist - only rule_based can be created dynamically
      if (strategyType === 'rule_based') {
        result.status = 'created';
        result.message = 'Rule-based strategy created (implementation pending)';
        // TODO: Create RuleBasedStrategy instance
      } else {
        result.success = false;
        result.error = `Strategy type ${strategyType} not found in registry`;
        return result;
      }
    } else {
      // Update existing strategy config
      if (mode === 'replace') {
        existingStrategy.config = { ...data.strategy.config };
        if (data.strategy.state) {
          existingStrategy.state = { ...existingStrategy.state, ...data.strategy.state };
        }
        result.status = 'replaced';
      } else {
        // Merge mode - only update provided fields
        existingStrategy.config = { ...existingStrategy.config, ...data.strategy.config };
        if (data.strategy.state) {
          existingStrategy.state = { ...existingStrategy.state, ...data.strategy.state };
        }
        result.status = 'merged';
      }

      // Preserve any unknown fields for re-export
      if (data._preservedFields) {
        existingStrategy._preservedFields = data._preservedFields;
      }
    }
  } catch (error) {
    result.success = false;
    result.error = error.message;
  }

  return result;
}

/**
 * Semantic validation of strategy config
 */
function validateSemantics(strategy) {
  const errors = [];
  const warnings = [];
  const config = strategy.config || {};

  // Threshold validations
  if (config.thresholds) {
    if (config.thresholds.sell !== undefined && config.thresholds.sell <= 0) {
      warnings.push('Sell threshold should be positive (percentage gain)');
    }
    if (config.thresholds.buy !== undefined && config.thresholds.buy >= 0) {
      warnings.push('Buy threshold should be negative (percentage drop)');
    }
    if (config.thresholds.sell !== undefined && config.thresholds.buy !== undefined) {
      if (config.thresholds.sell <= config.thresholds.buy) {
        errors.push('Sell threshold must be greater than buy threshold');
      }
    }
  }

  // Token trader validations
  if (strategy.type === 'token_trader') {
    if (config.tokenAddress && !/^0x[a-fA-F0-9]{40}$/.test(config.tokenAddress)) {
      errors.push('Invalid token address format');
    }
    if (config.capitalAllocationPercent !== undefined) {
      if (config.capitalAllocationPercent < 1 || config.capitalAllocationPercent > 100) {
        errors.push('Capital allocation must be between 1-100%');
      }
    }
    if (config.scaleOutLevels && Array.isArray(config.scaleOutLevels)) {
      for (let i = 1; i < config.scaleOutLevels.length; i++) {
        if (config.scaleOutLevels[i] <= config.scaleOutLevels[i - 1]) {
          errors.push('Scale-out levels must be in ascending order');
          break;
        }
      }
    }
  }

  // Rule-based validations
  if (strategy.type === 'rule_based') {
    if (!config.rules || !Array.isArray(config.rules)) {
      errors.push('Rule-based strategy must have a rules array');
    } else if (config.rules.length === 0) {
      warnings.push('Rule-based strategy has no rules defined');
    } else {
      // Validate each rule
      for (let i = 0; i < config.rules.length; i++) {
        const rule = config.rules[i];
        if (!rule.id) {
          errors.push(`Rule ${i} missing required 'id' field`);
        }
        if (!rule.conditions) {
          errors.push(`Rule ${i} missing required 'conditions' field`);
        }
        if (!rule.action) {
          errors.push(`Rule ${i} missing required 'action' field`);
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Normalize strategy data with defaults
 */
function normalizeStrategy(data) {
  const normalized = { ...data };

  // Ensure metadata exists with defaults
  normalized.metadata = {
    name: 'unnamed_strategy',
    displayName: 'Unnamed Strategy',
    description: '',
    author: 'anonymous',
    createdAt: new Date().toISOString(),
    tags: [],
    ...normalized.metadata
  };

  // Generate slug from name
  normalized.metadata.slug = slugify(normalized.metadata.name);

  // Ensure strategy section
  normalized.strategy = {
    enabled: true,
    ...normalized.strategy
  };

  // Separate known and unknown fields for preservation
  const knownFields = ['formatVersion', 'minCompatibleVersion', 'capabilities', 'metadata', 'strategy', 'checksum'];
  const unknown = {};
  for (const key of Object.keys(data)) {
    if (!knownFields.includes(key)) {
      unknown[key] = data[key];
    }
  }
  if (Object.keys(unknown).length > 0) {
    normalized._preservedFields = unknown;
  }

  return normalized;
}

/**
 * Patterns that indicate sensitive data keys
 */
const SENSITIVE_KEY_PATTERNS = /^(api_?key|secret|password|private_?key|token|mnemonic|seed|wallet_?key|auth_?token)$/i;

/**
 * Recursively remove sensitive keys from an object
 */
function removeSensitiveKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(removeSensitiveKeys);

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.test(key)) continue;
    cleaned[key] = typeof value === 'object' ? removeSensitiveKeys(value) : value;
  }
  return cleaned;
}

/**
 * Sanitize config for export (remove sensitive data)
 */
function sanitizeConfig(config, strategyType) {
  const sanitized = { ...config };

  // Remove internal fields
  delete sanitized._id;
  delete sanitized.__v;

  return removeSensitiveKeys(sanitized);
}

/**
 * Sanitize state for export
 */
function sanitizeState(state) {
  const sanitized = { ...state };

  // Remove potentially sensitive wallet-specific data
  delete sanitized._id;
  delete sanitized.__v;

  return removeSensitiveKeys(sanitized);
}

/**
 * Generate checksum for integrity verification
 */
function generateChecksum(data) {
  const content = JSON.stringify({
    metadata: data.metadata,
    strategy: data.strategy,
    strategies: data.strategies
  });
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Verify checksum
 */
function verifyChecksum(data) {
  if (!data.checksum) return true;

  const expected = generateChecksum(data);
  return data.checksum === expected;
}

/**
 * Check version compatibility
 */
function isVersionCompatible(required, current) {
  const reqParts = required.split('.').map(Number);
  const curParts = current.split('.').map(Number);

  // Major version must match or current be higher
  if (curParts[0] < reqParts[0]) return false;
  if (curParts[0] > reqParts[0]) return true;

  // Minor version current must be >= required
  if (curParts[1] < reqParts[1]) return false;

  return true;
}

/**
 * Check if object has nested field
 */
function hasNestedField(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return false;
    if (!(part in current)) return false;
    current = current[part];
  }
  return true;
}

/**
 * Convert name to slug
 */
function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .replace(/_+/g, '_')
    .trim();
  return slug || `strategy_${Date.now()}`;
}

/**
 * Get platform capabilities for compatibility checking
 */
export function getPlatformCapabilities() {
  return {
    platform: 'LANAgent',
    version: APP_VERSION,
    formatVersion: FORMAT_VERSION,
    capabilities: Object.values(CAPABILITIES).flat(),
    supportedTypes: [...strategyRegistry.getNames(), 'rule_based']
  };
}

export default {
  exportStrategy,
  exportAllStrategies,
  validateStrategy,
  importStrategy,
  getPlatformCapabilities,
  FORMAT_VERSION,
  CAPABILITIES
};
