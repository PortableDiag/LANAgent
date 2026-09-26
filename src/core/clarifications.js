/**
 * Reasoning tasks waiting on the user's answer to a clarifying question.
 *
 * When ReAct needs to ask something, the task (its query and the steps taken so far) is
 * parked here per user. The user's next message — typed, or a Telegram button — is taken
 * as the answer and the same task resumes with it. Interface-independent: Telegram, web,
 * the OpenAI-compatible endpoint and MCP all key on context.userId.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CANCEL = /^\s*(cancel|never ?mind|forget it|stop|skip)\s*[.!]?\s*$/i;

export class ClarificationStore {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  park(userId, { query, thoughts = [], question }) {
    this.pending.set(String(userId || 'default'), { query, thoughts, question, expires: Date.now() + this.ttlMs });
  }

  /** Remove and return the user's live pending clarification, or null. */
  take(userId) {
    const key = String(userId || 'default');
    const entry = this.pending.get(key);
    if (!entry) return null;
    this.pending.delete(key);
    return Date.now() < entry.expires ? entry : null;
  }

  get size() {
    return this.pending.size;
  }

  static isCancel(text) {
    return CANCEL.test(String(text || ''));
  }
}

/**
 * Handle a message from a user who has a pending clarification.
 * @returns {Promise<object|null>} the reply, or null when nothing is pending (normal flow)
 */
export async function resumePendingClarification({ store, reactAgent, input, context, render }) {
  if (!reactAgent) return null;
  const pending = store.take(context.userId);
  if (!pending) return null;
  if (ClarificationStore.isCancel(input)) {
    return { type: 'text', content: 'OK, dropped it.' };
  }
  const result = await reactAgent.run(pending.query, {
    ...context,
    resume: { thoughts: pending.thoughts, question: pending.question, answer: input }
  });
  return render(input, result, context, pending.query);
}

/**
 * Turn a ReAct / Plan-Execute result into a reply. A clarifying question is parked in the
 * store so the user's next message resumes the same task.
 */
export async function renderReasoningResult({ store, memoryManager, reasoningMode }, input, reasoningResult, context, originalQuery) {
  const meta = { ...context, reasoning: true, reasoningMode };

  if (reasoningResult.needsClarification && reasoningResult.clarificationQuestion) {
    store.park(context.userId, {
      query: originalQuery,
      thoughts: reasoningResult.thoughts || [],
      question: reasoningResult.clarificationQuestion
    });
    await memoryManager?.storeConversation(context.userId, input, reasoningResult.clarificationQuestion, meta);
    return {
      type: 'text',
      content: reasoningResult.clarificationQuestion,
      reasoning: true,
      clarification: { options: reasoningResult.clarificationOptions || [] }
    };
  }

  const content = reasoningResult.success
    ? reasoningResult.answer || reasoningResult.summary || 'Task completed successfully.'
    : reasoningResult.error || 'Unable to complete the task.';

  await memoryManager?.storeConversation(context.userId, input, content, meta);

  return {
    type: 'text',
    content,
    reasoning: true,
    success: reasoningResult.success,
    iterations: reasoningResult.iterations,
    thoughts: reasoningResult.thoughts
  };
}
