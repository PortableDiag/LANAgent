import winston from 'winston';
import Transport from 'winston-transport';
import { logger } from './logger.js';

/**
 * Custom transport that filters logs based on one or more filter functions
 * Supports dynamic filter updates without restarting the service
 * Multiple filters can be combined using AND/OR/NOT logical operators
 */
export class FilteredFileTransport extends Transport {
  constructor(opts) {
    super(opts);

    // Support both singular filter and plural filters for backward compatibility
    this.filterFuncs = opts.filters || (opts.filter ? [opts.filter] : [() => true]);
    this.logicalOperator = opts.logicalOperator || 'AND';

    // Create the underlying file transport
    const fileOpts = { ...opts };
    delete fileOpts.filter;
    delete fileOpts.filters;
    delete fileOpts.logicalOperator;
    this.fileTransport = new winston.transports.File(fileOpts);
  }

  /**
   * Evaluate the filter functions based on the logical operator
   */
  evaluateFilters(info) {
    if (this.logicalOperator === 'OR') {
      return this.filterFuncs.some(filterFunc => filterFunc(info));
    }
    if (this.logicalOperator === 'NOT') {
      return !this.filterFuncs.some(filterFunc => filterFunc(info));
    }
    // Default to AND
    return this.filterFuncs.every(filterFunc => filterFunc(info));
  }

  log(info, callback) {
    try {
      if (this.evaluateFilters(info)) {
        this.fileTransport.log(info, callback);
      } else {
        if (callback) {
          setImmediate(callback);
        }
      }
    } catch (error) {
      logger.error('Error in log filter function:', error);
      if (callback) {
        callback(error);
      }
    }
  }

  /**
   * Update the filter function at runtime (backward compatible)
   * @param {Function} newFilterFunc - New filter function to use
   */
  updateFilterFunction(newFilterFunc) {
    if (typeof newFilterFunc !== 'function') {
      throw new Error('Filter function must be a function');
    }
    this.filterFuncs = [newFilterFunc];
  }

  /**
   * Update multiple filter functions at runtime
   * @param {Array<Function>} newFilterFuncs - Array of filter functions
   * @param {string} newLogicalOperator - 'AND' or 'OR'
   */
  updateFilterFunctions(newFilterFuncs, newLogicalOperator = 'AND') {
    if (!Array.isArray(newFilterFuncs) || !newFilterFuncs.every(fn => typeof fn === 'function')) {
      throw new Error('Filter functions must be an array of functions');
    }
    if (!['AND', 'OR', 'NOT'].includes(newLogicalOperator)) {
      throw new Error('Logical operator must be "AND", "OR", or "NOT"');
    }
    this.filterFuncs = newFilterFuncs;
    this.logicalOperator = newLogicalOperator;
  }

  /**
   * Update the log level dynamically without restarting the service
   * @param {string} newLogLevel - New log level to apply
   */
  updateLogLevel(newLogLevel) {
    const validLogLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
    if (!validLogLevels.includes(newLogLevel)) {
      throw new Error(`Invalid log level: ${newLogLevel}`);
    }
    this.fileTransport.level = newLogLevel;
    logger.info(`Log level updated to ${newLogLevel}`);
  }

  // Proxy other methods to the underlying file transport
  close(callback) {
    if (this.fileTransport.close) {
      this.fileTransport.close(callback);
    } else if (callback) {
      callback();
    }
  }

  // Handle file rotation and other file-specific methods
  query(options, callback) {
    if (this.fileTransport.query) {
      this.fileTransport.query(options, callback);
    }
  }

  stream(options) {
    if (this.fileTransport.stream) {
      return this.fileTransport.stream(options);
    }
  }
}