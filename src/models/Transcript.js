import mongoose from 'mongoose';

/**
 * Verbatim chat history, one document per message.
 *
 * Kept apart from Memory on purpose: Memory holds curated, learnable knowledge and once
 * filled with 13K verbatim messages when conversations were stored there. Transcripts are
 * the raw record — searchable ("what did we say about X last week?"), used to restore the
 * follow-up buffer after a restart, and expired automatically after TRANSCRIPT_RETENTION_DAYS.
 */
const RETENTION_DAYS = Number(process.env.TRANSCRIPT_RETENTION_DAYS) || 180;

const transcriptSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  interface: { type: String, default: 'unknown' },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

transcriptSchema.index({ userId: 1, createdAt: -1 });
transcriptSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 });
transcriptSchema.index({ content: 'text' });

export const Transcript = mongoose.model('Transcript', transcriptSchema);
export default Transcript;
