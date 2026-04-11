#!/usr/bin/env node
// Script to update plugin development statuses in the database

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { PluginDevelopment } from '../src/models/PluginDevelopment.js';
import { logger } from '../src/utils/logger.js';

dotenv.config();

async function updatePluginStatus() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent');
    logger.info('Connected to MongoDB');
    
    // Find and update Microsoft Azure AI plugin development status
    const azureUpdate = await PluginDevelopment.findOneAndUpdate(
      { api: 'Microsoft Azure AI' },
      { 
        status: 'completed',
        completedAt: new Date(),
        prUrl: 'https://github.com/yourusername/LANAgent/pull/464',
        apiDetails: {
          name: 'Microsoft Azure AI',
          description: 'Comprehensive Azure AI services integration',
          category: 'AI/ML',
          documentation: 'https://docs.microsoft.com/en-us/azure/cognitive-services/',
          features: [
            'Computer vision',
            'Speech services', 
            'Language understanding',
            'Decision making',
            'Azure OpenAI service'
          ],
          evaluation: {
            score: 9,
            pros: [
              'Comprehensive AI services',
              'Enterprise-ready',
              'Strong documentation',
              'Multiple SDKs available'
            ],
            cons: [
              'Complex pricing structure',
              'Requires Azure subscription'
            ]
          }
        }
      },
      { new: true }
    );
    
    if (azureUpdate) {
      logger.info('Updated Microsoft Azure AI plugin status to completed');
      logger.info(`Record ID: ${azureUpdate._id}`);
    } else {
      logger.warn('No Microsoft Azure AI plugin development record found');
    }
    
    // Find and update OpenAI GPT3 plugin development status
    const openaiUpdate = await PluginDevelopment.findOneAndUpdate(
      { api: 'OpenAI GPT3' },
      {
        status: 'completed',
        completedAt: new Date(),
        apiDetails: {
          name: 'OpenAI GPT3',
          description: 'OpenAI GPT-3 language model integration',
          category: 'AI/ML',
          documentation: 'https://platform.openai.com/docs/api-reference',
          features: [
            'Text completion',
            'Code generation',
            'Translation',
            'Summarization',
            'Question answering'
          ],
          evaluation: {
            score: 8.5,
            pros: [
              'Powerful language model',
              'Easy to use API',
              'Good documentation',
              'Wide range of use cases'
            ],
            cons: [
              'Usage costs can be high',
              'Rate limits',
              'Requires API key'
            ]
          }
        }
      },
      { new: true }
    );
    
    if (openaiUpdate) {
      logger.info('Updated OpenAI GPT3 plugin status to completed');
      logger.info(`Record ID: ${openaiUpdate._id}`);
    } else {
      logger.warn('No OpenAI GPT3 plugin development record found');
    }
    
    // List all plugin development records
    logger.info('\n=== All Plugin Development Records ===');
    const allRecords = await PluginDevelopment.find().sort({ createdAt: -1 });
    
    for (const record of allRecords) {
      logger.info(`
API: ${record.api}
Status: ${record.status}
Created: ${record.createdAt}
Completed: ${record.completedAt || 'N/A'}
Branch: ${record.branchName || 'N/A'}
PR URL: ${record.prUrl || 'N/A'}
ID: ${record._id}
---`);
    }
    
    // Close connection
    await mongoose.disconnect();
    logger.info('Disconnected from MongoDB');
    
  } catch (error) {
    logger.error('Update script failed:', error);
    process.exit(1);
  }
}

// Run the update
updatePluginStatus().then(() => {
  logger.info('Plugin status update completed');
  process.exit(0);
}).catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});