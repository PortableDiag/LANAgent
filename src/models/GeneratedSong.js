import mongoose from 'mongoose';

const GeneratedSongSchema = new mongoose.Schema({
  prompt: {
    type: String,
    required: true
  },
  provider: {
    type: String,
    required: true,
    enum: ['suno', 'mubert', 'soundverse', 'huggingface']
  },
  title: {
    type: String,
    default: 'Untitled'
  },
  genre: String,
  mood: String,
  style: String,
  audioUrl: String,
  localPath: String,
  duration: Number,
  lyrics: String,
  instrumental: {
    type: Boolean,
    default: false
  },
  taskId: String,
  status: {
    type: String,
    enum: ['pending', 'generating', 'completed', 'failed', 'delivered'],
    default: 'pending'
  },
  deliveredVia: [{
    type: String,
    enum: ['telegram', 'email']
  }],
  error: String,
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  requestedBy: String,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  completedAt: Date
});

GeneratedSongSchema.index({ provider: 1, status: 1, createdAt: -1 });
GeneratedSongSchema.index({ taskId: 1 });

export const GeneratedSong = mongoose.model('GeneratedSong', GeneratedSongSchema);
