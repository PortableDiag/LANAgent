import express from 'express';
import { authenticateToken } from './auth.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * SSH Connection Management Web Interface
 * Provides secure SSH connection management with credential storage
 */

// API Routes for SSH Management

// Get SSH Connections with optional tag filtering
router.get('/api/connections', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { tags } = req.query;
    const result = await agent.apiManager.executeAPI('ssh', 'execute', { action: 'list-connections', tags });
    res.json(result);
  } catch (error) {
    console.error('SSH connections API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get SSH connections'
    });
  }
});

// Create SSH Connection with optional tags
router.post('/api/connections', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { name, host, port, username, password, privateKey, description, tags } = req.body;

    const result = await agent.apiManager.executeAPI('ssh', 'execute', {
      action: 'save-connection',
      name,
      host,
      port: parseInt(port) || 22,
      username,
      password,
      privateKey,
      description,
      tags
    });
    
    res.json(result);
  } catch (error) {
    console.error('SSH create connection API error:', error);
    logger.error('SSH create connection failed:', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create SSH connection'
    });
  }
});

// Update SSH Connection with optional tags
router.put('/api/connections/:id', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { name, host, port, username, password, privateKey, description, tags } = req.body;

    const result = await agent.apiManager.executeAPI('ssh', 'execute', {
      action: 'save-connection',
      id,
      name,
      host,
      port: parseInt(port) || 22,
      username,
      password,
      privateKey,
      description,
      tags
    });
    
    res.json(result);
  } catch (error) {
    console.error('SSH update connection API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update SSH connection'
    });
  }
});

// Delete SSH Connection
router.delete('/api/connections/:id', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const result = await agent.apiManager.executeAPI('ssh', 'execute', { action: 'delete-connection', id });
    res.json(result);
  } catch (error) {
    console.error('SSH delete connection API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete SSH connection'
    });
  }
});

// Test SSH Connection
router.post('/api/connections/:id/test', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const result = await agent.apiManager.executeAPI('ssh', 'execute', { action: 'test-connection', id });
    res.json(result);
  } catch (error) {
    console.error('SSH test connection API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test SSH connection'
    });
  }
});

// Connect via SSH
router.post('/api/connections/:id/connect', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const result = await agent.apiManager.executeAPI('ssh', 'execute', { action: 'connect', id });
    res.json(result);
  } catch (error) {
    console.error('SSH connect API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect via SSH'
    });
  }
});

// Disconnect from SSH
router.post('/api/connections/:id/disconnect', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const result = await agent.apiManager.executeAPI('ssh', 'execute', { action: 'disconnect', connectionId: id });
    res.json(result);
  } catch (error) {
    console.error('SSH disconnect API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect SSH'
    });
  }
});

// Execute Command via SSH
router.post('/api/connections/:id/execute', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { command } = req.body;
    
    const result = await agent.apiManager.executeAPI('ssh', 'execute', { 
      action: 'execute',
      connectionId: id, 
      command 
    });
    
    res.json(result);
  } catch (error) {
    console.error('SSH execute command API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute SSH command'
    });
  }
});

// Get SSH Connection Status
router.get('/api/status', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await agent.apiManager.executeAPI('ssh', 'getStatus');
    res.json(result);
  } catch (error) {
    console.error('SSH status API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get SSH status'
    });
  }
});

export default router;