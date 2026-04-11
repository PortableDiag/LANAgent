import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

const emailCache = new NodeCache({ stdTTL: 600 });

const emailSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  uid: Number,
  type: {
    type: String,
    enum: ['sent', 'received'],
    required: true
  },
  from: {
    type: String,
    required: true
  },
  to: String,
  cc: String,
  bcc: String,
  subject: {
    type: String,
    default: '(No subject)'
  },
  text: String,
  html: String,
  preview: {
    type: String,
    maxlength: 200
  },
  read: {
    type: Boolean,
    default: false
  },
  processed: {
    type: Boolean,
    default: false
  },
  processedAt: Date,
  processedBy: String,
  attachments: [{
    filename: String,
    contentType: String,
    size: Number
  }],
  flags: [String],
  inReplyTo: String,
  references: [String],
  threadId: String,
  conversationId: String,
  sentDate: {
    type: Date,
    required: true
  }
}, {
  timestamps: true
});

emailSchema.index({ sentDate: -1 });
emailSchema.index({ type: 1, processed: 1 });
emailSchema.index({ from: 1 });
emailSchema.index({ to: 1 });
emailSchema.index({ conversationId: 1, sentDate: 1 });

emailSchema.methods.markAsProcessed = async function(processedBy = 'manual') {
  this.processed = true;
  this.processedAt = new Date();
  this.processedBy = processedBy;
  try {
    await retryOperation(() => this.save(), { retries: 3 });
    logger.info(`Email ${this.messageId} marked as processed by ${processedBy}`);
  } catch (error) {
    logger.error(`Failed to mark email ${this.messageId} as processed:`, error);
    throw new Error('Failed to mark email as processed');
  }
};

emailSchema.methods.markAsRead = async function() {
  this.read = true;
  try {
    await retryOperation(() => this.save(), { retries: 3 });
    logger.info(`Email ${this.messageId} marked as read`);
  } catch (error) {
    logger.error(`Failed to mark email ${this.messageId} as read:`, error);
    throw new Error('Failed to mark email as read');
  }
};

/**
 * Batch process emails to mark them as read or processed.
 * @param {Array<String>} emailIds - Array of email message IDs to process.
 * @param {Object} options - Options for processing.
 * @param {Boolean} options.markAsRead - Whether to mark emails as read.
 * @param {Boolean} options.markAsProcessed - Whether to mark emails as processed.
 * @param {String} options.processedBy - Who processed the emails.
 * @returns {Promise<Object>} - Result of the batch operation.
 */
emailSchema.statics.batchProcessEmails = async function(emailIds, { markAsRead = false, markAsProcessed = false, processedBy = 'auto' }) {
  const bulkOps = emailIds.map(id => {
    const update = {};
    if (markAsRead) update.read = true;
    if (markAsProcessed) {
      update.processed = true;
      update.processedAt = new Date();
      update.processedBy = processedBy;
    }
    return {
      updateOne: {
        filter: { messageId: id },
        update: { $set: update }
      }
    };
  });

  try {
    const result = await retryOperation(() => this.bulkWrite(bulkOps), { retries: 3 });
    logger.info(`Batch processed ${emailIds.length} emails`);
    return result;
  } catch (error) {
    logger.error('Failed to batch process emails:', error);
    throw new Error('Batch processing failed');
  }
};

emailSchema.statics.getEmailsByConversation = async function(conversationId) {
  try {
    const cachedEmails = emailCache.get(conversationId);
    if (cachedEmails) {
      logger.info(`Cache hit for conversationId ${conversationId}`);
      return cachedEmails;
    }
    const emails = await this.find({ conversationId }).sort({ sentDate: 1 });
    emailCache.set(conversationId, emails);
    return emails;
  } catch (error) {
    logger.error(`Error fetching emails for conversationId ${conversationId}:`, error);
    throw new Error('Failed to fetch emails by conversation');
  }
};

emailSchema.statics.getUnprocessedCount = async function() {
  try {
    return await retryOperation(() => this.countDocuments({ processed: false }), { retries: 3 });
  } catch (error) {
    logger.error('Failed to get unprocessed email count:', error);
    throw new Error('Failed to get unprocessed email count');
  }
};

emailSchema.statics.getTodayStats = async function() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  try {
    const sentToday = await retryOperation(() => this.countDocuments({
      type: 'sent',
      sentDate: { $gte: startOfDay }
    }), { retries: 3 });

    const receivedToday = await retryOperation(() => this.countDocuments({
      type: 'received',
      sentDate: { $gte: startOfDay }
    }), { retries: 3 });

    return { sentToday, receivedToday };
  } catch (error) {
    logger.error('Failed to get today\'s email stats:', error);
    throw new Error('Failed to get today\'s email stats');
  }
};

emailSchema.statics.findByMessageId = async function(messageId) {
  try {
    return await retryOperation(() => this.findOne({ messageId }), { retries: 3 });
  } catch (error) {
    logger.error(`Failed to find email by messageId ${messageId}:`, error);
    throw new Error('Failed to find email by messageId');
  }
};

export const Email = mongoose.model('Email', emailSchema);