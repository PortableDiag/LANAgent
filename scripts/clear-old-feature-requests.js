#!/usr/bin/env node

import mongoose from 'mongoose';
import { FeatureRequest } from '../src/models/FeatureRequest.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

async function clearOldFeatureRequests() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Get start of today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Count feature requests before deletion
    const totalBefore = await FeatureRequest.countDocuments();
    const oldCount = await FeatureRequest.countDocuments({
      submittedAt: { $lt: today }
    });

    console.log(`Total feature requests: ${totalBefore}`);
    console.log(`Feature requests before today: ${oldCount}`);

    if (oldCount > 0) {
      // Delete all feature requests from before today
      const result = await FeatureRequest.deleteMany({
        submittedAt: { $lt: today }
      });
      console.log(`Deleted ${result.deletedCount} feature requests from before ${today.toDateString()}`);
    } else {
      console.log('No old feature requests to delete');
    }

    // Count remaining
    const remaining = await FeatureRequest.countDocuments();
    console.log(`Remaining feature requests: ${remaining}`);

    process.exit(0);
  } catch (error) {
    console.error('Error clearing old feature requests:', error);
    process.exit(1);
  }
}

// Run the cleanup
clearOldFeatureRequests();