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

export const YoutubeDownload = mongoose.model('YoutubeDownload', youtubeDownloadSchema);
export default YoutubeDownload;
