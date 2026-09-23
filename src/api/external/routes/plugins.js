import { Router } from 'express';
import path from 'path';
import { creditAuth } from '../middleware/creditAuth.js';
import { adminKeyAuth } from '../middleware/adminKeyAuth.js';
import ExternalAuditLog from '../../../models/ExternalAuditLog.js';
import { generateDownloadToken } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

// Plugins that produce a downloadable file on the agent's local filesystem.
// For these, we mint a short-lived download token URL so external clients can
// fetch the result. Without this conversion, the response sanitizer redacts
// the internal /root/... path and the client gets nothing usable.
const FILE_PRODUCING_PLUGINS = new Set(['ytdlp', 'ffmpeg', 'imageTools', 'pdf']);

function attachDownloadUrl(result, agentId) {
  if (!result || typeof result !== 'object') return result;

  // Object shape: result.file = { path, filename, size, ... }
  if (result.file && typeof result.file === 'object' && typeof result.file.path === 'string' && result.file.path) {
    const filePath = result.file.path;
    const filename = result.file.filename || path.basename(filePath);
    const size = result.file.size;
    try {
      const token = generateDownloadToken({
        filePath,
        filename,
        agentId: agentId || 'external',
        maxDownloads: 3,
        expiresInMinutes: 60
      });
      result.file = {
        filename,
        size,
        downloadUrl: `/api/external/download/${token}`,
        tokenExpires: '60 minutes',
        maxDownloads: 3
      };
    } catch (err) {
      logger.error(`attachDownloadUrl failed (object): ${err.message}`);
    }
  }
  // String shape: result.file = '/path/to/file' (e.g. ytdlp.thumbnail)
  else if (typeof result.file === 'string' && result.file.startsWith('/')) {
    const filePath = result.file;
    const filename = path.basename(filePath);
    try {
      const token = generateDownloadToken({
        filePath,
        filename,
        agentId: agentId || 'external',
        maxDownloads: 3,
        expiresInMinutes: 60
      });
      result.file = {
        filename,
        downloadUrl: `/api/external/download/${token}`,
        tokenExpires: '60 minutes',
        maxDownloads: 3
      };
    } catch (err) {
      logger.error(`attachDownloadUrl failed (string): ${err.message}`);
    }
  }

  // Strip leaky fields that would otherwise be sanitized to "[redacted]"
  // and provide no value to the external caller.
  if (typeof result.command === 'string') delete result.command;

  return result;
}

// Plugins that are safe to expose via paid external API — exported for catalog
export const ALLOWED_PLUGINS = new Set([
  'anime', 'chainlink', 'lyrics', 'nasa', 'weatherstack', 'news',
  'websearch', 'huggingface',
  // Already have dedicated routes but allow generic access too
  'scraper', 'ytdlp', 'ffmpeg',
  // AI content detection
  'aiDetector',
  // Challenge questions (bot filtering)
  'challengeQuestions',
  // Crypto analysis
  'tokenProfiler', 'walletProfiler', 'contractAudit',
  // Image processing
  'imageTools'
]);

// Actions blocked even on allowed plugins
const BLOCKED_ACTIONS = new Set([
  'configure', 'settings', 'updateSettings', 'getSettings',
  'setPreferences', 'getPreferences', 'version', 'update',
  'upgrade', 'showVersion', 'status', 'health', 'listFormats'
]);

// Credit costs by plugin (1 credit ≈ $0.01 USD) — exported for catalog
// These map to the SERVICE_USD_TIERS in p2p.js
export const PLUGIN_CREDIT_COSTS = {
  anime: 1,      // $0.01
  chainlink: 1,  // $0.01 — on-chain read, no API key needed
  lyrics: 1,     // $0.005 → round up to 1
  nasa: 1,       // $0.01
  weatherstack: 1, // $0.01
  news: 1,       // $0.01
  websearch: 2,  // $0.02
  huggingface: 10, // $0.10
  scraper: 2,    // $0.02
  ytdlp: 3,      // $0.03
  ffmpeg: 5,     // $0.05
  aiDetector: 5,  // $0.05 — AI content detection (text/image/audio/video)
  challengeQuestions: 2,  // $0.02 — bot-filtering challenge questions
  tokenProfiler: 3,  // $0.03 — token scam/honeypot detection
  walletProfiler: 3,  // $0.03 — wallet profiling and risk scoring
  contractAudit: 5,  // $0.05 — smart contract security audit
  imageTools: 2      // $0.02 — image processing (optimize, resize, crop, convert, watermark)
};

/**
 * Generic plugin execution route.
 * POST /api/external/service/:plugin/:action
 *
 * Allows external clients to call any eligible plugin action via the credit system.
 * Credit cost is determined by the plugin category.
 */
router.post('/:plugin/:action',
  creditAuth(true), // Require API key auth, we charge credits manually below
  async (req, res) => {
    const { plugin, action } = req.params;
    const params = req.body || {};

    // Validate plugin
    if (!ALLOWED_PLUGINS.has(plugin)) {
      return res.status(403).json({
        success: false,
        error: `Plugin '${plugin}' is not available as an external service`,
        allowedPlugins: Array.from(ALLOWED_PLUGINS)
      });
    }

    // Validate action
    if (BLOCKED_ACTIONS.has(action)) {
      return res.status(403).json({ success: false, error: `Action '${action}' is not available` });
    }

    // Get credit cost
    const creditCost = PLUGIN_CREDIT_COSTS[plugin] || 3;

    // Debit credits
    try {
      const ExternalCreditBalance = (await import('../../../models/ExternalCreditBalance.js')).default;
      const debited = await ExternalCreditBalance.debitCredits(req.wallet, creditCost);
      if (!debited) {
        return res.status(402).json({
          success: false,
          error: 'Insufficient credits',
          required: creditCost,
          balance: req.creditBalance || 0,
          plugin,
          action
        });
      }
    } catch (err) {
      return res.status(402).json({ success: false, error: 'Credit debit failed: ' + err.message });
    }

    try {
      // Get plugin instance — only if enabled (has required API keys, etc.)
      const apiManager = req.app.locals.agent?.apiManager;
      const pluginEntry = apiManager?.apis?.get(plugin);

      if (!pluginEntry || pluginEntry.enabled === false) {
        // Refund — plugin is disabled (missing API key or failed init)
        const ExternalCreditBalanceRef = (await import('../../../models/ExternalCreditBalance.js')).default;
        await ExternalCreditBalanceRef.refundCredits(req.wallet, creditCost);
        return res.status(503).json({
          success: false,
          error: `Plugin '${plugin}' is not available — missing API key or not configured`,
          credited: true,
          creditsRefunded: creditCost
        });
      }

      const pluginInstance = pluginEntry.instance || pluginEntry;

      if (!pluginInstance?.execute) {
        // Refund
        const ExternalCreditBalance = (await import('../../../models/ExternalCreditBalance.js')).default;
        await ExternalCreditBalance.refundCredits(req.wallet, creditCost);
        return res.status(503).json({ success: false, error: `Plugin '${plugin}' not available` });
      }

      // Execute — try new-style first, fall back to old-style if it fails
      let result;
      try {
        result = await pluginInstance.execute({ action, ...params });
        // If old-style plugin, action becomes [object Object] — detect and retry
        if (result?.error?.includes?.('[object Object]') || result?.error?.includes?.('Unknown action')) {
          result = await pluginInstance.execute(action, params);
        }
      } catch (execErr) {
        // Try old-style as fallback
        try {
          result = await pluginInstance.execute(action, params);
        } catch (fallbackErr) {
          throw execErr; // throw original error
        }
      }

      if (!result || result.success === false) {
        // Refund on graceful failure (e.g., "no results found")
        const ExternalCreditBalance2 = (await import('../../../models/ExternalCreditBalance.js')).default;
        await ExternalCreditBalance2.refundCredits(req.wallet, creditCost);
        // Return 200 (not 500) — the plugin handled the request, just didn't find results.
        // HTTP 500 would tell the gateway the agent is broken, which isn't true.
        return res.json({
          success: false,
          error: result?.error || 'Plugin execution failed',
          credited: true,
          creditsRefunded: creditCost
        });
      }

      // If the result used a fallback source (e.g. CoinGecko instead of Chainlink), refund
      let actualCharge = creditCost;
      if (result?.data?.source && result.data.source !== plugin) {
        try {
          const ExternalCreditBalanceRefund = (await import('../../../models/ExternalCreditBalance.js')).default;
          await ExternalCreditBalanceRefund.refundCredits(req.wallet, creditCost);
          actualCharge = 0;
        } catch {}
      }

      // Get remaining credits
      let creditsRemaining = 0;
      try {
        const ExternalCreditBalance = (await import('../../../models/ExternalCreditBalance.js')).default;
        const account = await ExternalCreditBalance.findByWallet(req.wallet);
        creditsRemaining = account?.credits || 0;
      } catch {}

      // For plugins that produce files, swap internal paths for a download token URL
      // before serialization (the sanitizer would otherwise redact the path).
      if (FILE_PRODUCING_PLUGINS.has(plugin)) {
        attachDownloadUrl(result, req.wallet);
      }

      // Send the response defensively — if serialization throws (e.g. circular ref
      // inside a plugin result), don't let it bubble into the outer catch and 500.
      try {
        res.json({
          ...result,
          creditsCharged: actualCharge,
          creditsRefunded: actualCharge === 0 ? creditCost : 0,
          creditsRemaining
        });
      } catch (serializeErr) {
        logger.error(`Failed to serialize ${plugin}:${action} response: ${serializeErr.message}`);
        if (!res.headersSent) {
          res.json({
            success: false,
            error: 'Plugin returned a non-serializable response',
            creditsCharged: actualCharge,
            creditsRefunded: actualCharge === 0 ? creditCost : 0,
            creditsRemaining
          });
        }
      }
    } catch (error) {
      // If we already sent the response (e.g. plugin succeeded but a post-send
      // hook threw), don't try to send 500 — the client already has valid data.
      if (res.headersSent) {
        logger.error(`External plugin ${plugin}:${action} post-send error: ${error.message}`);
        return;
      }
      // Refund on error
      try {
        const ExternalCreditBalance3 = (await import('../../../models/ExternalCreditBalance.js')).default;
        await ExternalCreditBalance3.refundCredits(req.wallet, creditCost);
      } catch {}
      logger.error(`External plugin ${plugin}:${action} failed:`, error);
      res.status(500).json({
        success: false,
        error: error.message,
        credited: true,
        creditsRefunded: creditCost
      });
    }
  }
);

// List available plugin services
router.get('/', async (req, res) => {
  const apiManager = req.app.locals.agent?.apiManager;
  const services = [];

  for (const plugin of ALLOWED_PLUGINS) {
    const entry = apiManager?.apis?.get(plugin);
    if (!entry) continue;
    // Skip disabled plugins (missing API keys, failed init, etc.)
    if (entry.enabled === false) continue;
    const instance = entry.instance || entry;
    if (!instance?.commands) continue;

    // Skip plugins missing required credentials
    const creds = instance.credentials || [];
    const hasRequiredCreds = creds.filter(c => c.required).every(c => {
      const val = instance.config?.[c.key] || process.env[c.envVar];
      return val && val.length > 0;
    });
    if (creds.some(c => c.required) && !hasRequiredCreds) continue;

    const commands = instance.commands
      .filter(cmd => {
        const name = cmd.command || cmd.name;
        if (BLOCKED_ACTIONS.has(name)) return false;
        if (cmd.offerAsService === false) return false;
        return true;
      })
      .map(cmd => ({
        action: cmd.command || cmd.name,
        description: cmd.description,
        usage: cmd.usage
      }));

    if (commands.length > 0) {
      services.push({
        plugin,
        creditCost: PLUGIN_CREDIT_COSTS[plugin] || 3,
        commands
      });
    }
  }

  res.json({ success: true, services, totalCommands: services.reduce((n, s) => n + s.commands.length, 0) });
});

export const USAGE_WINDOW_DAYS = 30;
export const TREND_WINDOW_DAYS = 7;

/**
 * Where the numbers come from.
 *
 * ExternalAuditLog is the only place a per-plugin call is recorded. It gets one
 * row per external request from auditLogMiddleware, carrying `path`, `method`,
 * `timestamp` and `success`, and it is the source used here.
 *
 * ExternalCreditBalance — the obvious-looking candidate — cannot answer this
 * question at all. It is one document per wallet, not a transaction collection;
 * its debits live in a 500-entry embedded `transactions` array that is $slice'd
 * on every write; and `debitCredits()` is called from the proxy route below with
 * no options, so `category` stays 'general', `tags` stays empty and the plugin
 * name is never written down anywhere on the debit. No query over that model can
 * produce per-plugin usage.
 *
 * The plugin name is recovered from the request path. The proxy route is
 * POST /api/external/service/:plugin/:action, so splitting the path on '/' puts
 * the plugin at index 4.
 *
 * Retention bounds the answer: ExternalAuditLog rows carry a 90-day TTL, so a
 * 30-day window is always fully covered, but nothing older can ever be asked
 * for.
 */
export function buildPluginUsagePipeline(now = new Date()) {
  const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const trendSince = new Date(now.getTime() - TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return {
    since,
    trendSince,
    pipeline: [
      {
        $match: {
          timestamp: { $gte: since },
          method: 'POST',
          path: { $regex: '^/api/external/service/' }
        }
      },
      {
        // Drop any query string before splitting, or '?foo=1' rides along on the
        // last segment.
        $addFields: {
          _plugin: {
            $arrayElemAt: [
              { $split: [{ $arrayElemAt: [{ $split: ['$path', '?'] }, 0] }, '/'] },
              4
            ]
          }
        }
      },
      { $match: { _plugin: { $nin: [null, ''] } } },
      {
        $facet: {
          popularPlugins: [
            {
              $group: {
                _id: '$_plugin',
                calls: { $sum: 1 },
                succeeded: { $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] } }
              }
            },
            { $sort: { calls: -1, _id: 1 } },
            { $limit: 10 },
            { $project: { _id: 0, plugin: '$_id', calls: 1, succeeded: 1 } }
          ],
          usageTrends: [
            { $match: { timestamp: { $gte: trendSince } } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'UTC' } },
                calls: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, date: '$_id', calls: 1 } }
          ],
          peakUsageTimes: [
            {
              $group: {
                _id: { $hour: { date: '$timestamp', timezone: 'UTC' } },
                calls: { $sum: 1 }
              }
            },
            { $sort: { calls: -1, _id: 1 } },
            { $limit: 5 },
            { $project: { _id: 0, hourUtc: '$_id', calls: 1 } }
          ],
          totals: [{ $count: 'calls' }]
        }
      }
    ]
  };
}

/**
 * Turn the $facet result into the response body.
 *
 * `sampleSize` is what makes an empty answer readable: three empty arrays could
 * mean "nobody called a plugin this month" or "the query is wrong", and only the
 * number of rows the aggregation actually matched tells them apart.
 */
export function shapePluginUsage(facetResult, { since, trendSince, now }) {
  const facet = (Array.isArray(facetResult) ? facetResult[0] : facetResult) || {};
  return {
    popularPlugins: facet.popularPlugins || [],
    usageTrends: facet.usageTrends || [],
    peakUsageTimes: facet.peakUsageTimes || [],
    meta: {
      source: 'ExternalAuditLog',
      generatedAt: now.toISOString(),
      windowDays: USAGE_WINDOW_DAYS,
      since: since.toISOString(),
      trendWindowDays: TREND_WINDOW_DAYS,
      trendSince: trendSince.toISOString(),
      timezone: 'UTC',
      retentionDays: 90,
      sampleSize: facet.totals?.[0]?.calls || 0
    }
  };
}

/**
 * Plugin usage analytics across every customer.
 * GET /api/external/service/analytics   (admin key required)
 *
 * Aggregate, cross-tenant figures — which plugins are being called, how often,
 * and when — are operator data, not customer data. adminKeyAuth, not creditAuth:
 * a customer `lsk_` key must not be able to read the whole service's demand
 * profile.
 */
router.get('/analytics', adminKeyAuth, async (req, res) => {
  try {
    const now = new Date();
    const { since, trendSince, pipeline } = buildPluginUsagePipeline(now);
    const facetResult = await ExternalAuditLog.aggregate(pipeline);

    res.json({
      success: true,
      data: shapePluginUsage(facetResult, { since, trendSince, now })
    });
  } catch (error) {
    logger.error(`GET /service/analytics error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to build plugin usage analytics' });
  }
});

export default router;
