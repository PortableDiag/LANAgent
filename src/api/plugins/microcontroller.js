import { BasePlugin } from '../core/basePlugin.js';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { getTemplate, listTemplates } from './microcontroller-templates.js';

const execAsync = promisify(exec);

export default class MicrocontrollerPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'microcontroller';
    this.version = '1.1.0';
    this.description = 'Arduino, ESP32/ESP8266, and Raspberry Pi Pico device management and programming';
    this.commands = [
      {
        command: 'list-devices',
        description: 'List all connected microcontroller devices',
        usage: 'list-devices()'
      },
      {
        command: 'connect',
        description: 'Connect to a microcontroller via serial port',
        usage: 'connect({ port: "/dev/ttyUSB0", baudRate: 9600 })'
      },
      {
        command: 'disconnect',
        description: 'Disconnect from a microcontroller',
        usage: 'disconnect({ port: "/dev/ttyUSB0" })'
      },
      {
        command: 'upload',
        description: 'Upload code to a microcontroller',
        usage: 'upload({ port: "/dev/ttyUSB0", board: "arduino:avr:uno", code: "void setup() {...}", sketch: "my_sketch" })'
      },
      {
        command: 'monitor',
        description: 'Monitor serial output from a microcontroller',
        usage: 'monitor({ port: "/dev/ttyUSB0", duration: 30 })'
      },
      {
        command: 'compile',
        description: 'Compile Arduino sketch without uploading',
        usage: 'compile({ board: "arduino:avr:uno", code: "void setup() {...}" })'
      },
      {
        command: 'detect-boards',
        description: 'Detect connected Arduino boards automatically',
        usage: 'detect-boards()'
      },
      {
        command: 'install-core',
        description: 'Install Arduino core for specific board types',
        usage: 'install-core({ core: "esp32:esp32" })'
      },
      {
        command: 'list-templates',
        description: 'List available code templates',
        usage: 'list-templates()'
      },
      {
        command: 'upload-template',
        description: 'Upload a pre-made template to a microcontroller',
        usage: 'upload-template({ port: "/dev/ttyUSB0", board: "arduino:avr:uno", template: "blink" })'
      }
    ];
    
    this.connectedDevices = new Map();
    this.activeMonitors = new Map();
    this.supportedBoards = {
      'arduino:avr:uno': 'Arduino Uno',
      'arduino:avr:mega': 'Arduino Mega',
      'arduino:avr:nano': 'Arduino Nano',
      'arduino:avr:nano:cpu=atmega328old': 'Arduino Nano (Old Bootloader)',
      'arduino:avr:nano:cpu=atmega328': 'Arduino Nano (New Bootloader)',
      'rp2040:rp2040:rpipico': 'Raspberry Pi Pico',
      'rp2040:rp2040:rpipicow': 'Raspberry Pi Pico W',
      'esp32:esp32:esp32': 'ESP32',
      'esp8266:esp8266:generic': 'ESP8266',
      'esp8266:esp8266:nodemcuv2': 'NodeMCU'
    };
  }

  async initialize() {
    try {
      // Check if arduino-cli is installed
      const { stdout } = await execAsync('arduino-cli version');
      logger.info(`Arduino CLI found: ${stdout.trim()}`);
      
      // Initialize arduino-cli config if needed
      await this.initializeArduinoCLI();
      
      this.initialized = true;
      return true;
    } catch (error) {
      if (error.message.includes('arduino-cli: command not found') || 
          error.message.includes('arduino-cli: not found')) {
        logger.warn('Arduino CLI not found. Installing...');
        try {
          await this.installArduinoCLI();
          this.initialized = true;
          return true;
        } catch (installError) {
          logger.error('Failed to install Arduino CLI:', installError);
          // Still return true to allow plugin to load for basic serial operations
          this.initialized = false;
          return true;
        }
      } else {
        logger.error('Arduino CLI initialization error:', error);
        // Still return true to allow plugin to load
        this.initialized = true;
        return true;
      }
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'list-devices':
        return await this.listDevices();
      
      case 'connect':
        return await this.connectDevice(data.port, data.baudRate);
      
      case 'disconnect':
        return await this.disconnectDevice(data.port);
      
      case 'upload':
        return await this.uploadCode(data.port, data.board, data.code, data.sketch);
      
      case 'monitor':
        return await this.monitorSerial(data.port, data.duration);
      
      case 'compile':
        return await this.compileSketch(data.board, data.code);
      
      case 'detect-boards':
        return await this.detectBoards();
      
      case 'install-core':
        return await this.installCore(data.core);
      
      case 'list-templates':
        return this.listTemplates();
      
      case 'upload-template':
        return await this.uploadTemplate(data.port, data.board, data.template);
      
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async listDevices() {
    try {
      const ports = await SerialPort.list();
      const devices = [];

      for (const port of ports) {
        const device = {
          path: port.path,
          manufacturer: port.manufacturer,
          serialNumber: port.serialNumber,
          pnpId: port.pnpId,
          vendorId: port.vendorId,
          productId: port.productId
        };

        // Try to identify the board type
        if (port.manufacturer) {
          if (port.manufacturer.includes('Arduino')) {
            device.type = 'Arduino';
            device.board = this.identifyArduinoBoard(port);
          } else if (port.manufacturer.includes('Raspberry Pi')) {
            device.type = 'Raspberry Pi Pico';
            device.board = this.identifyArduinoBoard(port);
          } else if (port.manufacturer.includes('Silicon Labs') || 
                     port.path.includes('USB')) {
            device.type = 'ESP';
            device.board = 'ESP32/ESP8266';
          }
        }
        
        // Also check by VID/PID if manufacturer not detected
        if (!device.type && port.vendorId) {
          const boardName = this.identifyArduinoBoard(port);
          if (boardName.includes('Raspberry Pi Pico')) {
            device.type = 'Raspberry Pi Pico';
            device.board = boardName;
          } else if (boardName.includes('Arduino') || boardName.includes('Nano')) {
            device.type = 'Arduino';
            device.board = boardName;
          }
        }

        devices.push(device);
      }

      // Also check for boards using arduino-cli
      try {
        const { stdout } = await execAsync('arduino-cli board list --format json');
        const boardList = JSON.parse(stdout);
        
        for (const board of boardList) {
          const existingDevice = devices.find(d => d.path === board.port.address);
          if (existingDevice && board.boards && board.boards.length > 0) {
            existingDevice.detectedBoard = board.boards[0].name;
            existingDevice.fqbn = board.boards[0].fqbn;
          }
        }
      } catch (error) {
        logger.warn('Could not get board list from arduino-cli');
      }

      return {
        success: true,
        devices,
        message: `Found ${devices.length} device(s)`
      };
    } catch (error) {
      throw new Error(`Failed to list devices: ${error.message}`);
    }
  }

  async connectDevice(port, baudRate = 9600) {
    if (this.connectedDevices.has(port)) {
      return {
        success: false,
        message: 'Device already connected'
      };
    }

    try {
      const serialPort = new SerialPort({
        path: port,
        baudRate: baudRate,
        autoOpen: false
      });

      await new Promise((resolve, reject) => {
        serialPort.open(err => {
          if (err) reject(err);
          else resolve();
        });
      });

      const parser = new ReadlineParser();
      serialPort.pipe(parser);

      // Store connection info
      this.connectedDevices.set(port, {
        port: serialPort,
        parser: parser,
        baudRate: baudRate,
        connectedAt: new Date()
      });

      return {
        success: true,
        message: `Connected to ${port} at ${baudRate} baud`
      };
    } catch (error) {
      throw new Error(`Failed to connect: ${error.message}`);
    }
  }

  async disconnectDevice(port) {
    const connection = this.connectedDevices.get(port);
    if (!connection) {
      return {
        success: false,
        message: 'Device not connected'
      };
    }

    try {
      // Stop any active monitoring
      if (this.activeMonitors.has(port)) {
        const monitor = this.activeMonitors.get(port);
        monitor.stop = true;
        this.activeMonitors.delete(port);
      }

      // Close the port
      await new Promise((resolve) => {
        connection.port.close(() => resolve());
      });

      this.connectedDevices.delete(port);

      return {
        success: true,
        message: `Disconnected from ${port}`
      };
    } catch (error) {
      throw new Error(`Failed to disconnect: ${error.message}`);
    }
  }

  async uploadCode(port, board, code, sketchName = 'temp_sketch') {
    try {
      // Create temporary directory for sketch
      const tempDir = path.join('/tmp', `arduino_${Date.now()}`);
      const sketchDir = path.join(tempDir, sketchName);
      await fs.mkdir(sketchDir, { recursive: true });

      // Write code to .ino file
      const sketchFile = path.join(sketchDir, `${sketchName}.ino`);
      await fs.writeFile(sketchFile, code);

      // Compile the sketch
      logger.info(`Compiling sketch for ${board}...`);
      const compileCmd = `arduino-cli compile --fqbn ${board} ${sketchDir}`;
      const { stdout: compileOut, stderr: compileErr } = await execAsync(compileCmd);

      if (compileErr && !compileErr.includes('warning')) {
        throw new Error(`Compilation failed: ${compileErr}`);
      }

      // Upload to board
      logger.info(`Uploading to ${port}...`);
      const uploadCmd = `arduino-cli upload -p ${port} --fqbn ${board} ${sketchDir}`;
      const { stdout: uploadOut, stderr: uploadErr } = await execAsync(uploadCmd);

      if (uploadErr && !uploadErr.includes('warning')) {
        throw new Error(`Upload failed: ${uploadErr}`);
      }

      // Clean up
      await fs.rm(tempDir, { recursive: true });

      // Notify success
      await this.notify(`✅ Code uploaded successfully to ${board} on ${port}`);

      return {
        success: true,
        message: 'Code uploaded successfully',
        compileOutput: compileOut,
        uploadOutput: uploadOut
      };
    } catch (error) {
      throw new Error(`Failed to upload code: ${error.message}`);
    }
  }

  async monitorSerial(port, duration = 30) {
    const connection = this.connectedDevices.get(port);
    if (!connection) {
      return {
        success: false,
        message: 'Device not connected. Please connect first.'
      };
    }

    return new Promise((resolve) => {
      const output = [];
      const monitor = {
        stop: false,
        startTime: Date.now()
      };

      this.activeMonitors.set(port, monitor);

      const dataHandler = (data) => {
        const line = data.toString().trim();
        if (line) {
          output.push({
            timestamp: new Date().toISOString(),
            data: line
          });
          
          // Send to Telegram if monitoring is active
          if (output.length % 10 === 0) {
            this.notify(`📡 Serial Monitor (${port}):\n${line}`);
          }
        }
      };

      connection.parser.on('data', dataHandler);

      // Set timeout
      setTimeout(() => {
        monitor.stop = true;
        connection.parser.off('data', dataHandler);
        this.activeMonitors.delete(port);

        resolve({
          success: true,
          message: `Monitored ${port} for ${duration} seconds`,
          output: output
        });
      }, duration * 1000);
    });
  }

  async compileSketch(board, code) {
    try {
      // Create temporary sketch
      const tempDir = path.join('/tmp', `arduino_compile_${Date.now()}`);
      const sketchName = 'temp_sketch';
      const sketchDir = path.join(tempDir, sketchName);
      await fs.mkdir(sketchDir, { recursive: true });

      const sketchFile = path.join(sketchDir, `${sketchName}.ino`);
      await fs.writeFile(sketchFile, code);

      // Compile
      const compileCmd = `arduino-cli compile --fqbn ${board} ${sketchDir} --verbose`;
      const { stdout, stderr } = await execAsync(compileCmd);

      // Extract size information
      const sizeMatch = stdout.match(/Sketch uses (\d+) bytes.*RAM.*(\d+) bytes/);
      let sizeInfo = null;
      if (sizeMatch) {
        sizeInfo = {
          flash: parseInt(sizeMatch[1]),
          ram: parseInt(sizeMatch[2])
        };
      }

      // Clean up
      await fs.rm(tempDir, { recursive: true });

      return {
        success: true,
        message: 'Compilation successful',
        sizeInfo,
        output: stdout
      };
    } catch (error) {
      throw new Error(`Compilation failed: ${error.message}`);
    }
  }

  async detectBoards() {
    try {
      const { stdout } = await execAsync('arduino-cli board list --format json');
      const boardList = JSON.parse(stdout);
      
      const detectedBoards = boardList.map(board => ({
        port: board.port.address,
        protocol: board.port.protocol,
        boards: board.boards || [],
        connected: this.connectedDevices.has(board.port.address)
      }));

      return {
        success: true,
        boards: detectedBoards,
        message: `Detected ${detectedBoards.length} board(s)`
      };
    } catch (error) {
      throw new Error(`Failed to detect boards: ${error.message}`);
    }
  }

  async installCore(core) {
    try {
      logger.info(`Installing core: ${core}`);
      const { stdout, stderr } = await execAsync(`arduino-cli core install ${core}`);

      return {
        success: true,
        message: `Core ${core} installed successfully`,
        output: stdout
      };
    } catch (error) {
      throw new Error(`Failed to install core: ${error.message}`);
    }
  }

  // Helper methods

  async initializeArduinoCLI() {
    try {
      // Check if config already exists
      try {
        await execAsync('arduino-cli config dump');
        logger.info('Arduino CLI config already exists');
      } catch (error) {
        // Config doesn't exist, initialize it
        logger.info('Initializing Arduino CLI config');
        await execAsync('arduino-cli config init');
      }
      
      // Add board manager URLs for ESP32, ESP8266, and RP2040
      try {
        await execAsync('arduino-cli config set board_manager.additional_urls "https://arduino.esp8266.com/stable/package_esp8266com_index.json,https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json,https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json"');
        logger.info('Added ESP and RP2040 board manager URLs');
      } catch (error) {
        logger.warn('Could not set board manager URLs:', error.message);
      }
      
      // Update core index
      try {
        await execAsync('arduino-cli core update-index');
        logger.info('Arduino core index updated');
      } catch (error) {
        logger.warn('Could not update core index:', error.message);
        // Continue anyway, basic Arduino cores might still work
      }
      
      // Install common cores
      const cores = ['arduino:avr'];
      for (const core of cores) {
        try {
          const installed = await execAsync(`arduino-cli core list | grep "${core}"`).catch(() => null);
          if (!installed) {
            await this.installCore(core);
          } else {
            logger.info(`Core ${core} already installed`);
          }
        } catch (error) {
          logger.warn(`Could not install core ${core}: ${error.message}`);
        }
      }
      
      // Install ESP cores separately after index update
      try {
        const esp32Installed = await execAsync('arduino-cli core list | grep "esp32:esp32"').catch(() => null);
        if (!esp32Installed) {
          await execAsync('arduino-cli core install esp32:esp32');
          logger.info('ESP32 core installed');
        } else {
          logger.info('ESP32 core already installed');
        }
      } catch (error) {
        logger.warn('Could not install ESP32 core:', error.message);
      }
      
      try {
        const esp8266Installed = await execAsync('arduino-cli core list | grep "esp8266:esp8266"').catch(() => null);
        if (!esp8266Installed) {
          await execAsync('arduino-cli core install esp8266:esp8266');
          logger.info('ESP8266 core installed');
        } else {
          logger.info('ESP8266 core already installed');
        }
      } catch (error) {
        logger.warn('Could not install ESP8266 core:', error.message);
      }
      
      // Install RP2040 core for Raspberry Pi Pico
      try {
        const rp2040Installed = await execAsync('arduino-cli core list | grep "rp2040:rp2040"').catch(() => null);
        if (!rp2040Installed) {
          await execAsync('arduino-cli core install rp2040:rp2040');
          logger.info('RP2040 core installed');
        } else {
          logger.info('RP2040 core already installed');
        }
      } catch (error) {
        logger.warn('Could not install RP2040 core:', error.message);
      }
    } catch (error) {
      logger.error('Failed to initialize Arduino CLI:', error);
    }
  }

  async installArduinoCLI() {
    try {
      // Download and install arduino-cli
      const installCmd = `
        curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
        sudo mv bin/arduino-cli /usr/local/bin/
        rm -rf bin
      `;
      
      await execAsync(installCmd);
      logger.info('Arduino CLI installed successfully');
      
      // Initialize after installation
      await this.initializeArduinoCLI();
    } catch (error) {
      throw new Error(`Failed to install Arduino CLI: ${error.message}`);
    }
  }

  identifyArduinoBoard(port) {
    // Basic identification based on USB IDs
    const vidPid = `${port.vendorId}:${port.productId}`;
    const boardMap = {
      '2341:0043': 'Arduino Uno',
      '2341:0010': 'Arduino Mega 2560',
      '2341:0042': 'Arduino Mega ADK',
      '2341:003f': 'Arduino Nano',
      '2341:003d': 'Arduino Nano',
      '2341:003e': 'Arduino Nano',
      '2341:8036': 'Arduino Leonardo',
      '2a03:0043': 'Arduino Uno',
      '2a03:003d': 'Arduino Nano',
      '2a03:003e': 'Arduino Nano',
      '1a86:7523': 'Generic CH340 Board (Nano/Uno Clone)',
      '0403:6001': 'FTDI Board (Nano/Uno)',
      '2e8a:0005': 'Raspberry Pi Pico',
      '2e8a:000a': 'Raspberry Pi Pico W'
    };

    return boardMap[vidPid] || 'Unknown Arduino';
  }

  listTemplates() {
    const templates = listTemplates();
    return {
      success: true,
      templates,
      message: `Available templates: ${templates.map(t => t.id).join(', ')}`
    };
  }

  async uploadTemplate(port, board, templateName) {
    const template = getTemplate(templateName);
    if (!template) {
      throw new Error(`Template '${templateName}' not found`);
    }

    return await this.uploadCode(port, board, template.code, templateName);
  }

  // Natural language processing
  async handleNaturalLanguage(query) {
    const lowerQuery = query.toLowerCase();

    if (lowerQuery.includes('list') || lowerQuery.includes('show') || lowerQuery.includes('devices')) {
      return await this.execute({ action: 'list-devices' });
    }

    if (lowerQuery.includes('connect')) {
      const portMatch = lowerQuery.match(/(?:port\s+|to\s+)(\/dev\/[\w\/]+|COM\d+)/i);
      const baudMatch = lowerQuery.match(/(\d+)\s*baud/i);
      
      if (portMatch) {
        return await this.execute({
          action: 'connect',
          port: portMatch[1],
          baudRate: baudMatch ? parseInt(baudMatch[1]) : 9600
        });
      }
    }

    if (lowerQuery.includes('templates')) {
      return await this.execute({ action: 'list-templates' });
    }

    if (lowerQuery.includes('upload')) {
      // Check for template names
      const templates = listTemplates();
      for (const template of templates) {
        if (lowerQuery.includes(template.id)) {
          const devices = await this.listDevices();
          if (devices.devices.length > 0) {
            const device = devices.devices[0];
            return await this.execute({
              action: 'upload-template',
              port: device.path,
              board: device.fqbn || 'arduino:avr:uno',
              template: template.id
            });
          } else {
            return {
              success: false,
              message: 'No devices found. Please connect a microcontroller.'
            };
          }
        }
      }
    }

    if (lowerQuery.includes('monitor')) {
      const portMatch = lowerQuery.match(/(?:port\s+|on\s+)(\/dev\/[\w\/]+|COM\d+)/i);
      const durationMatch = lowerQuery.match(/(\d+)\s*(?:seconds?|sec)/i);
      
      if (portMatch) {
        return await this.execute({
          action: 'monitor',
          port: portMatch[1],
          duration: durationMatch ? parseInt(durationMatch[1]) : 30
        });
      }
    }

    return {
      success: false,
      message: "I can help you with: list devices, connect to port, upload code/templates, monitor serial, compile sketch. Try 'list templates' to see available code examples."
    };
  }
}