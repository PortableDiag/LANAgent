import crypto from 'crypto';
import fsGrav from 'fs';
import pathGrav from 'path';
import NodeCache from 'node-cache';
import { logger } from './logger.js';
import { safePromiseAll } from './errorHandlers.js';
import { retryOperation } from '../utils/retryUtils.js';

// Gravatar API configuration
const GRAVATAR_API_BASE = 'https://api.gravatar.com/v3';
const GRAVATAR_API_KEY = process.env.GRAVATAR_API_KEY;

// Initialize cache with a default TTL of 1 hour
const gravatarCache = new NodeCache({ stdTTL: 3600 });

/**
 * Generate email hash for Gravatar
 * @param {string} email - Email address
 * @returns {string} SHA256 hash of lowercase trimmed email
 */
export function getEmailHash(email) {
  return crypto
    .createHash('sha256')
    .update(email.toLowerCase().trim())
    .digest('hex');
}

/**
 * Generate Gravatar URL for an email address with rating support
 * @param {string} email - Email address
 * @param {number} size - Image size (1-2048)
 * @param {string} defaultImage - Default image type or URL
 * @param {string} rating - Rating level (G, PG, R, X)
 * @returns {string} Gravatar URL
 */
export function getGravatarUrl(email, size = 200, defaultImage = 'robohash', rating = 'G') {
  const hash = crypto
    .createHash('md5')
    .update(email.toLowerCase().trim())
    .digest('hex');
  
  const isUrl = /^https?:\/\//i.test(defaultImage);
  const defaultImageParam = isUrl ? encodeURIComponent(defaultImage) : defaultImage;
  
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=${defaultImageParam}&r=${rating}`;
}

/**
 * Generate Gravatar profile URL
 * @param {string} email - Email address
 * @returns {string} Gravatar profile URL
 */
export function getGravatarProfileUrl(email) {
  const hash = crypto
    .createHash('md5')
    .update(email.toLowerCase().trim())
    .digest('hex');
  
  return `https://www.gravatar.com/${hash}.json`;
}

/**
 * Add Gravatar headers to email
 * @param {Object} headers - Email headers object
 * @param {string} email - Sender email address
 * @param {string} rating - Rating level (G, PG, R, X)
 * @returns {Object} Updated headers
 */
export function addGravatarHeaders(headers = {}, email, rating = 'G', customAvatarUrl = null) {
  const avatarUrl = customAvatarUrl || getGravatarUrl(email, 80, 'robohash', rating);

  // Add avatar URL headers (some clients use these)
  headers['X-Avatar-URL'] = avatarUrl;
  headers['X-Gravatar'] = avatarUrl;

  // Some clients look for these
  headers['X-Face-URL'] = avatarUrl;
  headers['Face-URL'] = avatarUrl;

  return headers;
}

/**
 * New feature: Bulk processing capability for Gravatar URLs
 * @param {Array} emails - List of email addresses
 * @param {Object} options - Options for processing
 * @param {number} options.size - Image size (1-2048)
 * @param {string} options.defaultImage - Default image type or URL
 * @param {string} options.rating - Rating level (G, PG, R, X)
 * @returns {Array} List of Gravatar URLs
 */
export async function processBulkGravatarUrls(emails, options = {}) {
  const results = [];
  const size = options.size || 200;
  const defaultImage = options.defaultImage || 'robohash';
  const rating = options.rating || 'G';

  // getGravatarUrl is fully synchronous (md5 + string format) — no concurrency
  // limiter needed. A plain loop is faster and brings no extra deps.
  for (const email of emails) {
    try {
      results.push(getGravatarUrl(email, size, defaultImage, rating));
    } catch (error) {
      console.error(`Error processing email ${email}:`, error);
    }
  }

  return results;
}

/**
 * Fetch Gravatar profile data for an email address
 * Uses the REST API if an API key is configured, otherwise falls back gracefully
 * @param {string} email - Email address to look up
 * @returns {Object|null} Profile data or null if not found/error
 */
export async function fetchGravatarProfile(email) {
  if (!email) return null;

  const cacheKey = `profile_${getEmailHash(email)}`;
  const cachedProfile = gravatarCache.get(cacheKey);
  if (cachedProfile) {
    logger.debug(`Cache hit for Gravatar profile of ${email}`);
    return cachedProfile;
  }

  try {
    const hash = getEmailHash(email);
    const headers = {
      'Accept': 'application/json'
    };

    // Add API key if available for enhanced data
    if (GRAVATAR_API_KEY) {
      headers['Authorization'] = `Bearer ${GRAVATAR_API_KEY}`;
    }

    const response = await retryOperation(() => fetch(`${GRAVATAR_API_BASE}/profiles/${hash}`, {
      method: 'GET',
      headers,
      timeout: 5000
    }));

    if (!response.ok) {
      if (response.status === 404) {
        logger.debug(`No Gravatar profile found for ${email}`);
        return null;
      }
      throw new Error(`Gravatar API returned ${response.status}`);
    }

    const profile = await response.json();

    logger.debug(`Fetched Gravatar profile for ${email}:`, {
      hasDisplayName: !!profile.display_name,
      hasAvatar: !!profile.avatar_url,
      hasVerifiedAccounts: profile.verified_accounts?.length > 0
    });

    gravatarCache.set(cacheKey, profile);
    return profile;
  } catch (error) {
    // Graceful fallback - don't break the flow if Gravatar is unavailable
    logger.debug(`Gravatar profile fetch failed for ${email}: ${error.message}`);
    return null;
  }
}

/**
 * Enrich contact data with Gravatar profile information
 * @param {Object} contact - Contact object with email
 * @returns {Object} Enriched contact with Gravatar data
 */
export async function enrichContactWithGravatar(contact) {
  if (!contact?.email && !contact?.metadata?.email) {
    return contact;
  }

  const email = contact.email || contact.metadata?.email;
  const profile = await fetchGravatarProfile(email);

  if (!profile) {
    return contact;
  }

  // Build enriched data
  const gravatarData = {
    gravatarHash: getEmailHash(email),
    avatarUrl: profile.avatar_url || getGravatarUrl(email, 200, '404'),
    hasGravatar: !!profile.avatar_url
  };

  // Add profile details if available
  if (profile.display_name) {
    gravatarData.displayName = profile.display_name;
  }

  if (profile.profile_url) {
    gravatarData.profileUrl = profile.profile_url;
  }

  if (profile.location) {
    gravatarData.location = profile.location;
  }

  if (profile.description) {
    gravatarData.bio = profile.description;
  }

  if (profile.job_title) {
    gravatarData.jobTitle = profile.job_title;
  }

  if (profile.company) {
    gravatarData.company = profile.company;
  }

  // Add verified accounts (social links)
  if (profile.verified_accounts && profile.verified_accounts.length > 0) {
    gravatarData.verifiedAccounts = profile.verified_accounts.map(account => ({
      service: account.service_type,
      url: account.url,
      label: account.service_label
    }));
  }

  // Merge into contact
  if (contact.metadata) {
    contact.metadata.gravatar = gravatarData;
    // Use Gravatar display name if contact doesn't have a name
    if (!contact.metadata.name && gravatarData.displayName) {
      contact.metadata.name = gravatarData.displayName;
    }
  } else {
    contact.gravatar = gravatarData;
    if (!contact.name && gravatarData.displayName) {
      contact.name = gravatarData.displayName;
    }
  }

  return contact;
}

/**
 * Check if an email has a Gravatar avatar (not just default)
 * @param {string} email - Email address to check
 * @returns {boolean} True if email has a custom Gravatar avatar
 */
export async function hasGravatarAvatar(email) {
  const profile = await fetchGravatarProfile(email);
  return !!(profile?.avatar_url);
}

/**
 * Fetch Gravatar profiles in bulk
 * @param {Array} emails - List of email addresses
 * @returns {Array} List of profile data (nulls filtered out)
 */
export async function fetchBulkGravatarProfiles(emails) {
  const profiles = await safePromiseAll(emails.map(email => fetchGravatarProfile(email)));
  return profiles.filter(profile => profile !== null);
}

/**
 * Upload an avatar image to Gravatar via REST API v3
 * Requires GRAVATAR_API_KEY environment variable
 * @param {string} imagePath - Absolute path to image file
 * @param {string} [email] - Email to set avatar for (uses selected_email_hash query param)
 * @returns {Object} { success: boolean, imageId?: string, error?: string }
 */
export async function uploadAvatarToGravatar(imagePath, email = null) {
  // Prefer OAuth token (grants write access) over API key (read-only)
  const authToken = process.env.GRAVATAR_OAUTH_TOKEN || GRAVATAR_API_KEY;
  if (!authToken) {
    logger.warn('No Gravatar auth token or API key set, skipping upload');
    return { success: false, error: 'No auth token configured. Connect Gravatar via Settings > Agent Avatar.' };
  }

  try {
    if (!fsGrav.existsSync(imagePath)) {
      return { success: false, error: `Avatar file not found: ${imagePath}` };
    }

    let imageBuffer = fsGrav.readFileSync(imagePath);
    const ext = pathGrav.extname(imagePath).toLowerCase();
    const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    let mimeType = mimeTypes[ext] || 'image/png';
    const filename = pathGrav.basename(imagePath);

    // Gravatar requires square images — center-crop if needed
    try {
      const sharp = (await import('sharp')).default;
      const metadata = await sharp(imageBuffer).metadata();
      if (metadata.width !== metadata.height) {
        const size = Math.min(metadata.width, metadata.height);
        imageBuffer = await sharp(imageBuffer)
          .extract({
            left: Math.floor((metadata.width - size) / 2),
            top: Math.floor((metadata.height - size) / 2),
            width: size,
            height: size
          })
          .png()
          .toBuffer();
        mimeType = 'image/png';
        logger.info(`Cropped avatar from ${metadata.width}x${metadata.height} to ${size}x${size} for Gravatar`);
      }
    } catch (cropErr) {
      logger.warn('Could not auto-crop avatar, uploading as-is:', cropErr.message);
    }

    // Build multipart form data manually (no external dependency needed)
    const boundary = '----GravatarUpload' + Date.now();
    const parts = [];
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const headerBuf = Buffer.from(parts[0], 'utf-8');
    const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const body = Buffer.concat([headerBuf, imageBuffer, footerBuf]);

    // Build URL with query params for auto-selecting avatar
    const uploadUrl = new URL(`${GRAVATAR_API_BASE}/me/avatars`);
    uploadUrl.searchParams.set('select_avatar', 'true');
    if (email) {
      uploadUrl.searchParams.set('selected_email_hash', getEmailHash(email));
    }

    const uploadResponse = await fetch(uploadUrl.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      logger.error(`Gravatar upload failed (${uploadResponse.status}):`, errorText);
      return { success: false, error: `Upload failed: ${uploadResponse.status} - ${errorText}` };
    }

    const uploadResult = await uploadResponse.json();
    const imageId = uploadResult.image_id || uploadResult.id;
    logger.info(`Gravatar avatar uploaded and selected, imageId: ${imageId}`);

    return { success: true, imageId };
  } catch (error) {
    logger.error('Gravatar upload error:', error.message);
    return { success: false, error: error.message };
  }
}
