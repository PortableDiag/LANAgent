#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import { PluginDevelopment } from '../src/models/PluginDevelopment.js';

async function updateAzureCognitiveStatus() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Update Microsoft Azure Cognitive Services to postponed
    const result = await PluginDevelopment.findOneAndUpdate(
      { api: 'Microsoft Azure Cognitive Services', status: 'in_progress' },
      { 
        status: 'postponed',
        error: 'Development postponed - requires further evaluation'
      },
      { new: true }
    );

    if (result) {
      console.log('✅ Updated Microsoft Azure Cognitive Services status to postponed');
      console.log(`   Created: ${result.createdAt}`);
      console.log(`   Status: ${result.status}`);
    } else {
      console.log('❌ Microsoft Azure Cognitive Services not found or already updated');
    }

    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

updateAzureCognitiveStatus();