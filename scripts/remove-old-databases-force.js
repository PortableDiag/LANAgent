#!/usr/bin/env node

/**
 * Database Cleanup Script - Non-interactive version
 * Removes old databases without prompting
 */

import { MongoClient } from 'mongodb';
import { logger } from '../src/utils/logger.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

// Databases to remove
const DATABASES_TO_REMOVE = ['alice-assistant', 'alice-bot', 'alice_agent', 'lan-agent'];
const TARGET_DATABASE = 'lanagent';

async function removeOldDatabases() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    // First, verify target database has data
    const targetDb = client.db(TARGET_DATABASE);
    const targetCollections = await targetDb.listCollections().toArray();
    
    console.log(`\n=== Target Database (${TARGET_DATABASE}) Status ===`);
    let totalDocs = 0;
    
    for (const collection of targetCollections) {
      const coll = targetDb.collection(collection.name);
      const count = await coll.countDocuments();
      totalDocs += count;
      console.log(`  - ${collection.name}: ${count} documents`);
    }
    
    if (totalDocs === 0) {
      console.log('\n❌ WARNING: Target database is empty!');
      console.log('Aborting cleanup.');
      return;
    }
    
    console.log(`\nTotal documents in target database: ${totalDocs}`);
    
    // Remove databases
    console.log('\n=== Removing Databases ===');
    for (const dbName of DATABASES_TO_REMOVE) {
      try {
        await client.db(dbName).dropDatabase();
        console.log(`✅ Removed: ${dbName}`);
        logger.info(`Removed database: ${dbName}`);
      } catch (error) {
        console.error(`❌ Failed to remove ${dbName}:`, error.message);
        logger.error(`Failed to remove database ${dbName}:`, error);
      }
    }
    
    console.log('\n✅ Database cleanup complete!');
    logger.info('Database cleanup completed successfully');
    
  } catch (error) {
    console.error('Error during cleanup:', error);
    logger.error('Database cleanup failed:', error);
  } finally {
    await client.close();
  }
}

// Run the cleanup
removeOldDatabases().catch(console.error);