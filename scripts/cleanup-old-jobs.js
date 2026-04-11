#!/usr/bin/env node
// One-time script to clean up accumulated cleanup jobs

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Agenda from 'agenda';

dotenv.config();

async function cleanup() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
    
    // Create agenda instance
    const agenda = new Agenda({
      db: {
        address: process.env.MONGODB_URI,
        collection: 'scheduled_jobs'
      }
    });
    
    // Start agenda
    await agenda.start();
    console.log('Agenda started');
    
    // Find ALL completed jobs (not recurring ones)
    const completedJobs = await agenda.jobs({
      $or: [
        { 'lastFinishedAt': { $exists: true } },
        { 'failedAt': { $exists: true } }
      ]
    });
    
    // Filter out recurring jobs
    const oldJobs = completedJobs.filter(job => 
      !job.attrs.repeatInterval && !job.attrs.repeatAt
    );
    
    console.log(`Found ${oldJobs.length} completed non-recurring jobs to remove`);
    
    let removed = 0;
    const jobTypeCounts = {};
    
    for (const job of oldJobs) {
      try {
        const jobName = job.attrs.name;
        await job.remove();
        removed++;
        jobTypeCounts[jobName] = (jobTypeCounts[jobName] || 0) + 1;
        
        if (removed % 10 === 0) {
          console.log(`Removed ${removed} jobs...`);
        }
      } catch (error) {
        console.error(`Failed to remove job ${job.attrs._id}:`, error.message);
      }
    }
    
    console.log(`\nSuccessfully removed ${removed} completed jobs:`);
    Object.entries(jobTypeCounts).forEach(([name, count]) => {
      console.log(`  - ${name}: ${count}`);
    });
    
    // Close connections
    await agenda.stop();
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('Cleanup script failed:', error);
    process.exit(1);
  }
}

// Run cleanup
cleanup().then(() => {
  console.log('Cleanup completed');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});