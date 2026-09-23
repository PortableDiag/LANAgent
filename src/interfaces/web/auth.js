import jwt from 'jsonwebtoken';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';
import apiKeyService from '../../services/apiKeyService.js';
import { scopesSatisfy } from '../../models/ApiKey.js';

// Cache for JWT secret after first successful retrieval
let cachedJWTSecret = null;

// In-memory cache for revoked tokens (TTL matches max token lifetime of 24h)
const revokedTokensCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Define role hierarchy for RBAC
const ROLE_HIERARCHY = {
  admin: ['user', 'moderator'],
  moderator: ['user'],
  user: []
};

/**
 * JWT secret key for token signing and verification
 * Requires secure JWT_SECRET environment variable in production
 * Uses lazy loading to avoid early environment variable access
 * @returns {string}
 */
function getJWTSecret() {
  // Return cached secret if already retrieved
  if (cachedJWTSecret) {
    return cachedJWTSecret;
  }
  
  const secret = process.env.JWT_SECRET;
  
  if (!secret) {
    logger.error('JWT_SECRET environment variable is required for security');
    logger.error('Make sure PM2 is started with ecosystem.config.cjs');
    throw new Error('JWT_SECRET environment variable must be set');
  }
  
  // Validate secret strength (minimum 32 characters)
  if (secret.length < 32) {
    logger.error('JWT_SECRET must be at least 32 characters long');
    throw new Error('JWT_SECRET must be at least 32 characters for security');
  }
  
  // Warn if using default insecure value
  if (secret === 'lanagent-secret-key-change-in-production') {
    logger.error('Using default JWT_SECRET is insecure - change immediately!');
    throw new Error('Default JWT_SECRET detected - must use secure secret in production');
  }
  
  // Cache the secret for future calls
  cachedJWTSecret = secret;
  logger.debug('JWT_SECRET successfully loaded and cached');
  
  return cachedJWTSecret;
}

/**
 * Generate a JWT token with the provided payload
 * 
 * @param {Object} payload - Data to be encoded in the token
 * @param {string} [payload.userId] - User identifier
 * @param {string} [payload.role] - User role
 * @param {Array<string>} [payload.permissions] - Array of permissions
 * @returns {string} Signed JWT token valid for 24 hours
 * @example
 * const token = generateToken({ userId: '12345', role: 'admin', permissions: ['read', 'write'] });
 */
export function generateToken(payload) {
  return jwt.sign(payload, getJWTSecret(), {
    expiresIn: '24h'
  });
}

/**
 * Verify and decode a JWT token
 *
 * @param {string} token - JWT token to verify
 * @returns {Object} Decoded token payload if valid
 * @throws {Error} When token is invalid, expired, malformed, or revoked
 * @example
 * try {
 *   const decoded = verifyToken(userToken);
 *   logger.info('User ID:', decoded.userId);
 * } catch (error) {
 *   logger.error('Invalid token');
 * }
 */
export function verifyToken(token) {
  // Check if token has been revoked
  if (revokedTokensCache.has(token)) {
    throw new Error('Token has been revoked');
  }

  try {
    return jwt.verify(token, getJWTSecret());
  } catch (error) {
    throw new Error('Invalid token');
  }
}

/**
 * Revoke a JWT token to prevent further use
 *
 * Revoked tokens are stored in an in-memory cache with a TTL matching
 * the maximum token lifetime (24 hours). This ensures tokens cannot be
 * used after revocation while preventing unbounded memory growth.
 *
 * @param {string} token - JWT token to revoke
 * @returns {boolean} True if the token was successfully revoked
 * @throws {Error} When token is not provided
 * @example
 * // Revoke a user's token on logout
 * revokeToken(userToken);
 */
export function revokeToken(token) {
  if (!token) {
    throw new Error('Token is required for revocation');
  }

  revokedTokensCache.set(token, true);
  logger.info('Token revoked successfully');
  return true;
}

/**
 * Check if a token has been revoked
 *
 * @param {string} token - JWT token to check
 * @returns {boolean} True if the token has been revoked
 */
export function isTokenRevoked(token) {
  return revokedTokensCache.has(token);
}

/**
 * Express middleware for authenticating JWT tokens or API keys
 * 
 * Supports two authentication methods:
 * 1. JWT token in Authorization header (Bearer format)
 * 2. API key in X-API-Key header or Authorization header (ApiKey format)
 * 
 * Verifies the credential and attaches user/key data to req.user or req.apiKey.
 * Returns 401 if no credential provided, 403 if credential is invalid.
 * 
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object  
 * @param {import('express').NextFunction} next - Express next function
 * @returns {void}
 * 
 * @example
 * // Use as middleware on protected routes
 * router.get('/protected', authenticateToken, (req, res) => {
 *   if (req.apiKey) {
 *     logger.info('API key used:', req.apiKey.name);
 *   } else {
 *     logger.info('JWT user:', req.user);
 *   }
 *   res.json({ message: 'Access granted' });
 * });
 */
export async function authenticateToken(req, res, next) {
  // Check for API key first
  const apiKey = req.headers['x-api-key'] || 
    (req.headers.authorization && req.headers.authorization.startsWith('ApiKey ') 
      ? req.headers.authorization.substring(7) 
      : null);
  
  if (apiKey) {
    try {
      const keyInfo = await apiKeyService.validateApiKey(apiKey);
      if (keyInfo) {
        req.apiKey = keyInfo;
        req.authType = 'apikey';
        return next();
      }
    } catch (error) {
      logger.error('API key validation error:', error);
    }
  }
  
  // Check for JWT token
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') && authHeader.substring(7);

  if (!token && !apiKey) {
    return res.status(401).json({ 
      success: false, 
      error: 'Authentication required' 
    });
  }

  if (token) {
    try {
      const decoded = verifyToken(token);
      req.user = decoded;
      req.authType = 'jwt';
      next();
    } catch (error) {
      logger.info('JWT authentication failed: Invalid or expired token');
      return res.status(403).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      });
    }
  } else {
    // API key was provided but invalid
    return res.status(403).json({
      success: false,
      error: 'Invalid API key'
    });
  }
}

/**
 * Express middleware for checking if a user has a specific permission
 * 
 * This middleware should be used after authenticateToken to ensure
 * the user is authenticated and has the required permission.
 * 
 * @param {string} permission - The permission to check for
 * @returns {Function} Express middleware function
 * @example
 * router.get('/admin', authenticateToken, authorizePermission('admin'), (req, res) => {
 *   res.json({ message: 'Admin access granted' });
 * });
 */
export function authorizePermission(permission) {
  return (req, res, next) => {
    // API keys carry scopes, so check them rather than waving the request through.
    //
    // The generated version returned next() unconditionally here, on the grounds that
    // keys "have their own permissions system". They have the FIELD — `scopes` on the
    // ApiKey model, marked "for future use" — but nothing enforced it, so an
    // authorisation middleware would have been silently inert for an entire auth class.
    // A control that looks like it restricts access and does not is worse than no
    // control, because a route gets marked protected on the strength of it.
    //
    // Behaviour for existing keys is unchanged: normalizeScopes() turns an empty scope
    // list into ['*'], and '*' satisfies everything. Only a deliberately scoped key is
    // newly restricted.
    if (req.authType === 'apikey') {
      if (scopesSatisfy(req.apiKey?.scopes, permission)) {
        return next();
      }
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions'
      });
    }

    // For JWT tokens, check permissions
    if (req.authType === 'jwt' && req.user) {
      // Check direct permissions
      if (req.user.permissions && req.user.permissions.includes(permission)) {
        return next();
      }

      // Check role-based permissions
      if (req.user.role) {
        // Direct role match
        if (req.user.role === permission) {
          return next();
        }

        // Check role hierarchy
        if (ROLE_HIERARCHY[req.user.role] && ROLE_HIERARCHY[req.user.role].includes(permission)) {
          return next();
        }

        // Check if role inherits from another role that has the permission.
        // `seen` guards the recursion: ROLE_HIERARCHY is acyclic today, but a future
        // entry pointing back up (user: ['admin']) would otherwise recurse until the
        // stack blew — inside auth middleware, on every request.
        const checkInheritedRoles = (role, targetPermission, seen = new Set()) => {
          if (!ROLE_HIERARCHY[role] || seen.has(role)) return false;
          seen.add(role);

          if (ROLE_HIERARCHY[role].includes(targetPermission)) {
            return true;
          }

          return ROLE_HIERARCHY[role].some(childRole =>
            checkInheritedRoles(childRole, targetPermission, seen)
          );
        };

        if (checkInheritedRoles(req.user.role, permission)) {
          return next();
        }
      }
    }

    // If we get here, the user doesn't have the required permission
    return res.status(403).json({
      success: false,
      error: 'Insufficient permissions'
    });
  };
}

/**
 * Introspect a JWT token to retrieve its metadata and validity
 *
 * This function allows third-party services to verify tokens without
 * having direct access to the JWT secret. Unlike verifyToken, this
 * returns an object with validity status instead of throwing on failure.
 *
 * @param {string} token - JWT token to introspect
 * @returns {Object} Token metadata including validity status
 * @throws {Error} When token is not provided
 * @example
 * const tokenInfo = introspectToken(userToken);
 * if (tokenInfo.valid) {
 *   logger.info('Token is valid:', tokenInfo.payload);
 * } else {
 *   logger.warn('Token is invalid:', tokenInfo.error);
 * }
 */
export function introspectToken(token) {
  if (!token) {
    throw new Error('Token is required for introspection');
  }

  // Check if token has been revoked
  if (revokedTokensCache.has(token)) {
    return { valid: false, error: 'Token has been revoked' };
  }

  try {
    const payload = jwt.verify(token, getJWTSecret());
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}
