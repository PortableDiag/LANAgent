import { BasePlugin } from '../core/basePlugin.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { BluetoothDevice } from '../../models/BluetoothDevice.js';

const execAsync = promisify(exec);

/**
 * Bluetooth Plugin
 * Provides Bluetooth device scanning, pairing, and connection management
 */
export default class BluetoothPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'bluetooth';
    this.version = '1.0.0';
    this.description = 'Manage Bluetooth devices - scan, pair, connect, and disconnect';

    this.commands = [
      {
        command: 'scan',
        description: 'Scan for nearby Bluetooth devices',
        usage: 'scan({ duration: 10 })',
        examples: ['scan for bluetooth devices', 'find bluetooth devices', 'discover bluetooth']
      },
      {
        command: 'list-paired',
        description: 'List all paired devices',
        usage: 'list-paired()',
        examples: ['list paired devices', 'show paired bluetooth', 'what devices are paired']
      },
      {
        command: 'list-connected',
        description: 'List currently connected devices',
        usage: 'list-connected()',
        examples: ['list connected devices', 'what is connected', 'show connected bluetooth']
      },
      {
        command: 'pair',
        description: 'Pair with a Bluetooth device',
        usage: 'pair({ address: "AA:BB:CC:DD:EE:FF" }) or pair({ name: "device name" })',
        examples: ['pair with my speaker', 'pair bluetooth headphones']
      },
      {
        command: 'unpair',
        description: 'Remove pairing from a device',
        usage: 'unpair({ address: "AA:BB:CC:DD:EE:FF" })',
        examples: ['unpair device', 'remove bluetooth device', 'forget device']
      },
      {
        command: 'connect',
        description: 'Connect to a paired device',
        usage: 'connect({ address: "AA:BB:CC:DD:EE:FF" }) or connect({ name: "device name" })',
        examples: ['connect to my headphones', 'connect bluetooth speaker']
      },
      {
        command: 'disconnect',
        description: 'Disconnect from a device',
        usage: 'disconnect({ address: "AA:BB:CC:DD:EE:FF" })',
        examples: ['disconnect from headphones', 'disconnect bluetooth']
      },
      {
        command: 'trust',
        description: 'Trust a device for auto-connect',
        usage: 'trust({ address: "AA:BB:CC:DD:EE:FF" })',
        examples: ['trust device', 'enable auto connect']
      },
      {
        command: 'info',
        description: 'Get detailed info about a device',
        usage: 'info({ address: "AA:BB:CC:DD:EE:FF" })',
        examples: ['device info', 'bluetooth device details']
      }
    ];

    this.bluetoothAvailable = null;
    this.scanProcess = null;
    this.discoveredDevices = new Map();
  }

  async initialize() {
    this.bluetoothAvailable = await this.checkBluetoothAvailable();
    if (!this.bluetoothAvailable) {
      logger.warn('Bluetooth (bluetoothctl) not available - Bluetooth plugin will be limited');
    } else {
      logger.info('Bluetooth plugin initialized');
    }
    return true;
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'scan':
        return await this.scanDevices(data);
      case 'list-paired':
        return await this.listPairedDevices();
      case 'list-connected':
        return await this.listConnectedDevices();
      case 'pair':
        return await this.pairDevice(data);
      case 'unpair':
        return await this.unpairDevice(data);
      case 'connect':
        return await this.connectDevice(data);
      case 'disconnect':
        return await this.disconnectDevice(data);
      case 'trust':
        return await this.trustDevice(data);
      case 'untrust':
        return await this.untrustDevice(data);
      case 'block':
        return await this.blockDevice(data);
      case 'info':
        return await this.getDeviceInfo(data);
      case 'status':
        return await this.getAdapterStatus();
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Check if bluetoothctl is available
   */
  async checkBluetoothAvailable() {
    try {
      await execAsync('which bluetoothctl');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Bluetooth adapter status
   */
  async getAdapterStatus() {
    try {
      const { stdout } = await execAsync('bluetoothctl show', { timeout: 5000 });
      const status = this.parseAdapterInfo(stdout);
      return {
        success: true,
        available: this.bluetoothAvailable,
        adapter: status
      };
    } catch (error) {
      return {
        success: false,
        available: this.bluetoothAvailable,
        error: error.message
      };
    }
  }

  /**
   * Scan for nearby Bluetooth devices
   */
  async scanDevices({ duration = 10 } = {}) {
    if (!this.bluetoothAvailable) {
      return { success: false, error: 'Bluetooth not available' };
    }

    try {
      logger.info(`Starting Bluetooth scan for ${duration} seconds...`);

      // Power on adapter if needed
      await execAsync('bluetoothctl power on', { timeout: 5000 }).catch(() => {});

      // Start scanning
      const scanPromise = new Promise((resolve, reject) => {
        const devices = new Map();
        const process = spawn('bluetoothctl', ['--timeout', String(duration), 'scan', 'on'], {
          timeout: (duration + 5) * 1000
        });

        let output = '';

        process.stdout.on('data', (data) => {
          output += data.toString();
          // Parse devices as they're discovered
          const lines = data.toString().split('\n');
          for (const line of lines) {
            const deviceMatch = line.match(/\[NEW\]\s+Device\s+([A-F0-9:]+)\s+(.+)/i);
            if (deviceMatch) {
              devices.set(deviceMatch[1], {
                macAddress: deviceMatch[1],
                name: deviceMatch[2].trim()
              });
            }
          }
        });

        process.stderr.on('data', (data) => {
          output += data.toString();
        });

        process.on('close', () => {
          resolve(Array.from(devices.values()));
        });

        process.on('error', (error) => {
          reject(error);
        });

        // Stop scanning after duration
        setTimeout(() => {
          execAsync('bluetoothctl scan off').catch(() => {});
        }, duration * 1000);
      });

      const discoveredList = await scanPromise;

      // Also get existing devices from bluetoothctl
      const { stdout: devicesOutput } = await execAsync('bluetoothctl devices', { timeout: 5000 });
      const existingDevices = this.parseDeviceList(devicesOutput);

      // Merge discovered with existing
      const allDevices = new Map();
      for (const device of existingDevices) {
        allDevices.set(device.macAddress, device);
      }
      for (const device of discoveredList) {
        allDevices.set(device.macAddress, { ...allDevices.get(device.macAddress), ...device });
      }

      const deviceArray = Array.from(allDevices.values());

      // Save discovered devices to database
      for (const device of deviceArray) {
        await BluetoothDevice.upsertFromScan(device);
      }

      logger.info(`Bluetooth scan complete: found ${deviceArray.length} devices`);

      return {
        success: true,
        count: deviceArray.length,
        duration,
        devices: deviceArray,
        message: `Found ${deviceArray.length} Bluetooth devices`
      };
    } catch (error) {
      logger.error('Bluetooth scan failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * List paired devices
   */
  async listPairedDevices() {
    try {
      if (this.bluetoothAvailable) {
        const { stdout } = await execAsync('bluetoothctl devices Paired', { timeout: 5000 });
        const devices = this.parseDeviceList(stdout);

        // Update database
        for (const device of devices) {
          await BluetoothDevice.upsertFromScan({ ...device, paired: true });
        }

        return {
          success: true,
          count: devices.length,
          devices,
          message: `${devices.length} paired device(s)`
        };
      }

      // Fall back to database
      const devices = await BluetoothDevice.getPairedDevices();
      return {
        success: true,
        count: devices.length,
        devices,
        cached: true
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * List connected devices
   */
  async listConnectedDevices() {
    try {
      if (this.bluetoothAvailable) {
        const { stdout } = await execAsync('bluetoothctl devices Connected', { timeout: 5000 });
        const devices = this.parseDeviceList(stdout);

        // Update database
        for (const device of devices) {
          await BluetoothDevice.upsertFromScan({ ...device, connected: true });
        }

        return {
          success: true,
          count: devices.length,
          devices,
          message: `${devices.length} connected device(s)`
        };
      }

      // Fall back to database
      const devices = await BluetoothDevice.getConnectedDevices();
      return {
        success: true,
        count: devices.length,
        devices,
        cached: true
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Pair with a device
   */
  async pairDevice({ address, name }) {
    if (!this.bluetoothAvailable) {
      return { success: false, error: 'Bluetooth not available' };
    }

    try {
      // Resolve address from name if needed
      const targetAddress = address || await this.resolveDeviceAddress(name);
      if (!targetAddress) {
        return { success: false, error: `Device not found: ${name || address}` };
      }

      logger.info(`Pairing with device: ${targetAddress}`);

      // Attempt to pair
      const { stdout, stderr } = await execAsync(`bluetoothctl pair ${targetAddress}`, {
        timeout: 30000
      });

      const output = stdout + stderr;
      const success = output.includes('Pairing successful') || output.includes('already paired');

      // Record event
      await BluetoothDevice.recordEvent(targetAddress, 'pair', success, success ? null : output);

      if (success) {
        return {
          success: true,
          address: targetAddress,
          message: `Successfully paired with ${targetAddress}`
        };
      } else {
        return {
          success: false,
          address: targetAddress,
          error: output.includes('Failed') ? 'Pairing failed - device may require PIN or confirmation' : output
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Unpair/remove a device
   */
  async unpairDevice({ address, name }) {
    if (!this.bluetoothAvailable) {
      return { success: false, error: 'Bluetooth not available' };
    }

    try {
      const targetAddress = address || await this.resolveDeviceAddress(name);
      if (!targetAddress) {
        return { success: false, error: `Device not found: ${name || address}` };
      }

      logger.info(`Removing device: ${targetAddress}`);

      const { stdout, stderr } = await execAsync(`bluetoothctl remove ${targetAddress}`, {
        timeout: 10000
      });

      const output = stdout + stderr;
      const success = output.includes('Device has been removed') || output.includes('removed');

      await BluetoothDevice.recordEvent(targetAddress, 'unpair', success);

      return {
        success,
        address: targetAddress,
        message: success ? `Device ${targetAddress} removed` : output
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Connect to a device
   */
  async connectDevice({ address, name }) {
    if (!this.bluetoothAvailable) {
      return { success: false, error: 'Bluetooth not available' };
    }

    try {
      const targetAddress = address || await this.resolveDeviceAddress(name);
      if (!targetAddress) {
        return { success: false, error: `Device not found: ${name || address}` };
      }

      logger.info(`Connecting to device: ${targetAddress}`);

      const { stdout, stderr } = await execAsync(`bluetoothctl connect ${targetAddress}`, {
        timeout: 30000
      });

      const output = stdout + stderr;
      const success = output.includes('Connection successful') || output.includes('Connected: yes');

      await BluetoothDevice.recordEvent(targetAddress, 'connect', success, success ? null : output);

      return {
        success,
        address: targetAddress,
        message: success ? `Connected to ${targetAddress}` : `Failed to connect: ${output}`
      };
    } catch (error) {
      await BluetoothDevice.recordEvent(address, 'connect', false, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Disconnect from a device
   */
  async disconnectDevice({ address, name }) {
    if (!this.bluetoothAvailable) {
      return { success: false, error: 'Bluetooth not available' };
    }

    try {
      const targetAddress = address || await this.resolveDeviceAddress(name);
      if (!targetAddress) {
        return { success: false, error: `Device not found: ${name || address}` };
      }

      logger.info(`Disconnecting from device: ${targetAddress}`);

      const { stdout, stderr } = await execAsync(`bluetoothctl disconnect ${targetAddress}`, {
        timeout: 10000
      });

      const output = stdout + stderr;
      const success = output.includes('Successful disconnection') || output.includes('Connected: no');

      await BluetoothDevice.recordEvent(targetAddress, 'disconnect', success);

      return {
        success,
        address: targetAddress,
        message: success ? `Disconnected from ${targetAddress}` : output
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Trust a device (allow auto-connect)
   */
  async trustDevice({ address, name }) {
    if (!this.bluetoothAvailable) {
      return { success: false, error: 'Bluetooth not available' };
    }

    try {
      const targetAddress = address || await this.resolveDeviceAddress(name);
      if (!targetAddress) {
        return { success: false, error: `Device not found: ${name || address}` };
      }

      const { stdout, stderr } = await execAsync(`bluetoothctl trust ${targetAddress}`, {
        timeout: 10000
      });

      const output = stdout + stderr;
      const success = output.includes('trust succeeded') || output.includes('Trusted: yes');

      await BluetoothDevice.recordEvent(targetAddress, 'trust', success);

      return {
        success,
        address: targetAddress,
        message: success ? `Device ${targetAddress} is now trusted` : output
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Untrust a device
   */
  async untrustDevice({ address, name }) {
    if (!this.bluetoothAvailable) {
      return { success: false, error: 'Bluetooth not available' };
    }

    try {
      const targetAddress = address || await this.resolveDeviceAddress(name);
      if (!targetAddress) {
        return { success: false, error: `Device not found: ${name || address}` };
      }

      const { stdout, stderr } = await execAsync(`bluetoothctl untrust ${targetAddress}`, {
        timeout: 10000
      });

      const output = stdout + stderr;
      const success = output.includes('untrust succeeded') || output.includes('Trusted: no');

      await BluetoothDevice.recordEvent(targetAddress, 'untrust', success);

      return {
        success,
        address: targetAddress,
        message: success ? `Device ${targetAddress} is no longer trusted` : output
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Block a device
   */
  async blockDevice({ address, name }) {
    if (!this.bluetoothAvailable) {
      return { success: false, error: 'Bluetooth not available' };
    }

    try {
      const targetAddress = address || await this.resolveDeviceAddress(name);
      if (!targetAddress) {
        return { success: false, error: `Device not found: ${name || address}` };
      }

      const { stdout, stderr } = await execAsync(`bluetoothctl block ${targetAddress}`, {
        timeout: 10000
      });

      const output = stdout + stderr;
      const success = output.includes('block succeeded') || output.includes('Blocked: yes');

      await BluetoothDevice.recordEvent(targetAddress, 'block', success);

      return {
        success,
        address: targetAddress,
        message: success ? `Device ${targetAddress} is now blocked` : output
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get detailed device info
   */
  async getDeviceInfo({ address, name }) {
    try {
      const targetAddress = address || await this.resolveDeviceAddress(name);
      if (!targetAddress) {
        return { success: false, error: `Device not found: ${name || address}` };
      }

      if (this.bluetoothAvailable) {
        const { stdout } = await execAsync(`bluetoothctl info ${targetAddress}`, {
          timeout: 5000
        });
        const info = this.parseDeviceInfo(stdout);

        // Update database
        if (info.name) {
          await BluetoothDevice.upsertFromScan({ macAddress: targetAddress, ...info });
        }

        return {
          success: true,
          address: targetAddress,
          info
        };
      }

      // Fall back to database
      const device = await BluetoothDevice.findOne({ macAddress: targetAddress.toUpperCase() });
      if (!device) {
        return { success: false, error: 'Device not found in database' };
      }

      return {
        success: true,
        address: targetAddress,
        info: device.toObject(),
        cached: true
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Resolve device address from name
   */
  async resolveDeviceAddress(name) {
    if (!name) return null;

    // Check if it's already a MAC address
    if (/^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i.test(name)) {
      return name.toUpperCase();
    }

    // Search in database first
    const device = await BluetoothDevice.findByNameOrAlias(name);
    if (device) {
      return device.macAddress;
    }

    // Search via bluetoothctl
    if (this.bluetoothAvailable) {
      const { stdout } = await execAsync('bluetoothctl devices', { timeout: 5000 });
      const devices = this.parseDeviceList(stdout);
      const match = devices.find(d =>
        d.name.toLowerCase().includes(name.toLowerCase())
      );
      if (match) {
        return match.macAddress;
      }
    }

    return null;
  }

  /**
   * Parse device list from bluetoothctl output
   */
  parseDeviceList(output) {
    const devices = [];
    const lines = output.trim().split('\n');

    for (const line of lines) {
      const match = line.match(/Device\s+([A-F0-9:]+)\s+(.+)/i);
      if (match) {
        devices.push({
          macAddress: match[1],
          name: match[2].trim()
        });
      }
    }

    return devices;
  }

  /**
   * Parse device info from bluetoothctl output
   */
  parseDeviceInfo(output) {
    const info = {};
    const lines = output.trim().split('\n');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).trim().toLowerCase();
      const value = line.substring(colonIndex + 1).trim();

      switch (key) {
        case 'name':
          info.name = value;
          break;
        case 'alias':
          info.alias = value;
          break;
        case 'class':
          info.deviceClass = value;
          break;
        case 'icon':
          info.icon = value;
          break;
        case 'paired':
          info.paired = value === 'yes';
          break;
        case 'trusted':
          info.trusted = value === 'yes';
          break;
        case 'blocked':
          info.blocked = value === 'yes';
          break;
        case 'connected':
          info.connected = value === 'yes';
          break;
        case 'modalias':
          info.modalias = value;
          break;
      }
    }

    return info;
  }

  /**
   * Parse adapter info from bluetoothctl output
   */
  parseAdapterInfo(output) {
    const info = {};
    const lines = output.trim().split('\n');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).trim().toLowerCase();
      const value = line.substring(colonIndex + 1).trim();

      switch (key) {
        case 'name':
          info.name = value;
          break;
        case 'powered':
          info.powered = value === 'yes';
          break;
        case 'discoverable':
          info.discoverable = value === 'yes';
          break;
        case 'pairable':
          info.pairable = value === 'yes';
          break;
        case 'address':
          info.address = value;
          break;
      }
    }

    return info;
  }

  /**
   * Natural language handler
   */
  async handleNaturalLanguage(query) {
    const lowerQuery = query.toLowerCase();

    // Scan commands
    if (lowerQuery.match(/(?:scan|search|find|discover|look)\s*(?:for\s*)?(?:nearby\s*)?bluetooth/i) ||
        lowerQuery.match(/bluetooth\s*(?:scan|search|discover)/i)) {
      const durationMatch = lowerQuery.match(/(\d+)\s*(?:second|sec|s)/i);
      const duration = durationMatch ? parseInt(durationMatch[1]) : 10;
      return await this.scanDevices({ duration });
    }

    // List paired
    if (lowerQuery.match(/(?:list|show|what)\s*(?:are\s*)?(?:my\s*)?paired\s*(?:bluetooth\s*)?devices?/i) ||
        lowerQuery.match(/(?:paired|bonded)\s*(?:bluetooth\s*)?devices?/i)) {
      return await this.listPairedDevices();
    }

    // List connected
    if (lowerQuery.match(/(?:list|show|what)\s*(?:is|are)\s*connected/i) ||
        lowerQuery.match(/connected\s*(?:bluetooth\s*)?devices?/i)) {
      return await this.listConnectedDevices();
    }

    // Pair commands
    const pairMatch = lowerQuery.match(/pair\s+(?:with\s+)?(?:my\s+)?(?:the\s+)?(.+)/i);
    if (pairMatch) {
      const name = pairMatch[1].replace(/\s*bluetooth\s*/gi, '').trim();
      return await this.pairDevice({ name });
    }

    // Connect commands
    const connectMatch = lowerQuery.match(/connect\s+(?:to\s+)?(?:my\s+)?(?:the\s+)?(.+)/i);
    if (connectMatch) {
      const name = connectMatch[1].replace(/\s*bluetooth\s*/gi, '').trim();
      return await this.connectDevice({ name });
    }

    // Disconnect commands
    const disconnectMatch = lowerQuery.match(/disconnect\s+(?:from\s+)?(?:my\s+)?(?:the\s+)?(.+)/i);
    if (disconnectMatch) {
      const name = disconnectMatch[1].replace(/\s*bluetooth\s*/gi, '').trim();
      return await this.disconnectDevice({ name });
    }

    // Unpair/remove commands
    const unpairMatch = lowerQuery.match(/(?:unpair|remove|forget)\s+(?:my\s+)?(?:the\s+)?(.+)/i);
    if (unpairMatch) {
      const name = unpairMatch[1].replace(/\s*bluetooth\s*/gi, '').replace(/device/gi, '').trim();
      return await this.unpairDevice({ name });
    }

    // Status
    if (lowerQuery.match(/bluetooth\s*(?:status|adapter|controller)/i)) {
      return await this.getAdapterStatus();
    }

    // Default - show capabilities
    return {
      success: true,
      message: "I can help with Bluetooth devices. Try:",
      capabilities: [
        "scan for bluetooth devices",
        "list paired devices",
        "list connected devices",
        "pair with [device name]",
        "connect to [device name]",
        "disconnect from [device name]"
      ]
    };
  }

  /**
   * Web UI configuration
   */
  getUIConfig() {
    return {
      menuItem: {
        id: 'bluetooth',
        title: 'Bluetooth',
        icon: 'fab fa-bluetooth-b',
        order: 76,
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
        .bt-container { padding: 1rem; }
        .bt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
        .bt-actions { display: flex; gap: 0.5rem; }
        .bt-device-list { display: grid; gap: 0.75rem; }
        .bt-device {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 1rem;
          background: var(--bg-secondary);
          border-radius: 8px;
        }
        .bt-device-icon {
          font-size: 1.5rem;
          width: 40px;
          text-align: center;
          color: var(--accent);
        }
        .bt-device-info { flex: 1; }
        .bt-device-name { font-weight: 500; }
        .bt-device-address { font-size: 0.75rem; color: var(--text-secondary); font-family: monospace; }
        .bt-device-status { display: flex; gap: 0.5rem; margin-top: 0.25rem; }
        .bt-badge {
          font-size: 0.625rem;
          padding: 0.125rem 0.375rem;
          border-radius: 10px;
          text-transform: uppercase;
        }
        .bt-badge-paired { background: #3b82f620; color: #3b82f6; }
        .bt-badge-connected { background: #22c55e20; color: #22c55e; }
        .bt-badge-trusted { background: #f59e0b20; color: #f59e0b; }
        .bt-device-actions { display: flex; gap: 0.25rem; }
        .bt-device-actions button { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
        .bt-loading { text-align: center; padding: 2rem; color: var(--text-secondary); }
        .bt-empty { text-align: center; padding: 3rem; color: var(--text-secondary); }
        .bt-section { margin-top: 1.5rem; }
        .bt-section-title { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: var(--text-secondary); }
        .bt-scan-status { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; }
        @media (max-width: 768px) {
          .bt-header { flex-direction: column; gap: 1rem; text-align: center; }
          .bt-actions { width: 100%; justify-content: center; }
          .bt-device { flex-direction: column; align-items: stretch; text-align: center; }
          .bt-device-icon { width: 100%; margin-bottom: 0.5rem; }
          .bt-device-status { justify-content: center; }
          .bt-device-actions { flex-direction: column; width: 100%; margin-top: 0.75rem; }
          .bt-device-actions button { width: 100%; padding: 0.5rem; text-align: center; justify-content: center; }
        }
      </style>

      <div class="bt-container">
        <div class="bt-header">
          <h2><i class="fab fa-bluetooth-b"></i> Bluetooth Devices</h2>
          <div class="bt-actions">
            <button class="btn btn-primary" onclick="btScan()" id="bt-scan-btn">
              <i class="fas fa-search"></i> Scan
            </button>
            <button class="btn btn-secondary" onclick="btRefresh()">
              <i class="fas fa-sync-alt"></i>
            </button>
          </div>
        </div>

        <div id="bt-scan-status" style="display: none;" class="bt-scan-status">
          <i class="fas fa-spinner fa-spin"></i>
          <span>Scanning for devices...</span>
        </div>

        <div class="bt-section">
          <div class="bt-section-title">Connected Devices</div>
          <div id="bt-connected" class="bt-device-list">
            <div class="bt-loading">Loading...</div>
          </div>
        </div>

        <div class="bt-section">
          <div class="bt-section-title">Paired Devices</div>
          <div id="bt-paired" class="bt-device-list">
            <div class="bt-loading">Loading...</div>
          </div>
        </div>

        <div class="bt-section">
          <div class="bt-section-title">Discovered Devices</div>
          <div id="bt-discovered" class="bt-device-list">
            <div class="bt-empty">Run a scan to discover nearby devices</div>
          </div>
        </div>
      </div>

      <script>
        (function() {
          const apiToken = localStorage.getItem('lanagent_token');
          let lastScanResults = [];

          async function btApi(action, data = {}) {
            const response = await fetch('/api/plugin', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + apiToken,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ plugin: 'bluetooth', action, ...data })
            });
            return await response.json();
          }

          function getDeviceIcon(device) {
            const iconMap = {
              'audio': 'fas fa-headphones',
              'input': 'fas fa-keyboard',
              'phone': 'fas fa-mobile-alt',
              'computer': 'fas fa-laptop'
            };
            return iconMap[device.deviceType] || 'fab fa-bluetooth-b';
          }

          function renderDevice(device, showActions = true) {
            const badges = [];
            if (device.paired) badges.push('<span class="bt-badge bt-badge-paired">Paired</span>');
            if (device.connected) badges.push('<span class="bt-badge bt-badge-connected">Connected</span>');
            if (device.trusted) badges.push('<span class="bt-badge bt-badge-trusted">Trusted</span>');

            let actions = '';
            if (showActions) {
              if (device.connected) {
                actions = '<button class="btn btn-sm btn-secondary" onclick="btDisconnect(\\'' + device.macAddress + '\\')">Disconnect</button>';
              } else if (device.paired) {
                actions = '<button class="btn btn-sm btn-primary" onclick="btConnect(\\'' + device.macAddress + '\\')">Connect</button>';
                actions += '<button class="btn btn-sm btn-secondary" onclick="btUnpair(\\'' + device.macAddress + '\\')">Remove</button>';
              } else {
                actions = '<button class="btn btn-sm btn-primary" onclick="btPair(\\'' + device.macAddress + '\\')">Pair</button>';
              }
            }

            return '<div class="bt-device">' +
              '<div class="bt-device-icon"><i class="' + getDeviceIcon(device) + '"></i></div>' +
              '<div class="bt-device-info">' +
                '<div class="bt-device-name">' + (device.name || 'Unknown Device') + '</div>' +
                '<div class="bt-device-address">' + device.macAddress + '</div>' +
                '<div class="bt-device-status">' + badges.join('') + '</div>' +
              '</div>' +
              '<div class="bt-device-actions">' + actions + '</div>' +
            '</div>';
          }

          async function loadDevices() {
            const [connected, paired] = await Promise.all([
              btApi('list-connected'),
              btApi('list-paired')
            ]);

            const connectedDiv = document.getElementById('bt-connected');
            const pairedDiv = document.getElementById('bt-paired');

            if (connected.success && connected.devices.length > 0) {
              connectedDiv.innerHTML = connected.devices.map(d => renderDevice({...d, connected: true})).join('');
            } else {
              connectedDiv.innerHTML = '<div class="bt-empty">No devices connected</div>';
            }

            if (paired.success && paired.devices.length > 0) {
              const nonConnected = paired.devices.filter(d =>
                !connected.devices?.find(c => c.macAddress === d.macAddress)
              );
              if (nonConnected.length > 0) {
                pairedDiv.innerHTML = nonConnected.map(d => renderDevice({...d, paired: true})).join('');
              } else {
                pairedDiv.innerHTML = '<div class="bt-empty">All paired devices are connected</div>';
              }
            } else {
              pairedDiv.innerHTML = '<div class="bt-empty">No paired devices</div>';
            }

            // Show last scan results
            if (lastScanResults.length > 0) {
              const discoveredDiv = document.getElementById('bt-discovered');
              const unpaired = lastScanResults.filter(d => !d.paired);
              if (unpaired.length > 0) {
                discoveredDiv.innerHTML = unpaired.map(d => renderDevice(d)).join('');
              }
            }
          }

          window.btScan = async function() {
            const btn = document.getElementById('bt-scan-btn');
            const status = document.getElementById('bt-scan-status');
            btn.disabled = true;
            status.style.display = 'flex';

            try {
              const result = await btApi('scan', { duration: 10 });
              if (result.success) {
                lastScanResults = result.devices || [];
                const discoveredDiv = document.getElementById('bt-discovered');
                if (lastScanResults.length > 0) {
                  discoveredDiv.innerHTML = lastScanResults.map(d => renderDevice(d)).join('');
                } else {
                  discoveredDiv.innerHTML = '<div class="bt-empty">No devices found</div>';
                }
              }
            } finally {
              btn.disabled = false;
              status.style.display = 'none';
              loadDevices();
            }
          };

          window.btRefresh = loadDevices;

          window.btConnect = async function(address) {
            const result = await btApi('connect', { address });
            if (result.success) {
              loadDevices();
            } else {
              alert('Failed to connect: ' + (result.error || 'Unknown error'));
            }
          };

          window.btDisconnect = async function(address) {
            const result = await btApi('disconnect', { address });
            loadDevices();
          };

          window.btPair = async function(address) {
            const result = await btApi('pair', { address });
            if (result.success) {
              loadDevices();
            } else {
              alert('Failed to pair: ' + (result.error || 'Unknown error'));
            }
          };

          window.btUnpair = async function(address) {
            if (confirm('Remove this device?')) {
              await btApi('unpair', { address });
              loadDevices();
            }
          };

          // Initial load
          loadDevices();
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
        method: 'POST',
        path: '/scan',
        handler: async (data) => await this.scanDevices(data)
      },
      {
        method: 'GET',
        path: '/paired',
        handler: async () => await this.listPairedDevices()
      },
      {
        method: 'GET',
        path: '/connected',
        handler: async () => await this.listConnectedDevices()
      },
      {
        method: 'POST',
        path: '/pair',
        handler: async (data) => await this.pairDevice(data)
      },
      {
        method: 'POST',
        path: '/connect',
        handler: async (data) => await this.connectDevice(data)
      },
      {
        method: 'POST',
        path: '/disconnect',
        handler: async (data) => await this.disconnectDevice(data)
      },
      {
        method: 'DELETE',
        path: '/device/:address',
        handler: async (data, req) => await this.unpairDevice({ address: req.params.address })
      },
      {
        method: 'GET',
        path: '/device/:address',
        handler: async (data, req) => await this.getDeviceInfo({ address: req.params.address })
      },
      {
        method: 'GET',
        path: '/status',
        handler: async () => await this.getAdapterStatus()
      }
    ];
  }
}
