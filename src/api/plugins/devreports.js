import { BasePlugin } from '../core/basePlugin.js';
import { textxRequest } from '../../services/textx/textxHub.js';
import { fileDevReport, listDevReports, syncPending, DEV_INBOX } from '../../services/devReports.js';

const RETRY_MS = 15 * 60 * 1000;

/**
 * The owner reports a bug or limitation for the developer ("log a bug: you didn't hear me the
 * first time"). Each report is stored with the conversation and recent errors, and mirrored to the
 * Trellis "Dev Inbox" basket. See services/devReports.js. On calls the same thing is the realtime
 * report_bug tool (services/textx/dialxRealtime.js).
 */
export default class DevReportsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'devreports';
    this.version = '1.0.0';
    this.description = `Report a bug, glitch or limitation in the agent itself to its developer, with the conversation and recent errors attached (saved to the Trellis "${DEV_INBOX}")`;
    this.commands = [
      {
        command: 'report',
        description: 'File a bug report for the developer about something the agent did wrong or cannot do. Use the owner\'s own words for what went wrong',
        usage: 'report({ text: "You hung up while I was still talking" })',
        examples: ['log a bug', 'report a bug to the developer', 'file a bug: you answered the wrong question', 'note this for the developer', 'that is a bug, report it', 'tell the developer you cannot read my calendar']
      },
      {
        command: 'list',
        description: 'List the bug reports filed for the developer and whether they are fixed',
        usage: 'list({ status: "open" })',
        examples: ['what bugs have I reported', 'show my bug reports', 'which reported bugs are still open']
      }
    ];
  }

  async initialize() {
    this.retryTimer = setInterval(() => syncPending(this.agent).catch(() => {}), RETRY_MS);
    this.retryTimer.unref?.();
  }

  async cleanup() {
    clearInterval(this.retryTimer);
  }

  fromOwner(data) {
    const uid = data._context?.userId;
    return !!textxRequest.getStore()?.deviceId || !uid || uid === 'web-user' || String(uid) === String(process.env.TELEGRAM_USER_ID || '');
  }

  interfaceOf(data) {
    const uid = String(data._context?.userId || '');
    if (textxRequest.getStore()?.deviceId || uid.startsWith('textx:')) return 'textx';
    if (uid === 'web-user') return 'web';
    if (uid && uid === String(process.env.TELEGRAM_USER_ID || '')) return 'telegram';
    return 'chat';
  }

  async execute(params = {}) {
    const { action } = params;
    if (!this.fromOwner(params)) return { success: false, error: 'Only my owner can file bug reports.' };

    if (action === 'report') {
      const text = String(params.text || params.description || params.report || params._context?.originalInput || '')
        .replace(/^\s*(?:(?:hey|ok(?:ay)?)[,\s]+)?(?:\w+[,\s]+)?(?:please\s+)?(?:log|file|report|note)\s+(?:a|this|that)?\s*(?:bug|issue)(?:\s+(?:report|for the developer))?\s*[:,-]?\s*/i, '')
        .trim();
      if (!text) return { success: false, error: 'What went wrong? Describe the bug.' };
      const r = await fileDevReport(this.agent, { text, interface: this.interfaceOf(params), userId: params._context?.userId });
      return {
        success: true,
        id: r.id,
        card: r.card,
        result: r.card
          ? `Bug report saved for the developer (Trellis ${DEV_INBOX}, card ${r.card}).`
          : 'Bug report saved for the developer. Trellis is unreachable right now; it will be added there automatically.'
      };
    }

    if (action === 'list') {
      const rows = await listDevReports({ status: params.status || 'open', limit: params.limit });
      if (!rows.length) return { success: true, reports: [], result: 'No bug reports.' };
      const lines = rows.map(r => `• ${new Date(r.createdAt).toISOString().slice(0, 10)} [${r.status}${r.fixedIn ? ` in ${r.fixedIn}` : ''}] ${r.text.slice(0, 140)}`);
      return { success: true, reports: rows.map(r => ({ id: String(r._id), text: r.text, status: r.status, card: r.trellisCard })), result: lines.join('\n') };
    }

    return { success: false, error: `Unknown action: ${action}. Use report or list.` };
  }
}
