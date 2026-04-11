import mongoose from 'mongoose';

const dailyPnLSchema = new mongoose.Schema({
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD
    realizedPnL: { type: Number, default: 0 },
    gasCost: { type: Number, default: 0 },
    dailyNet: { type: Number, default: 0 },    // realizedPnL - gasCost
    cumulativePnL: { type: Number, default: 0 },
    buyCount: { type: Number, default: 0 },
    sellCount: { type: Number, default: 0 },
    buyVolume: { type: Number, default: 0 },
    sellVolume: { type: Number, default: 0 },
    source: { type: String, enum: ['live', 'backfill'], default: 'live' }
}, { timestamps: true });

dailyPnLSchema.index({ date: 1 });

export default mongoose.model('DailyPnL', dailyPnLSchema);
