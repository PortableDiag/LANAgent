#!/usr/bin/env node

import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';

async function cleanupDedupe() {
  console.log('Connecting to MongoDB...');
  
  // Connect with MongoDB driver
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  
  const db = client.db('lanagent');
  const dedupeCollection = db.collection('plugin-development-dedupe');
  const pluginDevCollection = db.collection('plugindevelopments');
  
  // Plugins to clean up
  const pluginsToCleanup = [
    'Facebook',
    'Twitter', 
    'PubNub',
    'Pusher',
    'Postman',
    'Zabbix',
    'Grafana',
    'Prometheus'
  ];
  
  console.log('\n=== Cleaning up dedupe entries ===');
  
  // Clean dedupe entries
  for (const pluginName of pluginsToCleanup) {
    const result = await dedupeCollection.deleteMany({
      $or: [
        { apiName: pluginName },
        { apiName: { $regex: new RegExp(pluginName, 'i') } }
      ]
    });
    console.log(`Removed ${result.deletedCount} dedupe entries for ${pluginName}`);
  }
  
  console.log('\n=== Resetting plugin development status ===');
  
  // Reset plugin development status from completed/in_progress to allow retry
  for (const pluginName of pluginsToCleanup) {
    const result = await pluginDevCollection.updateMany(
      {
        api: pluginName,
        status: { $in: ['completed', 'in_progress'] }
      },
      {
        $set: {
          status: 'failed',
          error: 'Reset for retry - previous attempt generated invalid code'
        }
      }
    );
    console.log(`Updated ${result.modifiedCount} plugin development records for ${pluginName}`);
  }
  
  console.log('\n=== Summary ===');
  
  // Show current plugin development status
  const summary = await pluginDevCollection.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]).toArray();
  
  console.log('\nPlugin development status summary:');
  summary.forEach(s => {
    console.log(`  ${s._id}: ${s.count}`);
  });
  
  await client.close();
  console.log('\nCleanup complete!');
}

cleanupDedupe().catch(console.error).then(() => process.exit(0));