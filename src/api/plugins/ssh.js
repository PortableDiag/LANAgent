import { BasePlugin } from '../core/basePlugin.js';
import { Client } from 'ssh2';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { SSHConnection } from '../../models/SSHConnection.js';
import { encrypt, decrypt, isEncryptionConfigured } from '../../utils/encryption.js';

export default class SSHPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'ssh';
    this.version = '1.0.0';
    this.description = 'SSH connection management and remote command execution. Use saved connections to execute commands on remote servers.';
    this.commands = [
      {
        command: 'connect',
        description: 'Connect to a saved SSH server',
        usage: 'connect({ id: "root@your-server:22" })'
      },
      {
        command: 'disconnect',
        description: 'Disconnect from an active SSH connection',
        usage: 'disconnect({ connectionId: "root@your-server:22" })'
      },
      {
        command: 'execute',
        description: 'Execute a command on a connected SSH server',
        usage: 'execute({ connectionId: "root@your-server:22", command: "ls -la" })'
      },
      {
        command: 'list-connections',
        description: 'List all saved SSH connections',
        usage: 'list-connections()'
      },
      {
        command: 'save-connection',
        description: 'Save a new SSH connection configuration',
        usage: 'save-connection({ host: "your-server", username: "root", password: "pass", name: "My Server" })'
      },
      {
        command: 'delete-connection',
        description: 'Delete a saved SSH connection',
        usage: 'delete-connection({ id: "connection-id" })'
      },
      {
        command: 'test-connection',
        description: 'Test if an SSH connection can be established',
        usage: 'test-connection({ id: "connection-id" })'
      },
      {
        command: 'status',
        description: 'Get status of all active SSH connections',
        usage: 'status()'
      }
    ];
    
    // Examples for AI agent usage:
    // 1. List saved connections: { action: 'list-connections' }
    // 2. Connect to saved connection: { action: 'connect', id: 'root@your-server:22' }
    // 3. Execute command: { action: 'execute', connectionId: 'root@your-server:22', command: 'ls -la' }
    // 4. Disconnect: { action: 'disconnect', connectionId: 'root@your-server:22' }
    
    this.connections = new Map();
    this.activeConnections = new Map();
    this.savedConnections = [];
    this.lastConnectionTime = null;
  }

  async initialize() {
    try {
      // Check if encryption is configured
      if (!isEncryptionConfigured()) {
        logger.warn('SSH Plugin: Encryption key not configured. Please set ENCRYPTION_KEY in .env file');
      }
      
      // Load saved connections from database
      await this.loadSavedConnections();
      
      this.initialized = true;
      return true;
    } catch (error) {
      logger.error('Failed to initialize SSH plugin:', error);
      return false;
    }
  }

  async execute(params) {
    // Validate base action
    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: ['connect', 'disconnect', 'execute', 'list-connections', 'save-connection', 'delete-connection', 'test-connection', 'status']
      }
    });
    
    // Sanitize all string parameters
    params = this.sanitizeParams(params);
    
    const { action, ...data } = params;

    switch (action) {
      case 'connect':
        // Handle both direct connect with full data and ID-based connect
        if (data.id && !data.host) {
          // ID-based connect - look up the connection
          const connection = this.savedConnections.find(c => c.id === data.id);
          if (!connection) {
            return { success: false, error: 'Connection not found' };
          }
          return await this.connect({
            id: connection.id,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            privateKey: connection.privateKey
          });
        }
        // Direct connect with full parameters
        return await this.connect(data);
      
      case 'disconnect':
        return await this.disconnect(data.connectionId);
      
      case 'execute':
        return await this.executeCommand(data.connectionId, data.command);
      
      case 'list-connections':
        return await this.listConnections();
      
      case 'save-connection':
        return await this.saveConnection(data);
      
      case 'delete-connection':
        return await this.deleteConnection(data.id);
      
      case 'test-connection':
        return await this.testConnection(data.id);
      
      case 'status':
        return await this.getStatus();
      
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async connect(options) {
    // Validate connection parameters
    this.validateParams(options, {
      host: { required: true, type: 'string', minLength: 1, maxLength: 255 },
      username: { required: true, type: 'string', minLength: 1, maxLength: 100 },
      port: { type: 'number', min: 1, max: 65535 },
      password: { type: 'string', maxLength: 500 },
      privateKey: { type: 'string', maxLength: 10000 }
    });
    
    const { id, host, port = 22, username, password, privateKey } = options;
    
    const connectionId = id || `${username}@${host}:${port}`;
    
    // Check if already connected
    if (this.activeConnections.has(connectionId)) {
      return {
        success: true,
        message: 'Already connected',
        connectionId
      };
    }
    
    const conn = new Client();
    
    return new Promise((resolve, reject) => {
      conn.on('ready', () => {
        this.activeConnections.set(connectionId, conn);
        this.lastConnectionTime = new Date();
        logger.info(`SSH connected to ${connectionId}`);
        
        resolve({
          success: true,
          message: 'Connected successfully',
          connectionId,
          data: {
            connectionId,
            name: options.name || connectionId,
            host: options.host,
            username: options.username
          }
        });
      });
      
      conn.on('error', (err) => {
        logger.error(`SSH connection error for ${connectionId}:`, err);
        reject(new Error(`Connection failed: ${err.message}`));
      });
      
      const connectOptions = {
        host,
        port,
        username
      };
      
      if (password) {
        connectOptions.password = password;
        logger.info(`SSH connecting to ${host}:${port} as ${username} with password auth (length: ${password.length})`);
      } else if (privateKey) {
        connectOptions.privateKey = privateKey;
        logger.info(`SSH connecting to ${host}:${port} as ${username} with key auth`);
      } else {
        logger.info(`SSH connecting to ${host}:${port} as ${username} with no auth specified`);
      }
      
      try {
        conn.connect(connectOptions);
      } catch (error) {
        reject(new Error(`Failed to initiate connection: ${error.message}`));
      }
    });
  }

  async disconnect(connectionId) {
    const conn = this.activeConnections.get(connectionId);
    
    if (!conn) {
      return {
        success: false,
        error: 'Connection not found'
      };
    }
    
    try {
      conn.end();
      this.activeConnections.delete(connectionId);
      
      return {
        success: true,
        message: 'Disconnected successfully'
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to disconnect: ${error.message}`
      };
    }
  }

  async executeCommand(connectionId, command) {
    const conn = this.activeConnections.get(connectionId);
    
    if (!conn) {
      return {
        success: false,
        error: 'Connection not found. Please connect first.'
      };
    }
    
    return new Promise((resolve) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          resolve({
            success: false,
            error: `Command execution failed: ${err.message}`
          });
          return;
        }
        
        let output = '';
        let errorOutput = '';
        
        stream.on('close', (code, signal) => {
          resolve({
            success: true,
            data: {
              stdout: output,
              stderr: errorOutput,
              exitCode: code,
              signal
            }
          });
        });
        
        stream.on('data', (data) => {
          output += data.toString();
        });
        
        stream.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
      });
    });
  }

  async listConnections() {
    const activeIds = Array.from(this.activeConnections.keys());
    
    const connections = this.savedConnections.map(conn => ({
      id: conn.id,
      name: conn.name,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      description: conn.description,
      hasPassword: conn.hasPassword,
      hasPrivateKey: conn.hasPrivateKey,
      createdAt: conn.createdAt,
      status: activeIds.includes(conn.id) ? 'connected' : 'disconnected'
    }));
    
    return {
      success: true,
      data: connections
    };
  }

  async saveConnection(connectionData) {
    const { id, name, host, port = 22, username, password, privateKey, description } = connectionData;
    
    if (!name || !host || !username) {
      return {
        success: false,
        error: 'Name, host, and username are required'
      };
    }
    
    // Check if this is an update to existing connection
    const existingIndex = this.savedConnections.findIndex(c => c.id === (id || `${username}@${host}:${port}`));
    const isUpdate = existingIndex >= 0;
    const existingConnection = isUpdate ? this.savedConnections[existingIndex] : null;
    
    // Log password handling for debugging
    if (password) {
      logger.info(`saveConnection: Encrypting new password for ${id || `${username}@${host}:${port}`}`);
    } else if (existingConnection && existingConnection.password) {
      logger.info(`saveConnection: Keeping existing encrypted password for ${id}`);
    }
    
    const connection = {
      id: id || `${username}@${host}:${port}`,
      name,
      host,
      port,
      username,
      description,
      // Handle password - only encrypt if it's a new password
      password: password ? encrypt(password) : (existingConnection ? existingConnection.password : ''),
      privateKey: privateKey ? encrypt(privateKey) : (existingConnection ? existingConnection.privateKey : ''),
      hasPassword: !!password || (existingConnection && existingConnection.hasPassword),
      hasPrivateKey: !!privateKey || (existingConnection && existingConnection.hasPrivateKey),
      createdAt: existingConnection ? existingConnection.createdAt : new Date()
    };
    
    // Update or add connection - but store with decrypted password in memory
    const memoryConnection = {
      ...connection,
      // Store decrypted password in memory for use in connections
      password: password || (existingConnection ? existingConnection.password : ''),
      privateKey: privateKey || (existingConnection ? existingConnection.privateKey : '')
    };
    
    if (isUpdate) {
      this.savedConnections[existingIndex] = memoryConnection;
    } else {
      this.savedConnections.push(memoryConnection);
    }
    
    // Save to persistent storage
    await this.saveToPersistence();
    
    // Return sanitized data (without passwords)
    return {
      success: true,
      data: {
        id: connection.id,
        name: connection.name,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        description: connection.description,
        hasPassword: connection.hasPassword,
        hasPrivateKey: connection.hasPrivateKey,
        createdAt: connection.createdAt
      }
    };
  }

  async deleteConnection(connectionId) {
    // Disconnect if active
    if (this.activeConnections.has(connectionId)) {
      await this.disconnect(connectionId);
    }
    
    // Remove from saved connections
    const index = this.savedConnections.findIndex(c => c.id === connectionId);
    if (index >= 0) {
      this.savedConnections.splice(index, 1);
      await this.saveToPersistence();
      
      return {
        success: true,
        message: 'Connection deleted successfully'
      };
    }
    
    return {
      success: false,
      error: 'Connection not found'
    };
  }

  async testConnection(connectionId) {
    const connection = this.savedConnections.find(c => c.id === connectionId);
    
    if (!connection) {
      return {
        success: false,
        error: 'Connection configuration not found'
      };
    }
    
    try {
      // Try to connect with stored credentials
      // Note: connection.password is the already decrypted password from loadSavedConnections
      await this.connect({
        id: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password,  // This should already be decrypted
        privateKey: connection.privateKey
      });
      
      // If successful, disconnect
      await this.disconnect(connection.id);
      
      return {
        success: true,
        message: 'Connection test successful'
      };
    } catch (error) {
      return {
        success: false,
        error: `Connection test failed: ${error.message}`
      };
    }
  }

  async getStatus() {
    return {
      success: true,
      data: {
        totalConnections: this.savedConnections.length,
        activeConnections: this.activeConnections.size,
        lastConnection: this.lastConnectionTime ? this.lastConnectionTime.toISOString() : null
      }
    };
  }

  async loadSavedConnections() {
    try {
      const connections = await SSHConnection.find({}).select('+password +privateKey');
      this.savedConnections = connections.map(conn => {
        let decryptedPassword = '';
        let decryptedKey = '';
        
        // Try to decrypt, but don't fail if decryption fails
        try {
          if (conn.password) {
            logger.info(`loadSavedConnections: Decrypting password for ${conn.connectionId}, encrypted length: ${conn.password.length}`);
            decryptedPassword = decrypt(conn.password);
            logger.info(`loadSavedConnections: Successfully decrypted password for ${conn.connectionId}, decrypted length: ${decryptedPassword.length}`);
          }
        } catch (err) {
          logger.warn(`Failed to decrypt password for ${conn.connectionId}, will need to re-enter:`, err.message);
        }
        
        try {
          decryptedKey = conn.privateKey ? decrypt(conn.privateKey) : '';
        } catch (err) {
          logger.warn(`Failed to decrypt private key for ${conn.connectionId}, will need to re-enter`);
        }
        
        return {
          id: conn.connectionId,
          name: conn.name,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          description: conn.description,
          password: decryptedPassword,
          privateKey: decryptedKey,
          hasPassword: conn.hasPassword,
          hasPrivateKey: conn.hasPrivateKey,
          createdAt: conn.createdAt
        };
      });
      logger.info(`Loaded ${this.savedConnections.length} SSH connections from database`);
    } catch (error) {
      logger.error('Failed to load saved connections:', error);
      this.savedConnections = [];
    }
  }

  async saveToPersistence() {
    try {
      // Save all current connections, updating existing or creating new
      for (const conn of this.savedConnections) {
        // Encrypt passwords before saving to database
        const encryptedPassword = conn.password ? encrypt(conn.password) : '';
        const encryptedPrivateKey = conn.privateKey ? encrypt(conn.privateKey) : '';
        
        await SSHConnection.findOneAndUpdate(
          { connectionId: conn.id },
          {
            connectionId: conn.id,
            name: conn.name,
            host: conn.host,
            port: conn.port,
            username: conn.username,
            description: conn.description,
            password: encryptedPassword,
            privateKey: encryptedPrivateKey,
            hasPassword: conn.hasPassword,
            hasPrivateKey: conn.hasPrivateKey
          },
          { upsert: true, new: true }
        );
      }
      
      // Remove any connections from DB that are no longer in memory
      const memoryIds = this.savedConnections.map(c => c.id);
      await SSHConnection.deleteMany({ connectionId: { $nin: memoryIds } });
      
      logger.info(`Synchronized ${this.savedConnections.length} SSH connections to database`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to save connections to database:', error);
      return { success: false, error: error.message };
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
        path: '/connections',
        handler: async () => await this.listConnections()
      },
      {
        method: 'POST',
        path: '/connections',
        handler: async (data) => await this.saveConnection(data)
      },
      {
        method: 'PUT',
        path: '/connections/:id',
        handler: async (data) => await this.saveConnection(data)
      },
      {
        method: 'DELETE',
        path: '/connections/:id',
        handler: async (data, req) => {
          const id = req.params.id;
          return await this.deleteConnection(id);
        }
      },
      {
        method: 'POST',
        path: '/connections/:id/test',
        handler: async (data, req) => {
          const id = req.params.id;
          return await this.testConnection(id);
        }
      },
      {
        method: 'POST',
        path: '/connections/:id/connect',
        handler: async (data, req) => {
          const id = req.params.id;
          const connection = this.savedConnections.find(c => c.id === id);
          if (!connection) {
            return { success: false, error: 'Connection not found' };
          }
          
          logger.info(`Connect route: Found connection ${id}, has password: ${!!connection.password}, password length: ${connection.password ? connection.password.length : 0}`);
          
          return await this.connect({
            id: connection.id,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,  // This should already be decrypted from loadSavedConnections
            privateKey: connection.privateKey,
            ...data // Allow overriding password/key
          });
        }
      },
      {
        method: 'POST',
        path: '/connections/:id/disconnect',
        handler: async (data, req) => {
          const id = req.params.id;
          return await this.disconnect(id);
        }
      },
      {
        method: 'POST',
        path: '/connections/:id/execute',
        handler: async (data, req) => {
          const id = req.params.id;
          return await this.executeCommand(id, data.command);
        }
      }
    ];
  }

  // Cleanup on plugin disable
  async cleanup() {
    // Disconnect all active connections
    for (const [id, conn] of this.activeConnections) {
      try {
        conn.end();
        logger.info(`Disconnected SSH connection: ${id}`);
      } catch (error) {
        logger.error(`Failed to disconnect ${id}:`, error);
      }
    }
    
    this.activeConnections.clear();
  }
}