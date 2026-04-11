#!/usr/bin/env node
const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/lanagent').then(async () => {
  const db = mongoose.connection.db;
  const col = db.collection('scheduled_jobs');
  
  // Get all jobs that would be candidates for cleanup
  const cutoffDate = new Date();
  cutoffDate.setMinutes(cutoffDate.getMinutes() - 30);
  
  const candidateJobs = await col.find({
    $or: [
      { 
        lastFinishedAt: { $exists: true },
        lastFinishedAt: { $lt: cutoffDate },
        repeatInterval: { $exists: false }
      },
      { 
        failedAt: { $exists: true },
        failedAt: { $lt: cutoffDate },
        repeatInterval: { $exists: false }
      }
    ]
  }).toArray();
  
  console.log("Total jobs eligible for cleanup:", candidateJobs.length);
  
  // Group by job name
  const jobCounts = {};
  candidateJobs.forEach(job => {
    jobCounts[job.name] = (jobCounts[job.name] || 0) + 1;
  });
  
  console.log("\nBreakdown by job type:");
  Object.entries(jobCounts).forEach(([name, count]) => {
    console.log("-", name + ":", count);
  });
  
  // Check for github-discovery specifically
  const githubCleanupCandidates = candidateJobs.filter(j => j.name === "github-discovery");
  console.log("\nGitHub discovery jobs eligible for cleanup:", githubCleanupCandidates.length);
  
  if (githubCleanupCandidates.length > 0) {
    console.log("\nGitHub discovery job details:");
    githubCleanupCandidates.forEach(job => {
      console.log("- ID:", job._id);
      console.log("  LastFinished:", job.lastFinishedAt);
      console.log("  RepeatInterval:", job.repeatInterval);
      console.log("  Type:", job.type);
    });
  }
  
  // Also check what the cleanup job logic would skip
  console.log("\n--- Checking cleanup job logic ---");
  const cleanupSkipped = candidateJobs.filter(job => {
    return job.repeatInterval || job.repeatAt || job.name === 'cleanup-completed-jobs';
  });
  
  console.log("Jobs that would be SKIPPED by cleanup:", cleanupSkipped.length);
  cleanupSkipped.forEach(job => {
    console.log("-", job.name, "(has repeatInterval/repeatAt)");
  });
  
  mongoose.disconnect();
}).catch(console.error);