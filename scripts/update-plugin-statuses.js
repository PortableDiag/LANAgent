#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

// Import the model
import { PluginDevelopment } from '../src/models/PluginDevelopment.js';

async function updatePluginStatuses() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Update Microsoft Azure AI to postponed
    const azureResult = await PluginDevelopment.findOneAndUpdate(
      { api: 'Microsoft Azure AI' },
      { 
        status: 'postponed',
        error: 'Development postponed - requires further evaluation'
      },
      { new: true }
    );

    if (azureResult) {
      console.log('✅ Updated Microsoft Azure AI status to postponed');
    } else {
      console.log('❌ Microsoft Azure AI not found in database');
    }

    // Update OpenAI GPT3 to rejected
    const openaiResult = await PluginDevelopment.findOneAndUpdate(
      { api: 'OpenAI GPT3' },
      { 
        status: 'rejected',
        error: 'Plugin rejected - redundant with existing AI provider functionality'
      },
      { new: true }
    );

    if (openaiResult) {
      console.log('✅ Updated OpenAI GPT3 status to rejected');
    } else {
      console.log('❌ OpenAI GPT3 not found in database');
    }

    // List all plugin development records to verify
    console.log('\n📋 Current plugin development records:');
    const allRecords = await PluginDevelopment.find().sort({ createdAt: -1 });
    
    allRecords.forEach(record => {
      console.log(`- ${record.api}: ${record.status} (${new Date(record.createdAt).toLocaleDateString()})`);
    });

    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  } catch (error) {
    console.error('Error updating plugin statuses:', error);
    process.exit(1);
  }
}

updatePluginStatuses();