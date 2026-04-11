#!/usr/bin/env node

/**
 * Database Cleanup Script
 * Removes old databases after confirming data has been migrated to lanagent
 */

import { MongoClient } from 'mongodb';
import readline from 'readline';
import { logger } from '../src/utils/logger.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

// Databases to remove
const DATABASES_TO_REMOVE = ['alice-assistant', 'alice-bot', 'alice_agent', 'lan-agent'];
const TARGET_DATABASE = 'lanagent';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => {
    rl.question(query, resolve);
  });
}

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
      console.log('Please run consolidate-databases.js first');
      return;
    }
    
    console.log(`\nTotal documents in target database: ${totalDocs}`);
    
    // Show what will be removed
    console.log('\n=== Databases to Remove ===');
    for (const dbName of DATABASES_TO_REMOVE) {
      const db = client.db(dbName);
      const collections = await db.listCollections().toArray();
      let dbDocs = 0;
      
      console.log(`\n${dbName}:`);
      
      if (collections.length === 0) {
        console.log('  (empty - no collections)');
        continue;
      }
      
      for (const collection of collections) {
        const coll = db.collection(collection.name);
        const count = await coll.countDocuments();
        dbDocs += count;
        console.log(`  - ${collection.name}: ${count} documents`);
      }
      
      console.log(`  Total: ${dbDocs} documents`);
    }
    
    // Confirm deletion
    console.log('\n⚠️  WARNING: This action cannot be undone!');
    const answer = await question('\nAre you sure you want to remove these databases? (yes/no): ');
    
    if (answer.toLowerCase() !== 'yes') {
      console.log('Aborted.');
      return;
    }
    
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
    rl.close();
    await client.close();
  }
}

// Run the cleanup
removeOldDatabases().catch(console.error);