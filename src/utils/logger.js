import winston from 'winston';
import Transport from 'winston-transport';
import path from 'path';
import fs from 'fs';
import { FilteredFileTransport } from './filteredTransport.js';

// Ensure logs directory exists
const logDir = 'logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// ========== Sensitive data redaction ==========
//
// Deep-walks log info.message and metadata, masking values whose keys match
// known sensitive names and substring-replacing high-signal token patterns
// (JWTs, Bearer tokens). Stays conservative on regex patterns to avoid
// accidentally destroying useful log content (git SHAs, ETH addresses,
// Mongo ObjectIds are all hex and were false-positive targets in earlier
// drafts — those patterns are disabled by default and only added via
// configureRedaction() if the operator opts in).
const redactionConfig = {
  keys: new Set([
    'password', 'token', 'apikey', 'secret', 'authorization',
    'set-cookie', 'cookie', 'access_token', 'refresh_token', 'jwt',
    'bearer', 'x-api-key', 'x-auth-token', 'private_key', 'privatekey',
    'encryptedseed', 'mnemonic'
  ]),
  patterns: [
    { regex: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer ***REDACTED***' },
    { regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '***REDACTED:JWT***' }
  ],
  mask: '***REDACTED***',
  maxStringLength: 8192
};

export function configureRedaction({ keys, patterns, mask, maxStringLength } = {}) {
  if (Array.isArray(keys)) {
    redactionConfig.keys = new Set(keys.map(k => String(k).toLowerCase()));
  }
  if (Array.isArray(patterns)) {
    redactionConfig.patterns = patterns
      .map(p => p instanceof RegExp
        ? { regex: p, replacement: redactionConfig.mask }
        : (p?.regex instanceof RegExp ? { regex: p.regex, replacement: p.replacement ?? redactionConfig.mask } : null))
      .filter(Boolean);
  }
  if (typeof mask === 'string') redactionConfig.mask = mask;
  if (typeof maxStringLength === 'number' && maxStringLength > 0) redactionConfig.maxStringLength = maxStringLength;
}

function truncate(str) {
  if (typeof str !== 'string') return str;
  const max = redactionConfig.maxStringLength;
  return str.length <= max ? str : `${str.slice(0, max)}… [truncated ${str.length - max} chars]`;
}

function redactStr(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const { regex, replacement } of redactionConfig.patterns) {
    try { out = out.replace(regex, replacement); } catch { /* skip broken regex */ }
  }
  return truncate(out);
}

function shouldRedactKey(key) {
  return typeof key === 'string' && redactionConfig.keys.has(key.toLowerCase());
}

function deepRedact(input, seen = new WeakSet()) {
  if (input == null) return input;
  const t = typeof input;
  if (t === 'string') return redactStr(input);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return input;
  if (t === 'function') return '[Function]';
  if (t === 'symbol') return input.toString();
  if (Buffer.isBuffer(input)) return `[Buffer ${input.length} bytes]`;
  if (input instanceof Date) return input;
  if (input instanceof RegExp) return input.toString();

  if (typeof input === 'object') {
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
  }

  if (input instanceof Error) {
    const e = { name: input.name };
    if (input.message) e.message = redactStr(String(input.message));
    if (input.stack) e.stack = redactStr(String(input.stack));
    for (const key of Object.keys(input)) {
      e[key] = shouldRedactKey(key) ? redactionConfig.mask : deepRedact(input[key], seen);
    }
    return e;
  }

  if (Array.isArray(input)) return input.map(v => deepRedact(v, seen));

  const out = {};
  for (const [key, val] of Object.entries(input)) {
    if (shouldRedactKey(key)) out[key] = redactionConfig.mask;
    else out[key] = deepRedact(val, seen);
  }
  return out;
}

const redactFormat = winston.format((info) => {
  try {
    if (info.message !== undefined) {
      info.message = typeof info.message === 'string' ? redactStr(info.message) : deepRedact(info.message);
    }
    const base = new Set(['level', 'message', 'timestamp', 'service']);
    for (const key of Object.keys(info)) {
      if (base.has(key)) continue;
      if (shouldRedactKey(key)) info[key] = redactionConfig.mask;
      else if (typeof info[key] === 'string') info[key] = redactStr(info[key]);
      else info[key] = deepRedact(info[key]);
    }
  } catch (e) {
    info.redactionError = e?.message || 'redaction failed';
  }
  return info;
});

// Custom log format for better readability
const customFormat = winston.format.combine(
  redactFormat(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    let logMessage = `${timestamp} [${level.toUpperCase()}]`;
    if (service && service !== 'lan-agent') {
      logMessage += ` [${service}]`;
    }
    logMessage += ` ${message}`;
    
    // Add metadata if present
    const metaKeys = Object.keys(meta).filter(key => 
      !['timestamp', 'level', 'message', 'service', 'stack'].includes(key)
    );
    if (metaKeys.length > 0) {
      const cleanMeta = {};
      metaKeys.forEach(key => cleanMeta[key] = meta[key]);
      logMessage += ` ${JSON.stringify(cleanMeta)}`;
    }
    
    // Add stack trace for errors
    if (meta.stack) {
      logMessage += `\n${meta.stack}`;
    }
    
    return logMessage;
  })
);

// JSON format for machine processing
const jsonFormat = winston.format.combine(
  redactFormat(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'lan-agent' },
  transports: [
    // === ORGANIZED PROJECT LOGS ===
    
    // 1. ALL ACTIVITY - Everything in human-readable format
    new winston.transports.File({
      filename: path.join(logDir, 'all-activity.log'),
      format: customFormat,
      maxsize: 30 * 1024 * 1024, // 30MB max (reduced from 50MB for more reliable rotation)
      maxFiles: 5, // Keep 5 rotated files (increased from 3)
      tailable: true // Ensure the main file always has the latest logs
    }),
    
    // 2. ERRORS ONLY - Critical issues
    new winston.transports.File({
      filename: path.join(logDir, 'errors.log'),
      level: 'error',
      format: customFormat,
      maxsize: 10 * 1024 * 1024, // 10MB max
      maxFiles: 5,
      tailable: true
    }),
    
    // 3. SERVICE-SPECIFIC LOGS
    
    // Self-modification service logs
    new FilteredFileTransport({
      filename: path.join(logDir, 'self-modification.log'),
      format: customFormat,
      filter: (info) => {
        const msg = info.message?.toLowerCase() || '';
        const service = info.service?.toLowerCase() || '';
        return service === 'self-modification' ||
               msg.includes('self-modification') ||
               msg.includes('capability upgrade') ||
               msg.includes('pr created') ||
               msg.includes('systemexecutor');
      },
      maxsize: 20 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),
    
    // Plugin development logs
    new FilteredFileTransport({
      filename: path.join(logDir, 'plugin-development.log'),
      format: customFormat,
      filter: (info) => {
        const msg = info.message?.toLowerCase() || '';
        const service = info.service?.toLowerCase() || '';
        return service === 'plugin-development' ||
               msg.includes('plugin development') ||
               msg.includes('plugin capability') ||
               msg.includes('api discovery') ||
               msg.includes('new plugin');
      },
      maxsize: 20 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),

    // Bug detection and fixing logs  
    new FilteredFileTransport({
      filename: path.join(logDir, 'bug-detection.log'),
      format: customFormat,
      filter: (info) => {
        const msg = info.message?.toLowerCase() || '';
        const service = info.service?.toLowerCase() || '';
        // Exclude plugin-development logs even if they contain bug-related keywords
        if (service === 'plugin-development') return false;

        return service === 'bug-detector' ||
               service === 'bug-fixing' ||
               msg.includes('bug detect') ||
               msg.includes('bug fix') ||
               msg.includes('vulnerability') ||
               msg.includes('security scan');
      },
      maxsize: 20 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),
    
    // Diagnostics and health monitoring logs
    new FilteredFileTransport({
      filename: path.join(logDir, 'diagnostics.log'),
      format: customFormat,
      filter: (info) => {
        const msg = info.message?.toLowerCase() || '';
        const service = info.service?.toLowerCase() || '';
        return service === 'diagnostics' ||
               msg.includes('diagnostic') || 
               msg.includes('health check') || 
               msg.includes('api endpoint test') ||
               msg.includes('system resources') ||
               msg.includes('enhanced diagnostic');
      },
      maxsize: 20 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),
    
    // API and web interface logs
    new FilteredFileTransport({
      filename: path.join(logDir, 'api-web.log'),
      format: customFormat,
      filter: (info) => {
        const msg = info.message?.toLowerCase() || '';
        const service = info.service?.toLowerCase() || '';
        return service === 'api' ||
               service === 'web' ||
               msg.includes('api endpoint') ||
               msg.includes('api route') ||
               msg.includes('http request') ||
               msg.includes('http response') ||
               msg.includes('web ui') ||
               msg.includes('web interface') ||
               msg.includes('auth token') ||
               msg.includes('auth fail') ||
               msg.includes('login') ||
               msg.includes('jwt');
      },
      maxsize: 20 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),
    
    // Crypto strategy and trading logs
    new FilteredFileTransport({
      filename: path.join(logDir, 'crypto.log'),
      format: customFormat,
      filter: (info) => {
        const msg = info.message?.toLowerCase() || '';
        const service = info.service?.toLowerCase() || '';
        return service === 'crypto' ||
               service === 'token-scanner' ||
               service === 'strategy-evolution' ||
               msg.includes('crypto') ||
               msg.includes('strategy execution') ||
               msg.includes('strategy result') ||
               msg.includes('secondary strategy') ||
               msg.includes('tokentrader') ||
               msg.includes('token_trader') ||
               msg.includes('dollar_maximizer') ||
               msg.includes('swap') ||
               msg.includes('v3 quote') ||
               msg.includes('v3 selected') ||
               msg.includes('price monitor') ||
               msg.includes('heartbeat') ||
               msg.includes('regime') ||
               msg.includes('stablecoin reserve') ||
               msg.includes('reconciliation');
      },
      maxsize: 20 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),

    // Plugin activity logs
    new FilteredFileTransport({
      filename: path.join(logDir, 'plugins.log'),
      format: customFormat,
      filter: (info) => {
        const msg = info.message?.toLowerCase() || '';
        const service = info.service?.toLowerCase() || '';
        const isPluginService = service && (
          service.includes('plugin') ||
          service === 'calendar' ||
          service === 'monitoring' ||
          service === 'git' ||
          service === 'docker' ||
          service === 'network' ||
          service === 'vpn' ||
          service === 'samba' ||
          service === 'ffmpeg' ||
          service === 'yt-dlp' ||
          service === 'email' ||
          service === 'tasks' ||
          service === 'system'
        );
        return isPluginService ||
               msg.includes('plugin') ||
               msg.includes('plugin:') ||
               msg.includes('loaded api') ||
               msg.includes('executing api');
      },
      maxsize: 20 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),
    
    // 4. MACHINE-READABLE JSON - For automated analysis
    new winston.transports.File({ 
      filename: path.join(logDir, 'structured.json'),
      format: jsonFormat,
      maxsize: 30 * 1024 * 1024,
      maxFiles: 2,
      tailable: true
    })
  ]
});

// Add console output in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Create service-specific loggers for better organization
export const selfModLogger = logger.child({ service: 'self-modification' });
export const bugDetectorLogger = logger.child({ service: 'bug-detector' });
export const apiLogger = logger.child({ service: 'api' });
export const systemLogger = logger.child({ service: 'system' });
export const pluginLogger = logger.child({ service: 'plugin' });
export const pluginDevelopmentLogger = logger.child({ service: 'plugin-development' });
export const cryptoLogger = logger.child({ service: 'crypto' });

// Simple transport that forwards log entries to another logger.
// Used by plugin loggers to pipe messages into the main logger's transports
// without opening duplicate file handles on shared log files.
class ForwardTransport extends Transport {
  constructor(opts) {
    super(opts);
    this.target = opts.target;
  }
  log(info, callback) {
    // Forward to the target logger (main logger handles all-activity, plugins, etc.)
    this.target.log(info);
    if (callback) callback();
  }
}

// Plugin-specific logger cache
const pluginLoggerCache = new Map();

/**
 * Create a logger for a specific plugin with its own log file
 * @param {string} pluginName - The name of the plugin
 * @returns {winston.Logger} - A logger instance for the plugin
 */
export const createPluginLogger = (pluginName) => {
  // Check if logger already exists
  if (pluginLoggerCache.has(pluginName)) {
    return pluginLoggerCache.get(pluginName);
  }

  // Create plugin-specific log directory if needed
  const pluginLogDir = path.join(logDir, 'plugins');
  if (!fs.existsSync(pluginLogDir)) {
    fs.mkdirSync(pluginLogDir, { recursive: true });
  }

  // Create a standalone logger with only the plugin-specific file transport.
  // A forwarding transport pipes messages to the main logger so they appear
  // in all-activity.log, plugins.log, etc. without opening duplicate file
  // handles on shared log files (which causes rotation conflicts).
  const pluginLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { service: `plugin-${pluginName}` },
    transports: [
      // Plugin-specific log file
      new winston.transports.File({
        filename: path.join(pluginLogDir, `${pluginName}.log`),
        format: customFormat,
        maxsize: 10 * 1024 * 1024, // 10MB max per plugin
        maxFiles: 3,
        tailable: true
      }),
      // Forward to main logger for shared files (all-activity, plugins, etc.)
      new ForwardTransport({ target: logger })
    ]
  });

  // Add console output in development
  if (process.env.NODE_ENV !== 'production') {
    pluginLogger.add(new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }));
  }

  // Cache the logger
  pluginLoggerCache.set(pluginName, pluginLogger);
  
  return pluginLogger;
};

// Main logger export
export { logger };

// Utility functions for debugging
export const logDebugSeparator = (title) => {
  logger.info(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`);
};

export const logStep = (step, description) => {
  logger.info(`🔹 STEP ${step}: ${description}`);
};