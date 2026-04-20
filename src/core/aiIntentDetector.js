import { logger } from '../utils/logger.js';
import { StructuredOutputParser, JSONOutputParser } from '../services/outputParser.js';
import { schemas } from '../services/outputSchemas.js';

export class AIIntentDetector {
  constructor(agent) {
    this.agent = agent;
    this.intents = this.defineBaseIntents();

    // Initialize structured output parsers for validated responses
    this.parsers = {
      intent: new StructuredOutputParser(schemas.intent),
      reminder: new StructuredOutputParser(schemas.reminder),
      email: new StructuredOutputParser(schemas.email),
      search: new StructuredOutputParser(schemas.search),
      task: new StructuredOutputParser(schemas.task),
      json: new JSONOutputParser()
    };
  }

  /**
   * Parse LLM response with schema validation
   * Falls back to raw JSON parsing if schema validation fails
   */
  parseStructuredResponse(text, schemaName = 'json') {
    const parser = this.parsers[schemaName] || this.parsers.json;
    try {
      return parser.parse(text);
    } catch (error) {
      logger.debug(`Structured parsing failed for ${schemaName}: ${error.message}`);
      // Fallback to basic JSON parsing
      return this.parsers.json.safeParse(text, null);
    }
  }

  defineBaseIntents() {
    return {
      
      // General conversation (fallback)
      0: {
        name: 'general',
        description: 'General conversation or questions not matching specific intents',
        plugin: null,
        action: null,
        examples: ['hello', 'how are you?', 'tell me about yourself']
      },
      
      // Context-dependent query (requires conversation history)
      999: {
        name: 'contextQuery',
        description: 'Questions that refer to previous messages or require conversation context',
        plugin: '_system',
        action: 'query',
        examples: ['what do you think about that?', 'what about it?', 'explain that', 'tell me more', 'why?', 'how so?', 'what does that mean?']
      },
      
      // System information
      1: {
        name: 'systemInfo',
        description: 'Get system information (disk space, memory usage, CPU, network)',
        plugin: 'system',
        action: 'info',
        examples: ['how much disk space?', 'memory usage', 'CPU load', 'system stats']
      },
      
      // System commands
      2: {
        name: 'runCommand',
        description: 'Execute safe system commands',
        plugin: 'system',
        action: 'run',
        examples: ['run df -h', 'execute ps aux', 'show me top output']
      },
      
      // Reminders
      3: {
        name: 'setReminder',
        description: 'Set reminders with time delays',
        plugin: 'system',
        action: 'remind',
        examples: ['remind me to X in 30 minutes', 'set reminder for Y in 2 hours']
      },
      
      // Software management
      4: {
        name: 'installSoftware',
        description: 'Install packages or software',
        plugin: 'software',
        action: 'install',
        examples: ['install ffmpeg', 'download docker', 'get nodejs']
      },
      
      5: {
        name: 'uninstallSoftware',
        description: 'Uninstall or remove software',
        plugin: 'software',
        action: 'uninstall',
        examples: ['uninstall apache', 'remove docker', 'delete package']
      },
      
      6: {
        name: 'compileSoftware',
        description: 'Compile software from source code',
        plugin: 'software',
        action: 'compile',
        examples: ['compile neovim from source', 'build ffmpeg from git']
      },
      
      7: {
        name: 'checkSoftware',
        description: 'Check if software is installed',
        plugin: 'software',
        action: 'check',
        examples: ['is docker installed?', 'check if python exists', 'verify nginx']
      },
      
      8: {
        name: 'searchSoftware',
        description: 'Search for available packages',
        plugin: 'software',
        action: 'search',
        examples: ['search for video tools', 'find database packages']
      },
      
      // Web search
      9: {
        name: 'webSearch',
        description: 'Search the web for information - use for any question about current, recent, or real-time information',
        plugin: 'websearch',
        action: 'search',
        examples: ['what is bitcoin price', 'search for news', 'look up weather', 'what are the most popular npm packages', 'latest trends in', 'current ranking of', 'what happened recently with', 'who won the', 'find information about']
      },
      
      10: {
        name: 'stockPrice',
        description: 'Get stock prices',
        plugin: 'websearch',
        action: 'stock',
        examples: ['AAPL stock price', 'Tesla stock', 'MSFT price']
      },
      
      11: {
        name: 'cryptoPrice',
        description: 'Get cryptocurrency prices',
        plugin: 'websearch',
        action: 'crypto',
        examples: ['bitcoin price', 'ethereum value', 'BTC price']
      },
      
      12: {
        name: 'weatherInfo',
        description: 'Get weather information',
        plugin: 'websearch',
        action: 'weather',
        examples: ['weather in New York', 'temperature today']
      },
      
      // Task management
      13: {
        name: 'createTask',
        description: 'Create new tasks or todos',
        plugin: 'tasks',
        action: 'create',
        examples: ['add task to backup server', 'create todo for meeting']
      },
      
      14: {
        name: 'listTasks',
        description: 'Show all tasks',
        plugin: 'tasks',
        action: 'list',
        examples: ['show my tasks', 'list todos', 'what tasks do I have']
      },
      
      // Email
      15: {
        name: 'sendEmail',
        description: 'Send emails, optionally with file attachments or README',
        plugin: 'email',
        action: 'send',
        examples: ['send email to john@example.com', 'email the team about X', 'send an introduction email and include your readme', 'email wayne with the report attached']
      },
      
      16: {
        name: 'checkEmails',
        description: 'Check for new emails',
        plugin: 'email',
        action: 'getEmails',
        examples: ['check my emails', 'any new messages?', 'read inbox']
      },
      
      17: {
        name: 'scheduleEmail',
        description: 'Schedule an email for future delivery',
        plugin: 'email',
        action: 'schedule',
        examples: ['send email to John tomorrow at 9am', 'schedule email for Friday at 5pm', 'email reminder next Monday morning']
      },
      
      18: {
        name: 'scheduleRecurringEmail',
        description: 'Schedule a recurring email',
        plugin: 'email',
        action: 'scheduleRecurring',
        examples: ['send daily email to John at 9am', 'schedule weekly report every Monday', 'email reminder every month on the 15th']
      },
      
      // Git operations
      19: {
        name: 'gitStatus',
        description: 'Check git repository status',
        plugin: 'git',
        action: 'status',
        examples: ['git status', 'check repo status', 'what changed?']
      },
      
      20: {
        name: 'gitCommit',
        description: 'Commit changes to git',
        plugin: 'git',
        action: 'commit',
        examples: ['commit changes', 'git commit with message X']
      },
      
      21: {
        name: 'createGitHubIssue',
        description: 'Create GitHub issue or bug report',
        plugin: 'git',
        action: 'createIssue',
        examples: [
          'create an issue for bug X',
          'add a bug report for Y',
          'file an issue about Z',
          'report a bug in LANAgent',
          'create issue for project X about Y',
          'add bug for this project',
          'file a github issue',
          'create a bug report for that error',
          'file an issue for the error I just got',
          'report that error as a bug'
        ]
      },
      
      22: {
        name: 'listGitHubIssues',
        description: 'List GitHub issues',
        plugin: 'git',
        action: 'listIssues',
        examples: [
          'show github issues',
          'list open bugs',
          'what issues are open?',
          'show me the bug list'
        ]
      },
      
      // System control (master only)
      23: {
        name: 'restartAgent',
        description: 'Restart the agent (master only)',
        plugin: 'system',
        action: 'restart',
        examples: ['restart agent', 'reboot yourself', 'restart ALICE']
      },
      
      24: {
        name: 'redeployAgent',
        description: 'Pull updates and redeploy (master only)',
        plugin: 'system',
        action: 'redeploy',
        examples: ['redeploy from git', 'pull updates', 'update and restart']
      },
      
      // Development
      25: {
        name: 'addFeature',
        description: 'Add feature to development plan',
        plugin: 'development',
        action: 'feature',
        examples: ['add feature: voice support', 'new feature idea: X']
      },
      
      26: {
        name: 'addTodo',
        description: 'Add todo item to task list',
        plugin: 'tasks',
        action: 'create',
        examples: ['todo: fix bug in X', 'add to todo list: test Y']
      },
      
      // Web scraping
      27: {
        name: 'scrapeWebpage',
        description: 'Scrape and extract content from a webpage',
        plugin: 'scraper',
        action: 'scrape',
        examples: ['analyze https://example.com', 'what is on this page <url>', 'scrape this link']
      },
      
      28: {
        name: 'takeScreenshot',
        description: 'Take a screenshot of a webpage',
        plugin: 'scraper',
        action: 'screenshot',
        examples: ['screenshot https://example.com', 'capture this page']
      },
      
      29: {
        name: 'generatePDF',
        description: 'Generate a PDF from a webpage',
        plugin: 'scraper',
        action: 'pdf',
        examples: ['generate pdf of https://example.com', 'create pdf from website', 'pdf this page', 'scrape and send pdf']
      },
      
      // Code self-examination
      30: {
        name: 'examineOwnCode',
        description: 'Examine and explain own codebase',
        plugin: '_system',
        action: 'examineCode',
        examples: ['how does your memory system work', 'explain your plugin architecture', 'how do you handle tasks', 'show me your code for X']
      },
      
      31: {
        name: 'suggestImprovements',
        description: 'Suggest improvements to own code',
        plugin: '_system',
        action: 'suggestImprovements',
        examples: ['what improvements would you make to your code', 'how would you improve your memory system', 'suggest enhancements for X feature']
      },
      
      32: {
        name: 'listPlannedImprovements',
        description: 'List planned improvements and upgrades',
        plugin: '_system',
        action: 'listPlannedImprovements',
        examples: ['what improvements do you have planned', 'show planned upgrades', 'what features are you working on']
      },
      
      33: {
        name: 'showChangelog',
        description: 'Show recent changes from changelog',
        plugin: '_system',
        action: 'getRecentChanges',
        examples: [
          'show me the changelog',
          'what\'s new in the changelog',
          'anything new in the changelog',
          'what changes were made recently',
          'show recent updates',
          'what\'s been updated lately',
          'list recent changes',
          'what\'s new with you',
          'what\'s new'
        ]
      },
      
      34: {
        name: 'implementFeature',
        description: 'Build, implement, or code a new feature or capability in the system',
        plugin: '_system',
        action: 'considerFeature',
        examples: [
          'could you build a new notification system',
          'implement ability to export data',
          'add support for webhooks',
          'create a new plugin for weather alerts',
          'implement a rate limiter for the API',
          'build a caching layer for responses',
          'code a feature that tracks user sessions',
          'develop a dashboard widget'
        ]
      },
      
      // Contact management
      35: {
        name: 'addContact',
        description: 'Add or manage email contacts',
        plugin: 'email',
        action: 'addContact',
        examples: ['add contact john@example.com', 'save John Smith with email john@example.com', 'add email contact Sarah', 'remember email for Bob']
      },
      
      36: {
        name: 'listContacts',
        description: 'List saved email contacts',
        plugin: 'email',
        action: 'listContacts',
        examples: ['show my contacts', 'list email contacts', 'who are my contacts']
      },
      
      37: {
        name: 'deleteContact',
        description: 'Delete an email contact',
        plugin: 'email',
        action: 'deleteContact',
        examples: ['delete contact john@example.com', 'remove John from contacts', 'delete email contact Sarah']
      },
      
      38: {
        name: 'getContact',
        description: 'Get details of a specific contact by email address',
        plugin: 'email',
        action: 'getContact',
        examples: ['show contact john@example.com', 'get contact details for john@work.com', 'contact info for user@domain.com']
      },
      
      39: {
        name: 'updateContact',
        description: 'Update, modify, or change existing contact information (phone, alias, email, telegram, name)',
        plugin: 'email',
        action: 'updateContact',
        examples: [
          'update contact john@example.com',
          'add alias CommanderFog to Wayne',
          'update Sarah phone number',
          'add telegram to Bob',
          'change the phone number for Mike in contacts',
          'modify contact details for Jane',
          'update the email address for Tom in my contacts',
          'edit Bob contact info',
          'change contact name for user@example.com'
        ]
      },
      
      40: {
        name: 'findContact',
        description: 'Find contact by name, email or alias',
        plugin: 'email',
        action: 'findContact',
        examples: ['find contact CommanderFog', 'search for Wayne', 'find contact by alias Bobby', 'show me contact info for Kris', 'get John contact details', 'contact info for Sarah', 'who is Wayne']
      },
      
      41: {
        name: 'blockEmailContact',
        description: 'Block an email contact to prevent sending emails to them',
        plugin: 'email',
        action: 'blockContact',
        examples: [
          'block contact john@spam.com',
          'block emails to spammer@example.com',
          'add john@example.com to email blocklist',
          'prevent sending emails to that address',
          'add this email to the blocked list',
          'blacklist this email address',
          'stop emails to that person',
          'ban this contact from email'
        ]
      },
      
      42: {
        name: 'unblockEmailContact',
        description: 'Unblock a previously blocked email contact to allow sending emails again',
        plugin: 'email',
        action: 'unblockContact',
        examples: [
          'unblock contact john@example.com',
          'remove john@example.com from blocklist',
          'allow emails to john@example.com',
          'remove the block on that email address',
          'take this email off the blocklist',
          'unban this contact from email',
          're-enable emails to that person'
        ]
      },
      
      43: {
        name: 'listBlockedContacts',
        description: 'Show all blocked email contacts',
        plugin: 'email',
        action: 'listBlockedContacts',
        examples: ['show blocked contacts', 'list email blocklist', 'who is blocked from emails']
      },
      
      // Memory operations
      44: {
        name: 'rememberThis',
        description: 'Store important information to memory',
        plugin: '_system',
        action: 'remember',
        examples: [
          'remember this', 
          'save this information', 
          'store this for later', 
          'remember that the server password is xyz',
          'make a note of this',
          'keep this in mind',
          'don\'t forget this'
        ]
      },
      
      45: {
        name: 'recallInformation',
        description: 'Recall stored information from memory',
        plugin: '_system',
        action: 'recall',
        examples: [
          'what do you remember about',
          'recall information about',
          'what did I tell you about',
          'do you remember',
          'what was that thing about'
        ]
      },
      
      // Calendar management
      46: {
        name: 'createCalendarEvent',
        description: 'Create a new calendar event',
        plugin: 'calendar',
        action: 'createEvent',
        examples: ['add meeting to calendar tomorrow at 3pm', 'schedule appointment next week', 'create event birthday party on Saturday']
      },
      
      47: {
        name: 'listCalendarEvents',
        description: 'List upcoming calendar events',
        plugin: 'calendar',
        action: 'getEvents',
        examples: ['show my calendar', 'what events do I have today', 'list upcoming meetings', 'whats on my schedule']
      },
      
      48: {
        name: 'getTodayEvents',
        description: 'Get today\'s calendar events',
        plugin: 'calendar',
        action: 'getToday',
        examples: ['what do I have today', 'today\'s schedule', 'show today\'s events']
      },
      
      49: {
        name: 'deleteCalendarEvent',
        description: 'Delete a calendar event',
        plugin: 'calendar',
        action: 'deleteEvent',
        examples: ['delete meeting tomorrow', 'remove event from calendar', 'cancel appointment']
      },
      
      50: {
        name: 'checkCalendarAvailability',
        description: 'Check calendar availability for a specific time slot',
        plugin: 'calendar',
        action: 'checkAvailability',
        examples: ['am I free tomorrow at 2pm', 'check availability next Monday', 'when am I available today']
      },

      51: {
        name: 'searchCalendarEvents',
        description: 'Search calendar events by keyword or topic',
        plugin: 'calendar',
        action: 'searchEvents',
        examples: ['check my Olympics trip on the calendar', 'find my dentist appointment', 'search for meeting with John', 'look up vacation on calendar', 'find birthday events']
      },

      52: {
        name: 'getUpcomingCalendarEvents',
        description: 'Get upcoming calendar events for the next few days',
        plugin: 'calendar',
        action: 'getUpcoming',
        examples: ['what\'s coming up on my calendar', 'upcoming events this week', 'what do I have next 3 days', 'show me my schedule for the week']
      },

      // Device management
      53: {
        name: 'listConnectedDevices',
        description: 'List all devices connected to the system (USB, network, serial, etc.)',
        plugin: 'deviceInfo',
        action: 'list',
        examples: [
          'which devices are connected',
          'what devices are connected to you',
          'list connected devices',
          'show me all devices',
          'scan for devices',
          'detect devices',
          'find connected hardware',
          'what\'s plugged in',
          'show USB devices',
          'list network devices',
          'check connected peripherals'
        ]
      },
      
      // VPN Management
      55: {
        name: 'vpnConnect',
        description: 'Connect to VPN',
        plugin: 'vpn',
        action: 'connect',
        examples: ['connect vpn', 'connect to vpn server', 'vpn connect to location']
      },
      
      56: {
        name: 'vpnDisconnect',
        description: 'Disconnect from VPN',
        plugin: 'vpn',
        action: 'disconnect',
        examples: ['disconnect vpn', 'stop vpn', 'turn off vpn']
      },
      
      57: {
        name: 'vpnStatus',
        description: 'Check VPN connection status',
        plugin: 'vpn',
        action: 'status',
        examples: ['vpn status', 'am i on vpn', 'check vpn connection']
      },
      
      // Docker Management
      58: {
        name: 'dockerList',
        description: 'List Docker containers',
        plugin: 'docker',
        action: 'listContainers',
        examples: ['list docker containers', 'show containers', 'docker ps']
      },
      
      59: {
        name: 'dockerStart',
        description: 'Start Docker container',
        plugin: 'docker',
        action: 'startContainer',
        examples: ['start container X', 'docker start nginx', 'run container']
      },
      
      60: {
        name: 'dockerStop',
        description: 'Stop Docker container',
        plugin: 'docker',
        action: 'stopContainer',
        examples: ['stop container X', 'docker stop nginx', 'halt container']
      },
      
      // Network Operations
      61: {
        name: 'networkScan',
        description: 'Scan network for devices',
        plugin: 'network',
        action: 'scan',
        examples: ['scan network', 'find devices on network', 'network discovery']
      },
      
      62: {
        name: 'portScan',
        description: 'Scan ports on a host',
        plugin: 'network',
        action: 'port-scan',
        examples: ['port scan 192.168.1.1', 'scan ports on server', 'check open ports']
      },
      
      63: {
        name: 'pingHost',
        description: 'Ping a host or IP address',
        plugin: 'network',
        action: 'ping',
        examples: ['ping google.com', 'ping 8.8.8.8', 'check if host is up']
      },
      
      // Media Processing
      64: {
        name: 'downloadVideo',
        description: 'Download video from URL (YouTube, etc) - default for YouTube links',
        plugin: 'ytdlp',
        action: 'download',
        examples: ['download video from youtube', 'download this video', 'save video from url', 'get video from youtube.com', 'download https://youtube.com', 'download https://www.youtube.com/watch', 'download as mp4', 'youtube.com video', 'get this youtube video', 'download the video']
      },

      65: {
        name: 'convertMedia',
        description: 'Convert local media files between formats',
        plugin: 'ffmpeg',
        action: 'convert',
        examples: ['convert video to mp4', 'convert audio to mp3', 'change video format', 'convert file.mkv to mp4']
      },

      66: {
        name: 'extractAudio',
        description: 'Extract audio from a local video file on disk',
        plugin: 'ffmpeg',
        action: 'extract',
        examples: ['extract audio from local video', 'get audio from file.mp4', 'extract audio from /path/to/video.mkv']
      },

      166: {
        name: 'downloadAudio',
        description: 'Download audio/MP3 from YouTube or other URL — when user wants to DOWNLOAD, SEND, or SAVE a song as MP3/audio file. Can search by name if no URL given.',
        plugin: 'ytdlp',
        action: 'audio',
        examples: [
          'download mp3 from youtube',
          'download the song Bohemian Rhapsody as mp3',
          'send me the mp3 of Never Gonna Give You Up',
          'download Stairway to Heaven and send me the mp3',
          'get me the audio for Hotel California',
          'find the song Shape of You and send me the mp3',
          'send me the song Eternal Sunset by Meteor as an mp3',
          'send me the song Blinding Lights by The Weeknd',
          'send me that song as an mp3',
          'can you send me the song Bohemian Rhapsody',
          'get me the song Thunder by Imagine Dragons',
          'I want the song Levitating by Dua Lipa as mp3',
          'youtube to mp3',
          'download audio from url',
          'download as mp3',
          'just the audio',
          'audio only',
          'grab the song and send it as mp3'
        ]
      },

      167: {
        name: 'transcribeVideo',
        description: 'Transcribe or get subtitles/captions from a YouTube video or other video URL',
        plugin: 'ytdlp',
        action: 'transcribe',
        examples: ['transcribe this YouTube video', 'get the transcript from this video', 'what does this video say', 'get subtitles from this video', 'convert this video to text', 'youtube transcript', 'show me the captions', 'extract text from this video', 'what are they saying in this video']
      },

      168: {
        name: 'searchYoutube',
        description: 'Search YouTube for videos or songs by name to watch or listen — NOT for reading lyrics text. Use when user wants to FIND, SEARCH, or LOCATE a song or video.',
        plugin: 'ytdlp',
        action: 'search',
        examples: [
          'find me the song Bohemian Rhapsody by Queen',
          'search youtube for Never Gonna Give You Up',
          'find me a song called Hotel California',
          'search for the song Stairway to Heaven',
          'look up Somebody to Love by Jefferson Airplane',
          'find a music video for Blinding Lights',
          'search for a video about cooking',
          'find me a video of cats',
          'youtube search for Rick Astley',
          'can you find me the song Shape of You',
          'look for the song Imagine by John Lennon on youtube',
          'find me the song I want to listen to'
        ]
      },

      169: {
        name: 'getLyrics',
        description: 'Get the written lyrics text for a song — use ONLY when user explicitly says the word LYRICS or WORDS',
        plugin: 'lyrics',
        action: 'get',
        examples: [
          'get the lyrics for Bohemian Rhapsody by Queen',
          'show me the lyrics to Hotel California',
          'what are the lyrics to Never Gonna Give You Up',
          'lyrics for Blinding Lights by The Weeknd',
          'show me the words to Stairway to Heaven',
          'I want to read the lyrics of Imagine',
          'print the lyrics for Shape of You',
          'get me the song lyrics'
        ]
      },

      170: {
        name: 'searchLyrics',
        description: 'Search for song lyrics by keywords or partial text — when user has partial lyrics and wants to find the full text',
        plugin: 'lyrics',
        action: 'search',
        examples: [
          'search for lyrics containing never gonna give you up',
          'find lyrics with the words hello from the other side',
          'what song has the lyrics is this the real life',
          'search lyrics about stairway to heaven',
          'which song goes like we will rock you',
          'find a song with the lyrics I want to break free'
        ]
      },

      // Bug Detection
      67: {
        name: 'scanForBugs',
        description: 'Scan code for bugs',
        plugin: 'bugDetector',
        action: 'scanIncremental',
        examples: ['scan for bugs', 'find bugs in code', 'run bug detection', 'check code for issues']
      },
      
      68: {
        name: 'listBugs',
        description: 'List detected bugs and code issues from bug scanner',
        plugin: 'bugDetector',
        action: 'listBugs',
        examples: ['show bugs', 'show detected bugs', 'list bugs', 'list code issues', 'what bugs were found', 'show bug list', 'display bugs', 'view bugs']
      },
      
      // Backup Management
      69: {
        name: 'createBackup',
        description: 'Create system backup',
        plugin: 'backup',
        action: 'create',
        examples: ['create backup', 'backup system', 'backup files']
      },
      
      70: {
        name: 'restoreBackup',
        description: 'Restore from backup',
        plugin: 'backup',
        action: 'restore',
        examples: ['restore backup', 'restore from backup', 'recover files']
      },
      
      // SSH Management
      71: {
        name: 'sshConnect',
        description: 'Connect to remote server via SSH',
        plugin: 'ssh',
        action: 'connect',
        examples: ['ssh to server', 'connect ssh 192.168.1.1', 'remote connect to host']
      },
      
      // Voice/TTS
      72: {
        name: 'speakText',
        description: 'Convert text to speech',
        plugin: 'voice',
        action: 'speak',
        examples: ['say hello', 'speak this text', 'read this out loud']
      },
      
      // Missing Software Management Intents
      73: {
        name: 'updateSoftware',
        description: 'Update installed software',
        plugin: 'software',
        action: 'update',
        examples: ['update nginx', 'update all packages', 'apt update', 'upgrade system']
      },
      
      74: {
        name: 'listSoftware',
        description: 'List installed software',
        plugin: 'software',
        action: 'list',
        examples: ['list installed packages', 'show installed software', 'what software is installed']
      },
      
      // Missing Git Operations
      75: {
        name: 'gitClone',
        description: 'Clone a git repository',
        plugin: 'git',
        action: 'clone',
        examples: ['clone repository', 'git clone https://github.com/user/repo', 'download git repo']
      },
      
      76: {
        name: 'gitPull',
        description: 'Pull latest changes from git',
        plugin: 'git',
        action: 'pull',
        examples: ['git pull', 'pull latest changes', 'update from git']
      },
      
      77: {
        name: 'gitPush',
        description: 'Push changes to git',
        plugin: 'git',
        action: 'push',
        examples: ['git push', 'push changes', 'upload to git']
      },
      
      // Crypto Wallet Operations
      78: {
        name: 'checkWallet',
        description: 'Check wallet status and addresses',
        plugin: '_system',
        action: 'checkWallet',
        examples: ['show my wallet', 'what is my wallet address', 'show my crypto addresses', 'check wallet status']
      },
      
      79: {
        name: 'generateWallet',
        description: 'Generate a new crypto wallet',
        plugin: '_system',
        action: 'generateWallet',
        examples: ['generate new wallet', 'create crypto wallet', 'make me a wallet', 'initialize wallet']
      },
      
      80: {
        name: 'checkBalance',
        description: 'Check crypto balances',
        plugin: '_system',
        action: 'checkBalance',
        examples: ['check my balance', 'show crypto balance', 'how much ETH do I have', 'what is my BTC balance']
      },
      
      81: {
        name: 'sendCrypto',
        description: 'Send cryptocurrency',
        plugin: '_system',
        action: 'sendCrypto',
        examples: ['send ETH to', 'transfer BTC', 'send crypto', 'send 0.1 ETH to address']
      },
      
      82: {
        name: 'signMessage',
        description: 'Sign a message with wallet',
        plugin: '_system',
        action: 'signMessage',
        examples: ['sign message', 'sign this with my wallet', 'create signature']
      },

      83: {
        name: 'nanoReceive',
        description: 'Receive/pocket pending Nano blocks',
        plugin: '_system',
        action: 'nanoReceive',
        examples: ['receive nano', 'pocket nano', 'check nano receivable', 'collect nano', 'pocket pending nano']
      },

      84: {
        name: 'nanoFaucet',
        description: 'Claim free Nano from faucet',
        plugin: '_system',
        action: 'nanoFaucet',
        examples: ['claim nano faucet', 'get free nano', 'nano faucet', 'nano drip']
      },

      // Smart Contract Operations
      85: {
        name: 'readContract',
        description: 'Read smart contract data',
        plugin: '_system',
        action: 'readContract',
        examples: ['read contract', 'get contract data', 'check smart contract', 'query contract state']
      },
      
      86: {
        name: 'writeContract',
        description: 'Write to smart contract',
        plugin: '_system',
        action: 'writeContract',
        examples: ['write to contract', 'execute contract function', 'call smart contract', 'interact with contract']
      },
      
      87: {
        name: 'deployContract',
        description: 'Deploy smart contract',
        plugin: '_system',
        action: 'deployContract',
        examples: ['deploy contract', 'deploy smart contract', 'launch contract', 'deploy ERC20']
      },
      
      88: {
        name: 'monitorEvents',
        description: 'Monitor contract events',
        plugin: '_system',
        action: 'monitorEvents',
        examples: ['monitor contract events', 'watch events', 'track contract activity', 'subscribe to events']
      },
      
      // Development Operations
      89: {
        name: 'createProject',
        description: 'Create blockchain project',
        plugin: '_system',
        action: 'createProject',
        examples: ['create hardhat project', 'new solidity project', 'create smart contract project', 'init blockchain project']
      },
      
      90: {
        name: 'compileContracts',
        description: 'Compile smart contracts',
        plugin: '_system',
        action: 'compileContracts',
        examples: ['compile contracts', 'compile solidity', 'build smart contracts', 'compile project']
      },
      
      91: {
        name: 'testContracts',
        description: 'Test smart contracts',
        plugin: '_system',
        action: 'testContracts',
        examples: ['test contracts', 'run contract tests', 'test smart contracts', 'verify contracts work']
      },
      
      // Token Operations
      92: {
        name: 'checkTokenBalance',
        description: 'Check token balance',
        plugin: '_system',
        action: 'checkTokenBalance',
        examples: ['check USDT balance', 'how many tokens', 'token balance', 'ERC20 balance']
      },
      
      93: {
        name: 'transferTokens',
        description: 'Transfer ERC20 tokens (USDT, USDC, LINK, DAI, etc.) to another wallet address',
        plugin: '_system',
        action: 'transferTokens',
        examples: [
          'send tokens to another wallet',
          'transfer USDT tokens',
          'send ERC20 tokens',
          'move my LINK tokens to another address',
          'transfer 50 USDT tokens to this wallet',
          'send DAI tokens to that address',
          'move ERC20 tokens between wallets'
        ]
      },
      
      94: {
        name: 'approveTokens',
        description: 'Approve token spending',
        plugin: '_system',
        action: 'approveTokens',
        examples: ['approve token spending', 'approve USDT', 'allow contract to spend tokens']
      },
      
      // Network Operations
      95: {
        name: 'switchNetwork',
        description: 'Switch blockchain network',
        plugin: '_system',
        action: 'switchNetwork',
        examples: ['switch to polygon', 'use BSC', 'change to ethereum', 'switch network']
      },
      
      96: {
        name: 'getNetworkInfo',
        description: 'Get blockchain network information (chain ID, current blockchain network)',
        plugin: '_system',
        action: 'getNetworkInfo',
        examples: [
          'what blockchain network am I on',
          'current blockchain network',
          'show blockchain network info',
          'what chain ID is active',
          'which chain am I connected to',
          'show me the current network details for blockchain'
        ]
      },
      
      // Faucet Operations
      97: {
        name: 'claimFaucet',
        description: 'Claim testnet tokens',
        plugin: '_system',
        action: 'claimFaucet',
        examples: ['claim faucet', 'get testnet tokens', 'claim test ETH', 'faucet tokens']
      },
      
      // Transaction Management
      98: {
        name: 'estimateGas',
        description: 'Estimate blockchain transaction gas fees',
        plugin: '_system',
        action: 'estimateGas',
        examples: [
          'estimate gas for this transaction',
          'how much gas will this cost',
          'gas fee estimate',
          'transaction fee estimate on blockchain',
          'what are the current gas costs on ethereum',
          'estimate gas fees for sending ETH',
          'how much will the gas be for this contract call'
        ]
      },
      
      99: {
        name: 'getTransactionHistory',
        description: 'Get transaction history',
        plugin: '_system',
        action: 'getTransactionHistory',
        examples: ['show transactions', 'transaction history', 'past transactions', 'tx history']
      },

      // ======= MEDIA GENERATION =======
      100: {
        name: 'generateImage',
        description: 'Generate an image using AI (DALL-E, FLUX, Stable Diffusion)',
        plugin: '_system',
        action: 'generateImage',
        examples: [
          'generate an image of a sunset',
          'create a picture of a cat',
          'make an image that shows a mountain',
          'draw me a fantasy landscape',
          'send me a random image',
          'create artwork of a robot',
          'generate image of space',
          'make me a picture',
          'create an illustration',
          'design an image'
        ]
      },

      101: {
        name: 'generateVideo',
        description: 'Generate a video using AI (Sora, Wan)',
        plugin: '_system',
        action: 'generateVideo',
        examples: [
          'generate a video of waves',
          'create a video showing a sunset',
          'make a video of a cat playing',
          'send me a video of nature',
          'create an animation of dancing',
          'generate video of fireworks',
          'make a short video clip',
          'create a video animation'
        ]
      },

      102: {
        name: 'generateMusic',
        description: 'Generate AI music or songs using Suno, Mubert, or Soundverse',
        plugin: 'music',
        action: 'generate',
        examples: [
          'generate a song about the ocean',
          'make me a lo-fi beat',
          'create a happy pop song about coding',
          'sing me a song about rainy days',
          'compose some instrumental jazz',
          'play me something chill',
          'make music about love',
          'create a song for studying'
        ]
      },

      // ======= MUSIC LIBRARY =======
      103: {
        name: 'musicLibraryQuery',
        description: 'Query, browse, search, or manage the user\'s personal music library/collection. Also handles setting or changing the music directory path.',
        plugin: '_system',
        action: 'musicLibrary',
        examples: [
          'play some music',
          'play music from my library',
          'set my music directory to /mnt/nas/music',
          'where is my music stored',
          'do I have any Beatles in my music collection',
          'what artists are in my music library',
          'show me my music',
          'configure music source',
          'change my music folder'
        ]
      },

      // ======= CRYPTO TRADING =======
      104: {
        name: 'cryptoTradingStatus',
        description: 'Get crypto trading status, strategy performance, regime info, or general trading questions',
        plugin: '_system',
        action: 'cryptoTradingStatus',
        examples: [
          'how is my crypto trading doing',
          'crypto strategy status',
          'what is the trading bot doing',
          'how are my trades',
          'is the trading agent running',
          'show me crypto strategy',
          'what strategy is active',
          'market regime status',
          'tell me about the trading system',
          'how is the dollar maximizer doing'
        ]
      },

      104: {
        name: 'cryptoPositions',
        description: 'Check current crypto trading positions and holdings managed by the trading strategy',
        plugin: '_system',
        action: 'cryptoPositions',
        examples: [
          'what are my crypto positions',
          'show my trading positions',
          'am I holding ETH or stablecoins',
          'what is the strategy holding',
          'current crypto holdings',
          'show positions on BSC and ethereum'
        ]
      },

      105: {
        name: 'cryptoTradeHistory',
        description: 'View recent crypto trade history and journal entries',
        plugin: '_system',
        action: 'cryptoTradeHistory',
        examples: [
          'show my trade history',
          'recent crypto trades',
          'what trades have been executed',
          'trading journal',
          'last trades',
          'show trade log'
        ]
      },

      106: {
        name: 'swapCrypto',
        description: 'Swap or trade crypto tokens (buy ETH, sell BNB, swap USDT for ETH, exchange tokens)',
        plugin: '_system',
        action: 'swapCrypto',
        examples: [
          'swap USDT for ETH',
          'buy ETH with USDT',
          'sell my BNB for USDT',
          'trade ETH to USDT',
          'exchange BNB for USDT',
          'buy 0.5 ETH',
          'sell all my ETH',
          'swap tokens'
        ]
      },

      // ======= AGENT AVATAR =======
      110: {
        name: 'setAgentAvatar',
        description: 'Set or change the agent\'s avatar or profile picture from a provided image',
        plugin: '_system',
        action: 'setAvatar',
        examples: [
          'set this as your avatar',
          'use this image as your profile picture',
          'change your avatar to this',
          'here is your new avatar',
          'update your profile picture',
          'make this your avatar',
          'set your avatar',
          'change your profile picture',
          'here is a new profile image for you',
          'use this as your profile pic'
        ]
      },
      111: {
        name: 'syncAvatarToServices',
        description: 'Sync or upload the agent\'s avatar to Gravatar and other external services',
        plugin: '_system',
        action: 'syncAvatar',
        examples: [
          'sync your avatar to gravatar',
          'upload your avatar to gravatar',
          'push your avatar to services',
          'sync your profile picture',
          'update your gravatar',
          'send your avatar to gravatar',
          'sync avatar to external services',
          'propagate your avatar'
        ]
      },
      113: {
        name: 'getAgentNFT',
        description: 'Show the agent\'s ERC-8004 on-chain identity NFT',
        plugin: '_system',
        action: 'getAgentNFT',
        examples: [
          'show me your NFT',
          'what is your agent ID',
          'ERC-8004 identity',
          'show your on-chain identity',
          'what\'s your agent number',
          'show your blockchain identity',
          'agent NFT details',
          'show your NFT card',
          'what is your on-chain ID',
          'show agent identity token'
        ]
      },
      112: {
        name: 'getAgentAvatar',
        description: 'Show or provide the agent\'s current avatar or profile picture',
        plugin: '_system',
        action: 'getAvatar',
        examples: [
          'show me your avatar',
          'what do you look like',
          'send me your avatar',
          'show your profile picture',
          'what is your avatar',
          'give me your profile picture',
          'send your avatar',
          'show me your profile pic',
          'let me see your avatar',
          'what\'s your current avatar'
        ]
      },

      114: {
        name: 'externalServiceStats',
        description: 'Show external service gateway statistics, payments received, revenue, usage, and service status',
        plugin: '_system',
        action: 'getExternalServiceStats',
        examples: [
          'show external service stats',
          'how much revenue from external services',
          'show me payment history',
          'what payments have you received',
          'external gateway status',
          'how many requests to the sandbox',
          'show external service revenue',
          'what services are active',
          'how much BNB have you earned',
          'show audit logs for external services',
          'external API usage stats',
          'who has used your services'
        ]
      },

      // ======= SKYNET P2P NETWORK =======
      115: {
        name: 'skynetInfo',
        description: 'General questions about SKYNET token, Skynet P2P network, bounties, governance, trust scores, federation, data marketplace, compute rental, staking, referrals, arb signals, knowledge pack pricing, priority queue, V3 LP, or any SKYNET feature explanation',
        plugin: null,
        action: null,
        examples: [
          'what is SKYNET',
          'do I need SKYNET tokens',
          'how does the P2P network work',
          'tell me about bounties',
          'what is skynet governance',
          'how do trust scores work',
          'what can I do with SKYNET',
          'explain skynet federation',
          'what is the data marketplace',
          'how does compute rental work',
          'explain knowledge pack pricing',
          'what are arbitrage signals',
          'how do referral rewards work',
          'what is the service priority queue',
          'how does SKYNET staking work',
          'what is ERC-8004 verification',
          'tell me about concentrated liquidity V3',
          'what is staking yield distribution',
          'how was the SKYNET contract audited',
          'explain all SKYNET features',
          'what are premium knowledge packs',
          'how does the priority tipping system work'
        ]
      },

      116: {
        name: 'skynetNetworkStatus',
        description: 'Show live Skynet P2P network status including connected peers, services, bounties, and proposals',
        plugin: '_system',
        action: 'skynetNetworkStatus',
        examples: [
          'skynet network status',
          'how many peers are connected',
          'show P2P services',
          'skynet peer list',
          'show online peers',
          'how many bounties are open',
          'show active proposals',
          'skynet federation status'
        ]
      },

      117: {
        name: 'skynetTokenInfo',
        description: 'Show live SKYNET token data including ledger allocations, balances, and payment history',
        plugin: '_system',
        action: 'skynetTokenInfo',
        examples: [
          'SKYNET token info',
          'show token ledger',
          'SKYNET allocations',
          'how many SKYNET tokens in bounty pool',
          'show SKYNET payment history',
          'token supply breakdown',
          'SKYNET contract address',
          'show SKYNET treasury balance'
        ]
      },

      118: {
        name: 'skynetEconomyLive',
        description: 'Fetch and display LIVE/CURRENT data from Skynet economy: active marketplace listings, recent arb signals, referral reward history, running compute jobs. Only use when user wants to SEE current data, NOT when asking what something is or how it works (use intent 115 for explanations).',
        plugin: '_system',
        action: 'skynetEconomyLive',
        examples: [
          'show me the current data marketplace listings',
          'list active arb signals right now',
          'show my referral rewards history',
          'list running compute jobs',
          'show me what data is for sale right now',
          'show recent arb signals received',
          'how many compute jobs are active',
          'show referral reward stats',
          'list marketplace items for sale',
          'any arb opportunities right now'
        ]
      },

      // ======= SKYNET STAKING OPERATIONS =======
      119: {
        name: 'stakingStatus',
        description: 'Check staking position, staked amount, pending rewards, APY, contract stats',
        plugin: '_system',
        action: 'stakingStatus',
        examples: [
          'check my staking status',
          'how much am I staking',
          'staking rewards',
          'show my stake',
          'what is my staking position',
          'how much SKYNET do I have staked',
          'show staking APY'
        ]
      },

      120: {
        name: 'stakingStake',
        description: 'Stake SKYNET tokens into the staking contract',
        plugin: '_system',
        action: 'stakingStake',
        examples: [
          'stake 5000 SKYNET',
          'add tokens to stake',
          'stake more SKYNET',
          'I want to stake',
          'stake 100 tokens',
          'put 1000 SKYNET into staking'
        ]
      },

      121: {
        name: 'stakingUnstake',
        description: 'Unstake/withdraw SKYNET tokens from the staking contract',
        plugin: '_system',
        action: 'stakingUnstake',
        examples: [
          'unstake 1000 SKYNET',
          'withdraw my stake',
          'remove tokens from stake',
          'unstake all my SKYNET',
          'pull out my staked tokens'
        ]
      },

      122: {
        name: 'stakingClaim',
        description: 'Claim pending staking rewards',
        plugin: '_system',
        action: 'stakingClaim',
        examples: [
          'claim my staking rewards',
          'collect staking yield',
          'claim rewards',
          'harvest staking rewards',
          'collect my SKYNET rewards'
        ]
      },

      // ======= SCAMMER REGISTRY OPERATIONS =======
      124: {
        name: 'scammerReport',
        description: 'Report/flag a blockchain address as a scammer in the on-chain registry. Mints SCAMMER soulbound token to target.',
        plugin: '_system',
        action: 'scammerReport',
        examples: [
          'report 0x1234 as a scammer',
          'flag this address as a scammer: 0xabc',
          'add 0x1234 to the scammer registry',
          'mark 0xabc as address poisoning',
          'register scammer 0x1234 phishing',
          'report scammer 0x1234 evidence tx 0xdef',
          'flag 0x1234 as honeypot'
        ]
      },

      125: {
        name: 'scammerCheck',
        description: 'Check if a blockchain address is flagged in the scammer registry',
        plugin: '_system',
        action: 'scammerCheck',
        examples: [
          'is 0x1234 a scammer',
          'check if 0xabc is flagged',
          'check scammer registry for 0x1234',
          'is this address safe: 0xabc',
          'lookup 0x1234 in scammer list',
          'scammer check 0x1234'
        ]
      },

      126: {
        name: 'scammerList',
        description: 'List all flagged scammer addresses or show registry stats',
        plugin: '_system',
        action: 'scammerList',
        examples: [
          'show all flagged scammers',
          'list scammer registry',
          'how many scammers are flagged',
          'scammer registry stats',
          'show the scammer blacklist'
        ]
      },

      127: {
        name: 'scammerRemove',
        description: 'Remove an address from the scammer registry (genesis agent only)',
        plugin: '_system',
        action: 'scammerRemove',
        examples: [
          'remove 0x1234 from scammer registry',
          'unflag 0xabc as scammer',
          'clear scammer flag for 0x1234',
          'unlist 0x1234 from scammer blacklist'
        ]
      },

      123: {
        name: 'listMyServices',
        description: 'List services ALICE offers with pricing - both ERC-8004 external services (paid in BNB) and Skynet P2P services (paid in SKYNET tokens)',
        plugin: '_system',
        action: 'listMyServices',
        examples: [
          'what services do you offer',
          'how much do you charge',
          'show me your service pricing',
          'what are your p2p services',
          'list your paid services',
          'what can other agents pay you to do',
          'service catalog',
          'ERC-8004 services',
          'what services do you sell',
          'how much does image generation cost',
          'skynet service prices',
          'what do you charge for youtube download'
        ]
      },

      // ======= ENS NAME SERVICE =======
      128: {
        name: 'ensStatus',
        description: 'Check ENS name status — shows base name, expiry, subnames, reverse resolution, and auto-renewal setting',
        plugin: '_system',
        action: 'ensStatus',
        examples: [
          'what is my ENS name',
          'check ENS status',
          'when does my ENS expire',
          'show my ENS subnames',
          'do I have an ENS name',
          'ENS expiry',
          'lanagent.eth status',
          'what .eth name do I have',
          'is my ENS auto-renewing',
          'show ENS configuration'
        ]
      },
      129: {
        name: 'ensRequestSubname',
        description: 'Request an ENS subname from the genesis peer via the P2P network. Users can specify a desired label or let it default to the agent name.',
        plugin: '_system',
        action: 'ensRequestSubname',
        examples: [
          'get me an ENS subname',
          'request an ENS name',
          'I want a .eth subname',
          'register my ENS subname as coolbot',
          'request subname coolbot',
          'get me coolbot.lanagent.eth',
          'I want an ENS identity',
          'set up my ENS name',
          'request ENS name myagent',
          'can I get a subname',
          'give me an ENS subname called alpha',
          'change my ENS subname to newname'
        ]
      },

      // ======= EMAIL LEASING =======
      130: {
        name: 'emailLeaseRequest',
        description: 'Request a leased email address (e.g. myname@lanagent.net) from the genesis peer via the P2P network. Costs SKYNET tokens. The genesis instance creates the mailbox and returns IMAP/SMTP credentials.',
        plugin: '_system',
        action: 'emailLeaseRequest',
        examples: [
          'get me an email address',
          'I want a lanagent.net email',
          'lease an email',
          'request email mybot@lanagent.net',
          'can I get an email address',
          'set up my email',
          'get me an email called myagent',
          'I need an email account',
          'request email lease',
          'how do I get a lanagent email'
        ]
      },
      131: {
        name: 'emailLeaseStatus',
        description: 'Check the status of your leased email address — expiry, quota, renewal info',
        plugin: '_system',
        action: 'emailLeaseStatus',
        examples: [
          'check my email lease',
          'when does my email expire',
          'email lease status',
          'show my leased email',
          'do I have a leased email'
        ]
      },

      // ======= MINDSWARM INFO (general questions — routes to AI, not plugin actions) =======
      132: {
        name: 'mindswarmInfo',
        description: 'General questions about what MindSwarm is, how it works, the social network platform. NOT for performing actions like posting or checking feed.',
        plugin: null,
        action: null,
        examples: [
          'what is MindSwarm',
          'what\'s MindSwarm',
          'tell me about MindSwarm',
          'how does MindSwarm work',
          'what is the MindSwarm social network',
          'explain MindSwarm',
          'what can I do on MindSwarm',
          'is MindSwarm like Twitter'
        ]
      },

      // Special handling options
      998: {
        name: 'askClarification',
        description: 'Ask user for clarification when intent is unclear',
        plugin: '_system',
        action: 'clarify',
        examples: ['ambiguous request', 'unclear what user wants']
      },
      
    };
  }

  // Get intents from enabled plugins
  getDynamicIntents() {
    const dynamicIntents = {};
    let intentId = 1000; // Start dynamic intents at 1000 to avoid overlap with static intents
    
    if (this.agent.apiManager && this.agent.apiManager.apis) {
      for (const [pluginName, pluginInfo] of this.agent.apiManager.apis) {
        if (pluginInfo.enabled && pluginInfo.instance && pluginInfo.instance.commands) {
          // Handle simple command array (like network plugin)
          if (Array.isArray(pluginInfo.instance.commands)) {
            for (const command of pluginInfo.instance.commands) {
              // Handle both string commands and command objects
              const cmdName = typeof command === 'object' ? command.command : command;
              const cmdDesc = typeof command === 'object' && command.description
                ? command.description : `${pluginInfo.instance.description}: ${cmdName}`;
              const cmdExamples = typeof command === 'object' && command.examples
                ? command.examples : [`${cmdName} with ${pluginName}`];
              dynamicIntents[intentId] = {
                name: `${pluginName}_${cmdName}`,
                description: cmdDesc,
                plugin: pluginName,
                action: cmdName,
                examples: cmdExamples
              };
              intentId++;
            }
          } 
          // Handle detailed command objects
          else if (typeof pluginInfo.instance.commands === 'object') {
            for (const [cmdKey, cmdInfo] of Object.entries(pluginInfo.instance.commands)) {
              dynamicIntents[intentId] = {
                name: `${pluginName}_${cmdKey}`,
                description: `${pluginInfo.instance.description}: ${cmdInfo.description || cmdKey}`,
                plugin: pluginName,
                action: cmdKey,
                examples: cmdInfo.examples || [`${cmdKey} with ${pluginName}`]
              };
              intentId++;
            }
          }
        }
      }
    }
    
    return dynamicIntents;
  }

  // Build the complete intent list
  getAllIntents() {
    const baseIntents = this.intents;
    const dynamicIntents = this.getDynamicIntents();
    return { ...baseIntents, ...dynamicIntents };
  }

  // Check if text contains a URL
  detectURL(text) {
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
    const matches = text.match(urlRegex);
    return matches ? matches[0] : null;
  }

  /**
   * Regex-based fallback hints for intents that are commonly missed by AI
   * classification when the prompt contains 400+ intents. Only fires for
   * clear, unambiguous patterns. Returns intent ID or null.
   */
  _regexIntentHint(text) {
    const t = text.toLowerCase();

    // updateContact (39): "update/change/modify/edit ... contact(s)"
    if (/(?:update|change|modify|edit)\b.*\bcontacts?\b/.test(t) ||
        /\bcontacts?\b.*(?:update|change|modify|edit)/.test(t) ||
        /\badd\s+(?:an?\s+)?alias\b.*\bcontacts?\b/.test(t) ||
        /\bcontacts?\b.*\badd\s+(?:an?\s+)?alias/.test(t)) {
      return 39;
    }

    // unblockEmailContact (42): check BEFORE block - "unblock/remove block ... email/contact"
    if (/\bunblock\b.*\b(?:emails?|contacts?|address)/.test(t) ||
        /\b(?:emails?|contacts?)\b.*\bunblock/.test(t) ||
        /\bremove\b.*\bblock\b/.test(t) ||
        /\bre-?enable\b.*\bemails?\b/.test(t)) {
      return 42;
    }

    // blockEmailContact (41): "block ... email/contact" or "blocklist"
    if (/\bblock\b.*\b(?:emails?|contacts?|address)/.test(t) ||
        /\b(?:emails?|contacts?|address)\b.*\bblock(?:list|ed)?/.test(t) ||
        /\bprevent\s+(?:sending\s+)?emails?\b/.test(t) ||
        /\bblacklist\b.*\b(?:emails?|contacts?)/.test(t) ||
        /\badd\b.*\b(?:to\s+)?(?:the\s+)?block(?:ed|list)/.test(t)) {
      return 41;
    }

    // YouTube search: "find me a song", "search youtube for", "search for a song"
    if (/\b(?:find|search(?:\s+for)?|look\s+(?:up|for))\b.*\b(?:song|music|video|youtube)\b/i.test(t) &&
        !/(https?:\/\/)/i.test(t) &&
        !/\blyrics?\b/i.test(t)) {
      return 168;
    }

    // Lyrics: "get lyrics for", "lyrics to", "what are the lyrics"
    if (/\blyrics?\b/i.test(t) && !/\bsearch\b.*\blyrics?\b/i.test(t)) {
      return 169;
    }

    // Twitter/X URL: find the dynamic intent ID for twitter download
    if (/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/\d+/i.test(text)) {
      const dynamicIntents = this.getDynamicIntents();
      for (const [id, intent] of Object.entries(dynamicIntents)) {
        if (intent.plugin === 'twitter' && intent.action === 'download') {
          return parseInt(id);
        }
      }
    }

    return null;
  }

  // Create prompt for AI intent detection
  buildIntentPrompt(userQuery, conversationContext = '') {
    const allIntents = this.getAllIntents();
    const intentIds = Object.keys(allIntents);
    
    // Log intent count for debugging
    logger.debug(`Building intent prompt with ${intentIds.length} total intents (IDs: ${Math.min(...intentIds.map(Number))}-${Math.max(...intentIds.map(Number))})`);
    
    let prompt = `You are an intent classifier. Given a user query, select the best matching intent from the numbered list below.

${conversationContext}User Query: "${userQuery}"

Available Intents:
`;

    for (const [id, intent] of Object.entries(allIntents)) {
      prompt += `${id}. ${intent.name} - ${intent.description}\n`;
      if (intent.examples && intent.examples.length > 0) {
        prompt += `   Examples: ${intent.examples.join(', ')}\n`;
      }
    }

    prompt += `\nRespond with ONLY the number (0-999) that best matches the user's intent.

Decision Guide:
- For questions referring to previous messages (what about that, explain more, etc), use intent 999
- For system information queries (disk space, memory, CPU), use intent 1
- For running system commands, use intent 2
- For reminders with time, use intent 3
- For software installation/management (install, uninstall, compile, check, search), use intents 4-8
- For software updates, use intent 73
- For listing installed software, use intent 74
- For web searches, general lookups, or questions about current/recent/real-time information (popular packages, latest news, current trends, rankings, recent events), use intent 9
- For stock prices, use intent 10
- For cryptocurrency prices, use intent 11
- For weather, use intent 12
- For task management (create, list), use intents 13-14
- For sending emails immediately, use intent 15
- For checking emails/inbox, use intent 16
- For scheduling emails with future time/date, use intent 17
- For scheduling recurring emails (daily, weekly, etc), use intent 18
- For git operations (status, commit, issues), use intents 19-22
- For restarting the agent, use intent 23
- For redeploying from git, use intent 24
- For adding feature ideas to the plan, use intent 25
- For adding to-do items, use intent 26
- For scraping webpage content, use intent 27
- For taking screenshots of webpages, use intent 28
- For generating PDFs from webpages, use intent 29
- For examining own code, use intent 30
- For suggesting code improvements, use intent 31
- For listing planned improvements, use intent 32
- For showing changelog or recent updates, use intent 33
- For implementing/building new features in code, use intent 34
- For adding a new contact, use intent 35
- For listing contacts, use intent 36
- For deleting a contact, use intent 37
- For getting contact details by email, use intent 38
- For updating/modifying/changing existing contact info (change phone, add alias, edit email, modify name), use intent 39
- For finding/searching contacts by name or alias, use intent 40
- For blocking an email contact (prevent sending, add to blocklist, blacklist), use intent 41
- For unblocking an email contact (remove from blocklist, re-enable), use intent 42
- For listing blocked email contacts, use intent 43
- For remembering or storing information, use intent 44
- For recalling or retrieving stored information, use intent 45
- For calendar operations (create, list, today, delete, availability, search, upcoming), use intents 46-52
- For searching/finding/looking up specific calendar events by name or topic (e.g., "check my Olympics trip", "find dentist appointment"), use intent 51 (searchCalendarEvents)
- For getting upcoming events for the next few days/week, use intent 52 (getUpcomingCalendarEvents)
- For checking if a specific time slot is free (e.g., "am I free at 2pm"), use intent 50 (checkCalendarAvailability)
- For devices connected TO the agent/system (USB, peripherals, hardware), use intent 53
- For VPN operations (connect, disconnect, status), use intents 55-57
- For Docker operations (list, start, stop containers), use intents 58-60
- For network scanning/discovery, use intent 61
- For port scanning, use intent 62
- For pinging hosts, use intent 63
- For downloading video from YouTube/URL, use intent 64
- For converting local media files between formats, use intent 65
- For extracting audio from LOCAL video files on disk, use intent 66
- For downloading audio/MP3 from YouTube/URL, use intent 166
- For transcribing video/getting subtitles, use intent 167
- For searching YouTube for a song or video by name (no URL provided), use intent 168
- For getting song lyrics (when user explicitly asks for lyrics/words), use intent 169
- For searching lyrics by keywords, use intent 170
- IMPORTANT: When user says "find me a song" or "search for a song", use intent 168 (searchYoutube), NOT web search
- For bug detection (scan for bugs, list bugs), use intents 67-68
- For backup operations (create, restore), use intents 69-70
- For SSH connections to remote servers, use intent 71
- For text-to-speech, use intent 72
- For Git clone/pull/push operations, use intents 75-77
- For crypto wallet operations (check, generate, balance, send, sign), use intents 78-82
- For Nano wallet operations (receive/pocket, faucet), use intents 83-84. Nano sending uses intent 81 (sendCrypto) with chain XNO/NANO
- For smart contract operations (read, write, deploy, monitor events), use intents 85-88
- For blockchain development (create project, compile, test), use intents 89-91
- For ERC20 token operations (balance, transfer, approve), use intents 92-94
- For blockchain network operations (switch network, network info), use intents 95-96
- For testnet faucets, use intent 97
- For blockchain transaction operations (gas estimation, history), use intents 98-99
- For AI image generation, use intent 100
- For AI video generation, use intent 101
- For AI music generation, use intent 102
- IMPORTANT: For "what is", "how does", "explain", "tell me about" questions about ANY SKYNET/Skynet feature (token, P2P, bounties, governance, marketplace, compute rental, staking, referrals, arb signals, priority queue, etc.), ALWAYS use intent 115 (explains from knowledge, no live data needed)
- For live Skynet network status (peers, services, connections, bounties) — user wants to SEE numbers, use intent 116
- For live SKYNET token data (ledger balances, allocations, payment history) — user wants to SEE balances, use intent 117
- For live Skynet economy data (marketplace listings, arb signals, referral stats, compute jobs) — user wants to LIST/SHOW current items, use intent 118
- For staking status/position/rewards check, use intent 119 (stakingStatus)
- For staking tokens (adding to stake), use intent 120 (stakingStake)
- For unstaking/withdrawing tokens, use intent 121 (stakingUnstake)
- For claiming staking rewards, use intent 122 (stakingClaim)
- IMPORTANT: "how does staking work" / "explain staking" = intent 115 (knowledge). "check my staking status" / "stake 100 SKYNET" = intents 119-122 (action)
- For reporting a scammer address, use intent 124 (scammerReport). User must include a 0x address.
- For checking if an address is a scammer, use intent 125 (scammerCheck)
- For listing flagged scammers or registry stats, use intent 126 (scammerList)
- For removing a scammer flag (admin), use intent 127 (scammerRemove)
- IMPORTANT: "report 0x1234 as scammer" / "flag 0x1234 phishing" = intent 124. "is 0x1234 a scammer" = intent 125.
- If the request is ambiguous or unclear, use intent 998 (Ask for clarification)
- For general knowledge questions or conversations, use intent 999 (Process as query)
- For simple greetings or small talk, use intent 0 (General conversation)

Number:`;

    return prompt;
  }

  // Parse extracted parameters based on intent and user query
  async extractParameters(intentId, userQuery) {
    const intent = this.getAllIntents()[intentId];
    if (!intent || !intent.plugin) {
      return { plugin: null, action: null, params: {} };
    }

    let params = {};

    // Use AI to extract parameters for complex intents
    switch (intent.name) {
      case 'systemInfo':
        params = await this.extractSystemInfoParams(userQuery);
        break;
        
      case 'setReminder':
        params = await this.extractReminderParams(userQuery);
        break;
        
      case 'installSoftware':
      case 'uninstallSoftware':
      case 'checkSoftware':
        params = await this.extractSoftwareParams(userQuery);
        break;
        
      case 'compileSoftware':
        params = await this.extractCompileParams(userQuery);
        break;
        
      case 'runCommand':
        params = await this.extractCommandParams(userQuery);
        break;
        
      case 'webSearch':
      case 'stockPrice':
      case 'cryptoPrice':
      case 'weatherInfo':
        params = await this.extractSearchParams(userQuery, intent.action);
        break;
        
      case 'scrapeWebpage':
      case 'takeScreenshot':
      case 'generatePDF':
        params = await this.extractScraperParams(userQuery, intent.action);
        break;
        
      case 'examineOwnCode':
        params = await this.extractCodeTopic(userQuery);
        break;
        
      case 'suggestImprovements':
        params = await this.extractFeatureName(userQuery);
        break;
        
      case 'listPlannedImprovements':
        // No params needed
        params = {};
        break;
        
      case 'showChangelog':
        // Default to 7 days for changelog queries
        params = { days: 7 };
        break;
        
      case 'implementFeature':
      case 'considerFeature':
        params = await this.extractFeatureSuggestion(userQuery);
        break;

      case 'addTodo':
      case 'createTask':
        params = await this.extractTaskParams(userQuery);
        break;

      case 'sendEmail':
        params = await this.extractEmailParams(userQuery);
        break;
        
      case 'scheduleEmail':
        params = await this.extractScheduledEmailParams(userQuery);
        break;
        
      case 'scheduleRecurringEmail':
        params = await this.extractRecurringEmailParams(userQuery);
        break;
        
      case 'addContact':
        params = await this.extractContactParams(userQuery);
        break;
        
      case 'listContacts':
        // No params needed for listing contacts
        params = {};
        break;
        
      case 'deleteContact':
        params = await this.extractContactEmailParam(userQuery);
        break;
        
      case 'getContact':
        const contactEmailResult = await this.extractContactEmailParam(userQuery);
        // getContact expects just the email string, not an object
        if (contactEmailResult.email) {
          params = { email: contactEmailResult.email };
        } else if (contactEmailResult.name) {
          // If we got a name instead of email, this should use findContact
          throw new Error(`Please use an email address to get contact details, or search by name using "find contact ${contactEmailResult.name}"`);
        } else {
          throw new Error('Please specify the email address of the contact');
        }
        break;
        
      case 'updateContact':
        params = await this.extractContactParams(userQuery);
        break;
        
      case 'findContact':
        params = await this.extractFindContactParams(userQuery);
        break;
        
      case 'blockEmailContact':
      case 'unblockEmailContact':
        params = await this.extractContactEmailParam(userQuery);
        if (!params.email) {
          throw new Error('Please specify the email address to ' + 
            (intent.name === 'blockEmailContact' ? 'block' : 'unblock'));
        }
        if (intent.name === 'blockEmailContact') {
          // Try to extract reason
          const reasonMatch = userQuery.match(/(?:because|reason:|for)\s+(.+)/i);
          if (reasonMatch) {
            params.reason = reasonMatch[1].trim();
          }
        }
        break;
        
      case 'listBlockedContacts':
        params = {};
        break;
        
      // VPN Management
      case 'vpnConnect':
        params = await this.extractVpnParams(userQuery);
        break;
        
      case 'vpnDisconnect':
      case 'vpnStatus':
        params = {};
        break;
        
      // Docker Management
      case 'dockerList':
        params = {};
        break;
        
      case 'dockerStart':
      case 'dockerStop':
        params = await this.extractContainerName(userQuery);
        break;
        
      // Network Operations
      case 'networkScan':
        params = {};
        break;
        
      case 'portScan':
        params = await this.extractPortScanParams(userQuery);
        break;
        
      case 'pingHost':
        params = await this.extractHostParam(userQuery);
        break;
        
      // Media Processing
      case 'downloadVideo':
      case 'downloadAudio':
      case 'transcribeVideo':
        params = await this.extractVideoUrl(userQuery);
        break;

      case 'searchYoutube':
        params = await this.extractSearchQuery(userQuery);
        break;

      case 'getLyrics':
        params = await this.extractLyricsParams(userQuery);
        break;

      case 'searchLyrics':
        params = await this.extractSearchQuery(userQuery);
        break;

      case 'convertMedia':
      case 'extractAudio':
        params = await this.extractMediaParams(userQuery);
        break;
        
      // Bug Detection
      case 'scanForBugs':
      case 'listBugs':
        params = {};
        break;
        
      // Backup Management
      case 'createBackup':
      case 'restoreBackup':
        params = await this.extractBackupParams(userQuery);
        break;
        
      // SSH Management
      case 'sshConnect':
        params = await this.extractSshParams(userQuery);
        break;
        
      // Voice/TTS
      case 'speakText':
        params = await this.extractTextToSpeak(userQuery);
        break;
        
      // Software Management
      case 'updateSoftware':
        params = await this.extractSoftwareParams(userQuery);
        break;
        
      case 'listSoftware':
        params = {};
        break;
        
      // Git Operations
      case 'gitClone':
        params = await this.extractGitUrl(userQuery);
        break;
        
      case 'gitPull':
      case 'gitPush':
        params = {};
        break;
        
      // Crypto wallet operations
      case 'checkWallet':
      case 'generateWallet':
        params = {}; // No params needed
        break;
        
      case 'checkBalance':
        params = await this.extractCryptoBalanceParams(userQuery);
        break;
        
      case 'sendCrypto':
        params = await this.extractSendCryptoParams(userQuery);
        break;
        
      case 'signMessage':
        params = await this.extractSignMessageParams(userQuery);
        break;

      case 'nanoReceive':
      case 'nanoFaucet':
        params = {};
        break;

      // Smart contract operations
      case 'readContract':
      case 'writeContract':
        params = await this.extractContractParams(userQuery, intent.action);
        break;
        
      case 'deployContract':
        params = await this.extractDeployParams(userQuery);
        break;
        
      case 'monitorEvents':
        params = await this.extractMonitorParams(userQuery);
        break;
        
      // Development operations
      case 'createProject':
        params = await this.extractProjectParams(userQuery);
        break;
        
      case 'compileContracts':
      case 'testContracts':
        params = await this.extractPathParam(userQuery);
        break;
        
      // Token operations
      case 'checkTokenBalance':
      case 'transferTokens':
      case 'approveTokens':
        params = await this.extractTokenParams(userQuery, intent.action);
        break;
        
      // Network operations
      case 'switchNetwork':
        params = await this.extractNetworkParam(userQuery);
        break;
        
      case 'getNetworkInfo':
        params = {}; // No params needed
        break;
        
      // Faucet operations
      case 'claimFaucet':
        params = await this.extractFaucetParams(userQuery);
        break;
        
      // Transaction operations
      case 'estimateGas':
        params = await this.extractGasParams(userQuery);
        break;
        
      case 'getTransactionHistory':
        params = await this.extractHistoryParams(userQuery);
        break;

      // Music generation
      case 'generateMusic':
        params = await this.extractMusicParams(userQuery);
        break;

      // Calendar search - extract search query from natural language
      case 'searchCalendarEvents':
        params = await this.extractCalendarSearchParams(userQuery);
        break;

      // Calendar upcoming - extract days count
      case 'getUpcomingCalendarEvents':
        params = await this.extractCalendarUpcomingParams(userQuery);
        break;

      // Staking operations
      case 'stakingStatus':
      case 'stakingClaim':
        params = {};
        break;

      case 'stakingStake':
      case 'stakingUnstake':
        params = this.extractStakingAmount(userQuery);
        break;

      // Scammer registry operations
      case 'scammerReport':
        params = this.extractScammerReportParams(userQuery);
        break;

      case 'scammerCheck':
      case 'scammerRemove':
        params = this.extractScammerAddress(userQuery);
        break;

      case 'scammerList':
        params = {};
        break;

      // ENS operations
      case 'ensStatus':
        params = {};
        break;

      case 'ensRequestSubname':
        params = this.extractENSSubnameLabel(userQuery);
        break;

      default:
        // Check if it's a network plugin command
        if (intent.plugin === 'network') {
          params = await this.extractNetworkParams(intent.action, userQuery);
        } else if (intent.plugin === 'docker') {
          // Handle docker commands - extract action from command like "docker ps"
          const dockerMatch = userQuery.match(/docker\s+(\w+)(?:\s+(.*))?/i);
          if (dockerMatch) {
            const dockerAction = dockerMatch[1];
            const dockerParams = dockerMatch[2] || '';
            
            // Map common docker commands to plugin actions
            const actionMap = {
              'ps': 'ps',
              'list': 'list',
              'images': 'images',
              'run': 'create',
              'start': 'start',
              'stop': 'stop',
              'rm': 'remove',
              'remove': 'remove',
              'logs': 'logs',
              'exec': 'exec',
              'build': 'build',
              'pull': 'pull',
              'push': 'push',
              'compose': dockerParams.startsWith('up') ? 'compose-up' : 
                         dockerParams.startsWith('down') ? 'compose-down' : 'compose-status'
            };
            
            // Use mapped action or original if not mapped
            const mappedAction = actionMap[dockerAction] || dockerAction;
            
            // Extract additional parameters based on action
            params = await this.extractDockerParams(mappedAction, dockerParams, userQuery);
          } else {
            params = { query: userQuery };
          }
        } else if (intent.plugin) {
          // Dynamic plugin intent — let the plugin extract its own parameters via AI
          params = { query: userQuery, needsParameterExtraction: true, originalInput: userQuery };
        } else {
          // For simple intents, extract basic parameters
          params = { query: userQuery };
        }
    }

    return {
      plugin: intent.plugin,
      action: intent.action,
      params
    };
  }

  // AI-based parameter extraction methods
  async extractSystemInfoParams(query) {
    const prompt = `Extract the system information type from this query: "${query}"

Types: disk, memory, cpu, network, uptime, os, all

Respond with just the type word:`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 20 });
      const type = response.content.trim().toLowerCase();
      
      // Validate type
      const validTypes = ['disk', 'memory', 'cpu', 'network', 'uptime', 'os', 'all'];
      return { type: validTypes.includes(type) ? type : 'all' };
    } catch (error) {
      logger.error('Parameter extraction error:', error);
      return { type: 'all' };
    }
  }

  async extractReminderParams(query) {
    const prompt = `You MUST respond ONLY with valid JSON. Extract the message, time, and notification method from this reminder request: "${query}"

Examples:
"remind me to check logs in 30 minutes" -> {"message": "check logs", "minutes": 30, "notificationMethod": "telegram"}
"set reminder to deploy in 2 hours via email" -> {"message": "deploy", "minutes": 120, "notificationMethod": "email"}
"remind me to call mom in 1 hour via both telegram and email" -> {"message": "call mom", "minutes": 60, "notificationMethod": "both"}

Time conversions: 
- minutes = number of minutes
- hours = number * 60
- days = number * 1440

Notification methods: telegram (default), email, both

RESPOND WITH ONLY THIS JSON FORMAT (no explanation):
{
  "message": "the task to remind about",
  "minutes": number_of_minutes,
  "notificationMethod": "telegram"
}`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 100 });
      
      // Clean the response to extract just JSON
      let jsonStr = response.content.trim();
      
      // If response contains explanation, try to extract JSON
      if (!jsonStr.startsWith('{')) {
        const jsonMatch = jsonStr.match(/\{[^}]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
      }
      
      const parsed = JSON.parse(jsonStr);
      
      return {
        message: parsed.message || 'reminder',
        minutes: Math.max(1, parsed.minutes || 30), // Ensure at least 1 minute
        notificationMethod: parsed.notificationMethod || 'telegram'
      };
    } catch (error) {
      logger.error('Reminder parameter extraction error:', error);
      
      // Fallback: Try to parse time manually from the query
      const fallback = this.parseReminderManually(query);
      logger.info('Using manual fallback parsing:', fallback);
      return fallback;
    }
  }

  parseReminderManually(query) {
    const lowerQuery = query.toLowerCase();
    let minutes = 30; // default
    let message = 'reminder';
    let notificationMethod = 'telegram';
    
    // Extract time
    const timeMatch = lowerQuery.match(/(\d+)\s*(minute|min|hour|hr|day)s?/);
    if (timeMatch) {
      const num = parseInt(timeMatch[1]);
      const unit = timeMatch[2];
      if (unit.includes('min')) {
        minutes = num;
      } else if (unit.includes('hr') || unit.includes('hour')) {
        minutes = num * 60;
      } else if (unit.includes('day')) {
        minutes = num * 1440;
      }
    }
    
    // Extract notification method
    if (lowerQuery.includes('email') && lowerQuery.includes('telegram')) {
      notificationMethod = 'both';
    } else if (lowerQuery.includes('email')) {
      notificationMethod = 'email';
    }
    
    // Extract message (everything after "remind me to" or similar)
    const msgMatch = lowerQuery.match(/(?:remind me to|set reminder to|remind me about|reminder to)\s+(.+?)(?:\s+in\s+\d+|\s+via\s+|$)/);
    if (msgMatch) {
      message = msgMatch[1].trim();
    }
    
    return { message, minutes, notificationMethod };
  }

  async extractSoftwareParams(query) {
    const prompt = `Extract the package name from this software query: "${query}"

Examples:
"install ffmpeg" -> package: "ffmpeg"
"is docker installed?" -> package: "docker"
"remove apache" -> package: "apache"

Respond with just the package name:`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 50 });
      const packageName = response.content.trim().replace(/[^a-zA-Z0-9\-_.]/g, '');
      return { package: packageName };
    } catch (error) {
      logger.error('Software parameter extraction error:', error);
      return { package: 'unknown' };
    }
  }

  async extractCompileParams(query) {
    const prompt = `Extract the software name or URL from this compile request: "${query}"

Examples:
"compile neovim from source" -> url: "neovim"
"build https://github.com/user/repo" -> url: "https://github.com/user/repo"

Respond with just the name or URL:`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 100 });
      const url = response.content.trim();
      return { url };
    } catch (error) {
      logger.error('Compile parameter extraction error:', error);
      return { url: 'unknown' };
    }
  }

  async extractCommandParams(query) {
    const prompt = `Extract the command to run from this request: "${query}"

Examples:
"run df -h" -> command: "df -h"
"execute ps aux" -> command: "ps aux"
"show me top output" -> command: "top -bn1"

Respond with just the command:`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 50 });
      const command = response.content.trim();
      return { command };
    } catch (error) {
      logger.error('Command parameter extraction error:', error);
      return { command: 'echo "command not found"' };
    }
  }

  async extractContactEmailParam(query) {
    const prompt = `Extract the email address from this contact request: "${query}"
Examples:
"delete contact john@example.com" -> email: "john@example.com"
"remove John from contacts" -> email: null (need to ask for email)
"delete email contact sarah@work.com" -> email: "sarah@work.com"
"show contact details for bob@company.org" -> email: "bob@company.org"

Respond in JSON format:
{
  "email": "email@address.com or null"
}`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 100 });
      
      // Clean up response - remove markdown code blocks if present
      let cleanedResponse = response.content.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      const result = JSON.parse(cleanedResponse);
      
      // If no email found, we might need to look up by name
      if (!result.email) {
        // Extract name for lookup
        const nameMatch = query.match(/(?:delete|remove|show|get)\s+(?:contact\s+)?(?:for\s+)?([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
        if (nameMatch && nameMatch[1]) {
          result.name = nameMatch[1].trim();
        }
      }
      
      return result;
    } catch (error) {
      logger.error('Contact email extraction error:', error);
      // Try basic regex extraction
      const emailMatch = query.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      return { email: emailMatch ? emailMatch[0] : null };
    }
  }

  async extractScheduledEmailParams(query) {
    try {
      // First, get basic email parameters
      const emailParams = await this.extractEmailParams(query);
      
      // Now extract the scheduling time
      const timePrompt = `Extract the scheduled time from this email request: "${query}"

Today's date: ${new Date().toDateString()}
Current time: ${new Date().toLocaleTimeString()}

Examples:
"send email to John tomorrow at 9am" -> "tomorrow at 9am"
"schedule email to alice@example.com at 5:30 PM on Friday" -> "5:30 PM on Friday"
"email reminder to myself next Monday morning" -> "next Monday morning"
"send birthday wishes on December 25th at 8am" -> "December 25th at 8am"
"email Wayne in 2 hours" -> "in 2 hours"
"send report at 3pm" -> "at 3pm"

Extract the time/date portion and convert it to ISO 8601 format.
If no specific time is mentioned, use 9:00 AM.

Respond in JSON format:
{
  "timePhrase": "the time phrase from the query",
  "sendAt": "ISO 8601 datetime string (e.g., 2025-01-15T14:00:00Z)"
}`;

      const timeResponse = await this.agent.providerManager.generateResponse(timePrompt, { maxTokens: 100 });
      
      // Clean up response
      let cleanedTime = timeResponse.content.trim();
      if (cleanedTime.startsWith('```json')) {
        cleanedTime = cleanedTime.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedTime.startsWith('```')) {
        cleanedTime = cleanedTime.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      const timeData = JSON.parse(cleanedTime);
      
      // Combine email params with scheduling data
      return {
        to: emailParams.to,
        subject: emailParams.subject,
        body: emailParams.text,
        sendAt: timeData.sendAt,
        action: 'schedule',
        recipientName: emailParams.recipientName,
        timePhrase: timeData.timePhrase
      };
      
    } catch (error) {
      logger.error('Scheduled email extraction error:', error);
      throw new Error(`Failed to extract scheduled email parameters: ${error.message}`);
    }
  }

  async extractRecurringEmailParams(query) {
    try {
      // First, get basic email parameters
      const emailParams = await this.extractEmailParams(query);
      
      // Now extract the recurrence pattern
      const recurrencePrompt = `Extract the recurrence pattern from this recurring email request: "${query}"

Examples:
"send daily email to John at 9am" -> "0 9 * * *"
"schedule weekly report every Monday" -> "0 9 * * 1"
"email reminder every month on the 15th" -> "0 9 15 * *"
"send report every Friday at 5pm" -> "0 17 * * 5"
"email every 2 hours" -> "2 hours"
"send update every 30 minutes" -> "30 minutes"
"daily status email" -> "daily"
"weekly summary" -> "weekly"

Common patterns:
- "daily" or "every day" -> "daily" or "0 9 * * *" (9am daily)
- "weekly" or "every week" -> "weekly" or "0 9 * * 1" (Monday 9am)
- "monthly" -> "monthly" or "0 9 1 * *" (1st of month 9am)
- Time intervals: "5 minutes", "2 hours", etc.
- Cron expressions for complex patterns

Respond in JSON format:
{
  "recurrencePhrase": "the recurrence phrase from query",
  "recurrence": "cron expression or interval (e.g., '0 9 * * *' or '5 minutes')"
}`;

      const recurrenceResponse = await this.agent.providerManager.generateResponse(recurrencePrompt, { maxTokens: 100 });
      
      // Clean up response
      let cleanedRecurrence = recurrenceResponse.content.trim();
      if (cleanedRecurrence.startsWith('```json')) {
        cleanedRecurrence = cleanedRecurrence.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedRecurrence.startsWith('```')) {
        cleanedRecurrence = cleanedRecurrence.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      const recurrenceData = JSON.parse(cleanedRecurrence);
      
      // Combine email params with recurrence data
      return {
        to: emailParams.to,
        subject: emailParams.subject,
        text: emailParams.text,
        recurrence: recurrenceData.recurrence,
        action: 'scheduleRecurring',
        recipientName: emailParams.recipientName,
        recurrencePhrase: recurrenceData.recurrencePhrase
      };
      
    } catch (error) {
      logger.error('Recurring email extraction error:', error);
      throw new Error(`Failed to extract recurring email parameters: ${error.message}`);
    }
  }

  async extractContactParams(query) {
    const prompt = `Extract the contact information from this request: "${query}"

Examples:
"add contact john@example.com" -> name: null, email: "john@example.com", aliases: [], phone: null, telegram: null
"save John Smith with email john@example.com" -> name: "John Smith", email: "john@example.com", aliases: [], phone: null, telegram: null
"add contact Wayne Williams with email wayne@example.com, aliases CommanderFog and WayneW, phone +1-555-0123" -> name: "Wayne Williams", email: "wayne@example.com", aliases: ["CommanderFog", "WayneW"], phone: "+1-555-0123", telegram: null
"Add a new contact name is Wayne Williams email is mazuda95@gmail.com alias is CommanderFog phone number is +14055746564 telegram username is @VikTsoi74" -> name: "Wayne Williams", email: "mazuda95@gmail.com", aliases: ["CommanderFog"], phone: "+14055746564", telegram: "@VikTsoi74"
"add contact Sarah with email sarah@work.com, telegram @sarahc" -> name: "Sarah", email: "sarah@work.com", aliases: [], phone: null, telegram: "@sarahc"
"add contact Bob aka Bobby with email bob@company.org" -> name: "Bob", email: "bob@company.org", aliases: ["Bobby"], phone: null, telegram: null
"update contact wayne@example.com add aliases TheFog and Commander" -> email: "wayne@example.com", addAliases: ["TheFog", "Commander"]
"update contact sarah@resistance.org add twitter @sarah_connor and linkedin sarah-connor-123" -> email: "sarah@resistance.org", socialMedia: {"twitter": "@sarah_connor", "linkedin": "sarah-connor-123"}

Rules:
- Extract name, email, aliases, phone, telegram, and social media if mentioned
- For aliases: look for "alias", "aliases", "aka", "also known as", "nickname" or similar phrases (handle both singular and plural)
- For phone: extract phone numbers in any format
- For telegram: look for @ handles or "telegram" mentions
- For social media: extract platform and handle/url pairs
- Email must be a valid email format
- Return null for fields not mentioned

Respond in JSON format:
{
  "name": "Contact Name or null",
  "email": "email@address.com",
  "aliases": ["alias1", "alias2"] or [],
  "phone": "phone number or null",
  "telegram": "@handle or null",
  "socialMedia": {"platform": "handle/url"} or {},
  "addAliases": ["alias1", "alias2"] or null,
  "removeAliases": ["alias1", "alias2"] or null
}`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 200 });
      // Clean up response - remove markdown code blocks if present
      let cleanedResponse = response.content.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      const extracted = JSON.parse(cleanedResponse);
      
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!extracted.email || !emailRegex.test(extracted.email)) {
        throw new Error('Invalid email format');
      }
      
      // Build the return object with all extracted fields
      const result = {
        email: extracted.email,
        action: 'addContact'
      };
      
      // Only include fields that have values
      if (extracted.name) result.name = extracted.name;
      if (extracted.aliases && extracted.aliases.length > 0) result.aliases = extracted.aliases;
      if (extracted.phone) result.phone = extracted.phone;
      if (extracted.telegram) result.telegram = extracted.telegram;
      if (extracted.socialMedia && Object.keys(extracted.socialMedia).length > 0) {
        result.socialMedia = extracted.socialMedia;
      }
      if (extracted.addAliases && extracted.addAliases.length > 0) result.addAliases = extracted.addAliases;
      if (extracted.removeAliases && extracted.removeAliases.length > 0) result.removeAliases = extracted.removeAliases;
      
      return result;
      
    } catch (error) {
      logger.error('Contact parameter extraction error:', error);
      // Try basic extraction as fallback
      const emailMatch = query.match(/([^\s]+@[^\s]+\.[^\s]+)/);
      if (emailMatch) {
        return {
          name: null,
          email: emailMatch[1],
          action: 'addContact'
        };
      }
      throw new Error('Could not extract valid email from query');
    }
  }

  async extractEmailParams(query) {
    // Check if master email is mentioned or implied
    const masterEmail = process.env.EMAIL_OF_MASTER || '';
    
    // First, extract basic parameters
    const extractPrompt = `Extract the recipient and topic from this email request: "${query}"

Master's email: ${masterEmail}

Examples:
"send me an email saying good morning" -> recipient: "${masterEmail}", topic: "morning greeting"
"email john@example.com about the meeting" -> recipient: "john@example.com", topic: "meeting"
"send Sarah a project update" -> recipient: "Sarah", topic: "project update"
"send an email to Wayne explaining home media servers" -> recipient: "Wayne", topic: "home media servers"
"email CommanderFog about the project" -> recipient: "CommanderFog", topic: "project"
"send wayne an email explaining home media servers" -> recipient: "Wayne", topic: "home media servers"
"email wayne about server benefits" -> recipient: "Wayne", topic: "server benefits"
"email chris about the demo" -> recipient: "Chris", topic: "demo"
"send christina the report" -> recipient: "Christina", topic: "report"

Rules:
- If "me" or "master" is mentioned, recipient is: ${masterEmail}
- If a name is mentioned (e.g., "Wayne", "Bob", "Sarah"), extract it as the recipient
- Look for names after prepositions like "to", "for" or verbs like "send", "email"
- Only use ${masterEmail} if NO name is mentioned at all in the request
- Extract names as they appear (e.g., "wayne" -> "Wayne", "commanderfog" -> "CommanderFog")
- Extract the main topic/purpose of the email
- IMPORTANT: Extract the COMPLETE name - don't truncate (e.g., "Christina" not "Chris", unless user specifically said "Chris")

Respond in JSON format:
{
  "recipient": "email or name (properly capitalized)",
  "topic": "what the email is about"
}`;

    try {
      const extractResponse = await this.agent.providerManager.generateResponse(extractPrompt, { maxTokens: 100 });
      // Clean up response - remove markdown code blocks if present
      let cleanedResponse = extractResponse.content.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      const extracted = JSON.parse(cleanedResponse);
      
      let toEmail = extracted.recipient || masterEmail;
      let recipientName = null;
      
      // Check if recipient is a name rather than email
      if (toEmail && !toEmail.includes('@')) {
        logger.info(`Looking up contact by name/alias: "${toEmail}"`);
        
        // Try to find contact by name or alias
        try {
          // Use the plugin's findContact API
          const emailPlugin = this.agent.apiManager.getPlugin('email');
          if (emailPlugin) {
            logger.info('Using email plugin to find contact...');
            
            // Call the plugin's execute method with findContact action
            const searchResult = await emailPlugin.execute({
              action: 'findContact',
              searchTerm: toEmail
            });
            
            logger.info('Contact search result:', {
              success: searchResult?.success,
              found: searchResult?.contact ? 'yes' : 'no',
              email: searchResult?.contact?.email,
              name: searchResult?.contact?.name
            });
            
            if (searchResult && searchResult.success && searchResult.contact) {
              toEmail = searchResult.contact.email;
              recipientName = searchResult.contact.name || toEmail;
              logger.info(`Contact found: ${recipientName} <${toEmail}>`);
            } else {
              logger.info('Contact not found via findContact, trying memory recall...');
              
              // If not found and not master, check old method
              if (toEmail.toLowerCase() !== 'me' && toEmail.toLowerCase() !== 'master') {
                const contactQuery = await this.agent.memoryManager.recall(`email contact ${toEmail}`, {
                  type: 'knowledge',
                  limit: 1
                });
                
                if (contactQuery && contactQuery.length > 0) {
                  const match = contactQuery[0].content.match(/([^\s]+@[^\s]+)/);
                  if (match) {
                    toEmail = match[1];
                    // Try to extract name from the memory content
                    const nameMatch = contactQuery[0].content.match(/Email contact: ([^<]+) </); 
                    if (nameMatch) recipientName = nameMatch[1].trim();
                    logger.info(`Contact found via memory: ${recipientName} <${toEmail}>`);
                  }
                } else {
                  logger.warn(`Contact not found for: "${extracted.recipient}"`);
                  // If still not found, throw error to prevent sending to wrong person
                  throw new Error(`Cannot find contact "${extracted.recipient}". Please provide their email address or check the contact name.`);
                }
              }
            }
          } else {
            logger.error('Email plugin not available for contact lookup');
          }
        } catch (error) {
          logger.error('Contact lookup failed:', error);
          // Only fall back to master if explicitly 'me' or 'master'
          if (toEmail.toLowerCase() === 'me' || toEmail.toLowerCase() === 'master') {
            toEmail = masterEmail;
          } else {
            // For other names, throw error to prevent sending to wrong person
            throw new Error(`Cannot find contact "${toEmail}". Please provide their email address or check the contact name.`);
          }
        }
      } else if (toEmail && toEmail.includes('@')) {
        // We have an email, but let's try to find the contact name
        try {
          const emailPlugin = this.agent.apiManager.getPlugin('email');
          if (emailPlugin) {
            const searchResult = await emailPlugin.execute({
              action: 'getContact',
              email: toEmail
            });
            
            if (searchResult && searchResult.success && searchResult.contact) {
              recipientName = searchResult.contact.name;
            }
          }
        } catch (err) {
          // Ignore errors in contact lookup
          logger.debug('Contact name lookup failed:', err);
        }
      }
      
      // Generate timestamp for subject
      const timestamp = new Date().toLocaleString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      
      // Determine if this is going to master or someone else
      const isToMaster = toEmail === masterEmail;
      
      // Look up master's name from contacts
      let masterName = 'the user';
      try {
        // Direct database lookup for master contact
        const { Memory } = await import('../models/Memory.js');
        logger.info(`Looking up master contact for email: ${masterEmail}`);
        
        const masterContact = await Memory.findOne({
          type: 'knowledge',
          'metadata.category': 'email_contacts',
          'metadata.email': masterEmail
        });
        
        if (masterContact && masterContact.metadata && masterContact.metadata.name) {
          masterName = masterContact.metadata.name;
          logger.info(`Found master's name from database: ${masterName}`);
        } else {
          logger.info('Master contact not found in database, trying email plugin...');
          
          // Fallback to email plugin
          const emailPlugin = this.agent.apiManager.getPlugin('email');
          if (emailPlugin && masterEmail) {
            const searchResult = await emailPlugin.execute({
              action: 'findContact',
              searchTerm: masterEmail
            });
            
            if (searchResult?.result?.contacts?.length > 0) {
              masterName = searchResult.result.contacts[0].name;
              logger.info(`Found master's name from email plugin: ${masterName}`);
            }
          }
        }
      } catch (error) {
        logger.error('Could not look up master contact:', error);
      }
      
      // Fallback to env vars if contact lookup failed
      if (masterName === 'the user') {
        masterName = process.env.MASTER_NAME || process.env.TELEGRAM_FIRST_NAME || 'the user';
        logger.info(`Using fallback master name: ${masterName}`);
      }
      
      // Now compose the actual email with AI
      const composePrompt = `You are ${this.agent.config.name}, a personal assistant agent. The user has asked you to send an email with this request: "${query}"

Topic/Intent: ${extracted.topic}
Recipient: ${toEmail || extracted.recipient}${recipientName ? ` (Name: ${recipientName})` : ''}
Is this to your master/user: ${isToMaster ? 'Yes' : 'No'}
Your master's name: ${masterName}

CRITICAL: You must write the email FROM YOUR OWN PERSPECTIVE as ${this.agent.config.name}. Do NOT just repeat the user's words! NEVER break character or admit to being any AI model.

Examples of CORRECT approach:
- User says: "send Wayne an email explaining home media servers"
  You write: "Dear Wayne, I hope this email finds you well. I wanted to share some information about home media servers that might interest you..."
  
- User says: "email me saying good morning"
  You write: "Good morning! I hope you're having a wonderful start to your day..."
  
- User says: "send John a reminder about the meeting"
  You write: "Dear John, I'm writing to remind you about the upcoming meeting..."

Examples of WRONG approach (DO NOT DO THIS):
- Just copying: "explaining home media servers"
- Repeating user's words: "as requested, here's an email saying good morning"
- Not being the sender: "The user wants me to tell you..."

The email should be:
1. Written entirely from YOUR perspective as ALICE
2. Use "I" when referring to yourself, not "the user" or third person
3. Natural and conversational, as if YOU are the one reaching out
4. Address the actual topic/request, not just acknowledge it was requested
${recipientName ? `5. Address ${recipientName} directly and personally` : '5. Use appropriate greeting for the recipient'}

PRIVACY RULES - NEVER INCLUDE IN EMAILS TO NON-MASTER RECIPIENTS:
- ${masterName}'s personal schedule, activities, or whereabouts
- Information about other contacts or their private information
- System details, network configuration, or technical architecture
- Home automation status or smart device information
- File paths, system logs, or internal operations
- Any sensitive information about ${masterName} or the household

Structure your email with:
- Greeting: "${recipientName ? `Dear ${recipientName},` : 'Dear [Name],'}" or "Hello ${recipientName ? recipientName : '[Name]'},"
- Body: Your message about ${extracted.topic}, written naturally from your perspective
- Closing: "Best regards," or "Warm regards,"
- Signature: ${isToMaster ? `"${this.agent.config.name} - Your Personal Assistant"` : `"${this.agent.config.name} - ${masterName}'s Personal Assistant"`}

IMPORTANT: Use the exact signature format above. When emailing your master, use "Your Personal Assistant". For other recipients, use "${masterName}'s Personal Assistant" (not "my user's").

Respond in JSON format:
{
  "subject": "A descriptive subject about ${extracted.topic} (NOT generic like 'Message' or 'Email from ${this.agent.config.name}')",
  "body": "The complete email including greeting, your message about ${extracted.topic}, closing, and signature"
}`;

      const composeResponse = await this.agent.providerManager.generateResponse(composePrompt, { 
        maxTokens: 800,  // Increased from 300 to handle longer emails
        temperature: 0.7 
      });
      
      logger.info('AI compose response:', {
        contentLength: composeResponse.content?.length,
        preview: composeResponse.content?.substring(0, 100) + '...'
      });
      
      // Clean up response - remove markdown code blocks if present
      let cleanedCompose = composeResponse.content.trim();
      if (cleanedCompose.startsWith('```json')) {
        cleanedCompose = cleanedCompose.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedCompose.startsWith('```')) {
        cleanedCompose = cleanedCompose.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      const composed = JSON.parse(cleanedCompose);
      
      // Add timestamp to subject
      // Use AI-generated subject if valid, otherwise fallback to default
      const aiSubject = composed.subject && composed.subject.trim() && 
                       composed.subject.toLowerCase() !== 'subject' && 
                       composed.subject.length > 2 
                       ? composed.subject 
                       : `Message from ${this.agent.config.name}`;
      const finalSubject = `${aiSubject} - ${timestamp}`;
      
      // Debug logging
      logger.info('Email params extracted:', {
        to: toEmail,
        subject: finalSubject,
        textLength: composed.body?.length,
        textPreview: composed.body?.substring(0, 50) + '...'
      });
      
      // Validate toEmail is set
      if (!toEmail) {
        throw new Error('No valid recipient email address found');
      }

      // Detect attachment-related phrases in the query
      const queryLower = query.toLowerCase();
      const readmePatterns = /\b(include|attach|send|with)\b.{0,20}\b(readme|read me|documentation|docs|your readme)\b|\b(readme|documentation)\b.{0,20}\b(attach|include|send)\b|\bintroduce (yourself|itself)\b.*\b(readme|documentation|attach)\b/i;
      const includeReadme = readmePatterns.test(query);

      // Detect file path attachments
      const filePathPattern = /(?:attach|include|with)\s+(?:file\s+)?([\/~][^\s,]+\.[a-zA-Z0-9]+)/gi;
      const attachments = [];
      let fileMatch;
      while ((fileMatch = filePathPattern.exec(query)) !== null) {
        attachments.push(fileMatch[1]);
      }

      if (includeReadme) {
        logger.info('README attachment detected in email request');
      }
      if (attachments.length > 0) {
        logger.info(`File attachments detected: ${attachments.join(', ')}`);
      }

      const result = {
        to: toEmail,
        subject: finalSubject,
        text: composed.body,
        action: 'sendWithConfirmation',  // Use safer method
        recipientName: recipientName || extracted.recipient,
        requireConfirmation: true  // Always confirm for safety
      };

      if (includeReadme) {
        result.includeReadme = true;
      }
      if (attachments.length > 0) {
        result.attachments = attachments;
      }

      return result;
      
    } catch (error) {
      logger.error('Email parameter extraction error:', error);
      // Fallback
      const timestamp = new Date().toLocaleString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      return {
        to: masterEmail,
        subject: `Message from ${this.agent.config.name} - ${timestamp}`,
        text: `Hello,\n\n${query}\n\nBest regards,\n${this.agent.config.name} - Your Personal Assistant`,
        action: 'send'
      };
    }
  }

  async extractMusicParams(query) {
    try {
      const extractPrompt = `Extract music generation parameters from this request: "${query}"

Examples:
"generate a happy pop song about coding at 3am" -> prompt: "happy pop song about coding at 3am", genre: "pop", mood: "happy"
"make me a lo-fi beat for studying" -> prompt: "lo-fi beat for studying", genre: "lo-fi", mood: "chill"
"sing me a song about the ocean" -> prompt: "a song about the ocean", genre: null, mood: null
"compose an instrumental jazz piece" -> prompt: "instrumental jazz piece", genre: "jazz", mood: null, instrumental: true
"create ambient music for relaxing" -> prompt: "ambient music for relaxing", genre: "ambient", mood: "relaxing"
"generate a rock anthem about freedom" -> prompt: "rock anthem about freedom", genre: "rock", mood: "energetic"

Rules:
- Extract the main creative prompt (what the song should be about)
- Identify genre if mentioned (pop, rock, jazz, lo-fi, ambient, electronic, hip-hop, classical, etc.)
- Identify mood if mentioned (happy, sad, chill, energetic, romantic, melancholic, etc.)
- Set instrumental to true if "instrumental", "no vocals", "beat", "melody" is mentioned
- If a specific provider is mentioned (suno, mubert, soundverse), extract it

Respond in JSON format:
{
  "prompt": "the creative prompt for the song",
  "genre": "genre or null",
  "mood": "mood or null",
  "instrumental": false,
  "provider": "provider name or null"
}`;

      const response = await this.agent.providerManager.generateResponse(extractPrompt, { maxTokens: 150 });

      let cleaned = response.content.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const extracted = JSON.parse(cleaned);

      const params = {
        prompt: extracted.prompt || query,
        action: 'generate'
      };
      if (extracted.genre) params.genre = extracted.genre;
      if (extracted.mood) params.mood = extracted.mood;
      if (extracted.instrumental) params.instrumental = true;
      if (extracted.provider) params.provider = extracted.provider;

      logger.info('Music params extracted:', params);
      return params;

    } catch (error) {
      logger.error('Music parameter extraction error:', error);
      return {
        prompt: query,
        action: 'generate'
      };
    }
  }

  async extractCalendarSearchParams(query) {
    try {
      // Extract the search keyword from queries like "check my Olympics trip on the calendar"
      const cleaned = query
        .replace(/\b(check|find|search|look up|look for|show me|get|on the calendar|on my calendar|in my calendar|calendar|from calendar|in calendar)\b/gi, '')
        .replace(/\b(my|the|a|an)\b/gi, '')
        .trim()
        .replace(/\s+/g, ' ')
        .trim();

      const searchQuery = cleaned || query;
      logger.info(`Calendar search params extracted: query="${searchQuery}" from "${query}"`);
      return { query: searchQuery };
    } catch (error) {
      logger.error('Calendar search parameter extraction error:', error);
      return { query: query };
    }
  }

  async extractCalendarUpcomingParams(query) {
    try {
      // Extract number of days from queries like "next 3 days", "this week", "next week"
      const daysMatch = query.match(/(\d+)\s*days?/i);
      if (daysMatch) {
        return { days: parseInt(daysMatch[1]), limit: 20 };
      }
      if (/this week|next 7|next seven/i.test(query)) {
        return { days: 7, limit: 20 };
      }
      if (/next week/i.test(query)) {
        return { days: 14, limit: 20 };
      }
      if (/tomorrow/i.test(query)) {
        return { days: 1, limit: 20 };
      }
      // Default to 7 days
      return { days: 7, limit: 20 };
    } catch (error) {
      logger.error('Calendar upcoming parameter extraction error:', error);
      return { days: 7, limit: 20 };
    }
  }

  /**
   * Extract staking amount from natural language query.
   * Returns { amount: <number|'all'|null> }
   */
  extractStakingAmount(query) {
    // Check for "all" / "everything" / "max"
    if (/\ball\b|\beverything\b|\bmax\b|\bfull\s+balance\b/i.test(query)) {
      return { amount: 'all' };
    }

    // Match number patterns: "5000", "5,000", "5000.5", "5,000.50"
    const match = query.match(/(\d[\d,]*\.?\d*)\s*(?:skynet|tokens?)?/i);
    if (match) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (amount > 0) {
        return { amount };
      }
    }

    // No amount specified — agent should ask
    return { amount: null };
  }

  /**
   * Extract ENS subname label from natural language.
   * Handles: "request subname coolbot", "get me coolbot.lanagent.eth", "register my ENS as alpha"
   */
  extractENSSubnameLabel(query) {
    // Match explicit patterns: "subname coolbot", "called coolbot", "as coolbot", "name coolbot"
    const explicit = query.match(/(?:subname|called|named|as|name)\s+([a-z0-9][\w-]*)/i);
    if (explicit) {
      return { label: explicit[1].toLowerCase().replace(/[^a-z0-9-]/g, '') };
    }

    // Match "get me X.lanagent.eth" or "X.something.eth"
    const dotEth = query.match(/([a-z0-9][\w-]*)\.[\w-]+\.eth/i);
    if (dotEth) {
      return { label: dotEth[1].toLowerCase().replace(/[^a-z0-9-]/g, '') };
    }

    // No label specified — handler will default to AGENT_NAME or ask
    return { label: null };
  }

  /**
   * Extract scammer report params: address, category, evidence tx, reason
   */
  extractScammerReportParams(query) {
    const params = { address: null, category: null, evidenceTxHash: null, reason: null };

    // Extract ethereum address (0x followed by 40 hex chars)
    const addrMatch = query.match(/\b(0x[a-fA-F0-9]{40})\b/);
    if (addrMatch) params.address = addrMatch[1];

    // Extract evidence tx hash (0x followed by 64 hex chars)
    const txMatches = query.match(/\b(0x[a-fA-F0-9]{64})\b/g);
    if (txMatches) {
      // If there are multiple 0x hashes, the 64-char one is the evidence tx
      params.evidenceTxHash = txMatches[0];
    }

    // Detect category from keywords
    const categoryMap = {
      'address poison': 1, 'poison': 1,
      'phish': 2,
      'honeypot': 3, 'honey pot': 3,
      'rug pull': 4, 'rug': 4, 'rugpull': 4,
      'fake contract': 5, 'fake': 5,
      'dust': 6, 'dust attack': 6
    };
    const lowerQuery = query.toLowerCase();
    for (const [keyword, cat] of Object.entries(categoryMap)) {
      if (lowerQuery.includes(keyword)) {
        params.category = cat;
        break;
      }
    }

    // Extract explicit category number
    const catNumMatch = query.match(/\bcategory\s*(\d)\b/i);
    if (catNumMatch) params.category = parseInt(catNumMatch[1]);

    // Extract reason after "reason:" or "because" or "for"
    const reasonMatch = query.match(/(?:reason:|because|for)\s+["']?([^"'\n]{1,31})/i);
    if (reasonMatch) params.reason = reasonMatch[1].trim();

    return params;
  }

  /**
   * Extract a single ethereum address from query
   */
  extractScammerAddress(query) {
    const match = query.match(/\b(0x[a-fA-F0-9]{40})\b/);
    return { address: match ? match[1] : null };
  }

  async extractSearchParams(query, actionType) {
    let extractedParam = '';
    
    if (actionType === 'stock') {
      const prompt = `Extract the stock symbol from: "${query}"\nExamples: "AAPL stock" -> AAPL, "Tesla price" -> TSLA\nSymbol:`;
      try {
        const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 20 });
        extractedParam = response.content.trim().toUpperCase();
        return { symbol: extractedParam };
      } catch (error) {
        return { symbol: 'UNKNOWN' };
      }
    }
    
    if (actionType === 'crypto') {
      const prompt = `Extract ONLY the cryptocurrency symbol or name from: "${query}"

Examples:
"bitcoin price" -> BTC
"ethereum value" -> ETH
"price of chainlink" -> LINK
"cardano price" -> ADA
"what's dogecoin worth" -> DOGE
"SKYNET token price" -> SKYNET
"price per token" -> NONE
"current price" -> NONE

If no specific cryptocurrency is mentioned, respond with NONE.
Important: Respond with ONLY the symbol (like BTC) or name (like chainlink) or NONE. No extra text.

Symbol/Name:`;
      try {
        const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 10 });
        extractedParam = response.content.trim().replace(/[^a-zA-Z]/g, '');
        if (!extractedParam || extractedParam === 'NONE') {
          throw new Error('Which cryptocurrency would you like the price for? Please specify a token name or symbol (e.g. "Bitcoin price" or "SKYNET price").');
        }
        return { symbol: extractedParam };
      } catch (error) {
        if (error.message.includes('Which cryptocurrency')) throw error;
        return { symbol: 'BTC' };
      }
    }
    
    if (actionType === 'weather') {
      const prompt = `Extract the location from: "${query}"\nExamples: "weather in New York" -> New York\nLocation:`;
      try {
        const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 50 });
        extractedParam = response.content.trim();
        return { location: extractedParam };
      } catch (error) {
        return { location: 'Unknown' };
      }
    }
    
    // Default web search
    return { query };
  }

  async extractScraperParams(query, actionType) {
    // Extract URL from the query
    const url = this.detectURL(query);
    
    if (!url) {
      // Try to extract URL using AI
      const prompt = `Extract the URL from this request: "${query}"\n\nIf no URL found, respond with "NO_URL".\nURL:`;
      try {
        const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 100 });
        const extractedUrl = response.content.trim();
        if (extractedUrl === 'NO_URL') {
          return { error: 'No URL found in query' };
        }
        // Return params without action - it will be added by the task processor
        return { 
          url: extractedUrl,
          options: actionType === 'screenshot' ? { fullPage: true } : {}
        };
      } catch (error) {
        return { error: 'Failed to extract URL' };
      }
    }
    
    // Return params without action - it will be added by the task processor
    return { 
      url,
      options: actionType === 'screenshot' ? { fullPage: true } : {}
    };
  }

  async extractFindContactParams(query) {
    const prompt = `Extract the search term from this find contact request: "${query}"
    
Examples:
"find contact CommanderFog" -> searchTerm: "CommanderFog"
"search for Wayne" -> searchTerm: "Wayne"
"find contact by alias Bobby" -> searchTerm: "Bobby"
"lookup contact sarah@example.com" -> searchTerm: "sarah@example.com"
"show me contact info for Kris" -> searchTerm: "Kris"
"get John contact details" -> searchTerm: "John"
"contact info for Sarah" -> searchTerm: "Sarah"
"who is Wayne" -> searchTerm: "Wayne"

Respond in JSON format:
{
  "searchTerm": "the name, email, or alias to search for"
}`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 100 });
      let cleanedResponse = response.content.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      return JSON.parse(cleanedResponse);
    } catch (error) {
      this.logger.error('Failed to extract find contact params:', error);
      
      // Fallback extraction - use greedy match (.+) to capture multi-word names
      let searchMatch = query.match(/(?:find|search|lookup)\s+(?:for\s+)?(?:contact\s+)?(?:by\s+alias\s+)?(.+)/i);
      if (!searchMatch) {
        // Try patterns like "contact info for X" or "who is X"
        searchMatch = query.match(/(?:contact\s+info\s+for|who\s+is|show\s+me\s+contact\s+info\s+for)\s+(.+)/i);
        if (searchMatch) {
          return { searchTerm: searchMatch[1].trim() };
        }
        // Try "get X contact details"
        searchMatch = query.match(/get\s+(.+?)\s+contact/i);
        if (searchMatch) {
          return { searchTerm: searchMatch[1].trim() };
        }
      }
      return { searchTerm: searchMatch ? searchMatch[1].trim() : query.replace(/\b(?:find|search|lookup|contact|info|for|show|me|get|details|who|is)\b/gi, '').trim() };
    }
  }

  // Main detection method
  async detect(text, context = {}) {
    try {
      logger.info(`AI intent detection for: "${text}"`);
      
      // Quick check for URLs first
      const hasURL = this.detectURL(text);
      if (hasURL) {
        logger.info(`URL detected in query: ${hasURL}`);
      }
      
      // Get recent conversation context if available
      let conversationContext = '';
      if (context.userId && this.agent.memoryManager) {
        try {
          const recentConversations = await this.agent.memoryManager.getConversationContext(context.userId, 5);
          if (recentConversations && recentConversations.length > 0) {
            conversationContext = 'Recent conversation for context:\n';
            for (const conv of recentConversations.reverse()) {
              const role = conv.metadata?.role || 'unknown';
              const message = conv.content.substring(0, 150);
              conversationContext += `${role}: ${message}\n`;
            }
            conversationContext += '\n';
          }
        } catch (err) {
          logger.debug('Could not get conversation context for intent detection:', err);
        }
      }
      
      // Pre-check: regex hints for intents that get lost in the 400+ intent prompt
      const regexHintId = this._regexIntentHint(text);

      // Get AI to classify the intent
      const prompt = this.buildIntentPrompt(text, conversationContext);
      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 10,
        temperature: 0.1
      });

      let intentId = parseInt(response.content.trim());
      logger.info(`AI selected intent ID: ${intentId}`);

      // If AI returned general/invalid or a mismatched intent but regex found a specific match, use the regex hint
      // Regex hints are only set for unambiguous patterns (e.g. specific URL patterns), so they're safe to override
      if (regexHintId !== null && intentId !== regexHintId) {
        const regexIntent = this.getAllIntents()[regexHintId];
        const aiIntent = this.getAllIntents()[intentId];
        // Override if AI returned general/invalid, or if AI picked a different plugin than the regex hint
        if (intentId === 0 || isNaN(intentId) || !aiIntent || aiIntent.plugin !== regexIntent?.plugin) {
          logger.info(`Regex hint overrides AI intent ${intentId} (${aiIntent?.name || 'unknown'}) → ${regexHintId} (${regexIntent?.name})`);
          intentId = regexHintId;
        }
      }
      
      if (isNaN(intentId)) {
        logger.warn('AI returned invalid intent ID, using general');
        return { detected: false, intent: 'general', original: text };
      }
      
      // Get the selected intent
      const intent = this.getAllIntents()[intentId];
      
      // If this is a Govee plugin intent, use two-step detection for better accuracy
      if (intent && intent.plugin === 'govee') {
        logger.info('Detected Govee plugin intent, using two-step detection for better accuracy');
        return await this.detectGoveeSpecificIntent(text, conversationContext);
      }
      
      // Extract parameters for the detected intent
      let result;
      try {
        result = await this.extractParameters(intentId, text);
      } catch (paramError) {
        logger.warn(`Parameter extraction failed for intent ${intentId} (${intent?.name}): ${paramError.message}`);
        // Intent was correctly identified but params failed - still return the intent
        // The command handler can prompt the user for missing parameters
        if (intentId !== 0 && intent) {
          return {
            detected: true,
            intent: intent.name,
            plugin: intent.plugin || 'core',
            action: intent.action || intent.name,
            parameters: {},
            paramError: paramError.message
          };
        }
        return { detected: false, intent: 'general', original: text };
      }

      if (intentId === 0 || !result.plugin) {
        return { detected: false, intent: 'general', original: text };
      }

      return {
        detected: true,
        intent: intent.name,
        plugin: result.plugin,
        action: result.action,
        parameters: result.params
      };

    } catch (error) {
      logger.error('AI intent detection error:', error);
      return { detected: false, intent: 'general', original: text };
    }
  }

  /**
   * Two-step Govee intent detection for better accuracy
   */
  async detectGoveeSpecificIntent(text, conversationContext = '') {
    try {
      // Get all Govee commands from the plugin
      const goveePlugin = this.agent.apiManager.getPlugin('govee');
      if (!goveePlugin || !goveePlugin.commands) {
        logger.warn('Govee plugin not available for two-step detection');
        return { detected: false, intent: 'general', original: text };
      }

      // Build a focused prompt with only Govee commands
      let prompt = `You are a smart home intent classifier. Given a user query about Govee smart lights, select the best matching command from the numbered list below.

${conversationContext}User Query: "${text}"

Available Govee Commands:
`;
      
      let commandIndex = 1;
      const commandMap = {};
      
      for (const command of goveePlugin.commands) {
        commandMap[commandIndex] = command;
        prompt += `${commandIndex}. ${command.command} - ${command.description}\n`;
        if (command.examples && command.examples.length > 0) {
          prompt += `   Examples: ${command.examples.join(', ')}\n`;
        }
        commandIndex++;
      }
      
      prompt += `\nRespond with ONLY the number (1-${commandIndex-1}) that best matches the user's intent.

Decision Guide:
- For "turn on/off [device name]" or power control: choose power command
- For "toggle [device name]": choose power command (toggle is a power state)
- For "list devices" or "show lights": choose list command
- For brightness/dimming: choose brightness command
- For color changes (make it red, set to blue, change color): choose color command
- For color temperature (warm white, cool white, daylight, kelvin): choose temperature command
- For scenes: choose scene command
- For anything involving schedules, timers, "at [time]", "every day", recurring actions, "set up a schedule", "change/edit/delete schedule", "at night", "at midnight", "in the morning": choose schedules command
- If user references changing a SCHEDULED color/action (e.g., "instead of blue make it red at night"): choose schedules command`;

      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 10,
        temperature: 0.1
      });
      
      const commandNum = parseInt(response.content.trim());
      logger.info(`Govee two-step AI selected command: ${commandNum}`);
      
      if (isNaN(commandNum) || !commandMap[commandNum]) {
        logger.warn('Govee two-step AI returned invalid command number, falling back to list');
        return {
          detected: true,
          intent: 'govee_list',
          plugin: 'govee',
          action: 'list',
          parameters: {}
        };
      }
      
      const selectedCommand = commandMap[commandNum];
      
      // Extract parameters specific to the command
      const params = await this.extractGoveeParameters(selectedCommand.command, text);
      
      return {
        detected: true,
        intent: `govee_${selectedCommand.command}`,
        plugin: 'govee',
        action: selectedCommand.command,
        parameters: params
      };
      
    } catch (error) {
      logger.error('Govee two-step detection error:', error);
      return { detected: false, intent: 'general', original: text };
    }
  }

  /**
   * Extract parameters for specific Govee commands
   */
  async extractGoveeParameters(command, text) {
    const params = {};

    // All AI-detected params need the fromAI flag for device name resolution
    params.fromAI = true;

    switch (command) {
      case 'power': {
        // Extract state - handle toggle alongside on/off
        const toggleMatch = text.match(/\btoggle\b/i);
        if (toggleMatch) {
          params.state = 'toggle';
        } else {
          const stateMatch = text.match(/\b(on|off)\b/i);
          if (stateMatch) {
            params.state = stateMatch[1].toLowerCase();
          }
        }
        // Extract device name
        const powerDeviceMatch = text.match(/(?:turn (?:on|off)|toggle|power (?:on|off)|switch (?:on|off)) (?:the |my )?(.+?)(?:\s+(?:light|lights|lamp|device))?[?!.]*$/i);
        if (powerDeviceMatch && powerDeviceMatch[1]) {
          params.device = powerDeviceMatch[1].trim().replace(/[?!.]*$/, '').trim();
        }
        break;
      }

      case 'brightness': {
        const brightnessMatch = text.match(/(?:brightness|bright|dim).+?(\d+)/i) || text.match(/(\d+)\s*%/);
        if (brightnessMatch) {
          params.level = parseInt(brightnessMatch[1]);
        }
        // Extract device name: "set [device] brightness to X" or "dim the [device]"
        const brightDeviceMatch = text.match(/(?:set|make|adjust|change|dim|brighten) (?:the |my )?(.+?)(?:\s+(?:brightness|bright|to \d|light|lights))/i);
        if (brightDeviceMatch && brightDeviceMatch[1]) {
          params.device = brightDeviceMatch[1].trim().replace(/[?!.]*$/, '').trim();
        }
        break;
      }

      case 'color': {
        // Expanded color list matching all colors in govee-enhancements.js
        const colorNames = 'red|green|blue|white|black|yellow|cyan|magenta|purple|violet|orange|pink|brown|gray|grey|lime|indigo|turquoise|gold|silver';
        const colorModifiers = '(?:bright|dark|light|deep|pale|vivid|warm|cool|hot)\\s+';
        // Match color with optional modifier
        const fullColorRegex = new RegExp(`\\b((?:${colorModifiers})?(?:${colorNames}))\\b`, 'i');
        const colorMatch = text.match(fullColorRegex);
        if (colorMatch) {
          params.color = colorMatch[1].toLowerCase().trim();
        }
        // Extract device name: "make/set/turn [device] [color]" or "[device] to [color]"
        const colorDeviceMatch = text.match(/(?:set|make|turn|change) (?:the |my )?(.+?)(?:\s+(?:to\s+)?(?:bright|dark|light|deep|pale|vivid|warm|cool|hot\s+)?(?:red|green|blue|white|black|yellow|cyan|magenta|purple|violet|orange|pink|brown|gray|grey|lime|indigo|turquoise|gold|silver))/i);
        if (colorDeviceMatch && colorDeviceMatch[1]) {
          params.device = colorDeviceMatch[1].trim().replace(/\s+(?:color|light|lights)$/i, '').trim();
        }
        break;
      }

      case 'temperature': {
        // Extract kelvin value
        const kelvinMatch = text.match(/(\d{3,5})\s*k(?:elvin)?/i);
        if (kelvinMatch) {
          params.kelvin = parseInt(kelvinMatch[1]);
        } else {
          // Extract named temperatures (warm white, cool white, daylight, etc.)
          const tempMatch = text.match(/\b(warm(?:\s+white)?|cool(?:\s+white)?|cold(?:\s+white)?|daylight|neutral|candle(?:light)?|soft(?:\s+white)?)\b/i);
          if (tempMatch) {
            params.temperature = tempMatch[1].toLowerCase().trim();
          }
        }
        // Extract device name
        const tempDeviceMatch = text.match(/(?:set|make|change) (?:the |my )?(.+?)(?:\s+(?:to\s+)?(?:warm|cool|cold|daylight|neutral|candle|soft|\d{3,5}\s*k))/i);
        if (tempDeviceMatch && tempDeviceMatch[1]) {
          params.device = tempDeviceMatch[1].trim().replace(/\s+(?:light|lights|temperature|temp)$/i, '').trim();
        }
        break;
      }

      case 'scene': {
        const sceneMatch = text.match(/(?:scene|mode)\s+["']?(\w+)["']?/i) || text.match(/(?:apply|activate|use|set)\s+(?:the\s+)?["']?(\w+)["']?\s+(?:scene|mode)/i);
        if (sceneMatch) {
          params.scene = sceneMatch[1] || sceneMatch[2];
        }
        // Extract device name
        const sceneDeviceMatch = text.match(/(?:for|on|to) (?:the |my )?(.+?)(?:\s+(?:light|lights|device))?[?!.]*$/i);
        if (sceneDeviceMatch && sceneDeviceMatch[1]) {
          params.device = sceneDeviceMatch[1].trim().replace(/[?!.]*$/, '').trim();
        }
        break;
      }

      case 'schedules': {
        // Use AI to extract schedule parameters - too complex for regex
        const scheduleParams = await this.extractScheduleParametersWithAI(text);
        Object.assign(params, scheduleParams);
        break;
      }

      case 'toggle': {
        // Extract feature name (nightlight, oscillation, etc.)
        const featureMatch = text.match(/\b(nightlight|oscillation|air.?deflector)\b/i);
        if (featureMatch) {
          params.feature = featureMatch[1].toLowerCase().replace(/\s+/g, '');
        }
        // Extract device name
        const toggleDeviceMatch = text.match(/(?:toggle|enable|disable|activate) (?:the |my )?(?:\w+ )?(?:on |off )?(?:the |my )?(.+?)(?:\s+(?:light|lights|device|feature))?[?!.]*$/i);
        if (toggleDeviceMatch && toggleDeviceMatch[1]) {
          params.device = toggleDeviceMatch[1].trim().replace(/[?!.]*$/, '').trim();
        }
        break;
      }

      default:
        // For unhandled commands, don't extract - let the fallback AI handle it
        break;
    }

    return params;
  }

  /**
   * Extract schedule parameters using AI - handles complex natural language scheduling requests
   */
  async extractScheduleParametersWithAI(text) {
    const prompt = `Extract schedule parameters from this smart home device scheduling request.

User request: "${text}"

Extract a JSON object with these fields:
- "operation": one of "create", "update", "delete", or "list" (required)
- "device": the device name mentioned (e.g. "master toilet", "kitchen lights", "bedroom light") - extract the FULL name
- "time": the time in HH:MM 24-hour format (e.g., "19:00" for 7 PM, "00:00" for midnight, "21:00" for 9 PM)
- "deviceAction": what the device should do - one of "on", "off", "color", "brightness", "scene" (NOTE: field is called "deviceAction", NOT "action")
- "value": for color actions include the color name (e.g. "red"), for brightness include the number
- "repeat": one of "daily", "weekdays", "weekends", "once" (default to "daily" if recurring is implied or unclear)

Examples:
"set up a schedule for kitchen lights to turn on at 7 PM daily" -> {"operation":"create","device":"kitchen lights","time":"19:00","deviceAction":"on","repeat":"daily"}
"change my master toilet schedule to use red instead of blue" -> {"operation":"update","device":"master toilet","deviceAction":"color","value":"red"}
"turn off bedroom lights at midnight on weekdays" -> {"operation":"create","device":"bedroom lights","time":"00:00","deviceAction":"off","repeat":"weekdays"}
"delete the living room schedule" -> {"operation":"delete","device":"living room"}
"list my schedules" -> {"operation":"list"}
"edit the living room schedule to 8 PM instead of 7 PM" -> {"operation":"update","device":"living room","time":"20:00"}
"instead of blue I want my toilet light to be red at night" -> {"operation":"update","device":"master toilet","deviceAction":"color","value":"red"}
"schedule my toilet light to turn red at 9 PM" -> {"operation":"create","device":"toilet light","time":"21:00","deviceAction":"color","value":"red","repeat":"daily"}

Return ONLY a valid JSON object, nothing else.`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 200,
        temperature: 0.2
      });

      const cleanedResponse = response.content.trim()
        .replace(/^```json\s*/, '')
        .replace(/\s*```$/, '')
        .replace(/^```\s*/, '');

      const scheduleParams = JSON.parse(cleanedResponse);
      scheduleParams.fromAI = true;

      logger.info('AI extracted schedule parameters:', scheduleParams);
      return scheduleParams;
    } catch (error) {
      logger.error('Schedule parameter extraction failed:', error.message);
      return { operation: 'list', fromAI: true };
    }
  }

  // Code examination parameter extraction methods
  async extractCodeTopic(query) {
    const prompt = `Extract the code topic or feature being asked about from this query: "${query}"
    
Examples:
"how does your memory system work" -> topic: "memory"
"explain your plugin architecture" -> topic: "plugin"
"show me your code for handling tasks" -> topic: "task"
"how do you process telegram messages" -> topic: "telegram"

Respond with JSON: {"topic": "extracted_topic"}`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 50 });
      const parsed = JSON.parse(response.content.trim());
      return { topic: parsed.topic || query };
    } catch (error) {
      logger.error('Code topic extraction error:', error);
      return { topic: query };
    }
  }

  async extractFeatureName(query) {
    const prompt = `Extract the feature or system component being asked about from this query: "${query}"
    
Examples:
"what improvements would you make to your memory system" -> feature: "memory system"
"how would you improve the telegram interface" -> feature: "telegram interface"
"suggest enhancements for task management" -> feature: "task management"

Respond with JSON: {"feature": "extracted_feature"}`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 50 });
      const parsed = JSON.parse(response.content.trim());
      return { feature: parsed.feature || query };
    } catch (error) {
      logger.error('Feature extraction error:', error);
      return { feature: query };
    }
  }

  async extractFeatureSuggestion(query) {
    const prompt = `Extract the suggested feature from this query: "${query}"
    
Examples:
"could you add voice message support" -> suggestion: "voice message support"
"implement ability to schedule recurring system checks" -> suggestion: "schedule recurring system checks"
"add support for docker container monitoring" -> suggestion: "docker container monitoring"

Respond with JSON: {"suggestion": "extracted_suggestion"}`;

    try {
      const response = await this.agent.providerManager.generateResponse(prompt, { maxTokens: 100 });
      const parsed = JSON.parse(response.content.trim());
      return { suggestion: parsed.suggestion || query };
    } catch (error) {
      logger.error('Feature suggestion extraction error:', error);
      return { suggestion: query };
    }
  }

  async extractTaskParams(query) {
    try {
      // Extract title from common patterns
      let title = query;

      // Pattern: "todo: X" or "todo - X"
      const todoMatch = query.match(/^todo[:\s-]+\s*(.+)$/i);
      if (todoMatch) {
        title = todoMatch[1].trim();
      }

      // Pattern: "add task: X" or "create task: X"
      const taskMatch = query.match(/(?:add|create)\s+(?:task|todo)[:\s-]+\s*(.+)$/i);
      if (taskMatch) {
        title = taskMatch[1].trim();
      }

      // Pattern: "add to todo list: X"
      const todoListMatch = query.match(/add\s+to\s+(?:todo|task)\s+list[:\s-]+\s*(.+)$/i);
      if (todoListMatch) {
        title = todoListMatch[1].trim();
      }

      // Pattern: "add task X" (without colon)
      const simpleMatch = query.match(/(?:add|create)\s+(?:task|todo)\s+(?!list)(.+)$/i);
      if (simpleMatch && !title.startsWith(simpleMatch[1])) {
        title = simpleMatch[1].trim();
      }

      return { title };
    } catch (error) {
      logger.error('Task parameter extraction error:', error);
      return { title: query };
    }
  }

  async extractDockerParams(action, paramsString, fullQuery) {
    try {
      switch (action) {
        case 'ps':
        case 'list':
          return {
            all: paramsString.includes('-a') || fullQuery.includes('all'),
            format: 'table'
          };
          
        case 'images':
          return {
            format: 'table',
            filter: paramsString || undefined
          };
          
        case 'create':
          // Extract image name and other options
          const imageMatch = paramsString.match(/(\S+)(?:\s+(.*))?/);
          if (imageMatch) {
            const params = { image: imageMatch[1] };
            const options = imageMatch[2] || '';
            
            // Extract common options
            const nameMatch = options.match(/--name\s+(\S+)/);
            if (nameMatch) params.name = nameMatch[1];
            
            const portMatches = [...options.matchAll(/-p\s+(\S+)/g)];
            if (portMatches.length) params.ports = portMatches.map(m => m[1]);
            
            const volumeMatches = [...options.matchAll(/-v\s+(\S+)/g)];
            if (volumeMatches.length) params.volumes = volumeMatches.map(m => m[1]);
            
            return params;
          }
          return { image: paramsString || 'unknown' };
          
        case 'start':
        case 'stop':
        case 'restart':
        case 'remove':
          return { container: paramsString || '' };
          
        case 'logs':
          const logsMatch = paramsString.match(/(\S+)(?:\s+(.*))?/);
          return {
            container: logsMatch ? logsMatch[1] : '',
            lines: 100,
            follow: paramsString.includes('-f')
          };
          
        case 'exec':
          const execMatch = paramsString.match(/(\S+)\s+(.+)/);
          return {
            container: execMatch ? execMatch[1] : '',
            command: execMatch ? execMatch[2] : ''
          };
          
        case 'build':
          const buildMatch = paramsString.match(/(?:-t\s+(\S+)\s+)?(.+)?/);
          return {
            path: buildMatch && buildMatch[2] ? buildMatch[2] : '.',
            tag: buildMatch && buildMatch[1] ? buildMatch[1] : undefined
          };
          
        case 'pull':
        case 'push':
          return { image: paramsString || '' };
          
        case 'compose-up':
        case 'compose-down':
          return {
            detach: !paramsString.includes('--no-detach'),
            build: paramsString.includes('--build')
          };
          
        default:
          return {};
      }
    } catch (error) {
      logger.error('Docker parameter extraction error:', error);
      return {};
    }
  }

  async extractNetworkParams(action, query) {
    try {
      switch (action) {
        case 'scan':
          // Extract subnet if specified, otherwise use default
          const subnetMatch = query.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2})/);
          return { subnet: subnetMatch ? subnetMatch[1] : undefined };
          
        case 'ping':
          // Extract host/IP to ping
          const pingMatch = query.match(/ping\s+(\S+)|(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          return { 
            host: pingMatch ? (pingMatch[1] || pingMatch[2] || pingMatch[3]) : '8.8.8.8',
            count: query.match(/(\d+)\s*times?/) ? parseInt(query.match(/(\d+)\s*times?/)[1]) : 4
          };
          
        case 'port-scan':
          // Extract host and port specification
          const hostMatch = query.match(/(?:scan|check)\s+(?:ports?\s+on\s+)?(\S+)|(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          const ports = query.includes('all') ? 'all' : 'common';
          return {
            host: hostMatch ? (hostMatch[1] || hostMatch[2] || hostMatch[3]) : 'localhost',
            ports: ports
          };
          
        case 'traceroute':
          // Extract destination
          const traceMatch = query.match(/traceroute\s+(?:to\s+)?(\S+)|(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          return {
            host: traceMatch ? (traceMatch[1] || traceMatch[2] || traceMatch[3]) : '8.8.8.8',
            maxHops: 30
          };
          
        case 'dns-lookup':
          // Extract domain
          const domainMatch = query.match(/(?:lookup|dns|resolve)\s+(\S+)|([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          return {
            domain: domainMatch ? (domainMatch[1] || domainMatch[2]) : 'example.com',
            type: query.includes('MX') ? 'MX' : query.includes('TXT') ? 'TXT' : 'A'
          };
          
        case 'whois':
          // Extract domain
          const whoisMatch = query.match(/whois\s+(\S+)|([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          return {
            domain: whoisMatch ? (whoisMatch[1] || whoisMatch[2]) : 'example.com'
          };
          
        case 'speed-test':
          // Check if specific server mentioned
          const serverMatch = query.match(/server\s+(\S+)/);
          return {
            server: serverMatch ? serverMatch[1] : undefined
          };
          
        case 'connections':
          // Check filter type
          let filter = 'all';
          if (query.includes('listening')) filter = 'listening';
          else if (query.includes('established')) filter = 'established';
          return { filter };
          
        case 'interfaces':
          // No specific params needed
          return {};
          
        case 'monitor':
          // Extract monitoring type and duration
          const durationMatch = query.match(/(\d+)\s*(?:seconds?|minutes?)/);
          let duration = 60; // default 60 seconds
          if (durationMatch) {
            duration = parseInt(durationMatch[1]);
            if (query.includes('minute')) duration *= 60;
          }
          return {
            type: 'bandwidth',
            duration: duration
          };
          
        default:
          return { action };
      }
    } catch (error) {
      logger.error('Network parameter extraction error:', error);
      return {};
    }
  }

  // New extraction methods for added intents
  async extractVpnParams(query) {
    try {
      // Extract location from queries like "connect vpn to canada"
      const locationMatch = query.match(/(?:to|in|at)\s+(\w+)/i);
      if (locationMatch) {
        return { location: locationMatch[1] };
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  async extractContainerName(query) {
    try {
      // Extract container name from queries like "start container nginx"
      const nameMatch = query.match(/(?:container|docker)\s+(\S+)/i);
      if (nameMatch) {
        return { name: nameMatch[1] };
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  async extractPortScanParams(query) {
    try {
      // Extract host/IP from queries like "port scan 192.168.1.1"
      const ipMatch = query.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      const hostMatch = query.match(/(?:scan|on)\s+(\S+\.\S+)/i);

      if (ipMatch) {
        return { host: ipMatch[1] };
      } else if (hostMatch) {
        return { host: hostMatch[1] };
      }
      return { host: 'localhost' };
    } catch (error) {
      return {};
    }
  }

  async extractHostParam(query) {
    try {
      // Extract host/IP from queries like "ping google.com"
      const ipMatch = query.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      const hostMatch = query.match(/ping\s+(\S+)/i);
      
      if (ipMatch) {
        return { host: ipMatch[1] };
      } else if (hostMatch) {
        return { host: hostMatch[1] };
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  async extractVideoUrl(query) {
    try {
      // Extract URL from queries
      const urlMatch = query.match(/(https?:\/\/[^\s]+)/i);
      if (urlMatch) {
        return { url: urlMatch[1] };
      }
      // No URL found — extract as search query so ytdlp can search YouTube
      const searchQuery = query.replace(/^(download|get|find|save|grab|fetch)\s+(me\s+)?(the\s+)?(song|video|audio|mp3|mp4|music)\s*/i, '')
        .replace(/\s+(as|in)\s+(mp3|mp4|audio|video)$/i, '')
        .replace(/\s+from\s+youtube$/i, '')
        .trim();
      if (searchQuery && searchQuery.length > 2) {
        return { query: searchQuery };
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  async extractSearchQuery(query) {
    try {
      // Strip common prefixes to get the actual search query
      const searchQuery = query
        .replace(/^(search|find|look\s*up|look\s+for|search\s+for|search\s+youtube\s+for|find\s+me)\s+(a\s+)?(the\s+)?(song|video|music|music\s+video|track)?\s*(called|named|titled|by\s+the\s+name)?\s*/i, '')
        .replace(/\s+on\s+youtube$/i, '')
        .trim();
      return { query: searchQuery || query };
    } catch (error) {
      return { query };
    }
  }

  async extractLyricsParams(query) {
    try {
      // Try to extract "TITLE by ARTIST" pattern
      const byMatch = query.match(/(?:lyrics?\s+(?:for|to|of)\s+)?(.+?)\s+by\s+(.+)/i);
      if (byMatch) {
        const title = byMatch[1].replace(/^(the\s+)?(lyrics?\s+)?(for|to|of)\s+/i, '').replace(/["']/g, '').trim();
        const artist = byMatch[2].replace(/["']/g, '').trim();
        return { title, artist };
      }
      // Try "ARTIST - TITLE" pattern
      const dashMatch = query.match(/(?:lyrics?\s+(?:for|to|of)\s+)?(.+?)\s*[-–—]\s*(.+)/i);
      if (dashMatch) {
        return { artist: dashMatch[1].replace(/^(the\s+)?(lyrics?\s+)?(for|to|of)\s+/i, '').trim(), title: dashMatch[2].trim() };
      }
      // Fallback: use entire cleaned query as title
      const title = query.replace(/^(get|show|find|what\s+are)?\s*(me\s+)?(the\s+)?(lyrics?|words)\s*(for|to|of)?\s*/i, '').trim();
      return { title };
    } catch (error) {
      return {};
    }
  }

  async extractMediaParams(query) {
    try {
      const params = {};

      // Extract type for extraction operations (audio, video, frames)
      const typeMatch = query.match(/extract\s+(audio|video|frames?)/i);
      if (typeMatch) {
        params.type = typeMatch[1].replace(/s$/, ''); // normalize 'frames' to 'frame'
        if (params.type === 'frame') params.type = 'frames';
      } else if (query.match(/get\s+audio|audio\s+from|to\s+audio|to\s+mp3/i)) {
        params.type = 'audio';
      }

      // Extract input file from queries
      const fileMatch = query.match(/(?:from\s+|convert\s+)?([^\s]+\.(mp4|mp3|avi|mkv|mov|wav|flac|webm|ogg|m4a))/i);
      if (fileMatch) {
        params.input = fileMatch[1];
      }

      // Extract output format from queries like "convert to mp4" or "to mp3"
      const formatMatch = query.match(/to\s+(\w+)/i);
      if (formatMatch && !formatMatch[1].match(/^(audio|video|frames?)$/i)) {
        params.format = formatMatch[1];
        // Generate output filename if input is provided
        if (params.input) {
          const baseName = params.input.replace(/\.[^.]+$/, '');
          params.output = `${baseName}.${params.format}`;
        }
      }

      return params;
    } catch (error) {
      return {};
    }
  }

  async extractBackupParams(query) {
    try {
      // Extract backup type or name
      const nameMatch = query.match(/backup\s+(\w+)/i);
      if (nameMatch) {
        return { name: nameMatch[1] };
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  async extractSshParams(query) {
    try {
      // Extract host/IP from SSH queries
      const ipMatch = query.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      const hostMatch = query.match(/(?:to|ssh)\s+(\S+)/i);
      
      if (ipMatch) {
        return { host: ipMatch[1] };
      } else if (hostMatch) {
        return { host: hostMatch[1] };
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  async extractTextToSpeak(query) {
    try {
      // Extract text after "say" or "speak"
      const textMatch = query.match(/(?:say|speak)\s+(.+)/i);
      if (textMatch) {
        return { text: textMatch[1] };
      }
      return { text: query };
    } catch (error) {
      return { text: query };
    }
  }

  async extractSoftwareParams(query) {
    try {
      // Extract package name from queries like "update nginx"
      const packageMatch = query.match(/(?:update|upgrade)\s+(\S+)/i);
      if (packageMatch && packageMatch[1] !== 'all') {
        return { package: packageMatch[1] };
      }
      return {};
    } catch (error) {
      return {};
    }
  }

  async extractGitUrl(query) {
    try {
      // Extract git URL from clone queries
      const urlMatch = query.match(/(https?:\/\/[^\s]+)/i);
      const sshMatch = query.match(/(git@[^\s]+)/i);
      
      if (urlMatch) {
        return { url: urlMatch[1] };
      } else if (sshMatch) {
        return { url: sshMatch[1] };
      }
      return {};
    } catch (error) {
      return {};
    }
  }
  
  // Crypto parameter extraction methods
  async extractCryptoBalanceParams(query) {
    try {
      // Extract specific chain if mentioned
      const chainMatch = query.match(/\b(BTC|ETH|BSC|MATIC|bitcoin|ethereum|binance|polygon)\b/i);
      if (chainMatch) {
        return { chain: chainMatch[1].toUpperCase() };
      }
      return {};
    } catch (error) {
      return {};
    }
  }
  
  async extractSendCryptoParams(query) {
    try {
      // Extract amount, chain, and address
      const amountMatch = query.match(/(\d+\.?\d*)\s*(BTC|ETH|MATIC|BNB|XNO|NANO)?/i);
      const addressMatch = query.match(/\b(0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|nano_[13456789abcdefghijkmnopqrstuwxyz]{60})\b/);
      const toMatch = query.match(/to\s+(\S+)/i);
      
      const params = {};
      if (amountMatch) {
        params.amount = parseFloat(amountMatch[1]);
        if (amountMatch[2]) params.chain = amountMatch[2].toUpperCase();
      }
      if (addressMatch) {
        params.to = addressMatch[1];
      } else if (toMatch) {
        params.to = toMatch[1];
      }
      
      return params;
    } catch (error) {
      return {};
    }
  }
  
  async extractSignMessageParams(query) {
    try {
      // Extract message to sign
      const messageMatch = query.match(/sign\s+(?:message\s+)?(.+)/i);
      if (messageMatch) {
        return { message: messageMatch[1].trim() };
      }
      return {};
    } catch (error) {
      return {};
    }
  }
  
  async extractContractParams(query, action) {
    try {
      const addressMatch = query.match(/\b(0x[a-fA-F0-9]{40})\b/);
      const functionMatch = query.match(/(?:function|method)\s+(\w+)/i);
      const networkMatch = query.match(/(?:on|network)\s+(\w+)/i);
      
      const params = {};
      if (addressMatch) params.address = addressMatch[1];
      if (functionMatch) params.function = functionMatch[1];
      if (networkMatch) params.network = networkMatch[1].toLowerCase();
      
      // For write operations, extract arguments
      if (action === 'writeContract') {
        const argsMatch = query.match(/\(([^)]+)\)/);
        if (argsMatch) {
          params.args = argsMatch[1].split(',').map(arg => arg.trim());
        }
      }
      
      return params;
    } catch (error) {
      return {};
    }
  }
  
  async extractDeployParams(query) {
    try {
      const typeMatch = query.match(/\b(ERC20|ERC721|ERC1155|custom)\b/i);
      const nameMatch = query.match(/(?:name|called)\s+(\w+)/i);
      const symbolMatch = query.match(/(?:symbol)\s+(\w+)/i);
      const networkMatch = query.match(/(?:on|to)\s+(\w+)/i);
      
      const params = {};
      if (typeMatch) params.type = typeMatch[1].toUpperCase();
      if (nameMatch) params.name = nameMatch[1];
      if (symbolMatch) params.symbol = symbolMatch[1];
      if (networkMatch) params.network = networkMatch[1].toLowerCase();
      
      return params;
    } catch (error) {
      return {};
    }
  }
  
  async extractMonitorParams(query) {
    try {
      const addressMatch = query.match(/\b(0x[a-fA-F0-9]{40})\b/);
      const eventMatch = query.match(/(?:event|events)\s+(\w+)/i);
      const networkMatch = query.match(/(?:on|network)\s+(\w+)/i);
      
      const params = {};
      if (addressMatch) params.address = addressMatch[1];
      if (eventMatch) params.event = eventMatch[1];
      if (networkMatch) params.network = networkMatch[1].toLowerCase();
      
      return params;
    } catch (error) {
      return {};
    }
  }
  
  async extractProjectParams(query) {
    try {
      const nameMatch = query.match(/(?:project|called|named)\s+(\w+)/i);
      const templateMatch = query.match(/\b(basic|advanced|defi|nft)\b/i);
      
      const params = {};
      if (nameMatch) params.name = nameMatch[1];
      if (templateMatch) params.template = templateMatch[1].toLowerCase();
      
      return params;
    } catch (error) {
      return {};
    }
  }
  
  async extractPathParam(query) {
    try {
      const pathMatch = query.match(/(?:in|at|path)\s+([^\s]+)/i);
      if (pathMatch) {
        return { path: pathMatch[1] };
      }
      return {};
    } catch (error) {
      return {};
    }
  }
  
  async extractTokenParams(query, action) {
    try {
      const params = {};
      
      // Extract token identifier (address or symbol)
      const tokenAddressMatch = query.match(/\b(0x[a-fA-F0-9]{40})\b/);
      const tokenSymbolMatch = query.match(/\b(USDT|USDC|DAI|LINK|UNI|AAVE)\b/i);
      
      if (tokenAddressMatch) {
        params.token = tokenAddressMatch[1];
      } else if (tokenSymbolMatch) {
        params.token = tokenSymbolMatch[1].toUpperCase();
      }
      
      // Extract amount for transfers and approvals
      if (action === 'transferTokens' || action === 'approveTokens') {
        const amountMatch = query.match(/(\d+\.?\d*)/);
        if (amountMatch) params.amount = parseFloat(amountMatch[1]);
        
        const toMatch = query.match(/to\s+(0x[a-fA-F0-9]{40}|\S+)/i);
        if (toMatch) {
          params[action === 'transferTokens' ? 'to' : 'spender'] = toMatch[1];
        }
      }
      
      // Extract network
      const networkMatch = query.match(/(?:on|network)\s+(\w+)/i);
      if (networkMatch) params.network = networkMatch[1].toLowerCase();
      
      return params;
    } catch (error) {
      return {};
    }
  }
  
  async extractNetworkParam(query) {
    try {
      const networkMatch = query.match(/(?:to|network)\s+(\w+)/i);
      if (networkMatch) {
        return { network: networkMatch[1].toLowerCase() };
      }
      return {};
    } catch (error) {
      return {};
    }
  }
  
  async extractFaucetParams(query) {
    try {
      const networkMatch = query.match(/\b(goerli|sepolia|mumbai|testnet|mainnet)\b/i);
      if (networkMatch) {
        return { network: networkMatch[1].toLowerCase() };
      }
      return {};
    } catch (error) {
      return {};
    }
  }
  
  async extractGasParams(query) {
    try {
      const params = {};
      
      const toMatch = query.match(/to\s+(0x[a-fA-F0-9]{40})/i);
      const amountMatch = query.match(/(\d+\.?\d*)\s*(ETH|MATIC|BNB)?/i);
      const dataMatch = query.match(/data\s+(0x[a-fA-F0-9]+)/i);
      const networkMatch = query.match(/(?:on|network)\s+(\w+)/i);
      
      if (toMatch) params.to = toMatch[1];
      if (amountMatch) params.amount = parseFloat(amountMatch[1]);
      if (dataMatch) params.data = dataMatch[1];
      if (networkMatch) params.network = networkMatch[1].toLowerCase();
      
      return params;
    } catch (error) {
      return {};
    }
  }
  
  async extractHistoryParams(query) {
    try {
      const params = {};
      
      const addressMatch = query.match(/\b(0x[a-fA-F0-9]{40})\b/);
      const limitMatch = query.match(/(?:last|limit)\s+(\d+)/i);
      const networkMatch = query.match(/(?:on|network)\s+(\w+)/i);
      
      if (addressMatch) params.address = addressMatch[1];
      if (limitMatch) params.limit = parseInt(limitMatch[1]);
      if (networkMatch) params.network = networkMatch[1].toLowerCase();
      
      return params;
    } catch (error) {
      return {};
    }
  }

  /**
   * Debug method to list all available intents with detailed information
   * @returns {Object} Debug information about all intents
   */
  debugIntents() {
    const allIntents = this.getAllIntents();
    const intentIds = Object.keys(allIntents).map(id => parseInt(id)).sort((a, b) => a - b);
    
    const staticIntents = intentIds.filter(id => id < 1000);
    const dynamicIntents = intentIds.filter(id => id >= 1000);
    
    return {
      total: intentIds.length,
      staticCount: staticIntents.length,
      dynamicCount: dynamicIntents.length,
      intentIds,
      staticIntents: staticIntents.map(id => ({
        id,
        name: allIntents[id].name,
        plugin: allIntents[id].plugin,
        action: allIntents[id].action,
        description: allIntents[id].description
      })),
      dynamicIntents: dynamicIntents.map(id => ({
        id,
        name: allIntents[id].name,
        plugin: allIntents[id].plugin,
        action: allIntents[id].action,
        description: allIntents[id].description
      })),
      hasIntent209: !!allIntents[209],
      intent209: allIntents[209] || null,
      goveeIntents: intentIds
        .filter(id => allIntents[id].plugin === 'govee' || allIntents[id].name.toLowerCase().includes('govee'))
        .map(id => ({ id, ...allIntents[id] }))
    };
  }

  /**
   * Get the complete prompt that would be sent to AI for intent detection
   * @param {string} userQuery - The user query to analyze
   * @param {string} conversationContext - Optional conversation context
   * @returns {string} The complete prompt
   */
  getDebugPrompt(userQuery, conversationContext = '') {
    return this.buildIntentPrompt(userQuery, conversationContext);
  }
}

export default AIIntentDetector;
