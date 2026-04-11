#!/usr/bin/env node

/**
 * Clear processed state for bug #7 so it can be processed again
 * Issue: MongoDB incorrectly marked #7 as processed but no PR was created
 */

import { connectDB } from '../src/utils/database.js';

async function clearBug7State() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    
    const { ProcessedBug } = await import('../src/models/ProcessedBug.js');
    
    console.log('📋 Checking current processed bugs...');
    const allProcessed = await ProcessedBug.find({}).sort({createdAt: -1});
    console.log('Currently processed bugs:');
    allProcessed.forEach(pb => {
      console.log(`  #${pb.issueNumber}: ${pb.issueTitle} - ${pb.fixResult}`);
    });
    
    console.log('\n🗑️ Removing bug #7 from processed state...');
    const result = await ProcessedBug.deleteMany({ issueNumber: 7 });
    
    if (result.deletedCount > 0) {
      console.log(`✅ Removed ${result.deletedCount} record(s) for bug #7`);
      console.log('🎯 Bug #7 can now be processed again');
    } else {
      console.log('⚠️ No records found for bug #7 (already cleared?)');
    }
    
    console.log('\n📋 Updated processed bugs list:');
    const updatedProcessed = await ProcessedBug.find({}).sort({createdAt: -1});
    updatedProcessed.forEach(pb => {
      console.log(`  #${pb.issueNumber}: ${pb.issueTitle} - ${pb.fixResult}`);
    });
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error clearing bug #7 state:', error);
    process.exit(1);
  }
}

clearBug7State();