import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export default class DeviceInfoPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'deviceInfo';
    this.version = '1.1.0';
    this.description = 'Detect and list all connected devices (USB, network, microcontrollers, IoT, etc.)';
    this.commands = [
      {
        command: 'listConnected',
        description: 'List all connected devices including USB, network, microcontrollers, and IoT devices',
        usage: 'listConnected'
      },
      {
        command: 'detectArduino',
        description: 'Detect Arduino boards and microcontrollers connected via USB',
        usage: 'detectArduino'
      },
      {
        command: 'detectAndroid',
        description: 'Detect Android devices connected via USB/ADB',
        usage: 'detectAndroid'
      },
      {
        command: 'detectBluetooth',
        description: 'Detect Bluetooth devices',
        usage: 'detectBluetooth'
      },
      {
        command: 'detectIoT',
        description: 'Detect IoT devices on the network',
        usage: 'detectIoT'
      }
    ];
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
  }

  async initialize() {
    logger.info('DeviceInfo plugin initialized');
  }

  async execute(params) {
    const { action = 'list' } = params;
    
    switch (action) {
      case 'list':
      case 'listConnected':
        return await this.listConnectedDevices();
      case 'detectArduino':
        return await this.detectArduino();
      case 'detectAndroid':
        return await this.detectAndroidDevices();
      case 'detectBluetooth':
        return await this.detectBluetoothDevices();
      case 'detectIoT':
        return await this.detectIoTDevices();
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async listConnectedDevices() {
    try {
      const devicePromises = [
        this.getNetworkDevices(),
        this.getUSBDevices(),
        this.getSerialDevices(),
        this.getStorageDevices(),
        this.getAndroidDevices(),
        this.getBluetoothDevices(),
        this.getIoTDevices()
      ];

      const [
        networkDevices,
        usbDevices,
        serialDevices,
        storageDevices,
        androidDevices,
        bluetoothDevices,
        iotDevices
      ] = await Promise.all(devicePromises);

      const devices = {
        network: networkDevices,
        usb: usbDevices,
        serial: serialDevices,
        storage: storageDevices,
        android: androidDevices,
        bluetooth: bluetoothDevices,
        iot: iotDevices,
        summary: {}
      };

      devices.summary = {
        totalDevices: 
          devices.network.length + 
          devices.usb.length + 
          devices.serial.length + 
          devices.storage.length +
          devices.android.length +
          devices.bluetooth.length +
          devices.iot.length,
        breakdown: {
          network: devices.network.length,
          usb: devices.usb.length,
          serial: devices.serial.length,
          storage: devices.storage.length,
          android: devices.android.length,
          bluetooth: devices.bluetooth.length,
          iot: devices.iot.length
        }
      };

      let response = "Connected devices:\n\n";
      
      if (devices.network.length > 0) {
        response += `**Network Devices (${devices.network.length}):**\n`;
        devices.network.forEach(dev => {
          response += `• ${dev.ip} - ${dev.mac}${dev.status ? ` (${dev.status})` : ''}\n`;
        });
        response += "\n";
      }

      if (devices.usb.length > 0) {
        response += `**USB Devices (${devices.usb.length}):**\n`;
        devices.usb.forEach(dev => {
          response += `• ${dev.name}${dev.manufacturer ? ` - ${dev.manufacturer}` : ''}\n`;
        });
        response += "\n";
      }

      if (devices.serial.length > 0) {
        response += `**Microcontrollers/Serial Devices (${devices.serial.length}):**\n`;
        devices.serial.forEach(dev => {
          response += `• ${dev.device} - ${dev.type || 'Unknown type'}\n`;
        });
        response += "\n";
      }

      if (devices.storage.length > 0) {
        response += `**Storage Devices (${devices.storage.length}):**\n`;
        devices.storage.forEach(dev => {
          const mountpoint = dev.mountpoint ? dev.mountpoint.replace(/\[/g, '\\[').replace(/\]/g, '\\]') : null;
          response += `• ${dev.name} - ${dev.size}${mountpoint ? ` mounted at ${mountpoint}` : ' (not mounted)'}\n`;
        });
        response += "\n";
      }

      if (devices.android.length > 0) {
        response += `**Android Devices (${devices.android.length}):**\n`;
        devices.android.forEach(dev => {
          response += `• ${dev.name} - ${dev.status}\n`;
        });
        response += "\n";
      } else {
        // Check if ADB is actually installed
        try {
          await execAsync('which adb');
          response += "**Android Devices:** No devices connected (USB debugging must be enabled)\n\n";
        } catch (error) {
          response += "**Android Devices:** ADB not installed - Android support not available\n\n";
        }
      }

      if (devices.bluetooth.length > 0) {
        response += `**Bluetooth Devices (${devices.bluetooth.length}):**\n`;
        devices.bluetooth.forEach(dev => {
          response += `• ${dev.name} - ${dev.address}\n`;
        });
        response += "\n";
      } else {
        response += "**Bluetooth Devices:** No Bluetooth devices detected\n\n";
      }

      if (devices.iot.length > 0) {
        response += `**IoT Devices (${devices.iot.length}):**\n`;
        devices.iot.forEach(dev => {
          response += `• ${dev.ip} - ${dev.type}\n`;
        });
      } else {
        response += "**IoT Devices:** No IoT devices detected\n";
      }

      response += `\n**Total: ${devices.summary.totalDevices} devices connected**`;

      return {
        success: true,
        message: response,
        devices,
        formatted: response
      };
    } catch (error) {
      logger.error('Failed to list connected devices:', error);
      throw error;
    }
  }

  async getCachedData(key) {
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }
    }
    return null;
  }

  async setCachedData(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async getNetworkDevices() {
    const cacheKey = 'networkDevices';
    const cachedData = await this.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    try {
      const { stdout } = await execAsync("ip neigh show | grep -E 'REACHABLE|STALE|DELAY'");
      const lines = stdout.trim().split('\n').filter(line => line);
      
      const devices = lines.map(line => {
        const parts = line.split(' ');
        return {
          ip: parts[0],
          device: parts[2],
          mac: parts[4],
          status: parts[parts.length - 1].replace(/[()]/g, '')
        };
      });

      await this.setCachedData(cacheKey, devices);
      return devices;
    } catch (error) {
      logger.warn('Failed to get network devices:', error);
      return [];
    }
  }

  async getUSBDevices() {
    const cacheKey = 'usbDevices';
    const cachedData = await this.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    try {
      const { stdout } = await execAsync('lsusb');
      const lines = stdout.trim().split('\n').filter(line => line);
      
      const devices = lines.map(line => {
        const match = line.match(/ID ([0-9a-f]{4}:[0-9a-f]{4})\s+(.+)/i);
        if (match) {
          const [, id, name] = match;
          if (!name.includes('hub') && !name.includes('root')) {
            const cleanName = name.replace(/,?\s+Inc\.|,?\s+Ltd\.?/, '').trim();
            const parts = cleanName.split(' ');
            return {
              id,
              manufacturer: parts[0],
              name: cleanName,
              fullName: name
            };
          }
        }
        return null;
      }).filter(dev => dev !== null);

      await this.setCachedData(cacheKey, devices);
      return devices;
    } catch (error) {
      logger.warn('Failed to get USB devices:', error);
      return [];
    }
  }

  async getSerialDevices() {
    const cacheKey = 'serialDevices';
    const cachedData = await this.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    try {
      const devices = [];
      
      try {
        const { stdout: ttyUSB } = await execAsync('ls -la /dev/ttyUSB* 2>/dev/null');
        const usbLines = ttyUSB.trim().split('\n').filter(line => line);
        
        for (const line of usbLines) {
          const match = line.match(/\/dev\/ttyUSB\d+$/);
          if (match) {
            const device = match[0];
            let deviceType = 'Serial Device';
            
            try {
              const { stdout: dmesg } = await execAsync(`dmesg | grep -i "${device.replace('/dev/', '')}" | grep -i -E "esp32|cp210x|ch340|ftdi" | tail -1`);
              if (dmesg.includes('cp210x') || dmesg.includes('CP210x')) {
                deviceType = 'ESP32/ESP8266 (CP210x)';
              } else if (dmesg.includes('ch340') || dmesg.includes('CH340')) {
                deviceType = 'Arduino/Clone (CH340)';
              } else if (dmesg.includes('ftdi') || dmesg.includes('FTDI')) {
                deviceType = 'Arduino (FTDI)';
              }
            } catch (e) {
            }
            
            devices.push({
              device,
              type: deviceType
            });
          }
        }
      } catch (e) {
      }

      try {
        const { stdout: ttyACM } = await execAsync('ls -la /dev/ttyACM* 2>/dev/null');
        const acmLines = ttyACM.trim().split('\n').filter(line => line);
        
        acmLines.forEach(line => {
          const match = line.match(/\/dev\/ttyACM\d+$/);
          if (match) {
            devices.push({
              device: match[0],
              type: 'Arduino (Native USB)'
            });
          }
        });
      } catch (e) {
      }

      await this.setCachedData(cacheKey, devices);
      return devices;
    } catch (error) {
      logger.warn('Failed to get serial devices:', error);
      return [];
    }
  }

  async getStorageDevices() {
    const cacheKey = 'storageDevices';
    const cachedData = await this.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    try {
      const { stdout } = await execAsync("lsblk -J -o NAME,SIZE,TYPE,MOUNTPOINT");
      const data = JSON.parse(stdout);
      const devices = [];

      const processDevice = (device) => {
        if (device.type === 'disk') {
          devices.push({
            name: device.name,
            size: device.size,
            type: device.type,
            mountpoint: device.mountpoint
          });
        }
        if (device.children) {
          device.children.forEach(child => {
            if (child.type === 'part' && child.mountpoint) {
              devices.push({
                name: `${device.name}/${child.name}`,
                size: child.size,
                type: 'partition',
                mountpoint: child.mountpoint
              });
            }
          });
        }
      };

      data.blockdevices.forEach(processDevice);
      
      const filteredDevices = devices.filter(dev => !dev.name.startsWith('loop'));
      await this.setCachedData(cacheKey, filteredDevices);
      return filteredDevices;
    } catch (error) {
      logger.warn('Failed to get storage devices:', error);
      return [];
    }
  }

  async getAndroidDevices() {
    const cacheKey = 'androidDevices';
    const cachedData = await this.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    try {
      await execAsync('which adb');
      
      const { stdout } = await execAsync('adb devices');
      const lines = stdout.trim().split('\n').filter((line, index) => index > 0 && line.trim());
      
      const devices = lines.map(line => {
        const [device, status] = line.split('\t');
        return { name: device, status: status || 'unknown' };
      });

      await this.setCachedData(cacheKey, devices);
      return devices;
    } catch (error) {
      return [];
    }
  }

  async detectArduino() {
    const devices = await this.getSerialDevices();
    const arduinoDevices = devices.filter(dev => 
      dev.type.toLowerCase().includes('arduino') || 
      dev.type.toLowerCase().includes('esp')
    );

    if (arduinoDevices.length > 0) {
      return {
        success: true,
        found: true,
        devices: arduinoDevices,
        message: `Found ${arduinoDevices.length} Arduino/ESP device(s):\n` +
                 arduinoDevices.map(d => `• ${d.device} - ${d.type}`).join('\n')
      };
    } else {
      return {
        success: true,
        found: false,
        devices: [],
        message: 'No Arduino or ESP devices detected. Make sure the device is connected via USB.'
      };
    }
  }

  async detectAndroidDevices() {
    const devices = await this.getAndroidDevices();
    
    if (devices.length > 0) {
      return {
        success: true,
        found: true,
        devices,
        message: `Found ${devices.length} Android device(s):\n` +
                 devices.map(d => `• ${d.name} - ${d.status}`).join('\n')
      };
    } else {
      try {
        await execAsync('which adb');
        return {
          success: true,
          found: false,
          devices: [],
          message: 'No Android devices detected. Make sure USB debugging is enabled and the device is connected.'
        };
      } catch (error) {
        return {
          success: true,
          found: false,
          devices: [],
          message: 'Android Debug Bridge (ADB) is not installed. Install ADB to detect Android devices.'
        };
      }
    }
  }

  async getBluetoothDevices() {
    const cacheKey = 'bluetoothDevices';
    const cachedData = await this.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    try {
      const { stdout } = await execAsync('bluetoothctl devices');
      const lines = stdout.trim().split('\n').filter(line => line);
      
      const devices = lines.map(line => {
        const match = line.match(/Device\s([0-9A-F:]+)\s(.+)/i);
        if (match) {
          const [, address, name] = match;
          return { address, name };
        }
        return null;
      }).filter(dev => dev !== null);

      await this.setCachedData(cacheKey, devices);
      return devices;
    } catch (error) {
      logger.warn('Failed to get Bluetooth devices:', error);
      return [];
    }
  }

  async detectBluetoothDevices() {
    const devices = await this.getBluetoothDevices();
    
    if (devices.length > 0) {
      return {
        success: true,
        found: true,
        devices,
        message: `Found ${devices.length} Bluetooth device(s):\n` +
                 devices.map(d => `• ${d.name} - ${d.address}`).join('\n')
      };
    } else {
      return {
        success: true,
        found: false,
        devices: [],
        message: 'No Bluetooth devices detected. Make sure Bluetooth is enabled and devices are discoverable.'
      };
    }
  }

  async getIoTDevices() {
    const cacheKey = 'iotDevices';
    const cachedData = await this.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    try {
      const devices = [];
      const { stdout } = await execAsync('nmap -p 1883,5683 --open -oG - 192.168.1.0/24');
      const lines = stdout.trim().split('\n').filter(line => line.includes('Ports:'));
      
      lines.forEach(line => {
        const match = line.match(/Host:\s([\d.]+).*Ports:\s.*\s(\d+)\/open/);
        if (match) {
          const [, ip, port] = match;
          let type = 'Unknown IoT Device';
          if (port === '1883') {
            type = 'MQTT Device';
          } else if (port === '5683') {
            type = 'CoAP Device';
          }
          devices.push({ ip, type });
        }
      });

      await this.setCachedData(cacheKey, devices);
      return devices;
    } catch (error) {
      logger.warn('Failed to detect IoT devices:', error);
      return [];
    }
  }

  async detectIoTDevices() {
    const devices = await this.getIoTDevices();
    
    if (devices.length > 0) {
      return {
        success: true,
        found: true,
        devices,
        message: `Found ${devices.length} IoT device(s):\n` +
                 devices.map(d => `• ${d.ip} - ${d.type}`).join('\n')
      };
    } else {
      return {
        success: true,
        found: false,
        devices: [],
        message: 'No IoT devices detected on the network.'
      };
    }
  }
}