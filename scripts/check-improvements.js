#!/usr/bin/env node

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Improvement from '../src/models/Improvement.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: resolve(__dirname, '../.env') });

async function checkImprovements() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/lanagent');
    console.log('Connected to MongoDB');

    // Get all improvements
    const allImprovements = await Improvement.find().sort({ createdAt: -1 });
    console.log(`\nTotal improvements: ${allImprovements.length}`);

    // Group by status
    const byStatus = {};
    allImprovements.forEach(imp => {
      byStatus[imp.status] = (byStatus[imp.status] || 0) + 1;
    });
    
    console.log('\nImprovements by status:');
    Object.entries(byStatus).forEach(([status, count]) => {
      console.log(`  ${status}: ${count}`);
    });

    // Check for incomplete improvements (not pr_created, merged, or rejected)
    const incompleteStatuses = ['proposed', 'in_progress', 'failed'];
    const incomplete = await Improvement.find({ 
      status: { $in: incompleteStatuses }
    }).sort({ createdAt: -1 });

    if (incomplete.length > 0) {
      console.log(`\n❌ Found ${incomplete.length} incomplete improvements:`);
      incomplete.forEach(imp => {
        console.log(`\n  ID: ${imp._id}`);
        console.log(`  Type: ${imp.type}`);
        console.log(`  Target: ${imp.targetFile}`);
        console.log(`  Status: ${imp.status}`);
        console.log(`  Created: ${imp.createdAt}`);
        console.log(`  Branch: ${imp.branchName}`);
        if (imp.errorMessage) {
          console.log(`  Error: ${imp.errorMessage}`);
        }
      });
    } else {
      console.log('\n✅ No incomplete improvements found');
    }

    // Check recent improvements (last 24 hours)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const recent = await Improvement.find({
      createdAt: { $gte: yesterday }
    }).sort({ createdAt: -1 });

    console.log(`\n📅 Improvements in last 24 hours: ${recent.length}`);
    recent.forEach(imp => {
      console.log(`  ${imp.type} - ${imp.status} - ${imp.createdAt.toISOString()}`);
    });

    // Check for improvements without PRs
    const withoutPRs = await Improvement.find({
      status: 'pr_created',
      $or: [
        { prUrl: { $exists: false } },
        { prUrl: null },
        { prUrl: '' }
      ]
    });

    if (withoutPRs.length > 0) {
      console.log(`\n⚠️  Found ${withoutPRs.length} improvements marked as pr_created but without PR URLs:`);
      withoutPRs.forEach(imp => {
        console.log(`  ${imp._id} - ${imp.type} - ${imp.branchName}`);
      });
    }

    // Check for old proposed improvements (older than 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const oldProposed = await Improvement.find({
      status: 'proposed',
      createdAt: { $lt: weekAgo }
    });

    if (oldProposed.length > 0) {
      console.log(`\n⏰ Found ${oldProposed.length} old proposed improvements (>7 days):`);
      oldProposed.forEach(imp => {
        console.log(`  ${imp._id} - ${imp.type} - ${imp.createdAt}`);
      });
    }

    process.exit(0);
  } catch (error) {
    console.error('Error checking improvements:', error);
    process.exit(1);
  }
}

checkImprovements();