import { logger } from "../utils/logger.js";

export class CommandParser {
  constructor() {
    this.patterns = this.initializePatterns();
    this.commandHistory = [];
    this.confidenceThreshold = 0.7; // Commands below this confidence require approval
  }

  initializePatterns() {
    return {
      // System commands
      system: {
        update: /\b(update|upgrade|patch)\s+(system|packages?|everything)\b/i,
        reboot: /\b(reboot|restart)\s+(system|server|machine)\b/i,
        shutdown: /\b(shutdown|power off|turn off)\s+(system|server|machine)\b/i,
        status: /\b(show|check|get)\s+(system|server)?\s*status\b/i,
        install: /\b(install|add|setup)\s+(.+)/i,
        uninstall: /\b(uninstall|remove|delete)\s+(.+)/i
      },
      
      // File operations
      file: {
        list: /\b(list|show|ls)\s+(files?|folders?|directories?)\s*(?:in|at)?\s*(.+)?/i,
        create: /\b(create|make|touch)\s+(file|folder|directory)\s+(.+)/i,
        delete: /\b(delete|remove|rm)\s+(file|folder|directory)\s+(.+)/i,
        move: /\b(move|mv|rename)\s+(.+)\s+to\s+(.+)/i,
        copy: /\b(copy|cp|duplicate)\s+(.+)\s+to\s+(.+)/i,
        search: /\b(find|search|locate)\s+(.+)/i
      },
      
      // Network operations
      network: {
        scan: /\b(scan|discover)\s+(network|devices?|hosts?)\b/i,
        ping: /\b(ping|check)\s+(?:connectivity|connection)?\s*(?:to)?\s*(.+)/i,
        ports: /\b(check|scan|list)\s+ports?\s*(?:on)?\s*(.+)?/i,
        connections: /\b(show|list|check)\s+(connections?|network\s+status)\b/i,
        speedTest: /\b(speed|bandwidth)\s*test\b/i,
        traceroute: /\b(trace|traceroute)\s+(?:to\s+)?(.+)/i,
        interfaces: /\b(show|list)\s+(?:network\s+)?interfaces?\b/i,
        dnsLookup: /\b(dns|lookup|resolve)\s+(.+)/i,
        whois: /\b(whois)\s+(.+)/i
      },
      
      // Development
      development: {
        git: /\bgit\s+(.+)/i,
        code: /\b(create|generate|write)\s+(?:a\s+)?(.+?)\s+(?:in|using|with)\s+(.+)/i,
        test: /\b(test|run tests?)\s+(?:for)?\s*(.+)?/i,
        build: /\b(build|compile)\s+(.+)/i
      },
      
      // Git operations
      git: {
        status: /\b(show|check|get)\s+git\s+status\b/i,
        add: /\b(stage|add)\s+(?:all\s+)?(?:changes|files?)?\s*(.+)?(?:\s+to\s+git)?\b/i,
        commit: /\b(commit|save)\s+(?:changes\s+)?(?:with\s+message\s+)?['""]?(.+?)['""]?\s*$/i,
        push: /\b(push|upload)\s+(?:changes\s+)?(?:to\s+)?(?:remote|origin|github)?\b/i,
        pull: /\b(pull|fetch|get)\s+(?:latest\s+)?(?:changes|updates)\s+(?:from\s+)?(?:remote|origin|github)?\b/i,
        branch: /\b(create|switch|checkout|delete)\s+(?:to\s+)?(?:git\s+)?branch\s+(.+)/i,
        log: /\b(show|view|get)\s+(?:git\s+)?(?:commit\s+)?(?:history|log)\b/i,
        init: /\b(init|initialize|create)\s+(?:new\s+)?git\s+(?:repo|repository)\b/i,
        clone: /\b(clone|copy|download)\s+(?:git\s+)?(?:repo|repository)\s+(.+)/i
      },
      
      // Docker/Container
      container: {
        list: /\b(list|show)\s+(containers?|docker)\b/i,
        start: /\b(start|run)\s+container\s+(.+)/i,
        stop: /\b(stop|halt)\s+container\s+(.+)/i,
        create: /\b(create|build)\s+container\s+(?:for)?\s*(.+)/i
      },
      
      // Task management
      task: {
        create: /\b(add|create|schedule)\s+(?:a\s+)?task\s+(?:to)?\s*(.+)/i,
        list: /\b(list|show|view)\s+(?:all\s+)?tasks?\b/i,
        complete: /\b(complete|finish|done)\s+task\s+(.+)/i,
        delete: /\b(delete|remove|cancel)\s+task\s+(.+)/i,
        get: /\b(get|show|view)\s+task\s+(.+)/i,
        update: /\b(update|edit|modify)\s+task\s+(.+)/i,
        search: /\b(search|find)\s+tasks?\s+(?:for)?\s*(.+)/i
      },
      
      // API commands
      api: {
        list: /\b(list|show)\s+(?:available\s+)?(?:api\s+)?plugins?\b/i,
        execute: /\b(api|plugin)\s+(\w+)\s+(?:execute\s+)?(\w+)?\s*(.*)?/i,
        info: /\b(info|describe)\s+(?:api\s+)?plugin\s+(\w+)/i,
        enable: /\b(enable|activate)\s+(?:api\s+)?(?:plugin\s+)?(\w+)(?:\s+plugin)?\b/i,
        disable: /\b(disable|deactivate)\s+(?:api\s+)?(?:plugin\s+)?(\w+)(?:\s+plugin)?\b/i,
        turnOnPlugin: /\b(turn on)\s+(?:the\s+)?(?:api\s+)?(?:plugin\s+)?(\w+)(?:\s+plugin)?\b/i,
        turnOffPlugin: /\b(turn off)\s+(?:the\s+)?(?:api\s+)?(?:plugin\s+)?(\w+)(?:\s+plugin)?\b/i,
        status: /\b(status|check)\s+(?:api\s+)?(?:plugin\s+)?(\w+)(?:\s+plugin)?\b/i
      },
      
      // Microcontroller commands
      microcontroller: {
        listDevices: /\b(list|show|find)\s+(?:connected\s+)?(?:arduino|esp32|esp8266|microcontroller)s?\b/i,
        connect: /\b(connect)\s+(?:to\s+)?(?:arduino|esp32|microcontroller)?\s*(?:on\s+)?(?:port\s+)?(\/dev\/[\w\/]+|COM\d+)\b/i,
        upload: /\b(upload|flash)\s+(?:code|sketch|program)\s+(?:to\s+)?(?:arduino|esp32|microcontroller)?\b/i,
        monitor: /\b(monitor|watch|read)\s+(?:serial\s+)?(?:from\s+)?(?:arduino|esp32|microcontroller)?\b/i,
        uploadTemplate: /\b(upload|flash)\s+(blink|servo|mqtt|webserver|wifi|temperature|ultrasonic|neopixel)\s*(?:template|sketch|example)?\b/i
      },
      
      // General queries
      query: {
        explain: /\b(explain|what is|tell me about)\s+(.+)/i,
        help: /\b(help|how do i|how to)\s+(.+)/i,
        memory: /\b(remember|recall|what did)\s+(.+)/i
      }
    };
  }

  parse(input, context = {}) {
    // Guard against undefined or non-string input
    if (input === undefined || input === null) {
      logger.warn('CommandParser.parse called with undefined/null input');
      return {
        originalInput: '',
        type: 'natural',
        action: 'process',
        parameters: { query: '' },
        confidence: 0,
        requiresApproval: false,
        suggestedResponse: null
      };
    }

    // Ensure input is a string
    const inputStr = typeof input === 'string' ? input : String(input);
    const normalizedInput = inputStr.trim().toLowerCase();
    const result = {
      originalInput: inputStr,
      type: null,
      action: null,
      parameters: {},
      confidence: 0,
      requiresApproval: false,
      suggestedResponse: null
    };

    // Check each pattern category
    for (const [category, patterns] of Object.entries(this.patterns)) {
      for (const [action, regex] of Object.entries(patterns)) {
        const match = normalizedInput.match(regex);
        if (match) {
          result.type = category;
          result.action = action;
          result.parameters = this.extractParameters(match, action);
          result.confidence = this.calculateConfidence(match, input);
          result.requiresApproval = this.requiresApproval(category, action);

          // Require approval for low-confidence commands to reduce false positives
          if (result.confidence < this.confidenceThreshold) {
            result.requiresApproval = true;
            logger.info(`Command requires approval (low confidence ${result.confidence.toFixed(2)}): ${category}.${action}`, result.parameters);
          } else {
            logger.info(`Parsed command: ${category}.${action}`, result.parameters);
          }

          return result;
        }
      }
    }

    // If no pattern matches, it might be a natural language request
    result.type = "natural";
    result.action = "process";
    result.parameters = { query: input };
    result.confidence = 0.5;
    
    return result;
  }

  extractParameters(match, action) {
    const params = {};
    
    // Remove the full match from the array
    const groups = match.slice(1);
    
    // Map groups to parameter names based on action
    switch (action) {
      case "install":
      case "uninstall":
        params.package = groups[1]?.trim();
        break;
        
      case "move":
      case "copy":
        params.source = groups[1]?.trim();
        params.destination = groups[2]?.trim();
        break;
        
      case "create":
        params.type = groups[0]?.trim();
        params.path = groups[1]?.trim();
        break;
        
      case "ping":
        params.host = groups[0]?.trim();
        break;
        
      case "git":
        params.command = groups[0]?.trim();
        break;
        
      case "code":
        params.type = groups[1]?.trim();
        params.language = groups[2]?.trim();
        break;
        
      case "create": // task create
        if (groups[0]) {
          params.title = groups[0].trim();
        }
        break;
        
      case "execute": // api execute
        params.plugin = groups[1]?.trim();
        params.action = groups[2]?.trim() || 'execute';
        if (groups[3]) {
          // Try to parse additional parameters
          try {
            params = { ...params, ...JSON.parse(groups[3]) };
          } catch {
            params.data = groups[3].trim();
          }
        }
        break;
        
      default:
        // Generic parameter extraction
        groups.forEach((group, index) => {
          if (group) {
            params[`param${index}`] = group.trim();
          }
        });
    }
    
    return params;
  }

  calculateConfidence(match, originalInput) {
    // Calculate confidence based on match quality
    const matchLength = match[0].length;
    const inputLength = originalInput.trim().length;
    
    // Higher confidence for more complete matches
    const coverage = matchLength / inputLength;
    
    // Adjust for match position (earlier is better)
    const position = originalInput.indexOf(match[0]) / inputLength;
    
    return Math.min(0.95, coverage * (1 - position * 0.2));
  }

  requiresApproval(category, action) {
    // Define which actions require user approval
    // These are DANGEROUS operations that can damage the system
    const dangerousActions = {
      system: ["reboot", "shutdown", "update", "restart"],
      software: ["install", "uninstall", "update", "compile", "upgrade"],
      file: ["delete", "remove", "rm"],
      container: ["stop", "delete", "remove", "prune"],
      network: ["firewall", "iptables", "ufw"],
      service: ["stop", "restart", "disable"]
    };

    return dangerousActions[category]?.includes(action) || false;
  }

  suggestCommand(input) {
    // Suggest corrections or completions
    const suggestions = [];
    
    // Simple fuzzy matching against known commands
    // This could be enhanced with a proper fuzzy string matching library
    
    return suggestions;
  }

  addToHistory(parsedCommand, result) {
    this.commandHistory.push({
      timestamp: new Date(),
      command: parsedCommand,
      result: result,
      success: result.success || false
    });
    
    // Keep only last 1000 commands
    if (this.commandHistory.length > 1000) {
      this.commandHistory.shift();
    }
  }

  getHistory(limit = 10) {
    return this.commandHistory.slice(-limit);
  }
}