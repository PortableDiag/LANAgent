/**
 * Skill quality, after agentskills.io "Best practices for skill creators" and "Optimizing skill
 * descriptions" (read 2026-09-30):
 *   - SKILL_WRITING_RULES go into every prompt that writes a skill (task learning, peer learning,
 *     the background review, the curator's merges), so learned skills follow the same rules.
 *   - addGotcha(): a correction becomes a line in the skill's "## Gotchas" section ("When an
 *     agent makes a mistake you have to correct, add the correction to the gotchas section").
 *   - lintSkill(): the spec's limits and the common failure shapes, as plain warnings.
 *   - evaluateTriggers(): the guide's trigger eval, run against this agent's own matcher.
 */

export const SKILL_WRITING_RULES = `How to write the skill (agentskills.io best practices):
- Include only what an agent would NOT know on its own: the exact tool/action names, parameters, commands, paths, formats and project conventions that worked. No generic advice ("handle errors appropriately", "follow best practices").
- Teach a reusable procedure for this kind of task, not the answer to this one instance: no one-off values unless they are always the same.
- Give one default way to do each step; mention an alternative only as a brief fallback.
- Keep it moderate: short numbered steps, and a "## Gotchas" section for non-obvious facts and past mistakes. Well under 500 lines.
- Description: 1-3 sentences, under 1024 characters, imperative and about what the user wants: "Use this skill when the user wants to ..., even if they don't mention ...". Name the situations it applies to, not how it works inside.`;

const GENERIC = [
  /handle (all )?errors? appropriately/i, /follow (the )?best practices/i, /as (needed|appropriate)\b/i,
  /ensure (that )?everything (works|is correct)/i, /use (your|good) judg(e)?ment/i, /be careful to/i
];

/** Warnings for a skill, each a plain sentence. Empty when it looks right. */
export function lintSkill({ name = '', description = '', body = '' } = {}) {
  const w = [];
  const desc = String(description).trim();
  const text = String(body);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) w.push('The name should be lowercase words joined by hyphens, at most 64 characters.');
  if (desc.length > 1024) w.push(`The description is ${desc.length} characters; the limit is 1024.`);
  if (desc.length < 40) w.push('The description is too short to tell when the skill applies.');
  if (!/\b(use (this|it|when)|when (the )?(user|you|operator)|whenever|if (the )?(user|you))\b/i.test(desc)) w.push('The description should say when to use the skill ("Use this skill when …").');
  const lines = text.split('\n').length;
  const tokens = Math.round(text.length / 4);
  if (lines > 500 || tokens > 5000) w.push(`The body is long (${lines} lines, about ${tokens} tokens); the guideline is under 500 lines and 5,000 tokens.`);
  if (!/^\s*(\d+\.|[-*] \[ \]|#{1,3} )/m.test(text)) w.push('The body has no numbered steps or sections.');
  for (const g of GENERIC) if (g.test(text)) { w.push(`Generic advice ("${text.match(g)[0]}") adds nothing an agent doesn't already know.`); break; }
  return w;
}

/** Append a correction to the body's "## Gotchas" section (created if missing); no duplicate lines. */
export function addGotcha(body, gotcha) {
  const line = String(gotcha || '').replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim();
  const text = String(body || '').replace(/\s+$/, '');
  if (!line) return text;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const m = text.match(/^##\s*Gotchas\s*$/im);
  if (!m) return `${text}\n\n## Gotchas\n\n- ${line}\n`;
  const start = m.index + m[0].length;
  const next = text.slice(start).search(/^##\s/m);
  const end = next === -1 ? text.length : start + next;
  const section = text.slice(start, end);
  if (section.split('\n').some(l => norm(l) === norm(line))) return `${text}\n`;
  const updated = `${section.replace(/\s+$/, '')}\n- ${line}\n`;
  return `${text.slice(0, start)}${updated}${end < text.length ? `\n${text.slice(end)}` : ''}`.replace(/\n{3,}/g, '\n\n');
}

/**
 * The guide's trigger eval, against this agent's matcher: the side-model writes realistic
 * requests that should use the skill (some without naming its domain) and near-misses that
 * share its words but need something else; each is run through service.match().
 * @returns {Promise<{name, recall, falseTriggers, passRate, cases}>}
 */
export async function evaluateTriggers({ service, providerManager, name, count = 8 }) {
  const skill = await service.get(name);
  if (!skill) throw new Error(`No skill named "${name}"`);
  const gen = providerManager?.generateAux || providerManager?.generateResponse;
  if (!gen) throw new Error('No model available to write test requests');
  const res = await gen.call(providerManager, `Write test requests for deciding whether an AI agent should use this skill.

Skill: ${skill.name}
Description: ${skill.description}
Steps (for context): ${String(skill.body).slice(0, 1500)}

Write ${count} realistic requests a user might send that SHOULD use this skill: vary the phrasing (casual, terse, detailed, one with a typo), and make at least half of them describe the need without naming the skill's domain. Then write ${count} NEAR-MISS requests that share words or concepts with the skill but need something else. Plain user messages, no numbering.
Answer JSON only: {"should": ["..."], "shouldNot": ["..."]}`, { maxTokens: 1200, temperature: 0.7, auxTask: 'skill-trigger-eval' });
  let d;
  try { d = JSON.parse(String(res?.content || '').match(/\{[\s\S]*\}/)[0]); } catch { throw new Error('The model did not return test requests'); }
  const cases = [];
  for (const [list, expected] of [[d.should || [], true], [d.shouldNot || [], false]]) {
    for (const query of list.slice(0, count)) {
      const hits = await service.match(String(query), { limit: 3 }).catch(() => []);
      const triggered = hits.some(h => h.name === skill.name);
      cases.push({ query: String(query), expected, triggered, pass: triggered === expected });
    }
  }
  const should = cases.filter(c => c.expected), not = cases.filter(c => !c.expected);
  return {
    name: skill.name,
    recall: should.length ? should.filter(c => c.triggered).length / should.length : null,
    falseTriggers: not.filter(c => c.triggered).length,
    passRate: cases.length ? cases.filter(c => c.pass).length / cases.length : null,
    cases
  };
}
