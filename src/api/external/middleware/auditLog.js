import ExternalAuditLog from '../../../models/ExternalAuditLog.js';
import { logger } from '../../../utils/logger.js';
import { retryOperation } from '../../../utils/retryUtils.js';
import NodeCache from 'node-cache';

const extLogger = logger.child({ service: 'external-gateway' });
const auditCache = new NodeCache({ stdTTL: 300 });

export function auditLogMiddleware(req, res, next) {
  const startTime = Date.now();

  // Capture request body for POST requests
  let requestBody = null;
  if (req.method === 'POST' && req.body) {
    try {
      requestBody = JSON.stringify(req.body);
    } catch (err) {
      extLogger.warn('Failed to serialize request body for audit log', { error: err.message });
    }
  }

  // Wrap res.json to capture response
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Async save with retry — don't block response
    retryOperation(() => ExternalAuditLog.create({
      timestamp: new Date(),
      method: req.method,
      path: req.originalUrl,
      agentId: req.externalAgentId || null,
      ip: req.ip,
      statusCode,
      duration,
      paymentTx: req.headers['x-payment-tx'] || null,
      success: statusCode >= 200 && statusCode < 400,
      requestBody,
      responseBody: typeof body === 'object' ? JSON.stringify(body) : String(body)
    }), { retries: 3 }).catch(err => {
      extLogger.error('Failed to save audit log after retries:', err);
    });

    extLogger.info(`${req.method} ${req.originalUrl} → ${statusCode} (${duration}ms)`, {
      agentId: req.externalAgentId,
      ip: req.ip
    });

    return originalJson(body);
  };

  next();
}

export async function searchAuditLogs(filters = {}, page = 1, limit = 20) {
  const cacheKey = `audit_search_${JSON.stringify(filters)}_${page}_${limit}`;
  const cachedResult = auditCache.get(cacheKey);
  if (cachedResult) return cachedResult;

  const query = {};
  if (filters.method) query.method = filters.method;
  if (filters.path) query.path = { $regex: filters.path, $options: 'i' };
  if (filters.agentId) query.agentId = filters.agentId;
  if (filters.startDate || filters.endDate) {
    query.timestamp = {};
    if (filters.startDate) query.timestamp.$gte = new Date(filters.startDate);
    if (filters.endDate) query.timestamp.$lte = new Date(filters.endDate);
  }

  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    ExternalAuditLog.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    ExternalAuditLog.countDocuments(query)
  ]);

  const result = {
    logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  };

  auditCache.set(cacheKey, result);
  return result;
}

export async function auditLogHealthCheck() {
  try {
    const dbStatus = await ExternalAuditLog.db.db.admin().ping();
    return {
      status: 'healthy',
      database: dbStatus.ok ? 'connected' : 'disconnected',
      cache: auditCache.getStats(),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}
