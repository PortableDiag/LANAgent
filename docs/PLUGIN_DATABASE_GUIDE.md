# Plugin Database Usage Guide

## Overview

All LANAgent plugins must use MongoDB for data persistence instead of flat file storage. This ensures data consistency, better performance, and easier backups.

## Creating a MongoDB Model

1. Create your model file in `src/models/YourModel.js`:

```javascript
import mongoose from 'mongoose';

const yourSchema = new mongoose.Schema({
  // Define your fields
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: String,
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  },
  createdBy: String,
  updatedBy: String
}, {
  timestamps: true // Adds createdAt and updatedAt automatically
});

// Add indexes for better query performance
yourSchema.index({ name: 1 });
yourSchema.index({ status: 1 });

// Add instance methods if needed
yourSchema.methods.activate = function() {
  this.status = 'active';
  return this.save();
};

// Add static methods if needed
yourSchema.statics.findActive = function() {
  return this.find({ status: 'active' });
};

const YourModel = mongoose.model('YourModel', yourSchema);

export default YourModel;
```

2. Import and use in your plugin:

```javascript
import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import YourModel from '../../models/YourModel.js';

export default class YourPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'yourplugin';
    this.version = '1.0.0';
    this.description = 'Plugin that uses MongoDB for storage';
    this.commands = [
      {
        command: 'create',
        description: 'Create a new item',
        usage: 'create <name> [description]'
      },
      {
        command: 'list',
        description: 'List all items',
        usage: 'list [status]'
      }
    ];
  }

  async execute(params) {
    const { action } = params;
    
    try {
      switch(action) {
        case 'create':
          return await this.createItem(params);
        case 'list':
          return await this.listItems(params);
        default:
          return { 
            success: false, 
            error: 'Unknown action' 
          };
      }
    } catch (error) {
      logger.error('Plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async createItem(params) {
    const { name, description } = params;
    
    if (!name) {
      return { success: false, error: 'Name is required' };
    }
    
    try {
      const item = await YourModel.create({
        name,
        description,
        createdBy: 'agent'
      });
      
      return {
        success: true,
        result: `Created item: ${name}`,
        data: item
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create item: ${error.message}`
      };
    }
  }

  async listItems(params) {
    const { status = 'all' } = params;
    
    try {
      const query = status === 'all' ? {} : { status };
      const items = await YourModel.find(query)
        .sort({ createdAt: -1 })
        .limit(50);
      
      return {
        success: true,
        result: `Found ${items.length} items`,
        data: items
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list items: ${error.message}`
      };
    }
  }
}
```

## Best Practices

1. **Always use Mongoose models** - Never read/write to flat files for plugin data
2. **Add proper indexes** - Index fields that you'll query frequently
3. **Use timestamps** - Add `timestamps: true` to your schema for automatic tracking
4. **Handle errors gracefully** - Always wrap database operations in try-catch
5. **Validate data** - Use Mongoose schema validation for data integrity
6. **Limit query results** - Use `.limit()` to prevent loading too much data
7. **Use proper data types** - Choose appropriate Mongoose types for your fields

## Common Patterns

### Pagination
```javascript
const page = params.page || 1;
const limit = params.limit || 20;
const skip = (page - 1) * limit;

const items = await YourModel.find()
  .skip(skip)
  .limit(limit)
  .sort({ createdAt: -1 });
```

### Search
```javascript
const searchQuery = {
  $or: [
    { name: { $regex: params.search, $options: 'i' } },
    { description: { $regex: params.search, $options: 'i' } }
  ]
};
const results = await YourModel.find(searchQuery);
```

### Update with validation
```javascript
const item = await YourModel.findById(params.id);
if (!item) {
  return { success: false, error: 'Item not found' };
}

item.name = params.name || item.name;
item.updatedBy = 'agent';
await item.save();
```

## Migration from Flat Files

If you have an existing plugin using flat files, follow this pattern:

```javascript
async migrateOldData() {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const oldDataFile = path.join(process.cwd(), 'old-data.json');
    
    // Check if old file exists
    try {
      await fs.access(oldDataFile);
    } catch {
      return; // No old file to migrate
    }
    
    const data = await fs.readFile(oldDataFile, 'utf8');
    const oldData = JSON.parse(data);
    
    // Migrate each item
    for (const item of oldData.items) {
      await YourModel.create({
        ...item,
        createdBy: 'migration'
      });
    }
    
    // Rename old file to backup
    await fs.rename(oldDataFile, oldDataFile + '.migrated');
    logger.info('Migration completed successfully');
  } catch (error) {
    logger.error('Migration failed:', error);
  }
}
```

## Testing

When testing plugins with database operations:

1. Mock the model in your tests:
```javascript
jest.mock('../../models/YourModel.js', () => ({
  default: {
    create: jest.fn(),
    find: jest.fn(),
    findById: jest.fn()
  }
}));
```

2. Test database operations:
```javascript
test('should create item in database', async () => {
  YourModel.create.mockResolvedValue({ 
    _id: '123', 
    name: 'Test Item' 
  });
  
  const result = await plugin.createItem({ 
    name: 'Test Item' 
  });
  
  expect(YourModel.create).toHaveBeenCalled();
  expect(result.success).toBe(true);
});
```

## Need Help?

- Check existing plugins like `development.js` and `projects.js` for examples
- Review Mongoose documentation: https://mongoosejs.com/docs/
- Ask in development chat for assistance