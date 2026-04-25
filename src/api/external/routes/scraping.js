import { Router } from 'express';
import { hybridAuth } from '../middleware/hybridAuth.js';
import { creditAuth } from '../middleware/creditAuth.js';
import { logger } from '../../../utils/logger.js';
import { retryOperation, isRetryableError } from '../../../utils/retryUtils.js';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import NodeCache from 'node-cache';

const router = Router();
const scrapeCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Credit costs per tier
const TIER_COSTS = {
  basic: 1,
  stealth: 2,
  full: 3,
  render: 5
};

/**
 * Health check endpoint to verify service availability.
 */
router.get('/health', (req, res) => {
  res.json({ success: true, message: 'Service is healthy' });
});

/**
 * Execute a single scrape operation
 */
async function executeScrape(req, { url, selectors, extractType = 'text', userAgent, usePuppeteer = false }) {
  const scraperEntry = req.app.locals.agent?.apiManager?.apis?.get('scraper');
  const scraper = scraperEntry?.instance || scraperEntry;
  if (!scraper?.execute) {
    return { success: false, error: 'Scraping service not available', targetError: true };
  }

  const action = extractType === 'structured' ? 'extract' : 'scrape';
  const options = { bypassCache: true };
  if (userAgent) options.userAgent = userAgent;
  if (selectors) options.selector = selectors;
  if (usePuppeteer) options.usePuppeteer = true;

  // Check cache
  const cacheKey = `${action}:${url}:${JSON.stringify(selectors || '')}`;
  const cached = scrapeCache.get(cacheKey);
  if (cached) return cached;

  let result;
  try {
    let rawResult;
    let cheerioError = null;

    // Try cheerio first (fast)
    try {
      rawResult = await scraper.execute({ action, url, options });
    } catch (err) {
      cheerioError = err.message || String(err);
      rawResult = { success: false, error: cheerioError };
    }

    // Detect Cloudflare/bot challenge pages that return 200 but aren't real content
    const challengeTitles = ['Just a moment', 'Checking your browser', 'Attention Required', 'Access denied', 'Please Wait'];
    const gotChallengePage = rawResult.success && rawResult.content?.title &&
      challengeTitles.some(t => rawResult.content.title.includes(t));

    // If cheerio failed, got blocked, or got a challenge page, auto-retry with Puppeteer
    const shouldRetryWithPuppeteer = !options.usePuppeteer && (
      !rawResult.success ||
      !rawResult.content?.title ||
      gotChallengePage
    );

    if (shouldRetryWithPuppeteer) {
      const errMsg = rawResult.error || cheerioError || (gotChallengePage ? 'Cloudflare challenge page' : '');
      const isBlocked = gotChallengePage || errMsg.includes('403') || errMsg.includes('406') || errMsg.includes('503')
        || errMsg.includes('Forbidden') || errMsg.includes('blocked') || errMsg.includes('Failed to scrape');

      if (isBlocked) {
        logger.info(`[ExternalScrape] Cheerio failed for ${url} (${errMsg.slice(0, 60)}), retrying with Puppeteer...`);
        try {
          rawResult = await scraper.execute({ action, url, options: { ...options, usePuppeteer: true } });
          if (rawResult.success) {
            logger.info(`[ExternalScrape] Puppeteer succeeded for ${url}`);
          }
        } catch (puppeteerErr) {
          logger.warn(`[ExternalScrape] Puppeteer also failed for ${url}: ${puppeteerErr.message}`);
          // Keep the original cheerio error
          rawResult = { success: false, error: cheerioError || puppeteerErr.message };
        }
      }
    }

    // Quality-based escalation: if result looks suspicious, retry with Puppeteer
    if (rawResult.success && !options.usePuppeteer && rawResult.content) {
      const title = rawResult.content.title || '';
      const ogImage = rawResult.content.ogImage || '';
      const images = rawResult.content.images || [];

      // Detect polluted title (contains repeated logo/brand text patterns)
      const titleLooksCorrupted = /(.{3,})\1{2,}/.test(title) || // same text repeated 3+ times
        (title.length > 200); // unreasonably long title

      // Detect tracking pixel as primary image
      const adPatterns = [/ads\.rmbl\.ws/i, /doubleclick\.net/i, /googlesyndication/i, /\/t\?a=/i, /\/pixel\?/i, /\/beacon\?/i];
      const ogImageIsTracker = ogImage && adPatterns.some(p => p.test(ogImage));
      const onlyAdImages = images.length > 0 && images.length <= 3 &&
        images.every(img => adPatterns.some(p => p.test(img.src)));

      const qualityIsSuspicious = titleLooksCorrupted || ogImageIsTracker || onlyAdImages;

      if (qualityIsSuspicious) {
        logger.info(`[ExternalScrape] Suspicious quality for ${url} (title_corrupted=${titleLooksCorrupted}, og_tracker=${ogImageIsTracker}, only_ads=${onlyAdImages}), retrying with Puppeteer...`);
        try {
          const retryResult = await scraper.execute({ action, url, options: { ...options, usePuppeteer: true } });
          if (retryResult.success) {
            logger.info(`[ExternalScrape] Quality escalation to Puppeteer succeeded for ${url}`);
            rawResult = retryResult;
          }
        } catch (err) {
          logger.warn(`[ExternalScrape] Quality escalation Puppeteer failed for ${url}: ${err.message}`);
          // Keep the original result — it's better than nothing
        }
      }
    }

    // Force-sanitize: rebuild result from scratch using only primitive/plain values
    result = {
      success: !!rawResult.success,
      url: rawResult.url || url,
      content: rawResult.content ? {
        title: String(rawResult.content.title || ''),
        description: String(rawResult.content.description || ''),
        ogImage: String(rawResult.content.ogImage || ''),
        text: String(rawResult.content.text || ''),
        links: (rawResult.content.links || []).map(l => ({ href: String(l.href || ''), text: String(l.text || '') })),
        images: (rawResult.content.images || []).map(i => ({ src: String(i.src || ''), alt: String(i.alt || '') })),
        jsonld: rawResult.content.jsonld || [],
        microdata: rawResult.content.microdata || []
      } : null,
      method: String(rawResult.method || 'unknown'),
      error: rawResult.error ? String(rawResult.error) : undefined
    };
  } catch (err) {
    const msg = typeof err?.message === 'string' ? err.message : 'Scraping failed';
    // Don't propagate circular error messages — clean them up
    const cleanMsg = msg.includes('circular') ? 'Scraping service internal error' : msg;
    return { success: false, error: cleanMsg, targetError: true };
  }

  if (!result || !result.success) {
    return { success: false, error: result?.error || 'Scraping failed', targetError: true };
  }

  // Filter images: remove ad/tracker pixels
  let filteredImages = result.content?.images || [];
  let ogImage = result.content?.ogImage || '';
  if (scraper.filterImages) {
    filteredImages = scraper.filterImages(filteredImages);
  }
  // Validate og:image and find best image
  let bestImage = '';
  if (scraper.getBestImage) {
    try {
      bestImage = await scraper.getBestImage(ogImage, result.content?.images || []);
    } catch { bestImage = ogImage; }
  } else {
    bestImage = ogImage;
  }

  // Return only serializable fields (avoid leaking axios internals)
  const response = {
    success: true,
    url: result.url || url,
    data: {
      title: result.content?.title || '',
      description: result.content?.description || '',
      ogImage: bestImage,
      text: result.content?.text || '',
      links: result.content?.links || [],
      images: filteredImages,
      structuredData: result.content?.jsonld || [],
      microdata: result.content?.microdata || []
    },
    method: result.method
  };

  // Capture raw HTML for full/render tiers
  try {
    const axios = (await import('axios')).default;
    const htmlRes = await axios.get(url, { timeout: 15000, maxContentLength: 5 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    if (typeof htmlRes.data === 'string') {
      response._rawHtml = htmlRes.data;
    }
  } catch { /* HTML fetch optional, don't fail */ }

  // Capture screenshot for render tier via separate screenshot action
  if (usePuppeteer && scraper.execute) {
    try {
      const ssResult = await scraper.execute({ action: 'screenshot', url, options: { fullPage: false } });
      if (ssResult.success && ssResult.screenshot) {
        response._screenshot = ssResult.screenshot;
      }
    } catch { /* screenshot optional, don't fail the scrape */ }
  }

  // Final safety: ensure response is serializable before returning
  try {
    JSON.stringify(response);
  } catch {
    // Strip any remaining circular refs
    const safe = {
      success: !!response.success,
      url: String(response.url || url),
      data: response.data || null,
      method: String(response.method || 'unknown'),
      _rawHtml: typeof response._rawHtml === 'string' ? response._rawHtml : undefined,
      _screenshot: typeof response._screenshot === 'string' ? response._screenshot : undefined
    };
    scrapeCache.set(cacheKey, safe);
    return safe;
  }

  scrapeCache.set(cacheKey, response);
  return response;
}

/**
 * POST /api/external/scrape
 * Single URL scrape — supports both credit and legacy payment
 * Tier: basic (1 credit), stealth (2 credits, forces Puppeteer), full (3 credits, +HTML), render (5 credits, +HTML+screenshot)
 */
router.post('/',
  creditAuth(false), // Try credit auth but don't block legacy
  async (req, res) => {
    const { url, tier = 'basic', selectors, extractType = 'text', userAgent } = req.body;
    const creditCost = TIER_COSTS[tier] || TIER_COSTS.basic;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'url required' });
    }
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, error: 'url must start with http:// or https://' });
    }

    // Credit-based payment
    if (req.wallet) {
      const account = await ExternalCreditBalance.findByWallet(req.wallet);
      if (!account || account.credits < creditCost) {
        return res.status(402).json({ success: false, error: 'Insufficient credits', required: creditCost, balance: account?.credits || 0, tier });
      }
      await ExternalCreditBalance.debitCredits(req.wallet, creditCost);

      try {
        const usePuppeteer = tier === 'render' || tier === 'stealth';
        const result = await executeScrape(req, { url, selectors, extractType, userAgent, usePuppeteer });

        if (!result.success) {
          // Refund on target failure
          await ExternalCreditBalance.refundCredits(req.wallet, creditCost);
          const acc = await ExternalCreditBalance.findByWallet(req.wallet);
          return res.status(500).json({ ...result, credited: true, creditsRefunded: creditCost, creditsRemaining: acc?.credits || 0 });
        }

        // Add HTML for full/render tiers
        if ((tier === 'full' || tier === 'render') && result._rawHtml) {
          result.data.html = result._rawHtml;
        }
        // Add screenshot for render tier
        if (tier === 'render' && result._screenshot) {
          result.data.screenshot = result._screenshot;
        }
        delete result._rawHtml;
        delete result._screenshot;

        const acc = await ExternalCreditBalance.findByWallet(req.wallet);
        result.creditsRemaining = acc?.credits || 0;
        result.tier = tier;
        result.creditsCharged = creditCost;
        return res.json(result);
      } catch (error) {
        await ExternalCreditBalance.refundCredits(req.wallet, creditCost);
        const acc = await ExternalCreditBalance.findByWallet(req.wallet);
        logger.error('Scraping failed:', error.message);
        return res.status(500).json({ success: false, error: 'Scraping failed', targetError: true, credited: true, creditsRefunded: creditCost, creditsRemaining: acc?.credits || 0 });
      }
    }

    // Legacy payment fallback
    const { externalAuthMiddleware } = await import('../middleware/externalAuth.js');
    const { paymentMiddleware } = await import('../middleware/payment.js');
    externalAuthMiddleware(req, res, (err) => {
      if (err) return res.status(401).json({ success: false, error: err.message });
      paymentMiddleware('web-scraping')(req, res, async () => {
        try {
          const result = await executeScrape(req, { url, selectors, extractType, userAgent });
          if (!result.success) return res.status(500).json(result);
          res.json(result);
        } catch (error) {
          logger.error('Scraping failed:', error.message);
          res.status(500).json({ success: false, error: 'Scraping failed', targetError: true });
        }
      });
    });
  }
);

/**
 * POST /api/external/scrape/batch
 * Batch URL scrape — credit auth required (no legacy payment for batch)
 */
router.post('/batch',
  creditAuth(true),
  async (req, res) => {
    const { urls, tier = 'basic', selectors, extractType = 'text', userAgent } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ success: false, error: 'urls array is required' });
    }

    if (urls.length > 100) {
      return res.status(400).json({ success: false, error: 'Maximum 100 URLs per batch' });
    }

    const creditCost = TIER_COSTS[tier] || TIER_COSTS.basic;
    const totalCost = creditCost * urls.length;

    // Check and reserve all credits upfront
    const account = await ExternalCreditBalance.findByWallet(req.wallet);
    if (!account || account.credits < totalCost) {
      return res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        required: totalCost,
        balance: account?.credits || 0,
        perUrl: creditCost,
        urlCount: urls.length
      });
    }

    // Debit all credits upfront
    const debited = await ExternalCreditBalance.debitCredits(req.wallet, totalCost);
    if (!debited) {
      return res.status(402).json({
        success: false,
        error: 'Insufficient credits (race condition)',
        required: totalCost
      });
    }

    // Validate URLs
    const validUrls = urls.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
    const invalidCount = urls.length - validUrls.length;

    // Execute scrapes
    const results = [];
    let successCount = 0;
    let failCount = 0;
    let refundTotal = 0;

    // Process in batches of 10 for controlled concurrency
    const CONCURRENCY = 10;
    for (let i = 0; i < validUrls.length; i += CONCURRENCY) {
      const batch = validUrls.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(url => executeScrape(req, { url, selectors, extractType, userAgent }))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const url = batch[j];
        const result = batchResults[j];

        if (result.status === 'fulfilled' && result.value.success) {
          successCount++;
          results.push({ url, success: true, data: result.value, credited: false });
        } else {
          failCount++;
          refundTotal += creditCost;
          const error = result.status === 'rejected'
            ? result.reason?.message || 'Scrape failed'
            : result.value?.error || 'Scrape failed';
          results.push({ url, success: false, error, credited: true });
        }
      }
    }

    // Refund credits for failed scrapes
    if (refundTotal > 0) {
      await ExternalCreditBalance.refundCredits(req.wallet, refundTotal);
    }

    // Also refund for invalid URLs (they were never attempted but credits were reserved)
    if (invalidCount > 0) {
      const invalidRefund = invalidCount * creditCost;
      await ExternalCreditBalance.refundCredits(req.wallet, invalidRefund);
      refundTotal += invalidRefund;
    }

    const updatedAccount = await ExternalCreditBalance.findByWallet(req.wallet);

    res.json({
      success: true,
      results,
      totalUrls: urls.length,
      successful: successCount,
      failed: failCount + invalidCount,
      creditsCharged: totalCost - refundTotal,
      creditsRefunded: refundTotal,
      remainingCredits: updatedAccount?.credits || 0
    });
  }
);

export default router;
