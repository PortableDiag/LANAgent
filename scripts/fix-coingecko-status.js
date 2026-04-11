#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import { PluginDevelopment } from '../src/models/PluginDevelopment.js';

async function fixCoinGeckoStatus() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Update CoinGecko to completed with PR URL
    const result = await PluginDevelopment.findOneAndUpdate(
      { api: 'CoinGecko' },
      { 
        status: 'completed',
        prUrl: 'https://github.com/PortableDiag/LANAgent/pull/488',
        error: null,
        completedAt: new Date()
      },
      { new: true }
    );

    if (result) {
      console.log('✅ Updated CoinGecko status to completed with PR URL');
    } else {
      console.log('❌ CoinGecko not found in database');
    }

    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

fixCoinGeckoStatus();