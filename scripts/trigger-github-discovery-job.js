#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agenda } from 'agenda';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function triggerJob() {
  console.log('🚀 Triggering GitHub Discovery via Agenda job...\n');
  
  const agenda = new Agenda({
    db: {
      address: process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent',
      collection: 'scheduled_jobs'
    }
  });
  
  await agenda.start();
  
  try {
    // Trigger the job immediately
    const job = await agenda.now('github-discovery');
    console.log('✅ GitHub discovery job triggered!');
    console.log('Job ID:', job.attrs._id);
    
    // Wait a bit for the job to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check job status
    const jobs = await agenda.jobs({ name: 'github-discovery' });
    if (jobs.length > 0) {
      const latestJob = jobs[0];
      console.log('\nJob Status:');
      console.log('- Running:', !!latestJob.attrs.lockedAt);
      console.log('- Last run:', latestJob.attrs.lastRunAt);
      console.log('- Next run:', latestJob.attrs.nextRunAt);
    }
    
  } catch (error) {
    console.error('❌ Error triggering job:', error);
  } finally {
    await agenda.stop();
    process.exit(0);
  }
}

triggerJob().catch(console.error);