import { BasePlugin } from '../core/basePlugin.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { createWriteStream } from 'fs';

const execAsync = promisify(exec);

export default class SoftwarePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'software';
    this.version = '1.0.0';
    this.description = 'Install, update, and manage software packages';
    this.commands = [
      {
        command: 'install',
        description: 'Install software package',
        usage: 'install [package] [method]'
      },
      {
        command: 'uninstall',
        description: 'Uninstall software package',
        usage: 'uninstall [package]'
      },
      {
        command: 'update',
        description: 'Update software package or system',
        usage: 'update [package|system]'
      },
      {
        command: 'check',
        description: 'Check if software is installed',
        usage: 'check [package]'
      },
      {
        command: 'search',
        description: 'Search for packages',
        usage: 'search [query]'
      },
      {
        command: 'compile',
        description: 'Download and compile from source',
        usage: 'compile [url|package]'
      },
      {
        command: 'list',
        description: 'List installed packages',
        usage: 'list [filter]'
      }
    ];
    
    this.packageManagers = {
      apt: { install: 'apt install -y', remove: 'apt remove -y', search: 'apt search', update: 'apt update' },
      snap: { install: 'snap install', remove: 'snap remove', search: 'snap find', list: 'snap list' },
      npm: { install: 'npm install -g', remove: 'npm uninstall -g', list: 'npm list -g --depth=0' },
      pip: { install: 'pip3 install', remove: 'pip3 uninstall -y', search: 'pip3 search', list: 'pip3 list' },
      cargo: { install: 'cargo install', remove: 'cargo uninstall', search: 'cargo search' },
      gem: { install: 'gem install', remove: 'gem uninstall', search: 'gem search', list: 'gem list' }
    };
    
    this.compileDir = '/tmp/agent-compile';
  }

  /**
   * Check if an action requires explicit user approval
   * These are dangerous operations that can damage the system
   */
  requiresApproval(action, packageName) {
    // System-wide updates are ALWAYS dangerous
    if (action === 'update' && (!packageName || packageName === 'system')) {
      return {
        required: true,
        reason: 'System-wide updates can break drivers and system components',
        warning: '⚠️ WARNING: System updates may cause kernel changes that can break hardware drivers or other system components. This operation requires explicit approval.'
      };
    }

    // Package install/uninstall/compile are dangerous
    const dangerousActions = ['install', 'uninstall', 'compile'];
    if (dangerousActions.includes(action)) {
      return {
        required: true,
        reason: `Package ${action} operations can modify the system`,
        warning: `⚠️ This operation will ${action} software on the system and requires approval.`
      };
    }

    // Single package updates are less dangerous but still need approval
    if (action === 'update' && packageName && packageName !== 'system') {
      return {
        required: true,
        reason: 'Package updates can change system behavior',
        warning: `⚠️ This will update ${packageName}. Requires approval.`
      };
    }

    return { required: false };
  }

  async execute(params) {
    const { action, package: packageName, method, query, url, approved } = params;

    try {
      // Check if this action requires approval
      const approval = this.requiresApproval(action, packageName);
      if (approval.required && !approved) {
        logger.warn(`Software action "${action}" blocked - requires approval`);
        return {
          success: false,
          requiresApproval: true,
          error: approval.warning,
          reason: approval.reason,
          action,
          package: packageName,
          message: `This operation requires explicit user approval. To proceed, the user must confirm they want to ${action} ${packageName || 'system packages'}.`
        };
      }

      switch(action) {
        case 'install':
          return await this.installPackage(packageName, method);

        case 'uninstall':
          return await this.uninstallPackage(packageName);

        case 'update':
          return await this.updatePackage(packageName);

        case 'check':
          return await this.checkInstalled(packageName);

        case 'search':
          return await this.searchPackages(query || packageName);

        case 'compile':
          return await this.compileFromSource(url || packageName);

        case 'list':
          return await this.listInstalled(query);

        default:
          return {
            success: false,
            error: 'Unknown action. Use: install, uninstall, update, check, search, compile, or list'
          };
      }
    } catch (error) {
      logger.error('Software plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async installPackage(packageName, method) {
    if (!packageName) {
      return { success: false, error: 'Package name required' };
    }

    logger.info(`Installing package: ${packageName} (method: ${method || 'auto'})`);
    
    // Determine package manager
    const pm = method || await this.detectPackageManager(packageName);
    
    try {
      let command;
      let result;
      
      // Special cases for common software
      const specialCases = {
        'ffmpeg': async () => await this.installFFmpeg(),
        'docker': async () => await this.installDocker(),
        'node': async () => await this.installNode(),
        'rust': async () => await this.installRust(),
        'go': async () => await this.installGo()
      };
      
      if (specialCases[packageName.toLowerCase()]) {
        return await specialCases[packageName.toLowerCase()]();
      }
      
      // Regular package installation
      if (pm === 'apt') {
        // Update package list first
        await execAsync('apt update');
        command = `apt install -y ${packageName}`;
      } else if (this.packageManagers[pm]) {
        command = `${this.packageManagers[pm].install} ${packageName}`;
      } else {
        // Try to compile from source
        return await this.compileFromSource(packageName);
      }
      
      // Execute installation
      logger.info(`Executing: ${command}`);
      result = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
      
      // Verify installation
      const checkResult = await this.checkInstalled(packageName);
      
      if (checkResult.installed) {
        return {
          success: true,
          result: `Successfully installed ${packageName}`,
          version: checkResult.version,
          output: result.stdout
        };
      } else {
        return {
          success: false,
          error: 'Installation appeared to succeed but package not found',
          output: result.stdout
        };
      }
      
    } catch (error) {
      logger.error('Installation error:', error);
      return {
        success: false,
        error: `Failed to install ${packageName}: ${error.message}`,
        output: error.stdout || error.stderr
      };
    }
  }

  async uninstallPackage(packageName) {
    if (!packageName) {
      return { success: false, error: 'Package name required' };
    }

    try {
      // Check which package manager has it
      const pm = await this.findPackageManager(packageName);
      
      if (!pm) {
        return { success: false, error: `Package ${packageName} not found in any package manager` };
      }
      
      const command = `${this.packageManagers[pm].remove} ${packageName}`;
      logger.info(`Executing: ${command}`);
      
      const result = await execAsync(command);
      
      return {
        success: true,
        result: `Successfully uninstalled ${packageName}`,
        output: result.stdout
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to uninstall ${packageName}: ${error.message}`
      };
    }
  }

  async updatePackage(packageName) {
    try {
      if (!packageName || packageName === 'system') {
        // Update entire system
        logger.info('Updating system packages...');
        
        const commands = [
          'apt update',
          'apt upgrade -y',
          'apt autoremove -y'
        ];
        
        let output = '';
        for (const cmd of commands) {
          const result = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
          output += result.stdout + '\n';
        }
        
        return {
          success: true,
          result: 'System packages updated successfully',
          output
        };
      } else {
        // Update specific package
        const pm = await this.findPackageManager(packageName);
        
        if (pm === 'apt') {
          const result = await execAsync(`apt update && apt install --only-upgrade -y ${packageName}`);
          return {
            success: true,
            result: `Updated ${packageName}`,
            output: result.stdout
          };
        } else if (pm && this.packageManagers[pm].install) {
          // Reinstall to update
          return await this.installPackage(packageName, pm);
        } else {
          return {
            success: false,
            error: `Cannot update ${packageName} - package manager not found`
          };
        }
      }
    } catch (error) {
      return {
        success: false,
        error: `Update failed: ${error.message}`
      };
    }
  }

  async checkInstalled(packageName) {
    if (!packageName) {
      return { success: false, error: 'Package name required' };
    }

    try {
      // Check various ways
      const checks = [
        { cmd: `which ${packageName}`, type: 'binary' },
        { cmd: `dpkg -l | grep "^ii.*${packageName}"`, type: 'apt' },
        { cmd: `snap list ${packageName} 2>/dev/null`, type: 'snap' },
        { cmd: `npm list -g ${packageName} --depth=0 2>/dev/null`, type: 'npm' },
        { cmd: `pip3 show ${packageName} 2>/dev/null`, type: 'pip' },
        { cmd: `${packageName} --version 2>/dev/null`, type: 'version' },
        { cmd: `${packageName} -v 2>/dev/null`, type: 'version' }
      ];
      
      for (const check of checks) {
        try {
          const result = await execAsync(check.cmd);
          if (result.stdout) {
            // Extract version if possible
            let version = 'unknown';
            const versionMatch = result.stdout.match(/(\d+\.?\d*\.?\d*)/);
            if (versionMatch) {
              version = versionMatch[1];
            }
            
            return {
              success: true,
              installed: true,
              type: check.type,
              version,
              result: `${packageName} is installed (${check.type})`,
              output: result.stdout.trim()
            };
          }
        } catch (e) {
          // Continue checking other methods
        }
      }
      
      return {
        success: true,
        installed: false,
        result: `${packageName} is not installed`
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to check ${packageName}: ${error.message}`
      };
    }
  }

  async searchPackages(query) {
    if (!query) {
      return { success: false, error: 'Search query required' };
    }

    try {
      const results = {};
      
      // Search in apt
      try {
        const aptResult = await execAsync(`apt search ${query} 2>/dev/null | head -20`);
        if (aptResult.stdout) {
          results.apt = aptResult.stdout.trim().split('\n').slice(1); // Skip header
        }
      } catch (e) {}
      
      // Search in snap
      try {
        const snapResult = await execAsync(`snap find ${query} 2>/dev/null | head -10`);
        if (snapResult.stdout) {
          results.snap = snapResult.stdout.trim().split('\n').slice(1);
        }
      } catch (e) {}
      
      // Format results
      let formatted = `📦 Package search results for "${query}":\n\n`;
      
      if (results.apt && results.apt.length > 0) {
        formatted += `**APT Packages:**\n`;
        results.apt.slice(0, 5).forEach(line => {
          if (line.trim()) formatted += `• ${line}\n`;
        });
        formatted += '\n';
      }
      
      if (results.snap && results.snap.length > 0) {
        formatted += `**Snap Packages:**\n`;
        results.snap.slice(0, 5).forEach(line => {
          if (line.trim()) formatted += `• ${line}\n`;
        });
      }
      
      if (!results.apt && !results.snap) {
        formatted += 'No packages found.';
      }
      
      return {
        success: true,
        result: formatted,
        results
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Search failed: ${error.message}`
      };
    }
  }

  async compileFromSource(packageNameOrUrl) {
    logger.info(`Compiling from source: ${packageNameOrUrl}`);
    
    try {
      // Create compile directory
      await fs.mkdir(this.compileDir, { recursive: true });
      
      let sourceUrl = packageNameOrUrl;
      let packageName = 'package';
      
      // Handle special cases
      const knownSources = {
        'ffmpeg': {
          url: 'https://github.com/FFmpeg/FFmpeg.git',
          name: 'ffmpeg',
          build: ['./configure --enable-gpl --enable-libx264', 'make -j$(nproc)', 'make install']
        },
        'neovim': {
          url: 'https://github.com/neovim/neovim.git',
          name: 'neovim',
          deps: ['ninja-build gettext libtool libtool-bin autoconf automake cmake g++ pkg-config unzip curl doxygen'],
          build: ['make CMAKE_BUILD_TYPE=RelWithDebInfo', 'make install']
        }
      };
      
      let buildCommands = ['./configure', 'make -j$(nproc)', 'make install'];
      let dependencies = ['build-essential', 'git', 'cmake', 'autoconf', 'automake'];
      
      if (knownSources[packageNameOrUrl.toLowerCase()]) {
        const known = knownSources[packageNameOrUrl.toLowerCase()];
        sourceUrl = known.url;
        packageName = known.name;
        buildCommands = known.build;
        if (known.deps) dependencies = known.deps;
      } else if (!packageNameOrUrl.startsWith('http')) {
        // Try to find it on GitHub
        sourceUrl = `https://github.com/${packageNameOrUrl}.git`;
        packageName = packageNameOrUrl.split('/').pop();
      }
      
      // Install build dependencies
      logger.info('Installing build dependencies...');
      await execAsync(`apt update && apt install -y ${dependencies.join(' ')}`);
      
      // Clone or download source
      const sourceDir = path.join(this.compileDir, packageName);
      await fs.rm(sourceDir, { recursive: true, force: true });
      
      if (sourceUrl.endsWith('.git')) {
        logger.info(`Cloning ${sourceUrl}...`);
        await execAsync(`git clone ${sourceUrl} ${sourceDir}`);
      } else if (sourceUrl.endsWith('.tar.gz') || sourceUrl.endsWith('.tgz')) {
        logger.info(`Downloading ${sourceUrl}...`);
        const tarFile = path.join(this.compileDir, 'source.tar.gz');
        await this.downloadFile(sourceUrl, tarFile);
        await execAsync(`tar xzf ${tarFile} -C ${this.compileDir}`);
        // Find extracted directory
        const dirs = await fs.readdir(this.compileDir);
        const extractedDir = dirs.find(d => d !== 'source.tar.gz');
        if (extractedDir) {
          await fs.rename(path.join(this.compileDir, extractedDir), sourceDir);
        }
      }
      
      // Build and install
      logger.info('Building from source...');
      let output = '';
      
      for (const cmd of buildCommands) {
        logger.info(`Running: ${cmd}`);
        const result = await execAsync(cmd, { 
          cwd: sourceDir,
          maxBuffer: 50 * 1024 * 1024,
          env: { ...process.env, MAKEFLAGS: '-j$(nproc)' }
        });
        output += `\n=== ${cmd} ===\n${result.stdout}`;
      }
      
      // Clean up
      await fs.rm(sourceDir, { recursive: true, force: true });
      
      // Verify installation
      const check = await this.checkInstalled(packageName);
      
      if (check.installed) {
        return {
          success: true,
          result: `Successfully compiled and installed ${packageName} from source`,
          version: check.version,
          output
        };
      } else {
        return {
          success: false,
          error: 'Compilation succeeded but package not found in PATH',
          output
        };
      }
      
    } catch (error) {
      logger.error('Compilation error:', error);
      return {
        success: false,
        error: `Failed to compile ${packageNameOrUrl}: ${error.message}`,
        output: error.stdout || error.stderr
      };
    }
  }

  async listInstalled(filter) {
    try {
      const results = {};
      
      // List apt packages
      if (!filter || filter === 'apt') {
        const aptList = await execAsync('dpkg -l | grep "^ii" | awk \'{print $2 " - " $3}\'');
        results.apt = aptList.stdout.trim().split('\n').slice(0, 20);
      }
      
      // List snap packages
      if (!filter || filter === 'snap') {
        try {
          const snapList = await execAsync('snap list');
          results.snap = snapList.stdout.trim().split('\n');
        } catch (e) {}
      }
      
      // List npm global packages
      if (!filter || filter === 'npm') {
        try {
          const npmList = await execAsync('npm list -g --depth=0');
          results.npm = npmList.stdout.trim().split('\n').slice(1);
        } catch (e) {}
      }
      
      // Format output
      let formatted = '📦 Installed Packages:\n\n';
      
      Object.entries(results).forEach(([manager, packages]) => {
        if (packages && packages.length > 0) {
          formatted += `**${manager.toUpperCase()} Packages:**\n`;
          packages.forEach(pkg => {
            if (pkg.trim()) formatted += `• ${pkg}\n`;
          });
          formatted += '\n';
        }
      });
      
      return {
        success: true,
        result: formatted,
        results
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to list packages: ${error.message}`
      };
    }
  }

  // Helper methods
  async detectPackageManager(packageName) {
    // Try to detect the best package manager for the package
    const lowerName = packageName.toLowerCase();
    
    if (lowerName.includes('lib') || lowerName.includes('-dev')) return 'apt';
    if (lowerName.startsWith('node-') || lowerName.includes('npm')) return 'npm';
    if (lowerName.includes('python') || lowerName.startsWith('py')) return 'pip';
    if (lowerName.includes('rust') || lowerName.includes('cargo')) return 'cargo';
    if (lowerName.includes('ruby') || lowerName.includes('gem')) return 'gem';
    
    // Default to apt for system packages
    return 'apt';
  }

  async findPackageManager(packageName) {
    // Check which package manager has this package
    const checks = [
      { pm: 'apt', cmd: `dpkg -l | grep "^ii.*${packageName}"` },
      { pm: 'snap', cmd: `snap list ${packageName} 2>/dev/null` },
      { pm: 'npm', cmd: `npm list -g ${packageName} --depth=0 2>/dev/null` },
      { pm: 'pip', cmd: `pip3 show ${packageName} 2>/dev/null` }
    ];
    
    for (const check of checks) {
      try {
        const result = await execAsync(check.cmd);
        if (result.stdout) return check.pm;
      } catch (e) {}
    }
    
    return null;
  }

  async downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(dest);
      https.get(url, response => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', err => {
        fs.unlink(dest);
        reject(err);
      });
    });
  }

  // Special installation methods
  async installFFmpeg() {
    logger.info('Installing FFmpeg with full codecs support...');
    
    try {
      const commands = [
        'apt update',
        'apt install -y software-properties-common',
        'add-apt-repository -y ppa:jonathonf/ffmpeg-4',
        'apt update',
        'apt install -y ffmpeg libavcodec-extra'
      ];
      
      let output = '';
      for (const cmd of commands) {
        logger.info(`Running: ${cmd}`);
        try {
          const result = await execAsync(cmd);
          output += result.stdout + '\n';
        } catch (e) {
          // Some commands might fail on certain systems
          logger.warn(`Command failed: ${cmd}`, e.message);
        }
      }
      
      // Fallback to standard install if PPA fails
      await execAsync('apt install -y ffmpeg');
      
      const check = await this.checkInstalled('ffmpeg');
      return {
        success: check.installed,
        result: check.installed ? 'FFmpeg installed successfully' : 'Failed to install FFmpeg',
        version: check.version,
        output
      };
      
    } catch (error) {
      // Try compiling from source
      return await this.compileFromSource('ffmpeg');
    }
  }

  async installDocker() {
    logger.info('Installing Docker...');
    
    try {
      const script = `
        apt update
        apt install -y apt-transport-https ca-certificates curl software-properties-common
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | apt-key add -
        add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"
        apt update
        apt install -y docker-ce docker-ce-cli containerd.io
        systemctl start docker
        systemctl enable docker
      `;
      
      const commands = script.trim().split('\n').map(cmd => cmd.trim());
      let output = '';
      
      for (const cmd of commands) {
        if (cmd) {
          logger.info(`Running: ${cmd}`);
          const result = await execAsync(cmd);
          output += result.stdout + '\n';
        }
      }
      
      // Add current user to docker group
      await execAsync('usermod -aG docker $USER').catch(() => {});
      
      return {
        success: true,
        result: 'Docker installed successfully. You may need to log out and back in for group changes.',
        output
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to install Docker: ${error.message}`
      };
    }
  }

  async installNode() {
    logger.info('Installing Node.js via NodeSource...');
    
    try {
      const commands = [
        'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -',
        'apt install -y nodejs'
      ];
      
      let output = '';
      for (const cmd of commands) {
        const result = await execAsync(cmd);
        output += result.stdout + '\n';
      }
      
      const nodeVersion = await execAsync('node --version');
      const npmVersion = await execAsync('npm --version');
      
      return {
        success: true,
        result: `Node.js installed successfully`,
        versions: {
          node: nodeVersion.stdout.trim(),
          npm: npmVersion.stdout.trim()
        },
        output
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to install Node.js: ${error.message}`
      };
    }
  }
}