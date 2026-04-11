import { Router } from 'express';
import { creditAuth } from '../middleware/creditAuth.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

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

      res.json({
        ...result,
        creditsCharged: actualCharge,
        creditsRefunded: actualCharge === 0 ? creditCost : 0,
        creditsRemaining
      });
    } catch (error) {
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

export default router;
