import { validateJsonSchema } from '../utils/jsonUtils.js';
import { logger } from '../utils/logger.js';

/**
 * Pre-defined JSON schemas for structured output parsing
 * Used with StructuredOutputParser for validating LLM responses
 */

/**
 * Intent detection schema - used by aiIntentDetector
 */
export const intentSchema = {
  type: 'object',
  properties: {
    plugin: {
      type: 'string',
      description: 'The plugin to execute'
    },
    action: {
      type: 'string',
      description: 'The specific action within the plugin'
    },
    params: {
      type: 'object',
      description: 'Parameters for the action',
      additionalProperties: true
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence level of the detection (0-1)'
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of why this intent was detected'
    }
  },
  required: ['plugin', 'action']
};

/**
 * Chain analysis schema - used by pluginChainProcessor
 */
export const chainAnalysisSchema = {
  type: 'object',
  properties: {
    isMultiStep: {
      type: 'boolean',
      description: 'Whether this task requires multiple steps'
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stepNumber: {
            type: 'integer',
            minimum: 1
          },
          description: {
            type: 'string',
            description: 'What this step accomplishes'
          },
          plugin: {
            type: 'string',
            description: 'Plugin to use for this step'
          },
          action: {
            type: 'string',
            description: 'Action to execute'
          },
          params: {
            type: 'object',
            additionalProperties: true
          },
          passDataToNext: {
            type: 'boolean',
            default: false,
            description: 'Whether to pass output to next step'
          },
          useSharedData: {
            type: 'boolean',
            default: false,
            description: 'Whether to use data from previous steps'
          },
          required: {
            type: 'boolean',
            default: true,
            description: 'Whether this step must succeed'
          }
        },
        required: ['stepNumber', 'description', 'plugin', 'action']
      }
    },
    summary: {
      type: 'string',
      description: 'Brief summary of the overall task'
    }
  },
  required: ['isMultiStep']
};

/**
 * Reminder parameters schema
 */
export const reminderParamsSchema = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'The reminder message'
    },
    minutes: {
      type: 'number',
      minimum: 1,
      description: 'Minutes from now to trigger reminder'
    },
    notificationMethod: {
      type: 'string',
      enum: ['telegram', 'email', 'both'],
      default: 'telegram'
    }
  },
  required: ['message', 'minutes']
};

/**
 * Email parameters schema
 */
export const emailParamsSchema = {
  type: 'object',
  properties: {
    to: {
      type: 'string',
      format: 'email',
      description: 'Recipient email address'
    },
    subject: {
      type: 'string',
      description: 'Email subject'
    },
    body: {
      type: 'string',
      description: 'Email body content'
    },
    cc: {
      type: 'string',
      format: 'email',
      description: 'CC recipient'
    },
    attachments: {
      type: 'array',
      items: { type: 'string' },
      description: 'File paths to attach'
    }
  },
  required: ['to']
};

/**
 * Search parameters schema
 */
export const searchParamsSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search query'
    },
    type: {
      type: 'string',
      enum: ['web', 'news', 'images', 'videos'],
      default: 'web'
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 10
    }
  },
  required: ['query']
};

/**
 * Task parameters schema
 */
export const taskParamsSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Task title'
    },
    description: {
      type: 'string',
      description: 'Task description'
    },
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium'
    },
    dueDate: {
      type: 'string',
      description: 'Due date (ISO format or natural language)'
    },
    tags: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['title']
};

/**
 * ReAct thought schema - used by reasoning agent
 */
export const reactThoughtSchema = {
  type: 'object',
  properties: {
    thought: {
      type: 'string',
      description: 'Current reasoning about the situation'
    },
    action: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Tool/plugin to use'
        },
        input: {
          type: 'object',
          additionalProperties: true,
          description: 'Input parameters for the tool'
        }
      }
    },
    finalAnswer: {
      type: 'string',
      description: 'Final answer if task is complete (null if more steps needed)'
    }
  },
  required: ['thought']
};

/**
 * Plan schema - used by plan-execute agent
 */
export const planSchema = {
  type: 'object',
  properties: {
    objective: {
      type: 'string',
      description: 'The main objective to achieve'
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique step identifier'
          },
          action: {
            type: 'string',
            description: 'Description of the action'
          },
          tool: {
            type: 'string',
            description: 'Tool/plugin to use'
          },
          params: {
            type: 'object',
            additionalProperties: true
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of steps this depends on'
          }
        },
        required: ['id', 'action', 'tool']
      }
    },
    expectedOutcome: {
      type: 'string',
      description: 'What success looks like'
    }
  },
  required: ['objective', 'steps']
};

/**
 * System info parameters schema
 */
export const systemInfoParamsSchema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['cpu', 'memory', 'disk', 'network', 'processes', 'all'],
      default: 'all'
    },
    detailed: {
      type: 'boolean',
      default: false
    }
  }
};

/**
 * Git parameters schema
 */
export const gitParamsSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'log', 'diff', 'branch', 'commit', 'push', 'pull'],
      description: 'Git operation to perform'
    },
    message: {
      type: 'string',
      description: 'Commit message (for commit action)'
    },
    branch: {
      type: 'string',
      description: 'Branch name'
    },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files to stage'
    }
  },
  required: ['action']
};

/**
 * Crypto/Web search parameters schema
 */
export const cryptoSearchParamsSchema = {
  type: 'object',
  properties: {
    symbol: {
      type: 'string',
      description: 'Cryptocurrency symbol (e.g., BTC, ETH)'
    },
    currency: {
      type: 'string',
      default: 'USD',
      description: 'Fiat currency for conversion'
    },
    action: {
      type: 'string',
      enum: ['price', 'chart', 'info', 'news'],
      default: 'price'
    }
  },
  required: ['symbol']
};

/**
 * Document ingestion parameters schema (for RAG)
 */
export const documentIngestSchema = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      description: 'File path or URL to ingest'
    },
    type: {
      type: 'string',
      enum: ['text', 'pdf', 'web', 'markdown', 'json', 'auto'],
      default: 'auto'
    },
    chunkSize: {
      type: 'integer',
      minimum: 100,
      maximum: 10000,
      default: 1000
    },
    chunkOverlap: {
      type: 'integer',
      minimum: 0,
      maximum: 500,
      default: 200
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Additional metadata to attach to chunks'
    }
  },
  required: ['source']
};

/**
 * Collection of all schemas for easy import
 */
export const schemas = {
  intent: intentSchema,
  chainAnalysis: chainAnalysisSchema,
  reminder: reminderParamsSchema,
  email: emailParamsSchema,
  search: searchParamsSchema,
  task: taskParamsSchema,
  reactThought: reactThoughtSchema,
  plan: planSchema,
  systemInfo: systemInfoParamsSchema,
  git: gitParamsSchema,
  cryptoSearch: cryptoSearchParamsSchema,
  documentIngest: documentIngestSchema
};

/**
 * Permissions map for dynamic schema adjustments
 */
const permissionsMap = {
  admin: {
    task: {
      properties: {
        priority: {
          enum: ['low', 'medium', 'high', 'urgent', 'critical']
        }
      }
    }
  },
  user: {
    task: {
      properties: {
        priority: {
          enum: ['low', 'medium', 'high']
        }
      }
    }
  }
};

/**
 * Dynamically adjust schema properties based on runtime conditions
 * @param {string} schemaName - The name of the schema to adjust
 * @param {object} context - The runtime context for adjustments
 * @returns {object} - The adjusted schema
 */
export function adjustSchema(schemaName, context) {
  const schema = schemas[schemaName];
  if (!schema) {
    logger.error(`Schema ${schemaName} not found`);
    throw new Error(`Schema ${schemaName} not found`);
  }

  const adjustedSchema = JSON.parse(JSON.stringify(schema));

  const rolePermissions = permissionsMap[context.userRole];
  if (rolePermissions && rolePermissions[schemaName]) {
    Object.assign(adjustedSchema.properties, rolePermissions[schemaName].properties);
  }

  if (context.pluginConfig && context.pluginConfig[schemaName]) {
    Object.assign(adjustedSchema.properties, context.pluginConfig[schemaName]);
  }

  return adjustedSchema;
}

/**
 * Validate data against a dynamically adjusted schema
 * @param {string} schemaName - The name of the schema to validate against
 * @param {object} data - The data to validate
 * @param {object} context - The runtime context for schema adjustments
 * @returns {boolean} - True if valid, false otherwise
 */
export function validateData(schemaName, data, context) {
  const adjustedSchema = adjustSchema(schemaName, context);
  const validationResult = validateJsonSchema(data, adjustedSchema);
  if (!validationResult.valid) {
    logger.error(`Validation failed for schema ${schemaName}: ${validationResult.errors}`);
  }
  return validationResult.valid;
}

export default schemas;