#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

// Dynamically import after env is loaded
async function fixCalendarEvents() {
  try {
    console.log('Loading calendar plugin...');
    
    // Import required modules
    const { default: CalendarPlugin } = await import('../src/api/plugins/calendar.js');
    const { logger } = await import('../src/utils/logger.js');
    
    // Create minimal agent
    const agent = {
      config: { name: 'CalendarFixer' },
      logger: logger,
      notify: async (msg) => console.log('Notification:', msg),
      apiManager: {
        apis: new Map(),
        getPlugin: function(name) {
          const wrapper = this.apis.get(name);
          return wrapper ? wrapper.instance : null;
        }
      }
    };
    
    // Create calendar instance
    const calendar = new CalendarPlugin(agent);
    agent.apiManager.apis.set('calendar', { instance: calendar });
    
    // Initialize
    await calendar.initialize();
    
    // Check if connected
    console.log('Checking calendar connection...');
    const status = await calendar.execute({ action: 'listCalendars' });
    
    if (!status.success) {
      console.error('Calendar not connected. Please configure credentials first.');
      process.exit(1);
    }
    
    console.log('Calendar connected. Fetching events...');
    
    // Get all events
    const eventsResult = await calendar.execute({ 
      action: 'getEvents',
      start: new Date(Date.now() - 60*24*60*60*1000).toISOString(), // 60 days ago
      end: new Date(Date.now() + 60*24*60*60*1000).toISOString()     // 60 days future
    });
    
    if (!eventsResult.success || !eventsResult.events) {
      console.error('Failed to fetch events:', eventsResult.error);
      process.exit(1);
    }
    
    console.log(`Found ${eventsResult.events.length} events`);
    
    // Find problematic events
    const problematicEvents = eventsResult.events.filter(event => {
      const url = event.url || event.id || '';
      // Check for duplicated path structure
      return url.includes('events/https://') || url.includes('.ics.ics');
    });
    
    if (problematicEvents.length === 0) {
      console.log('No problematic events found.');
      return;
    }
    
    console.log(`\nFound ${problematicEvents.length} problematic events:`);
    problematicEvents.forEach(event => {
      console.log(`- ${event.title} (${event.start})`);
      console.log(`  URL: ${event.url || event.id}`);
    });
    
    // Try to fix and delete these events
    console.log('\nAttempting to fix and remove problematic events...');
    
    for (const event of problematicEvents) {
      const eventId = event.url || event.id;
      console.log(`\nProcessing: ${event.title}`);
      
      // Try different approaches to delete
      const approaches = [
        // 1. Try with the full malformed URL
        eventId,
        // 2. Try extracting just the filename
        eventId.split('/').pop(),
        // 3. Try extracting the UUID
        eventId.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/)?.[1] + '@lanagent.ics',
        // 4. Try fixing the duplicated path
        eventId.replace(/.*\/events\//g, ''),
      ];
      
      let deleted = false;
      for (const approach of approaches) {
        if (!approach) continue;
        
        console.log(`  Trying to delete with ID: ${approach}`);
        try {
          const result = await calendar.execute({
            action: 'deleteEvent',
            eventId: approach
          });
          
          if (result.success) {
            console.log(`  ✓ Successfully deleted!`);
            deleted = true;
            break;
          } else {
            console.log(`  ✗ Failed: ${result.error}`);
          }
        } catch (error) {
          console.log(`  ✗ Error: ${error.message}`);
        }
      }
      
      if (!deleted) {
        console.log(`  ⚠️  Could not delete this event through normal means`);
        
        // Try a more direct approach by manipulating the calendar objects
        console.log('  Attempting direct removal from calendar objects...');
        
        if (calendar.calendars && calendar.calendars[0]) {
          const cal = calendar.calendars[0];
          if (cal.objects) {
            const beforeCount = cal.objects.length;
            cal.objects = cal.objects.filter(obj => {
              const objUrl = obj.url || '';
              return !objUrl.includes(eventId) && !eventId.includes(objUrl);
            });
            const afterCount = cal.objects.length;
            
            if (beforeCount > afterCount) {
              console.log(`  ✓ Removed from local cache (${beforeCount} -> ${afterCount} objects)`);
            }
          }
        }
      }
    }
    
    console.log('\nDone! Please refresh your calendar view to see the changes.');
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the fixer
fixCalendarEvents().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});