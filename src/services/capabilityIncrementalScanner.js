import { selfModLogger as logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export class CapabilityIncrementalScanner {
  constructor(selfModService) {
    this.service = selfModService;
    this.agent = selfModService.agent;
    
    // Context limits per provider (2026 model updates)
    this.contextLimits = {
      'openai': {
        // GPT-5 series (2025-2026) - 400k context
        'gpt-5': 400000,
        'gpt-5-mini': 400000,
        'gpt-5.2': 400000,
        'gpt5': 400000,
        'gpt5mini': 400000,
        'gpt5.2': 400000,
        // GPT-4 series
        'gpt-4o': 128000,
        'gpt-4o-mini': 128000,
        'gpt-4-turbo': 128000,
        'gpt-4': 8000,
        'gpt-3.5-turbo': 16000,
        'gpt-3.5-turbo-16k': 16000,
        'default': 400000  // Default to GPT-5 context for OpenAI
      },
      'anthropic': {
        // Claude 4.5 series (2025-2026) - 200k standard context
        'claude-opus-4.5': 200000,
        'claude-sonnet-4.5': 200000,
        'claude-opus-4-5': 200000,
        'claude-sonnet-4-5': 200000,
        'claudeopus4.5': 200000,
        'claudesonnet4.5': 200000,
        'claude-opus-4-5-20251101': 200000,
        'claude-sonnet-4-5-20250929': 200000,
        // Claude 4 series
        'claude-sonnet-4': 200000,
        'claude-opus-4': 200000,
        // Claude 3.x series
        'claude-3-sonnet': 200000,
        'claude-3-haiku': 200000,
        'claude-3-opus': 200000,
        'claude-3.5-sonnet': 200000,
        'claude-3-5-sonnet': 200000,
        'claude-2.1': 200000,
        'claude-2': 100000,
        'default': 200000
      },
      'huggingface': {
        'mistral': 32000,
        'llama': 4096,
        'default': 8000
      },
      'gab': {
        'default': 32000
      },
      'replicate': {
        'wizardlm': 32000,
        'default': 16000
      },
      'groq': {
        'llama3': 8000,
        'mixtral': 32000,
        'default': 8000
      }
    };
  }

  /**
   * Start incremental capability analysis
   */
  async scanForCapabilityUpgrades() {
    try {
      const scanId = `capability_scan_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      logger.info(`Starting capability upgrade scan: ${scanId}`);

      // Get current AI provider info
      const providerInfo = await this.getCurrentProviderInfo();

      // Get existing PRs to avoid duplicates in analysis
      const existingPRs = await this.getExistingPRsContext();
      logger.info(`Found ${existingPRs.length} existing PRs to consider during analysis`);

      // Find all plugins and core files to analyze
      const targetFiles = await this.discoverUpgradeTargets();
      logger.info(`Found ${targetFiles.length} files to analyze for upgrades`);

      // Shuffle files for random order
      const shuffledFiles = this.shuffleArray([...targetFiles]);

      // Calculate max files based on context limit and average file size
      const maxFilesForContext = this.calculateMaxFilesForContext(providerInfo.contextLimit);
      const maxFiles = Math.min(shuffledFiles.length, maxFilesForContext);
      
      logger.info(`Analyzing ${maxFiles} files (context limit: ${providerInfo.contextLimit} tokens)`);
      
      // Analyze each target for upgrade opportunities
      const upgrades = [];
      let totalContextUsed = 0;
      
      for (let i = 0; i < maxFiles; i++) {
        const target = shuffledFiles[i];
        try {
          // Skip if file would exceed context limit
          if (totalContextUsed + target.size > providerInfo.contextLimit * 0.8) {
            logger.info(`Stopping analysis - approaching context limit (used: ${totalContextUsed})`);
            break;
          }
          
          logger.info(`Analyzing file ${i + 1}/${maxFiles}: ${target.name}`);
          const targetUpgrades = await this.analyzeTargetForUpgrades(target, providerInfo, existingPRs);
          upgrades.push(...targetUpgrades);
          
          totalContextUsed += target.size;
          
          // Small delay to avoid overwhelming AI provider
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          logger.warn(`Failed to analyze ${target.path}: ${error.message}`);
        }
      }
      
      logger.info(`Capability scan completed: ${upgrades.length} upgrade opportunities found`);
      return upgrades;
      
    } catch (error) {
      logger.error('Capability upgrade scan failed:', error);
      return [];
    }
  }

  /**
   * Get current AI provider and model info
   */
  async getCurrentProviderInfo() {
    try {
      let currentProvider = 'anthropic';
      let currentModel = 'default';

      // Get the active provider from providerManager
      if (this.agent.providerManager?.getCurrentProvider) {
        const provider = await this.agent.providerManager.getCurrentProvider();

        // Get the provider name from the providers map
        if (this.agent.providerManager.providers) {
          for (const [name, prov] of this.agent.providerManager.providers.entries()) {
            if (prov === provider) {
              currentProvider = name.toLowerCase();
              break;
            }
          }
        }

        // Get the model from the provider object
        if (provider?.models?.chat) {
          currentModel = provider.models.chat;
        } else if (provider?.model) {
          currentModel = provider.model;
        }
      }

      // Also check activeProvider directly
      if (this.agent.providerManager?.activeProvider) {
        const activeProvider = this.agent.providerManager.activeProvider;
        if (activeProvider?.models?.chat) {
          currentModel = activeProvider.models.chat;
        }
      }

      // Normalize model names for lookup
      currentModel = currentModel.toLowerCase().replace(/[^a-z0-9.-]/g, '');

      logger.info(`Provider detection: provider=${currentProvider}, model=${currentModel}`);

      const contextLimit = this.getContextLimit(currentProvider, currentModel);

      logger.info(`Context limit for ${currentProvider}/${currentModel}: ${contextLimit} tokens`);

      return { provider: currentProvider, model: currentModel, contextLimit };
    } catch (error) {
      logger.warn(`Could not get provider info, using defaults: ${error.message}`);
      return { provider: 'anthropic', model: 'default', contextLimit: 100000 };
    }
  }

  /**
   * Get context limit for a specific provider/model
   */
  getContextLimit(provider, model) {
    const providerLimits = this.contextLimits[provider] || this.contextLimits['huggingface'];
    return providerLimits[model] || providerLimits['default'] || 8000;
  }

  /**
   * Shuffle array using Fisher-Yates algorithm
   */
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Calculate max files based on context limit
   */
  calculateMaxFilesForContext(contextLimit) {
    // More realistic token estimates
    const avgFileTokens = 2500; // Most plugin files are 1000-3000 tokens
    const promptOverhead = 1000; // Prompt is relatively small
    const safetyMargin = 0.8; // Use 80% of context
    
    const maxFiles = Math.floor((contextLimit * safetyMargin - promptOverhead) / avgFileTokens);
    
    // Ensure we analyze at least 1 file, but cap at reasonable limits
    if (contextLimit < 4000) return 1; // Very small context
    if (contextLimit < 16000) return Math.max(1, maxFiles); // Small context
    if (contextLimit < 32000) return Math.min(10, Math.max(3, maxFiles)); // Medium context
    return Math.min(20, Math.max(5, maxFiles)); // Large context
  }

  /**
   * Discover files that are targets for capability upgrades
   */
  async discoverUpgradeTargets() {
    const targets = [];
    
    // For production, scan the entire src directory
    const productionSrcPath = path.join(process.env.AGENT_REPO_PATH || process.cwd(), 'src');
    
    logger.info(`Discovering upgrade targets in: ${productionSrcPath}`);
    
    try {
      // First, get all plugin files specifically (for proper categorization)
      const pluginDir = path.join(productionSrcPath, 'api/plugins');
      logger.info(`Scanning plugin directory: ${pluginDir}`);
      await this.scanDirectoryForTargets(pluginDir, targets, 'plugin');
      logger.info(`Found ${targets.length} plugin files`);
    } catch (error) {
      logger.warn(`Could not scan plugin directory: ${error.message}`);
    }
    
    const coreTargetsBefore = targets.length;
    try {
      // Then scan ALL other source files as core
      logger.info(`Scanning core files recursively in: ${productionSrcPath}`);
      await this.scanDirectoryRecursive(productionSrcPath, targets, 'core', {
        // Exclude certain directories to avoid duplicates and unnecessary files
        exclude: [
          'api/plugins', // Already scanned as plugins
          'test',
          'tests',
          '__tests__',
          'node_modules',
          '.git',
          'dist',
          'build',
          'coverage'
        ]
      });
      logger.info(`Found ${targets.length - coreTargetsBefore} core files`);
    } catch (error) {
      logger.warn(`Could not scan source directory: ${error.message}`);
    }
    
    // Sort by priority (plugins first, then core services)
    targets.sort((a, b) => {
      if (a.type === 'plugin' && b.type !== 'plugin') return -1;
      if (b.type === 'plugin' && a.type !== 'plugin') return 1;
      return a.size - b.size; // Smaller files first
    });
    
    return targets;
  }

  /**
   * Scan directory for upgrade targets
   */
  async scanDirectoryForTargets(dirPath, targets, type) {
    try {
      logger.info(`Reading directory: ${dirPath}`);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      logger.info(`Found ${entries.length} entries in ${dirPath}`);
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.js')) {
          const fullPath = path.join(dirPath, entry.name);
          const stats = await fs.stat(fullPath);
          
          // Skip very large files (>50KB) for now
          if (stats.size > 50000) continue;
          
          targets.push({
            path: fullPath,
            name: entry.name,
            type: type,
            size: stats.size,
            relativePath: path.relative(process.cwd(), fullPath)
          });
        }
      }
    } catch (error) {
      logger.warn(`Failed to scan ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Recursively scan directory for upgrade targets with exclusions
   */
  async scanDirectoryRecursive(dirPath, targets, type, options = {}) {
    const exclude = options.exclude || [];
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          // Check if directory should be excluded
          const shouldExclude = exclude.some(pattern => {
            const relativePath = path.relative(path.join(process.env.AGENT_REPO_PATH || process.cwd(), 'src'), fullPath);
            return relativePath.startsWith(pattern);
          });
          
          if (!shouldExclude) {
            // Recursively scan subdirectory
            await this.scanDirectoryRecursive(fullPath, targets, type, options);
          }
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          const stats = await fs.stat(fullPath);
          
          // Skip very large files (>50KB) for now
          if (stats.size > 50000) continue;
          
          targets.push({
            path: fullPath,
            name: entry.name,
            type: type,
            size: stats.size,
            relativePath: path.relative(process.env.AGENT_REPO_PATH || process.cwd(), fullPath)
          });
        }
      }
    } catch (error) {
      logger.warn(`Failed to scan ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Get existing PR context to avoid duplicate suggestions
   */
  async getExistingPRsContext() {
    try {
      // Get repository path from service
      const repoPath = this.service.developmentPath;
      const workingDir = repoPath || process.cwd();

      // Get BOTH open and recently merged PRs to avoid suggesting already-implemented features
      const openPRsPromise = this.agent.systemExecutor.execute(
        'gh pr list --state open --json title,headRefName,body',
        { cwd: workingDir, timeout: 10000 }
      );

      // Get merged PRs from the last 30 days
      const mergedPRsPromise = this.agent.systemExecutor.execute(
        'gh pr list --state merged --json title,headRefName,body --limit 50',
        { cwd: workingDir, timeout: 10000 }
      );

      const [openResult, mergedResult] = await Promise.all([openPRsPromise, mergedPRsPromise]);

      let allPRs = [];

      if (openResult.exitCode === 0) {
        const openPRs = JSON.parse(openResult.stdout || '[]');
        allPRs = allPRs.concat(openPRs);
      } else {
        logger.warn('Could not get open PRs:', openResult.stderr);
      }

      if (mergedResult.exitCode === 0) {
        const mergedPRs = JSON.parse(mergedResult.stdout || '[]');
        allPRs = allPRs.concat(mergedPRs);
      } else {
        logger.warn('Could not get merged PRs:', mergedResult.stderr);
      }

      // Filter for capability upgrade PRs and extract relevant info
      return allPRs
        .filter(pr => pr.title?.includes('Capability Upgrade') || pr.headRefName?.includes('auto-improve'))
        .map(pr => ({
          title: pr.title,
          branch: pr.headRefName,
          description: pr.body?.substring(0, 200) || '' // First 200 chars of PR description
        }));

    } catch (error) {
      logger.warn(`Failed to get existing PRs context: ${error.message}`);
      return [];
    }
  }

  /**
   * Analyze a specific target file for upgrade opportunities
   */
  async analyzeTargetForUpgrades(target, providerInfo, existingPRs = []) {
    try {
      // Check if this file already has an open capability upgrade PR
      const hasExistingPR = existingPRs.some(pr => {
        const prTitle = pr.title.toLowerCase();
        const targetFileName = target.name.toLowerCase().replace('.js', '');
        
        // Check if PR mentions this specific file
        const mentionsFile = prTitle.includes(targetFileName) ||
                           prTitle.includes(`${targetFileName}.js`) ||
                           prTitle.includes(`: ${targetFileName}`) ||
                           prTitle.includes(`/${targetFileName}`) ||
                           prTitle.includes(` ${targetFileName} `);
        
        // Only check if it's a capability upgrade if it mentions this file
        if (mentionsFile) {
          const isCapabilityPR = prTitle.includes('capability upgrade') || 
                               prTitle.includes('[capability upgrade]') ||
                               prTitle.includes('enhance_plugin_features') ||
                               prTitle.includes('extend_plugin_apis') ||
                               prTitle.includes('upgrade_core_capabilities') ||
                               prTitle.includes('optimize_plugin_performance') ||
                               prTitle.includes('improve_ai_integrations');
          
          return isCapabilityPR;
        }
        
        return false;
      });
      
      if (hasExistingPR) {
        logger.info(`✓ Skipping ${target.name} - already has capability upgrade PR`);
        return [];
      }
      
      logger.info(`🔍 Analyzing ${target.name} for capability upgrades...`);
      
      const content = await fs.readFile(target.path, 'utf8');
      
      // Skip files that are too large for analysis
      if (content.length > 15000) {
        logger.debug(`Skipping ${target.name} - too large for analysis`);
        return [];
      }
      
      // Use AI to analyze the file for upgrade opportunities
      const upgrades = await this.analyzeFileWithAI(target, content, providerInfo, existingPRs);
      
      return upgrades;
      
    } catch (error) {
      logger.error(`Failed to analyze ${target.path}: ${error.message}`);
      return [];
    }
  }

  /**
   * Use AI to analyze file for upgrade opportunities
   */
  async analyzeFileWithAI(target, content, providerInfo, existingPRs = []) {
    try {
      const prompt = this.buildCapabilityAnalysisPrompt(target, content, existingPRs);
      
      // Add timeout wrapper to prevent hanging
      const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('AI analysis timeout')), 60000); // 60 second timeout
      });

      const analysisPromise = this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 2000,
        temperature: 0.3,
        enableWebSearch: false
      });
      
      const response = await Promise.race([analysisPromise, timeoutPromise]);

      // Debug: log raw AI response for troubleshooting
      const rawContent = response?.content || '';
      logger.info(`[scanner-debug] ${target.name} response length=${rawContent.length}, first500=${rawContent.substring(0, 500).replace(/\n/g, '\\n')}`);

      // Parse the AI response to extract upgrade opportunities
      const upgrades = this.parseUpgradeOpportunities(rawContent, target);

      logger.info(`Found ${upgrades.length} upgrade opportunities in ${target.name}`);
      return upgrades;

    } catch (error) {
      logger.error(`AI analysis failed for ${target.path}: ${error.message}`);
      return [];
    }
  }

  /**
   * Build AI prompt for capability analysis
   */
  buildCapabilityAnalysisPrompt(target, content, existingPRs = []) {
    const isPlugin = target.type === 'plugin';
    
    // Build existing PRs context
    let existingPRsContext = '';
    if (existingPRs.length > 0) {
      existingPRsContext = `
IMPORTANT: The following capability upgrades are ALREADY being worked on - DO NOT suggest these:

${existingPRs.map(pr => `- ${pr.title} (${pr.branch})\n  ${pr.description}`).join('\n')}

`;
    }
    
    return `Analyze this ${isPlugin ? 'plugin' : 'core service'} for capability upgrade opportunities.

File: ${target.name}
Type: ${target.type}

${existingPRsContext}Code:
${content}

Focus ONLY on capability upgrades (NOT bug fixes or new plugins):

${isPlugin ? `
Plugin Upgrade Areas:
- New features that could be added to this plugin
- New API endpoints or commands
- Better integration with other services
- Performance optimizations
- Enhanced user experience
- Additional configuration options
` : `
Core Service Upgrade Areas:
- Enhanced functionality for existing features
- Better AI provider integration
- Improved data processing capabilities
- New automation features
- Better error handling and resilience
- Performance improvements
`}

Return your analysis in this JSON format:
{
  "upgrades": [
    {
      "type": "enhance_plugin_features|extend_plugin_apis|optimize_plugin_performance|upgrade_core_capabilities|etc",
      "target": "${target.name}",
      "description": "Brief description of the upgrade",
      "implementation": "How to implement this upgrade",
      "value": "high|medium|low",
      "effort": "small|medium|large",
      "impact": "high|medium|low",
      "newCapabilities": ["list", "of", "new", "capabilities"]
    }
  ]
}

CRITICAL REQUIREMENTS:
- Only suggest upgrades that are NOT already covered by existing PRs listed above
- Focus on NEW capabilities that haven't been suggested yet
- If similar upgrades exist, suggest complementary or different approaches
- Only suggest realistic, valuable upgrades
- If no NEW upgrades found (due to existing PRs), return empty upgrades array

EXISTING FEATURE CHECK (VERY IMPORTANT):
- This codebase already has common features like: health check endpoints (/health, /api/health),
  logging systems, error handling, authentication, rate limiting, caching, and monitoring
- Do NOT suggest adding features that are commonly already implemented in mature projects
- Health checks, status endpoints, basic CRUD operations - assume these EXIST unless the code
  clearly shows they're missing
- If you're unsure whether a feature exists elsewhere in the codebase, DO NOT suggest it
- Prefer suggesting ENHANCEMENTS to existing features over adding new common features

QUALITY REQUIREMENTS FOR SUGGESTIONS:
- Suggested implementations must be COMPLETE - include wiring to execute() and commands array
- Do NOT suggest features that would require non-existent services or dependencies
- Do NOT suggest encryption/breaking changes to existing data formats
- Check the code - if similar functionality exists (e.g., abiManager.js for ABI), don't suggest duplicating it
- Suggested features must perform REAL work, not just logging
- Do NOT suggest generic/common features like health checks, logging, caching unless the code explicitly lacks them

THIRD-PARTY API VERIFICATION (CRITICAL):
- Do NOT suggest calling API endpoints or SDK methods unless you are CERTAIN they exist
- If the code uses a third-party SDK (e.g., @whoisjson/whoisjson), only suggest methods you can see already used in the code
- Do NOT hallucinate or invent API endpoints for external services
- If you are unsure whether an API endpoint exists, DO NOT suggest it
- Common hallucination: suggesting "historical" or "analytics" endpoints that don't exist on the API

SCOPE AND IMPACT:
- Prefer SMALL, focused improvements over large rewrites
- Do NOT suggest changes that would require modifying multiple files
- Do NOT suggest adding caching to models/services that have tiny datasets (dozens of records)
- Do NOT suggest "optimization" unless there is an actual performance problem visible in the code
- Do NOT suggest adding WebSocket, streaming, or real-time features unless the infrastructure already exists
- Dead code has ZERO value — every function must have a caller, every method must be wired up

IMPORT PATH AWARENESS:
- Note the file location to suggest correct import paths
- src/api/plugins/*.js uses ../../utils/ for utilities
- src/services/*.js uses ../utils/ for utilities
- src/models/*.js uses ../utils/ for utilities

Be creative and find DIFFERENT upgrade opportunities than what's already being worked on.`;
  }

  /**
   * Parse AI response to extract upgrade opportunities
   */
  parseUpgradeOpportunities(aiResponse, target) {
    try {
      // Strip all code fences first — Claude often nests ```javascript inside ```json
      let cleaned = aiResponse.replace(/```\w*\n?/g, '');

      // Find the outermost JSON object containing "upgrades"
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');

      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        logger.warn(`[parser] ${target.name}: no JSON braces found in response`);
        return [];
      }

      let jsonString = cleaned.substring(firstBrace, lastBrace + 1);

      // Clean up trailing commas
      jsonString = jsonString.replace(/,(\s*[}\]])/g, '$1');

      let parsed;
      try {
        parsed = JSON.parse(jsonString);
      } catch (e) {
        // If full parse fails, try sanitizing embedded newlines in string values
        jsonString = jsonString.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
          return match.replace(/[\n\r\t]/g, ' ');
        });
        try {
          parsed = JSON.parse(jsonString);
        } catch (e2) {
          // Last resort: extract individual upgrade objects using a lenient approach
          // Find objects that have "type" and "description" fields
          logger.info(`[parser] ${target.name}: full JSON broken (${e2.message}), attempting individual object extraction`);
          const upgradeMatches = [];
          const typeRegex = /"type"\s*:\s*"([^"]+)"[\s\S]*?"target"\s*:\s*"([^"]+)"[\s\S]*?"description"\s*:\s*"([^"]+)"/g;
          let match;
          while ((match = typeRegex.exec(jsonString)) !== null) {
            upgradeMatches.push({
              type: match[1],
              target: match[2],
              description: match[3],
              implementation: 'See AI analysis for details',
              value: 'medium',
              effort: 'medium',
              impact: 'medium',
              newCapabilities: []
            });
          }
          if (upgradeMatches.length > 0) {
            parsed = { upgrades: upgradeMatches };
            logger.info(`[parser] ${target.name}: extracted ${upgradeMatches.length} upgrades from broken JSON`);
          } else {
            logger.warn(`[parser] ${target.name}: JSON parse failed and no upgrades extractable: ${e2.message}`);
            return [];
          }
        }
      }

      // Handle case where AI returns a single upgrade object instead of {upgrades: [...]}
      if (!parsed.upgrades && parsed.type && parsed.description) {
        parsed = { upgrades: [parsed] };
      }

      if (!parsed.upgrades || !Array.isArray(parsed.upgrades)) {
        logger.warn(`[parser] ${target.name}: no upgrades array, keys=${Object.keys(parsed).join(',')}`);
        return [];
      }
      logger.info(`[parser] ${target.name}: parsed ${parsed.upgrades.length} upgrades`);
      
      // Validate and enhance each upgrade
      const validUpgrades = parsed.upgrades
        .filter(upgrade => upgrade.type && upgrade.description)
        .map(upgrade => ({
          ...upgrade,
          id: `upgrade_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          targetFile: target.path,
          targetType: target.type,
          analysisDate: new Date(),
          safeForProduction: this.isSafeForProduction(upgrade),
          priority: this.calculatePriority(upgrade)
        }));
      
      return validUpgrades;
      
    } catch (error) {
      logger.warn(`Failed to parse AI response for ${target.name}: ${error.message}`);
      // Log the problematic response for debugging
      logger.debug(`Problematic AI response: ${aiResponse.substring(0, 500)}...`);
      return [];
    }
  }

  /**
   * Determine if upgrade is safe for production deployment
   */
  isSafeForProduction(upgrade) {
    const safeTypes = [
      'enhance_plugin_features',
      'extend_plugin_apis', 
      'add_plugin_commands',
      'optimize_plugin_performance'
    ];
    
    const riskyTypes = [
      'upgrade_core_capabilities',
      'improve_ai_integrations',
      'upgrade_memory_management'
    ];
    
    if (safeTypes.includes(upgrade.type) && upgrade.effort === 'small') return true;
    if (riskyTypes.includes(upgrade.type)) return false;
    
    return upgrade.effort === 'small' && upgrade.impact !== 'high';
  }

  /**
   * Calculate upgrade priority
   */
  calculatePriority(upgrade) {
    const valueScore = { high: 3, medium: 2, low: 1 };
    const impactScore = { high: 3, medium: 2, low: 1 };
    const effortScore = { small: 3, medium: 2, large: 1 };
    
    const score = (valueScore[upgrade.value] || 1) * 
                  (impactScore[upgrade.impact] || 1) * 
                  (effortScore[upgrade.effort] || 1);
    
    if (score >= 15) return 'high';
    if (score >= 8) return 'medium';
    return 'low';
  }
}

