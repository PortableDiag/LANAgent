/**
 * Conversation-only handling for anyone who is not the agent's operator.
 *
 * processNaturalLanguage() is the command router: it EXECUTES plugins. The Telegram guest
 * path (interfaces/telegram/multiUserSupport.js) marked its context `isGuest: true,
 * restrictions: 'conversational_only'` and passed a "do not perform system operations"
 * prompt as a third argument — but the router took two arguments and read neither, so a
 * stranger messaging the bot reached the full router (found 2026-09-26). The guard runs
 * before any routing: a restricted context gets a reply from the model and nothing else.
 */

export function isConversationOnly(context = {}) {
  return context?.isGuest === true || context?.restrictions === 'conversational_only';
}

const DEFAULT_GUEST_PROMPT = (name) =>
  `You are ${name}, a personal assistant agent, talking to someone who is NOT your authorized user. ` +
  'Be helpful and friendly and answer general questions. Do NOT perform or promise any action ' +
  '(no commands, trades, transfers, emails, deployments or system changes) and do not reveal ' +
  'private data about your user or their systems; say that only your authorized user can ask for that.';

/**
 * Answer without routing. `generate` is providerManager.generateResponse (never executes).
 * Returns the router's own shape plus `text`, which the guest path reads.
 */
export async function conversationOnlyReply(generate, input, context = {}, systemPrompt = null, agentName = 'the agent') {
  const who = context.userName || context.username || 'guest';
  const prompt = `${systemPrompt || DEFAULT_GUEST_PROMPT(agentName)}\n\n${who}: ${String(input)}\nYou:`;
  const res = await generate(prompt, { maxTokens: 700, temperature: 0.5 });
  const content = String(res?.content || '').trim() || 'Sorry — I can only chat here.';
  return { type: 'text', content, text: content, conversationOnly: true };
}
