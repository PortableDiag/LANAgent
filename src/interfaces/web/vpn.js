import express from 'express';
import { authenticateToken } from './auth.js';
import { retryOperation, isRetryableError } from '../../utils/retryUtils.js';
import { logger } from '../../utils/logger.js';
import NodeCache from 'node-cache';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 600 }); // Cache with a TTL of 10 minutes

/**
 * VPN Management Web Interface
 * Provides full control over VPN state and location selection
 */

// API Routes for VPN Management

// Get VPN Status
router.get('/api/status', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'status'), { retries: 3 });
    res.json(result);
  } catch (error) {
    logger.error('VPN status API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get VPN status'
    });
  }
});

// Connect to VPN
router.post('/api/connect', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { location, protocol, retry } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'connect', {
      location,
      protocol,
      retry
    }), { retries: 3, shouldRetry: isRetryableError });
    
    res.json(result);
  } catch (error) {
    logger.error('VPN connect API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect to VPN'
    });
  }
});

// Disconnect from VPN
router.post('/api/disconnect', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'disconnect'), { retries: 3 });
    res.json(result);
  } catch (error) {
    logger.error('VPN disconnect API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect from VPN'
    });
  }
});

// Smart Connect
router.post('/api/smart-connect', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { purpose } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'smartConnect', {
      purpose: purpose || 'general'
    }), { retries: 3 });
    
    res.json(result);
  } catch (error) {
    logger.error('VPN smart connect API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to smart connect to VPN'
    });
  }
});

// Get Available Locations
router.get('/api/locations', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { country } = req.query;
    
    const cacheKey = `locations_${country || 'all'}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'listLocations', {
      country
    }), { retries: 3 });
    
    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    logger.error('VPN locations API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get VPN locations'
    });
  }
});

// Test Connection
router.post('/api/test', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { testSites } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'testConnection', {
      testSites
    }), { retries: 3 });
    
    res.json(result);
  } catch (error) {
    logger.error('VPN test API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test VPN connection'
    });
  }
});

// Troubleshoot VPN
router.post('/api/troubleshoot', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'troubleshoot'), { retries: 3 });
    res.json(result);
  } catch (error) {
    logger.error('VPN troubleshoot API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to troubleshoot VPN'
    });
  }
});

// Set Auto-Connect Configuration
router.post('/api/auto-connect', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { enabled, location } = req.body;
    
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'setAutoConnect', {
      enabled: Boolean(enabled),
      location
    }), { retries: 3 });
    
    res.json(result);
  } catch (error) {
    logger.error('VPN auto-connect API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to set auto-connect configuration'
    });
  }
});

// Get Public IP
router.get('/api/public-ip', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await retryOperation(() => agent.apiManager.executeAPI('vpn', 'getPublicIP'), { retries: 3 });
    res.json(result);
  } catch (error) {
    logger.error('VPN public IP API error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get public IP'
    });
  }
});

// ── WireGuard (inbound tunnel) ──────────────────────────────

// Get WireGuard tunnel status
router.get('/api/wireguard/status', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await agent.apiManager.executeAPI('vpn', 'execute', { action: 'wireguardStatus' });
    res.json(result);
  } catch (error) {
    logger.error('WireGuard status API error:', error);
    res.status(500).json({ success: false, error: 'Failed to get WireGuard status' });
  }
});

// Bounce WireGuard tunnel (wg-quick down/up)
router.post('/api/wireguard/bounce', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const result = await agent.apiManager.executeAPI('vpn', 'execute', { action: 'wireguardBounce' });
    res.json(result);
  } catch (error) {
    logger.error('WireGuard bounce API error:', error);
    res.status(500).json({ success: false, error: 'Failed to bounce WireGuard tunnel' });
  }
});

// WireGuard health check (auto-recovers if stale)
router.post('/api/wireguard/health', authenticateToken, async (req, res) => {
  try {
    const agent = req.app.locals.agent;
    const { maxHandshakeAge } = req.body;
    const result = await agent.apiManager.executeAPI('vpn', 'execute', { action: 'wireguardHealth', maxHandshakeAge });
    res.json(result);
  } catch (error) {
    logger.error('WireGuard health API error:', error);
    res.status(500).json({ success: false, error: 'Failed to check WireGuard health' });
  }
});

export default router;