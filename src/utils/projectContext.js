import { logger } from './logger.js';
import { retryOperation } from './retryUtils.js';
import NodeCache from 'node-cache';

/**
 * In-memory cache for active project data
 */
const projectCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ─── Fuzzy matching helpers (no external deps) ────────────────────────────────

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function damerauLevenshtein(a, b) {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[al][bl];
}

function tokenize(s) {
  const norm = normalize(s);
  if (!norm) return new Set();
  return new Set(norm.split(' ').filter(Boolean));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Multi-mode fuzzy match: exact > substring > short-token Damerau-Levenshtein > Jaccard.
 * Returns { match: bool, score: [0,1] }.
 */
function fuzzyMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return { match: false, score: 0 };
  if (na === nb) return { match: true, score: 1 };
  if (na.includes(nb) || nb.includes(na)) {
    const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    return { match: ratio >= 0.6, score: Math.max(0.6, ratio) };
  }
  if (na.length <= 6 && nb.length <= 12) {
    const d = damerauLevenshtein(na, nb);
    if (d <= 2) return { match: true, score: Math.max(0.5, 1 - d / Math.max(na.length, nb.length, 3)) };
  }
  const jac = jaccard(tokenize(na), tokenize(nb));
  if (jac >= 0.7) return { match: true, score: jac };
  return { match: false, score: 0 };
}

/**
 * Build alias map from hardcoded defaults + optional agent config:
 *   agent.config?.projectContext?.aliases = { canonicalName: [aliases...] }
 */
function buildAliasMap(agent) {
  const map = {};
  const add = (canonical, aliases) => {
    const key = normalize(canonical);
    if (!map[key]) map[key] = new Set();
    for (const a of aliases) map[key].add(normalize(a));
    map[key].add(key);
  };
  add('lanagent', ['lanagent', 'lan agent', 'this agent', 'your code', 'your system', 'agent itself']);
  try {
    const cfgAliases = agent?.config?.projectContext?.aliases;
    if (cfgAliases && typeof cfgAliases === 'object') {
      for (const [canonical, aliases] of Object.entries(cfgAliases)) {
        if (Array.isArray(aliases)) add(canonical, aliases);
      }
    }
  } catch (e) {
    logger.warn('Failed to read projectContext aliases from agent config:', e);
  }
  return map;
}

/**
 * Determines which project an issue/bug report should be created for
 * based on the user's message and current context
 */
export async function determineProjectForIssue(message, agent) {
  const lowerMessage = message.toLowerCase();
  
  // Check for explicit project mentions
  const projectMentions = {
    'lanagent': ['lanagent', 'lan agent', 'this agent', 'your code', 'your system', 'agent itself'],
    'alice': ['alice', 'a.l.i.c.e'],
    'itself': ['yourself', 'your own', 'self', 'this system']
  };
  
  // Check if LANAgent is explicitly mentioned
  for (const mention of projectMentions.lanagent) {
    if (lowerMessage.includes(mention)) {
      return {
        project: 'LANAgent',
        repo: 'LANAgent',
        owner: 'PortableDiag',
        confidence: 'high'
      };
    }
  }
  
  // Check if referring to the agent itself
  for (const mention of projectMentions.itself) {
    if (lowerMessage.includes(mention)) {
      return {
        project: 'LANAgent',
        repo: 'LANAgent', 
        owner: 'PortableDiag',
        confidence: 'high'
      };
    }
  }
  
  // Check project manager for active projects
  try {
    const projectsPlugin = agent.apiManager?.getPlugin('projects');
    if (projectsPlugin) {
      const activeProjects = await getCachedProjects(() => 
        retryOperation(
          () => projectsPlugin.execute({ action: 'list', status: 'active' }),
          { retries: 3 }
        )
      );
      
      if (activeProjects?.success && activeProjects.projects) {
        // Fuzzy/alias matching across active projects. Exact matches still win
        // (score=1); fuzzy hits get a discounted score and the best candidate is
        // returned (ties broken by most-recent lastActivity).
        const aliasMap = buildAliasMap(agent);
        const messageTokens = Array.from(tokenize(lowerMessage));
        let bestCandidate = null;

        for (const project of activeProjects.projects) {
          try {
            const projectName = project?.name ? String(project.name) : '';
            const normProjectName = normalize(projectName);
            if (!normProjectName) continue;

            let matchType = null;
            let matchScore = 0;
            let matchReason = null;

            if (lowerMessage.includes(normProjectName)) {
              matchType = 'exact';
              matchScore = 1;
              matchReason = 'exact_project_name';
            } else {
              const aliases = aliasMap[normProjectName] || new Set([normProjectName]);
              for (const alias of aliases) {
                for (const mt of messageTokens) {
                  const { match, score } = fuzzyMatch(mt, alias);
                  if (match && score > matchScore) {
                    matchType = 'fuzzy';
                    matchScore = score * 0.85;
                    matchReason = `fuzzy_alias_match:${alias}`;
                  }
                }
                const { match: wholeMatch, score: wholeScore } = fuzzyMatch(lowerMessage, alias);
                if (wholeMatch && wholeScore > matchScore) {
                  matchType = 'fuzzy';
                  matchScore = wholeScore * 0.8;
                  matchReason = `fuzzy_alias_match:${alias}`;
                }
              }
              if (!matchType) {
                for (const mt of messageTokens) {
                  const { match, score } = fuzzyMatch(mt, normProjectName);
                  if (match && score > matchScore) {
                    matchType = 'fuzzy';
                    matchScore = score * 0.8;
                    matchReason = 'fuzzy_project_name';
                  }
                }
              }
            }

            if (matchType) {
              const repoMatch = project.repository?.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
              if (repoMatch) {
                const scoreValue = matchType === 'exact' ? 1 : matchScore;
                const lastActivity = new Date(project.lastActivity || 0).getTime();
                const candidate = {
                  project: project.name,
                  repo: repoMatch[2],
                  owner: repoMatch[1],
                  confidence: matchType === 'exact'
                    ? 'high'
                    : matchScore >= 0.9 ? 'high'
                    : matchScore >= 0.7 ? 'medium'
                    : 'low',
                  reason: matchReason,
                  __score: scoreValue,
                  __lastActivity: lastActivity
                };
                if (!bestCandidate || scoreValue > bestCandidate.__score
                    || (scoreValue === bestCandidate.__score && lastActivity > bestCandidate.__lastActivity)) {
                  bestCandidate = candidate;
                }
              }
            }
          } catch (e) {
            logger.warn('Error while evaluating project candidate:', { error: e?.message, project });
          }
        }

        if (bestCandidate) {
          delete bestCandidate.__score;
          delete bestCandidate.__lastActivity;
          return bestCandidate;
        }

        // Check for "this project" or "current project"
        if (lowerMessage.includes('this project') || lowerMessage.includes('current project')) {
          // Find most recently active project
          const sortedProjects = activeProjects.projects
            .filter(p => p.repository && p.repository.includes('github.com'))
            .sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));
            
          if (sortedProjects.length > 0) {
            const repoMatch = sortedProjects[0].repository.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
            if (repoMatch) {
              return {
                project: sortedProjects[0].name,
                repo: repoMatch[2],
                owner: repoMatch[1],
                confidence: 'medium'
              };
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error checking project manager:', error);
  }
  
  // Check git working directory
  try {
    const gitPlugin = agent.apiManager?.getPlugin('git');
    if (gitPlugin) {
      const gitStatus = await retryOperation(
        () => gitPlugin.execute({ action: 'status' }),
        { retries: 3 }
      );
      if (gitStatus.success) {
        // We're in a git repo, try to get remote URL
        const remote = await retryOperation(
          () => gitPlugin.execute({ action: 'remote', subAction: 'get-url', name: 'origin' }),
          { retries: 3 }
        );
        
        if (remote.success && remote.url) {
          const repoMatch = remote.url.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
          if (repoMatch) {
            return {
              project: repoMatch[2],
              repo: repoMatch[2],
              owner: repoMatch[1],
              confidence: lowerMessage.includes('this') ? 'high' : 'medium'
            };
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error checking git context:', error);
  }
  
  // Default to LANAgent if no other context found
  if (lowerMessage.includes('bug') || lowerMessage.includes('issue') || lowerMessage.includes('problem')) {
    return {
      project: 'LANAgent',
      repo: 'LANAgent',
      owner: 'PortableDiag',
      confidence: 'low',
      reason: 'No specific project mentioned, defaulting to LANAgent'
    };
  }
  
  return null;
}

/**
 * Get cached projects or fetch them if not cached
 * @param {Function} fetchFunc - Function to fetch projects if not cached
 * @returns {Promise<Object>} - The active projects data
 */
async function getCachedProjects(fetchFunc) {
  const cacheKey = 'activeProjects';
  const cachedProjects = projectCache.get(cacheKey);
  if (cachedProjects !== undefined) {
    return cachedProjects;
  }
  const projects = await fetchFunc();
  projectCache.set(cacheKey, projects);
  return projects;
}

/**
 * Parse issue details from natural language
 */
export function parseIssueDetails(message) {
  const lowerMessage = message.toLowerCase();
  
  // Determine issue type
  let labels = [];
  if (lowerMessage.includes('bug') || lowerMessage.includes('error') || lowerMessage.includes('crash')) {
    labels.push('bug');
  }
  if (lowerMessage.includes('feature') || lowerMessage.includes('enhancement') || lowerMessage.includes('add')) {
    labels.push('enhancement');
  }
  if (lowerMessage.includes('docs') || lowerMessage.includes('documentation')) {
    labels.push('documentation');
  }
  if (lowerMessage.includes('performance') || lowerMessage.includes('slow') || lowerMessage.includes('memory')) {
    labels.push('performance');
  }
  
  // Extract title - look for patterns like "about X", "for Y", "with Z"
  let title = message;
  const titlePatterns = [
    /(?:create|add|file|report)\s+(?:an?\s+)?(?:issue|bug|report)\s+(?:for\s+\w+\s+)?(?:about|regarding|with)\s+(.+)/i,
    /(?:bug|issue|problem)\s+(?:with|in|about)\s+(.+)/i,
    /(.+)\s+(?:is|isn't|not)\s+(?:working|functioning)/i,
    /(?:create|add|file|report)\s+(?:an?\s+)?(?:issue|bug)\s+(?:for|about)?\s*(.+)/i
  ];
  
  for (const pattern of titlePatterns) {
    const match = message.match(pattern);
    if (match) {
      title = match[1].trim();
      break;
    }
  }
  
  // Remove project names from title if they're at the start
  const projectNames = ['lanagent', 'alice', 'mywebapp', 'data-analyzer', 'this project', 'your code'];
  for (const proj of projectNames) {
    if (title.toLowerCase().startsWith(proj)) {
      title = title.substring(proj.length).trim();
      // Remove connecting words
      title = title.replace(/^(about|regarding|with|for)\s+/i, '');
    }
  }
  
  // Clean up the title
  title = title
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .replace(/^(that|where|which)\s+/i, '')
    .trim();
    
  // Capitalize first letter
  title = title.charAt(0).toUpperCase() + title.slice(1);
  
  return {
    title,
    labels,
    body: message // Use full message as body for context
  };
}
