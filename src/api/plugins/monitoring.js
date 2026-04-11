import { BasePlugin } from '../core/basePlugin.js';
import si from 'systeminformation';
import { logger } from '../../utils/logger.js';
import { TokenUsage } from '../../models/TokenUsage.js';
import { SystemSettings } from '../../models/SystemSettings.js';

export default class MonitoringPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'monitoring';
    this.version = '1.0.0';
    this.description = 'Advanced system monitoring including CPU temperature, performance metrics, GPU monitoring, and alerts';
    this.commands = [
      {
        command: 'temperature',
        description: 'Get current CPU and system temperatures',
        usage: 'temperature'
      },
      {
        command: 'performance',
        description: 'Get comprehensive system performance metrics (CPU, memory, disk, network)',
        usage: 'performance'
      },
      {
        command: 'health',
        description: 'Get overall system health status and alerts',
        usage: 'health'
      },
      {
        command: 'gpu',
        description: 'Get GPU information and statistics',
        usage: 'gpu'
      },
      {
        command: 'alerts',
        description: 'Get current system alerts and warnings',
        usage: 'alerts'
      },
      {
        command: 'history',
        description: 'Get historical monitoring data',
        usage: 'history [metric] [duration]'
      },
      {
        command: 'tokens',
        description: 'Get token usage metrics and set alerts',
        usage: 'tokens [provider] [days]'
      },
      {
        command: 'setTokenAlert',
        description: 'Set token usage alert threshold',
        usage: 'setTokenAlert [provider] [daily|total] [threshold]'
      }
    ];
    this.temperatureThresholds = {
      warning: 70, // Celsius
      critical: 85  // Celsius
    };
    this.cpuThresholds = {
      warning: 80, // Percentage
      critical: 95  // Percentage
    };
    this.memoryThresholds = {
      warning: 85, // Percentage
      critical: 95  // Percentage
    };
    this.diskThresholds = {
      warning: 85, // Percentage
      critical: 95  // Percentage
    };
    this.tokenThresholds = {
      daily: {
        anthropic: 500000,
        openai: 500000,
        gab: 500000,
        ollama: 1000000,
        bitnet: 1000000
      },
      total: {
        anthropic: 10000000,
        openai: 30000000,
        gab: 10000000,
        ollama: 50000000,
        bitnet: 50000000
      }
    };
    this.lastAlert = {};
    this.tokenCheckInterval = null;
  }

  async initialize() {
    logger.info('Monitoring plugin initialized');

    // Load persisted alert state from database to survive restarts
    try {
      const { Agent } = await import('../../models/Agent.js');
      const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
      if (agentData?.pluginData?.monitoring?.lastAlertTimes) {
        this.lastAlert = agentData.pluginData.monitoring.lastAlertTimes;
        logger.debug('Loaded persisted alert times from database');
      }
    } catch (error) {
      logger.debug('Could not load persisted alert times:', error.message);
    }

    // Load persisted token thresholds from SystemSettings
    await this.loadTokenThresholds();

    // Start temperature monitoring
    this.startTemperatureMonitoring();

    // Start token usage monitoring
    this.startTokenMonitoring();

    // Note: API endpoint registration removed as it's not supported by the current plugin architecture
    // Threshold configuration can be done through the plugin's execute method instead
  }

  /**
   * Load token thresholds from SystemSettings
   */
  async loadTokenThresholds() {
    try {
      const savedThresholds = await SystemSettings.getSetting('tokenAlertThresholds');
      if (savedThresholds) {
        // Merge saved thresholds with defaults (in case new providers were added)
        if (savedThresholds.daily) {
          this.tokenThresholds.daily = { ...this.tokenThresholds.daily, ...savedThresholds.daily };
        }
        if (savedThresholds.total) {
          this.tokenThresholds.total = { ...this.tokenThresholds.total, ...savedThresholds.total };
        }
        logger.info('Loaded persisted token thresholds from SystemSettings');
      }
    } catch (error) {
      logger.debug('Could not load token thresholds:', error.message);
    }
  }

  /**
   * Save token thresholds to SystemSettings
   */
  async saveTokenThresholds() {
    try {
      await SystemSettings.setSetting(
        'tokenAlertThresholds',
        this.tokenThresholds,
        'Token usage alert thresholds by provider',
        'monitoring'
      );
      logger.debug('Saved token thresholds to SystemSettings');
    } catch (error) {
      logger.error('Failed to save token thresholds:', error.message);
    }
  }

  /**
   * Get current threshold configuration
   */
  async getThresholds() {
    try {
      return {
        success: true,
        thresholds: {
          temperature: this.temperatureThresholds,
          cpu: this.cpuThresholds,
          memory: this.memoryThresholds,
          disk: this.diskThresholds,
          token: this.tokenThresholds
        }
      };
    } catch (error) {
      logger.error('Error retrieving thresholds:', error);
      return {
        success: false,
        error: 'Failed to retrieve thresholds'
      };
    }
  }

  /**
   * Update threshold configuration through plugin action
   */
  async updateThresholdsAction(data) {
    const { type, thresholds } = data;
    
    // Validate input
    if (!type || !thresholds) {
      return {
        success: false,
        error: 'Missing required parameters: type and thresholds'
      };
    }
    
    // Update thresholds based on type
    const result = this.updateThresholds(type, thresholds);
    
    if (result.success) {
      return {
        success: true,
        message: `Thresholds updated for ${type}`,
        thresholds: result.thresholds
      };
    } else {
      return {
        success: false,
        error: result.error
      };
    }
  }


  /**
   * Update threshold configuration
   */
  updateThresholds(type, thresholds) {
    try {
      // Validate thresholds structure
      if (typeof thresholds !== 'object' || thresholds === null) {
        return { success: false, error: 'Thresholds must be an object' };
      }
      
      // Validate warning and critical values
      if (thresholds.warning !== undefined && (typeof thresholds.warning !== 'number' || thresholds.warning < 0 || thresholds.warning > 100)) {
        return { success: false, error: 'Warning threshold must be a number between 0 and 100' };
      }
      
      if (thresholds.critical !== undefined && (typeof thresholds.critical !== 'number' || thresholds.critical < 0 || thresholds.critical > 100)) {
        return { success: false, error: 'Critical threshold must be a number between 0 and 100' };
      }
      
      // Validate warning < critical relationship
      const warning = thresholds.warning !== undefined ? thresholds.warning : this[`${type}Thresholds`].warning;
      const critical = thresholds.critical !== undefined ? thresholds.critical : this[`${type}Thresholds`].critical;
      
      if (warning >= critical) {
        return { success: false, error: 'Warning threshold must be less than critical threshold' };
      }
      
      // Update thresholds
      switch (type) {
        case 'temperature':
          if (thresholds.warning !== undefined) this.temperatureThresholds.warning = thresholds.warning;
          if (thresholds.critical !== undefined) this.temperatureThresholds.critical = thresholds.critical;
          return { success: true, thresholds: this.temperatureThresholds };
          
        case 'cpu':
          if (thresholds.warning !== undefined) this.cpuThresholds.warning = thresholds.warning;
          if (thresholds.critical !== undefined) this.cpuThresholds.critical = thresholds.critical;
          return { success: true, thresholds: this.cpuThresholds };
          
        case 'memory':
          if (thresholds.warning !== undefined) this.memoryThresholds.warning = thresholds.warning;
          if (thresholds.critical !== undefined) this.memoryThresholds.critical = thresholds.critical;
          return { success: true, thresholds: this.memoryThresholds };
          
        case 'disk':
          if (thresholds.warning !== undefined) this.diskThresholds.warning = thresholds.warning;
          if (thresholds.critical !== undefined) this.diskThresholds.critical = thresholds.critical;
          return { success: true, thresholds: this.diskThresholds };
          
        default:
          return { success: false, error: `Unknown threshold type: ${type}` };
      }
    } catch (error) {
      logger.error(`Error updating ${type} thresholds:`, error);
      return { success: false, error: `Failed to update ${type} thresholds` };
    }
  }

  async execute(params) {
    const { action, ...data } = params;
    
    this.validateParams(params, {
      action: { 
        required: true, 
        type: 'string',
        enum: ['temperature', 'performance', 'health', 'alerts', 'history', 'gpu', 'getThresholds', 'updateThresholds', 'tokens', 'setTokenAlert', 'getTokenThresholds', 'setTokenThresholds']
      }
    });
    
    switch (action) {
      case 'temperature':
        return await this.getTemperature();
      case 'performance':
        return await this.getPerformance();
      case 'health':
        return await this.getSystemHealth();
      case 'alerts':
        return await this.getAlerts();
      case 'history':
        return await this.getHistory(data);
      case 'gpu':
        return await this.getGpuInfo();
      case 'getThresholds':
        return await this.getThresholds();
      case 'updateThresholds':
        return await this.updateThresholdsAction(data);
      case 'tokens':
        const provider = data.provider || 'all';
        const days = data.days || 7;
        return await this.getTokenUsage(provider, days);
      case 'setTokenAlert':
        if (!data.provider || !data.type || !data.threshold) {
          return {
            success: false,
            error: 'Missing required parameters: provider, type, threshold'
          };
        }
        return await this.setTokenAlertThreshold(data.provider, data.type, data.threshold);
      case 'getTokenThresholds':
        return {
          success: true,
          thresholds: this.tokenThresholds
        };
      case 'setTokenThresholds':
        return await this.setAllTokenThresholds(data.thresholds);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async getTemperature() {
    try {
      const temps = await si.cpuTemperature();
      const currentTemp = temps.main || 0;
      
      // Check thresholds
      let status = 'normal';
      if (currentTemp >= this.temperatureThresholds.critical) {
        status = 'critical';
      } else if (currentTemp >= this.temperatureThresholds.warning) {
        status = 'warning';
      }
      
      const result = {
        success: true,
        temperature: {
          current: currentTemp,
          status,
          unit: 'C',
          cores: temps.cores || [],
          max: temps.max || currentTemp
        },
        thresholds: this.temperatureThresholds
      };
      
      // Alert if critical
      if (status === 'critical') {
        await this.sendTemperatureAlert(currentTemp, 'critical');
      } else if (status === 'warning') {
        await this.sendTemperatureAlert(currentTemp, 'warning');
      }
      
      return result;
    } catch (error) {
      logger.error('Temperature monitoring error:', error);
      return {
        success: false,
        error: 'Unable to read CPU temperature',
        message: 'This may require lm-sensors on Linux or running with appropriate permissions'
      };
    }
  }

  /**
   * Get GPU information including temperature, utilization, and memory usage
   * @returns {Object} GPU information
   */
  async getGpuInfo() {
    try {
      const graphics = await si.graphics();
      const gpus = graphics.controllers.map(gpu => {
        return {
          model: gpu.model,
          vendor: gpu.vendor,
          vram: gpu.vram,
          temperature: gpu.temperatureGpu || null,
          utilization: gpu.utilizationGpu || null,
          memoryUsed: gpu.memoryUsed || null,
          memoryFree: gpu.memoryFree || null,
          memoryTotal: gpu.memoryTotal || null,
          fanSpeed: gpu.fanSpeed || null,
          powerDraw: gpu.powerDraw || null,
          powerLimit: gpu.powerLimit || null
        };
      });

      return {
        success: true,
        gpus: gpus,
        count: gpus.length
      };
    } catch (error) {
      logger.error('GPU monitoring error:', error);
      return {
        success: false,
        error: 'Unable to retrieve GPU information',
        message: error.message
      };
    }
  }

  async getPerformance() {
    try {
      const [cpu, mem, disk, network, processes, gpu] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.networkStats(),
        si.processes(),
        this.getGpuInfo()
      ]);
      
      return {
        success: true,
        performance: {
          cpu: {
            usage: cpu.currentLoad,
            cores: cpu.cpus?.map(c => c.load) || [],
            temperature: await this.getTemperature()
          },
          memory: {
            used: mem.used,
            total: mem.total,
            percent: (mem.used / mem.total * 100).toFixed(2),
            available: mem.available
          },
          disk: disk.map(d => ({
            fs: d.fs,
            mount: d.mount,
            used: d.used,
            size: d.size,
            percent: d.use
          })),
          network: network.map(n => ({
            iface: n.iface,
            rx_sec: n.rx_sec,
            tx_sec: n.tx_sec
          })),
          processes: {
            all: processes.all,
            running: processes.running,
            sleeping: processes.sleeping,
            blocked: processes.blocked
          },
          gpu: gpu.success ? gpu.gpus : null
        }
      };
    } catch (error) {
      logger.error('Performance monitoring error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getSystemHealth() {
    try {
      const [temp, perf, system, gpu] = await Promise.all([
        this.getTemperature(),
        this.getPerformance(),
        si.system(),
        this.getGpuInfo()
      ]);
      
      const health = {
        status: 'healthy',
        issues: [],
        metrics: {}
      };
      
      // Check temperature
      if (temp.temperature?.status === 'critical') {
        health.status = 'critical';
        health.issues.push(`CPU temperature critical: ${temp.temperature.current}°C`);
      } else if (temp.temperature?.status === 'warning') {
        health.status = 'warning';
        health.issues.push(`CPU temperature warning: ${temp.temperature.current}°C`);
      }
      
      // Check CPU
      const cpuUsage = perf.performance?.cpu?.usage || 0;
      if (cpuUsage > this.cpuThresholds.critical) {
        health.status = 'critical';
        health.issues.push(`CPU usage critical: ${cpuUsage.toFixed(2)}%`);
      } else if (cpuUsage > this.cpuThresholds.warning) {
        health.status = health.status === 'critical' ? 'critical' : 'warning';
        health.issues.push(`CPU usage high: ${cpuUsage.toFixed(2)}%`);
      }
      
      // Check memory
      const memPercent = perf.performance?.memory?.percent || 0;
      if (memPercent > this.memoryThresholds.critical) {
        health.status = 'critical';
        health.issues.push(`Memory usage critical: ${memPercent}%`);
      } else if (memPercent > this.memoryThresholds.warning) {
        health.status = health.status === 'critical' ? 'critical' : 'warning';
        health.issues.push(`Memory usage high: ${memPercent}%`);
      }
      
      // Check disk
      perf.performance?.disk?.forEach(disk => {
        if (disk.percent > this.diskThresholds.critical) {
          health.status = 'critical';
          health.issues.push(`Disk ${disk.mount} usage critical: ${disk.percent}%`);
        } else if (disk.percent > this.diskThresholds.warning) {
          health.status = health.status === 'critical' ? 'critical' : 'warning';
          health.issues.push(`Disk ${disk.mount} usage high: ${disk.percent}%`);
        }
      });
      
      // Check GPU temperature if available
      if (gpu.success && gpu.gpus.length > 0) {
        gpu.gpus.forEach((gpuInfo, index) => {
          if (gpuInfo.temperature) {
            if (gpuInfo.temperature > 85) {
              health.status = 'critical';
              health.issues.push(`GPU ${index} temperature critical: ${gpuInfo.temperature}°C`);
            } else if (gpuInfo.temperature > 75) {
              health.status = health.status === 'critical' ? 'critical' : 'warning';
              health.issues.push(`GPU ${index} temperature warning: ${gpuInfo.temperature}°C`);
            }
          }
        });
      }
      
      health.metrics = {
        temperature: temp.temperature?.current,
        cpu: cpuUsage,
        memory: memPercent,
        uptime: process.uptime()
      };
      
      // Add GPU metrics if available
      if (gpu.success && gpu.gpus.length > 0) {
        health.metrics.gpu = gpu.gpus.map(g => ({
          temperature: g.temperature,
          utilization: g.utilization
        }));
      }
      
      return {
        success: true,
        health,
        system: {
          manufacturer: system.manufacturer,
          model: system.model,
          version: system.version
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAlerts() {
    // Return recent alerts from memory
    const alerts = Object.entries(this.lastAlert).map(([type, data]) => ({
      type,
      ...data
    }));
    
    return {
      success: true,
      alerts,
      count: alerts.length
    };
  }

  async getHistory(params) {
    // This would retrieve from database in production
    // For now, return current snapshot
    const snapshot = await this.getPerformance();
    
    return {
      success: true,
      history: [{
        timestamp: new Date(),
        ...snapshot.performance
      }],
      message: 'Historical data requires database implementation'
    };
  }

  startTemperatureMonitoring() {
    // Check temperature every 5 minutes
    setInterval(async () => {
      try {
        const result = await this.getTemperature();
        if (result.temperature?.status !== 'normal') {
          logger.warn(`CPU temperature ${result.temperature.status}: ${result.temperature.current}°C`);
        }
      } catch (error) {
        logger.error('Temperature monitoring interval error:', error);
      }
    }, 5 * 60 * 1000);
  }

  async sendTemperatureAlert(temperature, level) {
    const now = Date.now();
    const lastAlertTime = this.lastAlert[`temp_${level}`]?.time || 0;
    
    // Don't spam alerts - wait at least 30 minutes between same level
    if (now - lastAlertTime < 30 * 60 * 1000) {
      return;
    }
    
    this.lastAlert[`temp_${level}`] = {
      time: now,
      temperature,
      level
    };
    
    const emoji = level === 'critical' ? '🔥' : '⚠️';
    const message = `${emoji} CPU Temperature ${level.toUpperCase()}: ${temperature}°C`;
    
    // Send notification
    try {
      await this.notify(message);
      logger.warn(`Temperature alert sent: ${message}`);
    } catch (error) {
      logger.error('Failed to send temperature alert:', error);
    }
  }

  // Public methods for direct access
  async checkTemperature() {
    return await this.getTemperature();
  }

  async checkHealth() {
    return await this.getSystemHealth();
  }

  /**
   * Start monitoring token usage
   */
  startTokenMonitoring() {
    // Check token usage every 30 minutes
    this.tokenCheckInterval = setInterval(async () => {
      try {
        await this.checkTokenUsage();
      } catch (error) {
        logger.error('Token monitoring error:', error);
      }
    }, 30 * 60 * 1000);
    
    // Initial check
    this.checkTokenUsage();
  }

  /**
   * Check token usage against thresholds
   */
  async checkTokenUsage() {
    try {
      // Only check the currently active provider, not all providers
      let activeProvider = 'openai'; // default

      try {
        // Get the current active provider from the agent
        if (this.agent?.providerManager?.activeProvider?.name) {
          activeProvider = this.agent.providerManager.activeProvider.name.toLowerCase();
        }
      } catch (e) {
        logger.debug('Could not get active provider, using default:', e.message);
      }

      // Only check the active provider to avoid alerts for unused providers
      const providers = [activeProvider];

      for (const provider of providers) {
        // Skip if no threshold defined for this provider
        if (!this.tokenThresholds.daily[provider]) {
          continue;
        }

        // Check daily usage
        const dailyMetrics = await TokenUsage.getDailyMetrics(provider, 1);
        if (dailyMetrics.length > 0) {
          const todayUsage = dailyMetrics[0].totalTokens || 0;
          const dailyThreshold = this.tokenThresholds.daily[provider];

          if (todayUsage > dailyThreshold) {
            await this.sendTokenAlert(provider, 'daily', todayUsage, dailyThreshold);
          }
        }

        // Check total usage (last 30 days)
        const totalMetrics = await TokenUsage.getDailyMetrics(provider, 30);
        const totalUsage = totalMetrics.reduce((sum, day) => sum + (day.totalTokens || 0), 0);
        const totalThreshold = this.tokenThresholds.total[provider];

        if (totalUsage > totalThreshold) {
          await this.sendTokenAlert(provider, 'total', totalUsage, totalThreshold);
        }
      }
    } catch (error) {
      logger.error('Error checking token usage:', error);
    }
  }

  /**
   * Send token usage alert
   */
  async sendTokenAlert(provider, type, usage, threshold) {
    const now = Date.now();
    const alertKey = `token_${provider}_${type}`;
    const lastAlertTime = this.lastAlert[alertKey]?.time || 0;

    // Don't spam alerts - wait at least 2 hours between same alerts
    if (now - lastAlertTime < 2 * 60 * 60 * 1000) {
      return;
    }

    this.lastAlert[alertKey] = { time: now };

    // Persist alert times to database to survive restarts
    try {
      const { Agent } = await import('../../models/Agent.js');
      await Agent.findOneAndUpdate(
        { name: process.env.AGENT_NAME || 'LANAgent' },
        { $set: { 'pluginData.monitoring.lastAlertTimes': this.lastAlert } },
        { upsert: true }
      );
    } catch (error) {
      logger.debug('Could not persist alert times:', error.message);
    }

    const message = `⚠️ Token Usage Alert: ${provider} ${type} usage (${usage.toLocaleString()}) exceeded threshold (${threshold.toLocaleString()})`;

    // Send notification through agent
    if (this.agent) {
      await this.agent.notify(message, 'warning');
    }

    logger.warn(message);
  }

  /**
   * Get token usage metrics
   */
  async getTokenUsage(provider = 'all', days = 7) {
    try {
      const providers = provider === 'all' ? ['anthropic', 'openai', 'gab', 'ollama', 'bitnet'] : [provider];
      const results = {};
      
      for (const p of providers) {
        const metrics = await TokenUsage.getDailyMetrics(p, days);
        results[p] = {
          daily: metrics,
          total: metrics.reduce((sum, day) => sum + (day.totalTokens || 0), 0),
          threshold: {
            daily: this.tokenThresholds.daily[p],
            total: this.tokenThresholds.total[p]
          }
        };
      }
      
      return {
        success: true,
        usage: results
      };
    } catch (error) {
      logger.error('Error getting token usage:', error);
      return {
        success: false,
        error: 'Failed to get token usage'
      };
    }
  }

  /**
   * Set token alert threshold
   */
  async setTokenAlertThreshold(provider, type, threshold) {
    if (!this.tokenThresholds[type] || !this.tokenThresholds[type][provider]) {
      return {
        success: false,
        error: `Invalid provider or type. Valid providers: anthropic, openai, gab, ollama, bitnet. Valid types: daily, total`
      };
    }

    if (typeof threshold !== 'number' || threshold <= 0) {
      return {
        success: false,
        error: 'Threshold must be a positive number'
      };
    }

    this.tokenThresholds[type][provider] = threshold;

    // Persist to SystemSettings
    await this.saveTokenThresholds();

    return {
      success: true,
      message: `Set ${provider} ${type} threshold to ${threshold.toLocaleString()}`
    };
  }

  /**
   * Set all token thresholds at once
   */
  async setAllTokenThresholds(thresholds) {
    try {
      // Validate input
      if (!thresholds || typeof thresholds !== 'object') {
        return { success: false, error: 'Invalid thresholds object' };
      }

      // Update daily thresholds
      if (thresholds.daily && typeof thresholds.daily === 'object') {
        for (const [provider, value] of Object.entries(thresholds.daily)) {
          if (this.tokenThresholds.daily.hasOwnProperty(provider) && typeof value === 'number' && value > 0) {
            this.tokenThresholds.daily[provider] = value;
          }
        }
      }

      // Update total thresholds
      if (thresholds.total && typeof thresholds.total === 'object') {
        for (const [provider, value] of Object.entries(thresholds.total)) {
          if (this.tokenThresholds.total.hasOwnProperty(provider) && typeof value === 'number' && value > 0) {
            this.tokenThresholds.total[provider] = value;
          }
        }
      }

      // Persist to SystemSettings
      await this.saveTokenThresholds();

      return {
        success: true,
        message: 'Token thresholds updated successfully',
        thresholds: this.tokenThresholds
      };
    } catch (error) {
      logger.error('Failed to set token thresholds:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cleanup intervals
   */
  async cleanup() {
    if (this.tokenCheckInterval) {
      clearInterval(this.tokenCheckInterval);
    }
  }
}