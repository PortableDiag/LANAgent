import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const deviceGroupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  pluginName: {
    type: String,
    required: true,
    default: 'govee'
  },
  devices: [{
    deviceId: String,
    deviceName: String
  }],
  description: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Add compound index for optimized queries
deviceGroupSchema.index({ name: 1, pluginName: 1 });
deviceGroupSchema.index({ 'devices.deviceId': 1, pluginName: 1 });

// Initialize cache
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Update timestamp on save
deviceGroupSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Read-only diagnostic: find devices that belong to more than one group within
 * a plugin. Reporting ONLY — deliberately NOT wired into save validation, since
 * a device legitimately belonging to multiple groups (e.g. "LivingRoom" and
 * "AllLights") is a supported configuration; blocking it would break existing
 * groups. Lets an admin surface overlaps without changing write behaviour.
 * @param {string} pluginName
 * @returns {Promise<Array<{deviceId:string, count:number, groups:string[]}>>}
 */
deviceGroupSchema.statics.detectConflicts = async function(pluginName) {
  try {
    const pipeline = [
      { $match: { pluginName } },
      { $unwind: '$devices' },
      { $group: { _id: '$devices.deviceId', count: { $sum: 1 }, groups: { $push: '$name' } } },
      { $match: { count: { $gt: 1 } } }
    ];
    const result = await retryOperation(() => this.aggregate(pipeline));
    return result.map(item => ({ deviceId: item._id, count: item.count, groups: item.groups }));
  } catch (error) {
    logger.error('Device group conflict detection failed', { pluginName, error: error.message });
    throw error;
  }
};

// Static method to find group by name (case-insensitive) with caching
deviceGroupSchema.statics.findByName = async function(name, pluginName = 'govee') {
  const cacheKey = `findByName:${name}:${pluginName}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }
  const result = await retryOperation(() => this.findOne({
    name: { $regex: new RegExp(`^${name}$`, 'i') },
    pluginName
  }));
  cache.set(cacheKey, result);
  return result;
};

// Static method to find groups containing a device with caching
deviceGroupSchema.statics.findByDevice = async function(deviceId, pluginName = 'govee') {
  const cacheKey = `findByDevice:${deviceId}:${pluginName}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }
  const result = await retryOperation(() => this.find({
    'devices.deviceId': deviceId,
    pluginName
  }));
  cache.set(cacheKey, result);
  return result;
};

// Static method to aggregate device groups with caching
deviceGroupSchema.statics.aggregateDeviceGroups = async function(pipeline) {
  const cacheKey = `aggregateDeviceGroups:${JSON.stringify(pipeline)}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }
  const result = await retryOperation(() => this.aggregate(pipeline));
  cache.set(cacheKey, result);
  return result;
};

/**
 * Bulk create device groups
 * @param {Array} groupsData - Array of device group data
 * @returns {Promise<Array>} - Created device groups
 */
deviceGroupSchema.statics.bulkCreate = async function(groupsData) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const createdGroups = await this.insertMany(groupsData, { session });
    await session.commitTransaction();
    return createdGroups;
  } catch (error) {
    await session.abortTransaction();
    logger.error('Bulk create failed', error);
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Bulk update device groups
 * @param {Array} groupsData - Array of device group data with _id
 * @returns {Promise<Array>} - Updated device groups
 */
deviceGroupSchema.statics.bulkUpdate = async function(groupsData) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const updatePromises = groupsData.map(group =>
      this.updateOne({ _id: group._id }, group, { session })
    );
    await Promise.all(updatePromises);
    await session.commitTransaction();
    return groupsData;
  } catch (error) {
    await session.abortTransaction();
    logger.error('Bulk update failed', error);
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Bulk delete device groups
 * @param {Array} groupIds - Array of device group IDs
 * @returns {Promise<Number>} - Number of deleted groups
 */
deviceGroupSchema.statics.bulkDelete = async function(groupIds) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await this.deleteMany({ _id: { $in: groupIds } }, { session });
    await session.commitTransaction();
    return result.deletedCount;
  } catch (error) {
    await session.abortTransaction();
    logger.error('Bulk delete failed', error);
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Validate if a device belongs to a specific group
 * @param {string} groupId - The ID of the group to check
 * @param {string} deviceId - The ID of the device to validate
 * @param {string} pluginName - The name of the plugin
 * @returns {Promise<boolean>} - Whether the device belongs to the group
 */
deviceGroupSchema.statics.validateDeviceMembership = async function(groupId, deviceId, pluginName = 'govee') {
  try {
    const group = await retryOperation(() => this.findOne({
      _id: groupId,
      pluginName,
      'devices.deviceId': deviceId
    }));
    return !!group;
  } catch (error) {
    logger.error('Device group membership validation failed', { groupId, deviceId, pluginName, error: error.message });
    throw error;
  }
};

export const DeviceGroup = mongoose.model('DeviceGroup', deviceGroupSchema);
