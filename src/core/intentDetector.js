import { logger } from '../utils/logger.js';

export class IntentDetector {
  constructor() {
    this.intents = this.defineIntents();
  }

  defineIntents() {
    return {
      // Email intents
      sendEmail: {
        patterns: [
          /send\s+(?:an?\s+)?email\s+to\s+(\S+@\S+)/i,
          /email\s+(\S+@\S+)/i,
          /(?:send|write)\s+(?:a\s+)?(?:message|mail)\s+to\s+(\S+@\S+)/i,
          /reach\s+out\s+to\s+(\S+@\S+)/i,
          /contact\s+(\S+@\S+)/i,
          /tell\s+(\S+@\S+)/i,
        ],
        extractParams: (text) => {
          const emailMatch = text.match(/(\S+@\S+\.\S+)/);
          const subjectMatch = text.match(/subject[:\s]+["']?([^"'\n]+)["']?/i);
          const bodyMatch = text.match(/(?:message|body|text)[:\s]+["']?([^"'\n]+)["']?/i) ||
                           text.match(/with\s+(?:message|text)[:\s]+["']?([^"'\n]+)["']?/i);
          
          // Extract the actual message content more intelligently
          let messageContent = '';
          
          if (bodyMatch) {
            messageContent = bodyMatch[1];
          } else {
            // Try to extract content after common patterns
            const patterns = [
              /(?:tell|inform|let|notify)\s+(?:them|him|her)\s+(?:that|about)\s+(.+)/i,
              /(?:say|saying|and say)\s+(?:that\s+)?(.+)/i,
              /(?:message|text|content|body)[:\s]+(.+)/i,
              /to\s+\S+@\S+\s+(?:that|saying|about)\s+(.+)/i,
              /reach out.*?and\s+(.+)/i,
              /contact.*?and\s+(.+)/i
            ];
            
            for (const pattern of patterns) {
              const match = text.match(pattern);
              if (match) {
                messageContent = match[1].trim();
                break;
              }
            }
            
            // If still no content, use the whole text minus the email command
            if (!messageContent) {
              messageContent = text
                .replace(/(?:send|email|reach out to|contact|tell)\s+\S+@\S+/i, '')
                .replace(/^\s*(and|to|about|that)\s+/i, '')
                .trim();
            }
          }
          
          return {
            plugin: 'email',
            action: 'send',
            params: {
              to: emailMatch ? emailMatch[1] : null,
              subject: subjectMatch ? subjectMatch[1] : `Message from ${process.env.AGENT_NAME || 'LANAgent'}`,
              text: messageContent || 'No message content provided'
            }
          };
        }
      },

      // Git intents
      gitStatus: {
        patterns: [
          /git\s+status/i,
          /show\s+(?:me\s+)?(?:the\s+)?git\s+status/i,
          /what['']?s\s+the\s+git\s+status/i,
          /check\s+git\s+status/i
        ],
        extractParams: () => ({
          plugin: 'git',
          action: 'status',
          params: {}
        })
      },

      gitCommit: {
        patterns: [
          /git\s+commit/i,
          /commit\s+(?:the\s+)?changes/i,
          /make\s+a\s+commit/i
        ],
        extractParams: (text) => {
          const messageMatch = text.match(/(?:message|with)[:\s]+["']?([^"'\n]+)["']?/i);
          return {
            plugin: 'git',
            action: 'commit',
            params: {
              message: messageMatch ? messageMatch[1] : 'Auto-commit by ALICE',
              files: ['.']
            }
          };
        }
      },

      gitClone: {
        patterns: [
          /clone\s+(?:the\s+)?(?:repository|repo)/i,
          /git\s+clone/i,
          /clone\s+yourself/i
        ],
        extractParams: (text) => {
          const pathMatch = text.match(/(?:to|into|in)\s+(?:directory\s+)?["']?([^"'\s]+)["']?/i);
          return {
            plugin: 'git',
            action: 'clone',
            params: {
              url: 'https://github.com/PortableDiag/LANAgent.git',
              destination: pathMatch ? pathMatch[1] : './LANAgent-clone'
            }
          };
        }
      },

      // Task intents
      createTask: {
        patterns: [
          /(?:create|add|new)\s+(?:a\s+)?task/i,
          /add\s+(?:a\s+)?(?:todo|to-do)/i,
          /remind\s+me\s+to/i
        ],
        extractParams: (text) => {
          const titleMatch = text.match(/(?:task|todo|remind\s+me\s+to)[:\s]+["']?([^"'\n]+)["']?/i);
          const priorityMatch = text.match(/priority[:\s]+(\w+)/i);
          const dueMatch = text.match(/(?:due|by|before)[:\s]+([^,\n]+)/i);
          
          const params = {
            title: titleMatch ? titleMatch[1] : text.replace(/.*?(?:task|todo|to)[:\s]+/i, ''),
            priority: priorityMatch ? priorityMatch[1] : 'medium'
          };
          
          // Only add dueDate if it exists
          if (dueMatch) {
            params.dueDate = dueMatch[1];
          }
          
          return {
            plugin: 'tasks',
            action: 'create',
            params
          };
        }
      },

      listTasks: {
        patterns: [
          /(?:list|show)\s+(?:all\s+)?tasks/i,
          /(?:what|show)\s+(?:are\s+)?my\s+tasks/i,
          /tasks\s+list/i
        ],
        extractParams: () => ({
          plugin: 'tasks',
          action: 'list',
          params: {}
        })
      },

      // API plugin management
      listPlugins: {
        patterns: [
          /(?:list|show)\s+(?:api\s+)?plugins/i,
          /what\s+plugins\s+(?:are\s+)?available/i,
          /api\s+(?:list|status)/i
        ],
        extractParams: () => ({
          plugin: '_system',
          action: 'listPlugins',
          params: {}
        })
      },

      // Email reading intents
      checkEmails: {
        patterns: [
          /(?:check|read|get|show)\s+(?:my\s+)?(?:new\s+)?emails?/i,
          /(?:do|have)\s+i\s+have\s+(?:any\s+)?(?:new\s+)?emails?/i,
          /what(?:'s| is)\s+in\s+my\s+inbox/i
        ],
        extractParams: () => ({
          plugin: 'email',
          action: 'getEmails',
          params: {
            limit: 10,
            unreadOnly: false
          }
        })
      },

      searchEmails: {
        patterns: [
          /search\s+(?:for\s+)?emails?\s+(?:from|about|with)/i,
          /find\s+emails?\s+(?:from|about|containing)/i
        ],
        extractParams: (text) => {
          const fromMatch = text.match(/from\s+["']?([^"'\s]+)["']?/i);
          const subjectMatch = text.match(/(?:about|subject)\s+["']?([^"']+)["']?/i);
          const queryMatch = text.match(/(?:containing|with)\s+["']?([^"']+)["']?/i);
          
          return {
            plugin: 'email',
            action: 'searchEmails',
            params: {
              from: fromMatch ? fromMatch[1] : null,
              subject: subjectMatch ? subjectMatch[1] : null,
              query: queryMatch ? queryMatch[1] : null
            }
          };
        }
      },

      // Network intents
      networkScan: {
        patterns: [
          /scan\s+(?:the\s+)?network/i,
          /(?:find|discover)\s+devices/i,
          /network\s+discovery/i
        ],
        extractParams: () => ({
          plugin: 'network',
          action: 'scan',
          params: {}
        })
      },

      // Web search intents
      webSearch: {
        patterns: [
          /search\s+(?:the\s+)?(?:web|internet)\s+(?:for\s+)?(.+)/i,
          /(?:google|look up)\s+(.+)/i,
          /what\s+(?:is|are)\s+(?:the\s+)?(?:latest|current|recent)\s+(?:news|information|updates?)\s+(?:about|on)\s+(.+)/i,
          /find\s+(?:information|info)\s+(?:about|on)\s+(.+)/i
        ],
        extractParams: (text) => {
          let query = '';
          
          // Try different patterns to extract the search query
          const patterns = [
            /search\s+(?:the\s+)?(?:web|internet)\s+(?:for\s+)?(.+)/i,
            /(?:google|look up)\s+(.+)/i,
            /what\s+(?:is|are)\s+(?:the\s+)?(?:latest|current|recent)\s+(?:news|information|updates?)\s+(?:about|on)\s+(.+)/i,
            /find\s+(?:information|info)\s+(?:about|on)\s+(.+)/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              query = match[match.length - 1].trim();
              break;
            }
          }
          
          return {
            plugin: 'websearch',
            action: 'search',
            params: { query }
          };
        }
      },

      stockPrice: {
        patterns: [
          /(?:what['']?s?|what\s+is)\s+(?:the\s+)?(?:current\s+)?(?:price|value)\s+of\s+(\w+)\s*(?:stock)?/i,
          /(?:how\s+much\s+is|price\s+of)\s+(\w+)\s*(?:stock)?/i,
          /(\w+)\s+stock\s+price/i,
          /stock\s+price\s+(?:of\s+)?(\w+)/i
        ],
        extractParams: (text) => {
          const symbolMatch = text.match(/(?:of\s+)?(\w+)\s*(?:stock)?/i);
          const symbol = symbolMatch ? symbolMatch[1] : '';
          
          return {
            plugin: 'websearch',
            action: 'stock',
            params: { symbol }
          };
        }
      },

      cryptoPrice: {
        patterns: [
          /(?:what['']?s?|what\s+is)\s+(?:the\s+)?(?:current\s+)?(?:price|value)\s+of\s+(\w+)\s*(?:crypto|cryptocurrency)?/i,
          /(?:how\s+much\s+is|price\s+of)\s+(\w+)\s*(?:crypto|cryptocurrency|coin)?/i,
          /(\w+)\s+(?:crypto|cryptocurrency)\s+price/i,
          /(?:bitcoin|btc|ethereum|eth|dogecoin|doge)\s+price/i,
          /(?:crypto|cryptocurrency)\s+price\s+(?:of\s+)?(\w+)/i
        ],
        extractParams: (text) => {
          // Common crypto names to symbols
          const cryptoMap = {
            'bitcoin': 'BTC',
            'ethereum': 'ETH',
            'dogecoin': 'DOGE',
            'cardano': 'ADA',
            'ripple': 'XRP',
            'solana': 'SOL',
            'polkadot': 'DOT'
          };
          
          let symbol = '';
          
          // Try to extract crypto name/symbol
          const patterns = [
            /(?:price\s+of|how\s+much\s+is)\s+(\w+)/i,
            /(\w+)\s+(?:crypto|cryptocurrency)?\s+price/i,
            /(bitcoin|btc|ethereum|eth|dogecoin|doge|cardano|ada|ripple|xrp|solana|sol|polkadot|dot)/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              const matched = match[1].toLowerCase();
              symbol = cryptoMap[matched] || matched.toUpperCase();
              break;
            }
          }
          
          return {
            plugin: 'websearch',
            action: 'crypto',
            params: { symbol }
          };
        }
      },

      cryptoTradingStatus: {
        patterns: [
          /(?:how\s+is|how['']?s?)\s+(?:my\s+)?(?:crypto|trading|the\s+trading)/i,
          /(?:crypto|trading)\s+(?:strategy|status|bot)\s*(?:status)?/i,
          /(?:what\s+is|what['']?s?)\s+(?:the\s+)?(?:trading|crypto)\s+(?:agent|bot|strategy)\s+doing/i,
          /(?:is\s+the\s+)?(?:trading|crypto)\s+(?:agent|bot)\s+running/i,
          /(?:market\s+regime|regime)\s+(?:status|info)/i,
          /dollar\s+maximizer/i
        ],
        extractParams: () => ({
          plugin: '_system',
          action: 'cryptoTradingStatus',
          params: {}
        })
      },

      cryptoPositions: {
        patterns: [
          /(?:my\s+)?(?:crypto\s+)?(?:trading\s+)?positions/i,
          /(?:what\s+(?:am\s+I|are\s+we)\s+holding|what\s+is\s+the\s+strategy\s+holding)/i,
          /(?:am\s+I\s+)?holding\s+(?:ETH|BNB|stablecoin|native)/i,
          /(?:show|list)\s+(?:my\s+)?(?:crypto\s+)?(?:trading\s+)?positions/i
        ],
        extractParams: () => ({
          plugin: '_system',
          action: 'cryptoPositions',
          params: {}
        })
      },

      cryptoTradeHistory: {
        patterns: [
          /(?:trade|trading)\s+(?:history|journal|log)/i,
          /(?:recent|last|show)\s+(?:crypto\s+)?trades/i,
          /(?:what\s+)?trades\s+(?:have\s+been|were)\s+(?:executed|made)/i
        ],
        extractParams: () => ({
          plugin: '_system',
          action: 'cryptoTradeHistory',
          params: {}
        })
      },

      swapCrypto: {
        patterns: [
          /(?:swap|exchange|trade|convert)\s+(?:\d+\.?\d*\s+)?(\w+)\s+(?:for|to|into)\s+(\w+)/i,
          /buy\s+(?:\d+\.?\d*\s+)?(?:ETH|BNB|SOL|BTC|USDT|USDC)\b/i,
          /sell\s+(?:all\s+)?(?:my\s+)?(?:\d+\.?\d*\s+)?(?:ETH|BNB|SOL|BTC)\b/i
        ],
        extractParams: (text) => ({
          plugin: '_system',
          action: 'swapCrypto',
          params: { rawInput: text }
        })
      },

      weatherInfo: {
        patterns: [
          /weather\s+(?:in|for|at)\s+(.+)/i,
          /what['']?s?\s+the\s+weather\s+(?:like\s+)?(?:in|at)\s+(.+)/i,
          /(?:how['']?s?|what['']?s?)\s+the\s+weather\s+(?:in|at)\s+(.+)/i,
          /(?:current|today['']?s?)\s+weather\s+(?:in|for|at)\s+(.+)/i
        ],
        extractParams: (text) => {
          const locationMatch = text.match(/(?:in|for|at)\s+(.+?)(?:\?|$)/i);
          const location = locationMatch ? locationMatch[1].trim() : '';
          
          return {
            plugin: 'websearch',
            action: 'weather',
            params: { location }
          };
        }
      },

      // System restart intents
      restartAgent: {
        patterns: [
          /restart\s*(?:the\s+)?(?:agent|yourself|alice|system)/i,
          /please\s+restart/i,
          /reboot\s*(?:the\s+)?(?:agent|system)/i,
          /(?:can\s+you\s+)?restart\s+yourself/i
        ],
        extractParams: () => ({
          plugin: 'system',
          action: 'restart',
          params: { delay: 5 }
        })
      },

      redeployAgent: {
        patterns: [
          /redeploy\s*(?:from\s+)?(?:git|github)/i,
          /pull\s+(?:latest\s+)?(?:changes|updates)\s+and\s+restart/i,
          /update\s+from\s+git\s+and\s+restart/i,
          /deploy\s+latest\s+(?:version|changes)/i
        ],
        extractParams: () => ({
          plugin: 'system',
          action: 'redeploy',
          params: {}
        })
      },

      // Self-awareness intents
      whatChangesToday: {
        patterns: [
          /what(?:'s|\s+is)\s+new\s+(?:with\s+)?(?:you|your\s+code|today)/i,
          /what\s+(?:new\s+)?features?\s+(?:did\s+you\s+)?(?:gain|get|have)\s+today/i,
          /what\s+(?:changes?|updates?)\s+(?:were\s+made|happened)\s+today/i,
          /(?:tell\s+me\s+)?(?:about\s+)?(?:your\s+)?(?:recent|latest|new)\s+(?:features?|changes?|updates?|improvements?)/i,
          /what\s+(?:has\s+)?changed\s+(?:with\s+you|recently)/i,
          /show\s+me\s+(?:the\s+)?changelog/i,
          /what\s+can\s+you\s+do\s+(?:now\s+)?that\s+you\s+couldn't\s+(?:do\s+)?before/i
        ],
        extractParams: () => ({
          plugin: '_system',
          action: 'getRecentChanges',
          params: { days: 1 }
        })
      },

      aboutYourself: {
        patterns: [
          /(?:tell\s+me\s+)?about\s+yourself/i,
          /what\s+are\s+you\s+capable\s+of/i,
          /what\s+can\s+you\s+do/i,
          /(?:describe|explain)\s+(?:your\s+)?(?:features?|capabilities)/i,
          /how\s+do\s+you\s+work/i,
          /what\s+(?:is|are)\s+your\s+(?:purpose|functions?|role)/i,
          /introduce\s+yourself/i
        ],
        extractParams: () => ({
          plugin: '_system',
          action: 'aboutMe',
          params: {}
        })
      },

      projectInfo: {
        patterns: [
          /(?:show\s+me\s+)?(?:the\s+)?(?:project\s+)?readme/i,
          /what\s+(?:is|does)\s+(?:the\s+)?lan\s*agent\s+(?:project|do)/i,
          /(?:tell\s+me\s+)?about\s+(?:the\s+)?(?:lan\s*agent\s+)?project/i,
          /(?:project\s+)?(?:documentation|docs|info)/i,
          /how\s+(?:was|were)\s+you\s+(?:built|made|created|developed)/i
        ],
        extractParams: () => ({
          plugin: '_system',
          action: 'getProjectInfo',
          params: {}
        })
      },

      listAllFeatures: {
        patterns: [
          /(?:list|show)\s+(?:all\s+)?(?:your\s+)?features/i,
          /what\s+(?:all\s+)?can\s+you\s+do/i,
          /(?:show|list)\s+(?:me\s+)?(?:all\s+)?(?:your\s+)?capabilities/i,
          /(?:complete|full)\s+(?:feature\s+)?list/i
        ],
        extractParams: () => ({
          plugin: '_system',  
          action: 'listAllFeatures',
          params: {}
        })
      },

      // System information intents
      systemInfo: {
        patterns: [
          /(?:how\s+much|what(?:'s|\s+is)\s+(?:the\s+|your\s+)?)\s*(?:disk|storage)\s+(?:space|usage|free|available)/i,
          /(?:show|check|get)\s+(?:me\s+)?(?:disk|storage)\s+(?:space|usage|info)/i,
          /(?:how\s+much|what(?:'s|\s+is)\s+(?:the\s+|your\s+)?)\s*(?:memory|ram)\s+(?:usage|used|free|available)/i,
          /(?:show|check|get)\s+(?:me\s+)?(?:memory|ram)\s+(?:usage|info|status)/i,
          /(?:what(?:'s|\s+is)\s+(?:the\s+|your\s+)?|how\s+is\s+(?:the\s+)?)\s*cpu\s+(?:usage|load|utilization)/i,
          /(?:show|check|get)\s+(?:me\s+)?cpu\s+(?:usage|load|info|status)/i,
          /(?:what(?:'s|\s+is)\s+(?:the\s+|your\s+)?|show\s+(?:me\s+)?)\s*system\s+(?:info|information|status|stats)/i,
          /(?:how\s+long\s+has\s+(?:the\s+)?(?:system|server)\s+been\s+(?:running|up)|what(?:'s|\s+is)\s+(?:the\s+)?uptime)/i,
          /(?:what(?:'s|\s+is)\s+(?:the\s+|your\s+)?|show\s+(?:me\s+)?)\s*(?:network|ip)\s+(?:info|information|address|configuration)/i,
          /(?:what\s+)?(?:os|operating\s+system)\s+(?:is\s+(?:this|running)|version)/i,
          /(?:df|free|disk\s+space|memory\s+info|system\s+resources)/i,
          /(?:what(?:'s|\s+is))\s+(?:my|your|the|current)\s+(?:memory|ram|disk|cpu)\s+(?:usage|status|info)/i
        ],
        extractParams: (text) => {
          let type = 'all';
          
          // Determine specific info type requested
          if (text.match(/disk|storage|df/i)) {
            type = 'disk';
          } else if (text.match(/memory|ram|free\s+-/i)) {
            type = 'memory';
          } else if (text.match(/cpu|processor|load/i)) {
            type = 'cpu';
          } else if (text.match(/network|ip|interface/i)) {
            type = 'network';
          } else if (text.match(/uptime|running/i)) {
            type = 'uptime';
          } else if (text.match(/os|operating\s+system/i)) {
            type = 'os';
          }
          
          return {
            plugin: 'system',
            action: 'info',
            params: { type }
          };
        }
      },

      runCommand: {
        patterns: [
          /(?:run|execute)\s+(?:the\s+)?command[:\s]+(.+)/i,
          /(?:run|execute)[:\s]+(.+)/i,
          /(?:can\s+you\s+)?(?:please\s+)?run[:\s]+(.+)/i,
          /^(ls|pwd|df|free|ps|top|uptime|netstat|ip|whoami|hostname|date)\b/i,
          /show\s+me\s+(?:the\s+)?(?:output\s+of\s+)?(.+)/i
        ],
        extractParams: (text) => {
          let command = '';
          
          // Extract command from various patterns
          const patterns = [
            /(?:run|execute)\s+(?:the\s+)?command[:\s]+(.+)/i,
            /(?:run|execute)[:\s]+(.+)/i,
            /run[:\s]+(.+)/i,
            /show\s+me\s+(?:the\s+)?(?:output\s+of\s+)?(.+)/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              command = match[1].trim();
              break;
            }
          }
          
          // Check if the whole text is a command
          if (!command) {
            const cmdMatch = text.match(/^(ls|pwd|df|free|ps|top|uptime|netstat|ip|whoami|hostname|date|lscpu|lsblk|systemctl\s+status|du\s+-[sh])\b(.*)$/i);
            if (cmdMatch) {
              command = cmdMatch[1] + (cmdMatch[2] || '');
            }
          }
          
          return {
            plugin: 'system',
            action: 'run',
            params: { command: command.trim() }
          };
        }
      },

      // Reminder intents
      setReminder: {
        patterns: [
          /remind\s+me\s+(?:to\s+)?(.+?)\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i,
          /set\s+(?:a\s+)?reminder\s+(?:to\s+)?(.+?)\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i,
          /(?:in\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?)\s+remind\s+me\s+(?:to\s+)?(.+)/i,
          /reminder[:\s]+(.+?)\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i
        ],
        extractParams: (text) => {
          let message = '';
          let time = 0;
          let unit = 'minutes';
          
          // Try different patterns
          const patterns = [
            /remind\s+me\s+(?:to\s+)?(.+?)\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i,
            /set\s+(?:a\s+)?reminder\s+(?:to\s+)?(.+?)\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i,
            /(?:in\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?)\s+remind\s+me\s+(?:to\s+)?(.+)/i,
            /reminder[:\s]+(.+?)\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              if (match[3] && !isNaN(match[1])) {
                // Pattern: "remind me X in Y time"
                message = match[1].trim();
                time = parseInt(match[2]);
                unit = match[3];
              } else if (!isNaN(match[1])) {
                // Pattern: "in Y time remind me X"
                time = parseInt(match[1]);
                unit = match[2];
                message = match[3].trim();
              }
              break;
            }
          }
          
          // Convert to minutes
          let minutes = time;
          if (unit.match(/hour|hr/i)) {
            minutes = time * 60;
          }
          
          return {
            plugin: 'system',
            action: 'remind',
            params: { message, minutes }
          };
        }
      },

      // Development planning intents
      addFeature: {
        patterns: [
          /(?:add|create)\s+feature[:\s]+(.+)/i,
          /feature\s+request[:\s]+(.+)/i,
          /(?:i\s+)?(?:want|need)\s+(?:a\s+)?(?:new\s+)?feature[:\s]+(.+)/i,
          /(?:can\s+you\s+)?(?:add|implement)\s+(.+)\s+(?:as\s+a\s+)?feature/i
        ],
        extractParams: (text) => {
          let description = '';
          let priority = 'medium';
          
          // Extract priority if specified
          const priorityMatch = text.match(/\[(critical|high|medium|low)\]/i);
          if (priorityMatch) {
            priority = priorityMatch[1].toLowerCase();
            text = text.replace(priorityMatch[0], '').trim();
          }
          
          // Extract feature description
          const patterns = [
            /(?:add|create)\s+feature[:\s]+(.+)/i,
            /feature\s+request[:\s]+(.+)/i,
            /(?:want|need)\s+(?:a\s+)?(?:new\s+)?feature[:\s]+(.+)/i,
            /(?:add|implement)\s+(.+?)\s*(?:as\s+a\s+feature)?$/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              description = match[1].trim();
              break;
            }
          }
          
          return {
            plugin: 'development',
            action: 'feature',
            params: {
              subAction: 'add',
              content: description,
              priority
            }
          };
        }
      },

      addTodo: {
        patterns: [
          /(?:add|create)\s+todo[:\s]+(.+)/i,
          /todo[:\s]+(.+)/i,
          /(?:add\s+)?(?:this\s+)?to\s+(?:the\s+)?todo\s+list[:\s]+(.+)/i
        ],
        extractParams: (text) => {
          let description = '';
          let priority = 'medium';
          
          // Extract priority if specified
          const priorityMatch = text.match(/\[(critical|high|medium|low)\]/i);
          if (priorityMatch) {
            priority = priorityMatch[1].toLowerCase();
            text = text.replace(priorityMatch[0], '').trim();
          }
          
          // Extract todo description
          const patterns = [
            /(?:add|create)\s+todo[:\s]+(.+)/i,
            /todo[:\s]+(.+)/i,
            /to\s+(?:the\s+)?todo\s+list[:\s]+(.+)/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              description = match[1].trim();
              break;
            }
          }
          
          return {
            plugin: 'development',
            action: 'todo',
            params: {
              subAction: 'add',
              content: description,
              priority
            }
          };
        }
      },

      planEdits: {
        patterns: [
          /plan\s+(?:to\s+)?edit[:\s]+(.+)/i,
          /(?:add|create)\s+edit\s+(?:plan|task)[:\s]+(.+)/i,
          /(?:i\s+)?(?:want|need)\s+to\s+edit[:\s]+(.+)/i
        ],
        extractParams: (text) => {
          let description = '';
          let priority = 'medium';
          
          const priorityMatch = text.match(/\[(critical|high|medium|low)\]/i);
          if (priorityMatch) {
            priority = priorityMatch[1].toLowerCase();
            text = text.replace(priorityMatch[0], '').trim();
          }
          
          const patterns = [
            /plan\s+(?:to\s+)?edit[:\s]+(.+)/i,
            /edit\s+(?:plan|task)[:\s]+(.+)/i,
            /to\s+edit[:\s]+(.+)/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              description = match[1].trim();
              break;
            }
          }
          
          return {
            plugin: 'development',
            action: 'edits',
            params: {
              subAction: 'add',
              content: description,
              priority
            }
          };
        }
      },

      // Software installation intents
      installSoftware: {
        patterns: [
          /(?:install|download\s+and\s+install|get)\s+(.+?)(?:\s+(?:package|software|tool|app|application))?$/i,
          /(?:can\s+you\s+)?(?:please\s+)?install\s+(.+)/i,
          /(?:i\s+)?(?:want|need)\s+(?:to\s+)?(?:install|get)\s+(.+)/i,
          /set\s*up\s+(.+?)(?:\s+(?:on|for)\s+(?:me|this\s+system))?$/i,
          /add\s+(.+?)\s+to\s+(?:the\s+)?system/i
        ],
        extractParams: (text) => {
          let packageName = '';
          let method = null;
          
          // Check for specific method mentions
          if (text.match(/from\s+(?:source|git|github)/i)) {
            method = 'compile';
          } else if (text.match(/via\s+apt/i)) {
            method = 'apt';
          } else if (text.match(/via\s+snap/i)) {
            method = 'snap';
          } else if (text.match(/via\s+npm/i)) {
            method = 'npm';
          }
          
          // Extract package name
          const patterns = [
            /install\s+(.+?)(?:\s+from|\s+via|\s+using|$)/i,
            /download\s+and\s+install\s+(.+?)(?:\s+from|$)/i,
            /get\s+(.+?)(?:\s+from|\s+via|$)/i,
            /set\s*up\s+(.+?)(?:\s+on|$)/i,
            /add\s+(.+?)\s+to/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              packageName = match[1].trim()
                .replace(/^(the|a|an)\s+/i, '')
                .replace(/\s+(package|software|tool|app|application)$/i, '');
              break;
            }
          }
          
          return {
            plugin: 'software',
            action: 'install',
            params: { package: packageName, method }
          };
        }
      },

      compileSoftware: {
        patterns: [
          /(?:compile|build)\s+(.+?)\s+from\s+(?:source|git|github)/i,
          /(?:download|get|grab)\s+(.+?)\s+(?:from\s+)?(?:its\s+)?git\s+and\s+compile/i,
          /(?:build|compile)\s+(.+?)\s+from\s+scratch/i,
          /compile\s+(.+?)(?:\s+from\s+source)?$/i
        ],
        extractParams: (text) => {
          let packageNameOrUrl = '';
          
          const patterns = [
            /(?:compile|build)\s+(.+?)\s+from/i,
            /(?:download|get|grab)\s+(.+?)\s+(?:from\s+)?(?:its\s+)?git/i,
            /compile\s+(.+?)(?:\s+from|$)/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              packageNameOrUrl = match[1].trim();
              break;
            }
          }
          
          // Check if it's a URL
          if (!packageNameOrUrl.match(/^https?:\/\//)) {
            // Not a URL, treat as package name
            packageNameOrUrl = packageNameOrUrl
              .replace(/^(the|a|an)\s+/i, '')
              .replace(/\s+(package|software|tool|app|application)$/i, '');
          }
          
          return {
            plugin: 'software',
            action: 'compile',
            params: { url: packageNameOrUrl }
          };
        }
      },

      uninstallSoftware: {
        patterns: [
          /(?:uninstall|remove|delete)\s+(.+?)(?:\s+(?:package|software|tool|app|application))?$/i,
          /(?:can\s+you\s+)?(?:please\s+)?uninstall\s+(.+)/i,
          /get\s+rid\s+of\s+(.+)/i,
          /(?:i\s+)?(?:want|need)\s+to\s+(?:uninstall|remove)\s+(.+)/i
        ],
        extractParams: (text) => {
          let packageName = '';
          
          const patterns = [
            /(?:uninstall|remove|delete)\s+(.+?)(?:\s+from|$)/i,
            /get\s+rid\s+of\s+(.+?)$/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              packageName = match[1].trim()
                .replace(/^(the|a|an)\s+/i, '')
                .replace(/\s+(package|software|tool|app|application)$/i, '');
              break;
            }
          }
          
          return {
            plugin: 'software',
            action: 'uninstall',
            params: { package: packageName }
          };
        }
      },

      updateSoftware: {
        patterns: [
          /update\s+(.+?)(?:\s+(?:package|software|tool|app|application))?$/i,
          /upgrade\s+(.+?)$/i,
          /update\s+(?:the\s+)?system(?:\s+packages)?/i,
          /(?:run|do)\s+(?:a\s+)?system\s+update/i,
          /apt\s+update\s+&&\s+apt\s+upgrade/i
        ],
        extractParams: (text) => {
          let packageName = null;
          
          // Check if it's a system update
          if (text.match(/(?:system|all)\s+(?:packages|update)/i) || 
              text.match(/apt\s+update/i)) {
            packageName = 'system';
          } else {
            // Extract specific package name
            const patterns = [
              /update\s+(.+?)(?:\s+package|$)/i,
              /upgrade\s+(.+?)$/i
            ];
            
            for (const pattern of patterns) {
              const match = text.match(pattern);
              if (match) {
                packageName = match[1].trim()
                  .replace(/^(the|a|an)\s+/i, '')
                  .replace(/\s+(package|software|tool|app|application)$/i, '');
                break;
              }
            }
          }
          
          return {
            plugin: 'software',
            action: 'update',
            params: { package: packageName }
          };
        }
      },

      checkSoftware: {
        patterns: [
          /(?:is|check\s+if)\s+(.+?)\s+(?:is\s+)?installed/i,
          /(?:do\s+(?:i|we)\s+have|check\s+for)\s+(.+)/i,
          /verify\s+(.+?)\s+(?:is\s+)?(?:installed|available)/i,
          /(?:which|what)\s+version\s+of\s+(.+)/i
        ],
        extractParams: (text) => {
          let packageName = '';
          
          const patterns = [
            /(?:is|check\s+if)\s+(.+?)\s+(?:is\s+)?installed/i,
            /(?:have|check\s+for)\s+(.+?)(?:\s+installed)?$/i,
            /verify\s+(.+?)\s+(?:is|$)/i,
            /version\s+of\s+(.+?)$/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              packageName = match[1].trim()
                .replace(/^(the|a|an)\s+/i, '')
                .replace(/\s+(package|software|tool|app|application)$/i, '');
              break;
            }
          }
          
          return {
            plugin: 'software',
            action: 'check',
            params: { package: packageName }
          };
        }
      },

      searchSoftware: {
        patterns: [
          /search\s+(?:for\s+)?(?:packages?|software|tools?)\s+(?:for|about|related\s+to)\s+(.+)/i,
          /(?:find|look\s+for)\s+(.+?)\s+(?:packages?|software|tools?)/i,
          /what\s+(.+?)\s+(?:packages?|software|tools?)\s+are\s+available/i,
          /apt\s+search\s+(.+)/i,
          /snap\s+find\s+(.+)/i
        ],
        extractParams: (text) => {
          let query = '';
          
          const patterns = [
            /search\s+(?:for\s+)?(?:packages?|software|tools?)\s+(?:for|about|related\s+to)\s+(.+)/i,
            /(?:find|look\s+for)\s+(.+?)\s+(?:packages?|software|tools?)/i,
            /what\s+(.+?)\s+(?:packages?|software|tools?)/i,
            /(?:apt\s+search|snap\s+find)\s+(.+)/i
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
              query = match[1].trim();
              break;
            }
          }
          
          return {
            plugin: 'software',
            action: 'search',
            params: { query }
          };
        }
      },

      listSoftware: {
        patterns: [
          /list\s+(?:all\s+)?(?:installed\s+)?(?:packages?|software|tools?|applications?)/i,
          /(?:show|what)\s+(?:packages?|software|tools?)\s+(?:are\s+)?installed/i,
          /what(?:'s|\s+is)\s+installed(?:\s+on\s+(?:this\s+)?(?:system|machine))?/i,
          /(?:dpkg|apt|snap|npm|pip)\s+list/i
        ],
        extractParams: (text) => {
          let filter = null;
          
          // Check for specific package manager filters
          if (text.match(/apt\s+list/i) || text.match(/dpkg/i)) {
            filter = 'apt';
          } else if (text.match(/snap\s+list/i)) {
            filter = 'snap';
          } else if (text.match(/npm\s+list/i)) {
            filter = 'npm';
          } else if (text.match(/pip\s+list/i)) {
            filter = 'pip';
          }
          
          return {
            plugin: 'software',
            action: 'list',
            params: { query: filter }
          };
        }
      }
    };
  }

  async detect(text) {
    logger.info('Intent detection for:', text);
    
    // Check each intent pattern
    for (const [intentName, intent] of Object.entries(this.intents)) {
      for (const pattern of intent.patterns) {
        if (pattern.test(text)) {
          logger.info(`Detected intent: ${intentName}`);
          const result = intent.extractParams(text);
          
          // Validate extracted params
          if (result.plugin && result.action) {
            return {
              detected: true,
              intent: intentName,
              ...result
            };
          }
        }
      }
    }
    
    // No intent detected
    return {
      detected: false,
      original: text
    };
  }

  // Add new intent patterns dynamically
  addIntent(name, patterns, extractParams) {
    this.intents[name] = { patterns, extractParams };
  }
}

export default IntentDetector;