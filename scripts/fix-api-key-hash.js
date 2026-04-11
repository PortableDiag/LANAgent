#!/usr/bin/env node

import { connectDatabase } from '../src/utils/database.js';
import ApiKey from '../src/models/ApiKey.js';
import crypto from 'crypto';
import { logger } from '../src/utils/logger.js';

async function fixApiKeyHash() {
  try {
    await connectDatabase();
    
    const problemKey = '${LANAGENT_API_KEY:-your-api-key}';
    const correctHash = crypto.createHash('sha256').update(problemKey).digest('hex');
    const keyPrefix = problemKey.substring(0, 11) + '...';
    
    console.log('\nFixing API key hash for Debug Key:');
    console.log('Key:', problemKey);
    console.log('Prefix:', keyPrefix);
    console.log('Correct Hash:', correctHash);
    
    // Find the key by prefix
    const apiKey = await ApiKey.findOne({ keyPrefix });
    
    if (!apiKey) {
      console.log('\nAPI key not found!');
      process.exit(1);
    }
    
    console.log('\nCurrent key info:');
    console.log('- Name:', apiKey.name);
    console.log('- Status:', apiKey.status);
    console.log('- Current Hash:', apiKey.keyHash);
    console.log('- Created:', apiKey.createdAt);
    
    // Update the hash
    apiKey.keyHash = correctHash;
    await apiKey.save();
    
    console.log('\nHash updated successfully!');
    
    // Verify the fix
    const updatedKey = await ApiKey.findOne({ keyHash: correctHash });
    if (updatedKey) {
      console.log('\nVerified: Key can now be found by the correct hash');
      console.log('The API key should now work with authentication');
    } else {
      console.log('\nWarning: Key still not found by hash after update');
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

fixApiKeyHash();