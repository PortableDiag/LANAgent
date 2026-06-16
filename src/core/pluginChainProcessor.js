import { logger } from '../utils/logger.js';
import { StructuredOutputParser } from '../services/outputParser.js';
import { schemas } from '../services/outputSchemas.js';

/**
 * Plugin Chain Processor
 * Handles multi-step tasks by breaking them down into sequential plugin operations
 */
export class PluginChainProcessor {
  constructor(agent) {
    this.agent = agent;
    this.maxSteps = 5; // Prevent infinite loops
    this.stepTimeout = 60000; // 60 seconds per step
    this.activeChains = new Map(); // Track active chain executions
    this.maxConcurrentChains = 3; // Limit concurrent chains
    this.pluginLocks = new Map(); // Plugin-level locks for coordination

    // Initialize structured output parser for chain analysis
    this.chainAnalysisParser = new StructuredOutputParser(schemas.chainAnalysis);
  }

  /**
   * Parse chain analysis response with optional schema validation
   */
  parseChainAnalysis(text) {
    try {
      return this.chainAnalysisParser.parse(text);
    } catch (error) {
      logger.debug(`Structured chain parsing failed: ${error.message}`);
      // Fallback to basic JSON extraction
      const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : text;
      return JSON.parse(jsonStr);
    }
  }

  /**
   * Analyze a complex request and determine if it requires multiple steps
   * @param {string} input - User input text
   * @param {Object} context - Context including userId for conversation history
   * @returns {Object} Analysis result with steps if multi-step task detected
   */
  async analyzeComplexTask(input, context = {}) {
    try {
      logger.info(`Analyzing complex task: "${input}"`);

      // Get recent conversation context if available
      let conversationContext = '';
      if (context.userId && this.agent.memoryManager) {
        try {
          const recentConversations = await this.agent.memoryManager.getConversationContext(context.userId, 5);
          if (recentConversations?.length) {
            conversationContext = '\n\nRecent conversation history (for context - use this to understand references like "that file", "the video", "try again", etc.):\n';
            for (const conv of recentConversations.slice().reverse()) {
              const role = conv.metadata?.role || 'user';
              const message = conv.content?.substring(0, 300);
              conversationContext += `${role}: ${message}\n`;
            }
            conversationContext += '\nIMPORTANT: If the user refers to something from the conversation above (like "send me the file", "try again", etc.), use the relevant information (URLs, filenames, etc.) from that context.\n';
          }
        } catch (err) {
          logger.debug('Could not get conversation context for task analysis:', err);
        }
      }

      const analysisPrompt = `Analyze this user request and determine if it requires multiple sequential steps using different tools/plugins:

"${input}"
${conversationContext}
Available plugins and their capabilities:
- websearch: Search web (action: "search"), crypto prices (action: "crypto"), stock prices (action: "stock"), weather (action: "weather")
- ytdlp: Download videos/audio from YouTube and 1000+ sites
- ffmpeg: Convert, compress, trim video/audio files
- email: Send emails (use sendWithAI for AI-composed emails), manage contacts
- tasks: Create, manage, complete tasks
- git: Version control operations
- system: System information, commands, reminders
- scraper: Web scraping (action: "scrape"), screenshots (action: "screenshot"), PDF generation (action: "pdf")
- network: Network scanning, ping, port checks
- software: Install/uninstall packages
- calendar: Google Calendar via CalDAV - get today's events (action: "getToday"), get upcoming events (action: "getUpcoming", params: {days, limit}), search events (action: "searchEvents", params: {query, startDate}), get events in range (action: "getEvents", params: {startDate, endDate, limit}), create event (action: "createEvent", params: {title, start, end, description}), update event (action: "updateEvent", params: {eventId, updates}), delete event (action: "deleteEvent", params: {eventId}), check availability (action: "checkAvailability", params: {date, duration, startHour, endHour}), list calendars (action: "listCalendars"), status (action: "status"). For checking trips/plans use "searchEvents" or "getEvents" with a date range.
- govee: Smart home device control - list ALL devices (action: "list"), device status (action: "status", params: {device}), power on/off/toggle (action: "power", params: {device, state}), brightness (action: "brightness", params: {device, level}), color (action: "color", params: {device, color}), temperature (action: "temperature", params: {device, kelvin}), scenes (action: "scene", params: {device, scene}), schedules (action: "schedules", params: {operation: "create"|"update"|"delete"|"list", device, time: "HH:MM", action: "on"|"off"|"color"|"brightness", value, repeat: "daily"|"weekdays"|"weekends"|"once"}). For schedule changes use action "schedules" with appropriate operation. IMPORTANT: For "list all devices" use action "list", NOT "status".

IMPORTANT: Use only the action names shown above. For example:
- For bitcoin price: plugin: "websearch", action: "crypto", params: { "symbol": "BTC" }
- NOT: action: "websearch.getCryptoPrice" or action: "getCryptoPrice"

If this requires multiple steps, respond with JSON in this format:
{
  "isMultiStep": true,
  "steps": [
    {
      "stepNumber": 1,
      "description": "Brief description of step",
      "plugin": "plugin_name",
      "action": "action_name",
      "params": { "key": "value" },
      "waitForCompletion": true/false,
      "passDataToNext": "description of what data to pass"
    }
  ],
  "reasoning": "Why this needs multiple steps"
}

If it's a single-step task, respond with:
{
  "isMultiStep": false,
  "singleIntent": "description"
}

Examples of multi-step tasks:
- "Download latest music video and send to me" = download + email
- "Search for bitcoin price and create a task to check it daily" = search + task creation
- "Take screenshot of website and email it to john" = scrape + email
- "Search for a fact and email it" = search + email (use sendWithAI with prompt)

Examples of single-step tasks:
- "Generate a PDF from https://example.com" = scraper plugin with action: "pdf"
- "Generate and send me a pdf of https://example.com" = scraper plugin with action: "pdf" (PDF is automatically sent via Telegram when requested through Telegram)
- "Take a screenshot of https://example.com" = scraper plugin with action: "screenshot"
- "Scrape https://example.com" = scraper plugin with action: "scrape"
- "Make my master toilet light red" = govee plugin with action: "color" (device name resolution is automatic)
- "Turn on the living room light" = govee plugin with action: "power" (single device command)
- "Toggle the kitchen lights" = govee plugin with action: "power" (toggle is a power state)
- "Set bedroom light brightness to 50" = govee plugin with action: "brightness"
- "Set up a schedule for kitchen lights at 7 PM" = govee plugin with action: "schedules"
- "Change my toilet schedule to red instead of blue" = govee plugin with action: "schedules"
- "List my govee schedules" = govee plugin with action: "schedules"
- "List my govee devices" = govee plugin with action: "list" (NOT system plugin)
- "Check my calendar for today" = calendar plugin with action: "getToday"
- "What's on my calendar this week" = calendar plugin with action: "getUpcoming", params: { "days": 7 }
- "Check my Olympics trip on the calendar" = calendar plugin with action: "searchEvents", params: { "query": "Olympics" }
- "Do I have any events tomorrow" = calendar plugin with action: "getUpcoming", params: { "days": 1 }

IMPORTANT: Govee device commands (list, status, power, color, brightness, temperature, scene, schedules) are ALWAYS single-step. The plugin handles device name resolution internally. Do NOT decompose them into "list devices first, then control" - that is wrong. "List my devices" = govee action "list", NOT system plugin.

IMPORTANT: Calendar queries are ALWAYS single-step. Do NOT decompose "check my calendar" into multiple steps. Use the calendar plugin directly with the appropriate action (getToday, getUpcoming, searchEvents, getEvents, etc.).

IMPORTANT FILE DELIVERY RULES:
- When a user asks to "send me" or "send me the file" while using Telegram, it's a SINGLE-STEP task
- Downloaded files (from ytdlp, scraper, etc.) are AUTOMATICALLY sent back through Telegram - NO email step needed
- For "download X and send me" requests via Telegram: ONLY the download step is needed
- Only add an email step if the user EXPLICITLY says "email" or mentions an email recipient
- "send me here", "send in telegram", "send to telegram" = single download step only

Important: For email steps:
- Use action "sendWithAI" with a "prompt" parameter describing what to send
- OR use action "send" with "text" or "html" parameter containing the content
- ALWAYS include "to" parameter with the recipient (extract from phrases like "email to John", "send to Alice", etc.)
- If a name is mentioned (e.g., "Whalley"), use that as the "to" parameter
- Set "useSharedData": true on the email step to use data from previous steps
- Set "passDataToNext": true on previous steps that gather data for the email
- Include a "subject" parameter if you can infer one from the request

CRITICAL for data passing:
- When gathering information for an email (like bitcoin price, weather, etc):
  Step 1: Set "passDataToNext": true 
  Step 2: Set "useSharedData": true on the email step
  This ensures the actual data is sent, not placeholders!

Example email step with recipient:
{
  "stepNumber": 2,
  "description": "Email the information to recipient",
  "plugin": "email",
  "action": "sendWithAI",
  "params": { 
    "to": "John",  // or "john@example.com" if email provided
    "prompt": "Send the search results",
    "subject": "Information you requested"
  },
  "useSharedData": true  // CRITICAL: This uses data from previous steps
}

Example for "send me an email with bitcoin price":
[
  {
    "stepNumber": 1,
    "description": "Get the current price of bitcoin",
    "plugin": "websearch",
    "action": "crypto",
    "params": { "symbol": "BTC" },
    "passDataToNext": true  // CRITICAL: Pass the price to next step
  },
  {
    "stepNumber": 2,
    "description": "Send email with bitcoin price",
    "plugin": "email",
    "action": "sendWithAI",
    "params": {
      "to": "me",
      "prompt": "Send the bitcoin price information from the previous step",
      "subject": "Current Bitcoin Price Update"
    },
    "useSharedData": true  // CRITICAL: Use the price from step 1
  }
]

Analyze the request:`;

      const response = await this.agent.providerManager.generateResponse(analysisPrompt, {
        maxTokens: 800,
        temperature: 0.3
      });

      // Parse JSON response with structured parser
      const content = response.content.trim();
      let analysis;

      try {
        analysis = this.parseChainAnalysis(content);
      } catch (parseError) {
        logger.warn('Failed to parse JSON analysis, treating as single step:', parseError.message);
        return { isMultiStep: false, singleIntent: 'analysis_parse_failed' };
      }

      logger.info(`Task analysis result:`, {
        isMultiStep: analysis.isMultiStep,
        stepsCount: analysis.steps?.length || 0
      });

      return analysis;

    } catch (error) {
      logger.error('Complex task analysis error:', error);
      return { isMultiStep: false, singleIntent: 'analysis_failed' };
    }
  }

  /**
   * Acquire a lock for a plugin to prevent concurrent conflicts
   * @param {string} pluginName - Name of the plugin
   * @returns {Promise<Function>} Release function
   */
  async acquirePluginLock(pluginName) {
    if (!this.pluginLocks.has(pluginName)) {
      this.pluginLocks.set(pluginName, { locked: false, queue: [] });
    }

    const lock = this.pluginLocks.get(pluginName);
    
    if (lock.locked) {
      // Wait for lock to be available
      await new Promise(resolve => lock.queue.push(resolve));
    }

    lock.locked = true;

    // Return release function
    return () => {
      lock.locked = false;
      if (lock.queue.length > 0) {
        const next = lock.queue.shift();
        next();
      }
    };
  }

  /**
   * Check if we can execute a new chain
   * @returns {boolean} Whether a new chain can start
   */
  canExecuteChain() {
    return this.activeChains.size < this.maxConcurrentChains;
  }

  /**
   * Execute a chain of plugin operations
   * @param {Array} steps - Array of step objects
   * @param {Object} context - Execution context
   * @returns {Object} Chain execution result
   */
  async executeChain(steps, context = {}) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('Invalid steps array');
    }

    if (steps.length > this.maxSteps) {
      throw new Error(`Too many steps (${steps.length}). Maximum allowed: ${this.maxSteps}`);
    }

    // Check concurrent chain limit
    if (!this.canExecuteChain()) {
      throw new Error(`Maximum concurrent chains (${this.maxConcurrentChains}) reached. Please try again later.`);
    }

    const chainId = `chain_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    logger.info(`Executing plugin chain ${chainId} with ${steps.length} steps`);

    // Register this chain as active
    this.activeChains.set(chainId, {
      startTime: Date.now(),
      steps: steps.length,
      context
    });

    const results = [];
    let sharedData = {}; // Data passed between steps
    let overallSuccess = true;

    try {
      for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNumber = i + 1;
      
      try {
        logger.info(`Executing step ${stepNumber}/${steps.length}: ${step.description}`);

        // Set timeout for this step
        const stepPromise = this.executeStep(step, sharedData, context);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Step ${stepNumber} timeout`)), this.stepTimeout)
        );

        const stepResult = await Promise.race([stepPromise, timeoutPromise]);

        results.push({
          stepNumber,
          description: step.description,
          plugin: step.plugin,
          action: step.action,
          success: stepResult.success,
          result: stepResult.result || stepResult,
          error: stepResult.error,
          executionTime: stepResult.executionTime
        });

        // Update shared data if step specifies data passing
        if (step.passDataToNext && stepResult.success) {
          sharedData[`step${stepNumber}`] = stepResult;
          if (stepResult.outputData) {
            Object.assign(sharedData, stepResult.outputData);
          }
        }

        // Check if we should continue
        if (!stepResult.success) {
          overallSuccess = false;
          if (step.required !== false) {
            logger.error(`Required step ${stepNumber} failed, stopping chain execution`);
            break;
          }
        }

        // Add small delay between steps to prevent overload
        if (i < steps.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        logger.error(`Step ${stepNumber} execution error:`, error);
        results.push({
          stepNumber,
          description: step.description,
          plugin: step.plugin,
          action: step.action,
          success: false,
          error: error.message,
          executionTime: 0
        });
        overallSuccess = false;
        break;
      }
      }

      const summary = this.generateChainSummary(results, overallSuccess);

      return {
        success: overallSuccess,
        totalSteps: steps.length,
        completedSteps: results.length,
        results,
        summary,
        executionTime: results.reduce((total, r) => total + (r.executionTime || 0), 0)
      };
    } finally {
      // Always remove chain from active list
      this.activeChains.delete(chainId);
      logger.info(`Chain ${chainId} completed and removed from active chains`);
    }
  }

  /**
   * Execute a single step in the chain
   * @param {Object} step - Step configuration
   * @param {Object} sharedData - Data from previous steps
   * @param {Object} context - Execution context
   * @returns {Object} Step execution result
   */
  async executeStep(step, sharedData, context) {
    const startTime = Date.now();
    let releaseLock = null;

    try {
      // Acquire lock if plugin requires exclusive access
      if (step.requiresLock !== false) {
        releaseLock = await this.acquirePluginLock(step.plugin);
        logger.debug(`Acquired lock for plugin: ${step.plugin}`);
      }

      // Merge step params with shared data
      const params = { ...step.params };
      
      // Allow steps to reference shared data
      if (step.useSharedData) {
        Object.assign(params, sharedData);
      }
      
      // Special handling for email composition from previous step results
      if (step.plugin === 'email' && (step.action === 'send' || step.action === 'sendWithAI')) {
        // Ensure 'to' parameter exists
        if (!params.to) {
          logger.error('Email step missing "to" parameter:', step);
          throw new Error('Email step requires a "to" parameter with the recipient name or email address');
        }
        
        // If we have data from previous steps but no text/html/prompt, create one
        if (!params.text && !params.html && !params.prompt && Object.keys(sharedData).length > 0) {
          // Find the most recent step result
          const previousSteps = Object.keys(sharedData)
            .filter(key => key.startsWith('step'))
            .sort()
            .reverse();
          
          if (previousSteps.length > 0) {
            const lastStepData = sharedData[previousSteps[0]];
            const content = lastStepData.result?.result || lastStepData.result || JSON.stringify(lastStepData);
            
            // If using sendWithAI, create a prompt
            if (step.action === 'sendWithAI') {
              params.prompt = params.prompt || `Send the following information: ${content}`;
            } else {
              // For regular send, provide the content as text
              params.text = params.text || content;
            }
            
            logger.info('Auto-generated email content from previous step:', {
              action: step.action,
              hasPrompt: !!params.prompt,
              hasText: !!params.text,
              hasTo: !!params.to
            });
          }
        }
        
        // Add default subject if missing
        if (!params.subject) {
          params.subject = `Information from ${this.agent.config.name}`;
        }
      }

      // Mark as AI-originated so plugins can resolve device names, aliases, etc.
      params.fromAI = true;

      // Validate action exists for the plugin before executing
      const plugin = this.agent.plugins?.get(step.plugin);
      if (plugin && plugin.commands && Array.isArray(plugin.commands)) {
        const validActions = plugin.commands.map(c => c.command || c.name).filter(Boolean);
        if (validActions.length > 0 && !validActions.includes(step.action)) {
          logger.warn(`Invalid action "${step.action}" for plugin "${step.plugin}". Valid actions: ${validActions.join(', ')}`);
          return {
            success: false,
            error: `Invalid action "${step.action}" for plugin "${step.plugin}". Valid actions: ${validActions.join(', ')}`,
            executionTime: Date.now() - startTime
          };
        }
      }

      // Execute the plugin action
      const result = await this.agent.executePluginWithLogging(
        step.plugin,
        step.action,
        params,
        context
      );

      const executionTime = Date.now() - startTime;

      // Process the result for next step
      let outputData = {};
      if (step.extractData && result.success) {
        outputData = this.extractDataForNextStep(result, step.extractData);
      }

      return {
        success: result.success || false,
        result: result.result || result,
        error: result.error,
        executionTime,
        outputData
      };

    } catch (error) {
      const executionTime = Date.now() - startTime;
      return {
        success: false,
        error: error.message,
        executionTime
      };
    } finally {
      // Release lock if acquired
      if (releaseLock) {
        releaseLock();
        logger.debug(`Released lock for plugin: ${step.plugin}`);
      }
    }
  }

  /**
   * Extract specific data from step result for next steps
   * @param {Object} result - Step result
   * @param {Object} extractConfig - Configuration for data extraction
   * @returns {Object} Extracted data
   */
  extractDataForNextStep(result, extractConfig) {
    const extracted = {};

    try {
      if (extractConfig.fields) {
        for (const [key, path] of Object.entries(extractConfig.fields)) {
          extracted[key] = this.getNestedProperty(result, path);
        }
      }

      if (extractConfig.regex) {
        const text = result.result || JSON.stringify(result);
        for (const [key, pattern] of Object.entries(extractConfig.regex)) {
          const match = text.match(new RegExp(pattern));
          extracted[key] = match ? match[1] || match[0] : null;
        }
      }
    } catch (error) {
      logger.warn('Data extraction error:', error.message);
    }

    return extracted;
  }

  /**
   * Get nested property from object using dot notation
   * @param {Object} obj - Source object
   * @param {string} path - Dot notation path (e.g., 'result.data.url')
   * @returns {*} Property value or undefined
   */
  getNestedProperty(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Generate a human-readable summary of the chain execution
   * @param {Array} results - Step execution results
   * @param {boolean} overallSuccess - Whether the entire chain succeeded
   * @returns {string} Summary text
   */
  generateChainSummary(results, overallSuccess) {
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;
    
    let summary = `**Multi-Step Task Execution Summary**\n\n`;
    summary += `✅ **Overall Status:** ${overallSuccess ? 'SUCCESS' : 'PARTIAL/FAILED'}\n`;
    summary += `📊 **Steps Completed:** ${successful}/${results.length} successful\n\n`;

    if (failed > 0) {
      summary += `❌ **Failed Steps:** ${failed}\n\n`;
    }

    summary += `**Step Details:**\n`;
    results.forEach((result, index) => {
      const status = result.success ? '✅' : '❌';
      const time = result.executionTime ? ` (${result.executionTime}ms)` : '';
      summary += `${status} **Step ${result.stepNumber}:** ${result.description}${time}\n`;
      
      if (!result.success && result.error) {
        summary += `   ⚠️ *Error: ${result.error}*\n`;
      }
    });

    const totalTime = results.reduce((total, r) => total + (r.executionTime || 0), 0);
    if (totalTime > 0) {
      summary += `\n⏱️ **Total Execution Time:** ${totalTime}ms`;
    }

    return summary;
  }

  /**
   * Get status of all active chains
   * @returns {Object} Active chains status
   */
  getActiveChains() {
    const chains = [];
    for (const [id, info] of this.activeChains) {
      chains.push({
        id,
        startTime: info.startTime,
        duration: Date.now() - info.startTime,
        steps: info.steps,
        context: info.context
      });
    }
    return {
      active: chains.length,
      max: this.maxConcurrentChains,
      chains
    };
  }

  /**
   * Get plugin lock status
   * @returns {Object} Lock status for all plugins
   */
  getPluginLockStatus() {
    const locks = [];
    for (const [plugin, lock] of this.pluginLocks) {
      locks.push({
        plugin,
        locked: lock.locked,
        queueLength: lock.queue.length
      });
    }
    return locks;
  }
}