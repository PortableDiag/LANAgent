import ssh2 from 'ssh2';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';
import rateLimit from 'express-rate-limit';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
let packageVersion = '1.0.0';
try {
  const packageJsonPath = path.join(__dirname, '../../../package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageVersion = packageJson.version;
} catch (error) {
  logger.warn('Could not read package.json version:', error.message);
}

export class SSHInterface {
  constructor(agent) {
    this.agent = agent;
    this.server = null; // Will be created in initialize()
    this.sessions = new Map();
    this.port = process.env.AGENT_SSH_PORT || 2222;
    this.username = process.env.SSH_USERNAME || 'lanagent';
    this.password = process.env.SSH_PASSWORD || 'lanagent'; // Change in production!
    
    // Security warning for default password
    if (this.password === 'lanagent') {
      logger.warn('⚠️  SSH SECURITY WARNING: Using default password "lanagent". Please set SSH_PASSWORD environment variable for production use!');
    }
    
    this.allowedCommands = this.initializeAllowedCommands();
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
  }

  initializeAllowedCommands() {
    return {
      // Agent control commands
      'agent': {
        'status': () => this.getAgentStatus(),
        'restart': () => this.restartAgent(),
        'logs': (args) => this.getAgentLogs(args),
        'config': () => this.getAgentConfig()
      },
      // System commands
      'system': {
        'info': () => this.agent.getSystemStatus(),
        'exec': (args) => this.executeSystemCommand(args),
        'monitor': () => this.getSystemMetrics()
      },
      // AI commands
      'ai': {
        'providers': () => this.listAIProviders(),
        'switch': (args) => this.switchAIProvider(args),
        'chat': (args) => this.sendAIMessage(args)
      },
      // Task commands
      'task': {
        'list': () => this.listTasks(),
        'add': (args) => this.addTask(args),
        'complete': (args) => this.completeTask(args)
      },
      // Help command
      'help': () => this.showHelp()
    };
  }

  async initialize() {
    try {
      // Generate or load SSH host key
      const hostKey = await this.loadOrGenerateHostKey();
      
      // Create SSH server
      const { Server } = ssh2;
      this.server = new Server({
        hostKeys: [hostKey]
      }, (client) => {
        logger.info('SSH client connected');
        
        client.on('authentication', (ctx) => {
          if (ctx.method === 'password' && 
              ctx.username === this.username && 
              ctx.password === this.password) {
            ctx.accept();
          } else {
            ctx.reject();
          }
        });

        client.on('ready', () => {
          logger.info('SSH client authenticated');
          
          client.on('session', (accept, reject) => {
            const session = accept();
            this.handleSession(session);
          });
        });

        client.on('error', (err) => {
          logger.error('SSH client error:', err);
        });
      });

      this.server.on('error', (err) => {
        logger.error('SSH server error:', err);
      });

    } catch (error) {
      logger.error('Failed to initialize SSH interface:', error);
      throw error;
    }
  }

  async loadOrGenerateHostKey() {
    const keyPath = path.join(process.cwd(), 'data', 'ssh_host_key');
    
    try {
      // Try to load existing key
      const key = await fs.readFile(keyPath, 'utf8');
      return key;
    } catch (error) {
      // Generate new key if doesn't exist
      logger.info('Generating new SSH host key...');
      const { generateKeyPairSync } = await import('crypto');
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: {
          type: 'pkcs1',
          format: 'pem'
        }
      });
      
      // Save key for future use
      await fs.mkdir(path.dirname(keyPath), { recursive: true });
      await fs.writeFile(keyPath, privateKey, 'utf8');
      
      return privateKey;
    }
  }

  handleSession(session) {
    session.on('pty', (accept, reject, info) => {
      accept();
    });

    session.on('shell', (accept, reject) => {
      const stream = accept();
      const sessionId = Date.now().toString();
      
      this.sessions.set(sessionId, {
        stream,
        buffer: '',
        history: [],
        commandQueue: []
      });

      // Send welcome message
      stream.write('\r\n');
      stream.write('🤖 LAN Agent SSH Interface\r\n');
      stream.write('==========================\r\n');
      stream.write(`Connected to ${this.agent.config.name} v${this.agent.agentModel?.state?.version?.current || '1.0.0'}\r\n`);
      stream.write('Type "help" for available commands\r\n');
      stream.write('\r\n');
      stream.write('lanagent> ');

      stream.on('data', (data) => {
        this.handleInput(sessionId, data);
      });

      stream.on('close', () => {
        this.sessions.delete(sessionId);
        logger.info('SSH session closed');
      });
    });

    session.on('exec', (accept, reject, info) => {
      const stream = accept();
      this.handleCommand(info.command, stream);
    });
  }

  async handleInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { stream, buffer } = session;
    
    for (const char of data) {
      if (char === 0x0d || char === 0x0a) { // Enter key
        stream.write('\r\n');
        
        if (buffer.trim()) {
          session.history.push(buffer);
          session.commandQueue.push(buffer.trim());
          this.processCommandQueue(sessionId);
        }
        
        session.buffer = '';
        stream.write('lanagent> ');
      } else if (char === 0x7f || char === 0x08) { // Backspace
        if (buffer.length > 0) {
          session.buffer = buffer.slice(0, -1);
          stream.write('\b \b');
        }
      } else if (char >= 0x20 && char < 0x7f) { // Printable characters
        session.buffer += String.fromCharCode(char);
        stream.write(String.fromCharCode(char));
      }
    }
  }

  async processCommandQueue(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.processing) return;

    session.processing = true;
    while (session.commandQueue.length > 0) {
      const commandLine = session.commandQueue.shift();
      await this.processCommand(sessionId, commandLine);
    }
    session.processing = false;
  }

  async processCommand(sessionId, commandLine) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { stream } = session;
    const parts = commandLine.split(' ');
    const [category, command, ...args] = parts;

    try {
      if (category === 'exit' || category === 'quit') {
        stream.write('Goodbye!\r\n');
        stream.end();
        return;
      }

      if (!this.allowedCommands[category]) {
        stream.write(`Unknown command category: ${category}\r\n`);
        stream.write('Type "help" for available commands\r\n');
        return;
      }

      if (!command || !this.allowedCommands[category][command]) {
        stream.write(`Available commands for ${category}:\r\n`);
        for (const cmd of Object.keys(this.allowedCommands[category])) {
          stream.write(`  ${category} ${cmd}\r\n`);
        }
        return;
      }

      const result = await this.allowedCommands[category][command](args);
      stream.write(this.formatOutput(result) + '\r\n');
    } catch (error) {
      stream.write(`Error: ${error.message}\r\n`);
      logger.error('SSH command error:', error);
    }
  }

  formatOutput(data) {
    if (typeof data === 'string') {
      return data.split('\n').join('\r\n');
    }
    return JSON.stringify(data, null, 2).split('\n').join('\r\n');
  }

  async getCachedData(key, fetchFunc) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const data = await fetchFunc();
    this.cache.set(key, data);
    return data;
  }

  async getAgentStatus() {
    const status = await this.getCachedData('agentStatus', () => this.agent.getSystemStatus());
    return `Agent: ${status.agent.name} v${status.agent.version}
Status: ${status.agent.status}
Uptime: ${status.agent.uptime}
Memory: ${status.system.memory.used}/${status.system.memory.total} GB
CPU: ${status.system.cpu.usage}%
Disk: ${status.system.disk?.used || 'N/A'}/${status.system.disk?.total || 'N/A'} GB`;
  }

  async restartAgent() {
    setTimeout(() => {
      process.exit(0); // PM2 will restart it
    }, 1000);
    return 'Agent restart initiated...';
  }

  async getAgentLogs(args) {
    const lines = args[0] ? parseInt(args[0]) : 20;
    const history = this.agent.systemExecutor?.getHistory(lines) || [];
    
    if (history.length === 0) {
      return 'No command history available';
    }

    return history.map(entry => {
      const time = new Date(entry.timestamp).toLocaleString();
      const status = entry.result.success ? '✓' : '✗';
      return `[${time}] ${status} ${entry.command}`;
    }).join('\n');
  }

  async getAgentConfig() {
    return {
      name: this.agent.config.name,
      version: this.agent.agentModel?.state?.version?.current || '1.0.0',
      interfaces: Array.from(this.agent.interfaces.keys()),
      services: Array.from(this.agent.services.keys()),
      aiProvider: this.agent.providerManager.activeProvider?.name || 'none'
    };
  }

  async listAIProviders() {
    const providers = this.agent.providerManager.providers;
    const current = this.agent.providerManager.activeProvider?.name || 'none';
    
    return Array.from(providers.keys()).map(name => {
      const status = name === current ? ' (current)' : '';
      return `${name}${status}`;
    }).join('\n');
  }

  async switchAIProvider(args) {
    const provider = args[0];
    if (!provider) {
      return 'Usage: ai switch <provider>';
    }

    try {
      await this.agent.switchAIProvider(provider);
      return `Switched to ${provider}`;
    } catch (error) {
      return `Failed to switch: ${error.message}`;
    }
  }

  async sendAIMessage(args) {
    const message = args.join(' ');
    if (!message) {
      return 'Usage: ai chat <message>';
    }

    try {
      const response = await this.agent.processNaturalLanguage(message, {
        platform: 'ssh',
        userId: 'ssh-user'
      });
      return response.response || response.message || 'Processing complete';
    } catch (error) {
      return `AI error: ${error.message}`;
    }
  }

  async executeSystemCommand(args) {
    const command = args.join(' ');
    if (!command) {
      return 'Usage: system exec <command>';
    }

    try {
      const startTime = Date.now();
      const result = await retryOperation(() => this.agent.systemExecutor.execute(command, 'ssh'));
      const executionTime = Date.now() - startTime;
      logger.info(`Executed command: "${command}" in ${executionTime}ms`);
      if (!result.success) {
        logger.error(`Command failed: ${result.error}`);
        return `Command failed: ${result.error}`;
      }
      return result.output;
    } catch (error) {
      logger.error(`Execution error: ${error.message}`);
      return `Execution error: ${error.message}`;
    }
  }

  async getSystemMetrics() {
    try {
      const status = await this.getCachedData('systemMetrics', () => this.agent.getSystemStatus());
      const sys = status.system;
      return `CPU: ${sys.cpu.usage}% (${sys.loadAvg.join(', ')})
Memory: ${sys.memory.used}/${sys.memory.total} GB (${sys.memory.percentage}%)
Disk: ${sys.disk?.used || 'N/A'}/${sys.disk?.total || 'N/A'} GB (${sys.disk?.percentage || 'N/A'}%)
Processes: ${sys.processes.total} total (${sys.processes.running} running)`;
    } catch (error) {
      return `Error getting metrics: ${error.message}`;
    }
  }

  async listTasks() {
    try {
      const tasks = await this.getCachedData('tasks', () => this.agent.getTasks());
      if (!tasks || tasks.length === 0) {
        return 'No active tasks';
      }

      return tasks.map((task, index) => {
        const status = task.completed ? '✓' : (task.running ? '⟳' : '○');
        return `${index + 1}. ${status} ${task.title || task.description}`;
      }).join('\n');
    } catch (error) {
      return 'Task management not available yet';
    }
  }

  async addTask(args) {
    const title = args.join(' ');
    if (!title) {
      return 'Usage: task add <title>';
    }

    try {
      const result = await this.agent.addTask(title);
      if (result.error) {
        return `Failed to add task: ${result.error}`;
      }
      return `✅ Task created: "${result.title}" (ID: ${result.id})`;
    } catch (error) {
      return `Failed to add task: ${error.message}`;
    }
  }

  async completeTask(args) {
    const taskId = args[0];
    if (!taskId) {
      return 'Usage: task complete <id>';
    }

    try {
      const result = await this.agent.apiManager.executePlugin('tasks', 'execute', {
        action: 'complete',
        taskId: taskId
      });
      
      if (result.success) {
        return `✅ Task completed: "${result.task.title}"`;
      } else {
        return `Failed to complete task: Task not found`;
      }
    } catch (error) {
      return `Failed to complete task: ${error.message}`;
    }
  }

  showHelp() {
    return `Available Commands:
================
agent status      - Show agent status
agent restart     - Restart the agent  
agent logs [n]    - Show last n command logs
agent config      - Show agent configuration

system info       - Show system information
system exec <cmd> - Execute system command
system monitor    - Show system metrics

ai providers      - List AI providers
ai switch <name>  - Switch AI provider
ai chat <msg>     - Send message to AI

task list         - List all tasks
task add <title>  - Add new task
task complete <id> - Mark task as complete

help             - Show this help
exit/quit        - Close SSH session`;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        logger.info(`SSH Interface listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      this.server.close(() => {
        logger.info('SSH Interface stopped');
        resolve();
      });
      
      // Close all active sessions
      for (const [id, session] of this.sessions) {
        session.stream.end();
      }
      this.sessions.clear();
    });
  }
}