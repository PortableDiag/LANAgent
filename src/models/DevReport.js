import mongoose from 'mongoose';

/**
 * A bug or limitation the owner reported for the developer ("log a bug: …"), from a call, a voice
 * note or a chat. Kept here first so a report survives Trellis being unreachable; services/devReports.js
 * mirrors each one to the "Dev Inbox" basket in Trellis, where the developer reads it.
 */
const devReportSchema = new mongoose.Schema({
  text: { type: String, required: true },
  interface: { type: String, default: 'unknown' },
  userId: { type: String },
  callId: { type: String },
  conversation: [{ _id: false, role: String, text: String, at: Date }],
  errors: [String],
  version: String,
  model: String,
  status: { type: String, enum: ['open', 'fixed', 'wontfix'], default: 'open' },
  fixedIn: String,
  trellisCard: { type: String },
  syncedAt: Date,
  syncError: String,
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false, suppressReservedKeysWarning: true });

devReportSchema.index({ createdAt: -1 });
devReportSchema.index({ syncedAt: 1 }, { partialFilterExpression: { syncedAt: null } });

export const DevReport = mongoose.models.DevReport || mongoose.model('DevReport', devReportSchema);
export default DevReport;
