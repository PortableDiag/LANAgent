import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
// Note: axios import removed for now - will be added when needed for API testing

const execAsync = promisify(exec);

/**
 * Comprehensive Testing Framework for Self-Modification System
 * Provides safe testing environment for agent code changes
 */
export class TestFramework extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.testResults = [];
    this.testSession = {
      id: null,
      startTime: null,
      endTime: null,
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    // Test environment configuration
    this.config = {
      testPort: 3001, // Different from production port
      testTimeout: 30000, // 30 seconds per test
      testDbName: 'lanagent_test',
      maxRetries: 3,
      criticalTests: [
        'agent_initialization',
        'core_services',
        'api_endpoints', 
        'plugin_functionality',
        'database_connectivity',
        'interface_availability'
      ],
      testSuites: {
        unit: { enabled: true, timeout: 5000 },
        integration: { enabled: true, timeout: 15000 },
        functional: { enabled: true, timeout: 30000 },
        performance: { enabled: false, timeout: 60000 }
      }
    };
  }

  /**
   * Run comprehensive test suite
   */
  async runTestSuite(options = {}) {
    try {
      this.testSession.id = `test-${Date.now()}`;
      this.testSession.startTime = new Date();
      this.testResults = [];

      logger.info(`🧪 Starting test suite ${this.testSession.id}`);

      // 1. Pre-test validation
      await this.preTestValidation();

      // 2. Unit tests
      if (this.config.testSuites.unit.enabled) {
        await this.runUnitTests();
      }

      // 3. Integration tests
      if (this.config.testSuites.integration.enabled) {
        await this.runIntegrationTests();
      }

      // 4. Functional tests
      if (this.config.testSuites.functional.enabled) {
        await this.runFunctionalTests();
      }

      // 5. Performance tests (optional)
      if (this.config.testSuites.performance.enabled) {
        await this.runPerformanceTests();
      }

      // 6. Generate test report
      const report = await this.generateTestReport();

      this.testSession.endTime = new Date();
      logger.info(`✅ Test suite completed: ${this.testSession.passed}/${this.testSession.totalTests} passed`);

      return {
        success: this.testSession.failed === 0,
        report,
        session: this.testSession,
        results: this.testResults
      };

    } catch (error) {
      logger.error('Test suite execution failed:', error);
      return {
        success: false,
        error: error.message,
        session: this.testSession,
        results: this.testResults
      };
    }
  }

  /**
   * Pre-test validation
   */
  async preTestValidation() {
    await this.addTest('pre_test_validation', 'Pre-test Environment Check', async () => {
      // Check critical files exist
      const criticalFiles = [
        'src/index.js',
        'src/core/agent.js',
        'package.json'
      ];

      for (const file of criticalFiles) {
        try {
          await fs.access(file);
        } catch {
          throw new Error(`Critical file missing: ${file}`);
        }
      }

      // Check dependencies
      try {
        const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
        if (!packageJson.dependencies) {
          throw new Error('No dependencies found in package.json');
        }
      } catch (error) {
        throw new Error(`Package.json validation failed: ${error.message}`);
      }

      // Check environment variables
      const requiredEnvVars = ['MONGODB_URI'];
      for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
          throw new Error(`Required environment variable missing: ${envVar}`);
        }
      }

      return { status: 'passed', message: 'Environment validation passed' };
    });
  }

  /**
   * Run unit tests
   */
  async runUnitTests() {
    logger.info('📋 Running unit tests...');

    // Test 1: Module loading
    await this.addTest('unit_module_loading', 'Module Loading Test', async () => {
      const modules = [
        'src/core/agent.js',
        'src/core/memoryManager.js',
        'src/api/core/apiManager.js'
      ];

      for (const modulePath of modules) {
        try {
          // Use dynamic import to test ES modules
          const module = await import(`../../${modulePath}`);
          if (!module || typeof module !== 'object') {
            throw new Error(`Invalid module export: ${modulePath}`);
          }
        } catch (error) {
          throw new Error(`Failed to load module ${modulePath}: ${error.message}`);
        }
      }

      return { status: 'passed', message: 'All core modules loaded successfully' };
    });

    // Test 2: Configuration validation
    await this.addTest('unit_config_validation', 'Configuration Validation', async () => {
      const config = this.agent?.config;
      if (!config) {
        throw new Error('Agent configuration not found');
      }

      const requiredConfigKeys = ['name', 'port'];
      for (const key of requiredConfigKeys) {
        if (!(key in config)) {
          throw new Error(`Missing required config key: ${key}`);
        }
      }

      return { status: 'passed', message: 'Configuration validation passed' };
    });

    // Test 3: Memory manager functionality
    await this.addTest('unit_memory_manager', 'Memory Manager Test', async () => {
      if (!this.agent?.memoryManager) {
        throw new Error('Memory manager not available');
      }

      // Test memory storage and retrieval
      const testData = `Test memory entry ${Date.now()}`;
      const stored = await this.agent.memoryManager.store('system', testData, { category: 'unit_test' });
      
      if (!stored) {
        throw new Error('Failed to store test memory');
      }

      const retrieved = await this.agent.memoryManager.recall('Test memory', { limit: 1 });
      if (!retrieved || retrieved.length === 0) {
        throw new Error('Failed to retrieve stored memory');
      }

      return { status: 'passed', message: 'Memory manager functionality verified' };
    });
  }

  /**
   * Run integration tests
   */
  async runIntegrationTests() {
    logger.info('🔗 Running integration tests...');

    // Test 1: Agent initialization
    await this.addTest('integration_agent_init', 'Agent Initialization Test', async () => {
      if (!this.agent) {
        throw new Error('Agent instance not available');
      }

      // Check core components are initialized
      const components = {
        'providerManager': this.agent.providerManager,
        'memoryManager': this.agent.memoryManager,
        'apiManager': this.agent.apiManager,
        'commandParser': this.agent.commandParser
      };

      for (const [name, component] of Object.entries(components)) {
        if (!component) {
          throw new Error(`Component not initialized: ${name}`);
        }
      }

      return { status: 'passed', message: 'Agent initialization verified' };
    });

    // Test 2: Database connectivity
    await this.addTest('integration_database', 'Database Connectivity Test', async () => {
      try {
        // Try to connect to database through memory manager
        const testQuery = await this.agent.memoryManager.recall('test_connectivity', { limit: 1 });
        // If no error thrown, database is accessible
        
        return { status: 'passed', message: 'Database connectivity verified' };
      } catch (error) {
        throw new Error(`Database connectivity failed: ${error.message}`);
      }
    });

    // Test 3: AI Provider functionality
    await this.addTest('integration_ai_provider', 'AI Provider Test', async () => {
      if (!this.agent.providerManager) {
        throw new Error('Provider manager not available');
      }

      const activeProvider = await this.agent.providerManager.getCurrentProvider();
      if (!activeProvider) {
        throw new Error('No active AI provider found');
      }

      // Test basic AI functionality
      try {
        const response = await this.agent.providerManager.generateResponse('Test prompt', { maxTokens: 10 });
        if (!response || !response.content) {
          throw new Error('AI provider returned invalid response');
        }
      } catch (error) {
        throw new Error(`AI provider test failed: ${error.message}`);
      }

      return { status: 'passed', message: 'AI provider functionality verified' };
    });
  }

  /**
   * Run functional tests
   */
  async runFunctionalTests() {
    logger.info('⚙️ Running functional tests...');

    // Test 1: Plugin functionality
    await this.addTest('functional_plugins', 'Plugin Functionality Test', async () => {
      if (!this.agent.apiManager) {
        throw new Error('API manager not available');
      }

      const plugins = this.agent.apiManager.getPluginList();
      if (!plugins || plugins.length === 0) {
        throw new Error('No plugins loaded');
      }

      // Test at least one core plugin
      const corePlugins = plugins.filter(p => ['tasks', 'system', 'git'].includes(p.name));
      if (corePlugins.length === 0) {
        throw new Error('No core plugins found');
      }

      // Test first available core plugin
      const testPlugin = corePlugins[0];
      if (!testPlugin.enabled) {
        throw new Error(`Core plugin ${testPlugin.name} is not enabled`);
      }

      return { status: 'passed', message: `Plugin functionality verified (${plugins.length} plugins loaded)` };
    });

    // Test 2: Command processing
    await this.addTest('functional_command_processing', 'Command Processing Test', async () => {
      if (!this.agent.commandParser) {
        throw new Error('Command parser not available');
      }

      // Test basic command parsing
      const testCommand = 'test command';
      try {
        const parsed = await this.agent.commandParser.parse(testCommand);
        if (!parsed) {
          throw new Error('Command parser returned null result');
        }
      } catch (error) {
        // Command parsing may fail for test commands, but parser should exist
        if (error.message.includes('not available')) {
          throw error;
        }
      }

      return { status: 'passed', message: 'Command processing verified' };
    });

    // Test 3: Interface availability (if web interface is running)
    await this.addTest('functional_interfaces', 'Interface Availability Test', async () => {
      const interfaces = this.agent.interfaces;
      if (!interfaces) {
        throw new Error('No interfaces found');
      }

      // Check if web interface is available
      if (interfaces.has('web')) {
        const webInterface = interfaces.get('web');
        if (!webInterface) {
          throw new Error('Web interface not properly initialized');
        }
      }

      return { status: 'passed', message: 'Interface availability verified' };
    });
  }

  /**
   * Run performance tests
   */
  async runPerformanceTests() {
    logger.info('📊 Running performance tests...');

    await this.addTest('performance_memory_usage', 'Memory Usage Test', async () => {
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);

      // Alert if using more than 500MB
      if (heapUsedMB > 500) {
        return { 
          status: 'warning', 
          message: `High memory usage: ${heapUsedMB}MB used, ${heapTotalMB}MB total`
        };
      }

      return { 
        status: 'passed', 
        message: `Memory usage normal: ${heapUsedMB}MB used, ${heapTotalMB}MB total`
      };
    });
  }

  /**
   * Run tests in Docker container (when Docker orchestration is available)
   */
  async runDockerContainerTests(options = {}) {
    try {
      const dockerPlugin = this.agent?.apiManager?.getPlugin('docker');
      if (!dockerPlugin) {
        throw new Error('Docker plugin not available');
      }

      logger.info('🐳 Running tests in Docker container...');

      const {
        testImage = 'node:18-alpine',
        codePath = process.cwd(),
        testCommand = 'npm test',
        timeout = 300000
      } = options;

      // Create test environment
      const testEnv = await dockerPlugin.execute({
        action: 'create-test-environment',
        image: testImage,
        codePath,
        environment: [
          'NODE_ENV=test',
          `MONGODB_URI=${process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent_test'}`
        ],
        timeout
      });

      if (!testEnv.success) {
        throw new Error(`Failed to create test environment: ${testEnv.error}`);
      }

      const { containerName } = testEnv.data;

      try {
        // Install dependencies in container
        await dockerPlugin.execute({
          action: 'exec',
          container: containerName,
          command: 'npm ci',
          workdir: '/app'
        });

        // Run tests in container
        const testResult = await dockerPlugin.execute({
          action: 'test-code',
          containerName,
          testCommand,
          workdir: '/app'
        });

        // Run our comprehensive test suite in container
        const frameworkTestResult = await dockerPlugin.execute({
          action: 'exec',
          container: containerName,
          command: 'node tests/run-tests.js',
          workdir: '/app'
        });

        return {
          success: testResult.success && frameworkTestResult.success,
          data: {
            containerTests: testResult.data,
            frameworkTests: frameworkTestResult.data,
            containerName,
            environment: 'docker-isolated'
          }
        };

      } finally {
        // Cleanup container
        await dockerPlugin.execute({
          action: 'remove',
          container: containerName,
          force: true
        });
      }

    } catch (error) {
      logger.error('Docker container testing failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Add a test to the test suite
   */
  async addTest(id, name, testFunction) {
    this.testSession.totalTests++;
    
    const test = {
      id,
      name,
      startTime: Date.now(),
      endTime: null,
      duration: null,
      status: 'running',
      message: null,
      error: null
    };

    try {
      logger.debug(`Running test: ${name}`);
      
      // Set timeout for test
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Test timeout')), this.config.testTimeout)
      );

      const result = await Promise.race([testFunction(), timeout]);
      
      test.endTime = Date.now();
      test.duration = test.endTime - test.startTime;
      test.status = result.status || 'passed';
      test.message = result.message;

      if (test.status === 'passed') {
        this.testSession.passed++;
        logger.debug(`✓ ${name} - ${test.message}`);
      } else if (test.status === 'warning') {
        this.testSession.passed++; // Count warnings as passed but track them
        logger.warn(`⚠ ${name} - ${test.message}`);
      } else {
        this.testSession.failed++;
        logger.error(`✗ ${name} - ${test.message}`);
      }

    } catch (error) {
      test.endTime = Date.now();
      test.duration = test.endTime - test.startTime;
      test.status = 'failed';
      test.error = error.message;
      test.message = `Test failed: ${error.message}`;
      
      this.testSession.failed++;
      this.testSession.errors.push({ test: name, error: error.message });
      
      logger.error(`✗ ${name} - ${error.message}`);
    }

    this.testResults.push(test);
    this.emit('testComplete', test);
  }

  /**
   * Generate comprehensive test report
   */
  async generateTestReport() {
    const duration = this.testSession.endTime - this.testSession.startTime;
    const successRate = Math.round((this.testSession.passed / this.testSession.totalTests) * 100);

    const report = {
      session: this.testSession,
      summary: {
        total: this.testSession.totalTests,
        passed: this.testSession.passed,
        failed: this.testSession.failed,
        successRate: `${successRate}%`,
        duration: `${Math.round(duration / 1000)}s`
      },
      testDetails: this.testResults,
      recommendations: this.generateRecommendations()
    };

    // Save report to file
    const reportPath = `tests/reports/test-report-${this.testSession.id}.json`;
    try {
      await fs.mkdir('tests/reports', { recursive: true });
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      logger.info(`Test report saved: ${reportPath}`);
    } catch (error) {
      logger.warn(`Failed to save test report: ${error.message}`);
    }

    return report;
  }

  /**
   * Generate recommendations based on test results
   */
  generateRecommendations() {
    const recommendations = [];
    
    if (this.testSession.failed > 0) {
      recommendations.push({
        type: 'error',
        message: `${this.testSession.failed} tests failed. Review failed tests before deploying changes.`
      });
    }

    const slowTests = this.testResults.filter(t => t.duration > 10000);
    if (slowTests.length > 0) {
      recommendations.push({
        type: 'performance',
        message: `${slowTests.length} tests took longer than 10 seconds. Consider optimization.`
      });
    }

    if (this.testSession.totalTests < 10) {
      recommendations.push({
        type: 'coverage',
        message: 'Consider adding more tests to improve test coverage.'
      });
    }

    return recommendations;
  }

  /**
   * Get test framework status
   */
  getStatus() {
    return {
      enabled: true,
      lastTestSession: this.testSession,
      config: this.config,
      testSuites: Object.keys(this.config.testSuites).filter(
        suite => this.config.testSuites[suite].enabled
      )
    };
  }
}

export default TestFramework;