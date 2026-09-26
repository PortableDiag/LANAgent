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
 * relevant to the task, a one-line catalog of the rest, and a describe_tool pseudo-tool
 * to fetch any other plugin's commands on demand.
 */

// Plugins that can move funds, sign transactions or act on the trading wallet are never
// offered to autonomous multi-step reasoning. Extend with REASONING_EXCLUDED_PLUGINS.
const DEFAULT_EXCLUDED = ['contractCommands', 'cryptoMonitor', 'walletProfiler', 'tokenProfiler', 'chainlink', 'mindswarm'];

export const DESCRIBE_TOOL = 'describe_tool';

export function excludedPlugins() {
  const extra = (process.env.REASONING_EXCLUDED_PLUGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_EXCLUDED, ...extra]);
}

/** Enabled, non-excluded plugins as { name, description, commands[] }. */
export function listTools(agent) {
  const apis = agent?.apiManager?.apis;
  if (!apis) return [];
  const excluded = excludedPlugins();
  const tools = [];
  for (const [name, wrapper] of apis) {
    if (!wrapper?.enabled || excluded.has(name)) continue;
    const plugin = wrapper.instance || {};
    tools.push({
      name,
      description: plugin.description || `${name} plugin`,
      commands: (plugin.commands || []).map(c => ({ command: c.command, description: c.description, usage: c.usage }))
    });
  }
  return tools;
}

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
      ? 'call `' + DESCRIBE_TOOL + '` with params {"name": "<tool>"} to see their commands first'
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
export async function executeTool(agent, tool, command, params = {}) {
  const tools = listTools(agent);

  if (tool === DESCRIBE_TOOL) {
    const target = tools.find(t => t.name === params?.name);
    if (!target) return { success: false, error: `No available tool named "${params?.name}"` };
    return { success: true, result: `${target.name}: ${target.description}\n${commandLines(target)}` };
  }

  if (!tools.some(t => t.name === tool)) {
    return { success: false, error: `Tool '${tool}' not found or not available to reasoning` };
  }
  try {
    const result = await agent.apiManager.executeAPI(tool, 'execute', { ...(params || {}), action: command });
    return { success: result?.success !== false, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
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
