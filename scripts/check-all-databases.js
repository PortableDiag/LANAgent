#!/usr/bin/env node

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

async function checkAllDatabases() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB\n');
    
    // Get list of all databases
    const adminDb = client.db('admin');
    const { databases } = await adminDb.admin().listDatabases();
    
    // Filter for our specific databases
    const targetDbs = ['alice-assistant', 'alice-bot', 'alice_agent', 'lan-agent', 'lanagent'];
    
    for (const dbInfo of databases) {
      if (targetDbs.includes(dbInfo.name)) {
        console.log(`\n=== Database: ${dbInfo.name} (Size: ${(dbInfo.sizeOnDisk / 1024 / 1024).toFixed(2)} MB) ===`);
        
        const db = client.db(dbInfo.name);
        const collections = await db.listCollections().toArray();
        
        if (collections.length === 0) {
          console.log('  No collections found');
          continue;
        }
        
        for (const collection of collections) {
          const coll = db.collection(collection.name);
          const count = await coll.countDocuments();
          const indexes = await coll.indexes();
          
          console.log(`  - ${collection.name}:`);
          console.log(`    Documents: ${count}`);
          console.log(`    Indexes: ${indexes.length}`);
          
          // Get sample document
          if (count > 0) {
            const sample = await coll.findOne();
            console.log(`    Sample fields: ${Object.keys(sample).join(', ')}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Error checking databases:', error);
  } finally {
    await client.close();
  }
}

checkAllDatabases().catch(console.error);