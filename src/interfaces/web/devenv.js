import express from 'express';
import { authenticateToken } from './auth.js';
import { retryOperation } from '../../utils/retryUtils.js';
import { logger } from '../../utils/logger.js';
import NodeCache from 'node-cache';

const router = express.Router();
const metricsCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

/**
 * Development Environment Automation Web Interface
 * Provides comprehensive development workflow automation including
 * project setup, dependency management, testing automation, and deployment
 */

// API Routes for Development Environment Automation

// Get Development Environment Status
router.get('/api/status', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'getStatus'), { retries: 3, context: 'devenv-getStatus' });
    res.json(result);
  } catch (error) {
    logger.error('DevEnv status API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get development environment status'
    });
  }
});

// Get Active Projects
router.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'getProjects'), { retries: 3, context: 'devenv-getProjects' });
    res.json(result);
  } catch (error) {
    logger.error('DevEnv projects API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get active projects'
    });
  }
});

// Create New Project
router.post('/api/projects', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { name, type, framework, path, template, gitRepo, dependencies } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'createProject', {
      name,
      type,
      framework,
      path,
      template,
      gitRepo,
      dependencies
    }), { retries: 3, context: 'devenv-createProject' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv create project API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create project'
    });
  }
});

// Setup Project Dependencies
router.post('/api/projects/:id/setup', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { installDeps, setupEnv, initGit, runTests } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'setupProject', {
      projectId: id,
      installDeps: Boolean(installDeps),
      setupEnv: Boolean(setupEnv),
      initGit: Boolean(initGit),
      runTests: Boolean(runTests)
    }), { retries: 3, context: 'devenv-setupProject' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv setup project API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to setup project'
    });
  }
});

// Run Development Server
router.post('/api/projects/:id/dev', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { command, port, env } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'startDevelopmentServer', {
      projectId: id,
      command,
      port,
      env: env || {}
    }), { retries: 3, context: 'devenv-startDev' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv dev server API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start development server'
    });
  }
});

// Stop Development Server
router.post('/api/projects/:id/stop', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'stopDevelopmentServer', {
      projectId: id
    }), { retries: 3, context: 'devenv-stopDev' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv stop server API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop development server'
    });
  }
});

// Run Tests
router.post('/api/projects/:id/test', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { testType, watch, coverage, specific } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'runTests', {
      projectId: id,
      testType: testType || 'unit',
      watch: Boolean(watch),
      coverage: Boolean(coverage),
      specific
    }), { retries: 3, context: 'devenv-runTests' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv test API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to run tests'
    });
  }
});

// Build Project
router.post('/api/projects/:id/build', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { buildType, optimize, target } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'buildProject', {
      projectId: id,
      buildType: buildType || 'production',
      optimize: Boolean(optimize),
      target
    }), { retries: 3, context: 'devenv-build' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv build API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to build project'
    });
  }
});

// Deploy Project
router.post('/api/projects/:id/deploy', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { target, environment, config } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'deployProject', {
      projectId: id,
      target,
      environment: environment || 'staging',
      config: config || {}
    }), { retries: 3, context: 'devenv-deploy' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv deploy API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to deploy project'
    });
  }
});

// Install Dependencies
router.post('/api/projects/:id/install', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { packages, dev, global } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'installDependencies', {
      projectId: id,
      packages: packages || [],
      dev: Boolean(dev),
      global: Boolean(global)
    }), { retries: 3, context: 'devenv-installDeps' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv install deps API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to install dependencies'
    });
  }
});

// Update Dependencies
router.post('/api/projects/:id/update', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { packages, security, major } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'updateDependencies', {
      projectId: id,
      packages: packages || [],
      security: Boolean(security),
      major: Boolean(major)
    }), { retries: 3, context: 'devenv-updateDeps' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv update deps API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update dependencies'
    });
  }
});

// Lint Code
router.post('/api/projects/:id/lint', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { fix, files, format } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'lintCode', {
      projectId: id,
      fix: Boolean(fix),
      files: files || [],
      format: format || 'standard'
    }), { retries: 3, context: 'devenv-lint' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv lint API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to lint code'
    });
  }
});

// Format Code
router.post('/api/projects/:id/format', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { files, style, verify } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'formatCode', {
      projectId: id,
      files: files || [],
      style: style || 'prettier',
      verify: Boolean(verify)
    }), { retries: 3, context: 'devenv-format' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv format API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to format code'
    });
  }
});

// Get Environment Variables
router.get('/api/projects/:id/env', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'getEnvironmentVariables', {
      projectId: id
    }), { retries: 3, context: 'devenv-getEnv' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv get env API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get environment variables'
    });
  }
});

// Set Environment Variables
router.post('/api/projects/:id/env', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { variables, environment } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'setEnvironmentVariables', {
      projectId: id,
      variables: variables || {},
      environment: environment || 'development'
    }), { retries: 3, context: 'devenv-setEnv' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv set env API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to set environment variables'
    });
  }
});

// Get Project Templates
router.get('/api/templates', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { type, framework } = req.query;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'getTemplates', {
      type,
      framework
    }), { retries: 3, context: 'devenv-getTemplates' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv templates API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get project templates'
    });
  }
});

// Run Custom Commands
router.post('/api/projects/:id/command', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { command, args, cwd, env } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'runCommand', {
      projectId: id,
      command,
      args: args || [],
      cwd,
      env: env || {}
    }), { retries: 3, context: 'devenv-runCommand' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv command API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to run command'
    });
  }
});

// Get Project Logs
router.get('/api/projects/:id/logs', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { lines, follow } = req.query;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'getProjectLogs', {
      projectId: id,
      lines: parseInt(lines) || 100,
      follow: Boolean(follow)
    }), { retries: 3, context: 'devenv-getLogs' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv logs API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get project logs'
    });
  }
});

// Get Project Metrics
router.get('/api/projects/:id/metrics', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const cacheKey = `projectMetrics_${id}`;
    const cachedMetrics = metricsCache.get(cacheKey);
    if (cachedMetrics) {
      return res.json(cachedMetrics);
    }

    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'getProjectMetrics', {
      projectId: id
    }), { retries: 3, context: 'devenv-getMetrics' });

    metricsCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    logger.error('DevEnv metrics API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get project metrics'
    });
  }
});

// Delete Project
router.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { deleteFiles } = req.query;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'deleteProject', {
      projectId: id,
      deleteFiles: Boolean(deleteFiles)
    }), { retries: 3, context: 'devenv-deleteProject' });
    
    res.json(result);
  } catch (error) {
    logger.error('DevEnv delete project API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete project'
    });
  }
});

// List project version history
router.get('/api/projects/:id/versions', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'listProjectVersions', {
      projectId: id,
      limit
    }), { retries: 3, context: 'devenv-listProjectVersions' });

    res.json(result);
  } catch (error) {
    logger.error('DevEnv list versions API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list project versions'
    });
  }
});

// Rollback project to a specific version
router.post('/api/projects/:id/rollback', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { version } = req.body;

    if (!version) {
      return res.status(400).json({
        success: false,
        error: 'Version (commit hash) is required'
      });
    }

    const result = await retryOperation(() => agent.apiManager.executeAPI('devenv', 'rollbackProjectVersion', {
      projectId: id,
      version
    }), { retries: 3, context: 'devenv-rollbackProjectVersion' });

    res.json(result);
  } catch (error) {
    logger.error('DevEnv rollback API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to rollback project'
    });
  }
});

export default router;