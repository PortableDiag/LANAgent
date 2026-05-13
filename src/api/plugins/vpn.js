import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PluginSettings } from '../../models/PluginSettings.js';

const execAsync = promisify(exec);

/**
 * VPN Management Plugin
 * Dual-provider VPN management:
 *   - WireGuard (wg0): inbound tunnel for api.lanagent.net reverse proxy
 *   - ExpressVPN: outbound privacy for scrapes, API calls, IP hopping
 *
 * wg0.conf PostUp/PostDown hooks handle the coexistence (static route for
 * the WG endpoint + iptables exception for ExpressVPN's kill-switch).
 */
export class VPNPlugin extends BasePlugin {
  constructor() {
    super();
    this.name = 'vpn';
    this.version = '2.0.0';
    this.description = 'Dual VPN management: WireGuard (inbound tunnel) + ExpressVPN (outbound privacy)';
    this.commands = [
      {
        command: 'connect',
        description: 'Connect to VPN with optional location',
        usage: 'connect({ location: "us-den", protocol: "lightway_udp" })'
      },
      {
        command: 'disconnect',
        description: 'Disconnect from VPN',
        usage: 'disconnect()'
      },
      {
        command: 'status',
        description: 'Get current VPN connection status',
        usage: 'status()'
      },
      {
        command: 'list',
        description: 'List all available VPN locations',
        usage: 'list({ filter: "us" })'
      },
      {
        command: 'preferences',
        description: 'Get VPN preferences and settings',
        usage: 'preferences()'
      },
      {
        command: 'switch',
        description: 'Switch to a different VPN location',
        usage: 'switch({ location: "uk-london" })'
      },
      {
        command: 'autoconnect',
        description: 'Configure VPN auto-connect settings',
        usage: 'autoconnect({ enabled: true, location: "smart" })'
      },
      {
        command: 'protocol',
        description: 'Set VPN protocol',
        usage: 'protocol({ protocol: "lightway_udp" })'
      },
      {
        command: 'smart-connect',
        description: 'Connect using smart location selection',
        usage: 'smart-connect()'
      },
      {
        command: 'wireguard-status',
        description: 'Get WireGuard tunnel status (handshake, transfer, endpoint)',
        usage: 'wireguard-status()'
      },
      {
        command: 'wireguard-bounce',
        description: 'Restart WireGuard tunnel (wg-quick down/up)',
        usage: 'wireguard-bounce()'
      },
      {
        command: 'wireguard-health',
        description: 'Check WireGuard tunnel health (handshake age, ping peer)',
        usage: 'wireguard-health()'
      }
    ];
    
    this.config = {
      provider: 'expressvpn', // Currently supports ExpressVPN
      autoConnect: false,  // Agent-level setting: true = maintain connection, false = agent can toggle
      preferredLocations: ['usa', 'canada', 'uk'],
      retryAttempts: 3,
      retryDelay: 5000,
      connectionTimeout: 30000,
      healthCheckInterval: 300000, // 5 minutes
      smartRetry: true
    };
    
    this.connectionState = {
      connected: false,
      currentLocation: null,
      currentProtocol: null,
      connectionTime: null,
      publicIP: null,
      lastHealthCheck: null,
      failures: 0
    };
    
    this.healthCheckInterval = null;
    
    this.methods = [
      {
        name: 'connect',
        description: 'Connect to VPN with optional location',
        parameters: {
          location: { type: 'string', required: false, description: 'VPN server location' },
          protocol: { type: 'string', required: false, description: 'Connection protocol' },
          retry: { type: 'boolean', required: false, description: 'Enable smart retry' }
        }
      },
      {
        name: 'disconnect',
        description: 'Disconnect from VPN',
        parameters: {}
      },
      {
        name: 'status',
        description: 'Get current VPN connection status',
        parameters: {}
      },
      {
        name: 'listLocations',
        description: 'List available VPN server locations',
        parameters: {
          country: { type: 'string', required: false, description: 'Filter by country' }
        }
      },
      {
        name: 'getPublicIP',
        description: 'Get current public IP address',
        parameters: {}
      },
      {
        name: 'testConnection',
        description: 'Test VPN connection and speed',
        parameters: {
          testSites: { type: 'array', required: false, description: 'Sites to test connectivity' }
        }
      },
      {
        name: 'smartConnect',
        description: 'Intelligent connection with automatic location selection',
        parameters: {
          purpose: { type: 'string', required: false, description: 'Connection purpose (streaming, security, speed)' }
        }
      },
      {
        name: 'setAutoConnect',
        description: 'Configure automatic VPN connection',
        parameters: {
          enabled: { type: 'boolean', required: true, description: 'Enable auto-connect' },
          location: { type: 'string', required: false, description: 'Preferred location' }
        }
      },
      {
        name: 'canToggleConnection',
        description: 'Check if agent can toggle VPN connection',
        parameters: {}
      },
      {
        name: 'getConnectionHistory',
        description: 'Get VPN connection history and analytics',
        parameters: {
          days: { type: 'number', required: false, description: 'Number of days to retrieve' }
        }
      },
      {
        name: 'troubleshoot',
        description: 'Run VPN troubleshooting diagnostics',
        parameters: {}
      },
      {
        name: 'wireguardStatus',
        description: 'Get WireGuard tunnel status',
        parameters: {}
      },
      {
        name: 'wireguardBounce',
        description: 'Restart WireGuard tunnel',
        parameters: {}
      },
      {
        name: 'wireguardHealth',
        description: 'Check WireGuard tunnel health and auto-recover if stale',
        parameters: {
          maxHandshakeAge: { type: 'number', required: false, description: 'Max handshake age in seconds before recovery (default 180)' }
        }
      }
    ];
  }

  async initialize() {
    try {
      // Load persisted settings from database
      await this.loadPersistedSettings();
      
      // Check if ExpressVPN is installed
      const isInstalled = await this.checkExpressVPNInstallation();
      if (!isInstalled) {
        logger.warn('ExpressVPN CLI not found - VPN functionality will be limited');
        return false;
      }

      // Get initial connection status
      await this.updateConnectionState();
      
      // Start health monitoring if connected
      if (this.connectionState.connected) {
        this.startHealthMonitoring();
      }

      logger.info('VPN Plugin initialized successfully with autoConnect:', this.config.autoConnect);
      return true;
    } catch (error) {
      logger.error('Failed to initialize VPN Plugin:', error);
      return false;
    }
  }

  async getCommands() {
    return {
      connect: this.connect.bind(this),
      disconnect: this.disconnect.bind(this),
      status: this.getVPNStatus.bind(this),
      listLocations: this.listLocations.bind(this),
      getPublicIP: this.getPublicIP.bind(this),
      testConnection: this.testConnection.bind(this),
      smartConnect: this.smartConnect.bind(this),
      setAutoConnect: this.setAutoConnect.bind(this),
      canToggleConnection: this.canToggleConnection.bind(this),
      getConnectionHistory: this.getConnectionHistory.bind(this),
      troubleshoot: this.troubleshoot.bind(this),
      wireguardStatus: this.getWireguardStatus.bind(this),
      wireguardBounce: this.wireguardBounce.bind(this),
      wireguardHealth: this.wireguardHealth.bind(this)
    };
  }

  // Direct method aliases for API manager (to work with executeAPI calls)
  async status(params) { return await this.getVPNStatus(); }

  async execute(params) {
    const { action, ...args } = params;
    
    try {
      switch (action) {
        case 'connect':
          return await this.connect(args);
        case 'disconnect':
          return await this.disconnect();
        case 'status':
          return await this.getVPNStatus();
        case 'listLocations':
          return await this.listLocations(args);
        case 'getPublicIP':
          return await this.getPublicIP();
        case 'testConnection':
          return await this.testConnection(args);
        case 'smartConnect':
          return await this.smartConnect(args);
        case 'setAutoConnect':
          return await this.setAutoConnect(args);
        case 'canToggleConnection':
          return await this.canToggleConnection(args);
        case 'getConnectionHistory':
          return await this.getConnectionHistory(args);
        case 'troubleshoot':
          return await this.troubleshoot();
        case 'checkUpdate':
        case 'update':
          return await this.checkForUpdate();
        case 'wireguardStatus':
        case 'wireguard-status':
          return await this.getWireguardStatus();
        case 'wireguardBounce':
        case 'wireguard-bounce':
          return await this.wireguardBounce();
        case 'wireguardHealth':
        case 'wireguard-health':
          return await this.wireguardHealth(args);
        default:
          throw new Error(`Unknown VPN action: ${action}`);
      }
    } catch (error) {
      logger.error(`VPN Plugin error in ${action}:`, error);
      throw error;
    }
  }

  /**
   * Load persisted settings from database
   */
  async loadPersistedSettings() {
    try {
      const settings = await PluginSettings.findOne({
        pluginName: this.name,
        settingsKey: 'config'
      });
      
      if (settings && settings.settingsValue) {
        // Merge persisted settings with defaults
        this.config = { ...this.config, ...settings.settingsValue };
        logger.info('Loaded persisted VPN settings:', {
          autoConnect: this.config.autoConnect,
          preferredLocations: this.config.preferredLocations
        });
      }
    } catch (error) {
      logger.error('Failed to load persisted VPN settings:', error);
    }
  }

  /**
   * Save settings to database
   */
  async saveSettings() {
    try {
      await PluginSettings.findOneAndUpdate(
        {
          pluginName: this.name,
          settingsKey: 'config'
        },
        {
          settingsValue: this.config,
          updatedAt: new Date()
        },
        {
          upsert: true,
          new: true
        }
      );
      logger.info('VPN settings saved to database');
    } catch (error) {
      logger.error('Failed to save VPN settings:', error);
    }
  }

  /**
   * Check if ExpressVPN CLI is installed
   */
  async checkExpressVPNInstallation() {
    try {
      const { stdout } = await execAsync('expressvpnctl --version');
      logger.info('ExpressVPN CLI detected:', stdout.trim());
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Connect to VPN
   */
  async connect({ location = null, protocol = null, retry = true }) {
    try {
      const originalLocation = location;
      if (location && location !== 'smart') {
        const resolved = await this.resolveRegion(location);
        if (resolved && resolved !== location) {
          logger.info(`Resolved VPN location "${location}" → "${resolved}"`);
          location = resolved;
        }
      }
      logger.info(`Connecting to VPN${location ? ` (location: ${location})` : ''}`);

      // Disconnect first if already connected
      if (this.connectionState.connected) {
        await this.disconnect();
      }

      // Set protocol if specified
      if (protocol) {
        await execAsync(`expressvpnctl set protocol ${protocol}`);
      }

      let connectCommand = 'expressvpnctl connect';
      if (location) {
        connectCommand += ` "${location}"`;
      }

      const result = await this.executeWithTimeout(connectCommand, this.config.connectionTimeout);
      
      // Wait for connection to establish
      await this.waitForConnection();
      
      // Update connection state
      await this.updateConnectionState();
      
      if (this.connectionState.connected) {
        logger.info(`VPN connected successfully to ${this.connectionState.currentLocation}`);
        this.startHealthMonitoring();
        this.connectionState.failures = 0;
        
        return {
          success: true,
          message: `Connected to VPN (${this.connectionState.currentLocation})`,
          location: this.connectionState.currentLocation,
          protocol: this.connectionState.currentProtocol,
          publicIP: this.connectionState.publicIP,
          connectionTime: this.connectionState.connectionTime
        };
      } else {
        throw new Error('Failed to establish VPN connection');
      }

    } catch (error) {
      this.connectionState.failures++;
      
      if (retry && this.config.smartRetry && this.connectionState.failures < this.config.retryAttempts) {
        logger.warn(`VPN connection failed (attempt ${this.connectionState.failures}), retrying with different location...`);
        
        // Try different location on retry
        const alternativeLocation = await this.getAlternativeLocation(location);
        await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
        
        return await this.connect({ 
          location: alternativeLocation, 
          protocol, 
          retry: false // Prevent infinite recursion
        });
      }

      logger.error('VPN connection failed:', error);
      return {
        success: false,
        error: error.message,
        attempts: this.connectionState.failures
      };
    }
  }

  /**
   * Disconnect from VPN
   */
  async disconnect({ force = false } = {}) {
    try {
      // Check if agent is allowed to disconnect
      if (this.config.autoConnect && !force) {
        logger.warn('VPN disconnect blocked: auto-connect is enabled');
        return {
          success: false,
          message: 'Cannot disconnect VPN when auto-connect is enabled. Agent must maintain connection.',
          autoConnect: true
        };
      }
      
      logger.info('Disconnecting from VPN');
      
      await execAsync('expressvpnctl disconnect');
      
      this.connectionState.connected = false;
      this.connectionState.currentLocation = null;
      this.connectionState.currentProtocol = null;
      this.connectionState.connectionTime = null;
      this.connectionState.publicIP = null;
      
      this.stopHealthMonitoring();
      
      logger.info('VPN disconnected successfully');
      
      return {
        success: true,
        message: 'Disconnected from VPN'
      };
    } catch (error) {
      logger.error('VPN disconnection failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get current VPN status (both providers)
   */
  async getVPNStatus() {
    await this.updateConnectionState();

    let wireguard = null;
    try { wireguard = await this.getWireguardStatus(); } catch { /* optional */ }

    return {
      success: true,
      // ExpressVPN (outbound privacy)
      expressvpn: {
        connected: this.connectionState.connected,
        location: this.connectionState.currentLocation,
        protocol: this.connectionState.currentProtocol,
        connectionTime: this.connectionState.connectionTime,
        publicIP: this.connectionState.publicIP,
        failures: this.connectionState.failures,
        autoConnect: this.config.autoConnect,
        purpose: 'outbound — hides real IP for scrapes, API calls, IP hopping'
      },
      // WireGuard (inbound tunnel)
      wireguard: wireguard ? {
        ...wireguard,
        purpose: 'inbound — reverse-proxy tunnel for api.lanagent.net/api/external/'
      } : null,
      // Legacy flat fields for backward compat
      connected: this.connectionState.connected,
      location: this.connectionState.currentLocation,
      protocol: this.connectionState.currentProtocol,
      connectionTime: this.connectionState.connectionTime,
      publicIP: this.connectionState.publicIP,
      lastHealthCheck: this.connectionState.lastHealthCheck,
      failures: this.connectionState.failures,
      autoConnect: this.config.autoConnect
    };
  }

  /**
   * List available VPN locations
   */
  async listLocations({ country = null }) {
    try {
      const { stdout } = await execAsync('expressvpnctl get regions');
      const locations = this.parseLocationsList(stdout);
      
      let filteredLocations = locations;
      if (country) {
        filteredLocations = locations.filter(loc => 
          loc.name.toLowerCase().includes(country.toLowerCase())
        );
      }
      
      return {
        success: true,
        locations: filteredLocations,
        total: filteredLocations.length
      };
    } catch (error) {
      logger.error('Failed to list VPN locations:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get current public IP address
   */
  async getPublicIP() {
    try {
      // Try multiple IP detection services
      const ipServices = [
        'curl -s https://api.ipify.org',
        'curl -s https://ifconfig.me/ip',
        'curl -s https://ipinfo.io/ip'
      ];
      
      for (const service of ipServices) {
        try {
          const { stdout } = await execAsync(service);
          const ip = stdout.trim();
          if (this.isValidIP(ip)) {
            this.connectionState.publicIP = ip;
            return {
              success: true,
              ip: ip
            };
          }
        } catch (serviceError) {
          logger.warn(`IP service failed: ${service}`);
        }
      }
      
      throw new Error('All IP detection services failed');
    } catch (error) {
      logger.error('Failed to get public IP:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Test VPN connection and speed
   */
  async testConnection({ testSites = ['google.com', 'github.com', 'cloudflare.com'] }) {
    try {
      const results = {
        connected: this.connectionState.connected,
        publicIP: null,
        connectivity: {},
        speed: null
      };

      // Get current IP
      const ipResult = await this.getPublicIP();
      results.publicIP = ipResult.success ? ipResult.ip : 'Unknown';

      // Test connectivity to various sites
      for (const site of testSites) {
        try {
          const start = Date.now();
          await execAsync(`ping -c 3 ${site}`);
          const responseTime = Date.now() - start;
          
          results.connectivity[site] = {
            reachable: true,
            responseTime: Math.round(responseTime / 3) // Average of 3 pings
          };
        } catch (error) {
          results.connectivity[site] = {
            reachable: false,
            error: error.message
          };
        }
      }

      // Simple speed test (download a small file)
      try {
        const start = Date.now();
        await execAsync('curl -o /dev/null -s -w "%{time_total}" http://speedtest.ftp.otenet.gr/files/test100k.db');
        const downloadTime = Date.now() - start;
        results.speed = {
          downloadTime: downloadTime,
          estimatedSpeed: Math.round((100 * 1024 * 8) / (downloadTime / 1000)) // Rough estimate in bps
        };
      } catch (error) {
        results.speed = { error: 'Speed test failed' };
      }

      return {
        success: true,
        results: results
      };
    } catch (error) {
      logger.error('VPN connection test failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Smart connect with automatic location selection
   */
  async smartConnect({ purpose = 'general' }) {
    try {
      let preferredLocations;
      
      switch (purpose.toLowerCase()) {
        case 'streaming':
          preferredLocations = ['usa-losangeles', 'usa-newyork', 'uk-london'];
          break;
        case 'security':
          preferredLocations = ['switzerland', 'iceland', 'sweden'];
          break;
        case 'speed':
          // Get locations with best ping
          preferredLocations = await this.getClosestLocations();
          break;
        default:
          preferredLocations = this.config.preferredLocations;
      }

      // Try each preferred location until one works
      for (const location of preferredLocations) {
        const result = await this.connect({ location, retry: false });
        if (result.success) {
          return {
            ...result,
            message: `Smart connected for ${purpose} (${location})`
          };
        }
      }

      // If all preferred locations fail, try any available location
      return await this.connect({ retry: true });
      
    } catch (error) {
      logger.error('Smart connect failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Set auto-connect configuration (Agent-level control)
   * When enabled: Agent maintains VPN connection and can only change locations
   * When disabled: Agent can toggle VPN on/off as needed for tasks
   */
  async setAutoConnect({ enabled, location = null }) {
    this.config.autoConnect = enabled;
    if (location) {
      this.config.preferredLocations = [location, ...this.config.preferredLocations];
    }
    
    const modeDescription = enabled 
      ? 'Agent will maintain VPN connection (location changes only)'
      : 'Agent can toggle VPN on/off as needed';
    
    // Save settings to database
    await this.saveSettings();

    return {
      success: true,
      message: `Auto-connect ${enabled ? 'enabled' : 'disabled'}: ${modeDescription}`,
      autoConnect: this.config.autoConnect,
      mode: modeDescription,
      preferredLocation: location
    };
  }

  /**
   * Check if agent can toggle VPN connection
   */
  async canToggleConnection() {
    return {
      success: true,
      canToggle: !this.config.autoConnect,
      autoConnect: this.config.autoConnect,
      reason: this.config.autoConnect 
        ? 'Agent must maintain VPN connection (auto-connect enabled)'
        : 'Agent can toggle VPN as needed (auto-connect disabled)'
    };
  }

  /**
   * Get connection history (mock implementation - would need persistent storage)
   */
  async getConnectionHistory({ days = 7 }) {
    // This is a mock implementation - in production, you'd store connection data
    return {
      success: true,
      message: 'Connection history not yet implemented - feature coming soon',
      period: `${days} days`,
      entries: []
    };
  }

  /**
   * Check if ExpressVPN has an update available
   */
  async checkForUpdate() {
    try {
      // Try new CLI (expressvpnctl) first, fall back to legacy (expressvpn)
      let currentVersion = 'unknown';
      let statusOutput = '';

      try {
        const verOut = await execAsync('expressvpnctl --version 2>/dev/null');
        currentVersion = verOut.stdout.trim() || 'unknown';
        const stateOut = await execAsync('expressvpnctl get connectionstate 2>/dev/null');
        statusOutput = stateOut.stdout.trim();
      } catch {
        // Legacy CLI
        try {
          const legacyStatus = await execAsync('expressvpn status 2>/dev/null');
          statusOutput = legacyStatus.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
        } catch {}
        try {
          const verOut = await execAsync("dpkg -l expressvpn 2>/dev/null | awk '/^ii/{print $3}'");
          currentVersion = verOut.stdout.trim() || 'unknown';
        } catch {}
      }

      const updateAvailable = /new version.*available|update.*available|download.*latest/i.test(statusOutput);

      return {
        currentVersion,
        updateAvailable,
        status: statusOutput,
        message: updateAvailable
          ? `ExpressVPN ${currentVersion} — a new version is available. Download from the ExpressVPN website and install the .deb package.`
          : `ExpressVPN ${currentVersion} — up to date. Status: ${statusOutput || 'OK'}`
      };
    } catch (error) {
      return { error: error.message, updateAvailable: false };
    }
  }

  // ── WireGuard Management ──────────────────────────────────

  /**
   * Get WireGuard tunnel status: interface up/down, handshake age, transfer
   * stats, peer endpoint. Parses `wg show wg0` output.
   */
  async getWireguardStatus() {
    try {
      const { stdout: wgShow } = await execAsync('wg show wg0 2>&1');

      // Parse wg show output
      const handshakeMatch = wgShow.match(/latest handshake:\s*(.+)/);
      const transferMatch = wgShow.match(/transfer:\s*(.+)/);
      const endpointMatch = wgShow.match(/endpoint:\s*(\S+)/);
      const peerMatch = wgShow.match(/peer:\s*(\S+)/);
      const keepaliveMatch = wgShow.match(/persistent keepalive:\s*(.+)/);

      // Get handshake epoch for age calculation
      let handshakeAgeSec = null;
      try {
        const { stdout: hsRaw } = await execAsync('wg show wg0 latest-handshakes');
        const epoch = parseInt(hsRaw.split('\t')[1]);
        if (epoch > 0) {
          handshakeAgeSec = Math.floor(Date.now() / 1000) - epoch;
        }
      } catch { /* optional */ }

      // Ping peer to test actual tunnel connectivity
      let peerReachable = false;
      let pingMs = null;
      try {
        const { stdout: pingOut } = await execAsync('ping -c1 -W3 10.8.0.1 2>&1');
        peerReachable = true;
        const timeMatch = pingOut.match(/time[=<](\d+\.?\d*)/);
        if (timeMatch) pingMs = parseFloat(timeMatch[1]);
      } catch { /* unreachable */ }

      return {
        success: true,
        interfaceUp: true,
        peer: peerMatch ? peerMatch[1].substring(0, 12) + '...' : null,
        endpoint: endpointMatch ? endpointMatch[1] : null,
        handshake: handshakeMatch ? handshakeMatch[1].trim() : 'never',
        handshakeAgeSec,
        transfer: transferMatch ? transferMatch[1].trim() : null,
        keepalive: keepaliveMatch ? keepaliveMatch[1].trim() : null,
        peerReachable,
        pingMs,
        healthy: peerReachable && handshakeAgeSec !== null && handshakeAgeSec < 180
      };
    } catch (error) {
      // wg show fails if interface is down
      if (error.message?.includes('No such device') || error.stderr?.includes('No such device')) {
        return { success: true, interfaceUp: false, healthy: false, error: 'wg0 interface not found' };
      }
      return { success: false, interfaceUp: false, healthy: false, error: error.message };
    }
  }

  /**
   * Bounce the WireGuard tunnel: wg-quick down + up. The PostUp hooks in
   * wg0.conf re-add the static route and iptables exception for ExpressVPN
   * coexistence automatically.
   */
  async wireguardBounce() {
    try {
      logger.info('Bouncing WireGuard tunnel (wg-quick down/up wg0)...');
      await execAsync('wg-quick down wg0 2>&1').catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      const { stdout: upOut } = await execAsync('wg-quick up wg0 2>&1');

      // Wait for handshake
      await new Promise(r => setTimeout(r, 6000));
      const status = await this.getWireguardStatus();

      if (status.healthy) {
        logger.info(`WireGuard tunnel bounced successfully (handshake ${status.handshakeAgeSec}s ago, ping ${status.pingMs}ms)`);
      } else {
        logger.warn(`WireGuard tunnel bounced but not healthy: ${JSON.stringify(status)}`);
      }

      return { success: true, bounced: true, ...status };
    } catch (error) {
      logger.error('WireGuard bounce failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Health check for the WireGuard tunnel. If the handshake is stale (>maxAge)
   * or the peer is unreachable, auto-bounces the tunnel. Called by the
   * vpn-wireguard-watchdog Agenda job.
   */
  async wireguardHealth({ maxHandshakeAge = 180 } = {}) {
    try {
      const status = await this.getWireguardStatus();

      if (!status.interfaceUp) {
        logger.warn('WireGuard interface down — bouncing');
        return await this.wireguardBounce();
      }

      if (status.healthy) {
        return { success: true, action: 'none', reason: 'healthy', ...status };
      }

      // Stale handshake or peer unreachable
      const reason = !status.peerReachable
        ? 'peer_unreachable'
        : status.handshakeAgeSec > maxHandshakeAge
          ? `handshake_stale_${status.handshakeAgeSec}s`
          : 'unknown';

      logger.warn(`WireGuard unhealthy (${reason}) — bouncing`);
      const bounceResult = await this.wireguardBounce();
      return { success: true, action: 'bounced', reason, ...bounceResult };
    } catch (error) {
      logger.error('WireGuard health check failed:', error);
      return { success: false, action: 'error', error: error.message };
    }
  }

  /**
   * Run troubleshooting diagnostics
   */
  async troubleshoot() {
    const diagnostics = {
      expressvpnInstalled: false,
      expressvpnRunning: false,
      networkConnectivity: false,
      dnsResolution: false,
      firewallStatus: 'unknown',
      recommendations: []
    };

    try {
      // Check ExpressVPN installation
      diagnostics.expressvpnInstalled = await this.checkExpressVPNInstallation();
      if (!diagnostics.expressvpnInstalled) {
        diagnostics.recommendations.push('Install ExpressVPN CLI');
      }

      // Check if ExpressVPN service is running
      try {
        await execAsync('expressvpnctl status');
        diagnostics.expressvpnRunning = true;
      } catch (error) {
        diagnostics.recommendations.push('Start ExpressVPN service');
      }

      // Check network connectivity
      try {
        await execAsync('ping -c 1 8.8.8.8');
        diagnostics.networkConnectivity = true;
      } catch (error) {
        diagnostics.recommendations.push('Check internet connection');
      }

      // Check DNS resolution
      try {
        await execAsync('nslookup google.com');
        diagnostics.dnsResolution = true;
      } catch (error) {
        diagnostics.recommendations.push('Check DNS settings');
      }

      // Check firewall status
      try {
        const { stdout } = await execAsync('ufw status');
        diagnostics.firewallStatus = stdout.includes('Status: active') ? 'active' : 'inactive';
      } catch (error) {
        diagnostics.firewallStatus = 'unknown';
      }

      // Check WireGuard tunnel
      try {
        const wgStatus = await this.getWireguardStatus();
        diagnostics.wireguard = {
          interfaceUp: wgStatus.interfaceUp,
          healthy: wgStatus.healthy,
          handshakeAgeSec: wgStatus.handshakeAgeSec,
          peerReachable: wgStatus.peerReachable,
          pingMs: wgStatus.pingMs
        };
        if (!wgStatus.interfaceUp) {
          diagnostics.recommendations.push('WireGuard wg0 interface is down — run wireguard-bounce or wg-quick up wg0');
        } else if (!wgStatus.healthy) {
          diagnostics.recommendations.push(`WireGuard tunnel unhealthy (handshake ${wgStatus.handshakeAgeSec}s ago, peer ${wgStatus.peerReachable ? 'reachable' : 'unreachable'})`);
        }
      } catch {
        diagnostics.wireguard = { error: 'WireGuard not installed or not configured' };
      }

      return {
        success: true,
        diagnostics: diagnostics,
        overallHealth: diagnostics.recommendations.length === 0 ? 'healthy' : 'issues_found'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        diagnostics: diagnostics
      };
    }
  }

  /**
   * Helper Methods
   */

  async updateConnectionState() {
    try {
      // Get connection state
      const { stdout: connectionState } = await execAsync('expressvpnctl get connectionstate');
      this.connectionState.connected = connectionState.trim() === 'Connected';
      
      if (this.connectionState.connected) {
        // Get current region
        try {
          const { stdout: region } = await execAsync('expressvpnctl get region');
          this.connectionState.currentLocation = region.trim();
        } catch (error) {
          this.connectionState.currentLocation = 'Unknown';
        }
        
        // Get current protocol
        try {
          const { stdout: protocol } = await execAsync('expressvpnctl get protocol');
          this.connectionState.currentProtocol = protocol.trim();
        } catch (error) {
          this.connectionState.currentProtocol = 'Unknown';
        }
        
        this.connectionState.connectionTime = new Date();
        
        // Get current public IP
        try {
          const { stdout: pubip } = await execAsync('expressvpnctl get pubip');
          this.connectionState.publicIP = pubip.trim();
        } catch (error) {
          await this.getPublicIP(); // Fallback to external service
        }
      } else {
        this.connectionState.currentLocation = null;
        this.connectionState.currentProtocol = null;
        this.connectionState.connectionTime = null;
        this.connectionState.publicIP = null;
      }
      
      this.connectionState.lastHealthCheck = new Date();
    } catch (error) {
      this.connectionState.connected = false;
      this.connectionState.currentLocation = null;
      this.connectionState.currentProtocol = null;
      this.connectionState.connectionTime = null;
      this.connectionState.publicIP = null;
    }
  }

  async waitForConnection(timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await this.updateConnectionState();
      if (this.connectionState.connected) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Connection timeout');
  }

  startHealthMonitoring() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(async () => {
      await this.updateConnectionState();
      if (!this.connectionState.connected && this.config.autoConnect) {
        logger.warn('VPN connection lost, attempting to reconnect...');
        await this.smartConnect({ purpose: 'general' });
      }
    }, this.config.healthCheckInterval);
  }

  stopHealthMonitoring() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async getAlternativeLocation(failedLocation) {
    const availableLocations = this.config.preferredLocations.filter(
      loc => loc !== failedLocation
    );
    return availableLocations[Math.floor(Math.random() * availableLocations.length)];
  }

  async getRegionList(force = false) {
    const ttl = 60 * 60 * 1000;
    if (!force && this._regionCache && (Date.now() - this._regionCacheAt) < ttl) {
      return this._regionCache;
    }
    try {
      const { stdout } = await execAsync('expressvpnctl get regions');
      const regions = stdout.split('\n').map(s => s.trim()).filter(Boolean);
      this._regionCache = regions;
      this._regionCacheAt = Date.now();
      return regions;
    } catch (err) {
      logger.warn(`Failed to load expressvpn region list: ${err.message}`);
      return this._regionCache || [];
    }
  }

  async resolveRegion(input) {
    if (!input || input === 'smart') return input;
    const regions = await this.getRegionList();
    if (!regions.length) return input;
    const needle = String(input).toLowerCase().trim();
    if (regions.includes(needle)) return needle;
    const prefix = regions.filter(r => r.startsWith(needle + '-') || r === needle);
    if (prefix.length) return prefix[0];
    const aliasMap = { uk: 'uk-london', usa: 'usa-new-york', us: 'usa-new-york' };
    if (aliasMap[needle] && regions.includes(aliasMap[needle])) return aliasMap[needle];
    const substr = regions.filter(r => r.includes(needle));
    if (substr.length) return substr[0];
    return input;
  }

  async getClosestLocations() {
    // This would ping various locations and return the fastest ones
    // For now, return default preferred locations
    return this.config.preferredLocations;
  }

  parseLocationsList(output) {
    // Parse the ExpressVPN regions list output
    const lines = output.split('\n');
    const locations = [];
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith('Available') && trimmedLine !== '') {
        // Each line contains a region name like "usa-losangeles-1" or "smart"
        locations.push({
          name: trimmedLine,
          alias: trimmedLine,
          displayName: this.formatLocationName(trimmedLine)
        });
      }
    }
    
    return locations;
  }
  
  formatLocationName(regionName) {
    if (regionName === 'smart') {
      return 'Smart Location';
    }
    
    // Convert "usa-losangeles-1" to "USA Los Angeles 1"
    return regionName
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  isValidIP(ip) {
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipRegex.test(ip);
  }

  async executeWithTimeout(command, timeout) {
    return Promise.race([
      execAsync(command),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Command timeout')), timeout)
      )
    ]);
  }

  getStatusInfo() {
    return {
      name: this.name,
      version: this.version,
      enabled: this.enabled,
      connected: this.connectionState.connected,
      location: this.connectionState.currentLocation,
      autoConnect: this.config.autoConnect,
      methods: this.methods.map(m => ({ name: m.name, description: m.description }))
    };
  }

  async cleanup() {
    this.stopHealthMonitoring();
    if (this.connectionState.connected && this.config.autoConnect === false) {
      await this.disconnect();
    }
  }
}

export default VPNPlugin;