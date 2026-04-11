#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import { PluginDevelopment } from '../src/models/PluginDevelopment.js';

async function cleanupDuplicates() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB\n');

    // Delete the older postponed Microsoft Azure Cognitive Services entry
    const result = await PluginDevelopment.deleteOne({ 
      _id: '695292de12a4b444b565cce0'  // The older postponed one
    });

    if (result.deletedCount > 0) {
      console.log('✅ Deleted duplicate Microsoft Azure Cognitive Services (postponed) entry');
    } else {
      console.log('❌ Could not find the duplicate entry to delete');
    }

    // Show current state
    console.log('\nCurrent Microsoft Azure Cognitive Services entries:');
    const remaining = await PluginDevelopment.find({ api: 'Microsoft Azure Cognitive Services' });
    remaining.forEach(record => {
      console.log(`- ${record.api}: ${record.status} (${new Date(record.createdAt).toLocaleDateString()})`);
    });

    await mongoose.connection.close();
    console.log('\n✅ Done');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

cleanupDuplicates();