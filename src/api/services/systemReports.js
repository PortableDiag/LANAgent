import { Router } from 'express';
import { SystemReport } from '../../models/SystemReport.js';
import { logger } from '../../utils/logger.js';
import { authenticateToken } from '../../interfaces/web/auth.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import compression from 'compression';

const router = Router();
const reportCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 minute cache

// Rate limiter for API routes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

router.use(limiter);
router.use(compression());

/**
 * Export system reports in specified format
 * GET /api/system/reports/export
 * 
 * Query params:
 * - format: Export format (json, csv)
 * - type: Report type filter (daily, weekly, monthly, custom)
 * - startDate: Filter reports after this date
 * - endDate: Filter reports before this date
 */
router.get('/reports/export', authenticateToken, async (req, res) => {
  try {
    const { format, type, startDate, endDate } = req.query;

    if (!format || !['json', 'csv'].includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing format parameter. Use: json, csv'
      });
    }

    const query = {};
    if (type) query.reportType = type;
    if (startDate || endDate) {
      query['dateRange.start'] = {};
      if (startDate) query['dateRange.start'].$gte = new Date(startDate);
      if (endDate) query['dateRange.start'].$lte = new Date(endDate);
    }

    const cacheKey = `export_${format}_${type || 'all'}_${startDate || 'any'}_${endDate || 'any'}`;
    const cached = reportCache.get(cacheKey);
    if (cached) {
      // Restore the original headers + body. Without this, a cached CSV
      // export was being JSON-encoded by res.json() and missing
      // Content-Type/Disposition headers entirely.
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Content-Disposition', cached.contentDisposition);
      return res.send(cached.body);
    }

    const reports = await retryOperation(
      () => SystemReport.find(query).sort({ createdAt: -1 }).lean(),
      { retries: 3, context: 'SystemReport.find' }
    );

    let body, contentType, contentDisposition;
    if (format === 'json') {
      body = JSON.stringify({ success: true, reports });
      contentType = 'application/json';
      contentDisposition = 'attachment; filename="system-reports.json"';
    } else if (format === 'csv') {
      const csvHeaders = ['ID', 'Type', 'Title', 'Start Date', 'End Date', 'Created At', 'Performance - Avg Response Time', 'Performance - Job Success Rate', 'Issues - Errors Logged', 'Issues - Critical'];
      const csvRows = [csvHeaders.join(',')];

      reports.forEach(report => {
        const row = [
          report._id,
          report.reportType || '',
          `"${(report.title || '').replace(/"/g, '""')}"`,
          report.dateRange?.start || '',
          report.dateRange?.end || '',
          report.createdAt || '',
          report.content?.performance?.avgResponseTime || '0',
          report.content?.performance?.jobSuccessRate || '0',
          report.content?.issues?.errorsLogged || '0',
          report.content?.issues?.criticalIssues || '0'
        ];
        csvRows.push(row.join(','));
      });

      body = csvRows.join('\n');
      contentType = 'text/csv';
      contentDisposition = 'attachment; filename="system-reports.csv"';
    }

    reportCache.set(cacheKey, { body, contentType, contentDisposition });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDisposition);
    res.send(body);
  } catch (error) {
    logger.error('Failed to export reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export reports'
    });
  }
});

/**
 * Get system report history
 * GET /api/system/reports
 * 
 * Query params:
 * - type: Report type filter (daily, weekly, monthly, custom)
 * - limit: Number of reports to return (default 10)
 * - offset: Skip number of reports for pagination
 * - startDate: Filter reports after this date
 * - endDate: Filter reports before this date
 * - summary: Return only summary data (boolean)
 */
router.get('/reports', authenticateToken, async (req, res) => {
  try {
    const {
      type,
      limit = 10,
      offset = 0,
      startDate,
      endDate,
      summary = false
    } = req.query;

    const query = {};
    
    if (type) {
      query.reportType = type;
    }
    
    if (startDate || endDate) {
      query['dateRange.start'] = {};
      if (startDate) query['dateRange.start'].$gte = new Date(startDate);
      if (endDate) query['dateRange.start'].$lte = new Date(endDate);
    }

    const totalCount = await SystemReport.countDocuments(query);
    
    let reportsQuery = SystemReport.find(query)
      .sort({ createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit));

    if (summary === 'true') {
      reportsQuery = reportsQuery.select(
        'reportType title frequency dateRange createdAt content.performance content.issues'
      );
    }

    const reports = await reportsQuery.lean();

    res.json({
      success: true,
      total: totalCount,
      count: reports.length,
      offset: parseInt(offset),
      limit: parseInt(limit),
      reports: summary === 'true' 
        ? reports.map(r => ({
            id: r._id,
            type: r.reportType,
            title: r.title,
            dateRange: r.dateRange,
            created: r.createdAt,
            performance: {
              avgResponseTime: r.content?.performance?.avgResponseTime,
              jobSuccessRate: r.content?.performance?.jobSuccessRate
            },
            issues: {
              total: (r.content?.issues?.errorsLogged || 0) + (r.content?.issues?.criticalIssues || 0),
              critical: r.content?.issues?.criticalIssues
            }
          }))
        : reports
    });
  } catch (error) {
    logger.error('Failed to get system reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve system reports'
    });
  }
});

/**
 * Get specific system report by ID
 * GET /api/system/reports/:id
 */
router.get('/reports/:id', authenticateToken, async (req, res) => {
  try {
    const report = await SystemReport.findById(req.params.id).lean();
    
    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Report not found'
      });
    }

    res.json({
      success: true,
      report
    });
  } catch (error) {
    logger.error('Failed to get system report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve system report'
    });
  }
});

/**
 * Get latest report by type
 * GET /api/system/reports/latest/:type?
 */
router.get('/reports/latest/:type?', authenticateToken, async (req, res) => {
  try {
    const { type } = req.params;
    const report = await SystemReport.getLatestReport(type);
    
    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'No reports found'
      });
    }

    res.json({
      success: true,
      report
    });
  } catch (error) {
    logger.error('Failed to get latest report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve latest report'
    });
  }
});

/**
 * Get performance trends over time
 * GET /api/system/reports/trends
 * 
 * Query params:
 * - days: Number of days to look back (default 30)
 */
router.get('/reports/trends', authenticateToken, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const cacheKey = `trends_${days}`;

    // Check cache first
    const cached = reportCache.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        days: parseInt(days),
        trends: cached,
        fromCache: true
      });
    }

    const trends = await retryOperation(
      () => SystemReport.getPerformanceTrends(parseInt(days)),
      { retries: 3, context: 'SystemReport.getPerformanceTrends' }
    );

    // Cache the result
    reportCache.set(cacheKey, trends);

    res.json({
      success: true,
      days: parseInt(days),
      trends
    });
  } catch (error) {
    logger.error('Failed to get performance trends:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve performance trends'
    });
  }
});

/**
 * Delete old reports
 * DELETE /api/system/reports/cleanup
 * 
 * Body params:
 * - olderThan: Number of days (delete reports older than X days)
 * - keepLatest: Number of reports to keep regardless of age
 */
router.delete('/reports/cleanup', authenticateToken, async (req, res) => {
  try {
    const { olderThan = 90, keepLatest = 10 } = req.body;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(olderThan));

    // Get IDs of latest reports to keep
    const latestReports = await SystemReport.find()
      .sort({ createdAt: -1 })
      .limit(parseInt(keepLatest))
      .select('_id');
    
    const keepIds = latestReports.map(r => r._id);

    // Delete old reports except the ones we want to keep
    const result = await SystemReport.deleteMany({
      createdAt: { $lt: cutoffDate },
      _id: { $nin: keepIds }
    });

    res.json({
      success: true,
      deleted: result.deletedCount,
      message: `Deleted ${result.deletedCount} reports older than ${olderThan} days`
    });
  } catch (error) {
    logger.error('Failed to cleanup reports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup old reports'
    });
  }
});

export default router;
