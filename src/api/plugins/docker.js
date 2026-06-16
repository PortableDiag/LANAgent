import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { BasePlugin } from '../core/basePlugin.js';

const execAsync = promisify(exec);

/**
 * Docker Orchestration Plugin for LANAgent
 * Provides comprehensive Docker and Docker Compose management
 * Essential for testing framework and containerized applications
 */
export default class DockerPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'docker';
    this.version = '1.0.0';
    this.description = 'Docker orchestration and container management with testing framework integration';
    this.commands = [
      {
        command: 'status',
        description: 'Check Docker daemon status',
        usage: 'status()'
      },
      {
        command: 'ps',
        description: 'List running containers',
        usage: 'ps({ all: false, format: "table" })'
      },
      {
        command: 'list',
        description: 'List all containers with optional filters',
        usage: 'list({ all: true, filter: { status: "running" } })'
      },
      {
        command: 'images',
        description: 'List Docker images',
        usage: 'images({ filter: { dangling: false } })'
      },
      {
        command: 'create',
        description: 'Create a new container',
        usage: 'create({ image: "nginx", name: "my-nginx", ports: { "80": "8080" } })'
      },
      {
        command: 'start',
        description: 'Start a stopped container',
        usage: 'start({ container: "my-nginx" })'
      },
      {
        command: 'stop',
        description: 'Stop a running container',
        usage: 'stop({ container: "my-nginx", timeout: 10 })'
      },
      {
        command: 'remove',
        description: 'Remove a container',
        usage: 'remove({ container: "my-nginx", force: true })'
      },
      {
        command: 'restart',
        description: 'Restart a container',
        usage: 'restart({ container: "my-nginx" })'
      },
      {
        command: 'logs',
        description: 'View container logs',
        usage: 'logs({ container: "my-nginx", tail: 50, follow: false })'
      },
      {
        command: 'exec',
        description: 'Execute command in a running container',
        usage: 'exec({ container: "my-nginx", command: "ls -la" })'
      },
      {
        command: 'build',
        description: 'Build Docker image from Dockerfile',
        usage: 'build({ context: "./", dockerfile: "Dockerfile", tag: "my-app:latest" })'
      },
      {
        command: 'pull',
        description: 'Pull Docker image from registry',
        usage: 'pull({ image: "nginx:latest" })'
      },
      {
        command: 'push',
        description: 'Push Docker image to registry',
        usage: 'push({ image: "my-app:latest" })'
      },
      {
        command: 'compose-up',
        description: 'Start services using Docker Compose',
        usage: 'compose-up({ file: "docker-compose.yml", detach: true })'
      },
      {
        command: 'compose-down',
        description: 'Stop and remove Docker Compose services',
        usage: 'compose-down({ file: "docker-compose.yml", volumes: true })'
      },
      {
        command: 'stats',
        description: 'Display container resource usage statistics',
        usage: 'stats({ containers: ["my-nginx"], stream: false })'
      }
    ];
    
    this.config = {
      defaultNetwork: 'lanagent-network',
      testingNamespace: 'lanagent-test',
      registryUrl: null,
      composeProjectName: 'lanagent',
      autoCleanup: true,
      maxTestContainers: 3
    };

    // Track active test containers for cleanup
    this.testContainers = new Set();
  }

  async initialize() {
    try {
      // Check if Docker is installed and running
      await this.checkDockerInstallation();
      
      // Create LANAgent network if it doesn't exist
      await this.ensureNetwork();
      
      this.logger.info('Docker plugin initialized successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize Docker plugin:', error);
      return false;
    }
  }

  async execute(params) {
    const { action, ...options } = params;

    try {
      switch (action) {
        // Container Management
        case 'status':
          return await this.getDockerStatus();
        
        case 'list':
        case 'ps':
          return await this.listContainers(options);
        
        case 'images':
          return await this.listImages(options);
        
        case 'create':
          return await this.createContainer(options);
        
        case 'start':
          return await this.startContainer(options);
        
        case 'stop':
          return await this.stopContainer(options);
        
        case 'restart':
          return await this.restartContainer(options);
        
        case 'remove':
          return await this.removeContainer(options);
        
        case 'logs':
          return await this.getContainerLogs(options);
        
        case 'exec':
          return await this.execInContainer(options);
        
        // Image Management
        case 'build':
          return await this.buildImage(options);
        
        case 'pull':
          return await this.pullImage(options);
        
        case 'push':
          return await this.pushImage(options);
        
        case 'tag':
          return await this.tagImage(options);
        
        // Docker Compose
        case 'compose-up':
        case 'up':
          return await this.composeUp(options);
        
        case 'compose-down':
        case 'down':
          return await this.composeDown(options);
        
        case 'compose-status':
          return await this.composeStatus(options);
        
        case 'compose-logs':
          return await this.composeLogs(options);
        
        // Testing Integration
        case 'create-test-environment':
          return await this.createTestEnvironment(options);
        
        case 'test-code':
          return await this.testCodeInContainer(options);
        
        case 'cleanup-test-containers':
          return await this.cleanupTestContainers();
        
        // Network Management
        case 'network-create':
          return await this.createNetwork(options);
        
        case 'network-list':
          return await this.listNetworks();
        
        case 'network-remove':
          return await this.removeNetwork(options);
        
        // Volume Management
        case 'volume-create':
          return await this.createVolume(options);
        
        case 'volume-list':
          return await this.listVolumes();
        
        case 'volume-remove':
          return await this.removeVolume(options);
        
        // System Operations
        case 'system-prune':
          return await this.systemPrune(options);
        
        case 'stats':
          return await this.getContainerStats(options);
        
        default:
          throw new Error(`Unknown Docker action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`Docker operation failed:`, error);
      return {
        success: false,
        error: error.message,
        action,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Check if Docker is installed and running
   */
  async checkDockerInstallation() {
    try {
      const { stdout } = await execAsync('docker --version');
      this.dockerVersion = stdout.trim();
      
      // Check if Docker daemon is running
      await execAsync('docker info');
      
      // Check for docker-compose
      try {
        const { stdout: composeVersion } = await execAsync('docker-compose --version');
        this.composeVersion = composeVersion.trim();
      } catch {
        try {
          const { stdout: composeV2 } = await execAsync('docker compose version');
          this.composeVersion = composeV2.trim();
          this.useComposeV2 = true;
        } catch {
          this.logger.warn('Docker Compose not found - some features will be limited');
        }
      }
      
      this.logger.info(`Docker available: ${this.dockerVersion}`);
      if (this.composeVersion) {
        this.logger.info(`Docker Compose available: ${this.composeVersion}`);
      }
      
    } catch (error) {
      throw new Error(`Docker not available: ${error.message}`);
    }
  }

  /**
   * Get Docker system status
   */
  async getDockerStatus() {
    try {
      const { stdout: infoOutput } = await execAsync('docker info --format json');
      const dockerInfo = JSON.parse(infoOutput);
      
      const { stdout: versionOutput } = await execAsync('docker version --format json');
      const versionInfo = JSON.parse(versionOutput);
      
      return {
        success: true,
        data: {
          version: versionInfo.Client.Version,
          apiVersion: versionInfo.Client.ApiVersion,
          serverVersion: versionInfo.Server.Version,
          containers: dockerInfo.Containers,
          containersRunning: dockerInfo.ContainersRunning,
          containersPaused: dockerInfo.ContainersPaused,
          containersStopped: dockerInfo.ContainersStopped,
          images: dockerInfo.Images,
          serverStatus: dockerInfo.ServerVersion ? 'running' : 'stopped',
          architecture: dockerInfo.Architecture,
          operatingSystem: dockerInfo.OperatingSystem,
          memTotal: dockerInfo.MemTotal,
          cpus: dockerInfo.NCPU
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get Docker status: ${error.message}`
      };
    }
  }

  /**
   * List containers
   */
  async listContainers(options = {}) {
    try {
      const { all = false, format = 'table' } = options;
      const flags = all ? '-a' : '';
      
      if (format === 'json') {
        const { stdout } = await execAsync(`docker ps ${flags} --format json`);
        const containers = stdout.trim().split('\n')
          .filter(line => line)
          .map(line => JSON.parse(line));
        
        return {
          success: true,
          data: {
            containers,
            count: containers.length
          }
        };
      } else {
        const { stdout } = await execAsync(`docker ps ${flags}`);
        return {
          success: true,
          data: {
            output: stdout,
            format: 'table'
          }
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to list containers: ${error.message}`
      };
    }
  }

  /**
   * List images
   */
  async listImages(options = {}) {
    try {
      const { format = 'table', filter } = options;
      let command = 'docker images';
      
      if (filter) {
        command += ` --filter "${filter}"`;
      }
      
      if (format === 'json') {
        command += ' --format json';
        const { stdout } = await execAsync(command);
        const images = stdout.trim().split('\n')
          .filter(line => line)
          .map(line => JSON.parse(line));
        
        return {
          success: true,
          data: {
            images,
            count: images.length
          }
        };
      } else {
        const { stdout } = await execAsync(command);
        return {
          success: true,
          data: {
            output: stdout,
            format: 'table'
          }
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to list images: ${error.message}`
      };
    }
  }

  /**
   * Create a container
   */
  async createContainer(options = {}) {
    try {
      const {
        image,
        name,
        ports = [],
        volumes = [],
        environment = [],
        network = this.config.defaultNetwork,
        detach = true,
        interactive = false,
        tty = false,
        restart = 'unless-stopped',
        command
      } = options;

      if (!image) {
        throw new Error('Image name is required');
      }

      let dockerCommand = 'docker create';
      
      // Note: detach (-d) flag is not valid for docker create, only for docker run
      if (interactive) dockerCommand += ' -i';
      if (tty) dockerCommand += ' -t';
      
      if (name) dockerCommand += ` --name "${name}"`;
      if (network) dockerCommand += ` --network "${network}"`;
      if (restart) dockerCommand += ` --restart "${restart}"`;

      // Add port mappings
      ports.forEach(port => {
        dockerCommand += ` -p ${port}`;
      });

      // Add volume mounts
      volumes.forEach(volume => {
        dockerCommand += ` -v "${volume}"`;
      });

      // Add environment variables
      environment.forEach(env => {
        dockerCommand += ` -e "${env}"`;
      });

      dockerCommand += ` "${image}"`;
      
      if (command) {
        dockerCommand += ` ${command}`;
      }

      const { stdout } = await execAsync(dockerCommand);
      const containerId = stdout.trim();

      return {
        success: true,
        data: {
          containerId,
          name: name || containerId.substring(0, 12),
          image,
          message: 'Container created successfully'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create container: ${error.message}`
      };
    }
  }

  /**
   * Start a container
   */
  async startContainer(options = {}) {
    try {
      const { container } = options;
      if (!container) {
        throw new Error('Container name or ID is required');
      }

      await execAsync(`docker start "${container}"`);

      return {
        success: true,
        data: {
          container,
          status: 'started',
          message: 'Container started successfully'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to start container: ${error.message}`
      };
    }
  }

  /**
   * Stop a container
   */
  async stopContainer(options = {}) {
    try {
      const { container, timeout = 10 } = options;
      if (!container) {
        throw new Error('Container name or ID is required');
      }

      await execAsync(`docker stop -t ${timeout} "${container}"`);

      return {
        success: true,
        data: {
          container,
          status: 'stopped',
          message: 'Container stopped successfully'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to stop container: ${error.message}`
      };
    }
  }

  /**
   * Remove a container
   */
  async removeContainer(options = {}) {
    try {
      const { container, force = false, volumes = false } = options;
      if (!container) {
        throw new Error('Container name or ID is required');
      }

      let command = `docker rm`;
      if (force) command += ' -f';
      if (volumes) command += ' -v';
      command += ` "${container}"`;

      await execAsync(command);

      // Remove from test containers tracking
      this.testContainers.delete(container);

      return {
        success: true,
        data: {
          container,
          status: 'removed',
          message: 'Container removed successfully'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to remove container: ${error.message}`
      };
    }
  }

  /**
   * Create test environment for testing framework
   */
  async createTestEnvironment(options = {}) {
    try {
      const {
        image = 'node:18-alpine',
        testId = Date.now(),
        codePath,
        environment = ['NODE_ENV=test'],
        timeout = 300000 // 5 minutes
      } = options;

      const containerName = `${this.config.testingNamespace}-${testId}`;
      const volumeMounts = [];
      
      if (codePath) {
        volumeMounts.push(`${codePath}:/app`);
      }

      // Create test container
      const createResult = await this.createContainer({
        image,
        name: containerName,
        volumes: volumeMounts,
        environment,
        network: this.config.defaultNetwork,
        detach: true
      });

      if (!createResult.success) {
        throw new Error(createResult.error);
      }

      // Start the container
      const startResult = await this.startContainer({ container: containerName });
      if (!startResult.success) {
        await this.removeContainer({ container: containerName, force: true });
        throw new Error(startResult.error);
      }

      // Track test container for cleanup
      this.testContainers.add(containerName);

      // Set timeout for automatic cleanup
      setTimeout(async () => {
        if (this.testContainers.has(containerName)) {
          await this.removeContainer({ container: containerName, force: true });
          this.logger.info(`Test container ${containerName} automatically cleaned up after timeout`);
        }
      }, timeout);

      return {
        success: true,
        data: {
          containerId: createResult.data.containerId,
          containerName,
          testId,
          environment: 'ready',
          timeout,
          message: 'Test environment created successfully'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create test environment: ${error.message}`
      };
    }
  }

  /**
   * Test code in isolated container
   */
  async testCodeInContainer(options = {}) {
    try {
      const {
        containerName,
        testCommand = 'npm test',
        workdir = '/app'
      } = options;

      if (!containerName) {
        throw new Error('Container name is required');
      }

      // Execute test command in container
      const execResult = await this.execInContainer({
        container: containerName,
        command: testCommand,
        workdir
      });

      return {
        success: true,
        data: {
          testResults: execResult.data,
          containerName,
          command: testCommand,
          message: 'Code testing completed in container'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to test code in container: ${error.message}`
      };
    }
  }

  /**
   * Execute command in container
   */
  async execInContainer(options = {}) {
    try {
      const {
        container,
        command,
        workdir,
        user,
        detach = false,
        interactive = false,
        tty = false
      } = options;

      if (!container || !command) {
        throw new Error('Container and command are required');
      }

      let execCommand = 'docker exec';
      if (detach) execCommand += ' -d';
      if (interactive) execCommand += ' -i';
      if (tty) execCommand += ' -t';
      if (workdir) execCommand += ` -w "${workdir}"`;
      if (user) execCommand += ` -u "${user}"`;
      
      execCommand += ` "${container}" ${command}`;

      const { stdout, stderr } = await execAsync(execCommand);

      return {
        success: true,
        data: {
          stdout,
          stderr,
          command,
          container,
          exitCode: 0
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to execute command in container: ${error.message}`,
        data: {
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          command: options.command,
          container: options.container,
          exitCode: error.code || 1
        }
      };
    }
  }

  /**
   * Cleanup test containers
   */
  async cleanupTestContainers() {
    try {
      let cleanedCount = 0;
      const errors = [];

      for (const containerName of this.testContainers) {
        try {
          await this.removeContainer({ 
            container: containerName, 
            force: true 
          });
          cleanedCount++;
          this.testContainers.delete(containerName);
        } catch (error) {
          errors.push({ container: containerName, error: error.message });
        }
      }

      return {
        success: errors.length === 0,
        data: {
          cleanedCount,
          errors,
          message: `Cleaned up ${cleanedCount} test containers`
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup test containers: ${error.message}`
      };
    }
  }

  /**
   * Ensure LANAgent network exists
   */
  async ensureNetwork() {
    try {
      // Check if network exists
      const { stdout } = await execAsync(`docker network ls --filter name="${this.config.defaultNetwork}" --format "{{.Name}}"`);
      
      if (!stdout.trim()) {
        // Create network
        await execAsync(`docker network create "${this.config.defaultNetwork}"`);
        this.logger.info(`Created Docker network: ${this.config.defaultNetwork}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to ensure Docker network: ${error.message}`);
    }
  }

  /**
   * List Docker networks
   */
  async listNetworks() {
    try {
      const { stdout } = await execAsync('docker network ls --format json');
      const networks = stdout.trim().split('\n')
        .filter(line => line)
        .map(line => JSON.parse(line));
      
      return {
        success: true,
        data: {
          networks,
          count: networks.length
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list networks: ${error.message}`
      };
    }
  }

  /**
   * Create Docker network
   */
  async createNetwork(options = {}) {
    try {
      const { name, driver = 'bridge', subnet } = options;
      
      if (!name) {
        throw new Error('Network name is required');
      }

      let command = `docker network create --driver ${driver}`;
      if (subnet) {
        command += ` --subnet ${subnet}`;
      }
      command += ` "${name}"`;

      const { stdout } = await execAsync(command);
      
      return {
        success: true,
        data: {
          networkId: stdout.trim(),
          name,
          driver,
          subnet
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create network: ${error.message}`
      };
    }
  }

  /**
   * Remove Docker network
   */
  async removeNetwork(options = {}) {
    try {
      const { name } = options;
      
      if (!name) {
        throw new Error('Network name is required');
      }

      await execAsync(`docker network rm "${name}"`);
      
      return {
        success: true,
        data: {
          name,
          status: 'removed'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to remove network: ${error.message}`
      };
    }
  }

  /**
   * List Docker volumes
   */
  async listVolumes() {
    try {
      const { stdout } = await execAsync('docker volume ls --format json');
      const volumes = stdout.trim().split('\n')
        .filter(line => line)
        .map(line => JSON.parse(line));
      
      return {
        success: true,
        data: {
          volumes,
          count: volumes.length
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list volumes: ${error.message}`
      };
    }
  }

  /**
   * Create Docker volume
   */
  async createVolume(options = {}) {
    try {
      const { name, driver = 'local' } = options;
      
      if (!name) {
        throw new Error('Volume name is required');
      }

      const command = `docker volume create --driver ${driver} "${name}"`;
      const { stdout } = await execAsync(command);
      
      return {
        success: true,
        data: {
          name: stdout.trim(),
          driver
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create volume: ${error.message}`
      };
    }
  }

  /**
   * Remove Docker volume
   */
  async removeVolume(options = {}) {
    try {
      const { name, force = false } = options;
      
      if (!name) {
        throw new Error('Volume name is required');
      }

      let command = 'docker volume rm';
      if (force) command += ' -f';
      command += ` "${name}"`;

      await execAsync(command);
      
      return {
        success: true,
        data: {
          name,
          status: 'removed'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to remove volume: ${error.message}`
      };
    }
  }

  /**
   * Docker system prune
   */
  async systemPrune(options = {}) {
    try {
      const { force = true } = options;
      
      let command = 'docker system prune';
      if (force) command += ' -f';

      const { stdout } = await execAsync(command);
      
      return {
        success: true,
        data: {
          output: stdout,
          message: 'System cleanup completed'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to prune system: ${error.message}`
      };
    }
  }

  /**
   * Get container statistics
   */
  async getContainerStats(options = {}) {
    try {
      const { container, stream = false } = options;
      
      if (!container) {
        throw new Error('Container name or ID is required');
      }

      let command = `docker stats --no-stream --format json "${container}"`;
      const { stdout } = await execAsync(command);
      
      const stats = JSON.parse(stdout);
      
      return {
        success: true,
        data: {
          stats,
          container
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get container stats: ${error.message}`
      };
    }
  }

  /**
   * Build Docker image
   */
  async buildImage(options = {}) {
    try {
      const { path: buildPath = '.', tag, dockerfile = 'Dockerfile' } = options;
      
      let command = `docker build -f "${dockerfile}"`;
      if (tag) command += ` -t "${tag}"`;
      command += ` "${buildPath}"`;

      const { stdout } = await execAsync(command);
      
      return {
        success: true,
        data: {
          output: stdout,
          tag,
          path: buildPath
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to build image: ${error.message}`
      };
    }
  }

  /**
   * Pull Docker image
   */
  async pullImage(options = {}) {
    try {
      const { image } = options;
      
      if (!image) {
        throw new Error('Image name is required');
      }

      const { stdout } = await execAsync(`docker pull "${image}"`);
      
      return {
        success: true,
        data: {
          image,
          output: stdout
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to pull image: ${error.message}`
      };
    }
  }

  /**
   * Push Docker image
   */
  async pushImage(options = {}) {
    try {
      const { image } = options;
      
      if (!image) {
        throw new Error('Image name is required');
      }

      const { stdout } = await execAsync(`docker push "${image}"`);
      
      return {
        success: true,
        data: {
          image,
          output: stdout
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to push image: ${error.message}`
      };
    }
  }

  /**
   * Tag Docker image
   */
  async tagImage(options = {}) {
    try {
      const { sourceImage, targetImage } = options;
      
      if (!sourceImage || !targetImage) {
        throw new Error('Source and target image names are required');
      }

      await execAsync(`docker tag "${sourceImage}" "${targetImage}"`);
      
      return {
        success: true,
        data: {
          sourceImage,
          targetImage,
          status: 'tagged'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to tag image: ${error.message}`
      };
    }
  }

  /**
   * Restart a container
   */
  async restartContainer(options = {}) {
    try {
      const { container, timeout = 10 } = options;
      if (!container) {
        throw new Error('Container name or ID is required');
      }

      await execAsync(`docker restart -t ${timeout} "${container}"`);

      return {
        success: true,
        data: {
          container,
          status: 'restarted',
          message: 'Container restarted successfully'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to restart container: ${error.message}`
      };
    }
  }

  /**
   * Get Docker Compose status
   */
  async composeStatus(options = {}) {
    try {
      const {
        file = 'docker-compose.yml',
        project = this.config.composeProjectName
      } = options;

      let command = this.useComposeV2 ? 'docker compose' : 'docker-compose';
      command += ` -f "${file}" -p "${project}" ps --format json`;

      const { stdout } = await execAsync(command);
      const services = stdout.trim().split('\n')
        .filter(line => line)
        .map(line => JSON.parse(line));

      return {
        success: true,
        data: {
          services,
          count: services.length,
          project,
          file
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get Compose status: ${error.message}`
      };
    }
  }

  /**
   * Get Docker Compose logs
   */
  async composeLogs(options = {}) {
    try {
      const {
        file = 'docker-compose.yml',
        project = this.config.composeProjectName,
        service,
        lines = 100
      } = options;

      let command = this.useComposeV2 ? 'docker compose' : 'docker-compose';
      command += ` -f "${file}" -p "${project}" logs --tail ${lines}`;
      
      if (service) {
        command += ` "${service}"`;
      }

      const { stdout, stderr } = await execAsync(command);

      return {
        success: true,
        data: {
          logs: stdout,
          errors: stderr,
          project,
          file,
          service: service || 'all'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get Compose logs: ${error.message}`
      };
    }
  }

  /**
   * Docker Compose up
   */
  async composeUp(options = {}) {
    try {
      const {
        file = 'docker-compose.yml',
        project = this.config.composeProjectName,
        detach = true,
        build = false
      } = options;

      let command = this.useComposeV2 ? 'docker compose' : 'docker-compose';
      command += ` -f "${file}" -p "${project}"`;
      
      if (build) command += ' --build';
      if (detach) command += ' -d';
      
      command += ' up';

      const { stdout, stderr } = await execAsync(command);

      return {
        success: true,
        data: {
          stdout,
          stderr,
          project,
          file,
          message: 'Docker Compose services started'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to start Compose services: ${error.message}`
      };
    }
  }

  /**
   * Docker Compose down
   */
  async composeDown(options = {}) {
    try {
      const {
        file = 'docker-compose.yml',
        project = this.config.composeProjectName,
        volumes = false,
        removeOrphans = true
      } = options;

      let command = this.useComposeV2 ? 'docker compose' : 'docker-compose';
      command += ` -f "${file}" -p "${project}"`;
      
      if (volumes) command += ' -v';
      if (removeOrphans) command += ' --remove-orphans';
      
      command += ' down';

      const { stdout, stderr } = await execAsync(command);

      return {
        success: true,
        data: {
          stdout,
          stderr,
          project,
          file,
          message: 'Docker Compose services stopped'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to stop Compose services: ${error.message}`
      };
    }
  }

  /**
   * Get container logs
   */
  async getContainerLogs(options = {}) {
    try {
      const {
        container,
        lines = 100,
        follow = false,
        timestamps = true
      } = options;

      if (!container) {
        throw new Error('Container name or ID is required');
      }

      let command = `docker logs`;
      if (follow) command += ' -f';
      if (timestamps) command += ' -t';
      command += ` --tail ${lines} "${container}"`;

      const { stdout, stderr } = await execAsync(command);

      return {
        success: true,
        data: {
          logs: stdout,
          errors: stderr,
          container,
          lines,
          timestamps
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get container logs: ${error.message}`
      };
    }
  }

  /**
   * Get plugin status for web interface
   */
  getStatus() {
    return {
      name: this.name,
      version: this.version,
      enabled: true,
      dockerVersion: this.dockerVersion || 'Not detected',
      composeVersion: this.composeVersion || 'Not detected',
      defaultNetwork: this.config.defaultNetwork,
      testingNamespace: this.config.testingNamespace,
      activeTestContainers: this.testContainers.size,
      capabilities: [
        'Container management',
        'Image operations', 
        'Docker Compose',
        'Testing framework integration',
        'Network management',
        'Volume management'
      ]
    };
  }

  /**
   * Cleanup when plugin is disabled
   */
  async cleanup() {
    try {
      // Cleanup test containers
      await this.cleanupTestContainers();
      this.logger.info('Docker plugin cleanup completed');
    } catch (error) {
      this.logger.error('Docker plugin cleanup failed:', error);
    }
  }
}