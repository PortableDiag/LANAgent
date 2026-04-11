#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agenda } from 'agenda';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function triggerCleanup() {
  console.log('🧹 Triggering cleanup-completed-jobs...\n');
  
  const agenda = new Agenda({
    db: {
      address: process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent',
      collection: 'scheduled_jobs'
    }
  });
  
  await agenda.start();
  
  try {
    // First, let's see what jobs exist
    const allJobs = await agenda.jobs({});
    console.log(`Total jobs in database: ${allJobs.length}\n`);
    
    // Group by name
    const jobCounts = {};
    const oldJobs = [];
    const cutoffDate = new Date();
    cutoffDate.setMinutes(cutoffDate.getMinutes() - 30);
    
    allJobs.forEach(job => {
      const name = job.attrs.name;
      jobCounts[name] = (jobCounts[name] || 0) + 1;
      
      // Check if this would be cleaned up
      const lastFinished = job.attrs.lastFinishedAt;
      const failed = job.attrs.failedAt;
      const hasRepeat = job.attrs.repeatInterval || job.attrs.repeatAt;
      
      if (!hasRepeat && (lastFinished && lastFinished < cutoffDate || failed && failed < cutoffDate)) {
        oldJobs.push({
          name,
          id: job.attrs._id,
          lastFinished,
          failed
        });
      }
    });
    
    console.log('Jobs by type:');
    Object.entries(jobCounts).forEach(([name, count]) => {
      console.log(`- ${name}: ${count}`);
    });
    
    console.log(`\nJobs eligible for cleanup: ${oldJobs.length}`);
    oldJobs.forEach(job => {
      console.log(`- ${job.name} (${job.id})`);
    });
    
    // Now trigger the cleanup
    console.log('\n🚀 Triggering cleanup job...');
    const cleanupJob = await agenda.now('cleanup-completed-jobs');
    console.log('Cleanup job triggered, ID:', cleanupJob.attrs._id);
    
    // Wait for it to complete
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check again
    const afterJobs = await agenda.jobs({});
    console.log(`\nTotal jobs after cleanup: ${afterJobs.length}`);
    
    if (allJobs.length > afterJobs.length) {
      console.log(`✅ Cleaned up ${allJobs.length - afterJobs.length} jobs!`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await agenda.stop();
    process.exit(0);
  }
}

triggerCleanup().catch(console.error);