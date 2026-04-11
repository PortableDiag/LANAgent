#!/usr/bin/env node

// Simple migration script that just moves GitHub features to the new collection

const MongoClient = require('mongodb').MongoClient;

async function migrate() {
  const client = await MongoClient.connect('mongodb://localhost:27017');
  
  try {
    const lanagentDb = client.db('lanagent');
    const aliceDb = client.db('alice-assistant');
    
    // Get GitHub features from lanagent database
    const features = await lanagentDb.collection('featureRequests').find({
      submittedBy: { $in: ['github_discovery', 'github_discovery_scheduler'] }
    }).toArray();
    
    console.log(`Found ${features.length} GitHub features to migrate`);
    
    if (features.length === 0) {
      console.log('No features to migrate');
      return;
    }
    
    // Transform and insert into alice-assistant database
    let migrated = 0;
    let skipped = 0;
    
    for (const f of features) {
      try {
        // Extract repository info from description
        let repository = 'unknown';
        const repoMatch = f.description?.match(/from GitHub project ([^\.]+)/);
        if (repoMatch) {
          repository = repoMatch[1].trim();
        }
        
        // Create discovered feature document
        const discoveredFeature = {
          title: f.title,
          description: f.description || '',
          type: 'readme_feature',
          source: {
            repository: repository,
            url: f.githubReferences?.[0]?.url || 'https://github.com',
            filePath: f.githubReferences?.[0]?.filePath,
            language: f.githubReferences?.[0]?.language || 'javascript'
          },
          implementation: {
            suggestion: f.implementation || '',
            confidence: f.confidence || 'medium',
            targetFile: f.implementationFile,
            estimatedEffort: 'medium'
          },
          codeSnippets: [],
          status: 'discovered',
          discoveredBy: f.submittedBy,
          priority: 0,
          tags: ['github', 'migrated'],
          createdAt: f.createdAt || new Date(),
          updatedAt: f.updatedAt || new Date()
        };
        
        // Add code snippets if available
        if (f.githubReferences && f.githubReferences.length > 0) {
          for (const ref of f.githubReferences) {
            if (ref.codeSnippet) {
              discoveredFeature.codeSnippets.push({
                code: ref.codeSnippet.substring(0, 10000),
                language: ref.language || 'javascript',
                filePath: ref.filePath,
                contextNotes: ref.contextNotes
              });
            }
          }
        }
        
        // Generate fingerprint
        const crypto = require('crypto');
        const fingerprintData = `${discoveredFeature.source.repository}-${discoveredFeature.title}-${discoveredFeature.type}`;
        discoveredFeature.fingerprint = crypto.createHash('sha256').update(fingerprintData).digest('hex');
        
        // Insert into new collection
        await aliceDb.collection('discoveredFeatures').insertOne(discoveredFeature);
        
        // Delete from old collection
        await lanagentDb.collection('featureRequests').deleteOne({ _id: f._id });
        
        migrated++;
        console.log(`Migrated: ${f.title}`);
      } catch (err) {
        console.error(`Failed to migrate "${f.title}":`, err.message);
        skipped++;
      }
    }
    
    console.log(`\nMigration complete:`);
    console.log(`- Migrated: ${migrated}`);
    console.log(`- Skipped: ${skipped}`);
    
  } finally {
    await client.close();
  }
}

migrate().catch(console.error);