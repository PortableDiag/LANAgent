import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { UpsConfig } from '../../models/UpsConfig.js';
import { UpsEvent } from '../../models/UpsEvent.js';

/**
 * UPS Plugin
 * Provides user interaction for UPS monitoring and management
 */
export default class UpsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'ups';
    this.version = '1.0.0';
    this.description = 'Monitor and manage UPS power devices using NUT (Network UPS Tools)';

    this.commands = [
      {
        command: 'status',
        description: 'Get current UPS status',
        usage: 'status() or status({ upsName: "ups" })',
        examples: ['check ups status', 'what is my ups status', 'how much battery']
      },
      {
        command: 'list',
        description: 'List all configured UPS devices',
        usage: 'list()',
        examples: ['list ups devices', 'show all ups']
      },
      {
        command: 'history',
        description: 'Get power event history',
        usage: 'history({ hours: 24 })',
        examples: ['show power events', 'ups history', 'recent power outages']
      },
      {
        command: 'configure',
        description: 'Configure UPS monitoring settings',
        usage: 'configure({ upsName: "ups", enabled: true, thresholds: {...} })',
        examples: ['configure ups', 'set ups thresholds']
      },
      {
        command: 'test',
        description: 'Run UPS self-test (if supported)',
        usage: 'test({ upsName: "ups" })',
        examples: ['test ups battery', 'run ups test']
      },
      {
        command: 'acknowledge',
        description: 'Acknowledge a power event',
        usage: 'acknowledge({ eventId: "xxx" })',
        examples: ['acknowledge event', 'clear ups alert']
      }
    ];
  }

  async initialize() {
    logger.info('UPS plugin initialized');
    return true;
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'status':
        return await this.getStatus(data);
      case 'list':
        return await this.listDevices();
      case 'history':
        return await this.getHistory(data);
      case 'configure':
        return await this.configure(data);
      case 'test':
        return await this.testUps(data);
      case 'acknowledge':
        return await this.acknowledgeEvent(data);
      case 'stats':
        return await this.getStats();
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Get UPS status
   */
  async getStatus(params = {}) {
    try {
      const upsService = this.agent?.services?.get('upsService');

      if (params.upsName) {
        // Get specific UPS
        if (upsService) {
          return await upsService.getStatus(params.upsName);
        }
        const config = await UpsConfig.findOne({ upsName: params.upsName });
        if (!config) {
          return { success: false, error: `UPS not found: ${params.upsName}` };
        }
        return {
          success: true,
          upsName: config.upsName,
          status: config.lastStatus,
          cached: true
        };
      }

      // Get all UPS status
      if (upsService) {
        const statuses = await upsService.getAllStatus();
        return { success: true, devices: statuses };
      }

      const configs = await UpsConfig.find({}).lean();
      return {
        success: true,
        devices: configs.map(c => ({
          upsName: c.upsName,
          displayName: c.displayName,
          status: c.lastStatus,
          lastPollAt: c.lastPollAt
        }))
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * List all configured UPS devices
   */
  async listDevices() {
    try {
      const configs = await UpsConfig.find({}).lean();
      return {
        success: true,
        count: configs.length,
        devices: configs.map(c => ({
          upsName: c.upsName,
          displayName: c.displayName,
          host: c.host,
          enabled: c.enabled,
          lastPollAt: c.lastPollAt,
          lastError: c.lastError
        }))
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get power event history
   */
  async getHistory(params = {}) {
    try {
      const hours = params.hours || 24;
      const upsName = params.upsName || null;

      const events = await UpsEvent.getRecentEvents(hours, upsName);

      return {
        success: true,
        hours,
        count: events.length,
        events: events.map(e => ({
          eventId: e.eventId,
          upsName: e.upsName,
          eventType: e.eventType,
          severity: e.severity,
          message: e.message,
          createdAt: e.createdAt,
          resolvedAt: e.resolvedAt,
          duration: e.duration,
          acknowledged: e.acknowledged
        }))
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Configure UPS monitoring
   */
  async configure(params) {
    try {
      const { upsName, ...settings } = params;
      if (!upsName) {
        return { success: false, error: 'upsName is required' };
      }

      let config = await UpsConfig.findOne({ upsName });
      if (!config) {
        config = new UpsConfig({ upsName });
      }

      // Update allowed settings
      if (settings.displayName !== undefined) config.displayName = settings.displayName;
      if (settings.enabled !== undefined) config.enabled = settings.enabled;
      if (settings.pollInterval !== undefined) config.pollInterval = settings.pollInterval;
      if (settings.thresholds) Object.assign(config.thresholds, settings.thresholds);
      if (settings.notifications) Object.assign(config.notifications, settings.notifications);
      if (settings.autoShutdown) Object.assign(config.autoShutdown, settings.autoShutdown);
      if (settings.mqtt) Object.assign(config.mqtt, settings.mqtt);

      await config.save();

      // Restart monitoring if service is available
      const upsService = this.agent?.services?.get('upsService');
      if (upsService && config.enabled) {
        upsService.startMonitoring(upsName, config.pollInterval);
      } else if (upsService && !config.enabled) {
        upsService.stopMonitoring(upsName);
      }

      return {
        success: true,
        message: `UPS ${upsName} configuration updated`,
        config: {
          upsName: config.upsName,
          displayName: config.displayName,
          enabled: config.enabled,
          pollInterval: config.pollInterval,
          thresholds: config.thresholds,
          notifications: config.notifications,
          autoShutdown: config.autoShutdown
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Run UPS self-test
   */
  async testUps(params) {
    // Note: This requires upsrw or upscmd which may not be available
    return {
      success: false,
      message: 'UPS self-test requires upscmd with write access to UPS. Please run manually: upscmd ups test.battery.start'
    };
  }

  /**
   * Acknowledge an event
   */
  async acknowledgeEvent(params) {
    try {
      const { eventId } = params;
      if (!eventId) {
        return { success: false, error: 'eventId is required' };
      }

      const event = await UpsEvent.acknowledgeEvent(eventId, 'user');
      if (!event) {
        return { success: false, error: `Event not found: ${eventId}` };
      }

      return {
        success: true,
        message: `Event ${eventId} acknowledged`,
        event: {
          eventId: event.eventId,
          eventType: event.eventType,
          acknowledged: event.acknowledged,
          acknowledgedAt: event.acknowledgedAt
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get UPS monitoring stats
   */
  async getStats() {
    try {
      const upsService = this.agent?.services?.get('upsService');
      const serviceStats = upsService ? upsService.getStats() : { enabled: false, nutAvailable: false };
      const eventStats = await UpsEvent.getStats(30);

      return {
        success: true,
        service: serviceStats,
        events: eventStats
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Natural language handler
   */
  async handleNaturalLanguage(query) {
    const lowerQuery = query.toLowerCase();

    // Status queries
    if (lowerQuery.match(/(?:ups|battery|power)\s*(?:status|level|charge|state)/i) ||
        lowerQuery.match(/how\s*(?:much|is)\s*(?:the\s*)?(?:ups|battery)/i) ||
        lowerQuery.match(/check\s*(?:the\s*)?(?:ups|battery|power)/i) ||
        lowerQuery.match(/what['']?s\s*(?:the\s*)?(?:ups|battery)/i)) {
      return await this.getStatus();
    }

    // Runtime query
    if (lowerQuery.match(/(?:how\s*(?:much|long)|what['']?s)\s*(?:the\s*)?(?:ups\s*)?(?:runtime|time\s*left|remaining)/i)) {
      const status = await this.getStatus();
      if (status.success && status.devices?.length > 0) {
        const device = status.devices[0];
        const runtime = device.status?.batteryRuntime;
        if (runtime) {
          return {
            success: true,
            message: `UPS runtime remaining: ${Math.round(runtime / 60)} minutes`,
            runtime: runtime
          };
        }
      }
      return status;
    }

    // On battery check
    if (lowerQuery.match(/is\s*(?:the\s*)?(?:ups|power)\s*(?:on\s*)?battery/i) ||
        lowerQuery.match(/(?:power|ups)\s*(?:out|outage|failure)/i)) {
      const status = await this.getStatus();
      if (status.success && status.devices?.length > 0) {
        const device = status.devices[0];
        const upsStatus = device.status?.status || '';
        const onBattery = upsStatus.includes('OB');
        return {
          success: true,
          onBattery,
          message: onBattery ? 'Yes, UPS is running on battery power' : 'No, UPS is on utility power',
          status: device.status
        };
      }
      return status;
    }

    // Load query
    if (lowerQuery.match(/(?:ups|power)\s*load/i) ||
        lowerQuery.match(/how\s*(?:much|heavy)\s*(?:is\s*)?(?:the\s*)?(?:ups\s*)?load/i)) {
      const status = await this.getStatus();
      if (status.success && status.devices?.length > 0) {
        const device = status.devices[0];
        const load = device.status?.load;
        if (load !== undefined) {
          return {
            success: true,
            message: `UPS load: ${load}%`,
            load: load
          };
        }
      }
      return status;
    }

    // History / events
    if (lowerQuery.match(/(?:power|ups)\s*(?:event|history|log|outage)/i) ||
        lowerQuery.match(/(?:show|list|get)\s*(?:power|ups)\s*(?:event|history)/i) ||
        lowerQuery.match(/recent\s*(?:power|ups)/i)) {
      return await this.getHistory({ hours: 48 });
    }

    // List UPS devices
    if (lowerQuery.match(/list\s*(?:all\s*)?(?:ups|power)/i) ||
        lowerQuery.match(/(?:what|show)\s*(?:ups|power)\s*devices/i)) {
      return await this.listDevices();
    }

    // Default - show status
    if (lowerQuery.includes('ups') || lowerQuery.includes('battery') || lowerQuery.includes('power')) {
      return await this.getStatus();
    }

    return {
      success: true,
      message: "I can help with UPS monitoring. Try:",
      capabilities: [
        "What's my UPS status?",
        "How much battery is left?",
        "Is the UPS on battery?",
        "Show power events",
        "What's the UPS load?"
      ]
    };
  }

  /**
   * Web UI configuration
   */
  getUIConfig() {
    return {
      menuItem: {
        id: 'ups',
        title: 'UPS Monitor',
        icon: 'fas fa-car-battery',
        order: 75,
        section: 'main'
      },
      hasUI: true
    };
  }

  /**
   * Web UI content
   */
  getUIContent() {
    return `
      <style>
        .ups-container { padding: 1rem; }
        .ups-status-card {
          background: var(--bg-secondary);
          border-radius: 12px;
          padding: 1.5rem;
          margin-bottom: 1rem;
        }
        .ups-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }
        .ups-title { font-size: 1.25rem; font-weight: 600; }
        .ups-status-badge {
          padding: 0.25rem 0.75rem;
          border-radius: 20px;
          font-size: 0.875rem;
          font-weight: 500;
        }
        .ups-status-online { background: #22c55e20; color: #22c55e; }
        .ups-status-battery { background: #f59e0b20; color: #f59e0b; }
        .ups-status-critical { background: #ef444420; color: #ef4444; }
        .ups-status-offline { background: #6b728020; color: #6b7280; }
        .ups-metrics {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 1rem;
        }
        .ups-metric {
          text-align: center;
          padding: 1rem;
          background: var(--bg-tertiary);
          border-radius: 8px;
        }
        .ups-metric-value {
          font-size: 1.75rem;
          font-weight: 700;
          color: var(--accent);
        }
        .ups-metric-label {
          font-size: 0.75rem;
          color: var(--text-secondary);
          margin-top: 0.25rem;
        }
        .ups-battery-bar {
          height: 8px;
          background: var(--bg-tertiary);
          border-radius: 4px;
          margin-top: 1rem;
          overflow: hidden;
        }
        .ups-battery-fill {
          height: 100%;
          border-radius: 4px;
          transition: width 0.3s ease;
        }
        .ups-battery-good { background: #22c55e; }
        .ups-battery-warning { background: #f59e0b; }
        .ups-battery-critical { background: #ef4444; }
        .ups-events { margin-top: 1.5rem; }
        .ups-event {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 0.75rem;
          background: var(--bg-tertiary);
          border-radius: 8px;
          margin-bottom: 0.5rem;
        }
        .ups-event-icon { font-size: 1.25rem; }
        .ups-event-info { flex: 1; }
        .ups-event-type { font-weight: 500; }
        .ups-event-time { font-size: 0.75rem; color: var(--text-secondary); }
        .ups-loading { text-align: center; padding: 2rem; color: var(--text-secondary); }
        .ups-error { color: #ef4444; padding: 1rem; text-align: center; }
        .ups-not-available {
          text-align: center;
          padding: 3rem;
          color: var(--text-secondary);
        }
        .ups-not-available i { font-size: 3rem; margin-bottom: 1rem; opacity: 0.5; }
      </style>

      <div class="ups-container">
        <div class="plugin-header">
          <h2><i class="fas fa-car-battery"></i> UPS Monitor</h2>
          <button class="btn btn-secondary" onclick="upsRefresh()">
            <i class="fas fa-sync-alt"></i> Refresh
          </button>
        </div>

        <div id="ups-content">
          <div class="ups-loading">
            <i class="fas fa-spinner fa-spin"></i> Loading UPS status...
          </div>
        </div>

        <div class="ups-events">
          <h3>Recent Power Events</h3>
          <div id="ups-events-list">
            <div class="ups-loading">Loading events...</div>
          </div>
        </div>
      </div>

      <script>
        (function() {
          const apiToken = localStorage.getItem('lanagent_token');

          async function fetchUpsStatus() {
            try {
              const response = await fetch('/api/plugin', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + apiToken,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ plugin: 'ups', action: 'status' })
              });
              return await response.json();
            } catch (error) {
              return { success: false, error: error.message };
            }
          }

          async function fetchUpsEvents() {
            try {
              const response = await fetch('/api/plugin', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + apiToken,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ plugin: 'ups', action: 'history', hours: 48 })
              });
              return await response.json();
            } catch (error) {
              return { success: false, error: error.message };
            }
          }

          function getStatusBadge(status) {
            if (!status) return '<span class="ups-status-badge ups-status-offline">Unknown</span>';
            const statusStr = status.status || '';
            if (statusStr.includes('OB') && statusStr.includes('LB')) {
              return '<span class="ups-status-badge ups-status-critical">Low Battery</span>';
            }
            if (statusStr.includes('OB')) {
              return '<span class="ups-status-badge ups-status-battery">On Battery</span>';
            }
            if (statusStr.includes('OL')) {
              return '<span class="ups-status-badge ups-status-online">Online</span>';
            }
            return '<span class="ups-status-badge ups-status-offline">' + (status.statusDescription || statusStr) + '</span>';
          }

          function getBatteryClass(charge) {
            if (charge > 50) return 'ups-battery-good';
            if (charge > 20) return 'ups-battery-warning';
            return 'ups-battery-critical';
          }

          function formatRuntime(seconds) {
            if (!seconds) return '--';
            const mins = Math.floor(seconds / 60);
            if (mins < 60) return mins + ' min';
            const hours = Math.floor(mins / 60);
            const remainMins = mins % 60;
            return hours + 'h ' + remainMins + 'm';
          }

          function renderUpsStatus(data) {
            const content = document.getElementById('ups-content');

            if (!data.success) {
              content.innerHTML = '<div class="ups-error"><i class="fas fa-exclamation-triangle"></i> ' + (data.error || 'Failed to load UPS status') + '</div>';
              return;
            }

            const devices = data.devices || [];
            if (devices.length === 0) {
              content.innerHTML = '<div class="ups-not-available"><i class="fas fa-car-battery"></i><p>No UPS devices configured</p><p>Make sure NUT is installed and configured on the server</p></div>';
              return;
            }

            let html = '';
            for (const device of devices) {
              const status = device.status || device.lastStatus || {};
              const charge = status.batteryCharge;
              const runtime = status.batteryRuntime;
              const load = status.load;
              const inputV = status.inputVoltage;
              const outputV = status.outputVoltage;

              html += '<div class="ups-status-card">';
              html += '<div class="ups-header">';
              html += '<div class="ups-title">' + (device.displayName || device.upsName) + '</div>';
              html += getStatusBadge(status);
              html += '</div>';

              html += '<div class="ups-metrics">';
              if (charge !== undefined) {
                html += '<div class="ups-metric"><div class="ups-metric-value">' + charge + '%</div><div class="ups-metric-label">Battery</div></div>';
              }
              if (runtime !== undefined) {
                html += '<div class="ups-metric"><div class="ups-metric-value">' + formatRuntime(runtime) + '</div><div class="ups-metric-label">Runtime</div></div>';
              }
              if (load !== undefined) {
                html += '<div class="ups-metric"><div class="ups-metric-value">' + load + '%</div><div class="ups-metric-label">Load</div></div>';
              }
              if (inputV !== undefined) {
                html += '<div class="ups-metric"><div class="ups-metric-value">' + Math.round(inputV) + 'V</div><div class="ups-metric-label">Input</div></div>';
              }
              html += '</div>';

              if (charge !== undefined) {
                html += '<div class="ups-battery-bar"><div class="ups-battery-fill ' + getBatteryClass(charge) + '" style="width: ' + charge + '%"></div></div>';
              }

              html += '</div>';
            }

            content.innerHTML = html;
          }

          function getEventIcon(eventType) {
            const icons = {
              'power_loss': '⚡',
              'on_battery': '🔋',
              'low_battery': '🪫',
              'battery_critical': '🚨',
              'power_restored': '✅',
              'communication_lost': '📡',
              'overload': '⚠️'
            };
            return icons[eventType] || 'ℹ️';
          }

          function renderEvents(data) {
            const container = document.getElementById('ups-events-list');

            if (!data.success || !data.events || data.events.length === 0) {
              container.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-secondary);">No recent power events</div>';
              return;
            }

            let html = '';
            for (const event of data.events.slice(0, 10)) {
              const time = new Date(event.createdAt).toLocaleString();
              html += '<div class="ups-event">';
              html += '<div class="ups-event-icon">' + getEventIcon(event.eventType) + '</div>';
              html += '<div class="ups-event-info">';
              html += '<div class="ups-event-type">' + (event.message || event.eventType) + '</div>';
              html += '<div class="ups-event-time">' + time + '</div>';
              html += '</div>';
              html += '</div>';
            }

            container.innerHTML = html;
          }

          async function loadUpsData() {
            const [statusData, eventsData] = await Promise.all([
              fetchUpsStatus(),
              fetchUpsEvents()
            ]);
            renderUpsStatus(statusData);
            renderEvents(eventsData);
          }

          window.upsRefresh = loadUpsData;

          // Initial load
          loadUpsData();

          // Auto-refresh every 30 seconds
          setInterval(loadUpsData, 30000);
        })();
      </script>
    `;
  }

  /**
   * HTTP routes
   */
  getRoutes() {
    return [
      {
        method: 'GET',
        path: '/status',
        handler: async () => await this.getStatus()
      },
      {
        method: 'GET',
        path: '/status/:upsName',
        handler: async (data, req) => await this.getStatus({ upsName: req.params.upsName })
      },
      {
        method: 'GET',
        path: '/devices',
        handler: async () => await this.listDevices()
      },
      {
        method: 'GET',
        path: '/events',
        handler: async (data) => await this.getHistory(data)
      },
      {
        method: 'POST',
        path: '/configure',
        handler: async (data) => await this.configure(data)
      },
      {
        method: 'POST',
        path: '/acknowledge/:eventId',
        handler: async (data, req) => await this.acknowledgeEvent({ eventId: req.params.eventId })
      },
      {
        method: 'GET',
        path: '/stats',
        handler: async () => await this.getStats()
      }
    ];
  }
}
