import { logger } from './logger.js';
import { retryOperation } from './retryUtils.js';

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
      const activeProjects = await retryOperation(
        () => projectsPlugin.execute({ action: 'list', status: 'active' }),
        { retries: 3 }
      );
      
      if (activeProjects.success && activeProjects.projects) {
        // Look for project names in the message
        for (const project of activeProjects.projects) {
          const projectName = project.name.toLowerCase();
          if (lowerMessage.includes(projectName)) {
            // Try to extract GitHub repo info from project
            const repoMatch = project.repository?.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
            if (repoMatch) {
              return {
                project: project.name,
                repo: repoMatch[2],
                owner: repoMatch[1],
                confidence: 'high'
              };
            }
          }
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