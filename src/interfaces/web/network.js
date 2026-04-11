import express from 'express';
import { authenticateToken } from './auth.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

// Rate limiter for API routes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

/**
 * Network Security Monitoring Web Interface
 * Provides comprehensive network discovery and security monitoring
 * including ARP scanning and device detection
 */

// API Routes for Network Security Monitoring

// Get Network Status
router.get('/api/status', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'getStatus'));
    res.json(result);
  } catch (error) {
    console.error('Network status API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get network status'
    });
  }
});

// Perform Network Scan
router.post('/api/scan', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { subnet, scanType, timeout } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'scan', {
      subnet: subnet || 'auto',
      scanType: scanType || 'arp',
      timeout: timeout || 30
    }));
    
    res.json(result);
  } catch (error) {
    console.error('Network scan API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform network scan'
    });
  }
});

// Get Discovered Devices
router.get('/api/devices', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'getDevices'));
    res.json(result);
  } catch (error) {
    console.error('Network devices API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get network devices'
    });
  }
});

// Get Device Details
router.get('/api/devices/:id', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'getDeviceDetails', { id }));
    res.json(result);
  } catch (error) {
    console.error('Network device details API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get device details'
    });
  }
});

// Update Device Info
router.put('/api/devices/:id', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    const { name, category, notes, trusted } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'updateDevice', {
      id,
      name,
      category,
      notes,
      trusted: Boolean(trusted)
    }));
    
    res.json(result);
  } catch (error) {
    console.error('Network device update API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update device'
    });
  }
});

// Set Monitoring Configuration
router.post('/api/config', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { enabled, interval, alertNewDevices, subnets, excludedIPs } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'setConfig', {
      enabled: Boolean(enabled),
      interval: parseInt(interval) || 300,
      alertNewDevices: Boolean(alertNewDevices),
      subnets: subnets || [],
      excludedIPs: excludedIPs || []
    }));
    
    res.json(result);
  } catch (error) {
    console.error('Network config API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update network monitoring config'
    });
  }
});

// Get Monitoring Configuration
router.get('/api/config', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'getConfig'));
    res.json(result);
  } catch (error) {
    console.error('Network get config API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get network monitoring config'
    });
  }
});

// Get Network Alerts
router.get('/api/alerts', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { limit, offset } = req.query;
    const cacheKey = `alerts_${limit}_${offset}`;
    
    const result = await cache.get(cacheKey) || await retryOperation(async () => {
      const data = await agent.apiManager.executeAPI('network', 'getAlerts', {
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
      });
      cache.set(cacheKey, data);
      return data;
    });
    
    res.json(result);
  } catch (error) {
    console.error('Network alerts API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get network alerts'
    });
  }
});

// Clear/Acknowledge Alert
router.delete('/api/alerts/:id', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { id } = req.params;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'clearAlert', { id }));
    res.json(result);
  } catch (error) {
    console.error('Network clear alert API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear alert'
    });
  }
});

// Start/Stop Continuous Monitoring
router.post('/api/monitoring/start', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'startMonitoring'));
    res.json(result);
  } catch (error) {
    console.error('Network start monitoring API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start network monitoring'
    });
  }
});

router.post('/api/monitoring/stop', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'stopMonitoring'));
    res.json(result);
  } catch (error) {
    console.error('Network stop monitoring API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop network monitoring'
    });
  }
});

// Export Device List
router.get('/api/export', authenticateToken, limiter, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { format } = req.query;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('network', 'exportDevices', {
      format: format || 'csv'
    }));
    
    if (result.success) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="network-devices.csv"');
      res.send(result.data);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Network export API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export device list'
    });
  }
});

export default router;