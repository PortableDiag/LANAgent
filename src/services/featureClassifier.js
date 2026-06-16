import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

const DEV_PATH = process.env.AGENT_REPO_PATH || '/root/lanagent-repo';
const PLUGINS_DIR = 'src/api/plugins';

/**
 * Classify a discovered feature into an actionable plan for self-modification.
 *
 * Three outcomes:
 *   - modify     — enhance an existing file at returned `targetFile`
 *   - new-plugin — create a new plugin file at returned `targetFile`
 *                  (must be under src/api/plugins/, must not already exist)
 *   - skip       — not implementable cleanly; surface for manual review
 *
 * Never throws. AI failures, malformed JSON, missing files, name collisions
 * all collapse to { kind:'skip', rationale }. Self-modification can rely on
 * the returned shape being valid.
 *
 * @param {Object} agent           Agent instance (for providerManager access)
 * @param {Object} feature         DiscoveredFeature plain object or doc
 * @returns {Promise<{kind:'modify'|'new-plugin'|'skip', targetFile:?string, rationale:string}>}
 */
export async function classifyDiscoveredFeature(agent, feature) {
  if (!feature || !feature.title) {
    return { kind: 'skip', targetFile: null, rationale: 'classifier: empty feature' };
  }

  const existingPlugins = await listExistingPlugins();
  const prompt = buildClassifierPrompt(feature, existingPlugins);

  let response;
  try {
    response = await agent.providerManager.generateResponse(prompt, {
      maxTokens: 400,
      temperature: 0.2
    });
  } catch (err) {
    logger.warn(`[classifier] AI call failed for "${feature.title}": ${err.message}`);
    return { kind: 'skip', targetFile: null, rationale: `classifier failed: ${err.message}` };
  }

  const content = response?.content || '';
  const parsed = extractJson(content);
  if (!parsed) {
    logger.warn(`[classifier] No JSON in AI response for "${feature.title}" (${content.length} chars)`);
    return { kind: 'skip', targetFile: null, rationale: 'classifier: no JSON in AI response' };
  }

  const kind = parsed.kind;
  const targetFile = typeof parsed.targetFile === 'string' ? parsed.targetFile.trim() : null;
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 500) : '';

  if (kind === 'skip') {
    return { kind: 'skip', targetFile: null, rationale: rationale || 'classifier: skip (AI verdict)' };
  }

  if (kind === 'modify') {
    if (!targetFile) {
      return { kind: 'skip', targetFile: null, rationale: 'classifier: modify but no targetFile' };
    }
    const abs = path.isAbsolute(targetFile) ? targetFile : path.join(DEV_PATH, targetFile);
    try {
      await fs.access(abs);
    } catch {
      return { kind: 'skip', targetFile: null, rationale: `classifier: modify target missing (${targetFile})` };
    }
    return { kind: 'modify', targetFile, rationale: rationale || 'classifier: modify existing file' };
  }

  if (kind === 'new-plugin') {
    if (!targetFile) {
      return { kind: 'skip', targetFile: null, rationale: 'classifier: new-plugin but no targetFile' };
    }
    // Must be a fresh file under src/api/plugins/ with a .js extension and no leading separators.
    const normalized = targetFile.replace(/^\/+/, '');
    if (!normalized.startsWith(`${PLUGINS_DIR}/`) || !normalized.endsWith('.js')) {
      return {
        kind: 'skip',
        targetFile: null,
        rationale: `classifier: new-plugin path not under ${PLUGINS_DIR}/ or missing .js (${targetFile})`
      };
    }
    const basename = path.basename(normalized);
    // Avoid template/helper-named files that loadAllPlugins() filters out.
    if (/template|enhancements|advanced|helper|providers/i.test(basename) || basename.startsWith('_')) {
      return {
        kind: 'skip',
        targetFile: null,
        rationale: `classifier: new-plugin filename would be excluded by loader (${basename})`
      };
    }
    const abs = path.join(DEV_PATH, normalized);
    try {
      await fs.access(abs);
      // File already exists — collision with an existing plugin
      return {
        kind: 'skip',
        targetFile: null,
        rationale: `classifier: new-plugin collides with existing file (${normalized})`
      };
    } catch {
      // Good — doesn't exist
    }
    return { kind: 'new-plugin', targetFile: normalized, rationale: rationale || 'classifier: new plugin' };
  }

  return { kind: 'skip', targetFile: null, rationale: `classifier: unknown kind "${kind}"` };
}

/**
 * Read src/api/plugins/ and return the basenames (sans .js) of plugins that
 * would actually be loaded. Used to give the AI a name-collision-avoidance hint
 * and a sense of what plugins already cover.
 */
async function listExistingPlugins() {
  try {
    const dir = path.join(DEV_PATH, PLUGINS_DIR);
    const files = await fs.readdir(dir);
    return files
      .filter(f =>
        f.endsWith('.js') &&
        !f.startsWith('_') &&
        !/template|enhancements|advanced|helper|providers/i.test(f)
      )
      .map(f => f.slice(0, -3))
      .sort();
  } catch (err) {
    logger.warn(`[classifier] could not list plugins dir: ${err.message}`);
    return [];
  }
}

function buildClassifierPrompt(feature, existingPlugins) {
  const snippetSummary = Array.isArray(feature.codeSnippets) && feature.codeSnippets.length > 0
    ? `\nCode snippets attached: ${feature.codeSnippets.length} (${feature.codeSnippets.map(s => s.filePath || s.language || '?').slice(0, 3).join(', ')})`
    : '';

  return `You classify a discovered feature idea into a concrete implementation plan for the LANAgent codebase.

CODEBASE LAYOUT (Node.js, ES modules, MongoDB):
- src/api/plugins/  — Auto-discovered plugins (drop a .js file here, it loads on restart). Each plugin extends BasePlugin from src/api/core/basePlugin.js with a name, version, and async execute(params) method.
- src/services/     — Long-lived services wired into src/core/agent.js (multi-file edit; do NOT route new things here).
- src/core/         — Core agent/orchestration.
- src/interfaces/   — Web/Telegram/SSH interfaces.
- src/models/       — Mongoose models.
- src/utils/        — Shared utilities.

EXISTING PLUGINS (don't pick a name that collides):
${existingPlugins.join(', ') || '(none listed)'}

FEATURE TO CLASSIFY:
Title:       ${feature.title}
Description: ${feature.description || '(none)'}
${feature.implementation?.suggestion ? `Suggestion:  ${feature.implementation.suggestion}` : ''}${snippetSummary}

DECIDE ONE OF:
1. "modify" — feature is a clean enhancement to ONE specific existing file. Return the repo-relative path of that file (must exist).
2. "new-plugin" — feature is a self-contained capability that fits the plugin pattern. Return a fresh repo-relative path under src/api/plugins/<name>.js where <name> is lowercase, no spaces, doesn't collide with the list above, and doesn't start with _, "template", "helper", "advanced", "enhancements", or "providers".
3. "skip" — feature is not implementable as a clean plugin or single-file modify. Examples: requires new core service (multi-file edit to agent.js), too vague, depends on missing infra, would need a UI overhaul, duplicates an existing plugin, is an idea not a feature.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"kind":"modify"|"new-plugin"|"skip","targetFile":"src/path/to/file.js"|null,"rationale":"one short sentence"}`;
}

/**
 * Pull a JSON object out of an AI response. Tolerates markdown code fences
 * and surrounding prose. Returns null if no parseable object is found.
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;

  // Strip code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  // Find the first {...} block that spans the rest of the content (greedy on close)
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
