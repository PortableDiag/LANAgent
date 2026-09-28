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
    createdAt: { type: Date, default: Date.now, expires: 48 * 3600 }
});

export default mongoose.model('AgenticCommerceQuote', agenticCommerceQuoteSchema);
