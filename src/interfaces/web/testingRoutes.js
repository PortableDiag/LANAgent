/**
 * Comprehensive API Testing Routes
 * All endpoints for testing complex features, plugins, and background tasks
 */

import { authenticateToken } from './auth.js';
import { logger } from '../../utils/logger.js';

/**
 * Setup comprehensive testing routes for LANAgent API endpoints
 * 
 * Registers test endpoints for AI intent detection, memory system,
 * plugin integration testing, and background service validation.
 * All routes require authentication and provide detailed error handling.
 * 
 * @param {import('express').Application} app - Express application instance
 * @param {import('../../core/agent.js').Agent} agent - LANAgent instance with initialized services
 * @returns {void}
 * 
 * @example
 * // Setup testing routes during application initialization
 * import express from 'express';
 * import { setupTestingRoutes } from './testingRoutes.js';
 * 
 * const app = express();
 * const agent = new Agent();
 * setupTestingRoutes(app, agent);
 */
export function setupTestingRoutes(app, agent) {
  
  // ==================== COMPLEX FEATURES TESTING ====================
  
  // Test AI Intent Detection
  app.post('/api/test/ai-intent', authenticateToken, async (req, res) => {
    try {
      const { text } = req.body;
      
      if (!agent.aiIntentDetector) {
        return res.json({
          success: false,
          error: 'AI Intent Detector not initialized'
        });
      }
      
      const intent = await agent.aiIntentDetector.detect(text);
      res.json({ 
        success: true, 
        data: { 
          text, 
          intent,
          confidence: intent ? (intent.confidence || 'unknown') : 'none'
        } 
      });
    } catch (error) {
      logger.error('AI Intent test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Debug Intent System - List all available intents
  app.get('/api/debug/intents', authenticateToken, async (req, res) => {
    try {
      if (!agent.aiIntentDetector) {
        return res.json({
          success: false,
          error: 'AI Intent Detector not initialized'
        });
      }
      
      const debugInfo = agent.aiIntentDetector.debugIntents();
      res.json({ 
        success: true, 
        data: debugInfo
      });
    } catch (error) {
      logger.error('Intent debug error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Debug Intent Prompt - Get the full prompt sent to AI
  app.post('/api/debug/intent-prompt', authenticateToken, async (req, res) => {
    try {
      const { text, context } = req.body;
      
      if (!agent.aiIntentDetector) {
        return res.json({
          success: false,
          error: 'AI Intent Detector not initialized'
        });
      }
      
      const prompt = agent.aiIntentDetector.getDebugPrompt(text, context || '');
      res.json({ 
        success: true, 
        data: { 
          query: text,
          context: context || '',
          prompt
        } 
      });
    } catch (error) {
      logger.error('Intent prompt debug error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Memory System
  app.post('/api/test/memory', authenticateToken, async (req, res) => {
    try {
      const { action, data } = req.body;
      let result;
      
      switch (action) {
        case 'store':
          result = await agent.memoryManager.store(data.type || 'test', data.content, data.metadata || {});
          break;
        case 'retrieve':
          result = await agent.memoryManager.recall(data.query, { limit: 10 });
          break;
        case 'knowledge':
          result = await agent.memoryManager.getSystemKnowledge(data.category);
          break;
        case 'conversation':
          result = await agent.memoryManager.getConversationContext(data.userId || 'test-user', 10);
          break;
        default:
          throw new Error(`Unknown memory action: ${action}`);
      }
      
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Memory test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Self-Modification System
  app.post('/api/test/self-modification', authenticateToken, async (req, res) => {
    try {
      const { action } = req.body;
      let result;
      
      switch (action) {
        case 'status':
          result = agent.selfModification.getStatus();
          break;
        case 'upgrade-plans':
          result = await agent.selfModification.generateUpgradePlans();
          break;
        case 'check-improvements':
          result = await agent.selfModification.checkForImprovements();
          break;
        default:
          throw new Error(`Unknown self-modification action: ${action}`);
      }
      
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-modification test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Provider Manager
  app.post('/api/test/providers', authenticateToken, async (req, res) => {
    try {
      const { action, provider, prompt } = req.body;
      let result;
      
      switch (action) {
        case 'list':
          result = agent.providerManager.getProviderList();
          break;
        case 'current':
          result = await agent.providerManager.getCurrentProvider();
          break;
        case 'switch':
          await agent.providerManager.switchProvider(provider);
          result = { switched: true, provider };
          break;
        case 'test-response':
          result = await agent.processNaturalLanguage(prompt || 'Hello, test message', { interface: 'test' });
          break;
        case 'metrics':
          result = agent.providerManager.getMetrics();
          break;
        default:
          throw new Error(`Unknown provider action: ${action}`);
      }
      
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Provider test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== PLUGIN OPERATIONS TESTING ====================
  
  // Test All Plugins
  app.get('/api/test/plugins', authenticateToken, async (req, res) => {
    try {
      const plugins = agent.apiManager.getPluginList();
      res.json({ success: true, data: plugins });
    } catch (error) {
      logger.error('Plugin list test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Individual Plugin
  app.post('/api/test/plugin/:name', authenticateToken, async (req, res) => {
    try {
      const { name } = req.params;
      const { action, ...params } = req.body;
      
      const plugin = agent.apiManager.getPlugin(name);
      if (!plugin) {
        return res.status(404).json({ success: false, error: `Plugin ${name} not found` });
      }
      
      const result = await plugin.execute({ action, ...params });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error(`Plugin ${req.params.name} test error:`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Plugin Enable/Disable
  app.post('/api/test/plugin/:name/toggle', authenticateToken, async (req, res) => {
    try {
      const { name } = req.params;
      const { enable } = req.body;
      
      const plugin = agent.apiManager.getPlugin(name);
      if (!plugin) {
        return res.status(404).json({ success: false, error: `Plugin ${name} not found` });
      }
      
      // Note: Plugin enable/disable methods may not exist in current implementation
      // Return current status for now
      res.json({ 
        success: true, 
        data: { 
          plugin: name, 
          currentlyEnabled: plugin.enabled || true,
          requestedEnable: enable,
          note: "Plugin toggle not implemented in current API"
        } 
      });
    } catch (error) {
      logger.error(`Plugin ${req.params.name} toggle error:`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== BACKGROUND TASKS/JOBS TESTING ====================
  
  // Test Scheduler Status
  app.get('/api/test/scheduler', authenticateToken, async (req, res) => {
    try {
      if (!agent.scheduler) {
        return res.json({ 
          success: true, 
          data: { 
            status: 'not_initialized',
            message: 'Scheduler not initialized'
          } 
        });
      }
      
      const status = await agent.scheduler.getJobStatus();
      
      res.json({ 
        success: true, 
        data: status
      });
    } catch (error) {
      logger.error('Scheduler test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Bug Fixing Service
  app.post('/api/test/bug-fixing', authenticateToken, async (req, res) => {
    try {
      const { action } = req.body;
      let result;
      
      if (!agent.bugFixing) {
        return res.json({
          success: false,
          error: 'Bug fixing service not initialized'
        });
      }
      
      switch (action) {
        case 'status':
          result = agent.bugFixing.getStatus();
          break;
        case 'trigger':
          await agent.bugFixing.runBugFixingSession();
          result = { triggered: true, message: 'Bug fixing session started' };
          break;
        case 'config':
          result = agent.bugFixing.config;
          break;
        default:
          throw new Error(`Unknown bug fixing action: ${action}`);
      }
      
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Bug fixing test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Plugin Development Service
  app.post('/api/test/plugin-development', authenticateToken, async (req, res) => {
    try {
      const { action } = req.body;
      let result;
      
      if (!agent.pluginDevelopment) {
        return res.json({
          success: false,
          error: 'Plugin development service not initialized'
        });
      }
      
      switch (action) {
        case 'status':
          result = await agent.pluginDevelopment.getStatus();
          break;
        case 'trigger':
          await agent.pluginDevelopment.checkForPluginOpportunities();
          result = { triggered: true, message: 'Plugin development check started' };
          break;
        case 'config':
          result = agent.pluginDevelopment.config;
          break;
        default:
          throw new Error(`Unknown plugin development action: ${action}`);
      }
      
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Plugin development test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Email System
  app.post('/api/test/email', authenticateToken, async (req, res) => {
    try {
      const { action, ...params } = req.body;
      
      const emailPlugin = agent.apiManager.getPlugin('email');
      if (!emailPlugin) {
        return res.status(404).json({ success: false, error: 'Email plugin not found' });
      }
      
      const result = await emailPlugin.execute({ action, ...params });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Email test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Task Management
  app.post('/api/test/tasks', authenticateToken, async (req, res) => {
    try {
      const { action, ...params } = req.body;
      
      const taskPlugin = agent.apiManager.getPlugin('tasks');
      if (!taskPlugin) {
        return res.status(404).json({ success: false, error: 'Tasks plugin not found' });
      }
      
      const result = await taskPlugin.execute({ action, ...params });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Tasks test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Git Operations
  app.post('/api/test/git', authenticateToken, async (req, res) => {
    try {
      const { action, ...params } = req.body;
      
      const gitPlugin = agent.apiManager.getPlugin('git');
      if (!gitPlugin) {
        return res.status(404).json({ success: false, error: 'Git plugin not found' });
      }
      
      const result = await gitPlugin.execute({ action, ...params });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Git test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Web Search
  app.post('/api/test/websearch', authenticateToken, async (req, res) => {
    try {
      const { action, query } = req.body;
      
      const webSearchPlugin = agent.apiManager.getPlugin('websearch');
      if (!webSearchPlugin) {
        return res.status(404).json({ success: false, error: 'Web search plugin not found' });
      }
      
      const result = await webSearchPlugin.execute({ action, query });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Web search test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== SYSTEM INTEGRATION TESTS ====================
  
  // Test Complete Workflow
  app.post('/api/test/workflow', authenticateToken, async (req, res) => {
    try {
      const { workflow } = req.body;
      let result;
      
      switch (workflow) {
        case 'full-ai-pipeline':
          result = await testFullAIPipeline(agent);
          break;
        case 'plugin-integration':
          result = await testPluginIntegration(agent);
          break;
        case 'background-services':
          result = await testBackgroundServices(agent);
          break;
        default:
          throw new Error(`Unknown workflow: ${workflow}`);
      }
      
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Workflow test error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // System Health Check
  app.get('/api/test/health', authenticateToken, async (req, res) => {
    try {
      const health = {
        timestamp: new Date().toISOString(),
        agent: {
          name: agent.config.name || 'LAN Agent',
          uptime: process.uptime(),
          memory: process.memoryUsage()
        },
        services: {
          mongodb: !!agent.isConnected,
          providers: agent.providerManager ? agent.providerManager.getProviderList().length : 0,
          plugins: agent.apiManager ? agent.apiManager.getPluginList().length : 0,
          scheduler: agent.scheduler ? 'running' : 'stopped'
        },
        features: {
          selfModification: agent.selfModification ? agent.selfModification.getStatus().enabled : false,
          bugFixing: agent.bugFixing ? agent.bugFixing.getStatus().enabled : false,
          pluginDevelopment: agent.pluginDevelopment ? (await agent.pluginDevelopment.getStatus()).enabled : false
        }
      };
      
      res.json({ success: true, data: health });
    } catch (error) {
      logger.error('Health check error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

// Helper test functions
async function testFullAIPipeline(agent) {
  const results = {};
  
  // Test intent detection
  const intent = await agent.aiIntentDetector.detectIntent('What is the weather like today?');
  results.intentDetection = { intent, success: !!intent };
  
  // Test AI response
  const response = await agent.processNaturalLanguage('Hello, this is a test message');
  results.aiResponse = { response, success: !!response };
  
  // Test memory storage
  const memory = await agent.memoryManager.storeMemory('Test memory from API test', 'test', 5);
  results.memoryStorage = { memory, success: !!memory };
  
  return results;
}

async function testPluginIntegration(agent) {
  const results = {};
  const plugins = agent.apiManager.getPluginList();
  
  for (const plugin of plugins) {
    try {
      if (plugin.enabled) {
        // Test basic plugin functionality
        results[plugin.name] = {
          loaded: true,
          enabled: true,
          hasExecute: typeof plugin.execute === 'function',
          success: true
        };
      } else {
        results[plugin.name] = {
          loaded: true,
          enabled: false,
          hasExecute: typeof plugin.execute === 'function',
          success: false
        };
      }
    } catch (error) {
      results[plugin.name] = {
        loaded: false,
        enabled: false,
        error: error.message,
        success: false
      };
    }
  }
  
  return results;
}

async function testBackgroundServices(agent) {
  const results = {};
  
  // Test scheduler
  try {
    const schedulerStatus = await agent.scheduler.getStatus();
    results.scheduler = { status: schedulerStatus, success: true };
  } catch (error) {
    results.scheduler = { error: error.message, success: false };
  }
  
  // Test bug fixing service
  try {
    const bugFixingStatus = agent.bugFixing.getStatus();
    results.bugFixing = { status: bugFixingStatus, success: true };
  } catch (error) {
    results.bugFixing = { error: error.message, success: false };
  }
  
  // Test plugin development service
  try {
    const pluginDevStatus = await agent.pluginDevelopment.getStatus();
    results.pluginDevelopment = { status: pluginDevStatus, success: true };
  } catch (error) {
    results.pluginDevelopment = { error: error.message, success: false };
  }
  
  return results;
}