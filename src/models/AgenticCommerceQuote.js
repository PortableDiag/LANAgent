import mongoose from 'mongoose';

/**
 * A client's job parameters, stored when it asks for a quote and matched to its on-chain job
 * by the hash in the job description (`<serviceType>:<paramsHash>`). The chain carries only the
 * hash; the agent never pays gas to create a job, the client creates and funds it.
 */
const agenticCommerceQuoteSchema = new mongoose.Schema({
    paramsHash: { type: String, required: true, unique: true },
    serviceType: { type: String, required: true },
    serviceParams: { type: Object, default: {} },
    clientAddress: { type: String, default: '' },
    status: {
        type: String,
        enum: ['pending', 'matched', 'expired', 'cancelled'],
        default: 'pending'
    },
    matchedAt: { type: Date },
    matchedJobId: { type: String },
    createdAt: { type: Date, default: Date.now, expires: 48 * 3600 }
});

/**
 * Atomically match a quote by its paramsHash, setting status to 'matched' and recording the jobId.
 * Only succeeds if the quote is currently 'pending' and not expired.
 * @param {string} paramsHash - The unique hash of the quote parameters.
 * @param {string} jobId - The on-chain job identifier that matched this quote.
 * @returns {Promise<Object>} The updated quote document.
 * @throws {Error} If no pending quote is found or it is already matched/expired.
 */
agenticCommerceQuoteSchema.statics.matchQuote = async function (paramsHash, jobId) {
    const now = new Date();
    const expiryCutoff = new Date(now.getTime() - 48 * 3600 * 1000); // 48 hours ago

    if (!paramsHash || typeof paramsHash !== 'string') {
        throw new Error('paramsHash is required');
    }
    // The job description can carry the hash in either case; quotes are stored as
    // produced by keccak256 (lowercase). Mirror the service lookup, which tries both.
    const hashes = [...new Set([paramsHash.toLowerCase(), paramsHash])];

    const updated = await this.findOneAndUpdate(
        {
            paramsHash: { $in: hashes },
            // Quotes written before `status` existed have no field — treat as pending.
            status: { $in: ['pending', null] },
            createdAt: { $gt: expiryCutoff } // not expired
        },
        {
            $set: {
                status: 'matched',
                matchedAt: now,
                matchedJobId: jobId
            }
        },
        { new: true }
    );

    if (!updated) {
        throw new Error(`No pending quote found for paramsHash ${paramsHash} or it has expired.`);
    }

    return updated;
};

/**
 * Cancel this quote, setting its status to 'cancelled'.
 * @returns {Promise<Object>} The saved document.
 */
agenticCommerceQuoteSchema.methods.cancel = async function () {
    this.status = 'cancelled';
    return this.save();
};

/**
 * Check if the quote has expired based on its createdAt timestamp and the 48-hour TTL.
 * @returns {boolean} True if the quote is older than 48 hours.
 */
agenticCommerceQuoteSchema.methods.isExpired = function () {
    if (!this.createdAt) return false;
    const now = new Date();
    const ageMs = now.getTime() - new Date(this.createdAt).getTime();
    const ttlMs = 48 * 3600 * 1000;
    return ageMs > ttlMs;
};

export default mongoose.model('AgenticCommerceQuote', agenticCommerceQuoteSchema);
