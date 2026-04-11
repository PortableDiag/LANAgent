#!/usr/bin/env node

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(dirname(__dirname), '.env') });

async function fixContacts() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Define Memory schema
    const memorySchema = new mongoose.Schema({}, { strict: false });
    const Memory = mongoose.model('Memory', memorySchema);

    // Find all email contacts
    const contacts = await Memory.find({
      type: 'knowledge',
      'metadata.category': 'email_contacts'
    });

    console.log(`Found ${contacts.length} email contacts`);

    let fixed = 0;
    for (const contact of contacts) {
      let needsUpdate = false;
      const originalEmail = contact.metadata?.email;
      const originalName = contact.metadata?.name;

      // Extract clean email from various formats
      if (originalEmail && typeof originalEmail === 'string') {
        // Check if email contains angle brackets or quotes
        if (originalEmail.includes('<') || originalEmail.includes('"')) {
          const emailMatch = originalEmail.match(/<([^<>]+@[^<>]+)>/) || 
                            originalEmail.match(/([^\s<>"]+@[^\s<>"]+)/);
          if (emailMatch) {
            contact.metadata.email = emailMatch[1];
            needsUpdate = true;
            console.log(`Fixed email: "${originalEmail}" -> "${emailMatch[1]}"`);
          }
        }
      }

      // Extract clean name from various formats
      if (originalName && typeof originalName === 'string') {
        // Remove quotes and extract name from "Name" <email> format
        if (originalName.includes('"') || originalName.includes('<')) {
          let cleanName = originalName;
          
          // Extract name from "Name" <email> format
          const nameMatch = originalName.match(/^"([^"]+)"/);
          if (nameMatch) {
            cleanName = nameMatch[1];
          } else {
            // Remove everything after < if present
            const angleIndex = originalName.indexOf('<');
            if (angleIndex > 0) {
              cleanName = originalName.substring(0, angleIndex).trim();
            }
            // Remove quotes
            cleanName = cleanName.replace(/"/g, '').trim();
          }
          
          if (cleanName && cleanName !== originalName) {
            contact.metadata.name = cleanName;
            needsUpdate = true;
            console.log(`Fixed name: "${originalName}" -> "${cleanName}"`);
          }
        }
      }

      // Update content field to match
      if (needsUpdate) {
        const cleanEmail = contact.metadata.email;
        const cleanName = contact.metadata.name || 'Unknown';
        contact.content = `Email contact: ${cleanName} <${cleanEmail}>`;
        
        await contact.save();
        fixed++;
      }
    }

    console.log(`\nFixed ${fixed} contacts`);
    
    // Show updated contacts
    console.log('\nUpdated contacts:');
    const updatedContacts = await Memory.find({
      type: 'knowledge',
      'metadata.category': 'email_contacts'
    }).limit(10);
    
    updatedContacts.forEach(c => {
      console.log(`- ${c.metadata?.name}: ${c.metadata?.email}`);
    });

    await mongoose.disconnect();
    console.log('\nDone!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

fixContacts();