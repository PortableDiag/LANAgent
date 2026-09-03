import mongoose from 'mongoose';

/**
 * Records external-gateway YouTube download requests so agents can retrieve
 * their download history. Purely additive telemetry — writes are best-effort
 * and never block or fail a download (see the recording call sites).
 */
const youtubeDownloadSchema = new mongoose.Schema({
  // The external agent (wallet/api-key identity) that requested the download.
  agentId: { type: String, required: true, index: true },
  url: { type: String, required: true },
  format: { type: String, enum: ['mp3', 'mp4'], default: 'mp4' },
  quality: { type: String, default: 'best' },
  title: { type: String, default: '' },
  filename: { type: String, default: '' },
  fileSize: { type: Number, default: 0 },
  status: { type: String, enum: ['completed', 'failed'], required: true, index: true },
  error: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true }
});

// Common query: an agent's most-recent downloads.
youtubeDownloadSchema.index({ agentId: 1, createdAt: -1 });

/**
 * Paginated download history for one agent, newest first.
 * @param {string} agentId
 * @param {number} page - 1-indexed page
 * @param {number} limit
 * @returns {Promise<{items: Array, total: number, page: number, limit: number, totalPages: number}>}
 */
youtubeDownloadSchema.statics.getHistory = async function(agentId, page = 1, limit = 20) {
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const skip = (p - 1) * l;

  const [items, total] = await Promise.all([
    this.find({ agentId }).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
    this.countDocuments({ agentId })
  ]);

  return { items, total, page: p, limit: l, totalPages: Math.ceil(total / l) };
};

/**
 * Get download statistics aggregated by format, quality, and status for an agent.
 * @param {string} agentId
 * @returns {Promise<Object>}
 */
youtubeDownloadSchema.statics.getDownloadStats = async function(agentId) {
  const stats = await this.aggregate([
    { $match: { agentId } },
    {
      $group: {
        _id: {
          format: '$format',
          quality: '$quality',
          status: '$status'
        },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.format',
        qualities: {
          $push: {
            quality: '$_id.quality',
            status: '$_id.status',
            count: '$count'
          }
        }
      }
    },
    {
      $project: {
        _id: 0,
        format: '$_id',
        qualities: 1
      }
    }
  ]);

  // Transform to a more structured format
  const result = {};
  stats.forEach(item => {
    result[item.format] = {};
    item.qualities.forEach(q => {
      if (!result[item.format][q.quality]) {
        result[item.format][q.quality] = {};
      }
      result[item.format][q.quality][q.status] = q.count;
    });
  });

  return result;
};

/**
 * Get an agent's most-repeated completed downloads.
 * Scoped per agent — a global version would leak other tenants' URLs/titles.
 * @param {string} agentId
 * @param {number} limit
 * @returns {Promise<Array>}
 */
youtubeDownloadSchema.statics.getPopularDownloads = async function(agentId, limit = 10) {
  const popular = await this.aggregate([
    { $match: { agentId, status: 'completed' } },
    {
      $group: {
        _id: {
          url: '$url',
          title: '$title',
          format: '$format',
          quality: '$quality'
        },
        count: { $sum: 1 },
        lastDownloadedAt: { $max: '$createdAt' }
      }
    },
    { $sort: { count: -1 } },
    { $limit: Math.max(1, parseInt(limit) || 10) },
    {
      $project: {
        _id: 0,
        url: '$_id.url',
        title: '$_id.title',
        format: '$_id.format',
        quality: '$_id.quality',
        count: 1,
        lastDownloadedAt: 1
      }
    }
  ]);

  return popular;
};

export const YoutubeDownload = mongoose.model('YoutubeDownload', youtubeDownloadSchema);
export default YoutubeDownload;
