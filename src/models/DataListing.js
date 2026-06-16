import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

const dataListingSchema = new mongoose.Schema({
  listingId: { type: String, required: true, unique: true, index: true },
  sellerFingerprint: { type: String, required: true },
  title: { type: String, required: true, maxlength: 200 },
  description: { type: String, default: '', maxlength: 2000 },
  category: { type: String, default: 'general' },
  dataType: { type: String, enum: ['dataset', 'model', 'prompts', 'config', 'cache', 'other'], default: 'other' },
  price: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'SKYNET' },
  size: { type: Number, default: 0 },
  samplePreview: { type: String, default: '' },
  status: { type: String, enum: ['active', 'sold', 'expired', 'cancelled'], default: 'active' },
  purchases: { type: Number, default: 0 },
  totalRevenue: { type: Number, default: 0 },
  isLocal: { type: Boolean, default: false },
  expiresAt: { type: Date, default: null }
}, { timestamps: true });

// Existing indexes
dataListingSchema.index({ status: 1 });
dataListingSchema.index({ category: 1 });
dataListingSchema.index({ sellerFingerprint: 1 });

/**
 * TTL index for automatic document expiration
 * Documents will be automatically removed when expiresAt date is reached
 * Only affects documents where expiresAt is set (not null)
 */
dataListingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

/**
 * Compound index for efficient expiring listings queries
 */
dataListingSchema.index({ status: 1, expiresAt: 1 });

/**
 * Default expiration period in days for active listings
 */
const DEFAULT_EXPIRATION_DAYS = 30;

/**
 * Pre-save middleware to set default expiration for active listings
 * Sets expiresAt to 30 days from now if not already set and status is active
 */
dataListingSchema.pre('save', function(next) {
  // Only set default expiration for new active listings without an expiresAt
  if (this.isNew && this.status === 'active' && !this.expiresAt) {
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + DEFAULT_EXPIRATION_DAYS);
    this.expiresAt = expirationDate;
    logger.debug(`Setting default expiration for listing ${this.listingId}: ${this.expiresAt.toISOString()}`);
  }
  
  // If status changes to non-active, clear expiration (except for expired status)
  if (!this.isNew && this.isModified('status')) {
    if (this.status === 'sold' || this.status === 'cancelled') {
      // Clear TTL expiration for sold/cancelled listings - they should be kept for records
      this.expiresAt = null;
      logger.debug(`Clearing expiration for ${this.status} listing ${this.listingId}`);
    } else if (this.status === 'expired' && !this.expiresAt) {
      // Set immediate expiration for manually expired listings
      this.expiresAt = new Date();
      logger.debug(`Setting immediate expiration for expired listing ${this.listingId}`);
    }
  }
  
  next();
});

/**
 * Post-remove hook for cleanup notifications
 * Logs removal and can be extended for notification systems
 */
dataListingSchema.post('remove', function(doc) {
  logger.info(`Listing removed: ${doc.listingId} (${doc.title}) - Status: ${doc.status}`);
  
  // Emit event for cleanup notifications (can be consumed by notification services)
  if (doc.status === 'active' || doc.status === 'expired') {
    logger.info(`Cleanup notification: Listing ${doc.listingId} owned by ${doc.sellerFingerprint} has been removed`);
  }
});

/**
 * Post-findOneAndDelete hook for cleanup notifications
 * Handles deletions via findOneAndDelete
 */
dataListingSchema.post('findOneAndDelete', function(doc) {
  if (doc) {
    logger.info(`Listing deleted: ${doc.listingId} (${doc.title}) - Status: ${doc.status}`);
    
    if (doc.status === 'active' || doc.status === 'expired') {
      logger.info(`Cleanup notification: Listing ${doc.listingId} owned by ${doc.sellerFingerprint} has been deleted`);
    }
  }
});

/**
 * Post-deleteOne hook for cleanup notifications (document middleware)
 */
dataListingSchema.post('deleteOne', { document: true, query: false }, function(doc) {
  logger.info(`Listing deleteOne: ${doc.listingId} (${doc.title}) - Status: ${doc.status}`);
});

dataListingSchema.statics.getActiveListings = function () {
  return this.find({ status: 'active' }).sort({ createdAt: -1 });
};

dataListingSchema.statics.getMyListings = function () {
  return this.find({ isLocal: true }).sort({ createdAt: -1 });
};

/**
 * Extend the expiration date of a listing by a specified number of days
 * @param {string} listingId - The unique identifier of the listing
 * @param {number} days - Number of days to extend the expiration (must be positive)
 * @returns {Promise<Object|null>} The updated listing document or null if not found
 * @throws {Error} If days is not a positive number
 */
dataListingSchema.statics.extendExpiration = async function(listingId, days) {
  if (typeof days !== 'number' || days <= 0) {
    throw new Error('Days must be a positive number');
  }
  
  const listing = await this.findOne({ listingId });
  
  if (!listing) {
    logger.warn(`extendExpiration: Listing not found: ${listingId}`);
    return null;
  }
  
  // Only allow extending active listings
  if (listing.status !== 'active') {
    logger.warn(`extendExpiration: Cannot extend non-active listing ${listingId} (status: ${listing.status})`);
    throw new Error(`Cannot extend expiration for listing with status: ${listing.status}`);
  }
  
  // Calculate new expiration date
  const currentExpiration = listing.expiresAt || new Date();
  const newExpiration = new Date(currentExpiration);
  newExpiration.setDate(newExpiration.getDate() + days);
  
  listing.expiresAt = newExpiration;
  await listing.save();
  
  logger.info(`Extended expiration for listing ${listingId} by ${days} days. New expiration: ${newExpiration.toISOString()}`);
  
  return listing;
};

/**
 * Get listings that are expiring within a specified number of days
 * @param {number} withinDays - Number of days to look ahead for expiring listings
 * @returns {Promise<Array>} Array of listings expiring within the specified period
 * @throws {Error} If withinDays is not a positive number
 */
dataListingSchema.statics.getExpiringListings = async function(withinDays) {
  if (typeof withinDays !== 'number' || withinDays <= 0) {
    throw new Error('withinDays must be a positive number');
  }
  
  const now = new Date();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + withinDays);
  
  const expiringListings = await this.find({
    status: 'active',
    expiresAt: {
      $gte: now,
      $lte: futureDate
    }
  }).sort({ expiresAt: 1 });
  
  logger.debug(`Found ${expiringListings.length} listings expiring within ${withinDays} days`);
  
  return expiringListings;
};

/**
 * Get all expired listings that haven't been cleaned up yet
 * Useful for manual cleanup or reporting
 * @returns {Promise<Array>} Array of expired listings
 */
dataListingSchema.statics.getExpiredListings = async function() {
  const now = new Date();
  
  const expiredListings = await this.find({
    status: 'active',
    expiresAt: { $lt: now }
  }).sort({ expiresAt: 1 });
  
  logger.debug(`Found ${expiredListings.length} expired listings pending cleanup`);
  
  return expiredListings;
};

/**
 * Mark expired listings as expired status
 * This is useful for manual expiration processing before TTL cleanup
 * @returns {Promise<Object>} Result with count of updated listings
 */
dataListingSchema.statics.markExpiredListings = async function() {
  const now = new Date();
  
  const result = await this.updateMany(
    {
      status: 'active',
      expiresAt: { $lt: now }
    },
    {
      $set: { status: 'expired' }
    }
  );
  
  if (result.modifiedCount > 0) {
    logger.info(`Marked ${result.modifiedCount} listings as expired`);
  }
  
  return {
    modifiedCount: result.modifiedCount,
    matchedCount: result.matchedCount
  };
};

/**
 * Refresh expiration for a listing (reset to default expiration period from now)
 * @param {string} listingId - The unique identifier of the listing
 * @returns {Promise<Object|null>} The updated listing document or null if not found
 */
dataListingSchema.statics.refreshExpiration = async function(listingId) {
  const listing = await this.findOne({ listingId });
  
  if (!listing) {
    logger.warn(`refreshExpiration: Listing not found: ${listingId}`);
    return null;
  }
  
  if (listing.status !== 'active') {
    logger.warn(`refreshExpiration: Cannot refresh non-active listing ${listingId} (status: ${listing.status})`);
    throw new Error(`Cannot refresh expiration for listing with status: ${listing.status}`);
  }
  
  const newExpiration = new Date();
  newExpiration.setDate(newExpiration.getDate() + DEFAULT_EXPIRATION_DAYS);
  
  listing.expiresAt = newExpiration;
  await listing.save();
  
  logger.info(`Refreshed expiration for listing ${listingId}. New expiration: ${newExpiration.toISOString()}`);
  
  return listing;
};

const DataListing = mongoose.model('DataListing', dataListingSchema);
export default DataListing;
