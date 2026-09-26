import { selfModLogger as logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// Headroom the analysis watchdog keeps over the provider's own budget, so the
// provider aborts and rejects on its own terms first and the logged error names
// the real cause instead of a generic caller timeout.
const ANALYSIS_WATCHDOG_MARGIN_MS = 15000;

// Floor for a provider that cannot describe its budget. Only a lower bound — a
// provider reporting a larger budget raises the watchdog above this.
const ANALYSIS_MIN_WATCHDOG_MS = 60000;

// Attempts this scan is willing to fund per file: one retry, so 2 attempts.
//
// providerManager defaults generation calls to 3 retries, which is right for an
// interactive call and wrong here — files are analysed SERIALLY inside a cycle
// budget, so four 90s attempts on one unlucky file would spend six minutes of the
// hourly window and leave the watchdog too high to still be a backstop against a
// genuinely hung request. One retry gives the transient case a real second chance
// while keeping the worst case bounded (~197s for the HuggingFace path).
//
// This number feeds BOTH the call and the watchdog that guards it, which is the
// point: they cannot drift apart the way the 60s literal drifted below the
// provider's 90s budget.
const ANALYSIS_RETRIES = 1;

// How long a file stays off the candidate list after a capability-upgrade PR
// against it was CLOSED rather than merged.
//
// A closed PR is a rejection: a reviewer or the operator looked at the proposal
// and decided it should not ship. Nothing recorded that. The scanner asked only
// for open and merged PRs, so a closed one left no trace and the same file came
// straight back round on the shuffle. TimeIndicators.js was selected on 09-04,
// again on 09-14 (PR 2455) and again on 09-16 (PR 2461) — three proposals
// against one file in twelve days, all three closed, each costing a full cycle
// and a human review.
//
// 30 days matches the window the merged-PR lookup already uses. It is a
// cooldown and not a permanent exclusion on purpose: a file rejected for one
// bad proposal may still deserve a good one later.
const CLOSED_PR_COOLDOWN_DAYS = 30;

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
        // Qwen3-Coder is the model actually configured on this fleet. The id
        // arrives normalised with punctuation stripped
        // ("qwenqwen3-coder-480b-a35b-instruct"), which matched no key exactly,
        // so the lookup fell through to `default` and budgeted 8,000 tokens for
        // a 262,144-token model. getContextLimit now falls back to a
        // longest-prefix match, which these entries rely on.
        'qwen': 262144,
        'qwen3': 262144,
        'qwen3-coder': 262144,
        'default': 8000
      },
      'gab': {
        'default': 32000
      },
      'replicate': {
        'wizardlm': 32000,
        'default': 16000
      },
      'openrouter': {
        // Normally answered by the provider's live catalog (see getCurrentProviderInfo);
        // these cover a boot before the catalog has loaded. Ids arrive normalised
        // ("openaigpt-5.6-luna"), so these are substring keys.
        'gpt-5': 400000,
        'gpt-4.1': 1000000,
        'claude': 200000,
        'qwen3': 262144,
        'default': 128000
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
      // Spend cap, separate from the context budget. Each file is its own analysis
      // call and scans run hourly, so a 1M-context model would otherwise analyse 20
      // files a scan (~400 calls/day). SELFMOD_FILES_PER_SCAN overrides.
      const perScanCap = Number.parseInt(process.env.SELFMOD_FILES_PER_SCAN, 10);
      const filesPerScan = Number.isFinite(perScanCap) && perScanCap > 0 ? perScanCap : 3;
      const maxFiles = Math.min(shuffledFiles.length, maxFilesForContext, filesPerScan);
      
      logger.info(`Analyzing ${maxFiles} files (context limit: ${providerInfo.contextLimit} tokens)`);
      
      // Analyze each target for upgrade opportunities.
      //
      // `target.size` is BYTES from fs.stat; `contextLimit` is TOKENS. Comparing
      // them directly made the budget roughly 4x tighter than intended, and the
      // guard below used to `break` on the first file that did not fit rather
      // than skip it. Because the file list is SHUFFLED, that meant one large
      // file drawn first aborted the entire scan of 442 files before a single
      // one was analysed — logged as "approaching context limit (used: 0)".
      //
      // Measured on 2026-09-02: 8,728 scans found 0 opportunities against ~4,000
      // that found some, a near coin-flip that tracked the shuffle rather than
      // the codebase. A scan that stopped at used=0 produced no PRs at all, which
      // is why the pipeline appeared to have stopped submitting them.
      //
      // Each file is analysed in its OWN provider call, so the accumulated total
      // is not a context constraint — it is a per-cycle spend cap. The two are
      // now checked separately: a file too big for one call is skipped, and the
      // loop stops only when the cycle's budget is genuinely spent.
      const upgrades = [];
      const budgetTokens = Math.floor(providerInfo.contextLimit * 0.8);
      let totalContextUsed = 0;

      for (let i = 0; i < maxFiles; i++) {
        const target = shuffledFiles[i];
        try {
          // ~4 bytes per token is the standard rule of thumb for source text.
          const estTokens = Math.ceil(target.size / 4);

          // Too large for a single call — skip THIS file, not the whole scan.
          if (estTokens > budgetTokens) {
            logger.info(`Skipping ${target.name}: ~${estTokens} tokens exceeds the per-call budget (${budgetTokens})`);
            continue;
          }

          // Cycle budget spent. Stopping here is correct; every remaining file
          // would be work this cycle cannot pay for.
          if (totalContextUsed + estTokens > budgetTokens) {
            logger.info(`Stopping analysis - cycle budget spent (used ~${totalContextUsed} of ${budgetTokens} tokens, ${i} of ${maxFiles} files analysed)`);
            break;
          }

          logger.info(`Analyzing file ${i + 1}/${maxFiles}: ${target.name}`);
          const targetUpgrades = await this.analyzeTargetForUpgrades(target, providerInfo, existingPRs);
          upgrades.push(...targetUpgrades);

          totalContextUsed += Math.ceil(target.size / 4);
          
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
      let currentProvider = null;
      let currentModel = 'default';
      let providerObj = null;

      // Get the active provider from providerManager
      if (this.agent.providerManager?.getCurrentProvider) {
        const provider = await this.agent.providerManager.getCurrentProvider();
        providerObj = provider || null;

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

      // Prefer the provider's own model catalog over the static table. OpenRouter
      // publishes context_length per model; the table had no 'openrouter' entry at
      // all, so openai/gpt-5.6-luna (1.05M context) fell through to the HuggingFace
      // default of 8,000 and every scan analysed ~1 file.
      const rawModel = currentModel;
      let catalogLimit = null;
      try {
        const meta = providerObj?.catalog?.get?.(rawModel);
        if (Number.isFinite(meta?.contextLength) && meta.contextLength > 0) {
          catalogLimit = meta.contextLength;
        }
      } catch { /* catalog is optional — fall back to the table */ }

      // Normalize model names for lookup
      currentModel = currentModel.toLowerCase().replace(/[^a-z0-9.-]/g, '');

      // If provider detection failed, fall back to the safe smallest registry
      // entry instead of hardcoding 'anthropic'. This file does not initiate
      // AI calls itself — the provider label is only used for context-limit
      // lookup, so a conservative default is preferable to one that misroutes
      // downstream calls.
      if (!currentProvider) currentProvider = 'huggingface';

      logger.info(`Provider detection: provider=${currentProvider}, model=${currentModel}`);

      const contextLimit = catalogLimit || this.getContextLimit(currentProvider, currentModel);

      logger.info(`Context limit for ${currentProvider}/${currentModel}: ${contextLimit} tokens` +
        (catalogLimit ? ' (from provider catalog)' : ''));

      return { provider: currentProvider, model: currentModel, contextLimit };
    } catch (error) {
      logger.warn(`Could not get provider info, using defaults: ${error.message}`);
      return { provider: 'huggingface', model: 'default', contextLimit: 8000 };
    }
  }

  /**
   * Get context limit for a specific provider/model
   */
  getContextLimit(provider, model) {
    const providerLimits = this.contextLimits[provider] || this.contextLimits['huggingface'];

    // Exact match first.
    if (providerLimits[model]) return providerLimits[model];

    // Then longest-prefix match. Model ids carry size/variant/date suffixes that
    // the table cannot enumerate — the deployed
    // "qwenqwen3-coder-480b-a35b-instruct" matched nothing and silently took the
    // 8,000-token `default`, budgeting a 262,144-token model as if it were tiny.
    // Longest-first so 'gpt-4o-mini' cannot be captured by 'gpt-4'.
    const prefixes = Object.keys(providerLimits)
      .filter(k => k !== 'default')
      .sort((a, b) => b.length - a.length);
    for (const key of prefixes) {
      if (model.includes(key)) return providerLimits[key];
    }

    return providerLimits['default'] || 8000;
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
  /**
   * Is this file a real module the pipeline could legitimately rewrite?
   *
   * `src/api/plugins/_ai_template.js` is a SCAFFOLD, not a module: its body is
   * literal `{{PLUGIN_NAME}}` placeholders, so it has never parsed and never
   * will. The scanner had no file-level filter at all — every `.js` under 50KB
   * was a candidate — so it selected the template, spent a provider call
   * analysing it, generated a rewrite, APPLIED it, and only then died in the
   * pre-PR load check with `syntax: …/_ai_template.js:5`. Seven cycles were
   * burned that way, each one an hour of the pipeline's budget producing
   * nothing.
   *
   * The leading underscore is this codebase's existing marker for "not a live
   * module" — featureClassifier.js already skips on it, and pluginDevelopment.js
   * names these files as templates. Honouring the same convention here is the
   * fix; a parse check per file would cost a subprocess per candidate for the
   * one case the convention already describes.
   */
  isUpgradeCandidate(name) {
    if (name.startsWith('_')) return false;       // scaffolds and templates
    if (name.endsWith('.example')) return false;  // never loaded
    return true;
  }

  async scanDirectoryForTargets(dirPath, targets, type) {
    try {
      logger.info(`Reading directory: ${dirPath}`);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      logger.info(`Found ${entries.length} entries in ${dirPath}`);
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.js')) {
          if (!this.isUpgradeCandidate(entry.name)) continue;
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
          if (!this.isUpgradeCandidate(entry.name)) continue;
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

      // Closed-but-not-merged PRs — rejections. Three traps here:
      //
      //  1. `gh pr list --state closed` returns MERGED ones too, so `state` is
      //     requested and filtered on below. Without that filter every merged PR
      //     would read as a rejection and cool its own file down.
      //  2. A flat `--limit N` is a COUNT, and the cooldown is a DURATION, so a
      //     limit that is too small silently shortens the cooldown instead of
      //     failing. `--limit 50` reached back about eighteen days against this
      //     repo's ~83-closures-a-month; 200 reaches back roughly eighty, and
      //     the coverage assertion below says so out loud if that ever stops
      //     being true.
      //  3. Do NOT reach for `--search "closed:>=<date>"` to make the window a
      //     duration directly. It looks like the precise form and it is the
      //     wrong one: measured 2026-09-17, that query returned nothing closed
      //     after 09-06 while the plain list returned closures up to that
      //     morning — the search index lagged by eleven days and omitted every
      //     rejection this cooldown exists to catch, with no error.
      const closedPRsPromise = this.agent.systemExecutor.execute(
        'gh pr list --state closed --json title,headRefName,body,state,closedAt --limit 200',
        { cwd: workingDir, timeout: 15000 }
      );

      const [openResult, mergedResult, closedResult] = await Promise.all([
        openPRsPromise,
        mergedPRsPromise,
        closedPRsPromise
      ]);

      let allPRs = [];

      if (openResult.exitCode === 0) {
        const openPRs = JSON.parse(openResult.stdout || '[]');
        allPRs = allPRs.concat(openPRs.map(pr => ({ ...pr, _state: 'open' })));
      } else {
        logger.warn('Could not get open PRs:', openResult.stderr);
      }

      if (mergedResult.exitCode === 0) {
        const mergedPRs = JSON.parse(mergedResult.stdout || '[]');
        allPRs = allPRs.concat(mergedPRs.map(pr => ({ ...pr, _state: 'merged' })));
      } else {
        logger.warn('Could not get merged PRs:', mergedResult.stderr);
      }

      if (closedResult.exitCode === 0) {
        const closedPRs = JSON.parse(closedResult.stdout || '[]');
        const rejected = closedPRs.filter(pr => pr.state === 'CLOSED');
        allPRs = allPRs.concat(rejected.map(pr => ({ ...pr, _state: 'closed' })));

        // Does the page actually span the cooldown? If the oldest rejection it
        // returned is NEWER than the cooldown start, the list was truncated by
        // the limit and files rejected in the older part of the window will be
        // re-selected as though they had never been proposed. That is the exact
        // failure the cooldown is meant to end, so it is logged rather than left
        // to look like a quiet success.
        const cooldownStart = Date.now() - CLOSED_PR_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
        const oldest = rejected
          .map(pr => Date.parse(pr.closedAt))
          .filter(t => !Number.isNaN(t))
          .sort((a, b) => a - b)[0];
        if (oldest !== undefined && oldest > cooldownStart) {
          const days = Math.floor((Date.now() - oldest) / (24 * 60 * 60 * 1000));
          logger.warn(
            `Closed-PR list covers only ~${days} days but the rejection cooldown is ` +
            `${CLOSED_PR_COOLDOWN_DAYS} days — raise the --limit; older rejections are invisible`
          );
        }
      } else {
        logger.warn('Could not get closed PRs:', closedResult.stderr);
      }

      // Filter for capability upgrade PRs and extract relevant info.
      // Carry _state so the per-target dedupe can treat open PRs (still active)
      // differently from merged PRs (historical) — see analyzeTargetForUpgrades.
      return allPRs
        .filter(pr => pr.title?.includes('Capability Upgrade') || pr.headRefName?.includes('auto-improve'))
        .map(pr => ({
          title: pr.title,
          branch: pr.headRefName,
          state: pr._state,
          closedAt: pr.closedAt || null,
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
      // Dedupe scope:
      //   - OPEN PR for this file (any capability type) → skip; no point opening a
      //     second PR on the same file while one is still pending review.
      //   - MERGED PR for this file → only block re-analysis when AI ends up
      //     proposing the SAME capability type. We can't know the type until
      //     analyzeFileWithAI runs, so we collect mergedTypesForFile here and
      //     pass it into analyzeFileWithAI to dedupe at the per-upgrade level.
      //   - CLOSED PR for this file within the cooldown → skip. A close is a
      //     rejection of this file as a target, whatever capability type comes
      //     back next time, so it is checked before any analysis is funded.
      const targetFileName = target.name.toLowerCase().replace('.js', '');
      const CAP_TYPES = [
        'enhance_plugin_features',
        'extend_plugin_apis',
        'optimize_plugin_performance',
        'upgrade_core_capabilities',
        'improve_ai_integrations',
        'enhance_data_processing',
        'expand_plugin_functionality',
        'upgrade_service_integrations',
        'add_plugin_commands',
        'enhance_user_interfaces',
        'upgrade_memory_management',
        'optimize_workflow_automation'
      ];
      const mentionsThisFile = (prTitle) =>
        prTitle.includes(targetFileName) ||
        prTitle.includes(`${targetFileName}.js`) ||
        prTitle.includes(`: ${targetFileName}`) ||
        prTitle.includes(`/${targetFileName}`) ||
        prTitle.includes(` ${targetFileName} `);

      let hasOpenPRForFile = false;
      const mergedTypesForFile = new Set();
      let coolingUntil = null;   // most recent rejection's cooldown expiry
      const cooldownMs = CLOSED_PR_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      for (const pr of existingPRs) {
        const prTitle = (pr.title || '').toLowerCase();
        if (!mentionsThisFile(prTitle)) continue;
        const isCapabilityPR = prTitle.includes('capability upgrade') ||
                               prTitle.includes('[capability upgrade]') ||
                               CAP_TYPES.some(t => prTitle.includes(t));
        if (!isCapabilityPR) continue;
        if (pr.state === 'merged') {
          for (const t of CAP_TYPES) if (prTitle.includes(t)) mergedTypesForFile.add(t);
        } else if (pr.state === 'closed') {
          // A close with no usable timestamp still counts as a rejection — fall
          // back to a full cooldown from now rather than ignoring it, so a gh
          // response missing closedAt cannot quietly re-open the target.
          const closedAt = pr.closedAt ? Date.parse(pr.closedAt) : NaN;
          const expiry = Number.isNaN(closedAt) ? Date.now() + cooldownMs : closedAt + cooldownMs;
          if (expiry > Date.now() && (coolingUntil === null || expiry > coolingUntil)) {
            coolingUntil = expiry;
          }
        } else {
          // treat unknown state as open (back-compat) and any explicit 'open'
          hasOpenPRForFile = true;
        }
      }

      if (hasOpenPRForFile) {
        logger.info(`✓ Skipping ${target.name} - has open capability upgrade PR`);
        return [];
      }

      if (coolingUntil !== null) {
        const daysLeft = Math.ceil((coolingUntil - Date.now()) / (24 * 60 * 60 * 1000));
        logger.info(`✓ Skipping ${target.name} - a capability upgrade PR against it was closed; cooling down for ${daysLeft} more day(s)`);
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

      // Drop upgrades whose (file + type) was already MERGED — different types
      // on the same file are still allowed.
      if (mergedTypesForFile.size > 0 && upgrades.length > 0) {
        const before = upgrades.length;
        const kept = upgrades.filter(u => !mergedTypesForFile.has(u.type));
        const dropped = before - kept.length;
        if (dropped > 0) {
          logger.info(`✓ ${target.name}: dropped ${dropped} upgrade(s) whose type already merged (${[...mergedTypesForFile].join(', ')})`);
        }
        return kept;
      }

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

      // Token budget: reasoning models (gpt-5, o-series) consume the budget
      // internally before any visible content. We were observing length=0
      // responses across every file with maxTokens=2000 because the model
      // averaged ~1,871 reasoning tokens per call and ran out of room for
      // the JSON output. Bumped to 10K plus reasoning_effort=low to cap the
      // think-time. Non-reasoning providers (anthropic, gab, etc.) ignore
      // both — the cap is harmless overhead for them.
      const analysisOptions = {
        maxTokens: 10000,
        temperature: 0.3,
        enableWebSearch: false,
        retries: ANALYSIS_RETRIES,
        additionalParams: { reasoning_effort: 'low' }
      };

      // Watchdog for a provider that never returns at all — deliberately ABOVE the
      // provider's own budget, never below it.
      //
      // This was a hard-coded 60s while HuggingFace's budget for this very call is
      // 90s (it scales with maxTokens and is capped at 90s — raised to 90s *for*
      // these code-generation calls). So the watchdog always fired first: every
      // analysis that ran long was rejected 30s before the provider was even
      // allowed to answer, so the slow tail could never succeed — 54 "AI analysis
      // timeout" failures between 2026-09-02 and 09-06 (119 succeeded against 21
      // lost on 09-05, 22 against 7 on 09-06), each also burning a full 60s of the
      // scan window. ollama's budget is 600s, which this would truncate tenfold.
      //
      // Ask the provider what it allows and sit above it, so this stays a backstop
      // against a hung request rather than a second opinion on how long a call may
      // take — and so it cannot silently fall behind the provider again.
      //
      // getGenerationTimeoutMs reports the budget for the whole RETRY LOOP, not one
      // attempt at it. Sizing this from a single attempt's 90s was the same bug over
      // again one layer down: the loop beneath this watchdog is allowed several
      // attempts, so a watchdog set 15s above one of them aborts partway through the
      // next. It was masked only because a timeout was classified non-retryable and
      // the loop therefore never took a second attempt.
      const providerBudgetMs = await this.agent.providerManager.getGenerationTimeoutMs?.(analysisOptions);
      const watchdogMs =
        Math.max(Number(providerBudgetMs) > 0 ? Number(providerBudgetMs) : 0, ANALYSIS_MIN_WATCHDOG_MS) +
        ANALYSIS_WATCHDOG_MARGIN_MS;

      let timeoutHandle;
      const timeoutPromise = new Promise((resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`AI analysis timeout after ${watchdogMs}ms`)),
          watchdogMs
        );
      });

      const analysisPromise = this.agent.providerManager.generateResponse(prompt, analysisOptions);

      let response;
      try {
        response = await Promise.race([analysisPromise, timeoutPromise]);
      } finally {
        // The loser of the race is never awaited; leaving its timer armed keeps a
        // ref'd handle alive for the full budget on every successful analysis.
        clearTimeout(timeoutHandle);
      }

      // Debug: log raw AI response for troubleshooting
      const rawContent = response?.content || '';
      logger.info(`[scanner-debug] ${target.name} response length=${rawContent.length}, first500=${rawContent.substring(0, 500).replace(/\n/g, '\\n')}`);

      if (!rawContent.trim()) {
        logger.info(`[scanner] ${target.name}: empty AI response, treating as 0 upgrades (see anthropic provider log for refusal/stop_reason)`);
        return [];
      }

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

