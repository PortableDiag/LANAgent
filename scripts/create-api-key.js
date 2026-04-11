import mongoose from 'mongoose';
import dotenv from 'dotenv';
import apiKeyService from '../src/services/apiKeyService.js';

dotenv.config();

async function createApiKey() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/lanagent');
    console.log('Connected to MongoDB');
    
    // Create a new API key
    const keyInfo = await apiKeyService.createApiKey({
      name: 'Mobile Test Key',
      description: 'Created via script for mobile testing',
      createdBy: 'script',
      rateLimit: 100
    });
    
    console.log('\n=== NEW API KEY CREATED ===');
    console.log('Name:', keyInfo.name);
    console.log('ID:', keyInfo.id);
    console.log('Key Prefix:', keyInfo.keyPrefix);
    console.log('\n🔑 FULL API KEY (save this now!):');
    console.log(keyInfo.key);
    console.log('\n=========================\n');
    
    console.log('Usage examples:');
    console.log('curl -H "X-API-Key: ' + keyInfo.key + '" http://$PRODUCTION_SERVER/api/system/status');
    console.log('\nOr in Authorization header:');
    console.log('curl -H "Authorization: ApiKey ' + keyInfo.key + '" http://$PRODUCTION_SERVER/api/system/status');
    
    // Optionally delete the old unusable key
    if (process.argv.includes('--delete-old')) {
      const oldKeyId = '69546bea4a2c47091ce90e18';
      const deleted = await apiKeyService.deleteApiKey(oldKeyId);
      if (deleted) {
        console.log('\n✅ Deleted old unusable key');
      }
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

createApiKey();