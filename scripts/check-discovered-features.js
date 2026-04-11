#!/usr/bin/env node

import { MongoClient } from 'mongodb';

async function checkFeatures() {
  const client = await MongoClient.connect('mongodb://localhost:27017');
  
  try {
    const db = client.db('lanagent');
    
    // Get sample features
    const features = await db.collection('discoveredFeatures').find({}).limit(5).toArray();
    
    console.log(`Found ${await db.collection('discoveredFeatures').countDocuments()} total discovered features`);
    console.log('\nSample features:');
    
    for (const feature of features) {
      console.log(`\nTitle: ${feature.title}`);
      console.log(`Type: ${feature.type}`);
      console.log(`Tags: ${feature.tags ? feature.tags.join(', ') : 'none'}`);
      console.log(`Status: ${feature.status}`);
      console.log(`Repository: ${feature.source?.repository}`);
    }
    
    // Check types distribution
    const types = await db.collection('discoveredFeatures').distinct('type');
    console.log('\nAll types:', types);
    
    // Check tags distribution
    const tags = await db.collection('discoveredFeatures').distinct('tags');
    console.log('\nAll tags:', tags);
    
    // Count plugin-related features
    const pluginRelated = await db.collection('discoveredFeatures').countDocuments({
      $or: [
        { type: { $in: ['plugin_idea', 'integration', 'api_feature'] } },
        { tags: { $in: ['plugin', 'api', 'integration'] } },
        { title: { $regex: /plugin|integration|api/i } }
      ]
    });
    
    console.log(`\nPlugin-related features: ${pluginRelated}`);
    
  } finally {
    await client.close();
  }
}

checkFeatures().catch(console.error);