/**
 * "Yes, take the action" — a go-ahead for something proposed in the conversation.
 *
 * On its own the message names no action, so intent detection finds nothing and the
 * conversational follow-up answered it with a text-only model call. That call cannot act,
 * yet it replied "Done — I appended a section to card 176" when nothing was written
 * (Trellis, 2026-09-29). A go-ahead is resolved here into the standalone request it
 * approves, which then runs through the normal command pipeline.
 */

// Short approvals only: "yes", "go ahead", "yes @Alice take the action", "please do it".
const APPROVAL = /^(?:(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|confirmed?|approved?|go ahead|do it|proceed|go for it)\b[\s,.!]*)+(?:(?:please\s+)?(?:take|do|perform|run|execute|make|go ahead with|proceed with)\s+(?:the|that|this|it|your)\b.*)?$/i;
const ACTION_PHRASE = /^(?:please\s+)?(?:take|do|perform|run|execute|go ahead with|proceed with)\s+(?:the|that|this|it)\s+(?:action|change|edit|step|thing|update|append)s?\b/i;

export const NO_ACTION = 'NO_ACTION';

// "Don't do it yet", "just draft it", "what would you write if…": the user wants to see the
// action before it runs. The router executed these at once (2026-09-29, Trellis card 177).
const DEFERRAL = /\b(?:don'?t|do not)\s+(?:do|run|send|post|write|append|make|change|execute)\s+(?:it|that|this|anything)\s+yet\b|\b(?:don'?t|do not)\s+do\s+anything\s+yet\b|\bjust\s+(?:draft|preview|show me|tell me)\b|\bwhat\s+would\s+you\s+(?:write|append|send|post|say|change|do)\b|\bbefore\s+you\s+do\s+anything\b|\bI'?ll\s+confirm\b|\bwait\s+for\s+my\s+(?:ok|okay|go[- ]ahead|confirmation)\b/i;

/** True when the message asks to see a proposed action before it runs. */
export function isDeferredRequest(input) {
  return DEFERRAL.test(String(input || ''));
}

/** True for a short message that approves a proposed action without naming it. */
export function isActionConfirmation(input) {
  const text = String(input || '').replace(/@[\w.-]+[,:]?/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!text || text.split(/\s+/).length > 12) return false;
  return APPROVAL.test(text) || ACTION_PHRASE.test(text);
}

/**
 * Turn the go-ahead into the request it approves, from the recent conversation.
 * @param {object} p
 * @param {(prompt: string, opts: object) => Promise<any>} p.generate - providerManager.generateResponse
 * @param {string} p.conversation - recent turns, oldest first
 * @param {string} p.input - the go-ahead itself
 * @returns {Promise<string|null>} a standalone instruction, or null when nothing was proposed
 */
export async function resolveConfirmation({ generate, conversation, input }) {
  const prompt =
    `The user just replied "${String(input).slice(0, 200)}" to the conversation below. ` +
    `Find the concrete action that was proposed or asked for most recently — by the assistant or ` +
    `another participant — that the user is now approving.\n` +
    `Write it as ONE standalone instruction the assistant can carry out with no other context: ` +
    `name every target exactly (card numbers, file names, recipients) and include the full content ` +
    `to write or send, verbatim where it was already drafted.\n` +
    `If no action was proposed, answer with exactly ${NO_ACTION}.\n\n` +
    `Conversation:\n${conversation}\n\nInstruction:`;
  const res = await generate(prompt, { maxTokens: 1200, temperature: 0 });
  const text = String(res?.content || res?.text || '').trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!text || text.startsWith(NO_ACTION)) return null;
  return text;
}

/**
 * An instruction to work something out or make something, rather than to fetch or run one thing:
 * "come up with a test", "work together on…", "design / draft / plan …". Used only for messages
 * sent to several agents at once, where the one-shot router misreads them.
 */
/**
 * A request that only means something with the channel conversation: "add to the card as
 * requested", "do your part", "add yours". Without it, the one-shot router read "add to the card
 * as requested" as a question and answered it with text (card 21 #1281, 2026-10-01).
 */
export function refersToConversation(text) {
  const t = String(text || '').split(/\n\n\(Note for /)[0];
  return /\b(as (?:requested|asked|discussed|agreed|planned|instructed)|like (?:the others|everyone else|they did)|your (?:part|block|section|share|bit|items?|suggestions?)|add (?:yours|it|that|them|to (?:it|that|the card))|the (?:card|task) (?:above|we|they|everyone)|(?:do|finish|complete) (?:it|that|the task|your part))\b/i.test(t);
}

export function isOpenEndedTask(text) {
  const t = String(text || '').split(/\n\n\(Note for /)[0];
  return /\b(come up with|work (?:it out )?together|collaborate|agree on|figure out|design|draft|propose|plan out|put together|brainstorm|write up|develop|devise)\b/i.test(t);
}
