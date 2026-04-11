import { BasePlugin } from '../core/basePlugin.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import fs from 'fs/promises';
import { SambaMount } from '../../models/SambaMount.js';
import { encrypt, decrypt, isEncryptionConfigured } from '../../utils/encryption.js';

const execAsync = promisify(exec);

export default class SambaPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'samba';
    this.version = '1.0.0';
    this.description = 'Samba/CIFS mount management and monitoring';
    this.commands = [
      {
        command: 'listMounts',
        description: 'List all Samba/CIFS mounts',
        usage: 'listMounts()'
      },
      {
        command: 'mount',
        description: 'Mount a Samba/CIFS share',
        usage: 'mount({ share: "//192.168.1.100/share", mountPoint: "/mnt/share", username: "user", password: "pass", domain: "WORKGROUP" })'
      },
      {
        command: 'unmount',
        description: 'Unmount a Samba/CIFS share',
        usage: 'unmount({ mountPoint: "/mnt/share", force: false })'
      },
      {
        command: 'getStatus',
        description: 'Get status of a specific mount',
        usage: 'getStatus({ mountPoint: "/mnt/share" })'
      },
      {
        command: 'checkUtils',
        description: 'Check if CIFS utilities are installed',
        usage: 'checkUtils()'
      },
      {
        command: 'saveMountConfig',
        description: 'Save mount configuration for easy remounting',
        usage: 'saveMountConfig({ name: "myShare", share: "//192.168.1.100/share", mountPoint: "/mnt/share", username: "user", password: "pass" })'
      },
      {
        command: 'listSavedMounts',
        description: 'List saved mount configurations',
        usage: 'listSavedMounts()'
      },
      {
        command: 'mountSaved',
        description: 'Mount using a saved configuration',
        usage: 'mountSaved({ name: "myShare" })'
      },
      {
        command: 'deleteSavedMount',
        description: 'Delete a saved mount configuration',
        usage: 'deleteSavedMount({ id: "mount-id" })'
      },
      {
        command: 'browse',
        description: 'Browse files in a mounted share',
        usage: 'browse({ mountPoint: "/mnt/share", path: "/" })'
      }
    ];
    
    // Store mount configurations
    this.mountConfigs = new Map();
  }

  async initialize() {
    try {
      // Check if encryption is configured
      if (!isEncryptionConfigured()) {
        logger.warn('Samba Plugin: Encryption key not configured. Please set ENCRYPTION_KEY in .env file');
      }
      
      // Load saved mounts from database
      await this.loadSavedMounts();
      
      // Check if CIFS utils are installed
      const cifsInstalled = await this.checkCIFSUtils();
      logger.info(`Samba Plugin initialized. CIFS utils: ${cifsInstalled ? 'Available' : 'Missing'}`);
      return true;
    } catch (error) {
      logger.error('Failed to initialize Samba Plugin:', error);
      return false;
    }
  }

  async execute(params) {
    const { action, ...args } = params;
    
    try {
      switch (action) {
        case 'listMounts':
          return await this.listMounts();
        case 'mount':
          return await this.mount(args);
        case 'unmount':
          return await this.unmount(args);
        case 'getStatus':
          return await this.getStatus();
        case 'checkUtils':
          return await this.checkUtils();
        case 'createMount':
          return await this.createMount(args);
        case 'updateMount':
          return await this.updateMount(args);
        case 'deleteMount':
          return await this.deleteMount(args);
        case 'testMount':
          return await this.testMount(args);
        case 'mountAll':
          return await this.mountAll();
        case 'unmountAll':
          return await this.unmountAll();
        case 'browse':
          return await this.browse(args);
        default:
          throw new Error(`Unknown Samba action: ${action}`);
      }
    } catch (error) {
      logger.error(`Samba Plugin error in ${action}:`, error);
      throw error;
    }
  }

  // Direct method aliases for API manager
  async listMounts() {
    try {
      // Get configured mounts
      const configuredMounts = Array.from(this.mountConfigs.values());
      
      // Get currently mounted CIFS/SMB shares for status verification
      try {
        const { stdout } = await execAsync('mount | grep -E "cifs|smb" || echo "No CIFS mounts found"');
        const activeMountPaths = new Set();
        
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (line.includes('type cifs') || line.includes('type smb')) {
            const parts = line.split(' ');
            if (parts.length >= 3) {
              activeMountPaths.add(parts[2]); // mount point
            }
          }
        }
        
        // Update mount status based on actual system state
        configuredMounts.forEach(mount => {
          const actuallyMounted = activeMountPaths.has(mount.mountPoint);
          if (mount.mounted !== actuallyMounted) {
            mount.mounted = actuallyMounted;
            this.mountConfigs.set(mount.id, mount);
          }
        });
      } catch (error) {
        // Continue with configured mounts even if we can't check current status
      }
      
      // Sanitize mount data to not expose passwords
      const sanitizedMounts = configuredMounts.map(mount => ({
        id: mount.id,
        name: mount.name,
        server: mount.server,
        share: mount.share,
        mountPoint: mount.mountPoint,
        username: mount.username,
        domain: mount.domain,
        options: mount.options,
        mounted: mount.mounted,
        createdAt: mount.createdAt,
        status: mount.mounted ? 'mounted' : 'unmounted',
        hasPassword: !!mount.password
      }));
      
      return {
        success: true,
        mounts: sanitizedMounts,
        total: sanitizedMounts.length,
        data: sanitizedMounts  // Also include as 'data' for API compatibility
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        mounts: []
      };
    }
  }

  async mount(args) {
    try {
      // Handle both direct mount args and config-based mount
      let config;
      
      if (args.id) {
        // Mount using stored configuration
        config = this.mountConfigs.get(args.id);
        if (!config) {
          throw new Error('Mount configuration not found');
        }
      } else if (args.source && args.target) {
        // Direct mount parameters
        config = args;
      } else {
        throw new Error('Either mount ID or source/target required');
      }

      const source = config.source || `//${config.server}/${config.share}`;
      const target = config.target || config.mountPoint;
      
      if (!source || !target) {
        throw new Error('Source and target are required');
      }

      // Create mount point if it doesn't exist
      await execAsync(`sudo mkdir -p "${target}"`);

      // Build mount command
      let mountCmd = `sudo mount -t cifs "${source}" "${target}"`;
      
      const username = config.username;
      // Password should already be decrypted in memory
      const password = config.password || '';
      
      const options = config.options || [];
      
      // Build mount options
      const mountOptions = [];
      
      if (username) {
        mountOptions.push(`username=${username}`);
        if (password) {
          // Escape special characters in password for shell
          const escapedPassword = password.replace(/'/g, "'\"'\"'");
          mountOptions.push(`password='${escapedPassword}'`);
        }
      } else {
        // For anonymous/guest access
        mountOptions.push('guest');
      }
      
      // Add domain if specified
      if (config.domain) {
        mountOptions.push(`domain=${config.domain}`);
      }
      
      // Add any additional options
      if (options.length > 0) {
        mountOptions.push(...options);
      }
      
      // Apply options if any exist
      if (mountOptions.length > 0) {
        mountCmd += ` -o ${mountOptions.join(',')}`;
      }

      logger.info(`Executing mount command: ${mountCmd.replace(/password='[^']*'/, 'password=***')}`);
      await execAsync(mountCmd);
      
      // Update config if using stored configuration
      if (args.id && this.mountConfigs.has(args.id)) {
        config.mounted = true;
        this.mountConfigs.set(args.id, config);
      }
      
      return {
        success: true,
        message: `Successfully mounted ${source} to ${target}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Mount failed: ${error.message}`
      };
    }
  }

  async unmount(args) {
    try {
      let target;
      let configId = null;
      
      if (args.id) {
        // Unmount using stored configuration
        const config = this.mountConfigs.get(args.id);
        if (!config) {
          throw new Error('Mount configuration not found');
        }
        target = config.mountPoint;
        configId = args.id;
      } else if (args.target) {
        // Direct unmount
        target = args.target;
      } else {
        throw new Error('Either mount ID or target required');
      }

      if (!target) {
        throw new Error('Target mount point is required');
      }

      await execAsync(`sudo umount "${target}"`);
      
      // Update config if using stored configuration
      if (configId && this.mountConfigs.has(configId)) {
        const config = this.mountConfigs.get(configId);
        config.mounted = false;
        this.mountConfigs.set(configId, config);
      }
      
      return {
        success: true,
        message: `Successfully unmounted ${target}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Unmount failed: ${error.message}`
      };
    }
  }

  async getStatus() {
    try {
      const mounts = await this.listMounts();
      const cifsUtils = await this.checkCIFSUtils();
      
      return {
        success: true,
        status: {
          cifsUtils: cifsUtils,
          activeMounts: mounts.success ? mounts.mounts.length : 0,
          mounts: mounts.success ? mounts.mounts : []
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async checkUtils() {
    return {
      success: true,
      cifsUtils: await this.checkCIFSUtils()
    };
  }

  async checkCIFSUtils() {
    try {
      await execAsync('which mount.cifs');
      return true;
    } catch (error) {
      return false;
    }
  }

  async createMount({ name, server, share, mountPoint, username, password, domain, options = [] }) {
    try {
      const mountId = `mount_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const config = {
        id: mountId,
        name: name || `${server}/${share}`,
        server,
        share,
        mountPoint,
        username: username || '',
        password: password || '',  // Store plain text in memory
        domain: domain || '',
        options,
        created: new Date(),
        mounted: false
      };
      
      this.mountConfigs.set(mountId, config);
      
      // Save to database
      await this.saveToPersistence();
      
      return {
        success: true,
        message: 'Mount configuration created',
        id: mountId,
        config: {
          id: config.id,
          name: config.name,
          server: config.server,
          share: config.share,
          mountPoint: config.mountPoint,
          username: config.username,
          domain: config.domain,
          hasPassword: !!config.password
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateMount({ id, ...updates }) {
    try {
      if (!this.mountConfigs.has(id)) {
        throw new Error('Mount configuration not found');
      }
      
      const existingConfig = this.mountConfigs.get(id);
      
      // Handle password update - keep plain text in memory
      if (!updates.password && 'password' in updates) {
        // Password field is empty, keep existing password if user had one
        if (existingConfig.password) {
          updates.password = existingConfig.password;
        }
      }
      // Don't encrypt the password here - keep it plain in memory
      
      const config = { ...existingConfig, ...updates };
      this.mountConfigs.set(id, config);
      
      // Save to database
      await this.saveToPersistence();
      
      // Return sanitized config without password
      return {
        success: true,
        message: 'Mount configuration updated',
        config: {
          id: config.id,
          name: config.name,
          server: config.server,
          share: config.share,
          mountPoint: config.mountPoint,
          username: config.username,
          domain: config.domain,
          hasPassword: !!config.password
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async deleteMount({ id }) {
    try {
      if (!this.mountConfigs.has(id)) {
        throw new Error('Mount configuration not found');
      }
      
      // Unmount if currently mounted
      const config = this.mountConfigs.get(id);
      if (config.mounted) {
        await this.unmount({ id });
      }
      
      this.mountConfigs.delete(id);
      
      // Save to database
      await this.saveToPersistence();
      
      return {
        success: true,
        message: 'Mount configuration deleted'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async testMount({ id }) {
    try {
      const config = this.mountConfigs.get(id);
      if (!config) {
        throw new Error('Mount configuration not found');
      }
      
      // Password should already be decrypted in memory
      const password = config.password || '';
      
      // Test using smbclient
      let testCmd;
      if (config.username && password) {
        // Use password via environment variable to avoid shell escaping issues
        testCmd = `SMBCLIENT_PASSWORD='${password.replace(/'/g, "'\"'\"'")}' smbclient //${config.server}/${config.share} -U ${config.username} -c "ls" 2>&1 || true`;
      } else if (config.username) {
        testCmd = `smbclient //${config.server}/${config.share} -U ${config.username} -N -c "ls" 2>&1 || true`;
      } else {
        testCmd = `smbclient //${config.server}/${config.share} -N -c "ls" 2>&1 || true`;
      }
      
      const { stdout } = await execAsync(testCmd, { 
        env: { ...process.env, SMBCLIENT_PASSWORD: password }
      });
      
      const success = !stdout.includes('NT_STATUS_LOGON_FAILURE') && 
                     !stdout.includes('NT_STATUS_ACCESS_DENIED') &&
                     !stdout.includes('NT_STATUS_BAD_NETWORK_NAME') &&
                     !stdout.includes('Connection to') && 
                     !stdout.includes('failed');
      
      return {
        success,
        message: success ? 'Connection test successful' : 'Connection test failed - check server, share name, and credentials',
        details: success ? 'Successfully connected to share' : stdout.substring(0, 200)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async mountAll() {
    try {
      const results = [];
      for (const [id, config] of this.mountConfigs) {
        if (!config.mounted) {
          const result = await this.mount({ id });
          results.push({ id, name: config.name, ...result });
        }
      }
      
      return {
        success: true,
        message: `Attempted to mount ${results.length} shares`,
        results
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async unmountAll() {
    try {
      const results = [];
      for (const [id, config] of this.mountConfigs) {
        if (config.mounted) {
          const result = await this.unmount({ id });
          results.push({ id, name: config.name, ...result });
        }
      }
      
      return {
        success: true,
        message: `Attempted to unmount ${results.length} shares`,
        results
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async browse({ id, path = '/' }) {
    try {
      const config = this.mountConfigs.get(id);
      if (!config) {
        throw new Error('Mount configuration not found');
      }
      
      if (!config.mounted) {
        throw new Error('Share is not mounted');
      }
      
      const browsePath = path === '/' ? config.mountPoint : `${config.mountPoint}${path}`;
      
      // Get file listing with details
      const { stdout } = await execAsync(`ls -la "${browsePath}" | tail -n +2`);
      
      const files = [];
      const lines = stdout.trim().split('\n').filter(line => line.length > 0);
      
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 9) {
          const name = parts.slice(8).join(' ');
          if (name !== '.' && name !== '..') {
            files.push({
              name,
              isDirectory: parts[0].startsWith('d'),
              size: parseInt(parts[4]) || 0,
              permissions: parts[0],
              modified: `${parts[5]} ${parts[6]} ${parts[7]}`
            });
          }
        }
      }
      
      return {
        success: true,
        data: {
          mountPoint: config.mountPoint,
          currentPath: browsePath,
          files: files
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to browse mount: ${error.message}`
      };
    }
  }

  async loadSavedMounts() {
    try {
      const mounts = await SambaMount.find({}).select('+password');
      for (const mount of mounts) {
        // Decrypt password for use in memory
        let decryptedPassword = '';
        try {
          if (mount.password) {
            decryptedPassword = decrypt(mount.password);
          }
        } catch (err) {
          logger.warn(`Failed to decrypt password for ${mount.mountId}, will need to re-enter`);
        }
        
        this.mountConfigs.set(mount.mountId, {
          id: mount.mountId,
          name: mount.name,
          server: mount.server,
          share: mount.share,
          mountPoint: mount.mountPoint,
          username: mount.username,
          password: decryptedPassword,  // Store decrypted password in memory
          domain: mount.domain,
          options: mount.options,
          mounted: mount.mounted,
          created: mount.createdAt
        });
      }
      logger.info(`Loaded ${this.mountConfigs.size} Samba mounts from database`);
    } catch (error) {
      logger.error('Failed to load saved mounts:', error);
    }
  }

  async saveToPersistence() {
    try {
      // Save all current mounts, updating existing or creating new
      for (const [id, config] of this.mountConfigs) {
        // Encrypt password before saving to database
        const encryptedPassword = config.password && config.username ? encrypt(config.password) : '';
        
        await SambaMount.findOneAndUpdate(
          { mountId: id },
          {
            mountId: id,
            name: config.name,
            server: config.server,
            share: config.share,
            mountPoint: config.mountPoint,
            username: config.username,
            password: encryptedPassword,
            domain: config.domain,
            options: config.options,
            mounted: config.mounted
          },
          { upsert: true, new: true }
        );
      }
      
      // Remove any mounts from DB that are no longer in memory
      const memoryIds = Array.from(this.mountConfigs.keys());
      await SambaMount.deleteMany({ mountId: { $nin: memoryIds } });
      
      logger.info(`Synchronized ${this.mountConfigs.size} Samba mounts to database`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to save mounts to database:', error);
      return { success: false, error: error.message };
    }
  }

  getStatusInfo() {
    return {
      name: this.name,
      version: this.version,
      enabled: this.enabled,
      description: this.description,
      commands: this.commands,
      mountConfigs: Array.from(this.mountConfigs.values())
    };
  }

  // Get HTTP routes for the web interface
  getRoutes() {
    return [
      {
        method: 'GET',
        path: '/status',
        handler: async () => {
          const result = await this.getStatus();
          if (result.success && result.status) {
            const mounts = result.status.mounts || [];
            return {
              success: true,
              data: {
                totalMounts: mounts.length,
                activeMounts: mounts.filter(m => m.mounted).length,
                cifsStatus: result.status.cifsUtils ? 'Available' : 'Not Installed',
                lastMount: mounts.find(m => m.mounted)?.mountedAt || 'Never'
              }
            };
          }
          return result;
        }
      },
      {
        method: 'GET',
        path: '/mounts',
        handler: async () => {
          const result = await this.listMounts();
          if (result.success) {
            return {
              success: true,
              data: result.data || result.mounts || []
            };
          }
          return result;
        }
      },
      {
        method: 'POST',
        path: '/mounts',
        handler: async (data) => await this.createMount(data)
      },
      {
        method: 'PUT',
        path: '/mounts/:id',
        handler: async (data, req) => await this.updateMount({ id: req.params.id, ...data })
      },
      {
        method: 'DELETE',
        path: '/mounts/:id',
        handler: async (data, req) => await this.deleteMount({ id: req.params.id })
      },
      {
        method: 'POST',
        path: '/mounts/:id/mount',
        handler: async (data, req) => await this.mount({ id: req.params.id })
      },
      {
        method: 'POST',
        path: '/mounts/:id/unmount',
        handler: async (data, req) => await this.unmount({ id: req.params.id })
      },
      {
        method: 'POST',
        path: '/mounts/:id/test',
        handler: async (data, req) => await this.testMount({ id: req.params.id })
      },
      {
        method: 'POST',
        path: '/mounts/:id/browse',
        handler: async (data, req) => await this.browse({ id: req.params.id, path: data.path || '/' })
      },
      {
        method: 'POST',
        path: '/mount-all',
        handler: async () => await this.mountAll()
      },
      {
        method: 'POST',
        path: '/unmount-all',
        handler: async () => await this.unmountAll()
      }
    ];
  }
}