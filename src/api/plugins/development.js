import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import DevelopmentPlan from '../../models/DevelopmentPlan.js';

export default class DevelopmentPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'development';
    this.version = '2.0.0';
    this.description = 'Development planning and feature management (MongoDB-based)';
    this.commands = [
      {
        command: 'plan',
        description: 'View development plans',
        usage: 'plan [view|stats]'
      },
      {
        command: 'feature',
        description: 'Manage feature requests',
        usage: 'feature [add|list|complete|tag|filter] <content>'
      },
      {
        command: 'edits',
        description: 'Manage planned code edits',
        usage: 'edits [add|list|complete|tag|filter] <content>'
      },
      {
        command: 'research',
        description: 'Manage research items',
        usage: 'research [add|list|complete|tag|filter] <content>'
      },
      {
        command: 'tags',
        description: 'List all tags used',
        usage: 'tags [list]'
      }
    ];
    
    // Check for and migrate old data on startup
    this.migrateOldData();
  }

  async execute(params) {
    const { action, subAction, content, priority, id, tags, status } = params;
    
    try {
      switch(action) {
        case 'plan':
          return await this.viewPlan(subAction);
          
        case 'feature':
          return await this.manageItems('feature', subAction, content, priority, id, tags, status);
          
        case 'edits':
          return await this.manageItems('edit', subAction, content, priority, id, tags, status);
          
        case 'research':
          return await this.manageItems('research', subAction, content, priority, id, tags, status);
          
        case 'tags':
          return await this.listAllTags();
          
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: plan, feature, edits, research, or tags' 
          };
      }
    } catch (error) {
      logger.error('Development plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async manageItems(type, subAction, content, priority = 'medium', id, tags = [], status) {
    switch(subAction) {
      case 'add':
        return await this.addItem(type, content, priority, tags);
        
      case 'list':
        return await this.listItems(type, status);
        
      case 'complete':
        return await this.completeItem(id || content);
        
      case 'delete':
        return await this.deleteItem(id || content);
        
      case 'tag':
        return await this.tagItem(id || content, tags);
        
      case 'untag':
        return await this.untagItem(id || content, tags);
        
      case 'filter':
        return await this.filterItems(type, tags, status);
        
      default:
        return await this.listItems(type);
    }
  }

  async addItem(type, content, priority, tags) {
    try {
      const item = await DevelopmentPlan.create({
        content,
        type,
        priority,
        tags: Array.isArray(tags) ? tags : tags ? [tags] : [],
        createdBy: 'agent'
      });
      
      return {
        success: true,
        result: `Added ${type}: ${content} (Priority: ${priority})`,
        item: {
          id: item._id,
          content: item.content,
          priority: item.priority,
          tags: item.tags
        }
      };
    } catch (error) {
      logger.error(`Failed to add ${type}:`, error);
      return {
        success: false,
        error: `Failed to add ${type}: ${error.message}`
      };
    }
  }

  async listItems(type, status = 'pending') {
    try {
      const query = { type };
      if (status !== 'all') {
        query.status = status;
      }
      
      const items = await DevelopmentPlan.find(query)
        .sort({ priority: -1, createdAt: -1 })
        .limit(100);
      
      if (items.length === 0) {
        return {
          success: true,
          result: `No ${status} ${type}s found`,
          items: []
        };
      }
      
      const formatted = items.map(item => 
        `• [${item.priority.toUpperCase()}] ${item.content}${item.tags.length ? ` (${item.tags.join(', ')})` : ''} - ${item._id}`
      ).join('\n');
      
      return {
        success: true,
        result: `${type.charAt(0).toUpperCase() + type.slice(1)}s (${status}):\n${formatted}`,
        items: items.map(item => ({
          id: item._id,
          content: item.content,
          priority: item.priority,
          tags: item.tags,
          status: item.status,
          createdAt: item.createdAt
        }))
      };
    } catch (error) {
      logger.error(`Failed to list ${type}s:`, error);
      return {
        success: false,
        error: `Failed to list ${type}s: ${error.message}`
      };
    }
  }

  async completeItem(identifier) {
    try {
      // Try to find by ID first, then by content
      let item = await DevelopmentPlan.findById(identifier).catch(() => null);
      if (!item) {
        item = await DevelopmentPlan.findOne({ 
          content: { $regex: identifier, $options: 'i' },
          status: { $ne: 'completed' }
        });
      }
      
      if (!item) {
        return {
          success: false,
          error: 'Item not found'
        };
      }
      
      item.status = 'completed';
      item.completedAt = new Date();
      item.updatedBy = 'agent';
      await item.save();
      
      return {
        success: true,
        result: `Completed ${item.type}: ${item.content}`
      };
    } catch (error) {
      logger.error('Failed to complete item:', error);
      return {
        success: false,
        error: `Failed to complete item: ${error.message}`
      };
    }
  }

  async deleteItem(identifier) {
    try {
      // Try to find by ID first, then by content
      let item = await DevelopmentPlan.findById(identifier).catch(() => null);
      if (!item) {
        item = await DevelopmentPlan.findOne({ 
          content: { $regex: identifier, $options: 'i' }
        });
      }
      
      if (!item) {
        return {
          success: false,
          error: 'Item not found'
        };
      }
      
      await item.deleteOne();
      
      return {
        success: true,
        result: `Deleted ${item.type}: ${item.content}`
      };
    } catch (error) {
      logger.error('Failed to delete item:', error);
      return {
        success: false,
        error: `Failed to delete item: ${error.message}`
      };
    }
  }

  async tagItem(identifier, tags) {
    try {
      let item = await DevelopmentPlan.findById(identifier).catch(() => null);
      if (!item) {
        item = await DevelopmentPlan.findOne({ 
          content: { $regex: identifier, $options: 'i' }
        });
      }
      
      if (!item) {
        return {
          success: false,
          error: 'Item not found'
        };
      }
      
      // Add tags (avoiding duplicates)
      const tagsArray = Array.isArray(tags) ? tags : [tags];
      item.tags = [...new Set([...item.tags, ...tagsArray])];
      item.updatedBy = 'agent';
      await item.save();
      
      return {
        success: true,
        result: `Tagged ${item.type}: ${item.content} with ${tagsArray.join(', ')}`
      };
    } catch (error) {
      logger.error('Failed to tag item:', error);
      return {
        success: false,
        error: `Failed to tag item: ${error.message}`
      };
    }
  }

  async untagItem(identifier, tags) {
    try {
      let item = await DevelopmentPlan.findById(identifier).catch(() => null);
      if (!item) {
        item = await DevelopmentPlan.findOne({ 
          content: { $regex: identifier, $options: 'i' }
        });
      }
      
      if (!item) {
        return {
          success: false,
          error: 'Item not found'
        };
      }
      
      // Remove tags
      const tagsArray = Array.isArray(tags) ? tags : [tags];
      item.tags = item.tags.filter(tag => !tagsArray.includes(tag));
      item.updatedBy = 'agent';
      await item.save();
      
      return {
        success: true,
        result: `Removed tags from ${item.type}: ${item.content}`
      };
    } catch (error) {
      logger.error('Failed to untag item:', error);
      return {
        success: false,
        error: `Failed to untag item: ${error.message}`
      };
    }
  }

  async filterItems(type, tags, status = 'pending') {
    try {
      const query = {};
      if (type !== 'all') {
        query.type = type;
      }
      if (status !== 'all') {
        query.status = status;
      }
      if (tags && tags.length > 0) {
        const tagsArray = Array.isArray(tags) ? tags : [tags];
        query.tags = { $in: tagsArray };
      }
      
      const items = await DevelopmentPlan.find(query)
        .sort({ priority: -1, createdAt: -1 })
        .limit(100);
      
      if (items.length === 0) {
        return {
          success: true,
          result: 'No matching items found',
          items: []
        };
      }
      
      const formatted = items.map(item => 
        `• [${item.type.toUpperCase()}/${item.priority.toUpperCase()}] ${item.content}${item.tags.length ? ` (${item.tags.join(', ')})` : ''} - ${item._id}`
      ).join('\n');
      
      return {
        success: true,
        result: `Filtered results:\n${formatted}`,
        items: items.map(item => ({
          id: item._id,
          type: item.type,
          content: item.content,
          priority: item.priority,
          tags: item.tags,
          status: item.status,
          createdAt: item.createdAt
        }))
      };
    } catch (error) {
      logger.error('Failed to filter items:', error);
      return {
        success: false,
        error: `Failed to filter items: ${error.message}`
      };
    }
  }

  async listAllTags() {
    try {
      // Aggregate to get unique tags with counts
      const tagStats = await DevelopmentPlan.aggregate([
        { $unwind: '$tags' },
        { $group: { 
          _id: '$tags', 
          count: { $sum: 1 },
          types: { $addToSet: '$type' }
        }},
        { $sort: { count: -1 } }
      ]);
      
      if (tagStats.length === 0) {
        return {
          success: true,
          result: 'No tags found',
          tags: []
        };
      }
      
      const formatted = tagStats.map(tag => 
        `• ${tag._id}: ${tag.count} items (${tag.types.join(', ')})`
      ).join('\n');
      
      return {
        success: true,
        result: `Tags in use:\n${formatted}`,
        tags: tagStats.map(tag => ({
          tag: tag._id,
          count: tag.count,
          types: tag.types
        }))
      };
    } catch (error) {
      logger.error('Failed to list tags:', error);
      return {
        success: false,
        error: `Failed to list tags: ${error.message}`
      };
    }
  }

  async viewPlan(subAction = 'stats') {
    try {
      if (subAction === 'stats') {
        // Get statistics
        const stats = await DevelopmentPlan.aggregate([
          {
            $group: {
              _id: {
                type: '$type',
                status: '$status'
              },
              count: { $sum: 1 }
            }
          },
          {
            $group: {
              _id: '$_id.type',
              statuses: {
                $push: {
                  status: '$_id.status',
                  count: '$count'
                }
              },
              total: { $sum: '$count' }
            }
          }
        ]);
        
        const formatted = stats.map(stat => {
          const statusBreakdown = stat.statuses.map(s => `${s.status}: ${s.count}`).join(', ');
          return `${stat._id}: ${stat.total} total (${statusBreakdown})`;
        }).join('\n');
        
        return {
          success: true,
          result: `Development Plan Statistics:\n${formatted}`,
          stats
        };
      }
      
      // Default view - show recent items
      const recentItems = await DevelopmentPlan.find({ status: 'pending' })
        .sort({ createdAt: -1 })
        .limit(10);
      
      const formatted = recentItems.map(item => 
        `• [${item.type.toUpperCase()}/${item.priority.toUpperCase()}] ${item.content}`
      ).join('\n');
      
      return {
        success: true,
        result: `Recent development items:\n${formatted}`,
        items: recentItems
      };
    } catch (error) {
      logger.error('Failed to view plan:', error);
      return {
        success: false,
        error: `Failed to view plan: ${error.message}`
      };
    }
  }

  /**
   * Migrate old file-based data to MongoDB if it exists
   */
  async migrateOldData() {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const oldDataFile = path.join(process.cwd(), 'development-plan.json');
      
      // Check if old file exists
      try {
        await fs.access(oldDataFile);
      } catch {
        return; // No old file to migrate
      }
      
      const data = await fs.readFile(oldDataFile, 'utf8');
      const oldPlan = JSON.parse(data);
      
      logger.info('Migrating old development plan data to MongoDB...');
      
      let migratedCount = 0;
      
      // Helper function to extract priority from old format
      const extractPriority = (item) => {
        if (typeof item === 'string') return 'medium';
        return item.priority || 'medium';
      };
      
      // Helper function to extract content from old format
      const extractContent = (item) => {
        if (typeof item === 'string') return item;
        return item.content || item.description || item;
      };
      
      // Migrate features
      for (const feature of oldPlan.features || []) {
        await DevelopmentPlan.create({
          content: extractContent(feature),
          type: 'feature',
          priority: extractPriority(feature),
          tags: feature.tags || [],
          status: feature.status === 'completed' ? 'completed' : 'pending',
          createdBy: 'migration'
        });
        migratedCount++;
      }
      
      // Migrate edits
      for (const edit of oldPlan.edits || []) {
        await DevelopmentPlan.create({
          content: extractContent(edit),
          type: 'edit',
          priority: extractPriority(edit),
          tags: edit.tags || [],
          status: edit.status === 'applied' ? 'completed' : 'pending',
          createdBy: 'migration'
        });
        migratedCount++;
      }
      
      // Migrate research items
      for (const research of oldPlan.research || []) {
        await DevelopmentPlan.create({
          content: extractContent(research),
          type: 'research',
          priority: extractPriority(research),
          tags: research.tags || [],
          status: 'pending',
          createdBy: 'migration'
        });
        migratedCount++;
      }
      
      // Migrate completed items
      for (const completed of oldPlan.completed || []) {
        await DevelopmentPlan.create({
          content: extractContent(completed),
          type: completed.type || 'feature',
          priority: extractPriority(completed),
          tags: completed.tags || [],
          status: 'completed',
          completedAt: completed.completedAt || new Date(),
          createdBy: 'migration'
        });
        migratedCount++;
      }
      
      // Rename old file to backup
      await fs.rename(oldDataFile, oldDataFile + '.migrated');
      logger.info(`Migration completed successfully. Migrated ${migratedCount} items.`);
    } catch (error) {
      logger.error('Failed to migrate old development data:', error);
    }
  }
}