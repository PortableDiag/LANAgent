#!/usr/bin/env node

/**
 * Database Consolidation Script
 * Migrates all data from alice-assistant, alice-bot, alice_agent, and lan-agent to lanagent database
 */

import { MongoClient } from 'mongodb';
import { logger } from '../src/utils/logger.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

// Databases to migrate from
const SOURCE_DATABASES = ['alice-assistant', 'alice-bot', 'alice_agent', 'lan-agent'];
const TARGET_DATABASE = 'lanagent';

async function consolidateDatabases() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    logger.info('Starting database consolidation process');
    
    const targetDb = client.db(TARGET_DATABASE);
    
    // Process each source database
    for (const sourceDbName of SOURCE_DATABASES) {
      console.log(`\n=== Processing ${sourceDbName} ===`);
      logger.info(`Processing database: ${sourceDbName}`);
      
      const sourceDb = client.db(sourceDbName);
      const collections = await sourceDb.listCollections().toArray();
      
      if (collections.length === 0) {
        console.log(`No collections found in ${sourceDbName}`);
        continue;
      }
      
      for (const collectionInfo of collections) {
        const collectionName = collectionInfo.name;
        const sourceCollection = sourceDb.collection(collectionName);
        const targetCollection = targetDb.collection(collectionName);
        
        const sourceCount = await sourceCollection.countDocuments();
        
        if (sourceCount === 0) {
          console.log(`  - ${collectionName}: No documents to migrate`);
          continue;
        }
        
        console.log(`  - ${collectionName}: ${sourceCount} documents found`);
        
        // Check if collection already exists in target
        const targetCount = await targetCollection.countDocuments();
        
        if (targetCount > 0) {
          console.log(`    Warning: Target collection already has ${targetCount} documents`);
          logger.warn(`Target collection ${collectionName} already has ${targetCount} documents`);
          
          // For safety, we'll merge rather than replace
          // Skip if documents might be duplicates
          const sampleDoc = await sourceCollection.findOne();
          const existingDoc = await targetCollection.findOne({ _id: sampleDoc._id });
          
          if (existingDoc) {
            console.log(`    Skipping - appears to be duplicate data`);
            continue;
          }
        }
        
        // Copy indexes first (except _id index)
        const sourceIndexes = await sourceCollection.indexes();
        for (const index of sourceIndexes) {
          if (index.name !== '_id_') {
            try {
              delete index.ns; // Remove namespace
              delete index.v;  // Remove version
              await targetCollection.createIndex(index.key, {
                name: index.name,
                ...index
              });
              console.log(`    Created index: ${index.name}`);
            } catch (error) {
              if (error.code === 85) { // Index already exists
                console.log(`    Index already exists: ${index.name}`);
              } else {
                logger.error(`Failed to create index ${index.name}:`, error);
              }
            }
          }
        }
        
        // Migrate documents in batches
        const batchSize = 1000;
        let migrated = 0;
        
        while (migrated < sourceCount) {
          const batch = await sourceCollection
            .find({})
            .skip(migrated)
            .limit(batchSize)
            .toArray();
          
          if (batch.length === 0) break;
          
          try {
            // Use insertMany with ordered: false to continue on duplicates
            const result = await targetCollection.insertMany(batch, { ordered: false });
            migrated += result.insertedCount;
            console.log(`    Migrated ${migrated}/${sourceCount} documents`);
          } catch (error) {
            if (error.code === 11000) { // Duplicate key error
              console.log(`    Some documents already exist, continuing...`);
              migrated += batch.length;
            } else {
              throw error;
            }
          }
        }
        
        logger.info(`Migrated ${collectionName}: ${migrated} documents`);
      }
    }
    
    console.log('\n=== Migration Summary ===');
    
    // Show final state of target database
    const finalCollections = await targetDb.listCollections().toArray();
    console.log(`\nTarget database (${TARGET_DATABASE}) now contains:`);
    
    for (const collection of finalCollections) {
      const coll = targetDb.collection(collection.name);
      const count = await coll.countDocuments();
      console.log(`  - ${collection.name}: ${count} documents`);
    }
    
    console.log('\n✅ Database consolidation complete!');
    console.log('\nNext steps:');
    console.log('1. Test the application to ensure everything works');
    console.log('2. Update MONGODB_DB environment variable to "lanagent" if needed');
    console.log('3. Run "node scripts/remove-old-databases.js" to clean up');
    
    logger.info('Database consolidation completed successfully');
    
  } catch (error) {
    console.error('Error during consolidation:', error);
    logger.error('Database consolidation failed:', error);
  } finally {
    await client.close();
  }
}

// Run the consolidation
consolidateDatabases().catch(console.error);