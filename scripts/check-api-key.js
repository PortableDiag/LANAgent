#!/usr/bin/env node

import { connectDatabase } from '../src/utils/database.js';
import ApiKey from '../src/models/ApiKey.js';
import crypto from 'crypto';
import { logger } from '../src/utils/logger.js';

async function checkApiKey() {
  try {
    await connectDatabase();
    
    const problemKey = '${LANAGENT_API_KEY:-your-api-key}';
    const keyHash = crypto.createHash('sha256').update(problemKey).digest('hex');
    const keyPrefix = problemKey.substring(0, 11) + '...';
    
    console.log('\nChecking for problematic API key:');
    console.log('Key:', problemKey);
    console.log('Prefix:', keyPrefix);
    console.log('Hash:', keyHash);
    
    // Check by hash
    const byHash = await ApiKey.findOne({ keyHash });
    if (byHash) {
      console.log('\nFound by hash:', {
        id: byHash._id,
        name: byHash.name,
        status: byHash.status,
        createdAt: byHash.createdAt
      });
    } else {
      console.log('\nNot found by hash');
    }
    
    // Check by prefix
    const byPrefix = await ApiKey.find({ keyPrefix });
    if (byPrefix.length > 0) {
      console.log('\nFound by prefix:', byPrefix.map(k => ({
        id: k._id,
        name: k.name,
        status: k.status,
        createdAt: k.createdAt
      })));
    } else {
      console.log('\nNot found by prefix');
    }
    
    // List all API keys
    const allKeys = await ApiKey.find({});
    console.log('\nTotal API keys in database:', allKeys.length);
    console.log('\nAll API keys:');
    allKeys.forEach(key => {
      console.log(`- ${key.name} (${key.keyPrefix}) - Status: ${key.status}, Created: ${key.createdAt}`);
    });
    
    // Check recent logs for this key
    console.log('\n\nSearching logs for references to this key...');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

checkApiKey();