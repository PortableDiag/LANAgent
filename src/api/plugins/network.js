import { BasePlugin } from '../core/basePlugin.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import dns from 'dns';
import net from 'net';
import dgram from 'dgram';
import { logger } from '../../utils/logger.js';
import os from 'os';
import NodeCache from 'node-cache';
import NetworkDevice from '../../models/NetworkDevice.js';
import { PluginSettings } from '../../models/PluginSettings.js';

const execAsync = promisify(exec);
const networkCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
const dnsLookup = promisify(dns.lookup);

export default class NetworkPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'network';
    this.version = '1.1.0';
    this.description = 'Network monitoring, diagnostics, port scanning, Wake-on-LAN, and management';
    this.commands = [
      {
        command: 'scan',
        description: 'Scan network for devices',
        usage: 'scan({ subnet: "192.168.1.0/24", fast: true })'
      },
      {
        command: 'ping',
        description: 'Ping a host to check connectivity',
        usage: 'ping({ host: "google.com", count: 4 })'
      },
      {
        command: 'traceroute',
        description: 'Trace route to a destination',
        usage: 'traceroute({ host: "google.com" })'
      },
      {
        command: 'port-scan',
        description: 'Scan ports on a host',
        usage: 'port-scan({ host: "192.168.1.1", ports: "80,443,22", timeout: 2000 })'
      },
      {
        command: 'connections',
        description: 'List active network connections',
        usage: 'connections({ state: "ESTABLISHED" })'
      },
      {
        command: 'interfaces',
        description: 'List network interfaces',
        usage: 'interfaces()'
      },
      {
        command: 'speed-test',
        description: 'Run network speed test',
        usage: 'speed-test()'
      },
      {
        command: 'dns-lookup',
        description: 'Perform DNS lookup',
        usage: 'dns-lookup({ hostname: "google.com" })'
      },
      {
        command: 'whois',
        description: 'Perform WHOIS lookup',
        usage: 'whois({ domain: "example.com" })'
      },
      {
        command: 'monitor',
        description: 'Monitor network activity',
        usage: 'monitor({ duration: 60, interface: "eth0" })'
      },
      {
        command: 'wake',
        description: 'Wake a device using Wake-on-LAN magic packet',
        usage: 'wake({ mac: "AA:BB:CC:DD:EE:FF" }) or wake({ deviceName: "my-desktop" })'
      },
      {
        command: 'poll',
        description: 'Check availability of all monitored devices',
        usage: 'poll()'
      },
      {
        command: 'devices',
        description: 'List all discovered network devices from database',
        usage: 'devices({ online: true, category: "trusted" })'
      }
    ];
    
    this.activeMonitors = new Map();
    this.scanHistory = [];
    this.lastScanDevices = []; // Track devices from latest scan
    this.scanInterval = null; // Interval for auto-scanning
    
    // Plugin settings
    this.settings = {
      enabled: false,
      interval: 300,
      alertNewDevices: false,
      subnets: [],  // Will be populated with actual subnet
      excludedIPs: [],
      scanInterval: 300000, // 5 minutes (legacy)
      monitoringEnabled: false,
      defaultSubnet: null,  // Will be detected
      maxScanHistory: 100
    };
    
    // Load configuration from database on initialization
    this.initialize();
  }

  async initialize() {
    try {
      // Load configuration from database first
      await this.loadConfig();
      
      // Load saved scan data
      await this.loadScanData();
      
      // Set default subnet if none configured
      if (!this.settings.subnets || this.settings.subnets.length === 0) {
        this.settings.subnets = [this.getLocalSubnet()];
        this.settings.defaultSubnet = this.settings.subnets[0];
        logger.info(`Auto-detected subnet: ${this.settings.defaultSubnet}`);
      }
      
      // Check for required network tools
      const tools = ['ping', 'nmap', 'ss', 'iftop', 'traceroute'];
      const missing = [];
      
      for (const tool of tools) {
        try {
          await execAsync(`which ${tool}`);
        } catch {
          missing.push(tool);
        }
      }
      
      if (missing.length > 0) {
        logger.warn(`Missing network tools: ${missing.join(', ')}. Some features may be limited.`);
      }
      
      // Start monitoring if it was enabled
      if (this.settings.enabled) {
        logger.info('Starting network monitoring from saved state');
        this.startAutoScanning();
      }
      
      this.initialized = true;
      logger.info(`Network plugin initialized with settings: enabled=${this.settings.enabled}, interval=${this.settings.interval}s`);
      return true;
    } catch (error) {
      logger.error('Failed to initialize network plugin:', error);
      return false;
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'scan':
        return await this.scanNetwork(data.subnet || this.getLocalSubnet());
      
      case 'ping':
        return await this.ping(data.host, data.count || 4);
      
      case 'traceroute':
        return await this.traceroute(data.host, data.maxHops);
      
      case 'port-scan':
        return await this.portScan(data.host, data.ports || 'common');
      
      case 'connections':
        return await this.getConnections(data.filter);
      
      case 'interfaces':
        return await this.getInterfaces();
      
      case 'speed-test':
        return await this.speedTest(data.server);
      
      case 'dns-lookup':
        return await this.dnsLookup(data.domain, data.type);
      
      case 'whois':
        return await this.whois(data.domain);
      
      case 'monitor':
        return await this.startMonitoring(data.type, data.duration);

      case 'wake':
        return await this.wakeOnLan(data);

      case 'poll':
        return await this.pollDevices();

      case 'devices':
        return await this.getDevicesFromDB(data);

      case 'getSettings':
        return await this.getSettings();
        
      case 'updateSettings':
        return await this.updateSettings(data);
      
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async scanNetwork(subnet) {
    try {
      logger.info(`Scanning network: ${subnet}`);

      // Use nmap for network scanning
      const { stdout } = await execAsync(`nmap -sn ${subnet}`, {
        timeout: 60000
      });

      const devices = this.parseNmapOutput(stdout);
      const newDevices = [];
      const updatedDevices = [];

      // Save each device to MongoDB
      for (const device of devices) {
        try {
          // Normalize MAC address if present
          const mac = device.mac ? device.mac.toUpperCase() : null;

          // Check if device exists
          let dbDevice = await NetworkDevice.findOne({ ip: device.ip });

          if (!dbDevice) {
            // New device - create it
            dbDevice = new NetworkDevice({
              ip: device.ip,
              mac,
              hostname: device.hostname,
              vendor: device.vendor,
              subnet,
              online: true,
              dateDiscovered: new Date(),
              lastSeen: new Date(),
              lastOnline: new Date()
            });
            newDevices.push(dbDevice);
          } else {
            // Existing device - update it
            if (mac && !dbDevice.mac) dbDevice.mac = mac;
            if (device.hostname && !dbDevice.hostname) dbDevice.hostname = device.hostname;
            if (device.vendor && !dbDevice.vendor) dbDevice.vendor = device.vendor;

            dbDevice.markOnline();
            dbDevice.stats.timesDiscovered = (dbDevice.stats.timesDiscovered || 0) + 1;
            updatedDevices.push(dbDevice);
          }

          await dbDevice.save();
        } catch (err) {
          logger.warn(`Failed to save device ${device.ip}: ${err.message}`);
        }
      }

      // Mark devices not in scan as potentially offline (will be verified by poll)
      const scannedIPs = devices.map(d => d.ip);
      await NetworkDevice.updateMany(
        { subnet, ip: { $nin: scannedIPs }, online: true },
        { $set: { online: false, lastSeen: new Date() } }
      );

      // Update in-memory cache
      this.lastScanDevices = await NetworkDevice.find({ subnet }).lean();

      this.scanHistory.push({
        timestamp: new Date(),
        subnet,
        deviceCount: devices.length,
        newCount: newDevices.length
      });

      // Notify if new devices found
      if (newDevices.length > 0 && this.settings.alertNewDevices) {
        await this.notify(`🆕 New devices on network:\n${newDevices.map(d => `${d.ip} - ${d.hostname || d.vendor || 'Unknown'}`).join('\n')}`);
      }

      // Keep scan history trimmed
      if (this.scanHistory.length > this.settings.maxScanHistory) {
        this.scanHistory = this.scanHistory.slice(-this.settings.maxScanHistory);
      }

      return {
        success: true,
        subnet,
        deviceCount: devices.length,
        newDevices: newDevices.length,
        updatedDevices: updatedDevices.length,
        devices: this.lastScanDevices,
        message: `Found ${devices.length} devices (${newDevices.length} new) on ${subnet}`
      };
    } catch (error) {
      throw new Error(`Network scan failed: ${error.message}`);
    }
  }

  /**
   * Poll all monitored devices to check availability via ping or ARP
   */
  async pollDevices() {
    try {
      const devices = await NetworkDevice.getDevicesForMonitoring();
      const results = { online: 0, offline: 0, alerts: [] };

      logger.info(`Polling ${devices.length} monitored devices...`);

      for (const device of devices) {
        try {
          // Try ping first
          const pingResult = await this.ping(device.ip, 1);

          if (pingResult.success && pingResult.stats.packetsReceived > 0) {
            const { shouldAlert } = device.markOnline(pingResult.stats.avgTime);
            results.online++;

            if (shouldAlert) {
              results.alerts.push({ device: device.getDisplayName(), status: 'online' });
              await this.notify(`✅ ${device.getDisplayName()} is back online`);
            }
          } else {
            // Try ARP as fallback for devices that don't respond to ping
            const arpResult = await this.checkARP(device.ip);

            if (arpResult) {
              device.markOnline();
              results.online++;
            } else {
              const { shouldAlert } = device.markOffline();
              results.offline++;

              if (shouldAlert) {
                results.alerts.push({ device: device.getDisplayName(), status: 'offline' });
                await this.notify(`⚠️ ${device.getDisplayName()} is offline`);
              }
            }
          }

          await device.save();
        } catch (err) {
          logger.warn(`Failed to poll device ${device.ip}: ${err.message}`);
        }
      }

      logger.info(`Poll complete: ${results.online} online, ${results.offline} offline`);

      return {
        success: true,
        polled: devices.length,
        ...results,
        message: `Polled ${devices.length} devices: ${results.online} online, ${results.offline} offline`
      };
    } catch (error) {
      throw new Error(`Device polling failed: ${error.message}`);
    }
  }

  /**
   * Check if device is in ARP cache (for devices that don't respond to ping)
   */
  async checkARP(ip) {
    try {
      const { stdout } = await execAsync(`arp -n ${ip} 2>/dev/null || ip neigh show ${ip} 2>/dev/null`);
      return stdout.includes(ip) && !stdout.includes('incomplete');
    } catch {
      return false;
    }
  }

  /**
   * Get devices from MongoDB with filtering
   */
  async getDevicesFromDB(filters = {}) {
    try {
      let query = {};

      if (filters.online !== undefined) {
        query.online = filters.online;
      }
      if (filters.category) {
        query.category = filters.category;
      }
      if (filters.deviceType) {
        query.deviceType = filters.deviceType;
      }
      if (filters.subnet) {
        query.subnet = filters.subnet;
      }
      if (filters.search) {
        const regex = new RegExp(filters.search, 'i');
        query.$or = [
          { ip: regex },
          { hostname: regex },
          { name: regex },
          { vendor: regex }
        ];
      }

      const devices = await NetworkDevice.find(query).sort({ lastSeen: -1 });

      return {
        success: true,
        count: devices.length,
        devices,
        message: `Found ${devices.length} devices`
      };
    } catch (error) {
      throw new Error(`Failed to get devices: ${error.message}`);
    }
  }

  async ping(host, count = 4) {
    try {
      const command = os.platform() === 'win32' 
        ? `ping -n ${count} ${host}`
        : `ping -c ${count} ${host}`;
      
      const { stdout, stderr } = await execAsync(command, {
        timeout: count * 2000 + 5000
      });
      
      if (stderr && !stdout) {
        return {
          success: false,
          host,
          message: `Cannot reach ${host}`,
          error: stderr
        };
      }
      
      // Parse ping statistics
      const stats = this.parsePingOutput(stdout);
      
      return {
        success: true,
        host,
        stats,
        message: `${stats.packetsReceived}/${stats.packetsSent} packets received, ${stats.packetLoss}% loss, avg time: ${stats.avgTime}ms`,
        rawOutput: stdout
      };
    } catch (error) {
      return {
        success: false,
        host,
        message: `Ping failed: ${error.message}`
      };
    }
  }

  async traceroute(host, maxHops = 30) {
    try {
      const command = os.platform() === 'win32'
        ? `tracert -h ${maxHops} ${host}`
        : `traceroute -m ${maxHops} ${host}`;
      
      const { stdout } = await execAsync(command, {
        timeout: 60000
      });
      
      const hops = this.parseTracerouteOutput(stdout);
      
      return {
        success: true,
        host,
        hops,
        hopCount: hops.length,
        message: `Traceroute to ${host}: ${hops.length} hops`
      };
    } catch (error) {
      throw new Error(`Traceroute failed: ${error.message}`);
    }
  }

  async portScan(host, ports = 'common') {
    if (!host) {
      return {
        success: false,
        openPorts: [],
        message: 'No target host specified. Please provide an IP address or hostname to scan (e.g., "scan ports on 192.168.0.1").'
      };
    }
    try {
      // Resolve hostname to IP if needed
      let targetIP = host;
      if (!net.isIP(host)) {
        const result = await dnsLookup(host);
        targetIP = result.address;
      }
      
      let portList;
      if (ports === 'common') {
        portList = '21,22,23,25,53,80,110,443,445,3306,3389,8080,8443';
      } else if (ports === 'all') {
        portList = '1-65535';
      } else {
        portList = ports;
      }
      
      logger.info(`Port scanning ${host} (${targetIP}) - ports: ${portList}`);
      
      const { stdout } = await execAsync(`nmap -p ${portList} ${targetIP}`, {
        timeout: 120000
      });
      
      const openPorts = this.parsePortScanOutput(stdout);
      
      // Notify if sensitive ports are open
      const sensitivePorts = [22, 23, 3389, 5900];
      const openSensitive = openPorts.filter(p => sensitivePorts.includes(p.port));
      if (openSensitive.length > 0) {
        await this.notify(`⚠️ Sensitive ports open on ${host}:\n${openSensitive.map(p => `${p.port}/${p.protocol} - ${p.service}`).join('\n')}`);
      }
      
      return {
        success: true,
        host,
        ip: targetIP,
        openPorts,
        portCount: openPorts.length,
        message: `Found ${openPorts.length} open ports on ${host}`
      };
    } catch (error) {
      throw new Error(`Port scan failed: ${error.message}`);
    }
  }

  async getConnections(filter = 'all') {
    const cacheKey = `connections_${filter}`;
    const cached = networkCache.get(cacheKey);
    if (cached) return cached;

    try {
      let command = 'ss -tunapo';

      if (filter === 'listening') {
        command = 'ss -tulnp';
      } else if (filter === 'established') {
        command = 'ss -tunp state established';
      }

      const { stdout } = await execAsync(command);
      const connections = this.parseSSOutput(stdout);

      const result = {
        success: true,
        filter,
        connectionCount: connections.length,
        connections,
        message: `Found ${connections.length} ${filter} connections`
      };
      networkCache.set(cacheKey, result);
      return result;
    } catch (error) {
      throw new Error(`Failed to get connections: ${error.message}`);
    }
  }

  async getInterfaces() {
    const cached = networkCache.get('interfaces');
    if (cached) return cached;

    try {
      const interfaces = os.networkInterfaces();
      const result = [];
      
      for (const [name, addrs] of Object.entries(interfaces)) {
        const iface = {
          name,
          addresses: addrs,
          status: 'unknown'
        };
        
        // Get additional interface info
        try {
          const { stdout } = await execAsync(`ip link show ${name}`);
          iface.status = stdout.includes('state UP') ? 'up' : 'down';
          
          // Get statistics
          const { stdout: stats } = await execAsync(`ip -s link show ${name}`);
          const rxMatch = stats.match(/RX:\s*bytes\s+(\d+)/);
          const txMatch = stats.match(/TX:\s*bytes\s+(\d+)/);
          
          if (rxMatch) iface.rxBytes = parseInt(rxMatch[1]);
          if (txMatch) iface.txBytes = parseInt(txMatch[1]);
        } catch (error) {
          logger.warn(`Could not get details for interface ${name}`);
        }
        
        result.push(iface);
      }
      
      const response = {
        success: true,
        interfaces: result,
        message: `Found ${result.length} network interfaces`
      };
      networkCache.set('interfaces', response);
      return response;
    } catch (error) {
      throw new Error(`Failed to get interfaces: ${error.message}`);
    }
  }

  async speedTest(server) {
    try {
      // Check if speedtest-cli is installed
      try {
        await execAsync('which speedtest-cli');
      } catch {
        // Install speedtest-cli
        await execAsync('pip3 install speedtest-cli');
      }
      
      await this.notify('🚀 Starting speed test, this may take a minute...');
      
      const command = server 
        ? `speedtest-cli --server ${server} --json`
        : 'speedtest-cli --json';
      
      const { stdout } = await execAsync(command, {
        timeout: 120000
      });
      
      const results = JSON.parse(stdout);
      
      const downloadMbps = (results.download / 1000000).toFixed(2);
      const uploadMbps = (results.upload / 1000000).toFixed(2);
      const ping = results.ping.toFixed(2);
      
      return {
        success: true,
        download: downloadMbps,
        upload: uploadMbps,
        ping: ping,
        server: results.server,
        message: `Speed test results:\n⬇️ Download: ${downloadMbps} Mbps\n⬆️ Upload: ${uploadMbps} Mbps\n📡 Ping: ${ping} ms`
      };
    } catch (error) {
      throw new Error(`Speed test failed: ${error.message}`);
    }
  }

  async dnsLookup(domain, type = 'A') {
    try {
      const command = `dig ${domain} ${type} +short`;
      const { stdout } = await execAsync(command);
      
      const records = stdout.trim().split('\n').filter(line => line);
      
      return {
        success: true,
        domain,
        type,
        records,
        message: `DNS ${type} records for ${domain}:\n${records.join('\n')}`
      };
    } catch (error) {
      throw new Error(`DNS lookup failed: ${error.message}`);
    }
  }

  async whois(domain) {
    try {
      const { stdout } = await execAsync(`whois ${domain}`, {
        timeout: 30000
      });
      
      // Extract key information
      const info = {
        domain,
        registrar: this.extractWhoisField(stdout, 'Registrar'),
        created: this.extractWhoisField(stdout, 'Creation Date'),
        expires: this.extractWhoisField(stdout, 'Expiry Date|Expiration Date'),
        nameServers: this.extractWhoisField(stdout, 'Name Server', true),
        status: this.extractWhoisField(stdout, 'Status')
      };
      
      return {
        success: true,
        ...info,
        rawData: stdout,
        message: `WHOIS info for ${domain}:\nRegistrar: ${info.registrar}\nCreated: ${info.created}\nExpires: ${info.expires}`
      };
    } catch (error) {
      throw new Error(`WHOIS lookup failed: ${error.message}`);
    }
  }

  /**
   * Send Wake-on-LAN magic packet to wake a device
   * @param {Object} params - { mac: 'AA:BB:CC:DD:EE:FF' } or { deviceName: 'my-desktop' } or { deviceId: 'device_192_168_1_100' }
   */
  async wakeOnLan(params) {
    try {
      let mac = params.mac;
      let deviceName = params.deviceName || params.name;
      let deviceId = params.deviceId || params.id;

      // If no MAC provided, try to find device by name or ID
      if (!mac) {
        let device = null;

        if (deviceId) {
          device = this.lastScanDevices.find(d => d.id === deviceId);
        } else if (deviceName) {
          // Search by hostname or custom name (case-insensitive)
          const searchName = deviceName.toLowerCase();
          device = this.lastScanDevices.find(d =>
            (d.hostname && d.hostname.toLowerCase().includes(searchName)) ||
            (d.name && d.name.toLowerCase().includes(searchName)) ||
            (d.notes && d.notes.toLowerCase().includes(searchName))
          );
        }

        if (!device) {
          return {
            success: false,
            error: `Device not found: ${deviceName || deviceId || 'no identifier provided'}`,
            message: 'Please provide a MAC address or a valid device name/ID from a network scan'
          };
        }

        if (!device.mac) {
          return {
            success: false,
            error: `No MAC address found for device: ${device.hostname || device.ip}`,
            message: 'MAC address is required for Wake-on-LAN. Try running a network scan first.'
          };
        }

        mac = device.mac;
        deviceName = device.hostname || device.name || device.ip;
      }

      // Validate MAC address format
      const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
      if (!macRegex.test(mac)) {
        return {
          success: false,
          error: `Invalid MAC address format: ${mac}`,
          message: 'MAC address should be in format AA:BB:CC:DD:EE:FF or AA-BB-CC-DD-EE-FF'
        };
      }

      // Normalize MAC address (remove separators)
      const macBytes = mac.replace(/[:-]/g, '').match(/.{2}/g).map(byte => parseInt(byte, 16));

      // Create magic packet: 6 bytes of 0xFF followed by MAC address repeated 16 times
      const magicPacket = Buffer.alloc(102);

      // First 6 bytes are 0xFF
      for (let i = 0; i < 6; i++) {
        magicPacket[i] = 0xFF;
      }

      // Repeat MAC address 16 times
      for (let i = 0; i < 16; i++) {
        for (let j = 0; j < 6; j++) {
          magicPacket[6 + i * 6 + j] = macBytes[j];
        }
      }

      // Send packet via UDP broadcast
      const socket = dgram.createSocket('udp4');

      return new Promise((resolve) => {
        socket.on('error', (err) => {
          socket.close();
          resolve({
            success: false,
            error: `Failed to send WOL packet: ${err.message}`
          });
        });

        socket.bind(() => {
          socket.setBroadcast(true);

          // Send to broadcast address on port 9 (standard WOL port)
          // Also try port 7 as some devices use that
          const broadcastAddr = '255.255.255.255';
          let sent = 0;

          socket.send(magicPacket, 0, magicPacket.length, 9, broadcastAddr, (err) => {
            if (err) {
              logger.warn(`WOL send to port 9 failed: ${err.message}`);
            } else {
              sent++;
            }

            socket.send(magicPacket, 0, magicPacket.length, 7, broadcastAddr, (err2) => {
              socket.close();

              if (err2) {
                logger.warn(`WOL send to port 7 failed: ${err2.message}`);
              } else {
                sent++;
              }

              if (sent > 0) {
                logger.info(`Wake-on-LAN packet sent to ${mac}${deviceName ? ` (${deviceName})` : ''}`);
                resolve({
                  success: true,
                  mac,
                  deviceName: deviceName || null,
                  message: `Wake-on-LAN magic packet sent to ${mac}${deviceName ? ` (${deviceName})` : ''}. Device should wake up within a few seconds if WOL is enabled.`
                });
              } else {
                resolve({
                  success: false,
                  error: 'Failed to send WOL packet on any port'
                });
              }
            });
          });
        });
      });
    } catch (error) {
      logger.error('Wake-on-LAN failed:', error);
      return {
        success: false,
        error: `Wake-on-LAN failed: ${error.message}`
      };
    }
  }

  /**
   * Get devices that have MAC addresses (WOL-capable)
   */
  async getWolDevices() {
    const wolDevices = this.lastScanDevices.filter(d => d.mac);
    return {
      success: true,
      data: wolDevices,
      count: wolDevices.length,
      message: `Found ${wolDevices.length} devices with MAC addresses (WOL-capable)`
    };
  }

  async startMonitoring(type = 'bandwidth', duration = 60) {
    const monitorId = `monitor_${Date.now()}`;
    
    try {
      if (type === 'bandwidth') {
        const monitor = {
          id: monitorId,
          type,
          startTime: Date.now(),
          duration: duration * 1000,
          active: true,
          data: []
        };
        
        this.activeMonitors.set(monitorId, monitor);
        
        // Start bandwidth monitoring
        const interval = setInterval(async () => {
          if (!monitor.active || Date.now() - monitor.startTime > monitor.duration) {
            clearInterval(interval);
            monitor.active = false;
            return;
          }
          
          const stats = await this.getCurrentBandwidth();
          monitor.data.push({
            timestamp: new Date(),
            ...stats
          });
          
          // Send update every 10 seconds
          if (monitor.data.length % 10 === 0) {
            await this.notify(`📊 Bandwidth: ⬇️ ${stats.rxRate} KB/s ⬆️ ${stats.txRate} KB/s`);
          }
        }, 1000);
        
        return {
          success: true,
          monitorId,
          type,
          duration,
          message: `Started ${type} monitoring for ${duration} seconds`
        };
      }
      
      throw new Error(`Unknown monitor type: ${type}`);
    } catch (error) {
      throw new Error(`Failed to start monitoring: ${error.message}`);
    }
  }

  // Helper methods

  parseNmapOutput(output) {
    const devices = [];
    const lines = output.split('\n');
    
    let currentDevice = null;
    
    for (const line of lines) {
      if (line.includes('Nmap scan report for')) {
        if (currentDevice) devices.push(currentDevice);
        
        const match = line.match(/Nmap scan report for (.+?)(?:\s+\((.+?)\))?$/);
        if (match) {
          currentDevice = {
            hostname: match[1] !== match[2] ? match[1] : null,
            ip: match[2] || match[1]
          };
        }
      } else if (line.includes('MAC Address:') && currentDevice) {
        const match = line.match(/MAC Address:\s+([A-F0-9:]+)(?:\s+\((.+?)\))?/);
        if (match) {
          currentDevice.mac = match[1];
          currentDevice.vendor = match[2];
        }
      } else if (line.includes('Host is up') && currentDevice) {
        currentDevice.status = 'up';
      }
    }
    
    if (currentDevice) devices.push(currentDevice);
    
    return devices;
  }

  parsePingOutput(output) {
    const stats = {
      packetsSent: 0,
      packetsReceived: 0,
      packetLoss: 0,
      minTime: 0,
      avgTime: 0,
      maxTime: 0
    };
    
    // Parse packet statistics
    const statsMatch = output.match(/(\d+) packets transmitted, (\d+) received, ([\d.]+)% packet loss/);
    if (statsMatch) {
      stats.packetsSent = parseInt(statsMatch[1]);
      stats.packetsReceived = parseInt(statsMatch[2]);
      stats.packetLoss = parseFloat(statsMatch[3]);
    }
    
    // Parse RTT statistics
    const rttMatch = output.match(/min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)/);
    if (rttMatch) {
      stats.minTime = parseFloat(rttMatch[1]);
      stats.avgTime = parseFloat(rttMatch[2]);
      stats.maxTime = parseFloat(rttMatch[3]);
    }
    
    return stats;
  }

  parseTracerouteOutput(output) {
    const hops = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (match) {
        const hopNumber = parseInt(match[1]);
        const details = match[2].trim();
        
        // Parse hop details
        const timeMatches = details.match(/([\d.]+)\s+ms/g);
        const times = timeMatches ? timeMatches.map(t => parseFloat(t)) : [];
        
        hops.push({
          hop: hopNumber,
          host: details.split(/\s+/)[0],
          times
        });
      }
    }
    
    return hops;
  }

  parsePortScanOutput(output) {
    const ports = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      const match = line.match(/^(\d+)\/(tcp|udp)\s+(\w+)\s+(.+)?/);
      if (match) {
        ports.push({
          port: parseInt(match[1]),
          protocol: match[2],
          state: match[3],
          service: match[4] || 'unknown'
        });
      }
    }
    
    return ports.filter(p => p.state === 'open');
  }

  parseSSOutput(output) {
    const connections = [];
    const lines = output.split('\n').slice(1); // Skip header
    
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length >= 6) {
        connections.push({
          protocol: fields[0],
          state: fields[1],
          recvQ: parseInt(fields[2]) || 0,
          sendQ: parseInt(fields[3]) || 0,
          localAddress: fields[4],
          remoteAddress: fields[5],
          process: fields[6] || null
        });
      }
    }
    
    return connections;
  }

  extractWhoisField(data, fieldName, multiple = false) {
    const regex = new RegExp(`${fieldName}[:\s]+(.+)`, 'gi');
    const matches = [...data.matchAll(regex)];
    
    if (multiple) {
      return matches.map(m => m[1].trim());
    }
    
    return matches.length > 0 ? matches[0][1].trim() : null;
  }

  async getCurrentBandwidth() {
    try {
      const { stdout } = await execAsync('cat /proc/net/dev');
      const lines = stdout.split('\n');
      
      let totalRx = 0;
      let totalTx = 0;
      
      for (const line of lines) {
        if (line.includes(':') && !line.includes('lo:')) {
          const fields = line.split(/\s+/).filter(f => f);
          totalRx += parseInt(fields[1]) || 0;
          totalTx += parseInt(fields[9]) || 0;
        }
      }
      
      // If we have previous data, calculate rate
      const lastData = this.lastBandwidthData;
      this.lastBandwidthData = { rx: totalRx, tx: totalTx, time: Date.now() };
      
      if (lastData) {
        const timeDiff = (this.lastBandwidthData.time - lastData.time) / 1000;
        const rxRate = Math.round((totalRx - lastData.rx) / timeDiff / 1024);
        const txRate = Math.round((totalTx - lastData.tx) / timeDiff / 1024);
        
        return { rxRate, txRate };
      }
      
      return { rxRate: 0, txRate: 0 };
    } catch (error) {
      logger.error('Failed to get bandwidth:', error);
      return { rxRate: 0, txRate: 0 };
    }
  }

  getLocalSubnet() {
    const interfaces = os.networkInterfaces();
    
    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          // Convert IP to subnet (assume /24)
          const parts = addr.address.split('.');
          return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
        }
      }
    }
    
    return '192.168.1.0/24'; // Default fallback
  }

  // Natural language processing
  async handleNaturalLanguage(query) {
    const lowerQuery = query.toLowerCase();
    
    if (lowerQuery.includes('scan') && (lowerQuery.includes('network') || lowerQuery.includes('devices'))) {
      return await this.execute({ action: 'scan' });
    }
    
    if (lowerQuery.includes('ping')) {
      const hostMatch = lowerQuery.match(/ping\s+(\S+)/);
      if (hostMatch) {
        return await this.execute({
          action: 'ping',
          host: hostMatch[1]
        });
      }
    }
    
    if (lowerQuery.includes('port') && lowerQuery.includes('scan')) {
      const hostMatch = lowerQuery.match(/(?:scan|check)\s+(?:ports?\s+on\s+)?(\S+)/);
      if (hostMatch) {
        return await this.execute({
          action: 'port-scan',
          host: hostMatch[1],
          ports: lowerQuery.includes('all') ? 'all' : 'common'
        });
      }
    }
    
    if (lowerQuery.includes('speed') && lowerQuery.includes('test')) {
      return await this.execute({ action: 'speed-test' });
    }
    
    if (lowerQuery.includes('connection') || lowerQuery.includes('netstat')) {
      const filter = lowerQuery.includes('listening') ? 'listening' : 
                    lowerQuery.includes('established') ? 'established' : 'all';
      return await this.execute({
        action: 'connections',
        filter
      });
    }
    
    if (lowerQuery.includes('interface')) {
      return await this.execute({ action: 'interfaces' });
    }

    if (lowerQuery.includes('dns') || lowerQuery.includes('lookup')) {
      const domainMatch = lowerQuery.match(/(?:lookup|dns)\s+(\S+)/);
      if (domainMatch) {
        return await this.execute({
          action: 'dns-lookup',
          domain: domainMatch[1]
        });
      }
    }

    // Wake-on-LAN commands
    if (lowerQuery.includes('wake') || lowerQuery.includes('wol') || lowerQuery.includes('turn on') || lowerQuery.includes('power on')) {
      // Try to extract device name or MAC address
      // "wake up my desktop" / "wake the NAS" / "turn on the server"
      const wakeMatch = lowerQuery.match(/(?:wake(?:\s+up)?|wol|turn\s+on|power\s+on)\s+(?:the\s+|my\s+)?(.+)/i);

      if (wakeMatch) {
        const target = wakeMatch[1].trim();

        // Check if it's a MAC address
        const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
        if (macRegex.test(target)) {
          return await this.wakeOnLan({ mac: target });
        }

        // Otherwise treat as device name
        return await this.wakeOnLan({ deviceName: target });
      }

      // If just "wake" with no target, show available devices
      return await this.getWolDevices();
    }

    // List WOL-capable devices
    if ((lowerQuery.includes('wol') || lowerQuery.includes('wake')) &&
        (lowerQuery.includes('device') || lowerQuery.includes('list') || lowerQuery.includes('show'))) {
      return await this.getWolDevices();
    }

    return {
      success: false,
      message: "I can help with: network scan, ping, port scan, speed test, connections, interfaces, DNS lookup, wake-on-lan"
    };
  }

  // Direct method aliases for web interface compatibility
  async getStatus() {
    try {
      const interfaces = await this.getInterfaces();
      const connections = await this.getConnections();
      
      return {
        success: true,
        data: {
          monitoring: { enabled: this.settings.enabled },
          lastScan: this.scanHistory.length > 0 ? this.scanHistory[this.scanHistory.length - 1].timestamp : null,
          deviceCount: this.lastScanDevices?.length || 0,
          interfaces: interfaces.interfaces || [],
          connections: connections.connections || []
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getDevices() {
    try {
      // Load from MongoDB
      const devices = await NetworkDevice.find().sort({ lastSeen: -1 }).lean();

      // Transform for frontend compatibility
      const transformedDevices = devices.map(device => ({
        ...device,
        id: device._id.toString(),
        trusted: device.category === 'trusted'
      }));

      this.lastScanDevices = transformedDevices;

      return {
        success: true,
        data: transformedDevices,
        message: `Found ${devices.length} devices`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAlerts(params = {}) {
    try {
      // For now, return empty alerts - this would need alert tracking
      return {
        success: true,
        data: [],
        message: 'Network alerts not yet implemented'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getConfig() {
    const cached = networkCache.get('config');
    if (cached) return cached;

    try {
      const result = {
        success: true,
        data: {
          enabled: this.settings.enabled,
          interval: this.settings.interval,
          alertNewDevices: this.settings.alertNewDevices,
          subnets: this.settings.subnets || ['192.168.1.0/24'],
          excludedIPs: this.settings.excludedIPs || []
        }
      };
      networkCache.set('config', result);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async setConfig(config) {
    try {
      // Update settings with new configuration
      Object.assign(this.settings, {
        enabled: config.enabled !== undefined ? Boolean(config.enabled) : this.settings.enabled,
        interval: config.interval || this.settings.interval,
        alertNewDevices: config.alertNewDevices !== undefined ? Boolean(config.alertNewDevices) : this.settings.alertNewDevices,
        subnets: config.subnets || this.settings.subnets,
        excludedIPs: config.excludedIPs || this.settings.excludedIPs
      });
      
      // Save configuration to database
      await this.saveConfig();
      networkCache.del('config');

      logger.info('Network plugin configuration updated:', this.settings);

      return {
        success: true,
        message: 'Network configuration updated and saved'
      };
    } catch (error) {
      logger.error('Failed to save network configuration:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async startMonitoring() {
    try {
      // Update settings
      this.settings.enabled = true;
      await this.saveConfig();
      
      // Start auto-scanning
      this.startAutoScanning();
      
      return {
        success: true,
        message: 'Network monitoring started'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async stopMonitoring() {
    try {
      // Update settings
      this.settings.enabled = false;
      await this.saveConfig();
      
      // Stop auto-scanning
      this.stopAutoScanning();
      
      return {
        success: true,
        message: 'Network monitoring stopped'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async clearAlert({ id }) {
    try {
      return {
        success: true,
        message: `Alert ${id} cleared`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async exportDevices(params = {}) {
    try {
      return {
        success: true,
        data: [],
        message: 'Device export not yet implemented'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getDeviceDetails({ id }) {
    try {
      // Support both MongoDB _id and legacy id format
      let device;
      if (id.match(/^[0-9a-fA-F]{24}$/)) {
        device = await NetworkDevice.findById(id);
      } else {
        // Legacy format: device_192_168_1_100 -> 192.168.1.100
        const ip = id.replace('device_', '').replace(/_/g, '.');
        device = await NetworkDevice.findOne({ ip });
      }

      if (!device) {
        return {
          success: false,
          error: 'Device not found'
        };
      }

      // Transform for frontend compatibility
      const deviceObj = device.toObject();
      deviceObj.id = deviceObj._id.toString();
      deviceObj.trusted = deviceObj.category === 'trusted';

      return {
        success: true,
        data: deviceObj
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateDevice(params) {
    try {
      const { id, ...updates } = params;

      // Support both MongoDB _id and legacy id format
      let device;
      if (id.match(/^[0-9a-fA-F]{24}$/)) {
        device = await NetworkDevice.findById(id);
      } else {
        const ip = id.replace('device_', '').replace(/_/g, '.');
        device = await NetworkDevice.findOne({ ip });
      }

      if (!device) {
        return {
          success: false,
          error: 'Device not found'
        };
      }

      // Handle trusted boolean -> category conversion
      if (updates.trusted !== undefined) {
        updates.category = updates.trusted ? 'trusted' : 'unknown';
        delete updates.trusted;
      }

      // Apply updates (only allow certain fields)
      const allowedFields = ['name', 'deviceType', 'category', 'notes', 'tags', 'wolEnabled', 'monitor', 'alertOnOffline', 'alertOnOnline', 'os'];
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          device[field] = updates[field];
        }
      }

      await device.save();

      // Transform response for frontend
      const deviceObj = device.toObject();
      deviceObj.id = deviceObj._id.toString();
      deviceObj.trusted = deviceObj.category === 'trusted';

      return {
        success: true,
        message: 'Device updated successfully',
        data: deviceObj
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async scan(params = {}) {
    try {
      const subnet = params.subnet || this.settings.defaultSubnet || this.getLocalSubnet();
      return await this.scanNetwork(subnet);
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Settings management
  async getSettings() {
    return {
      success: true,
      settings: { ...this.settings }
    };
  }

  async updateSettings(newSettings) {
    try {
      // Validate settings
      if (newSettings.scanInterval && newSettings.scanInterval < 60000) {
        throw new Error('Scan interval must be at least 60 seconds');
      }
      
      // Update settings
      Object.assign(this.settings, newSettings);
      
      return {
        success: true,
        message: 'Network plugin settings updated',
        settings: { ...this.settings }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get HTTP routes for the web interface
  getRoutes() {
    return [
      {
        method: 'GET',
        path: '/status',
        handler: async () => await this.getStatus()
      },
      {
        method: 'GET',
        path: '/devices',
        handler: async () => await this.getDevices()
      },
      {
        method: 'POST',
        path: '/scan',
        handler: async (data) => await this.scan(data)
      },
      {
        method: 'GET',
        path: '/config',
        handler: async () => await this.getConfig()
      },
      {
        method: 'POST',
        path: '/config',
        handler: async (data) => await this.setConfig(data)
      },
      {
        method: 'GET',
        path: '/alerts',
        handler: async () => ({
          success: true,
          data: [] // No alerts for now
        })
      },
      {
        method: 'DELETE',
        path: '/alerts/:id',
        handler: async (data, req) => await this.clearAlert({ id: req.params.id })
      },
      {
        method: 'POST',
        path: '/monitoring/start',
        handler: async () => await this.startMonitoring()
      },
      {
        method: 'POST',
        path: '/monitoring/stop',
        handler: async () => await this.stopMonitoring()
      },
      {
        method: 'GET',
        path: '/devices/:id',
        handler: async (data, req) => await this.getDeviceDetails({ id: req.params.id })
      },
      {
        method: 'PUT',
        path: '/devices/:id',
        handler: async (data, req) => await this.updateDevice({ id: req.params.id, ...data })
      },
      {
        method: 'GET',
        path: '/export',
        handler: async (data) => await this.exportDevices(data)
      },
      {
        method: 'POST',
        path: '/wake',
        handler: async (data) => await this.wakeOnLan(data)
      },
      {
        method: 'GET',
        path: '/wol-devices',
        handler: async () => await this.getWolDevices()
      },
      {
        method: 'POST',
        path: '/poll',
        handler: async () => await this.pollDevices()
      },
      {
        method: 'DELETE',
        path: '/devices/:id',
        handler: async (data, req) => await this.deleteDevice({ id: req.params.id })
      }
    ];
  }

  /**
   * Delete a device from the database
   */
  async deleteDevice({ id }) {
    try {
      let result;
      if (id.match(/^[0-9a-fA-F]{24}$/)) {
        result = await NetworkDevice.findByIdAndDelete(id);
      } else {
        const ip = id.replace('device_', '').replace(/_/g, '.');
        result = await NetworkDevice.findOneAndDelete({ ip });
      }

      if (!result) {
        return { success: false, error: 'Device not found' };
      }

      return {
        success: true,
        message: `Device ${result.ip} deleted`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Load configuration from database
   */
  async loadConfig() {
    try {
      const savedConfig = await PluginSettings.getCached('network', 'config');
      if (savedConfig) {
        this.settings = {
          ...this.settings,
          enabled: savedConfig.enabled !== undefined ? savedConfig.enabled : this.settings.enabled,
          interval: savedConfig.interval || this.settings.interval,
          alertNewDevices: savedConfig.alertNewDevices !== undefined ? savedConfig.alertNewDevices : this.settings.alertNewDevices,
          subnets: savedConfig.subnets || this.settings.subnets,
          excludedIPs: savedConfig.excludedIPs || this.settings.excludedIPs
        };
        logger.info('Network plugin configuration loaded from database');
      } else {
        logger.info('No saved network configuration found, using defaults');
      }
    } catch (error) {
      logger.warn('Failed to load network configuration:', error.message);
    }
  }

  /**
   * Save configuration to database
   */
  async saveConfig() {
    try {
      await PluginSettings.setCached('network', 'config', {
        enabled: this.settings.enabled,
        interval: this.settings.interval,
        alertNewDevices: this.settings.alertNewDevices,
        subnets: this.settings.subnets,
        excludedIPs: this.settings.excludedIPs
      });
      logger.info('Network plugin configuration saved to database');
    } catch (error) {
      logger.error('Failed to save network configuration:', error);
    }
  }

  /**
   * Load scan data from database (MongoDB NetworkDevice collection)
   */
  async loadScanData() {
    try {
      // Load devices from MongoDB
      const devices = await NetworkDevice.find().sort({ lastSeen: -1 }).lean();
      this.lastScanDevices = devices;

      logger.info(`Network devices loaded from MongoDB: ${devices.length} devices`);

      // If we have devices, schedule a poll to check their current status
      if (devices.length > 0 && this.settings.enabled) {
        setTimeout(() => {
          logger.info('Running startup device poll...');
          this.pollDevices().catch(err => logger.warn('Startup poll failed:', err.message));
        }, 30000); // Wait 30s after startup before polling
      }
    } catch (error) {
      logger.warn('Failed to load network devices from MongoDB:', error.message);
    }
  }

  /**
   * Save scan data to database
   */
  async saveScanData() {
    try {
      await PluginSettings.setCached('network', 'scanData', {
        history: this.scanHistory.slice(-10),
        lastScanTime: new Date()
      });
      logger.info('Network scan data saved to database');
    } catch (error) {
      logger.error('Failed to save network scan data:', error);
    }
  }

  /**
   * Start automatic scanning based on interval
   */
  startAutoScanning() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    // Run initial scan
    this.scanNetwork(this.settings.subnets[0] || this.getLocalSubnet());

    // Set up interval scanning (full nmap scan)
    this.scanInterval = setInterval(() => {
      if (this.settings.enabled) {
        logger.info('Running scheduled network scan');
        this.scanNetwork(this.settings.subnets[0] || this.getLocalSubnet());
      }
    }, this.settings.interval * 1000);

    // Set up polling interval (ping/arp check) - runs every 60 seconds
    const pollIntervalMs = Math.min(60000, (this.settings.interval * 1000) / 5);
    this.pollInterval = setInterval(() => {
      if (this.settings.enabled) {
        this.pollDevices().catch(err => logger.warn('Scheduled poll failed:', err.message));
      }
    }, pollIntervalMs);

    logger.info(`Network auto-scanning started: scan every ${this.settings.interval}s, poll every ${pollIntervalMs / 1000}s`);
  }

  /**
   * Stop automatic scanning
   */
  stopAutoScanning() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info('Network auto-scanning and polling stopped');
  }
}