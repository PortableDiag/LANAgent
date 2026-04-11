#!/usr/bin/env node

/**
 * Quick Intent Analysis Script
 * This script analyzes the intent definitions directly from the source file
 */

import { readFileSync } from 'fs';
import path from 'path';

// Read the aiIntentDetector.js file
const aiIntentDetectorPath = './src/core/aiIntentDetector.js';
const content = readFileSync(aiIntentDetectorPath, 'utf8');

console.log('🔍 LANAgent Intent Analysis - Quick Check');
console.log('=========================================\n');

// Extract static intent definitions
const intentMatches = content.match(/(\d+):\s*{[\s\S]*?name:\s*['"](.*?)['"][\s\S]*?plugin:\s*['"](.*?)['"][\s\S]*?action:\s*['"](.*?)['"][\s\S]*?description:\s*['"](.*?)['"][\s\S]*?}/g);

if (intentMatches) {
    console.log(`📊 Found ${intentMatches.length} static intent definitions\n`);
    
    console.log('=== STATIC INTENTS (from source analysis) ===');
    
    const intents = [];
    
    intentMatches.forEach(match => {
        const idMatch = match.match(/(\d+):/);
        const nameMatch = match.match(/name:\s*['"](.*?)['"]/);
        const pluginMatch = match.match(/plugin:\s*['"](.*?)['"]/);
        const actionMatch = match.match(/action:\s*['"](.*?)['"]/);
        const descMatch = match.match(/description:\s*['"](.*?)['"]/);
        
        if (idMatch && nameMatch && pluginMatch && actionMatch && descMatch) {
            const intent = {
                id: parseInt(idMatch[1]),
                name: nameMatch[1],
                plugin: pluginMatch[1],
                action: actionMatch[1],
                description: descMatch[1]
            };
            intents.push(intent);
        }
    });
    
    // Sort by ID
    intents.sort((a, b) => a.id - b.id);
    
    // Show all static intents
    intents.forEach(intent => {
        console.log(`${intent.id.toString().padStart(3)}: ${intent.name} (${intent.plugin}.${intent.action}) - ${intent.description.substring(0, 60)}${intent.description.length > 60 ? '...' : ''}`);
    });
    
    // Check for intent 209
    console.log('\n=== INTENT ID 209 ANALYSIS ===');
    const intent209 = intents.find(i => i.id === 209);
    if (intent209) {
        console.log(`✅ Intent ID 209 FOUND in static intents!`);
        console.log(`   Name: ${intent209.name}`);
        console.log(`   Plugin: ${intent209.plugin}`);
        console.log(`   Action: ${intent209.action}`);
        console.log(`   Description: ${intent209.description}`);
    } else {
        console.log(`❌ Intent ID 209 NOT FOUND in static intents`);
        console.log(`   This means intent 209 is either a dynamic intent or doesn't exist.`);
        console.log(`   Dynamic intents start at ID 1000 and are generated from enabled plugins.`);
        console.log(`   To find dynamic intent 209, you need to run the full debug script.`);
    }
    
    // Check Govee-related intents  
    console.log('\n=== GOVEE-RELATED INTENTS ===');
    const goveeIntents = intents.filter(i => 
        i.plugin === 'govee' || 
        i.name.toLowerCase().includes('govee') || 
        i.description.toLowerCase().includes('govee')
    );
    
    if (goveeIntents.length > 0) {
        goveeIntents.forEach(intent => {
            console.log(`${intent.id.toString().padStart(3)}: ${intent.name} (${intent.plugin}.${intent.action}) - ${intent.description}`);
        });
    } else {
        console.log('❌ No Govee-related static intents found');
        console.log('   Govee intents are likely dynamic (generated from the Govee plugin)');
    }
    
    // Show intent ID ranges
    console.log('\n=== INTENT ID DISTRIBUTION ===');
    const maxStaticId = Math.max(...intents.map(i => i.id));
    const minStaticId = Math.min(...intents.map(i => i.id));
    console.log(`Static Intent ID Range: ${minStaticId} to ${maxStaticId}`);
    console.log(`Dynamic Intents Start At: 1000`);
    console.log(`Intent 209 is in static range (not dynamic). Dynamic intents now start at 1000+`);
    
} else {
    console.log('❌ Could not extract intent definitions from source file');
}

console.log('\n=== DYNAMIC INTENT INFORMATION ===');
console.log('Dynamic intents are generated from plugin commands at runtime.');
console.log('They start at ID 1000 and increment for each plugin command.');
console.log('To see all dynamic intents including ID 209, run: node debug_intents.js');

console.log('\n=== DEBUGGING RECOMMENDATIONS ===');
console.log('1. Run the full debug script: node debug_intents.js');
console.log('2. Use the debug API endpoint: GET /api/debug/intents');
console.log('3. Check logs for intent prompt content when AI detection runs');
console.log('4. Use the intent prompt debug endpoint: POST /api/debug/intent-prompt');