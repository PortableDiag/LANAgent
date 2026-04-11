#!/usr/bin/env node

/**
 * Debug script for LANAgent intent detection system
 * This script will dump all available intents (static + dynamic) and help debug intent ID 209
 */

import { Agent } from './src/core/agent.js';
import { connectDatabase } from './src/utils/database.js';
import { logger } from './src/utils/logger.js';

async function debugIntents() {
  console.log('🔍 LANAgent Intent Detection Debug Script');
  console.log('==========================================\n');

  try {
    // Initialize agent
    console.log('🚀 Initializing LANAgent...');
    const agent = new Agent();
    await agent.initialize();
    
    if (!agent.aiIntentDetector) {
      console.error('❌ AI Intent Detector not available');
      return;
    }

    // Get all intents
    const allIntents = agent.aiIntentDetector.getAllIntents();
    const intentIds = Object.keys(allIntents).map(id => parseInt(id)).sort((a, b) => a - b);
    
    console.log(`📊 Total Intents Available: ${intentIds.length}\n`);
    
    // Separate static and dynamic intents
    const staticIntents = intentIds.filter(id => id < 1000);
    const dynamicIntents = intentIds.filter(id => id >= 1000);
    
    console.log(`📋 Static Intents: ${staticIntents.length} (IDs: 0-999)`);
    console.log(`🔌 Dynamic Intents: ${dynamicIntents.length} (IDs: 1000+)\n`);

    // Show static intents summary
    console.log('=== STATIC INTENTS ===');
    staticIntents.forEach(id => {
      const intent = allIntents[id];
      console.log(`${id.toString().padStart(3)}: ${intent.name} (${intent.plugin}) - ${intent.description}`);
    });

    console.log('\n=== DYNAMIC INTENTS ===');
    dynamicIntents.forEach(id => {
      const intent = allIntents[id];
      console.log(`${id.toString().padStart(3)}: ${intent.name} (${intent.plugin}) - ${intent.description}`);
    });

    // Check for intent ID 209 specifically
    console.log('\n=== INTENT ID 209 ANALYSIS ===');
    if (allIntents[209]) {
      const intent209 = allIntents[209];
      console.log(`✅ Intent ID 209 EXISTS!`);
      console.log(`   Name: ${intent209.name}`);
      console.log(`   Plugin: ${intent209.plugin}`);
      console.log(`   Action: ${intent209.action}`);
      console.log(`   Description: ${intent209.description}`);
      console.log(`   Examples: ${JSON.stringify(intent209.examples, null, 2)}`);
    } else {
      console.log(`❌ Intent ID 209 DOES NOT EXIST`);
      console.log(`   Available intent IDs range: ${Math.min(...intentIds)} to ${Math.max(...intentIds)}`);
    }

    // Show Govee-related intents
    console.log('\n=== GOVEE-RELATED INTENTS ===');
    const goveeIntents = intentIds.filter(id => {
      const intent = allIntents[id];
      return intent.plugin === 'govee' || intent.name.toLowerCase().includes('govee');
    });
    
    if (goveeIntents.length > 0) {
      goveeIntents.forEach(id => {
        const intent = allIntents[id];
        console.log(`${id.toString().padStart(3)}: ${intent.name} (${intent.plugin}) - ${intent.description}`);
      });
    } else {
      console.log('❌ No Govee intents found');
    }

    // Create a function to test specific intent detection
    console.log('\n=== INTENT DETECTION TEST ===');
    const testQueries = [
      'turn on living room light',
      'list govee devices', 
      'show me all smart lights'
    ];

    for (const query of testQueries) {
      try {
        const result = await agent.aiIntentDetector.detect(query);
        console.log(`Query: "${query}"`);
        console.log(`  Result: Intent ID ${result.intentId || 'N/A'}, ${result.intent || 'unknown'}`);
        console.log(`  Plugin: ${result.plugin || 'N/A'}, Action: ${result.action || 'N/A'}`);
      } catch (error) {
        console.log(`Query: "${query}" - ERROR: ${error.message}`);
      }
    }

    // Show the prompt that would be sent to AI for a Govee command
    console.log('\n=== AI INTENT PROMPT SAMPLE ===');
    const samplePrompt = agent.aiIntentDetector.buildIntentPrompt('turn on living room light');
    console.log('Sample prompt for "turn on living room light":');
    console.log('---');
    console.log(samplePrompt.substring(0, 1000) + (samplePrompt.length > 1000 ? '...\n[TRUNCATED]' : ''));
    console.log('---');

  } catch (error) {
    console.error('❌ Error during debug:', error);
  }

  process.exit(0);
}

debugIntents();