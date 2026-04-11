import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

/**
 * ScanProgress Caching Helper
 *
 * Provides caching layer for frequently accessed ScanProgress queries
 * to reduce database load during incremental scans.
 *
 * Uses node-cache with configurable TTL and automatic expiration.
 */

// Initialize cache with 30-second TTL (scan operations are time-sensitive)
const scanCache = new NodeCache({
    stdTTL: 30,
    checkperiod: 10,
    useClones: false
});

// Cache statistics
let stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    invalidations: 0
};

/**
 * Build cache key for count queries
 */
function buildCountKey(sessionScanId, status = null) {
    return status
        ? `count:${sessionScanId}:${status}`
        : `count:${sessionScanId}:all`;
}

/**
 * Build cache key for pending entries query
 */
function buildPendingKey(sessionScanId) {
    return `pending:${sessionScanId}`;
}

/**
 * Get cached count or fetch from database
 *
 * @param {Model} ScanProgress - Mongoose model
 * @param {string} sessionScanId - Scan session ID
 * @param {string|null} status - Optional status filter
 * @returns {Promise<number>} - Count of documents
 */
export async function getCachedCount(ScanProgress, sessionScanId, status = null) {
    const cacheKey = buildCountKey(sessionScanId, status);

    // Check cache first
    const cached = scanCache.get(cacheKey);
    if (cached !== undefined) {
        stats.hits++;
        logger.debug(`ScanProgress cache HIT: ${cacheKey} = ${cached}`);
        return cached;
    }

    stats.misses++;

    // Build query
    const query = { sessionScanId };
    if (status) {
        query.status = status;
    }

    // Fetch from database
    const count = await retryOperation(() => ScanProgress.countDocuments(query));

    // Cache the result
    scanCache.set(cacheKey, count);
    stats.sets++;
    logger.debug(`ScanProgress cache SET: ${cacheKey} = ${count}`);

    return count;
}

/**
 * Get cached pending entries or fetch from database
 *
 * @param {Model} ScanProgress - Mongoose model
 * @param {string} sessionScanId - Scan session ID
 * @returns {Promise<Array>} - Array of pending scan entries
 */
export async function getCachedPendingEntries(ScanProgress, sessionScanId) {
    const cacheKey = buildPendingKey(sessionScanId);

    // Check cache first
    const cached = scanCache.get(cacheKey);
    if (cached !== undefined) {
        stats.hits++;
        logger.debug(`ScanProgress cache HIT: ${cacheKey} (${cached.length} entries)`);
        return cached;
    }

    stats.misses++;

    // Fetch from database
    const entries = await retryOperation(() => ScanProgress.find({
        sessionScanId,
        status: 'pending'
    }).sort({ fileSize: 1 }));

    // Cache the result
    scanCache.set(cacheKey, entries);
    stats.sets++;
    logger.debug(`ScanProgress cache SET: ${cacheKey} (${entries.length} entries)`);

    return entries;
}

/**
 * Invalidate cache entries for a session when documents are updated
 *
 * @param {string} sessionScanId - Scan session ID
 */
export function invalidateSessionCache(sessionScanId) {
    // Build all possible keys for this session
    const keysToDelete = [
        buildCountKey(sessionScanId, null),
        buildCountKey(sessionScanId, 'pending'),
        buildCountKey(sessionScanId, 'processing'),
        buildCountKey(sessionScanId, 'completed'),
        buildCountKey(sessionScanId, 'failed'),
        buildPendingKey(sessionScanId)
    ];

    // Batch delete keys
    const deletedCount = scanCache.del(keysToDelete);

    if (deletedCount > 0) {
        stats.invalidations += deletedCount;
        logger.debug(`ScanProgress cache INVALIDATED: ${deletedCount} keys for session ${sessionScanId}`);
    }
}

/**
 * Wrapper for updateOne that invalidates cache
 *
 * @param {Model} ScanProgress - Mongoose model
 * @param {Object} filter - Query filter
 * @param {Object} update - Update object
 * @returns {Promise<UpdateResult>} - Update result
 */
export async function updateOneWithCacheInvalidation(ScanProgress, filter, update) {
    const result = await retryOperation(() => ScanProgress.updateOne(filter, update));

    // Invalidate cache if we know the sessionScanId
    if (filter.sessionScanId) {
        invalidateSessionCache(filter.sessionScanId);
    }

    return result;
}

/**
 * Get cache statistics
 *
 * @returns {Object} - Cache statistics
 */
export function getCacheStats() {
    const cacheStats = scanCache.getStats();
    return {
        ...stats,
        keys: scanCache.keys().length,
        nodeCache: cacheStats,
        hitRate: stats.hits + stats.misses > 0
            ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) + '%'
            : 'N/A'
    };
}

/**
 * Clear all cache entries
 */
export function clearCache() {
    scanCache.flushAll();
    stats = { hits: 0, misses: 0, sets: 0, invalidations: 0 };
    logger.info('ScanProgress cache cleared');
}

/**
 * Set custom TTL for cache entries
 *
 * @param {number} ttl - TTL in seconds
 */
export function setTTL(ttl) {
    scanCache.options.stdTTL = ttl;
    logger.info(`ScanProgress cache TTL set to ${ttl} seconds`);
}

export default {
    getCachedCount,
    getCachedPendingEntries,
    invalidateSessionCache,
    updateOneWithCacheInvalidation,
    getCacheStats,
    clearCache,
    setTTL
};
