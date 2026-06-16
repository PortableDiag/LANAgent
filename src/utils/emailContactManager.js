import Fuse from 'fuse.js';
import { logger } from './logger.js';

export class EmailContactManager {
  constructor(agent) {
    this.agent = agent;
    this.fuseInstance = null;
    this.blocklist = new Set();
    this.loadBlocklist();
  }

  async loadBlocklist() {
    try {
      // Load blocklist from memory using precise regex search
      const { Memory } = await import('../models/Memory.js');
      const blockedContacts = await Memory.find({
        type: 'knowledge',
        content: { $regex: /^blocked email contact /i }
      }).limit(100);
      
      blockedContacts.forEach(contact => {
        if (contact.metadata?.email) {
          this.blocklist.add(contact.metadata.email.toLowerCase());
        }
      });
      
      logger.info(`Loaded ${this.blocklist.size} blocked contacts`);
    } catch (error) {
      logger.error('Failed to load blocklist:', error);
    }
  }

  async blockContact(email, reason = 'User requested') {
    try {
      const emailLower = email.toLowerCase();
      this.blocklist.add(emailLower);

      await this.agent.memoryManager.storeKnowledge(
        `blocked email contact ${email}`,
        'blocked_contacts',
        {
          email: email,
          blockedAt: new Date(),
          reason: reason
        }
      );
      
      logger.info(`Blocked contact: ${email}, reason: ${reason}`);
      return { success: true, message: `Contact ${email} has been blocked` };
    } catch (error) {
      logger.error('Failed to block contact:', error);
      return { success: false, error: error.message };
    }
  }

  async unblockContact(email) {
    try {
      const emailLower = email.toLowerCase();
      this.blocklist.delete(emailLower);

      // Mark as unblocked in memory
      await this.agent.memoryManager.storeKnowledge(
        `unblocked email contact ${email}`,
        'blocked_contacts',
        {
          email: email,
          unblockedAt: new Date()
        }
      );
      
      logger.info(`Unblocked contact: ${email}`);
      return { success: true, message: `Contact ${email} has been unblocked` };
    } catch (error) {
      logger.error('Failed to unblock contact:', error);
      return { success: false, error: error.message };
    }
  }

  isBlocked(email) {
    return this.blocklist.has(email.toLowerCase());
  }

  async searchContacts(searchTerm, allContacts) {
    try {
      // Get deleted contacts to filter out - use precise search to avoid matching regular contacts
      const { Memory } = await import('../models/Memory.js');
      const deletedContacts = await Memory.find({
        type: 'knowledge',
        content: { $regex: /^Deleted email contact:/i }
      }).limit(500);
      
      const deletedEmails = new Set(deletedContacts
        .map(d => {
          const email = d.metadata?.email || d.content?.match(/([^\s]+@[^\s]+)/)?.[1];
          return email?.toLowerCase();
        })
        .filter(email => email !== undefined));

      // Filter out deleted and blocked contacts
      const activeContacts = allContacts.filter(contact => {
        const email = contact.metadata?.email?.toLowerCase();
        if (!contact.metadata) return false;
        if (!email) return true; // Keep contacts without email field
        return !deletedEmails.has(email) && !this.blocklist.has(email);
      });

      logger.info(`Searching through ${activeContacts.length} active contacts (${allContacts.length} total, ${deletedEmails.size} deleted, ${this.blocklist.size} blocked)...`);

      // Prepare data for Fuse.js
      const fuseData = activeContacts.map(contact => ({
        ...contact,
        searchableNames: [
          contact.metadata.name,
          // Also add first name separately for better matching
          contact.metadata.name ? contact.metadata.name.split(/\s+/)[0] : null,
          // Add last name separately too
          contact.metadata.name ? contact.metadata.name.split(/\s+/).slice(-1)[0] : null,
          ...(contact.metadata.aliases || [])
        ].filter(Boolean)
      }));
      
      // Debug log searchable data
      if (searchTerm.toLowerCase().includes('whalley')) {
        logger.debug('Searchable data for Whalley search:', fuseData.map(d => ({
          name: d.metadata?.name,
          searchableNames: d.searchableNames
        })));
      }

      // Configure Fuse.js
      const fuse = new Fuse(fuseData, {
        keys: ['searchableNames'],
        threshold: 0.4, // Increased threshold for better partial matching
        includeScore: true,
        minMatchCharLength: 2,
        shouldSort: true,
        findAllMatches: false,
        location: 0,
        distance: 100,
        useExtendedSearch: false,
        ignoreLocation: false,
        ignoreFieldNorm: false
      });

      // Search
      const results = fuse.search(searchTerm);
      
      // Also check for exact matches (case-insensitive)
      const searchTermLower = searchTerm.toLowerCase();
      const exactMatches = activeContacts.filter(contact => {
        const metadata = contact.metadata;
        if (!metadata) return false;
        
        // Check exact full name match
        if (metadata.name && metadata.name.toLowerCase() === searchTermLower) {
          return true;
        }
        
        // Check if search term matches first name or last name in a full name
        if (metadata.name) {
          const nameParts = metadata.name.toLowerCase().split(/\s+/);
          // Check first name
          if (nameParts[0] === searchTermLower) {
            return true;  // First name exact match
          }
          // Check last name
          if (nameParts.length > 1 && nameParts[nameParts.length - 1] === searchTermLower) {
            return true;  // Last name exact match
          }
        }
        
        // Check exact alias match
        if (metadata.aliases && Array.isArray(metadata.aliases)) {
          return metadata.aliases.some(alias => alias.toLowerCase() === searchTermLower);
        }
        
        return false;
      });

      return {
        exactMatches,
        fuzzyMatches: results.map(r => {
          const contact = r.item;
          if (!contact?.metadata) {
            logger.warn('Fuse result missing metadata:', {
              hasItem: !!r.item,
              itemKeys: r.item ? Object.keys(r.item) : [],
              score: r.score
            });
          }
          return {
            contact: contact,
            score: 1 - r.score, // Convert to confidence (1 = perfect match)
            matchedValue: this.findMatchedValue(contact, searchTerm)
          };
        }).filter(m => m.contact?.metadata) // Filter out invalid results
      };
    } catch (error) {
      logger.error('Contact search failed:', error);
      throw error;
    }
  }

  findMatchedValue(contact, searchTerm) {
    const searchLower = searchTerm.toLowerCase();
    
    // Check if search matches first name
    if (contact?.metadata && contact?.metadata?.name) {
      const nameParts = contact?.metadata?.name?.split(/\s+/);
      if (nameParts[0].toLowerCase() === searchLower) {
        return `${contact?.metadata?.name} (matched first name)`;
      }
      
      if (contact?.metadata?.name?.toLowerCase()?.includes(searchLower)) {
        return contact.metadata.name;
      }
    }
    
    if (contact.metadata && contact.metadata.aliases) {
      for (const alias of contact.metadata.aliases) {
        if (alias?.toLowerCase()?.includes(searchLower)) {
          return `${alias} (alias)`;
        }
      }
    }
    
    return contact.metadata?.name || 'Unknown';
  }

  async confirmRecipient(contact, searchTerm, confidence) {
    // Store confirmation request in memory for audit trail
    await this.agent.memoryManager.storeKnowledge(
      'email recipient confirmation',
      {
        searchTerm,
        matchedContact: contact.metadata.name,
        matchedEmail: contact.metadata.email,
        confidence,
        timestamp: new Date()
      }
    );

    // Create confirmation message
    const confirmData = {
      type: 'email_recipient_confirmation',
      searchTerm,
      matchedContact: {
        name: contact.metadata.name,
        email: contact.metadata.email,
        aliases: contact.metadata.aliases || []
      },
      confidence: Math.round(confidence * 100),
      message: `Found "${contact.metadata.name}" (${contact.metadata.email}) with ${Math.round(confidence * 100)}% confidence. Is this the correct recipient?`
    };

    return confirmData;
  }

  generateDidYouMean(searchTerm, candidates) {
    // Sort by score/relevance
    const suggestions = candidates
      .slice(0, 3) // Top 3 suggestions
      .map(c => ({
        name: c.contact.metadata.name,
        email: c.contact.metadata.email,
        confidence: Math.round((c.score || 0) * 100)
      }));

    return {
      type: 'did_you_mean',
      searchTerm,
      suggestions,
      message: `No exact match found for "${searchTerm}". Did you mean one of these contacts?`
    };
  }

  async resolveRecipient(searchTerm, requireHighConfidence = true) {
    try {
      // Check if it's an email address
      if (searchTerm?.includes('@')) {
        // Check if blocked
        if (this.isBlocked(searchTerm)) {
          throw new Error(`Cannot send email to blocked contact: ${searchTerm}`);
        }
        return { email: searchTerm, confidence: 1.0, needsConfirmation: false };
      }

      // Get all contacts using precise category filter instead of fuzzy text search
      // Prioritize personal contacts over agent contacts
      const { Memory } = await import('../models/Memory.js');
      const allContacts = await Memory.find({
        type: 'knowledge',
        'metadata.category': 'email_contacts'
      }).sort({ 
        "metadata.importance": -1, // Master/Self first (10), then personal (9), then agent (7)
        "metadata.relationship": 1, // Secondary sort: master, personal, agent_contact, self
        createdAt: -1 
      }).limit(500);
      
      logger.info(`Found ${allContacts.length} total contacts for resolution`);
      
      // Log a sample contact structure for debugging
      if (allContacts.length > 0) {
        const sampleContact = allContacts[0];
        logger.debug('Sample contact structure:', {
          hasMetadata: !!sampleContact.metadata,
          metadataKeys: sampleContact.metadata ? Object.keys(sampleContact.metadata) : [],
          hasEmail: !!sampleContact.metadata?.email,
          hasName: !!sampleContact.metadata?.name,
          category: sampleContact.metadata?.category
        });
      }

      // Search contacts
      const { exactMatches, fuzzyMatches } = await this.searchContacts(searchTerm, allContacts);
      
      logger.info(`Contact search results for "${searchTerm}":`, {
        exactMatches: exactMatches.length,
        fuzzyMatches: fuzzyMatches.length,
        topMatch: fuzzyMatches[0] ? {
          name: fuzzyMatches[0].contact?.metadata?.name,
          score: fuzzyMatches[0].score,
          matchedValue: fuzzyMatches[0].matchedValue
        } : null
      });

      // Handle exact matches
      if (exactMatches.length === 1) {
        const contact = exactMatches[0];
        if (this.isBlocked(contact.metadata.email)) {
          throw new Error(`Cannot send email to blocked contact: ${contact.metadata.name}`);
        }
        
        logger.info(`Found exact match: ${contact.metadata.name} <${contact.metadata.email}>`);
        return {
          email: contact.metadata.email,
          name: contact.metadata.name,
          confidence: 1.0,
          needsConfirmation: false,
          contact
        };
      } else if (exactMatches.length > 1) {
        // Multiple exact matches - this shouldn't happen but needs handling
        throw new Error(`Multiple contacts found with the exact name "${searchTerm}". Please use their email address instead.`);
      }

      // Handle fuzzy matches
      if (fuzzyMatches.length > 0) {
        let bestMatch = fuzzyMatches[0];
        
        // Check if blocked
        if (bestMatch.contact?.metadata?.email && this.isBlocked(bestMatch.contact.metadata.email)) {
          // Find next non-blocked match
          const nonBlockedMatch = fuzzyMatches.find(m => 
            m.contact?.metadata?.email && !this.isBlocked(m.contact.metadata.email)
          );
          if (!nonBlockedMatch) {
            throw new Error(`All matching contacts for "${searchTerm}" are blocked`);
          }
          bestMatch = nonBlockedMatch;
        }
        
        // Ensure we have valid contact data
        if (!bestMatch.contact?.metadata?.email) {
          logger.error('Best match missing contact email:', {
            searchTerm,
            bestMatch: {
              score: bestMatch.score,
              matchedValue: bestMatch.matchedValue,
              hasContact: !!bestMatch.contact,
              hasMetadata: !!bestMatch.contact?.metadata,
              hasEmail: !!bestMatch.contact?.metadata?.email
            }
          });
          throw new Error(`Contact match found for "${searchTerm}" but missing email address`);
        }

        // High confidence match (>85%)
        if (bestMatch.score > 0.85) {
          logger.info(`High confidence match: ${bestMatch.matchedValue} (${Math.round(bestMatch.score * 100)}%)`);
          return {
            email: bestMatch.contact.metadata.email,
            name: bestMatch.contact.metadata.name,
            confidence: bestMatch.score,
            needsConfirmation: false,
            contact: bestMatch.contact
          };
        }
        
        // Medium confidence (60-85%)
        if (bestMatch.score > 0.6) {
          // If high confidence is required, return with confirmation needed
          if (requireHighConfidence) {
            logger.warn(`Medium confidence match: ${bestMatch.matchedValue} (${Math.round(bestMatch.score * 100)}%)`);
            return {
              email: bestMatch.contact.metadata.email,
              name: bestMatch.contact.metadata.name,
              confidence: bestMatch.score,
              needsConfirmation: true,
              confirmationData: await this.confirmRecipient(bestMatch.contact, searchTerm, bestMatch.score),
              contact: bestMatch.contact
            };
          } else {
            // High confidence not required - accept medium confidence matches
            logger.info(`Accepting medium confidence match: ${bestMatch.matchedValue} (${Math.round(bestMatch.score * 100)}%)`);
            return {
              email: bestMatch.contact.metadata.email,
              name: bestMatch.contact.metadata.name,
              confidence: bestMatch.score,
              needsConfirmation: false,
              contact: bestMatch.contact
            };
          }
        }
        
        // Low confidence (<60%) - if not requiring high confidence, still use if >40%
        if (!requireHighConfidence && bestMatch.score > 0.4) {
          logger.info(`Accepting low confidence match due to requireHighConfidence=false: ${bestMatch.matchedValue} (${Math.round(bestMatch.score * 100)}%)`);
          return {
            email: bestMatch.contact.metadata.email,
            name: bestMatch.contact.metadata.name,
            confidence: bestMatch.score,
            needsConfirmation: false,
            contact: bestMatch.contact
          };
        }
        
        // Very low confidence - provide "did you mean" suggestions
        if (fuzzyMatches.length > 0) {
          return {
            email: null,
            name: null,
            confidence: bestMatch.score,
            needsConfirmation: true,
            didYouMean: this.generateDidYouMean(searchTerm, fuzzyMatches),
            suggestions: fuzzyMatches.slice(0, 3)
          };
        }
      }

      // No matches found
      throw new Error(`No contact found matching "${searchTerm}". Please check the name or provide an email address.`);

    } catch (error) {
      logger.error('Failed to resolve recipient:', error);
      throw error;
    }
  }
}
