import mongoose from 'mongoose';

const sambaMountSchema = new mongoose.Schema({
  mountId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  server: {
    type: String,
    required: true
  },
  share: {
    type: String,
    required: true
  },
  mountPoint: {
    type: String,
    required: true
  },
  username: {
    type: String,
    required: true
  },
  domain: String,
  options: [String],
  // Security note: In production, these should be encrypted
  password: {
    type: String,
    select: false // Don't return by default
  },
  // Mount status (not persisted, updated at runtime)
  mounted: {
    type: Boolean,
    default: false
  },
  lastMountedAt: Date,
  lastError: String
}, {
  timestamps: true
});

// Index for fast lookups
sambaMountSchema.index({ server: 1, share: 1 });

export const SambaMount = mongoose.model('SambaMount', sambaMountSchema);