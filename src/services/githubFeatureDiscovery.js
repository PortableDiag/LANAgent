import { logger } from '../utils/logger.js';
import { execSync } from 'child_process';
import axios from 'axios';

export class GitHubFeatureDiscovery {
  constructor(agent, gitToken) {
    this.agent = agent;
    this.gitToken = gitToken || process.env.GIT_PERSONAL_ACCESS_TOKEN;
    this.baseURL = 'https://api.github.com';
    
    // Search queries for finding similar projects
    this.searchQueries = [
      'ai agent automation',
      'personal assistant agent',
      'lan agent network',
      'home automation agent',
      'ai code assistant',
      'self-modifying agent',
      'autonomous agent system',
      'telegram bot ai agent',
      'voice assistant agent',
      'task automation agent'
    ];
    
    // Known similar projects to monitor
    this.knownProjects = [
      { owner: 'openclaw', repo: 'openclaw' },       // Multi-channel AI assistant
      { owner: 'Significant-Gravitas', repo: 'AutoGPT' },
      { owner: 'geekan', repo: 'MetaGPT' },
      { owner: 'microsoft', repo: 'autogen' },
      { owner: 'AntonOsika', repo: 'gpt-engineer' },
      { owner: 'e2b-dev', repo: 'awesome-ai-agents' },
      { owner: 'OpenBMB', repo: 'ChatDev' },
      { owner: 'kyegomez', repo: 'swarms' },
      { owner: 'langchain-ai', repo: 'langchain' },
      { owner: 'khoj-ai', repo: 'khoj' },           // Personal AI assistant
      { owner: 'mem0ai', repo: 'mem0' },            // Memory layer for AI
      { owner: 'plandex-ai', repo: 'plandex' },     // AI coding engine
      { owner: 'All-Hands-AI', repo: 'OpenHands' }, // AI software dev agents
      { owner: 'joaomdmoura', repo: 'crewAI' }      // Multi-agent framework
    ];
  }
  
  /**
   * Search GitHub for similar AI agent projects and extract features
   */
  async discoverFeaturesFromGitHub() {
    try {
      logger.info('🔍 Starting GitHub feature discovery...');
      
      const discoveredFeatures = [];
      
      // 1. Search for similar projects
      const similarProjects = await this.searchForSimilarProjects();
      logger.info(`Found ${similarProjects.length} similar projects to analyze`);
      
      // 2. Analyze each project for interesting features
      for (const project of similarProjects.slice(0, 10)) { // Limit to 10 for rate limits
        try {
          const features = await this.analyzeProjectForFeatures(project);
          discoveredFeatures.push(...features);
          
          // Small delay to respect rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logger.warn(`Failed to analyze ${project.full_name}: ${error.message}`);
        }
      }
      
      // 3. Search for specific feature implementations
      const specificFeatures = await this.searchForSpecificFeatures();
      discoveredFeatures.push(...specificFeatures);
      
      // 4. Deduplicate and prioritize
      const uniqueFeatures = this.deduplicateFeatures(discoveredFeatures);
      const prioritizedFeatures = this.prioritizeFeatures(uniqueFeatures);
      
      logger.info(`🚀 Discovered ${prioritizedFeatures.length} unique features from GitHub`);
      return prioritizedFeatures;
      
    } catch (error) {
      logger.error('GitHub feature discovery failed:', error);
      return [];
    }
  }
  
  /**
   * Search for similar AI agent projects
   */
  async searchForSimilarProjects() {
    const projects = [];
    
    try {
      // Search using various queries
      for (const query of this.searchQueries.slice(0, 3)) { // Limit queries to avoid rate limits
        const response = await this.githubAPI('/search/repositories', {
          q: `${query} language:javascript language:python stars:>50`,
          sort: 'stars',
          order: 'desc',
          per_page: 10
        });
        
        if (response.items) {
          projects.push(...response.items);
        }
      }
      
      // Add known projects
      for (const project of this.knownProjects) {
        try {
          const repo = await this.githubAPI(`/repos/${project.owner}/${project.repo}`);
          if (repo) {
            projects.push(repo);
          }
        } catch (e) {
          // Skip if not found
        }
      }
      
      // Deduplicate by repo ID
      const seen = new Set();
      return projects.filter(p => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
      
    } catch (error) {
      logger.error('Failed to search for similar projects:', error);
      return [];
    }
  }
  
  /**
   * Analyze a project for interesting features
   */
  async analyzeProjectForFeatures(project) {
    const features = [];
    
    try {
      logger.info(`Analyzing ${project.full_name} for features...`);
      
      // 1. Get README to understand features
      const readme = await this.getProjectReadme(project);
      if (readme) {
        const readmeFeatures = this.extractFeaturesFromReadme(readme, project);
        features.push(...readmeFeatures);
      }
      
      // 2. Analyze repository structure
      const structure = await this.getRepoStructure(project);
      const structureFeatures = this.extractFeaturesFromStructure(structure, project);
      features.push(...structureFeatures);
      
      // 3. Look at recent commits for new features
      const commits = await this.getRecentCommits(project);
      const commitFeatures = this.extractFeaturesFromCommits(commits, project);
      features.push(...commitFeatures);
      
      // 4. Check for plugins/extensions
      const plugins = await this.checkForPlugins(project);
      features.push(...plugins);
      
      return features;
      
    } catch (error) {
      logger.error(`Failed to analyze ${project.full_name}:`, error);
      return [];
    }
  }
  
  /**
   * Get project README content
   */
  async getProjectReadme(project) {
    try {
      const readme = await this.githubAPI(`/repos/${project.full_name}/readme`);
      if (readme && readme.content) {
        return Buffer.from(readme.content, 'base64').toString('utf8');
      }
    } catch (error) {
      logger.debug(`No README found for ${project.full_name}`);
    }
    return null;
  }
  
  /**
   * Extract features from README content
   */
  extractFeaturesFromReadme(readme, project) {
    const features = [];
    const lines = readme.split('\n');
    
    // Look for feature sections
    const featurePatterns = [
      /^#{1,3}\s*Features?$/i,
      /^#{1,3}\s*Capabilities?$/i,
      /^#{1,3}\s*What.*(can|does)/i,
      /^#{1,3}\s*Functionality/i
    ];
    
    let inFeatureSection = false;
    let currentFeature = null;
    let featureContext = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check if we're entering a features section
      if (featurePatterns.some(pattern => pattern.test(line))) {
        inFeatureSection = true;
        featureContext = [];
        continue;
      }
      
      // Stop at next major section
      if (inFeatureSection && /^#{1,3}\s*\w/.test(line) && !featurePatterns.some(p => p.test(line))) {
        inFeatureSection = false;
      }
      
      // Extract features from lists
      if (inFeatureSection) {
        const listMatch = line.match(/^[\s-*]+(.+)/);
        if (listMatch) {
          const featureText = listMatch[1].trim();
          
          // Skip generic or already implemented features
          if (!this.isGenericFeature(featureText) && !this.isAlreadyImplemented(featureText)) {
            // Capture surrounding context (3 lines before and after)
            const contextStart = Math.max(0, i - 3);
            const contextEnd = Math.min(lines.length - 1, i + 3);
            const contextSnippet = lines.slice(contextStart, contextEnd + 1).join('\n');
            
            features.push({
              type: 'readme_feature',
              description: featureText,
              source: project.full_name,
              sourceUrl: project.html_url,
              confidence: 'medium',
              implementation: this.suggestImplementation(featureText),
              // Add context for storage
              githubReference: {
                repository: project.full_name,
                url: project.html_url,
                filePath: 'README.md',
                codeSnippet: contextSnippet,
                language: 'markdown',
                contextNotes: `Feature found in README features section`
              }
            });
          }
        }
        
        // Keep track of feature context
        featureContext.push(line);
        if (featureContext.length > 10) {
          featureContext.shift();
        }
      }
    }
    
    return features;
  }
  
  /**
   * Get repository structure
   */
  async getRepoStructure(project) {
    try {
      const contents = await this.githubAPI(`/repos/${project.full_name}/contents`);
      return contents || [];
    } catch (error) {
      logger.debug(`Could not get structure for ${project.full_name}`);
      return [];
    }
  }
  
  /**
   * Extract features from repository structure
   */
  extractFeaturesFromStructure(structure, project) {
    const features = [];

    // Only look for DIRECTORIES that suggest features (not config files)
    const interestingDirs = {
      'voice': 'Voice command capabilities',
      'speech': 'Speech recognition/synthesis',
      'vision': 'Computer vision capabilities',
      'scheduler': 'Scheduling and cron features',
      'workflow': 'Workflow automation',
      'integrations': 'Third-party integrations',
      'dashboard': 'Web dashboard interface',
      'analytics': 'Analytics and reporting',
      'notifications': 'Notification system',
      'webhooks': 'Webhook support',
      'graphql': 'GraphQL API',
      'realtime': 'Real-time features',
      'websocket': 'WebSocket support',
      'canvas': 'Visual canvas features',
      'agents': 'Multi-agent capabilities',
      'skills': 'Skills/plugin system',
      'memory': 'Memory/context management',
      'tools': 'Tool/function calling'
    };

    // Files/dirs to explicitly ignore
    const ignorePatterns = [
      /^\./, // Hidden files/dirs
      /\.ya?ml$/, /\.json$/, /\.toml$/, /\.md$/, /\.txt$/, // Config files
      /license/i, /readme/i, /changelog/i, /security/i, // Doc files
      /node_modules/, /vendor/, /dist/, /build/ // Build artifacts
    ];

    for (const item of structure) {
      // Skip files, only process directories
      if (item.type !== 'dir') continue;

      const lowercaseName = item.name.toLowerCase();

      // Skip ignored patterns
      if (ignorePatterns.some(p => p.test(lowercaseName))) continue;

      for (const [keyword, feature] of Object.entries(interestingDirs)) {
        if (lowercaseName.includes(keyword) && !this.isAlreadyImplemented(feature)) {
          features.push({
            type: 'structure_feature',
            description: `${feature} (found ${item.name}/ directory in ${project.name})`,
            source: project.full_name,
            sourceUrl: `${project.html_url}/tree/main/${item.path}`,
            confidence: 'medium',
            implementation: `Investigate ${item.path}/ implementation patterns`,
            githubReference: {
              repository: project.full_name,
              url: `${project.html_url}/tree/main/${item.path}`,
              filePath: item.path,
              codeSnippet: `Directory: ${item.name}/\nPath: ${item.path}`,
              language: 'text',
              contextNotes: `Feature directory found in repository structure`
            }
          });
        }
      }
    }

    return features;
  }
  
  /**
   * Get recent commits
   */
  async getRecentCommits(project) {
    try {
      const commits = await this.githubAPI(`/repos/${project.full_name}/commits`, {
        per_page: 20
      });
      return commits || [];
    } catch (error) {
      logger.debug(`Could not get commits for ${project.full_name}`);
      return [];
    }
  }
  
  /**
   * Extract features from commit messages
   */
  extractFeaturesFromCommits(commits, project) {
    const features = [];
    
    const featurePatterns = [
      /^feat(?:ure)?[:(]\s*(.+)/i,
      /^add(?:ed)?[:(]\s*(.+)/i,
      /^implement(?:ed)?[:(]\s*(.+)/i,
      /^new[:(]\s*(.+)/i
    ];
    
    for (const commit of commits) {
      if (!commit.commit) continue;
      
      const message = commit.commit.message;
      
      for (const pattern of featurePatterns) {
        const match = message.match(pattern);
        if (match) {
          const featureText = match[1].trim();
          
          if (!this.isGenericFeature(featureText) && !this.isAlreadyImplemented(featureText)) {
            features.push({
              type: 'commit_feature',
              description: featureText,
              source: project.full_name,
              sourceUrl: commit.html_url,
              confidence: 'high',
              implementation: `Study commit: ${commit.sha.substring(0, 7)}`,
              // Add GitHub reference for commits
              githubReference: {
                repository: project.full_name,
                url: commit.html_url,
                filePath: 'commit',
                codeSnippet: `Commit: ${commit.sha}\nAuthor: ${commit.commit.author.name}\nDate: ${commit.commit.author.date}\n\n${commit.commit.message}`,
                language: 'text',
                contextNotes: `Feature extracted from commit message`
              }
            });
          }
          break;
        }
      }
    }
    
    return features;
  }
  
  /**
   * Check for plugins/extensions in the project
   */
  async checkForPlugins(project) {
    const plugins = [];
    
    try {
      // Look for plugins directory
      const pluginDirs = ['plugins', 'extensions', 'modules', 'addons'];
      
      for (const dir of pluginDirs) {
        try {
          const contents = await this.githubAPI(`/repos/${project.full_name}/contents/${dir}`);
          
          if (contents && Array.isArray(contents)) {
            for (const item of contents) {
              if (item.type === 'file' && item.name.endsWith('.js')) {
                const pluginName = item.name.replace('.js', '');
                
                if (!this.isAlreadyImplemented(pluginName)) {
                  // Try to fetch the actual plugin code
                  let codeSnippet = '';
                  let implementationExample = null;
                  
                  try {
                    const fileContent = await this.getFileContent(project.full_name, item.path);
                    if (fileContent) {
                      // Extract first 50 lines or main function
                      const lines = fileContent.split('\n');
                      codeSnippet = lines.slice(0, 50).join('\n');
                      
                      // Try to find main export or class definition
                      const classMatch = fileContent.match(/class\s+(\w+)[\s\S]*?{[\s\S]*?constructor[\s\S]*?}/);
                      const exportMatch = fileContent.match(/export\s+(default\s+)?(function|const|class)[\s\S]*?{[\s\S]*?}/);
                      
                      if (classMatch || exportMatch) {
                        implementationExample = {
                          source: project.full_name,
                          description: `${pluginName} implementation`,
                          code: (classMatch || exportMatch)[0].substring(0, 1000),
                          language: 'javascript'
                        };
                      }
                    }
                  } catch (e) {
                    logger.debug(`Could not fetch plugin code for ${item.path}`);
                  }
                  
                  plugins.push({
                    type: 'plugin_idea',
                    description: `${pluginName} plugin (from ${project.name})`,
                    source: project.full_name,
                    sourceUrl: `${project.html_url}/blob/main/${item.path}`,
                    confidence: 'high',
                    implementation: `Port ${item.path} to our plugin system`,
                    githubReference: {
                      repository: project.full_name,
                      url: `${project.html_url}/blob/main/${item.path}`,
                      filePath: item.path,
                      codeSnippet: codeSnippet,
                      language: 'javascript',
                      contextNotes: `Plugin found in ${dir} directory`
                    },
                    implementationExample: implementationExample
                  });
                }
              }
            }
          }
        } catch (e) {
          // Directory doesn't exist
        }
      }
    } catch (error) {
      logger.debug(`Could not check plugins for ${project.full_name}`);
    }
    
    return plugins;
  }
  
  /**
   * Search for specific feature implementations
   */
  async searchForSpecificFeatures() {
    const features = [];
    
    // Search for specific implementations we might want
    const searches = [
      { query: 'voice recognition agent', feature: 'Voice command system' },
      { query: 'agent memory persistence', feature: 'Long-term memory system' },
      { query: 'agent learning from feedback', feature: 'Learning from user feedback' },
      { query: 'multi-agent collaboration', feature: 'Multi-agent coordination' },
      { query: 'agent task scheduling cron', feature: 'Advanced task scheduling' },
      { query: 'agent web scraping automation', feature: 'Advanced web automation' },
      { query: 'agent code generation', feature: 'Code generation capabilities' },
      { query: 'agent self improvement', feature: 'Self-improvement mechanisms' }
    ];
    
    for (const search of searches.slice(0, 3)) { // Limit to avoid rate limits
      try {
        const response = await this.githubAPI('/search/code', {
          q: `${search.query} language:javascript`,
          per_page: 5
        });
        
        if (response.items) {
          for (const item of response.items) {
            if (!this.isAlreadyImplemented(search.feature)) {
              features.push({
                type: 'code_search_feature',
                description: search.feature,
                source: item.repository.full_name,
                sourceUrl: item.html_url,
                confidence: 'medium',
                implementation: `Study implementation in ${item.path}`,
                // Add GitHub reference for code search
                githubReference: {
                  repository: item.repository.full_name,
                  url: item.html_url,
                  filePath: item.path,
                  codeSnippet: `Code search result for: ${search.query}\nFile: ${item.path}\nMatch: ${item.text_matches ? item.text_matches[0]?.fragment : 'See file'}`,
                  language: 'text',
                  contextNotes: `Feature found via GitHub code search`
                }
              });
            }
          }
        }
      } catch (error) {
        logger.debug(`Search failed for: ${search.query}`);
      }
    }
    
    return features;
  }
  
  /**
   * Check if a feature is generic/common
   */
  isGenericFeature(feature) {
    const generic = [
      'bug fix', 'fixed', 'update', 'updated', 'refactor',
      'cleanup', 'improve', 'enhancement', 'test', 'tests',
      'docs', 'documentation', 'readme', 'typo', 'lint'
    ];
    
    const lowerFeature = feature.toLowerCase();
    return generic.some(g => lowerFeature.includes(g));
  }
  
  /**
   * Check if we already have this feature
   */
  isAlreadyImplemented(feature) {
    const implemented = [
      'telegram', 'git', 'commit', 'email', 'weather',
      'search', 'reminder', 'task', 'todo', 'project',
      'memory', 'context', 'plugin', 'command', 'web interface',
      'api', 'webhook', 'notification'
    ];
    
    const lowerFeature = feature.toLowerCase();
    return implemented.some(i => lowerFeature.includes(i));
  }
  
  /**
   * Suggest implementation approach
   */
  suggestImplementation(feature) {
    const lowerFeature = feature.toLowerCase();
    
    if (lowerFeature.includes('voice') || lowerFeature.includes('speech')) {
      return 'Create voice plugin using Web Speech API or speech-to-text service';
    }
    if (lowerFeature.includes('vision') || lowerFeature.includes('image')) {
      return 'Create vision plugin using computer vision APIs';
    }
    if (lowerFeature.includes('schedule') || lowerFeature.includes('cron')) {
      return 'Enhance task scheduler with cron expressions';
    }
    if (lowerFeature.includes('workflow')) {
      return 'Create workflow automation system with visual builder';
    }
    if (lowerFeature.includes('dashboard')) {
      return 'Enhance web interface with dashboard features';
    }
    
    return 'Research and implement based on source project';
  }
  
  /**
   * Deduplicate discovered features
   */
  deduplicateFeatures(features) {
    const seen = new Map();
    
    for (const feature of features) {
      const key = feature.description.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      if (!seen.has(key) || feature.confidence === 'high') {
        seen.set(key, feature);
      }
    }
    
    return Array.from(seen.values());
  }
  
  /**
   * Prioritize features by value
   */
  prioritizeFeatures(features) {
    return features.sort((a, b) => {
      // Priority order: high confidence > medium > low
      const confidenceScore = { high: 3, medium: 2, low: 1 };
      const scoreA = confidenceScore[a.confidence] || 0;
      const scoreB = confidenceScore[b.confidence] || 0;
      
      return scoreB - scoreA;
    });
  }
  
  /**
   * Get file content from repository
   */
  async getFileContent(repoFullName, filePath) {
    try {
      const content = await this.githubAPI(`/repos/${repoFullName}/contents/${filePath}`);
      if (content && content.content) {
        return Buffer.from(content.content, 'base64').toString('utf8');
      }
    } catch (error) {
      logger.debug(`Could not fetch file content for ${filePath}: ${error.message}`);
    }
    return null;
  }
  
  /**
   * Make GitHub API request
   */
  async githubAPI(endpoint, params = {}) {
    try {
      const url = new URL(`${this.baseURL}${endpoint}`);
      Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
      
      const response = await axios.get(url.toString(), {
        headers: {
          'Authorization': `token ${this.gitToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'LANAgent/1.0'
        },
        timeout: 10000
      });
      
      return response.data;
      
    } catch (error) {
      if (error.response?.status === 403) {
        logger.warn('GitHub API rate limit reached');
      }
      throw error;
    }
  }
}