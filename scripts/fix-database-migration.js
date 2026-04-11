#!/usr/bin/env node

// Fix migration - move discovered features back to lanagent database

import { MongoClient } from 'mongodb';

async function fixMigration() {
  const client = await MongoClient.connect('mongodb://localhost:27017');
  
  try {
    const lanagentDb = client.db('lanagent');
    const aliceDb = client.db('alice-assistant');
    
    // Get features from alice-assistant that were incorrectly placed there
    const features = await aliceDb.collection('discoveredFeatures').find({}).toArray();
    
    console.log(`Found ${features.length} features in alice-assistant to move back to lanagent`);
    
    if (features.length === 0) {
      console.log('No features to move');
      return;
    }
    
    // Insert into lanagent database
    let moved = 0;
    let errors = 0;
    
    for (const feature of features) {
      try {
        // Remove _id to let MongoDB create a new one
        delete feature._id;
        
        // Insert into lanagent
        await lanagentDb.collection('discoveredFeatures').insertOne(feature);
        
        moved++;
        console.log(`Moved: ${feature.title}`);
      } catch (err) {
        console.error(`Failed to move "${feature.title}":`, err.message);
        errors++;
      }
    }
    
    // If all successful, drop the collection from alice-assistant
    if (errors === 0) {
      await aliceDb.collection('discoveredFeatures').drop();
      console.log('\nDropped discoveredFeatures collection from alice-assistant');
    } else {
      console.log('\nSome features failed to move, keeping alice-assistant collection');
    }
    
    console.log(`\nMigration fix complete:`);
    console.log(`- Moved: ${moved}`);
    console.log(`- Errors: ${errors}`);
    
    // Also check if there are any remaining GitHub features in featureRequests
    const remainingGitHub = await lanagentDb.collection('featureRequests').countDocuments({
      submittedBy: { $in: ['github_discovery', 'github_discovery_scheduler'] }
    });
    
    console.log(`\nRemaining GitHub features in featureRequests: ${remainingGitHub}`);
    
  } finally {
    await client.close();
  }
}

fixMigration().catch(console.error);