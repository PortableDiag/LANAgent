import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { UpsConfig } from '../../models/UpsConfig.js';
import { UpsEvent } from '../../models/UpsEvent.js';

const execAsync = promisify(exec);

/**
 * UPS Monitoring Service
 * Monitors UPS devices via NUT (Network UPS Tools) and emits events for status changes
 */
class UpsService extends EventEmitter {
  constructor() {
    super();
    this.agent = null;
    this.enabled = false;
    this.pollIntervals = new Map();    // upsName -> interval timer
    this.previousStatuses = new Map(); // upsName -> last status
    this.shutdownInitiated = false;
    this.nutAvailable = null;          // Cache NUT availability check
  }

  /**
   * Initialize the UPS service
   */
  async initialize(agent) {
    this.agent = agent;
    logger.info('Initializing UPS monitoring service...');

    // Check if NUT is available
    this.nutAvailable = await this.checkNutAvailable();
    if (!this.nutAvailable) {
      logger.warn('NUT (upsc) not available - UPS monitoring will be disabled');
      return false;
    }

    // Load enabled UPS configurations
    const configs = await UpsConfig.getEnabled();

    if (configs.length === 0) {
      // Try to auto-detect UPS devices
      const detected = await this.detectUpsDevices();
      if (detected.length > 0) {
        logger.info(`Auto-detected ${detected.length} UPS device(s)`);
        for (const upsName of detected) {
          await UpsConfig.getOrCreateDefault(upsName);
        }
      } else {
        // Create default config for 'ups' which is the standard NUT name
        await UpsConfig.getOrCreateDefault('ups');
        logger.info('Created default UPS configuration');
      }
    }

    this.enabled = true;
    logger.info('UPS monitoring service initialized');
    return true;
  }

  /**
   * Start monitoring all configured UPS devices
   */
  async start() {
    if (!this.nutAvailable) {
      logger.warn('Cannot start UPS monitoring - NUT not available');
      return;
    }

    const configs = await UpsConfig.getEnabled();
    for (const config of configs) {
      this.startMonitoring(config.upsName, config.pollInterval);
    }

    logger.info(`UPS monitoring started for ${configs.length} device(s)`);
  }

  /**
   * Stop all monitoring
   */
  async stop() {
    for (const [upsName, interval] of this.pollIntervals) {
      clearInterval(interval);
      logger.info(`Stopped monitoring UPS: ${upsName}`);
    }
    this.pollIntervals.clear();
    this.enabled = false;
  }

  /**
   * Shutdown the service
   */
  async shutdown() {
    await this.stop();
    logger.info('UPS monitoring service shut down');
  }

  /**
   * Check if NUT (upsc) is available
   */
  async checkNutAvailable() {
    try {
      await execAsync('which upsc');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect available UPS devices via NUT
   */
  async detectUpsDevices(host = 'localhost') {
    try {
      const { stdout } = await execAsync(`upsc -l ${host}`, { timeout: 10000 });
      const devices = stdout.trim().split('\n').filter(line => line.trim());
      return devices;
    } catch (error) {
      logger.debug(`No UPS devices detected on ${host}: ${error.message}`);
      return [];
    }
  }

  /**
   * Start monitoring a specific UPS
   */
  startMonitoring(upsName, pollInterval = 30000) {
    // Clear existing interval if any
    if (this.pollIntervals.has(upsName)) {
      clearInterval(this.pollIntervals.get(upsName));
    }

    // Initial poll
    this.pollUps(upsName);

    // Set up interval polling
    const interval = setInterval(() => {
      this.pollUps(upsName);
    }, pollInterval);

    this.pollIntervals.set(upsName, interval);
    logger.info(`Started monitoring UPS: ${upsName} (interval: ${pollInterval}ms)`);
  }

  /**
   * Stop monitoring a specific UPS
   */
  stopMonitoring(upsName) {
    if (this.pollIntervals.has(upsName)) {
      clearInterval(this.pollIntervals.get(upsName));
      this.pollIntervals.delete(upsName);
      logger.info(`Stopped monitoring UPS: ${upsName}`);
    }
  }

  /**
   * Poll a UPS for status
   */
  async pollUps(upsName) {
    try {
      const config = await UpsConfig.findOne({ upsName });
      if (!config || !config.enabled) return;

      const status = await this.queryUpsStatus(upsName, config.host);
      const previousStatus = this.previousStatuses.get(upsName);

      // Update stored status
      await UpsConfig.updateStatus(upsName, status);
      this.previousStatuses.set(upsName, status);

      // Emit status update
      this.emit('ups:status', { upsName, status, config });

      // Check for status changes and handle events
      if (previousStatus) {
        await this.detectStatusChanges(upsName, previousStatus, status, config);
      }

      // Check thresholds
      await this.checkThresholds(upsName, status, config);

      // Publish to MQTT if enabled
      await this.publishToMqtt(upsName, status, config);

    } catch (error) {
      logger.error(`Failed to poll UPS ${upsName}:`, error.message);

      // Record error
      await UpsConfig.recordError(upsName, error.message);

      // Check if we lost communication
      const config = await UpsConfig.findOne({ upsName });
      if (config && config.consecutiveErrors >= 3) {
        await this.handlePowerEvent(upsName, 'communication_lost', null, config);
      }
    }
  }

  /**
   * Query UPS status via upsc command
   */
  async queryUpsStatus(upsName, host = 'localhost') {
    const { stdout } = await execAsync(`upsc ${upsName}@${host}`, { timeout: 10000 });
    return this.parseUpscOutput(stdout);
  }

  /**
   * Parse upsc output into structured object
   */
  parseUpscOutput(output) {
    const status = {};
    const lines = output.trim().split('\n');

    // NUT variable mappings
    const mappings = {
      'battery.charge': 'batteryCharge',
      'battery.runtime': 'batteryRuntime',
      'ups.load': 'load',
      'input.voltage': 'inputVoltage',
      'output.voltage': 'outputVoltage',
      'ups.temperature': 'temperature',
      'battery.temperature': 'batteryTemperature',
      'ups.status': 'status',
      'ups.model': 'upsModel',
      'ups.mfr': 'manufacturer',
      'device.serial': 'serialNumber',
      'ups.serial': 'serialNumber',
      'ups.firmware': 'firmwareVersion',
      'battery.voltage': 'batteryVoltage',
      'battery.voltage.nominal': 'batteryVoltageNominal',
      'input.voltage.nominal': 'inputVoltageNominal',
      'ups.realpower': 'realPower',
      'ups.realpower.nominal': 'realPowerNominal',
      'ups.beeper.status': 'beeperStatus',
      'ups.test.result': 'lastTestResult',
      'battery.date': 'batteryDate',
      'ups.delay.shutdown': 'shutdownDelay',
      'ups.delay.start': 'startDelay'
    };

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();

      // Map to friendly name or use original
      const mappedKey = mappings[key] || key.replace(/\./g, '_');

      // Parse numeric values
      const numValue = parseFloat(value);
      status[mappedKey] = isNaN(numValue) ? value : numValue;
    }

    // Add human-readable status description
    status.statusDescription = this.getStatusDescription(status.status);

    return status;
  }

  /**
   * Get human-readable status description
   */
  getStatusDescription(statusCode) {
    if (!statusCode) return 'Unknown';

    const descriptions = {
      'OL': 'Online (on utility power)',
      'OB': 'On Battery',
      'LB': 'Low Battery',
      'HB': 'High Battery',
      'RB': 'Battery Needs Replacement',
      'CHRG': 'Charging',
      'DISCHRG': 'Discharging',
      'BYPASS': 'Bypass Mode',
      'CAL': 'Calibrating',
      'OFF': 'Offline',
      'OVER': 'Overloaded',
      'TRIM': 'Trimming Voltage',
      'BOOST': 'Boosting Voltage',
      'FSD': 'Forced Shutdown'
    };

    // Status can be space-separated combination (e.g., "OL CHRG")
    const parts = statusCode.split(' ');
    const desc = parts.map(p => descriptions[p] || p).join(', ');
    return desc || statusCode;
  }

  /**
   * Detect status changes and emit appropriate events
   */
  async detectStatusChanges(upsName, previousStatus, currentStatus, config) {
    const prevStatusCode = previousStatus.status || '';
    const currStatusCode = currentStatus.status || '';

    // Power loss / On battery detection
    if (!prevStatusCode.includes('OB') && currStatusCode.includes('OB')) {
      await this.handlePowerEvent(upsName, 'on_battery', currentStatus, config);
    }

    // Power restored detection
    if (prevStatusCode.includes('OB') && !currStatusCode.includes('OB') && currStatusCode.includes('OL')) {
      await this.handlePowerEvent(upsName, 'power_restored', currentStatus, config);
    }

    // Low battery detection
    if (!prevStatusCode.includes('LB') && currStatusCode.includes('LB')) {
      await this.handlePowerEvent(upsName, 'low_battery', currentStatus, config);
    }

    // Overload detection
    if (!prevStatusCode.includes('OVER') && currStatusCode.includes('OVER')) {
      await this.handlePowerEvent(upsName, 'overload', currentStatus, config);
    }

    // Battery replacement needed
    if (!prevStatusCode.includes('RB') && currStatusCode.includes('RB')) {
      await this.handlePowerEvent(upsName, 'battery_replace', currentStatus, config);
    }
  }

  /**
   * Check thresholds and trigger events
   */
  async checkThresholds(upsName, status, config) {
    const { thresholds } = config;

    // Check battery level thresholds
    if (status.batteryCharge !== undefined) {
      if (status.batteryCharge <= thresholds.shutdownBattery) {
        await this.handlePowerEvent(upsName, 'battery_critical', status, config);
        await this.checkAutoShutdown(upsName, status, config);
      } else if (status.batteryCharge <= thresholds.criticalBattery) {
        await this.handlePowerEvent(upsName, 'battery_critical', status, config);
      } else if (status.batteryCharge <= thresholds.lowBattery) {
        await this.handlePowerEvent(upsName, 'low_battery', status, config);
      }
    }

    // Check runtime threshold
    if (status.batteryRuntime !== undefined) {
      if (status.batteryRuntime <= thresholds.criticalRuntime) {
        await this.handlePowerEvent(upsName, 'battery_critical', status, config);
        await this.checkAutoShutdown(upsName, status, config);
      }
    }

    // Check load threshold
    if (status.load !== undefined && status.load >= thresholds.highLoad) {
      await this.handlePowerEvent(upsName, 'overload', status, config);
    }

    // Check temperature threshold
    if (status.temperature !== undefined && status.temperature >= thresholds.highTemperature) {
      // Temperature warning - could add a specific event type
      logger.warn(`UPS ${upsName} temperature high: ${status.temperature}C`);
    }
  }

  /**
   * Handle a power event
   */
  async handlePowerEvent(upsName, eventType, status, config) {
    // Determine severity
    const severityMap = {
      'power_loss': 'warning',
      'on_battery': 'warning',
      'low_battery': 'warning',
      'battery_critical': 'critical',
      'shutdown_initiated': 'critical',
      'power_restored': 'info',
      'communication_lost': 'critical',
      'communication_restored': 'info',
      'overload': 'critical',
      'battery_replace': 'warning',
      'test': 'info'
    };

    const severity = severityMap[eventType] || 'info';

    // Check notification cooldown
    if (config && !config.shouldNotify(eventType)) {
      logger.debug(`Skipping notification for ${eventType} - cooldown active`);
      return;
    }

    // Record event to database
    const event = await UpsEvent.recordEvent({
      upsName,
      eventType,
      severity,
      statusSnapshot: status,
      message: this.getEventMessage(eventType, status),
      previousStatus: this.previousStatuses.get(upsName)?.status
    });

    // Emit event for other services (MQTT, Event Engine)
    this.emit('ups:event', { upsName, eventType, severity, status, event });

    // Send notifications
    await this.sendNotifications(upsName, eventType, severity, status, config);

    // Record notification sent
    if (config) {
      await config.recordNotification(eventType);
    }

    logger.info(`UPS Event: ${upsName} - ${eventType} (${severity})`);
  }

  /**
   * Get human-readable event message
   */
  getEventMessage(eventType, status) {
    const messages = {
      'power_loss': 'Utility power lost',
      'on_battery': `UPS running on battery (${status?.batteryCharge || '?'}% charge, ~${Math.round((status?.batteryRuntime || 0) / 60)} min remaining)`,
      'low_battery': `UPS battery low (${status?.batteryCharge || '?'}%)`,
      'battery_critical': `UPS battery critical (${status?.batteryCharge || '?'}%) - immediate action required`,
      'shutdown_initiated': 'System shutdown initiated due to UPS battery critical',
      'power_restored': 'Utility power restored - UPS back online',
      'communication_lost': 'Lost communication with UPS',
      'communication_restored': 'Communication with UPS restored',
      'overload': `UPS overloaded (${status?.load || '?'}% load)`,
      'battery_replace': 'UPS battery needs replacement',
      'test': 'UPS self-test completed'
    };

    return messages[eventType] || eventType;
  }

  /**
   * Send notifications for an event
   */
  async sendNotifications(upsName, eventType, severity, status, config) {
    if (!config?.notifications?.enabled) return;

    const message = this.formatNotificationMessage(upsName, eventType, status, config);

    // Send via agent notification system (Telegram, etc.)
    if (this.agent) {
      try {
        await this.agent.notify(message);
        logger.debug(`Sent notification for UPS event: ${eventType}`);
      } catch (error) {
        logger.error('Failed to send UPS notification:', error.message);
      }
    }
  }

  /**
   * Format notification message
   */
  formatNotificationMessage(upsName, eventType, status, config) {
    const icon = {
      'power_loss': '⚡',
      'on_battery': '🔋',
      'low_battery': '🪫',
      'battery_critical': '🚨',
      'shutdown_initiated': '💀',
      'power_restored': '✅',
      'communication_lost': '📡',
      'communication_restored': '📡',
      'overload': '⚠️',
      'battery_replace': '🔧',
      'test': 'ℹ️'
    }[eventType] || 'ℹ️';

    const displayName = config?.displayName || upsName;
    const eventMessage = this.getEventMessage(eventType, status);

    let message = `${icon} **UPS Alert - ${displayName}**\n${eventMessage}`;

    if (status) {
      const details = [];
      if (status.batteryCharge !== undefined) details.push(`Battery: ${status.batteryCharge}%`);
      if (status.batteryRuntime !== undefined) details.push(`Runtime: ${Math.round(status.batteryRuntime / 60)} min`);
      if (status.load !== undefined) details.push(`Load: ${status.load}%`);
      if (status.inputVoltage !== undefined) details.push(`Input: ${status.inputVoltage}V`);

      if (details.length > 0) {
        message += `\n\n${details.join(' | ')}`;
      }
    }

    return message;
  }

  /**
   * Check and execute auto-shutdown if needed
   */
  async checkAutoShutdown(upsName, status, config) {
    if (this.shutdownInitiated) return;
    if (!config?.autoShutdown?.enabled) return;

    const { autoShutdown, thresholds } = config;
    let shouldShutdown = false;

    if (autoShutdown.triggerOn === 'battery_level' || autoShutdown.triggerOn === 'both') {
      if (status.batteryCharge <= autoShutdown.batteryThreshold) {
        shouldShutdown = true;
      }
    }

    if (autoShutdown.triggerOn === 'runtime' || autoShutdown.triggerOn === 'both') {
      if (status.batteryRuntime <= autoShutdown.runtimeThreshold) {
        shouldShutdown = true;
      }
    }

    if (shouldShutdown) {
      this.shutdownInitiated = true;

      // Record shutdown event
      await this.handlePowerEvent(upsName, 'shutdown_initiated', status, config);

      // Notify before shutdown
      if (autoShutdown.notifyBeforeShutdown) {
        const message = `🚨 **CRITICAL: System shutdown in ${autoShutdown.delaySeconds} seconds**\nUPS battery critically low. Initiating safe shutdown.`;
        if (this.agent) {
          await this.agent.notify(message);
        }
      }

      // Execute shutdown after delay
      logger.warn(`Initiating system shutdown in ${autoShutdown.delaySeconds} seconds due to UPS battery critical`);

      setTimeout(async () => {
        try {
          logger.warn(`Executing shutdown command: ${autoShutdown.command}`);
          await execAsync(autoShutdown.command);
        } catch (error) {
          logger.error('Failed to execute shutdown command:', error.message);
        }
      }, autoShutdown.delaySeconds * 1000);
    }
  }

  /**
   * Publish status to MQTT
   */
  async publishToMqtt(upsName, status, config) {
    if (!config?.mqtt?.enabled) return;

    const mqttService = this.agent?.services?.get('mqttService');
    if (!mqttService) return;

    try {
      const topic = config.mqtt.statusTopic.replace('{upsName}', upsName);
      await mqttService.publish(topic, JSON.stringify({
        upsName,
        timestamp: new Date().toISOString(),
        ...status
      }));
    } catch (error) {
      logger.debug(`Failed to publish UPS status to MQTT: ${error.message}`);
    }
  }

  /**
   * Get current status for all monitored UPS devices
   */
  async getAllStatus() {
    const configs = await UpsConfig.find({}).lean();
    const results = [];

    for (const config of configs) {
      results.push({
        upsName: config.upsName,
        displayName: config.displayName,
        enabled: config.enabled,
        lastStatus: config.lastStatus,
        lastPollAt: config.lastPollAt,
        lastError: config.lastError
      });
    }

    return results;
  }

  /**
   * Get status for a specific UPS
   */
  async getStatus(upsName) {
    const config = await UpsConfig.findOne({ upsName });
    if (!config) {
      throw new Error(`UPS not found: ${upsName}`);
    }

    // Get fresh status if NUT is available
    if (this.nutAvailable && config.enabled) {
      try {
        const status = await this.queryUpsStatus(upsName, config.host);
        return {
          upsName: config.upsName,
          displayName: config.displayName,
          status,
          config: {
            enabled: config.enabled,
            thresholds: config.thresholds,
            notifications: config.notifications,
            autoShutdown: config.autoShutdown
          }
        };
      } catch (error) {
        // Fall back to cached status
      }
    }

    return {
      upsName: config.upsName,
      displayName: config.displayName,
      status: config.lastStatus,
      config: {
        enabled: config.enabled,
        thresholds: config.thresholds,
        notifications: config.notifications,
        autoShutdown: config.autoShutdown
      },
      cached: true
    };
  }

  /**
   * Get service statistics
   */
  getStats() {
    return {
      enabled: this.enabled,
      nutAvailable: this.nutAvailable,
      monitoredDevices: this.pollIntervals.size,
      shutdownInitiated: this.shutdownInitiated
    };
  }
}

// Export singleton instance
export const upsService = new UpsService();
export default upsService;
