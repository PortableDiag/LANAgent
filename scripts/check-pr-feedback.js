#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import { PluginDevelopment } from '../src/models/PluginDevelopment.js';

async function checkPRFeedback() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB\n');

    const repoPath = process.env.AGENT_REPO_PATH || '/root/lanagent-repo';
    
    // Get all plugin development records
    const records = await PluginDevelopment.find({
      prUrl: { $exists: true },
      rejectionFeedback: { $exists: false }
    });
    
    console.log(`Found ${records.length} plugin records without feedback\n`);
    
    for (const record of records) {
      try {
        // Extract PR number from URL
        const prMatch = record.prUrl.match(/\/pull\/(\d+)/);
        if (!prMatch) continue;
        
        const prNumber = prMatch[1];
        console.log(`Checking PR #${prNumber} for ${record.api}...`);
        
        // Get PR details
        const prDetails = execSync(
          `cd ${repoPath} && gh pr view ${prNumber} --json state,closedAt,comments,title`,
          { encoding: 'utf8' }
        );
        
        const details = JSON.parse(prDetails);
        
        if (details.state === 'CLOSED' && details.closedAt) {
          console.log(`  - PR was closed at ${details.closedAt}`);
          
          // Extract feedback from comments
          const feedback = {
            prNumber: parseInt(prNumber),
            closedAt: new Date(details.closedAt),
            rejectionReasons: [],
            suggestions: [],
            comments: []
          };
          
          if (details.comments && details.comments.length > 0) {
            // Look for closing comments
            const closingTime = new Date(details.closedAt);
            
            details.comments.forEach(comment => {
              const commentTime = new Date(comment.createdAt);
              const timeDiff = Math.abs(closingTime - commentTime) / 1000 / 60; // minutes
              
              // Include all comments for context
              feedback.comments.push({
                author: comment.author.login,
                body: comment.body,
                createdAt: comment.createdAt
              });
              
              // Focus on comments near closing time for rejection reasons
              if (timeDiff < 60) {
                const body = comment.body.toLowerCase();
                
                if (body.includes('reject') || body.includes('closing') || 
                    body.includes('not') || body.includes('issue') || 
                    body.includes('problem') || body.includes('wrong')) {
                  feedback.rejectionReasons.push(comment.body);
                }
                
                if (body.includes('should') || body.includes('could') || 
                    body.includes('need') || body.includes('instead') || 
                    body.includes('better') || body.includes('suggest')) {
                  feedback.suggestions.push(comment.body);
                }
              }
            });
          }
          
          // Update the record
          record.rejectionFeedback = feedback;
          if (details.state === 'CLOSED' && !details.merged) {
            record.status = 'rejected';
          }
          await record.save();
          
          console.log(`  - Found ${feedback.rejectionReasons.length} rejection reasons`);
          console.log(`  - Found ${feedback.suggestions.length} suggestions`);
        }
        
      } catch (error) {
        console.error(`  - Error checking PR: ${error.message}`);
      }
    }
    
    await mongoose.connection.close();
    console.log('\n✅ Done');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkPRFeedback();