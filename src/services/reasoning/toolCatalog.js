import { logger } from '../../utils/logger.js';
import { embeddingService } from '../embeddingService.js';
import { vectorStore } from '../vectorStore.js';

/**
 * Plugin tools for the reasoning agents (ReAct, Plan-Execute).
 *
 * Read live from apiManager.apis on every call, so a plugin enabled or disabled at runtime
 * is reflected immediately. (Both agents used to read `apiManager.plugins`, which does not
 * exist, and ran with zero tools.)
 *
 * The plugins expose over a thousand commands — too many to list in every reasoning step.
 * A prompt gets full command lists only for the plugins the vector intent index ranks as
 * relevant to the task, a one-line catalog of the rest, and describe_tool and search_tools
 * pseudo-tools to discover commands on demand.
 */

// Plugins that can move funds, sign transactions or act on the trading wallet are never
// offered to autonomous multi-step reasoning. Extend with REASONING_EXCLUDED_PLUGINS.
const DEFAULT_EXCLUDED = ['contractCommands', 'cryptoMonitor', 'walletProfiler', 'tokenProfiler', 'chainlink', 'mindswarm'];

export const DESCRIBE_TOOL = 'describe_tool';
export const SEARCH_TOOL = 'search_tools';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

// A trusted peer agent's request (another agent on the operator's own Trellis account) runs
// with the tools, minus anything that restarts, reconfigures or opens a shell on this host, or
// holds the operator's credentials. Money is already out via DEFAULT_EXCLUDED. Extend with
// PEER_EXCLUDED_PLUGINS.
const PEER_EXCLUDED = ['system', 'systemAdmin', 'ssh', 'vpn', 'apikeys', 'oauthmanager', 'selfHealing', 'software', 'devenv', 'development', 'docker', 'backupStrategy', 'email', 'twitter', 'subagents', 'systemLogs'];

export function excludedPlugins(context = null) {
  const extra = (process.env.REASONING_EXCLUDED_PLUGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const peer = context?.trellis?.peer
    ? [...PEER_EXCLUDED, ...(process.env.PEER_EXCLUDED_PLUGINS || '').split(',').map(s => s.trim()).filter(Boolean)]
    : [];
  return new Set([...DEFAULT_EXCLUDED, ...extra, ...peer]);
}

/** Enabled, non-excluded plugins as { name, description, commands[] }. */
export function listTools(agent, context = null) {
  const apis = agent?.apiManager?.apis;
  if (!apis) return [];
  const excluded = excludedPlugins(context);
  const tools = [];
  for (const [name, wrapper] of apis) {
    if (!wrapper?.enabled || excluded.has(name)) continue;
    const plugin = wrapper.instance || {};
    tools.push({
      name,
      description: plugin.description || `${name} plugin`,
      commands: (Array.isArray(plugin.commands) ? plugin.commands : [])
        .filter(c => c && c.command)
        .map(c => ({ command: c.command, description: c.description, usage: c.usage }))
    });
  }
  return tools;
}

/**
 * Enabled plugins this request may not use, whose name the query names. Without this a search
 * for one answers "no match" and the model searches again: ReAct looked for mindswarm eight
 * times in one run (2026-10-03).
 */
function withheldNamed(agent, query, context = null) {
  const apis = agent?.apiManager?.apis;
  if (!apis) return [];
  const words = normalizedText(String(query || '')).split(' ').filter(w => w.length >= 3);
  const excluded = excludedPlugins(context);
  const names = [];
  for (const [name, wrapper] of apis) {
    if (!wrapper?.enabled || !excluded.has(name)) continue;
    const plain = normalizedText(name).replace(/ /g, '');
    if (words.some(w => plain === w || plain.includes(w) || w.includes(plain))) names.push(name);
  }
  return names;
}

const withheldText = (names) =>
  `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} installed but not available to multi-step reasoning ` +
  `(it can move funds or act on this host). Do not search for it again: say it has to be run as a direct command.`;

/**
 * Plugin names most relevant to a task, best first, from the vector intent index
 * (the same embeddings intent detection uses). Empty when the index is unavailable.
 */
export async function selectRelevantTools(agent, query, { max = 6, available } = {}) {
  const allowed = new Set((available || listTools(agent)).map(t => t.name));
  try {
    const embedding = await embeddingService.generateEmbedding(query);
    const results = await vectorStore.search(embedding, 25);
    const names = [];
    for (const r of results || []) {
      const plugin = r?.metadata?.plugin || r?.plugin;
      if (plugin && allowed.has(plugin) && !names.includes(plugin)) names.push(plugin);
      if (names.length >= max) break;
    }
    return names;
  } catch (error) {
    logger.debug(`Relevant-tool selection unavailable: ${error.message}`);
    return [];
  }
}

function commandLines(tool) {
  return tool.commands.map(c => `  - ${c.command}: ${c.description || ''}${c.usage ? ` (usage: ${c.usage})` : ''}`).join('\n');
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function normalizedText(value) {
  return tokenize(value).join(' ');
}

function searchLimit(options = {}) {
  const requested = Number(options.max ?? options.limit ?? DEFAULT_SEARCH_LIMIT);
  if (!Number.isFinite(requested)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(requested)));
}

/**
 * Search enabled plugin commands by command name, description, and usage.
 *
 * Command-name matches receive higher scores than description and usage matches.
 * The catalog is rebuilt from the live enabled plugin set for every search so runtime
 * plugin enablement, disablement, and command changes are reflected immediately.
 */
export function searchTools(agent, query, options = {}) {
  const queryText = String(query || '').trim();
  const queryTokens = tokenize(queryText);
  if (!queryTokens.length) return [];

  const normalizedQuery = normalizedText(queryText);
  const entries = [];
  for (const plugin of listTools(agent, options.context ?? null)) {
    for (const command of plugin.commands) {
      const commandText = String(command.command || '');
      const description = String(command.description || '');
      const usage = String(command.usage || '');
      const commandTokens = tokenize(commandText);
      const descriptionTokens = tokenize(description);
      const usageTokens = tokenize(usage);

      const commandExact = normalizedText(commandText) === normalizedQuery;
      // Substring matching only for tokens of 3+ characters: a query word like "a" or
      // "to" would otherwise be contained in nearly every description.
      const hits = (token, candidates) => candidates.some(candidate =>
        candidate === token || (token.length >= 3 && candidate.includes(token)));
      const commandMatches = queryTokens.filter(token => hits(token, commandTokens)).length;
      const descriptionMatches = queryTokens.filter(token => hits(token, descriptionTokens)).length;
      const usageMatches = queryTokens.filter(token => hits(token, usageTokens)).length;

      if (!commandExact && commandMatches === 0 && descriptionMatches === 0 && usageMatches === 0) {
        continue;
      }

      const score =
        (commandExact ? 10000 : 0) +
        (commandMatches * 100) +
        (descriptionMatches * 10) +
        usageMatches +
        (commandText.toLowerCase().includes(queryText.toLowerCase()) ? 25 : 0);

      entries.push({
        plugin: plugin.name,
        command: commandText,
        description,
        usage,
        score
      });
    }
  }

  return entries
    .sort((a, b) =>
      b.score - a.score ||
      a.plugin.localeCompare(b.plugin) ||
      a.command.localeCompare(b.command)
    )
    .slice(0, searchLimit(options))
    .map(({ score, ...result }) => result);
}

/**
 * Prompt text: detailed commands for the relevant plugins, one line for every other one.
 * `order` optionally ranks the catalog (e.g. by past success). `describeHint` is off for
 * one-shot planners, which cannot call describe_tool before committing to a plan.
 */
export function formatToolsForPrompt(tools, relevantNames = [], order = null, { describeHint = true } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const detailed = relevantNames.map(n => byName.get(n)).filter(Boolean);
  const rest = (order || tools).filter(t => !relevantNames.includes(t.name));

  const sections = [];
  if (detailed.length) {
    sections.push(detailed.map(t => `**${t.name}**: ${t.description}\n${commandLines(t)}`).join('\n\n'));
  }
  if (rest.length) {
    const hint = describeHint
      ? 'call `' + DESCRIBE_TOOL + '` with params {"name": "<tool>"} to see their commands, or `' +
        SEARCH_TOOL + '` with params {"query": "<keywords>"} to search commands'
      : 'commands not listed; prefer the tools listed above';
    sections.push(`Other tools (${hint}):\n` +
      rest.map(t => `- ${t.name}: ${String(t.description).substring(0, 90)}`).join('\n'));
  }
  return sections.join('\n\n') || 'No tools available.';
}

/**
 * Run one tool command. Goes through apiManager.executeAPI (plugin timeout, call stats) and
 * is NOT retried: a plugin command can have side effects that must not be repeated.
 */
export async function executeTool(agent, tool, command, params = {}, context = null) {
  const tools = listTools(agent, context);

  if (tool === DESCRIBE_TOOL) {
    const target = tools.find(t => t.name === params?.name);
    if (!target) {
      const withheld = withheldNamed(agent, params?.name, context);
      return { success: false, error: withheld.length ? withheldText(withheld) : `No available tool named "${params?.name}"` };
    }
    return { success: true, result: `${target.name}: ${target.description}\n${commandLines(target)}` };
  }

  if (tool === SEARCH_TOOL) {
    const query = params?.query ?? params?.q ?? (command !== 'search' ? command : '');
    if (!String(query || '').trim()) {
      return { success: false, error: 'A search query is required' };
    }
    try {
      const matches = searchTools(agent, query, {
        ...(params?.options || {}),
        ...(params?.max !== undefined ? { max: params.max } : {}),
        context
      });
      const withheld = matches.length ? [] : withheldNamed(agent, query, context);
      // Text, like describe_tool, so the observation reads the same in the next prompt.
      return {
        success: true,
        matches,
        result: matches.length
          ? matches.map(m => `- ${m.plugin}.${m.command}: ${m.description}${m.usage ? ` (usage: ${m.usage})` : ''}`).join('\n')
          : withheld.length ? withheldText(withheld) : `No commands match "${String(query).trim()}".`
      };
    } catch (error) {
      logger.debug(`Tool search failed: ${error.message}`);
      return { success: false, error: 'Unable to search available tools' };
    }
  }

  if (!tools.some(t => t.name === tool)) {
    return { success: false, error: `Tool '${tool}' not found or not available to reasoning` };
  }
  try {
    // The Trellis channel a request came from, for trellis-notes only (see executePluginWithLogging).
    const channel = tool === 'trellis-notes' && context?.trellis ? { _trellis: context.trellis } : {};
    // The http plugin narrows what a peer's request may reach (no LAN, no uploads outside data dirs);
    // cryptotools refuses a peer the saved secrets as HMAC keys.
    if ((tool === 'http' || tool === 'cryptotools') && context?.trellis?.peer) channel._peer = context.trellis.peer;
    // A follow-up is scheduled for the conversation it was promised in.
    if (tool === 'followup' && context) channel._context = { trellis: context.trellis || null, userId: context.userId || null, interface: context.interface || null };
    const result = await agent.apiManager.executeAPI(tool, 'execute', { ...(params || {}), ...channel, action: command });
    if (result?.success === false) {
      const hint = elsewhereHint(tools, tool, command);
      if (hint) return { success: false, error: `${result.error || 'plugin reported failure'}. ${hint}`, result };
    }
    return { success: result?.success !== false, result };
  } catch (error) {
    const hint = elsewhereHint(tools, tool, command);
    return { success: false, error: hint ? `${error.message}. ${hint}` : error.message };
  }
}

/**
 * When a command failed on a tool that does not declare it, name the tool(s) that do. The model
 * called trellis-notes.listSecrets (an http command) six times on 2026-10-05 and retried the same
 * call after the validation error, which lists only trellis-notes' own actions.
 */
function elsewhereHint(tools, tool, command) {
  const own = tools.find(t => t.name === tool);
  if (!own || own.commands.some(c => c.command === command)) return '';
  const owners = tools.filter(t => t.name !== tool && t.commands.some(c => c.command === command)).map(t => t.name);
  if (!owners.length) return '';
  return `"${command}" is not a ${tool} command; it belongs to ${owners.map(n => `tool "${n}"`).join(' or ')}. Call it there.`;
}

/**
 * Past successful reasoning for similar tasks, formatted as worked examples. Only chains
 * that actually used a tool are useful as examples.
 */
export async function findPastExamples(thoughtStore, query, { limit = 2 } = {}) {
  if (!thoughtStore?.findSimilarReasoning) return '';
  try {
    const chains = await thoughtStore.findSimilarReasoning(query, { limit: limit * 3, successfulOnly: true });
    const useful = chains.filter(c => (c.thoughts || []).some(t => t.type === 'action' || (t.type === 'plan' && t.content?.steps?.length)))
      .slice(0, limit);
    return useful.map(c => {
      const steps = (c.thoughts || []).flatMap(t => {
        if (t.type === 'action') return [`${t.content.tool}.${t.content.command}(${JSON.stringify(t.content.params || {})})`];
        if (t.type === 'plan') return (t.content.steps || []).map(s => `${s.tool}.${s.command}(${JSON.stringify(s.params || {})})`);
        return [];
      });
      const answer = c.result?.answer || c.result?.summary || '';
      return `Task: ${c.query}\nSteps: ${steps.join(' → ').substring(0, 600)}\nOutcome: ${String(answer).substring(0, 300)}`;
    }).join('\n\n');
  } catch (error) {
    logger.debug(`Past reasoning lookup failed: ${error.message}`);
    return '';
  }
}
