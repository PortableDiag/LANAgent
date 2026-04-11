import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import emailService from '../../services/emailService.js';
import { readFileSync } from 'fs';

// Patterns to extract verification code from email body
// Applied to HTML-stripped text first, then raw HTML with tags stripped
const VERIFICATION_CODE_PATTERNS = [
  /verification code\s*(?:is)?[:\s]+([0-9]{4,8})/i,
  /your (?:verification )?code\s*(?:is)?[:\s]+([0-9]{4,8})/i,
  /code\s*(?:is)?[:\s]+([0-9]{4,8})/i,
];

// Strip HTML tags to get plain text for regex matching
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Read version from package.json
let pluginVersion = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  pluginVersion = pkg.version || '1.0.0';
} catch { /* fallback */ }


export default class DryAIPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'dry-ai';
    this.version = pluginVersion;
    this.description = 'Dry.AI integration for natural language data management';

    this.commands = [
      {
        command: 'autoAuth',
        description: 'Automatically register/login to Dry.AI, read verification email, and complete authentication',
        usage: 'autoAuth()',
        examples: [
          'log in to dry ai',
          'sign up for dry.ai',
          'register on dry ai',
          'register with dry ai',
          'did you register with dry.ai',
          'authenticate with dry.ai',
          'connect to dry ai',
          'are you connected to dry ai',
          'set up dry ai',
          'get dry ai working',
          'log me in to dry.ai',
          'sign me up for dry ai',
          'log in to dry',
          'connect to dry',
          'set up dry'
        ]
      },
      {
        command: 'register',
        description: 'Register or login to Dry.AI with email (manual step 1 - prefer autoAuth for full automated flow)',
        usage: 'register({ email: "user@example.com" })',
        examples: [
          'just send the dry ai registration email',
          'send dry.ai verification code',
          'send the dry registration email only',
          'just do the registration step for dry ai',
          'start the dry ai signup process manually',
          'send the dry ai login email'
        ]
      },
      {
        command: 'verify',
        description: 'Verify email with code from Dry.AI',
        usage: 'verify({ code: "123456", userId: "uid", email: "user@example.com" })',
        examples: [
          'verify my dry ai code',
          'enter dry.ai verification code',
          'confirm dry ai email',
          'submit the dry ai verification code',
          'use this code for dry ai login',
          'enter the dry verification number'
        ]
      },
      {
        command: 'createAppSpace',
        description: 'Create an AI-powered app space with custom types and interactive pages',
        usage: 'createAppSpace({ name: "Bug Tracker", prompt: "A bug tracker with bugs and releases" })',
        examples: [
          'build me a dog walking tracker on dry ai',
          'create an inventory app in dry.ai',
          'make a recipe collection app on dry ai',
          'build a bug tracker with dry.ai',
          'create a fitness tracking app',
          'make me an app on dry ai',
          'create a new app space in dry.ai',
          'build an app for tracking expenses',
          'build me an app on dry',
          'create a dry app'
        ]
      },
      {
        command: 'createItem',
        description: 'Create a new item in Dry.AI using natural language',
        usage: 'createItem({ query: "a new task called Fix login bug", folder: "folderId" })',
        examples: [
          'add an item to my dry ai folder',
          'save this note to dry.ai',
          'create a new task in dry ai',
          'add a link to dry ai',
          'save a note in dry ai',
          'add a new entry to dry.ai',
          'create a record in my dry ai space',
          'store this in dry ai',
          'add something to dry',
          'save this in dry'
        ]
      },
      {
        command: 'createType',
        description: 'Create a new custom type/schema in a Dry.AI space',
        usage: 'createType({ query: "Bug with fields: title, severity, status", folder: "spaceId" })',
        examples: [
          'create a bug type in dry ai',
          'add a recipe type to my dry.ai space',
          'make a new type for contacts',
          'add a type to my dry space',
          'define a new schema in dry ai',
          'create a custom type on dry',
          'add a new item type to my dry space',
          'set up a task type in dry ai',
          'make a new category type on dry'
        ]
      },
      {
        command: 'createSpace',
        description: 'Create a new smartspace in Dry.AI',
        usage: 'createSpace({ query: "A space for tracking my recipes" })',
        examples: [
          'create a new smartspace in dry ai',
          'make a new space on dry.ai',
          'set up a new dry ai workspace',
          'create a dry.ai space for my project',
          'make a space to organize my data',
          'create a dry space',
          'make a new dry space',
          'start a new space on dry for notes',
          'create a space called recipes on dry ai',
          'make me a new dry ai smartspace'
        ]
      },
      {
        command: 'createFolder',
        description: 'Create a new folder in a Dry.AI space',
        usage: 'createFolder({ query: "Meeting Notes", folder: "spaceId" })',
        examples: [
          'create a folder in my dry ai space',
          'add a subfolder to dry.ai',
          'make a new folder for project docs',
          'create a folder in dry',
          'add a new folder to my dry space',
          'make a subfolder in dry ai',
          'create a folder called archive in dry',
          'add a folder to the workout tracker on dry',
          'new folder in my dry ai space'
        ]
      },
      {
        command: 'importItems',
        description: 'Batch import multiple items into a Dry.AI folder',
        usage: 'importItems({ query: "Item 1, Item 2, Item 3", folder: "folderId" })',
        examples: [
          'import a bunch of items to dry ai',
          'batch add items to my dry.ai space',
          'add multiple entries to dry ai at once',
          'bulk import data into dry ai',
          'import these items to my dry space',
          'add a list of items to dry',
          'mass import to dry ai',
          'upload multiple records to dry'
        ]
      },
      {
        command: 'listSpaces',
        description: 'List all spaces/smartspaces in Dry.AI',
        usage: 'listSpaces()',
        examples: [
          'list my dry ai spaces',
          'show my dry.ai spaces',
          'what spaces do I have on dry ai',
          'show my dry ai smartspaces',
          'which tools from dry do you have',
          'what can I do on dry ai',
          'list the dry spaces',
          'show me my dry ai',
          'what dry ai spaces do I have',
          'list my dry spaces',
          'show my dry spaces',
          'what spaces do I have on dry',
          'give me a link to my dry ai space',
          'what is the url for my dry space',
          'send me the link to the workout tracker on dry',
          'link to my dry ai space',
          'can you share the dry space url',
          'give me the dry ai space link',
          'open my space on dry ai'
        ]
      },
      {
        command: 'search',
        description: 'Search your Dry.AI data across spaces',
        usage: 'search({ query: "what wines do I have?", folder: "spaceId" })',
        examples: [
          'search dry ai for project tasks',
          'ask dry ai about my recipes',
          'what do I have in dry ai',
          'find my notes about python',
          'query dry ai for recent items',
          'how many tasks do I have in dry ai',
          'look up something in dry.ai',
          'search my dry ai data',
          'find items in dry ai matching',
          'search dry for something',
          'find in dry'
        ]
      },
      {
        command: 'listItems',
        description: 'List items in a specific Dry.AI folder',
        usage: 'listItems({ folder: "folderId", query: "search term" })',
        examples: [
          'list everything in dry.ai folder',
          'find items in my dry ai folder',
          'show items in my dry ai space',
          'what items are in dry.ai',
          'list dry ai items',
          'show my dry items',
          'list the items in the memories space on dry',
          'what items are in the workout tracker on dry ai',
          'show me the entries in my dry space',
          'list the records in my dry ai folder',
          'what do I have in the test notes space on dry',
          'show items in that dry space',
          'list things in my dry ai space'
        ]
      },
      {
        command: 'getItem',
        description: 'Get details of a specific item from Dry.AI',
        usage: 'getItem({ itemId: "id" })',
        examples: [
          'get dry ai item details',
          'show me this dry.ai item',
          'retrieve item from dry ai',
          'open this dry ai entry',
          'view dry ai item info'
        ]
      },
      {
        command: 'updateItem',
        description: 'Update an item in Dry.AI using natural language',
        usage: 'updateItem({ itemId: "id", query: "change priority to high" })',
        examples: [
          'update my dry ai item',
          'change the dry.ai task to high priority',
          'modify item in dry ai',
          'edit dry ai entry',
          'rename dry ai item'
        ]
      },
      {
        command: 'updateItems',
        description: 'Bulk update items in a Dry.AI folder using natural language',
        usage: 'updateItems({ folder: "folderId", query: "mark all as completed" })',
        examples: [
          'update all items in my dry ai folder',
          'bulk edit dry.ai items',
          'change all tasks to done in dry ai',
          'mark everything as completed in dry',
          'update multiple items in dry ai',
          'batch update my dry items',
          'change all entries in my dry folder',
          'bulk modify dry ai records'
        ]
      },
      {
        command: 'updateType',
        description: 'Update a type/schema in Dry.AI',
        usage: 'updateType({ itemId: "typeId", query: "add a priority field" })',
        examples: [
          'update dry ai type',
          'add a field to my dry.ai type',
          'modify the bug type schema',
          'change the fields on my dry type',
          'edit the recipe type in dry ai',
          'update the schema for my dry space type',
          'add a new field to the task type on dry',
          'modify my dry ai type definition'
        ]
      },
      {
        command: 'updateSpace',
        description: 'Update a smartspace in Dry.AI',
        usage: 'updateSpace({ itemId: "spaceId", query: "rename to Project Tracker" })',
        examples: [
          'rename my dry ai space',
          'update dry.ai smartspace settings',
          'change space description in dry ai',
          'rename the workout tracker space on dry',
          'update my dry space name',
          'change the settings on my dry ai space',
          'edit the space details in dry',
          'modify my dry ai smartspace'
        ]
      },
      {
        command: 'updateFolder',
        description: 'Update a folder in Dry.AI',
        usage: 'updateFolder({ itemId: "folderId", query: "rename to Archive" })',
        examples: [
          'rename my dry ai folder',
          'update dry.ai folder settings',
          'change the name of my dry folder',
          'edit folder details in dry ai',
          'rename the archive folder on dry',
          'update my dry ai folder name',
          'modify folder settings in dry'
        ]
      },
      {
        command: 'shareItem',
        description: 'Share, invite, or grant access to a Dry.AI item or space with another user',
        usage: 'shareItem({ itemId: "id", query: "share with charles as admin" })',
        examples: [
          'share this dry ai item',
          'make my dry.ai item public',
          'share dry ai link',
          'invite someone to my dry ai space',
          'add a user to my dry.ai space',
          'give charles access to my dry ai',
          'invite charles to the workout tracker',
          'share my dry ai space with a friend',
          'grant admin access to dry ai space',
          'add a member to my dry.ai workspace',
          'invite user to dry.ai as editor',
          'share the workout tracker with charles',
          'invite someone to my dry space',
          'share my dry space',
          'add a user to dry',
          'give access to my dry space',
          'invite me to the cat tracker app on dry',
          'invite me to the app on dry as admin',
          'add me to the dry ai app space',
          'invite me to the dry app',
          'share the app space with me on dry',
          'invite me to that dry ai space'
        ]
      },
      {
        command: 'deleteItem',
        description: 'Delete an item, space, or app from Dry.AI',
        usage: 'deleteItem({ itemId: "id" })',
        examples: [
          'delete dry ai item',
          'remove this from dry.ai',
          'trash the dry ai entry',
          'delete this from dry ai',
          'remove a dry.ai record',
          'delete from dry',
          'delete the beer tracker app space',
          'delete my dry ai space',
          'remove the app space on dry',
          'delete the dry ai app',
          'delete a space on dry.ai',
          'delete the test notes space from dry',
          'remove the workout tracker space from dry',
          'delete that space from dry ai',
          'remove my space from dry'
        ]
      },
      {
        command: 'deleteByQuery',
        description: 'Delete Dry.AI items matching a search query',
        usage: 'deleteByQuery({ folder: "folderId", query: "completed tasks" })',
        examples: [
          'delete all completed tasks in dry ai',
          'remove old items from dry.ai folder',
          'clear out finished items in dry',
          'delete everything marked done in dry ai',
          'remove all archived entries from dry',
          'bulk delete items matching a query in dry ai',
          'clean up old records in my dry space'
        ]
      },
      {
        command: 'help',
        description: 'Get help and documentation about Dry.AI features',
        usage: 'help({ query: "how do I create a type?" })',
        examples: [
          'how does dry ai work',
          'dry.ai help',
          'what can dry ai do',
          'help me with dry ai features',
          'dry help',
          'how does dry work'
        ]
      },
      {
        command: 'prompt',
        description: 'Run a multi-intent natural language prompt against Dry.AI data',
        usage: 'prompt({ query: "summarize my tasks and show overdue ones", folder: "folderId" })',
        examples: [
          'ask dry ai to summarize my data',
          'run a prompt on my dry.ai space',
          'analyze my dry ai items',
          'ask dry to summarize',
          'run a query against my dry ai data',
          'prompt dry ai about my tasks',
          'ask dry to analyze my workout data',
          'tell dry ai to process my items',
          'run this prompt on my dry space'
        ]
      },
      {
        command: 'report',
        description: 'Generate a structured report from Dry.AI data',
        usage: 'report({ query: "weekly progress report", folder: "folderId" })',
        examples: [
          'generate a report from dry ai',
          'create a dry.ai summary report',
          'dry ai status report',
          'generate a dry report',
          'make a weekly report from dry ai',
          'create a progress report from dry',
          'give me a report on my dry ai data',
          'dry ai report on my workout progress',
          'summarize my dry data into a report'
        ]
      },
      {
        command: 'status',
        description: 'Check Dry.AI authentication status',
        usage: 'status()',
        examples: [
          'am I logged in to dry ai',
          'dry.ai connection status',
          'check dry ai auth',
          'am I connected to dry',
          'dry status'
        ]
      },
      {
        command: 'setToken',
        description: 'Manually set Dry.AI MCP token',
        usage: 'setToken({ token: "mcp_..." })',
        examples: [
          'set dry ai token',
          'configure dry.ai api key',
          'save my dry ai mcp token',
          'use this token for dry ai',
          'set the dry api token'
        ]
      },
      {
        command: 'clearToken',
        description: 'Remove stored Dry.AI credentials',
        usage: 'clearToken()',
        examples: [
          'log out of dry ai',
          'clear dry.ai credentials',
          'disconnect from dry ai',
          'remove my dry ai login',
          'sign out of dry',
          'forget my dry ai token',
          'log out of dry'
        ]
      },
      {
        command: 'setOwnerEmail',
        description: 'Set the owner\'s email so they get auto-invited as admin when the agent creates spaces on Dry.AI',
        usage: 'setOwnerEmail({ email: "user@example.com" })',
        examples: [
          'set my dry ai email',
          'my dry.ai email is',
          'invite me to dry ai spaces',
          'add me to dry ai as admin',
          'set dry ai owner email',
          'remember my dry email'
        ]
      },
      {
        command: 'uploadFile',
        description: 'Upload a file to Dry.AI',
        usage: 'uploadFile({ filename: "report.pdf", content: "<base64>", mimeType: "application/pdf", spaceId: "id" })',
        examples: [
          'upload a file to dry ai',
          'send this file to dry.ai',
          'attach a file to my dry ai space',
          'upload to dry',
          'send file to dry'
        ]
      },
      {
        command: 'regeneratePage',
        description: 'Regenerate an app page in Dry.AI from scratch using AI',
        usage: 'regeneratePage({ objectId: "pageId", spaceId: "spaceId" })',
        examples: [
          'regenerate my dry ai app page',
          'rebuild the dry.ai page',
          'refresh the app page in dry ai',
          'regenerate the dry page',
          'rebuild my dry app page'
        ]
      },
      {
        command: 'modifyPage',
        description: 'Make a specific edit to a Dry.AI app page using natural language',
        usage: 'modifyPage({ objectId: "pageId", spaceId: "spaceId", query: "add a search bar" })',
        examples: [
          'change my dry ai app page',
          'edit the dry.ai page layout',
          'modify the app page in dry ai',
          'update the dry page design',
          'add a search bar to my dry app page',
          'change the header on my dry page',
          'edit my dry app page'
        ]
      }
    ];

    this.config = {
      baseUrl: 'https://dry.ai'
    };

    this.mcpToken = null;
    this.authEmail = null;
    this.authUserId = null;
    this.ownerEmail = null;  // User's email — auto-invited as admin on space creation
  }

  async initialize() {
    try {
      await this._loadToken();
      if (this.mcpToken) {
        this.logger.info('Dry.AI plugin initialized with stored token');
      } else {
        this.logger.info('Dry.AI plugin initialized (no token configured)');
      }
    } catch (error) {
      this.logger.warn('Dry.AI plugin initialization warning:', error.message);
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: [
          'autoAuth', 'register', 'verify', 'status', 'setToken', 'clearToken', 'setOwnerEmail',
          'createAppSpace', 'createItem', 'createType', 'createSpace', 'createFolder', 'importItems',
          'getItem', 'listSpaces', 'search', 'listItems', 'help', 'prompt', 'report',
          'updateItem', 'updateItems', 'updateType', 'updateSpace', 'updateFolder', 'shareItem',
          'deleteItem', 'deleteByQuery',
          'uploadFile', 'regeneratePage', 'modifyPage'
        ]
      }
    });

    switch (action) {
      // Auth
      case 'autoAuth':    return await this.handleAutoAuth(data);
      case 'register':    return await this.handleRegister(data);
      case 'verify':      return await this.handleVerify(data);
      case 'status':      return await this.handleStatus();
      case 'setToken':    return await this.handleSetToken(data);
      case 'clearToken':  return await this.handleClearToken();
      case 'setOwnerEmail': return await this.handleSetOwnerEmail(data);

      // CRUD (all require auth)
      case 'createAppSpace': return await this.handleCreateAppSpace(data);
      case 'createItem':  return await this.handleCreateItem(data);
      case 'createType':  return await this.handleCreateType(data);
      case 'createSpace': return await this.handleCreateSpace(data);
      case 'createFolder': return await this.handleCreateFolder(data);
      case 'importItems': return await this.handleImportItems(data);
      case 'getItem':     return await this.handleGetItem(data);
      case 'listSpaces':  return await this.handleListSpaces();
      case 'search':      return await this.handleSearch(data);
      case 'listItems':   return await this.handleListItems(data);
      case 'help':        return await this.handleHelp(data);
      case 'prompt':      return await this.handlePrompt(data);
      case 'report':      return await this.handleReport(data);
      case 'updateItem':  return await this.handleUpdateItem(data);
      case 'updateItems': return await this.handleUpdateItems(data);
      case 'updateType':  return await this.handleUpdateType(data);
      case 'updateSpace': return await this.handleUpdateSpace(data);
      case 'updateFolder': return await this.handleUpdateFolder(data);
      case 'shareItem':   return await this.handleShareItem(data);
      case 'deleteItem':  return await this.handleDeleteItem(data);
      case 'deleteByQuery': return await this.handleDeleteByQuery(data);
      case 'uploadFile':    return await this.handleUploadFile(data);
      case 'regeneratePage': return await this.handleRegeneratePage(data);
      case 'modifyPage':    return await this.handleModifyPage(data);

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // ─── Auth Handlers ───────────────────────────────────────────────

  async handleAutoAuth(data) {
    // If already authenticated, just return status
    if (this.mcpToken) {
      return {
        success: true,
        alreadyAuthenticated: true,
        email: this.authEmail,
        message: `Already authenticated as ${this.authEmail || 'unknown'}`
      };
    }

    const email = data.email || process.env.EMAIL_USER || process.env.GMAIL_USER;
    if (!email || !email.includes('@')) {
      throw new Error('No agent email configured. Set EMAIL_USER env var or pass email parameter.');
    }

    this.logger.info(`[autoAuth] Starting automated Dry.AI authentication for ${email}`);

    // Record time before register so we only look at emails arriving after this point
    const registerTime = new Date();

    // Step 1: Register/login
    const registerResult = await this._apiRequest('POST', '/api/crud-gpt/register-user', { email });
    if (!registerResult.success) {
      return {
        success: false,
        step: 'register',
        error: registerResult.error || 'Registration request failed'
      };
    }

    const userId = registerResult.data?.userId;
    const isExisting = registerResult.data?.isExistingUser;
    this.logger.info(`[autoAuth] ${isExisting ? 'Login' : 'Registration'} initiated, userId: ${userId}. Waiting for verification email...`);

    // Step 2: Poll for verification email (try up to 6 times, 10s apart = ~60s max)
    let verificationData = null;
    const maxAttempts = 6;
    const pollInterval = 10000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Wait before checking (give email time to arrive)
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      this.logger.info(`[autoAuth] Checking for verification email (attempt ${attempt}/${maxAttempts})...`);

      try {
        const emailPlugin = this.agent.apiManager?.getPlugin('email');
        if (!emailPlugin) {
          this.logger.warn('[autoAuth] Email plugin not available');
          continue;
        }

        // Use searchEmails with FROM filter — IMAP-level filtering, returns headers including subject
        // The subject line contains the code: "Verify Your Dry.ai Email - Code: 380012"
        const searchResult = await emailPlugin.execute({
          action: 'searchEmails',
          from: 'unitarylabs.com',
          limit: 5
        });

        const emails = searchResult?.emails || [];
        this.logger.info(`[autoAuth] Search returned ${emails.length} emails from unitarylabs`);

        for (const emailMsg of emails) {
          // Skip emails from before we sent the register request
          if (emailMsg.date && new Date(emailMsg.date) < registerTime) {
            this.logger.debug(`[autoAuth] Skipping old email from ${emailMsg.date}`);
            continue;
          }

          const subject = emailMsg.subject || '';
          this.logger.info(`[autoAuth] Checking email subject: "${subject}"`);

          // Extract code from subject line: "Verify Your Dry.ai Email - Code: 380012"
          const subjectMatch = subject.match(/Code[:\s]+([0-9]{4,8})/i);
          if (subjectMatch?.[1]) {
            verificationData = { code: subjectMatch[1] };
            this.logger.info(`[autoAuth] Found verification code in subject: ${verificationData.code}`);
            break;
          }
        }

        if (verificationData?.code) break;
      } catch (err) {
        this.logger.warn(`[autoAuth] Email check attempt ${attempt} failed: ${err.message}`);
      }
    }

    if (!verificationData?.code) {
      return {
        success: false,
        step: 'email',
        userId,
        email,
        message: `Could not find verification code in email after ${maxAttempts} attempts. You can complete manually: verify({ code: "CODE", userId: "${userId}", email: "${email}" })`
      };
    }

    // Step 3: Verify with the code
    const verifyResult = await this._apiRequest('POST', '/api/crud-gpt/verify-email', {
      code: verificationData.code,
      userId,
      email
    });

    if (!verifyResult.success || !verifyResult.data) {
      return {
        success: false,
        step: 'verify',
        error: verifyResult.error || 'Verification request failed',
        code: verificationData.code,
        userId,
        email
      };
    }

    const token = verifyResult.data.mcpToken;
    if (!token) {
      return {
        success: false,
        step: 'verify',
        error: 'Verification succeeded but no MCP token received',
        verifyResponse: verifyResult.data
      };
    }

    // Step 4: Save token
    await this._saveToken(token, email, userId);
    this.logger.info(`[autoAuth] Authentication complete. Token saved for ${email}`);

    let message = `Successfully authenticated as ${email}. All Dry.AI operations are now available.`;
    if (!this.ownerEmail) {
      message += '\n\nNote: This is the agent\'s Dry.AI account, not yours. To get auto-invited as admin when I create spaces, tell me your email: "set my dry ai email to you@example.com"';
    } else {
      message += `\n\nOwner email: ${this.ownerEmail} — you will be auto-invited as admin to any spaces I create.`;
    }

    return {
      success: true,
      email,
      userId,
      isExistingUser: isExisting,
      ownerEmail: this.ownerEmail || null,
      message
    };
  }

  async handleRegister(data) {
    const email = data.email || process.env.EMAIL_USER || process.env.GMAIL_USER;
    if (!email || !email.includes('@')) {
      throw new Error('A valid email address is required. Set EMAIL_USER env var or pass email parameter.');
    }

    this.logger.info(`Registering/logging in to Dry.AI with: ${email}`);

    const result = await this._apiRequest('POST', '/api/crud-gpt/register-user', { email });

    if (result.success) {
      const responseData = result.data;
      const isExisting = responseData.isExistingUser;
      this.logger.info(`Dry.AI ${isExisting ? 'login' : 'registration'} initiated for ${email}`);

      return {
        success: true,
        userId: responseData.userId,
        isExistingUser: isExisting,
        message: responseData.message || `Verification code sent to ${email}. Use the 'verify' action with your code, userId, and email.`
      };
    }

    return result;
  }

  async handleVerify(data) {
    const { code, userId, email } = data;
    if (!code) throw new Error('Verification code is required');
    if (!userId) throw new Error('userId is required (from the register response)');
    if (!email) throw new Error('Email address is required');

    this.logger.info(`Verifying Dry.AI email code for ${email}`);

    const result = await this._apiRequest('POST', '/api/crud-gpt/verify-email', { code, userId, email });

    if (result.success && result.data) {
      const responseData = result.data;
      const token = responseData.mcpToken;

      if (token) {
        await this._saveToken(token, email, userId);
        this.logger.info('Dry.AI authentication successful, token saved');

        return {
          success: true,
          verified: true,
          mcpToken: token.substring(0, 8) + '...' + token.substring(token.length - 4),
          message: 'Authentication successful. You can now use all Dry.AI CRUD operations.'
        };
      }

      return {
        success: true,
        verified: responseData.verified,
        message: responseData.message || 'Verification processed but no token received.'
      };
    }

    return result;
  }

  async handleStatus() {
    let message = this.mcpToken
      ? `Authenticated as ${this.authEmail || 'unknown'} (agent account)`
      : 'Not authenticated. Use register/verify or setToken to connect.';
    if (this.mcpToken && this.ownerEmail) {
      message += `. Owner: ${this.ownerEmail} (auto-invited on space creation)`;
    } else if (this.mcpToken && !this.ownerEmail) {
      message += '. No owner email set — use "set my dry ai email" so you get invited to spaces I create.';
    }
    return {
      success: true,
      authenticated: !!this.mcpToken,
      email: this.authEmail || null,
      ownerEmail: this.ownerEmail || null,
      userId: this.authUserId || null,
      baseUrl: this.config.baseUrl,
      tokenStored: !!this.mcpToken,
      message
    };
  }

  async handleSetToken(data) {
    const { token } = data;
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('A non-empty token string is required');
    }

    await this._saveToken(token.trim(), data.email || null, data.userId || null);
    this.logger.info('Dry.AI MCP token manually set');

    return {
      success: true,
      message: 'Token saved successfully'
    };
  }

  async handleClearToken() {
    this.mcpToken = null;
    this.authEmail = null;
    this.authUserId = null;
    await PluginSettings.setCached(this.name, 'mcpToken', null);
    this.logger.info('Dry.AI credentials cleared');

    return {
      success: true,
      message: 'Dry.AI credentials cleared. You will need to re-authenticate.'
    };
  }

  async handleSetOwnerEmail(data) {
    const email = data.email || data.query || data.originalInput;
    if (!email || !email.includes('@')) {
      throw new Error('A valid email address is required. Example: setOwnerEmail({ email: "you@example.com" })');
    }
    const cleaned = email.trim().toLowerCase();
    this.ownerEmail = cleaned;
    await PluginSettings.setCached(this.name, 'ownerEmail', cleaned);
    this.logger.info(`Dry.AI owner email set: ${cleaned}`);

    return {
      success: true,
      message: `Owner email set to ${cleaned}. You will now be auto-invited as admin when I create spaces or app spaces on Dry.AI.`
    };
  }

  /**
   * Auto-invite the owner as admin to a newly created space/appspace.
   * Called after successful createAppSpace or createSpace.
   * Fails silently — should not block the create response.
   */
  async _autoInviteOwner(spaceId, spaceName) {
    if (!this.ownerEmail || !spaceId) return null;

    try {
      this.logger.info(`Auto-inviting ${this.ownerEmail} as admin to "${spaceName}" (${spaceId})`);
      const result = await this._apiRequest('PUT', '/api/custom-gpt/share_item', {
        item: spaceId,
        query: `invite ${this.ownerEmail} as admin`
      });
      this.logger.info(`Auto-invite API response for "${spaceName}": ${JSON.stringify(result).substring(0, 500)}`);
      // Dry server sometimes returns success:true with data.error — check both
      const serverError = result.data?.error;
      if (result.success && !serverError) {
        this.logger.info(`Owner ${this.ownerEmail} invited as admin to "${spaceName}"`);
      } else {
        const errMsg = serverError || result.error || JSON.stringify(result);
        this.logger.warn(`Auto-invite failed for "${spaceName}": ${errMsg}`);
        // Retry once after additional delay
        this.logger.info(`Retrying invite for "${spaceName}" after 15s...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
        const retry = await this._apiRequest('PUT', '/api/custom-gpt/share_item', {
          item: spaceId,
          query: `invite ${this.ownerEmail} as admin`
        });
        this.logger.info(`Auto-invite retry response for "${spaceName}": ${JSON.stringify(retry).substring(0, 500)}`);
        if (retry.success && !retry.data?.error) {
          this.logger.info(`Owner ${this.ownerEmail} invited as admin to "${spaceName}" (retry succeeded)`);
          return retry;
        } else {
          this.logger.warn(`Auto-invite retry also failed for "${spaceName}": ${retry.data?.error || retry.error || 'unknown'}`);
        }
      }
      return result;
    } catch (err) {
      this.logger.warn(`Auto-invite error for "${spaceName}": ${err.message}`);
      return null;
    }
  }

  // ─── CRUD Handlers ───────────────────────────────────────────────

  async handleCreateAppSpace(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const name = data.name || data.type || data.title || data.query;
    // Fall back to original user input if no name extracted
    const originalInput = data.originalInput || data._context?.originalInput;
    const prompt = data.prompt || data.description || originalInput || (name ? `Create an app for ${name}` : null);

    if (!name && !prompt) {
      return {
        success: false,
        message: 'What should the app be called? Give me a name or describe what it should do.\nExample: "Create a Fitness Tracker app on Dry.AI"'
      };
    }

    this.logger.info(`Creating Dry.AI app space: ${name || prompt}`);

    const result = await this._apiRequest('POST', '/api/custom-gpt/create_app_space',
      { name: name || prompt, prompt: prompt || `Create an app for ${name}` },
      {}, { maxRetries: 1, retryDelayMs: 5000 }
    );

    if (result.success) {
      const responseData = result.data;
      const space = responseData.items && responseData.items.length > 0 ? responseData.items[0] : null;
      const response = {
        success: true,
        message: responseData.message || `App space "${name}" created successfully.`,
        space: space ? { name: space.Name, id: space.ID, url: space.URL } : null
      };

      // Auto-invite owner as admin
      // App spaces generate pages async — delay invite so the space is fully initialized
      if (space?.ID && this.ownerEmail) {
        this.logger.info(`Waiting 15s for app space "${space.Name || name}" to finish generating before invite...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
        const inviteResult = await this._autoInviteOwner(space.ID, space.Name || name);
        if (inviteResult?.success) {
          response.message += ` ${this.ownerEmail} has been invited as admin.`;
          response.ownerInvited = true;
        }
      } else if (!this.ownerEmail) {
        response.note = 'This was created under the agent\'s Dry.AI account. To get access, tell me your email with: "set my dry ai email to you@example.com"';
      }

      return response;
    }
    return result;
  }

  async handleCreateItem(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    // If there's an attached file, delegate to uploadFile handler
    if (data._context?.attachedFile) {
      this.logger.info('createItem has attached file — delegating to uploadFile');
      return await this.handleUploadFile(data);
    }

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: 'Please provide more details about what you want to do.' }; }

    const folder = data.folder;
    const body = { query };
    if (folder) body.folder = folder;

    this.logger.info(`Creating Dry.AI item: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('POST', '/api/custom-gpt/create_item', body);

    if (result.success) {
      return {
        success: true,
        message: result.data?.message || 'Item created successfully',
        items: result.data?.items,
        data: result.data
      };
    }
    return result;
  }

  async handleCreateType(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: 'Please provide more details about what you want to do.' }; }

    const folder = data.folder;
    const body = { query, forceCreate: data.forceCreate || false };
    if (folder) body.folder = folder;

    this.logger.info(`Creating Dry.AI type: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('POST', '/api/custom-gpt/create_type', body);

    if (result.success) {
      return {
        success: true,
        message: result.data?.message || 'Type created successfully',
        items: result.data?.items,
        data: result.data
      };
    }
    return result;
  }

  async handleCreateSpace(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.name || data.originalInput || data._context?.originalInput;
    if (!query) {
      return { success: false, message: 'What should the space be called? Give me a name or description.' };
    }

    this.logger.info(`Creating Dry.AI smartspace: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('POST', '/api/custom-gpt/create_smartspace', { query });

    if (result.success) {
      const items = result.data?.items || [];
      const space = items.length > 0 ? items[0] : null;
      const spaceId = space?.ID || space?.id;
      const spaceName = space?.Name || space?.name || query;

      const response = {
        success: true,
        message: result.data?.message || 'Space created successfully',
        items,
        data: result.data
      };

      // Auto-invite owner as admin
      if (spaceId && this.ownerEmail) {
        const inviteResult = await this._autoInviteOwner(spaceId, spaceName);
        if (inviteResult?.success) {
          response.message += ` ${this.ownerEmail} has been invited as admin.`;
          response.ownerInvited = true;
        }
      } else if (!this.ownerEmail) {
        response.note = 'This was created under the agent\'s Dry.AI account. To get access, tell me your email with: "set my dry ai email to you@example.com"';
      }

      return response;
    }
    return result;
  }

  async handleCreateFolder(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.name || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: 'Please provide more details about what you want to do.' }; }

    const folder = data.folder;
    const body = { query, forceCreate: data.forceCreate || false };
    if (folder) body.folder = folder;

    this.logger.info(`Creating Dry.AI folder: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('POST', '/api/custom-gpt/create_folder', body);

    if (result.success) {
      return {
        success: true,
        message: result.data?.message || 'Folder created successfully',
        items: result.data?.items,
        data: result.data
      };
    }
    return result;
  }

  async handleImportItems(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: 'Please provide more details about what you want to do.' }; }

    const folder = data.folder;
    const body = { query };
    if (folder) body.folder = folder;

    this.logger.info(`Importing items to Dry.AI: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('POST', '/api/custom-gpt/import_items', body);

    if (result.success) {
      return {
        success: true,
        message: result.data?.message || 'Items imported successfully',
        items: result.data?.items,
        data: result.data
      };
    }
    return result;
  }

  async handleGetItem(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const itemId = data.itemId || data.item;
    if (!itemId) { return { success: false, message: 'Please specify which item by name or ID.' }; }

    this.logger.info(`Getting Dry.AI item: ${itemId}`);
    const result = await this._apiRequest('GET', '/api/custom-gpt/details', null, { item: itemId });

    if (result.success) {
      const item = result.data?.item || result.data;
      return {
        success: true,
        message: this._formatItem(item),
        item: result.data
      };
    }
    return result;
  }

  async handleListSpaces() {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    this.logger.info('Listing Dry.AI spaces');
    const result = await this._apiRequest('GET', '/api/custom-gpt/get_all_smartspaces');

    if (result.success) {
      return {
        success: true,
        message: this._formatSpaces(result.data),
        spaces: result.data
      };
    }
    return result;
  }

  async handleSearch(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: "Please provide more details about what you want to do." }; }

    const folder = data.folder;
    const queryParams = { query };
    if (folder) queryParams.folder = folder;

    this.logger.info(`Searching Dry.AI: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('GET', '/api/custom-gpt/search_smartspace', null, queryParams);

    if (result.success) {
      return {
        success: true,
        message: this._formatSearchResults(result.data, query),
        results: result.data,
        data: result.data
      };
    }
    return result;
  }

  async handleListItems(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    let { folder, query, space } = data;
    const originalInput = data._context?.originalInput || data.originalInput || query || '';
    let resolvedName = '';

    // If no folder ID, try to resolve a space name from the input
    if (!folder) {
      const resolved = await this._resolveSpaceFromInput(space || originalInput);
      if (resolved) {
        folder = resolved.id;
        resolvedName = resolved.name;
        this.logger.info(`listItems: resolved space "${resolved.name}" → folder ${folder}`);
      }
    }

    const queryParams = {};
    if (folder) queryParams.folder = folder;
    // Don't pass the raw user input as query — it confuses the API into returning spaces
    // Only pass query if it looks like an actual search term (not the full NL command)
    if (query && query !== originalInput) queryParams.query = query;

    this.logger.info(`Listing Dry.AI items${folder ? ` in folder ${folder}` : ''}${queryParams.query ? ` matching "${queryParams.query}"` : ''}`);
    const result = await this._apiRequest('GET', '/api/crud-gpt/items', null, queryParams);

    if (result.success) {
      return {
        success: true,
        message: this._formatItemsList(result.data, resolvedName || space),
        items: result.data
      };
    }
    return result;
  }

  async handleHelp(data) {
    const query = data.query || data.originalInput || 'What is Dry.AI?';

    this.logger.info(`Dry.AI help: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('GET', '/api/custom-gpt/dry_help', null, { query });

    if (result.success) {
      return {
        success: true,
        message: this._formatHelpResults(result.data),
        data: result.data
      };
    }
    return result;
  }

  async handlePrompt(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: "Please provide more details about what you want to do." }; }

    const folder = data.folder;
    const body = { query };
    if (folder) body.folder = folder;

    this.logger.info(`Dry.AI prompt: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('POST', '/api/crud-gpt/prompt', body);

    if (result.success) {
      return {
        success: true,
        message: this._formatSearchResults(result.data, query),
        data: result.data
      };
    }
    return result;
  }

  async handleReport(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: "Please provide more details about what you want to do." }; }

    const folder = data.folder;
    const body = { query };
    if (folder) body.folder = folder;

    this.logger.info(`Dry.AI report: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('POST', '/api/crud-gpt/report', body);

    if (result.success) {
      return {
        success: true,
        message: this._formatSearchResults(result.data, query),
        data: result.data
      };
    }
    return result;
  }

  async handleUpdateItem(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: 'Please provide more details about what you want to do.' }; }

    const itemId = data.itemId || data.item;
    if (!itemId) { return { success: false, message: 'Please specify which item by name or ID.' }; }

    this.logger.info(`Updating Dry.AI item ${itemId}: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('PUT', '/api/custom-gpt/update_item', { item: itemId, query });

    if (result.success) {
      return {
        success: true,
        message: 'Item updated successfully',
        data: result.data
      };
    }
    return result;
  }

  async handleUpdateType(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: "Please provide more details about what you want to do." }; }

    const itemId = data.itemId || data.item;
    if (!itemId) { return { success: false, message: 'Please specify which item by name or ID.' }; }

    this.logger.info(`Updating Dry.AI type ${itemId}: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('PUT', '/api/custom-gpt/update_type', { item: itemId, query });

    if (result.success) {
      return {
        success: true,
        message: 'Type updated successfully',
        data: result.data
      };
    }
    return result;
  }

  async handleUpdateSpace(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: "Please provide more details about what you want to do." }; }

    const itemId = data.itemId || data.item;
    if (!itemId) { return { success: false, message: 'Please specify which item by name or ID.' }; }

    this.logger.info(`Updating Dry.AI space ${itemId}: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('PUT', '/api/custom-gpt/update_smartspace', { item: itemId, query });

    if (result.success) {
      return {
        success: true,
        message: 'Space updated successfully',
        data: result.data
      };
    }
    return result;
  }

  async handleUpdateItems(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: "Please provide more details about what you want to do." }; }

    const folder = data.folder;
    if (!folder) { return { success: false, message: 'Please specify which folder or space.' }; }

    this.logger.info(`Bulk updating Dry.AI items in ${folder}: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('PUT', '/api/custom-gpt/update_items', { folder, query });

    if (result.success) {
      return {
        success: true,
        message: 'Items updated successfully',
        data: result.data
      };
    }
    return result;
  }

  async handleUpdateFolder(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: "Please provide more details about what you want to do." }; }

    const itemId = data.itemId || data.item;
    if (!itemId) { return { success: false, message: 'Please specify which item by name or ID.' }; }

    this.logger.info(`Updating Dry.AI folder ${itemId}: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('PUT', '/api/custom-gpt/update_folder', { item: itemId, query });

    if (result.success) {
      return {
        success: true,
        message: 'Folder updated successfully',
        data: result.data
      };
    }
    return result;
  }

  async handleShareItem(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const originalInput = data._context?.originalInput || '';
    let query = data.query || data.originalInput || 'share this item';
    let itemId = data.itemId || data.item;

    // If no itemId provided, try to find a matching space from the query + original input
    if (!itemId) {
      this.logger.info(`No itemId for share — searching spaces. query="${query}", originalInput="${originalInput}"`);
      try {
        const spacesResult = await this._apiRequest('GET', '/api/custom-gpt/get_all_smartspaces');
        const spaces = spacesResult.data?.items || spacesResult.data || [];
        if (Array.isArray(spaces) && spaces.length > 0) {
          // Try to match by name from both query AND original user input
          const searchText = `${query} ${originalInput}`.toLowerCase();
          const match = spaces.find(s => {
            const spaceName = (s.Name || s.name || '').toLowerCase();
            return spaceName && (searchText.includes(spaceName) || spaceName.includes(searchText.split(' ').filter(w => w.length > 3).join(' ')));
          });
          if (match) {
            itemId = match.ID || match.id;
            this.logger.info(`Matched space "${match.Name || match.name}" (${itemId}) from search text`);
          } else {
            // Don't silently pick a random space — tell the user
            const spaceNames = spaces.map(s => s.Name || s.name).filter(Boolean).join(', ');
            return {
              success: false,
              message: `I couldn't determine which space to share. Your spaces: ${spaceNames}\nPlease specify the exact name.`
            };
          }
        }
      } catch (err) {
        this.logger.warn(`Could not list spaces for share: ${err.message}`);
      }
    }

    if (!itemId) {
      throw new Error('Could not determine which item to share. Specify an itemId or space name.');
    }

    // If ownerEmail is set and query doesn't mention a specific email, inject it
    if (this.ownerEmail && !query.includes('@')) {
      query = `invite ${this.ownerEmail} as admin`;
    }

    this.logger.info(`Sharing Dry.AI item ${itemId}: ${query}`);
    const result = await this._apiRequest('PUT', '/api/custom-gpt/share_item', { item: itemId, query });

    if (result.success) {
      return {
        success: true,
        message: `Item shared successfully${this.ownerEmail && !data.query?.includes('@') ? ` — ${this.ownerEmail} invited as admin` : ''}`,
        data: result.data
      };
    }
    return result;
  }

  async handleDeleteItem(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    let itemId = data.itemId || data.item;

    // Dry.AI IDs are alphanumeric uppercase strings like "3QNVQEQ_LQA4X"
    // If the value looks like a human-readable name (contains spaces/lowercase),
    // treat it as a name to search for, not an ID
    const looksLikeId = itemId && /^[A-Z0-9_]+$/.test(itemId);
    if (itemId && !looksLikeId) {
      this.logger.info(`"${itemId}" looks like a name, not an ID — will search spaces`);
      itemId = null;
    }

    // If no itemId, try to find by name from the original input
    if (!itemId) {
      const originalInput = data._context?.originalInput || data.query || data.originalInput || data.item || '';
      this.logger.info(`No itemId for delete — searching by name from: "${originalInput}"`);
      try {
        const spacesResult = await this._apiRequest('GET', '/api/custom-gpt/get_all_smartspaces');
        const spaces = spacesResult.data?.items || spacesResult.data || [];
        if (Array.isArray(spaces) && spaces.length > 0) {
          const searchText = originalInput.toLowerCase();
          // Find all matching spaces, then pick the longest name match
          // to avoid "Memories Space" matching before "Memories Space 2"
          const matches = spaces.filter(s => {
            const name = (s.Name || s.name || '').toLowerCase();
            return name && searchText.includes(name);
          });
          const match = matches.length > 1
            ? matches.reduce((best, s) => {
                const bestName = (best.Name || best.name || '').length;
                const thisName = (s.Name || s.name || '').length;
                return thisName > bestName ? s : best;
              })
            : matches[0];
          if (match) {
            itemId = match.ID || match.id;
            this.logger.info(`Matched "${match.Name || match.name}" (${itemId}) for deletion`);
          } else {
            const spaceNames = spaces.map(s => s.Name || s.name).filter(Boolean).join(', ');
            return {
              success: false,
              message: `I couldn't find which space/item to delete. Your spaces: ${spaceNames}\nPlease specify the exact name.`
            };
          }
        }
      } catch (err) {
        this.logger.warn(`Could not list spaces for delete: ${err.message}`);
      }
    }

    if (!itemId) {
      return { success: false, message: 'Could not determine which item to delete. Please specify the name or ID.' };
    }

    this.logger.info(`Deleting Dry.AI item with ID: ${itemId}`);
    const result = await this._apiRequest('DELETE', '/api/custom-gpt/delete', null, { item: itemId });
    this.logger.info(`Delete API response: ${JSON.stringify(result).substring(0, 500)}`);

    if (result.success) {
      // Verify deletion actually happened by checking if the item still exists
      try {
        const spacesAfter = await this._apiRequest('GET', '/api/custom-gpt/get_all_smartspaces');
        const remaining = (spacesAfter.data?.items || spacesAfter.data || []);
        const stillExists = remaining.find(s => (s.ID || s.id) === itemId);
        if (stillExists) {
          this.logger.warn(`Delete claimed success but item ${itemId} still exists!`);
          return {
            success: false,
            message: `Failed to delete the item — it still exists after the delete request. The ID "${itemId}" may be invalid.`
          };
        }
      } catch (verifyErr) {
        this.logger.warn(`Could not verify deletion: ${verifyErr.message}`);
      }

      return {
        success: true,
        message: 'Item deleted successfully',
        data: result.data
      };
    }
    return result;
  }

  async handleDeleteByQuery(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const query = data.query || data.originalInput || data._context?.originalInput;
    if (!query) { return { success: false, message: "Please provide more details about what you want to do." }; }

    const folder = data.folder;
    const queryParams = { query };
    if (folder) queryParams.folder = folder;

    this.logger.info(`Deleting Dry.AI items matching: ${query.substring(0, 80)}`);
    const result = await this._apiRequest('DELETE', '/api/custom-gpt/delete_items', null, queryParams);

    if (result.success) {
      return {
        success: true,
        message: 'Matching items deleted successfully',
        data: result.data
      };
    }
    return result;
  }

  async handleUploadFile(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    // Check for attached file from Telegram context
    const attached = data._context?.attachedFile;
    const filename = data.filename || data.name || attached?.filename;
    const content = data.content || data.data || data.base64 || attached?.base64;
    const mimeType = data.mimeType || data.type || attached?.mimeType;

    if (!filename || !content) {
      return {
        success: false,
        message: 'To upload a file to Dry.AI, I need the file data. You can:\n' +
          '1. Send a file/document via Telegram and ask me to upload it to Dry.AI\n' +
          '2. Use the Dry.AI web interface to upload files directly\n' +
          '3. Use the API with base64-encoded file content'
      };
    }

    // Resolve space name to spaceId if not provided
    let spaceId = data.spaceId || data.space;
    if (!spaceId || !/^[a-f0-9]{24}$/i.test(spaceId)) {
      const originalInput = data._context?.originalInput || data.originalInput || '';
      const resolved = await this._resolveSpaceFromInput(spaceId || originalInput);
      if (resolved) {
        spaceId = resolved.id;
        this.logger.info(`uploadFile: resolved space "${resolved.name}" → ${spaceId}`);
      } else {
        spaceId = data.spaceId; // pass through whatever was given
      }
    }

    this.logger.info(`Uploading file to Dry.AI: ${filename}${spaceId ? ` (space: ${spaceId})` : ''}`);
    const result = await this._apiRequest('POST', '/api/mcp/upload-file',
      { filename, content, mimeType, itemId: data.itemId, spaceId },
      {}, { maxRetries: 1, retryDelayMs: 3000 }
    );

    this.logger.info(`uploadFile API response: ${JSON.stringify(result).substring(0, 500)}`);

    if (result.success) {
      const fileObjectId = result.data?.fileObjectId || result.data?.data?.fileObjectId || result.data?.id;
      const fileUrl = result.data?.url || result.data?.data?.url;
      const fileSize = result.data?.size || result.data?.data?.size;

      if (!fileObjectId) {
        this.logger.warn(`uploadFile: API returned success but no fileObjectId — response: ${JSON.stringify(result.data).substring(0, 300)}`);
        return {
          success: false,
          message: `Upload to Dry.AI may have failed — no file ID returned. Response: ${JSON.stringify(result.data).substring(0, 200)}`
        };
      }

      let message = `File "${filename}" uploaded successfully`;
      if (fileUrl) message += `\n[View file](${fileUrl})`;
      if (!spaceId) message += '\n(no space specified — uploaded to default)';

      return {
        success: true,
        message,
        fileObjectId,
        url: fileUrl,
        size: fileSize,
        data: result.data
      };
    }
    return result;
  }

  async handleRegeneratePage(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const objectId = data.objectId || data.pageId || data.itemId;
    const spaceId = data.spaceId || data.folder;

    if (!objectId || !spaceId) { return { success: false, message: 'Please specify the page and space to modify.' }; }

    this.logger.info(`Regenerating Dry.AI app page: ${objectId}`);
    const result = await this._apiRequest('POST', '/api/mcp/regenerate-page',
      { objectId, spaceId },
      {}, { maxRetries: 1, retryDelayMs: 5000 }
    );

    if (result.success) {
      return {
        success: true,
        message: result.data?.message || 'Page regenerated successfully',
        data: result.data
      };
    }
    return result;
  }

  async handleModifyPage(data) {
    const authCheck = this._ensureAuthenticated();
    if (authCheck) return authCheck;

    const objectId = data.objectId || data.pageId || data.itemId;
    const spaceId = data.spaceId || data.folder;
    const query = data.query || data.instruction || data.originalInput;

    if (!objectId || !spaceId) { return { success: false, message: 'Please specify the page and space to modify.' }; }
    if (!query) { return { success: false, message: 'Please provide more details about what you want to do.' }; }

    this.logger.info(`Modifying Dry.AI app page: ${objectId} — ${query.substring(0, 80)}`);
    const result = await this._apiRequest('POST', '/api/mcp/modify-page',
      { objectId, spaceId, query },
      {}, { maxRetries: 1, retryDelayMs: 5000 }
    );

    if (result.success) {
      return {
        success: true,
        message: result.data?.message || 'Page modified successfully',
        data: result.data
      };
    }
    return result;
  }

  // ─── Internal Methods ────────────────────────────────────────────

  async _apiRequest(method, endpoint, body = null, queryParams = {}, { maxRetries = 3, retryDelayMs = 2000 } = {}) {
    const url = new URL(`${this.config.baseUrl}${endpoint}`);
    Object.entries(queryParams).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `LANAgent/${this.version}`
      }
    };

    if (this.mcpToken) {
      options.headers['Authorization'] = `Bearer ${this.mcpToken}`;
    }

    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    }

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url.toString(), options);
        let data;

        try {
          data = await response.json();
        } catch {
          data = { message: await response.text() };
        }

        if (!response.ok) {
          // Non-retryable errors
          if (response.status === 401) {
            this.mcpToken = null;
            await PluginSettings.setCached(this.name, 'mcpToken', null);
            this.logger.warn('Dry.AI token expired or invalid, cleared');
            return {
              success: false,
              error: 'Authentication expired. Please re-authenticate using register/verify or setToken.'
            };
          }

          if (response.status === 403) {
            return {
              success: false,
              error: `Permission denied: ${data.error || data.message || 'Access forbidden'}`
            };
          }

          if (response.status === 429) {
            return {
              success: false,
              error: 'Rate limited by Dry.AI. Please wait before retrying.'
            };
          }

          // Retryable server errors
          const retryable = response.status === 424 || response.status === 502 ||
                            response.status === 503 || response.status === 504 ||
                            response.status === 522;
          if (retryable && attempt < maxRetries) {
            const waitTime = retryDelayMs * Math.pow(1.5, attempt - 1);
            this.logger.info(`Dry.AI request failed (${response.status}), retrying in ${waitTime}ms (attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }

          return {
            success: false,
            error: data.error || data.message || `HTTP ${response.status}`
          };
        }

        return { success: true, data };

      } catch (error) {
        lastError = error;
        const retryable = error.message.includes('ECONNRESET') ||
                          error.message.includes('ETIMEDOUT') ||
                          error.message.includes('fetch failed');
        if (retryable && attempt < maxRetries) {
          const waitTime = retryDelayMs * Math.pow(1.5, attempt - 1);
          this.logger.info(`Dry.AI network error, retrying in ${waitTime}ms (attempt ${attempt}/${maxRetries}): ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        this.logger.error(`Dry.AI API request failed: ${method} ${endpoint}`, error);
        return {
          success: false,
          error: `Network error: ${error.message}`
        };
      }
    }

    return { success: false, error: `Failed after ${maxRetries} attempts: ${lastError?.message}` };
  }

  // ─── Space Resolution ──────────────────────────────────────────

  /**
   * Resolve a space name from natural language input to a space ID.
   * Returns { id, name } or null if no match found.
   */
  async _resolveSpaceFromInput(input) {
    if (!input) return null;
    try {
      const spacesResult = await this._apiRequest('GET', '/api/custom-gpt/get_all_smartspaces');
      const spaces = spacesResult.data?.items || spacesResult.data || [];
      if (!Array.isArray(spaces) || !spaces.length) return null;

      const searchText = input.toLowerCase();
      const match = spaces.find(s => {
        const spaceName = (s.Name || s.name || '').toLowerCase();
        return spaceName && (searchText.includes(spaceName) || spaceName.includes(searchText.split(' ').filter(w => w.length > 3).join(' ')));
      });

      if (match) {
        return { id: match.ID || match.id, name: match.Name || match.name };
      }
    } catch (err) {
      this.logger.warn(`Could not resolve space from input: ${err.message}`);
    }
    return null;
  }

  // ─── Response Formatting ─────────────────────────────────────────

  _cleanUrl(url) {
    if (!url) return '';
    if (typeof url === 'object') url = url.href || '';
    if (typeof url !== 'string' || url.includes('[object')) return '';
    return url;
  }

  _formatSpaces(data) {
    const items = data?.items || (Array.isArray(data) ? data : []);
    if (!items.length) return 'No spaces found. Create one with "create a dry ai space for..."';

    let msg = `**Your Dry.AI Spaces** (${items.length}):\n\n`;
    for (const space of items) {
      const name = space.Name || space.name || 'Unnamed';
      const desc = space.Description || space.description || '';
      const url = this._cleanUrl(space.URL || space.url);
      const id = space.ID || space.id || '';
      const link = url || (id ? `https://dry.ai/v?t=tsr&oc=$${id.toLowerCase()}` : '');
      const types = space.Types || [];
      const folders = space.Folders || [];

      if (link) {
        msg += `**[${name}](${link})**`;
      } else {
        msg += `**${name}**`;
      }
      if (desc) msg += ` — ${desc}`;
      msg += '\n';
      if (types.length) msg += `  Types: ${types.map(t => t.Name || t.name).join(', ')}\n`;
      if (folders.length) {
        const folderLinks = folders.map(f => {
          const fname = f.Name || f.name;
          const furl = this._cleanUrl(f.URL || f.url);
          return furl ? `[${fname}](${furl})` : fname;
        });
        msg += `  Folders: ${folderLinks.join(', ')}\n`;
      }
      msg += '\n';
    }
    return msg.trim();
  }

  _formatItem(item) {
    if (!item) return 'Item not found.';
    const name = item.Name || item.name || item.Title || item.title || 'Unnamed';
    const type = item.Type || item.type || '';
    const body = item.Body || item.body || item.Description || item.description || '';
    const url = this._cleanUrl(item.URL || item.url);
    const id = item.ID || item.id || '';

    let msg = '';
    if (url) {
      msg += `**[${name}](${url})**`;
    } else if (id) {
      msg += `**[${name}](https://dry.ai/v?t=tsr&oc=$${id.toLowerCase()})**`;
    } else {
      msg += `**${name}**`;
    }
    if (type) msg += ` (${type})`;
    msg += '\n';
    if (body) msg += `${body.substring(0, 500)}\n`;
    return msg.trim();
  }

  _formatItemsList(data, spaceName) {
    const items = data?.items || (Array.isArray(data) ? data : []);
    if (!items.length) return spaceName ? `No items found in "${spaceName}".` : 'No items found.';

    let msg = spaceName ? `**Items in ${spaceName}** (${items.length}):\n\n` : `**Items** (${items.length}):\n\n`;
    const maxShow = 10;
    for (let i = 0; i < Math.min(items.length, maxShow); i++) {
      const item = items[i];
      const name = item.Name || item.name || item.Title || item.title || 'Unnamed';
      const type = item.Type || item.type || '';
      const url = this._cleanUrl(item.URL || item.url);
      const id = item.ID || item.id || '';
      const link = url || (id ? `https://dry.ai/v?t=tsr&oc=$${id.toLowerCase()}` : '');

      msg += `${i + 1}. `;
      if (link) {
        msg += `[${name}](${link})`;
      } else {
        msg += `**${name}**`;
      }
      if (type) msg += ` (${type})`;
      msg += '\n';
    }
    if (items.length > maxShow) msg += `\n...and ${items.length - maxShow} more items.`;
    return msg.trim();
  }

  _formatSearchResults(data, query) {
    const items = data?.items || (Array.isArray(data) ? data : []);
    const metadata = data?.metadata || '';

    if (!items.length && !metadata) return `No results found for "${query}".`;

    let msg = '';
    if (items.length) {
      msg += `**Results for "${query}"** (${items.length}):\n\n`;
      const maxShow = 8;
      for (let i = 0; i < Math.min(items.length, maxShow); i++) {
        const item = items[i];
        const name = item.Name || item.name || item.Title || item.title || 'Unnamed';
        const type = item.Type || item.type || '';
        const body = item.Body || item.body || '';
        const url = this._cleanUrl(item.URL || item.url);
        const id = item.ID || item.id || '';
        const link = url || (id ? `https://dry.ai/v?t=tsr&oc=$${id.toLowerCase()}` : '');

        msg += `${i + 1}. `;
        if (link) {
          msg += `[${name}](${link})`;
        } else {
          msg += `**${name}**`;
        }
        if (type) msg += ` (${type})`;
        if (body) msg += ` — ${body.substring(0, 100)}`;
        msg += '\n';
      }
      if (items.length > maxShow) msg += `\n...and ${items.length - maxShow} more results.`;
    }
    if (metadata && typeof metadata === 'string') {
      msg += '\n' + metadata.substring(0, 500);
    }
    return msg.trim() || `Search complete for "${query}".`;
  }

  _formatHelpResults(data) {
    const items = data?.items || [];
    const metadata = data?.metadata || '';

    let msg = '';
    if (items.length) {
      for (const item of items.slice(0, 5)) {
        const title = item.Title || item.Name || item.name || '';
        const body = item.Body || item.body || '';
        if (title) msg += `**${title}**\n`;
        if (body) msg += `${body.substring(0, 300)}\n\n`;
      }
    }
    if (metadata && typeof metadata === 'string') {
      msg += metadata.substring(0, 500);
    }
    return msg.trim() || 'No help results found.';
  }

  _ensureAuthenticated() {
    if (!this.mcpToken) {
      return {
        success: false,
        error: 'Not authenticated. Use register/verify or setToken first.'
      };
    }
    return null;
  }

  async _loadToken() {
    try {
      const stored = await PluginSettings.getCached(this.name, 'mcpToken');
      if (stored && stored.token) {
        this.mcpToken = stored.token;
        this.authEmail = stored.email || null;
        this.authUserId = stored.userId || null;
      }
    } catch (error) {
      this.logger.debug('Could not load Dry.AI token:', error.message);
    }
    // Load owner email
    try {
      const ownerEmail = await PluginSettings.getCached(this.name, 'ownerEmail');
      if (ownerEmail) this.ownerEmail = ownerEmail;
    } catch { /* not set yet */ }
  }

  async _saveToken(token, email = null, userId = null) {
    this.mcpToken = token;
    this.authEmail = email;
    this.authUserId = userId;
    await PluginSettings.setCached(this.name, 'mcpToken', {
      token,
      email,
      userId,
      savedAt: new Date().toISOString()
    });
  }

  async cleanup() {
    this.mcpToken = null;
    this.authEmail = null;
    this.authUserId = null;
  }
}
