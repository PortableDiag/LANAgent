#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import { PluginDevelopment } from '../src/models/PluginDevelopment.js';

async function checkStatus() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB\n');

    // Get all records
    const allRecords = await PluginDevelopment.find().sort({ createdAt: -1 });
    console.log(`Total plugin development records: ${allRecords.length}\n`);

    // Find duplicates
    const apiCounts = {};
    allRecords.forEach(record => {
      apiCounts[record.api] = (apiCounts[record.api] || 0) + 1;
    });

    console.log('Duplicate APIs:');
    Object.entries(apiCounts).forEach(([api, count]) => {
      if (count > 1) {
        console.log(`- ${api}: ${count} entries`);
      }
    });

    // Show all Microsoft Azure Cognitive Services entries
    console.log('\nMicrosoft Azure Cognitive Services entries:');
    const azureCognitiveRecords = await PluginDevelopment.find({ api: 'Microsoft Azure Cognitive Services' }).sort({ createdAt: -1 });
    azureCognitiveRecords.forEach(record => {
      console.log(`- Created: ${record.createdAt}, Status: ${record.status}, ID: ${record._id}`);
    });

    // Show OpenAI GPT3
    console.log('\nOpenAI GPT3 entry:');
    const openaiRecord = await PluginDevelopment.findOne({ api: 'OpenAI GPT3' });
    if (openaiRecord) {
      console.log(`- Created: ${openaiRecord.createdAt}, Status: ${openaiRecord.status}`);
    } else {
      console.log('- Not found');
    }

    // Show last 20 records
    console.log('\nLast 20 plugin development records:');
    allRecords.slice(0, 20).forEach(record => {
      console.log(`- ${record.api}: ${record.status} (${new Date(record.createdAt).toLocaleDateString()})`);
    });

    await mongoose.connection.close();
    console.log('\n✅ Done');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkStatus();