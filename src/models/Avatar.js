import mongoose from 'mongoose';

const AvatarSchema = new mongoose.Schema({
  avatarId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  owner: {
    type: String,
    index: true
  },
  name: {
    type: String,
    default: ''
  },
  agentName: {
    type: String,
    index: true
  },
  agentId: {
    type: Number,
    default: 0
  },
  nftTokenId: {
    type: Number,
    default: null,
    index: true
  },
  nftTxHash: String,
  baseModelPath: String,
  bakedModelPath: String,
  thumbnailPath: String,
  ipfsCIDs: {
    model: String,
    thumbnail: String,
    metadata: String,
    customizations: String
  },
  customizations: {
    body: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    face: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    outfit: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    accessories: {
      type: [String],
      default: []
    },
    effects: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    expression: {
      type: String,
      default: 'neutral'
    }
  },
  unlockedItems: [{
    _id: false,
    itemId: String,
    unlockedAt: {
      type: Date,
      default: Date.now
    },
    achievement: String
  }],
  sourceType: {
    type: String,
    enum: ['photo', 'prompt', 'template']
  },
  sourceHash: String,
  polyCount: Number,
  hasRig: {
    type: Boolean,
    default: false
  },
  hasMorphTargets: {
    type: Boolean,
    default: false
  },
  format: {
    type: String,
    default: 'glb'
  },
  version: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

AvatarSchema.index({ owner: 1, createdAt: -1 });
AvatarSchema.index({ agentName: 1, createdAt: -1 });
AvatarSchema.index({ nftTokenId: 1 });

AvatarSchema.statics.getByOwner = function (owner) {
  return this.find({ owner }).sort({ createdAt: -1 });
};

AvatarSchema.statics.getByAgent = function (agentName) {
  return this.find({ agentName }).sort({ createdAt: -1 });
};

AvatarSchema.statics.getGallery = function (limit = 20) {
  return this.find().sort({ createdAt: -1 }).limit(limit);
};

export const Avatar = mongoose.model('Avatar', AvatarSchema);
