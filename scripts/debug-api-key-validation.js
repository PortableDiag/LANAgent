#!/usr/bin/env node

import { connectDatabase } from '../src/utils/database.js';
import ApiKey from '../src/models/ApiKey.js';
import apiKeyService from '../src/services/apiKeyService.js';
import { logger } from '../src/utils/logger.js';

async function debugApiKeyValidation() {
  try {
    await connectDatabase();
    
    const testKey = '${LANAGENT_API_KEY:-your-api-key}';
    
    console.log('\n=== API Key Validation Debug ===');
    console.log('Testing key:', testKey);
    
    // First, let's validate using the service
    console.log('\n1. Testing via apiKeyService.validateApiKey():');
    const result1 = await apiKeyService.validateApiKey(testKey);
    console.log('Result:', result1 ? 'VALID' : 'INVALID');
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Try again
    console.log('\n2. Testing again after 1 second:');
    const result2 = await apiKeyService.validateApiKey(testKey);
    console.log('Result:', result2 ? 'VALID' : 'INVALID');
    
    // Check the key directly
    console.log('\n3. Checking key directly in database:');
    const keyHash = ApiKey.hashKey(testKey);
    const apiKey = await ApiKey.findOne({ keyHash });
    
    if (apiKey) {
      console.log('Found key:', apiKey.name);
      console.log('Status:', apiKey.status);
      console.log('ExpiresAt:', apiKey.expiresAt);
      console.log('ExpiresAt type:', typeof apiKey.expiresAt);
      console.log('ExpiresAt is null:', apiKey.expiresAt === null);
      console.log('ExpiresAt is undefined:', apiKey.expiresAt === undefined);
      
      // Test isValid method
      console.log('\n4. Testing isValid() method:');
      const isValid = apiKey.isValid();
      console.log('isValid():', isValid);
      
      // Check each condition
      console.log('\n5. Checking validity conditions:');
      console.log('Status is active:', apiKey.status === 'active');
      
      if (apiKey.expiresAt !== null && apiKey.expiresAt !== undefined) {
        const now = new Date();
        console.log('Current time:', now.toISOString());
        console.log('Expiry time:', apiKey.expiresAt.toISOString());
        console.log('Is expired:', apiKey.expiresAt < now);
      } else {
        console.log('No expiration set (should always be valid)');
      }
      
      // Check rate limiting
      console.log('\n6. Checking rate limit:');
      console.log('Rate limit:', apiKey.rateLimit, 'requests/minute');
      console.log('Usage count:', apiKey.usageCount);
      console.log('Last used:', apiKey.lastUsedAt);
      
    } else {
      console.log('Key not found in database!');
    }
    
    // Test multiple rapid requests
    console.log('\n7. Testing multiple rapid requests:');
    for (let i = 0; i < 5; i++) {
      const result = await apiKeyService.validateApiKey(testKey);
      console.log(`Request ${i + 1}:`, result ? 'VALID' : 'INVALID');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

debugApiKeyValidation();