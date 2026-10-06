import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';
import NodeCache from 'node-cache';
import { listTools, selectRelevantTools, formatToolsForPrompt, executeTool, findPastExamples, DESCRIBE_TOOL, SEARCH_TOOL } from './toolCatalog.js';
import { getSkillsService, learnSkillFromTask } from '../skills/skillsService.js';
import { promisesFollowUp, scheduleFollowUp } from '../followUps.js';
import { TodoList, TODO_TOOL, TODO_TOOL_PROMPT, runTodoTool } from './todoList.js';

// Steps spent only on the to-do list do not use up maxIterations, up to this many per run
export const FREE_TODO_STEPS = 3;

/**
 * ReActAgent - Implements the ReAct (Reasoning + Acting) pattern
 *
 * The ReAct pattern interleaves reasoning (thinking) with acting (tool use)
 * in a loop: Thought -> Action -> Observation -> Thought -> ...
 *
 * This allows the agent to:
 * - Break down complex tasks step by step
 * - Adjust strategy based on observations
 * - Provide transparent reasoning traces
 */

/**
 * What a final answer claims was written (a channel message, a card) when no successful step
 * wrote it; null when every such claim is backed by a step.
 */
export function unbackedWriteClaim(answer, thoughts = []) {
  const text = String(answer || '');
  const done = thoughts
    .filter(t => t.type === 'observation' && t.content && t.content.success !== false)
    .map(t => String(t.content.command || ''));
  const claims = [
    [/\b(posted|replied|sent|shared)\b[^.\n]{0,80}\b(channel|trellis|card\s*#?\d+|chat)\b|\b(channel|card\s*#?\d+)\b[^.\n]{0,40}\b(posted|replied)\b/i,
      /^(replyChannel|say|postMessage|sendMessage|reply\w*|post\w*)$/i, 'that a message was posted'],
    [/\b(appended|recorded|wrote|written)\b[^.\n]{0,60}\b(card|trellis)\b|\b(added|updated)\b[^.\n]{0,20}\b(to|on)\s+(trellis\s+)?card\b/i,
      /^(append\w*|create\w*|update\w*|set\w*|edit\w*|write\w*|replyChannel|move\w*|add\w*)$/i, 'that a card was written']
  ];
  for (const [said, did, what] of claims) {
    if (said.test(text) && !done.some(c => did.test(c))) return what;
  }
  return null;
}


/** The request without the notes a channel listener appends ("(Note for ALICE: …)"). */
export function stripListenerNotes(text) {
  return String(text || '').replace(/\n*\(Note for [^:]{1,40}:[\s\S]*?\)\s*$/g, '').replace(/\n*\(Note for [^:]{1,40}:[\s\S]*?\)(?=\s*\(Note for|\s*$)/g, '').trim() || String(text || '');
}


/**
 * Statements in a final answer that no step supports, by one auxiliary-model call. Best effort:
 * no model, a failed call or an unreadable reply returns [] and the answer stands.
 */
const AUDIT_RESULT_CHARS = 4000;
const AUDIT_STEPS_CHARS = 40000;

export async function auditAnswer(providerManager, answer, thoughts = [], { name = null, conversation = '' } = {}) {
  if (!(providerManager?.generateResponse || providerManager?.generateAux) || !answer) return [];
  const steps = [];
  for (const t of thoughts) {
    if (t.type === 'action') steps.push(`ACTION ${t.content.tool}.${t.content.command} ${JSON.stringify(t.content.params || {}).slice(0, 300)}`);
    else if (t.type === 'observation' && t.content?.tool !== 'check') {
      const c = t.content || {};
      // 900 chars per result hid most of a paper, a picture's description and a channel read, so
      // facts taken from them were refused as unsupported (card 21 #3259, 2026-10-06).
      steps.push(`RESULT ${c.success === false ? 'FAILED ' + String(c.error || '').slice(0, 150) : 'ok ' + JSON.stringify(c.result ?? c).slice(0, AUDIT_RESULT_CHARS)}`);
    }
  }
  const targets = [...new Set(thoughts.filter(t => t.type === 'action').map(t => {
    const q = t.content?.params || {};
    return `${t.content?.tool}.${t.content?.command} ${q.url || (q.card !== undefined ? `card ${q.card}` : '')}`.trim();
  }))];
  const prompt = 'You check an AI agent\'s report against the steps it actually ran.\n\nEVERYTHING IT CALLED (nothing else was fetched or checked):\n' + targets.join('\n').slice(0, 3000) +
    '\n\nSTEPS (in order):\n' + steps.join('\n').slice(-AUDIT_STEPS_CHARS) +
    // Who is who: card 21 #3268 (2026-10-06) posted Nexus's item, design and "I'll wire the Hermes
    // adapter" in the first person, at step 1, from a channel tail that was mostly Nexus's messages.
    (conversation ? `\n\nTHE CHANNEL THIS REPORT GOES TO (other participants' words, not the agent's results):\n${String(conversation).slice(-6000)}` : '') +
    '\n\nREPORT' + (name ? ` (written by ${name})` : '') + ':\n' + String(answer).slice(0, 3000) +
    '\n\nList each statement in the REPORT that says the agent itself did, fetched, checked, created, sent or found something that NO step above shows ' +
    '(e.g. "checked both tasks" when only one was fetched, or a size/number for an item whose URL is not in the list above). Counts, ids, sizes and status codes must come from the RESULTS. Statements about what others did, plans, or ' +
    'admissions of what was not done are fine' + (name ? `, EXCEPT another participant's work, assignment, design or plan restated as ${name}'s own ("my item 4", "I'll wire the adapter" when the channel shows another agent owns it): list those` : '') + '. Reply with JSON only: {"unsupported": ["<short quote>", ...]} — an empty list if every claim is backed.';
  try {
    // The main model: the auxiliary one passed #1744's invented delete and picture post.
    const generate = providerManager.generateResponse ? providerManager.generateResponse.bind(providerManager) : providerManager.generateAux.bind(providerManager);
    const res = await generate(prompt, { maxTokens: 300, temperature: 0, auxTask: 'answer-audit' });
    const m = String(res?.content || res || '').match(/\{[\s\S]*\}/);
    const list = m ? JSON.parse(m[0]).unsupported : [];
    return Array.isArray(list) ? list.map(String).filter(Boolean).slice(0, 5) : [];
  } catch {
    return [];
  }
}


/** Iterations of earlier steps that made exactly this call (same tool, command and params). */
export function identicalCalls(action, thoughts = []) {
  const key = (a) => `${a?.tool}.${a?.command}:${JSON.stringify(a?.params || {})}`;
  const k = key(action);
  return thoughts.filter((t, i) => t.type === 'action' && key(t.content) === k &&
    !(thoughts[i + 1]?.type === 'observation' && thoughts[i + 1].content?.refused)).map(t => t.iteration);
}


/**
 * An earlier successful step this action would duplicate: a second channel post or card write
 * to the same card, or a second POST/PUT/PATCH/DELETE to the same URL. Null when the action is
 * new, the earlier one failed, or params.allowRepeat is set.
 */
export function repeatedSideEffect(action, thoughts = []) {
  const p = action?.params || {};
  if (p.allowRepeat === true) return null;
  const keyOf = (a) => {
    const q = a?.params || {};
    // A channel post or append is a duplicate only with the same text (a second, different
    // message to the same channel is ordinary: the v0.88.0 checks post a picture, a thread
    // reply and a bad-thread probe to one test channel). Creates are keyed by title.
    if (a?.tool === 'trellis-notes' && /^(replyChannel|say|appendNote)$/.test(String(a.command))) {
      const text = String(q.text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}|https?:\S+|\d+/g, '#').trim().slice(0, 160);
      return `trellis:${a.command === 'appendNote' ? 'append' : 'post'}:${q.card ?? ''}:${text}:${[].concat(q.files || []).length}`;
    }
    if (a?.tool === 'trellis-notes' && /^(createNote|createTask|createImageCard)$/.test(String(a.command))) {
      return `trellis:${a.command}:${String(q.title ?? '').toLowerCase()}`;
    }
    if (a?.tool === 'http' && a.command === 'request') {
      const method = String(q.method || (q.json || q.form || q.body || q.multipart ? 'POST' : 'GET')).toUpperCase();
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return `http:${method}:${String(q.url || '').split('?')[0]}`;
    }
    return null;
  };
  const key = keyOf(action);
  if (!key) return null;
  for (let i = 0; i < thoughts.length - 1; i++) {
    const t = thoughts[i];
    if (t.type !== 'action' || keyOf(t.content) !== key) continue;
    const o = thoughts[i + 1];
    // Something failed after it (a register call rejected): starting that part over is a retry,
    // not a duplicate, e.g. a fresh signup challenge.
    const failedSince = thoughts.slice(i + 2).some(x => x.type === 'observation' && x.content?.success === false && !x.content?.refused && x.content?.tool !== 'check');
    if (failedSince) continue;
    if (o?.type === 'observation' && o.content && o.content.success !== false && !o.content.refused) {
      const r = o.content.result || {};
      const summary = [r.status && `HTTP ${r.status}`, r.data?.task_id && `task ${r.data.task_id}`, r.seq && `message #${r.seq}`].filter(Boolean).join(', ') || 'succeeded';
      return { iteration: t.iteration, summary };
    }
  }
  return null;
}


/**
 * Tool commands a report names as done that never ran successfully in this run. Deterministic,
 * no model: #1744 (2026-10-02) said "deleteCard with confirmTitle succeeded" for a delete that
 * never ran, and the model-based check let it through.
 */
export function unrunCommandsNamed(text, thoughts = [], knownCommands = []) {
  const done = new Set(thoughts
    .filter((t, i) => t.type === 'action' && thoughts[i + 1]?.type === 'observation' && thoughts[i + 1].content?.success !== false && !thoughts[i + 1].content?.refused)
    .map(t => String(t.content?.command || '')));
  const named = [];
  for (const cmd of new Set(knownCommands)) {
    if (!cmd || cmd.length < 6 || !/[A-Z]/.test(cmd)) continue;     // camelCase names only: "readCard", not "list"
    if (new RegExp(`\\b${cmd}\\b`).test(String(text || '')) && !done.has(cmd)) named.push(cmd);
  }
  return named;
}

export class ReActAgent extends EventEmitter {
  constructor(agent, options = {}) {
    super();
    this.agent = agent;
    this.maxIterations = options.maxIterations || 10;
    this.thoughtTimeout = options.thoughtTimeout || 30000; // 30 seconds per thought
    this.showThoughts = options.showThoughts || false;
    this.thoughtStore = options.thoughtStore || null;
    this.executionBudget = options.executionBudget || options.budget || {};
    this.activeRun = null;

    // Build tool descriptions from available plugins
    this.tools = [];
    this.toolMap = new Map();
    this.toolPerformanceCache = new NodeCache({ stdTTL: 3600 });
  }

  /**
   * Initialize the agent with available tools/plugins
   */
  async initialize() {
    await this.refreshTools();
    logger.info(`ReActAgent initialized with ${this.tools.length} tools`);
  }

  /**
   * Refresh the list of available tools from plugins. The catalog is read live on every
   * run; this snapshot only serves getState() and the startup log.
   */
  async refreshTools(context = null) {
    this.tools = listTools(this.agent, context);
    this.toolMap = new Map(this.tools.map(t => [t.name, t]));
  }

  /**
   * Create a bounded promise that observes cooperative cancellation.
   */
  async _boundedOperation(operation, timeoutMs, signal, label) {
    if (signal?.aborted) {
      throw this._terminationError('cancelled', 'Execution was cancelled');
    }

    let timer;
    let abortHandler;
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(this._terminationError('budgetExceeded', `${label} exceeded its ${timeoutMs}ms limit`));
          }, timeoutMs);
        })
      : null;
    const cancellation = signal
      ? new Promise((_, reject) => {
          abortHandler = () => reject(this._terminationError('cancelled', 'Execution was cancelled'));
          signal.addEventListener('abort', abortHandler, { once: true });
        })
      : null;

    try {
      const promises = [operation()];
      if (timeout) promises.push(timeout);
      if (cancellation) promises.push(cancellation);
      return await Promise.race(promises);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }

  /**
   * Construct an internal termination error with machine-readable metadata.
   */
  _terminationError(type, reason) {
    const error = new Error(reason);
    error.terminationType = type;
    return error;
  }

  /**
   * Check whether the current run may continue.
   */
  _checkBudget(run) {
    if (run.signal?.aborted) {
      throw this._terminationError('cancelled', 'Execution was cancelled');
    }

    const elapsed = Date.now() - run.startTime;
    if (run.budget.timeoutMs !== undefined && elapsed >= run.budget.timeoutMs) {
      throw this._terminationError('budgetExceeded', `Execution exceeded its ${run.budget.timeoutMs}ms time budget`);
    }

    if (run.budget.maxToolCalls !== undefined && run.toolCalls >= run.budget.maxToolCalls) {
      throw this._terminationError('budgetExceeded', `Maximum tool-call budget of ${run.budget.maxToolCalls} was reached`);
    }
  }

  /**
   * Return a structured result for a cancelled or budget-limited run.
   */
  _terminationResult(error, thoughts, iteration, startTime) {
    const cancelled = error.terminationType === 'cancelled';
    const result = {
      success: false,
      ...(cancelled ? { cancelled: true } : { budgetExceeded: true }),
      reason: error.message,
      error: error.message,
      thoughts,
      iterations: iteration,
      duration: Date.now() - startTime
    };
    this.emit(cancelled ? 'cancelled' : 'budgetExceeded', result);
    return result;
  }

  /**
   * Run the ReAct loop for a given query
   */
  async run(query, context = {}) {
    // Resuming after a clarification: keep the earlier steps and add the user's answer
    const resume = context.resume;
    const thoughts = resume?.thoughts ? [...resume.thoughts] : [];
    if (resume) {
      thoughts.push({
        type: 'observation',
        content: `You asked the user: "${resume.question}". The user answered: "${resume.answer}"`,
        iteration: 0,
        timestamp: new Date()
      });
    }

    // The task's own to-do list (per run, in memory), carried over a clarification pause
    const todo = new TodoList();
    ReActAgent.replayTodo(todo, thoughts);
    const withTodo = r => (todo.empty ? r : { ...r, todo: todo.snapshot() });
    // Progress line for the user, with the to-do list under it when there is one
    const progress = async (line) => {
      if (!context.showThinking) return;
      const list = todo.render();
      const text = [line, list].filter(Boolean).join('\n\n');
      if (text) await context.showThinking(text);
    };

    const signal = context.signal || context.abortSignal;
    const budget = { ...this.executionBudget, ...(context.budget || context.executionBudget || {}) };
    const run = {
      signal,
      budget,
      startTime: Date.now(),
      toolCalls: 0,
      iteration: 0,
      todo
    };
    this.activeRun = run;

    let iteration = 0;
    const startTime = run.startTime;

    logger.info(`ReActAgent starting with query: ${query.substring(0, 100)}...`);
    this.emit('start', { query, context, budget });

    try {
      this._checkBudget(run);

      // Tools and worked examples are chosen once per task: the plugins relevant to it get
      // full command lists, and similar tasks that succeeded before are shown as examples.
      await this.refreshTools(context);
      const relevant = await selectRelevantTools(this.agent, stripListenerNotes(query), { available: this.tools });
      // A web or API task gets the http tool's full usage, not a one-line catalog entry: listed
      // only by name, it went unused and the run asked the operator to "enable the HTTP tool"
      // (2026-10-02).
      if (/\b(api|https?|url|endpoint|sign ?up|register|webhook|upload|post|\w+\.(?:com|net|org|io|ai|dev|app))\b/i.test(query)
        && this.tools.some(t => t.name === 'http') && !relevant.includes('http')) relevant.unshift('http');
      const pastExamples = await findPastExamples(this.thoughtStore, stripListenerNotes(query));
      if (pastExamples) logger.info('ReAct: reusing similar past reasoning as examples');
      // Matched on the request alone: the listener's "(Note for ALICE: this message also goes to
      // Nexus, trellis, Orbit…)" is all Trellis-and-agents words, and with it every channel request
      // matched run-standard-agent-test (0.77-0.84). On card 21 #1574 ("test reapption and send
      // me your link") that skill took the run to card 209 and reapption was never called.
      const request = stripListenerNotes(query);
      const skills = await getSkillsService().promptFor(request).catch(() => '');
      if (skills) logger.info('ReAct: following a matching skill');
      // A request from a shared Trellis channel only makes sense with that conversation: "do you
      // all agree on the steps?" is about cards and messages ReAct otherwise never sees. On card
      // 21 #1255 (2026-10-01) it answered that it could not see the steps of a test it had run
      // and signed the day before.
      const auditWho = { name: this.agent?.config?.name || 'ALICE', conversation: context.trellis?.recent || '' };
      const channel = context.trellis?.recent
        ? `This request came from a shared Trellis channel (card ${context.trellis.card}). The conversation there, oldest first (your own messages are signed ${this.agent?.config?.name || 'ALICE'}):\n${String(context.trellis.recent).slice(-4000)}\n\nCards it mentions ("#209", "the test", "the card in this workspace") are in the Trellis workspace: find them with the trellis-notes search and read actions before saying you cannot see them. A Trellis feature none of the trellis-notes commands covers (a new route or field from a release note) is reachable with trellis-notes.api: read GET /api (the route index) for the route and its body, then call it.`
        : '';
      const guidance = { relevant, pastExamples, skills, todo, channel };
      let freeTodoSteps = 0;

      while (iteration < this.maxIterations + freeTodoSteps) {
        this._checkBudget(run);
        iteration++;
        run.iteration = iteration;
        logger.info(`ReAct iteration ${iteration}/${this.maxIterations + freeTodoSteps}`);

        // Step 1: THOUGHT - Reason about current state
        const thought = await this._boundedOperation(
          () => this.think(query, thoughts, { ...context, signal }, guidance),
          // Only an explicit per-step budget bounds a thought. thoughtTimeout (30 s) was
          // never enforced and sits far below the provider's own retry budget, so racing
          // it would abort slow-but-healthy providers.
          budget.maxActionDurationMs,
          signal,
          'Thinking'
        );
        thoughts.push({ type: 'thought', content: thought, iteration, timestamp: new Date() });
        this.emit('thought', { iteration, thought });

        if (this.showThoughts && context.showThinking) {
          await context.showThinking(`💭 Thinking: ${thought.reasoning?.substring(0, 100)}...`);
        }

        // A to-do list sent alongside the step ("todo": [...]) is applied first
        if (Array.isArray(thought.todo)) {
          const before = todo.revision;
          try { todo.write(thought.todo); } catch { /* malformed list: keep the old one */ }
          if (todo.revision !== before && !thought.action?.tool && !thought.finalAnswer) await progress('');
        }

        // An action and a final answer in the same step: the action runs, the answer waits for
        // its result. Answer-first, "No verification checks were completed" ended a run at step
        // 1 with its testClip action never run (2026-10-02).
        if (thought.finalAnswer && thought.action?.tool) {
          logger.info('ReAct: step had both an action and a final answer; running the action first');
          thought.finalAnswer = null;
        }

        // A final answer that says a message was posted or a card written, when no step did it:
        // "The results were posted to Trellis channel 21" with no post (card 21, 2026-10-02). Sent
        // back once to actually do it; a second unbacked claim is corrected in the answer.
        if (thought.finalAnswer) {
          const claim = unbackedWriteClaim(thought.finalAnswer, thoughts);
          if (claim && !run.claimChecked) {
            run.claimChecked = true;
            logger.info(`ReAct: final answer claims ${claim} but no step did it; sending it back`);
            thoughts.push({ type: 'observation', iteration, timestamp: new Date(), content: {
              tool: 'check', command: 'verify', success: false,
              error: `Your answer says ${claim}, but no step did that. Do it now with the tool (a Trellis channel message is trellis-notes.replyChannel with the card and text; a card write is trellis-notes.appendNote), then give the final answer.`
            } });
            continue;
          }
          // Claims the write check cannot see: "I fetched reaction details and receipts for both
          // ready tasks" after one receipt fetch and no reaction fetch (card 21 #1591). One cheap
          // model call compares the answer with the steps; once per run.
          if (!claim && !run.answerAudited && thoughts.some(t => t.type === 'action')) {
            run.answerAudited = true;
            const unsupported = await auditAnswer(this.agent?.providerManager, thought.finalAnswer, thoughts, auditWho);
            if (unsupported.length) {
              run.answerFlagged = true;
              logger.info(`ReAct: final answer has ${unsupported.length} claim(s) no step supports; sending it back`);
              thoughts.push({ type: 'observation', iteration, timestamp: new Date(), content: {
                tool: 'check', command: 'verify', success: false,
                error: `Your answer claims things no step in this run did: ${unsupported.map(u => `"${u}"`).join('; ')}. Either do them now with tools, or give a final answer that states only what the steps show and says plainly what was not done.`
              } });
              continue;
            }
          }
          if (claim) {
            // Twice unbacked: the answer is not trusted at all (card 21 #1583 posted another
            // agent's findings as its own under a correction line). Say what really ran.
            const ran = thoughts.filter(t => t.type === 'action').map(t => `${t.content.tool}.${t.content.command}`);
            thought.finalAnswer = `I have not finished this. My draft answer said ${claim}, but no step did that, so I am not reporting it.` +
              (ran.length ? ` What actually ran: ${[...new Set(ran)].join(', ')}.` : ' No tool ran.');
            thought.unfinished = true;
          }
        }

        // Check if we have a final answer
        if (thought.finalAnswer) {
          const result = withTodo({
            success: !thought.unfinished,
            answer: thought.finalAnswer,
            thoughts,
            iterations: iteration,
            duration: Date.now() - startTime
          });

          // A promise to come back ("I'll poll again and report") is kept: if the answer or a
          // post in this run makes one and no follow-up was scheduled, schedule it now. On
          // 2026-10-02 such a promise had nothing behind it and a reaction went unreported.
          if (!context.followUp) {
            const posted = thoughts.filter(t => t.type === 'action' && t.content?.tool === 'trellis-notes'
              && /^(replyChannel|say|appendNote)$/.test(String(t.content.command))).map(t => String(t.content.params?.text || ''));
            const scheduled = thoughts.some((t, i) => t.type === 'action' && t.content?.tool === 'followup'
              && thoughts[i + 1]?.content?.success !== false);
            if (!scheduled && [result.answer, ...posted].some(promisesFollowUp)) {
              scheduleFollowUp(this.agent, { task: stripListenerNotes(query), context, reason: 'promised in the answer' })
                .then(w => w && logger.info(`ReAct: the answer promised a follow-up; scheduled for ${w.toISOString()}`))
                .catch(err => logger.warn(`ReAct: could not schedule the promised follow-up: ${err.message}`));
            }
          }

          // Store thought chain if thought store is available
          if (this.thoughtStore) {
            await this.thoughtStore.saveThoughtChain(query, thoughts, result);
          }

          // Turn a multi-step success into a reusable skill (best effort, not awaited)
          // Only a clean run teaches: one the claim checks sent back, refused a post or a repeat
          // in, or that ended unfinished is not a procedure to repeat. "react-to-task-status" was
          // learned from such a run (2026-10-02) with an invented step.
          const clean = result.success && !run.claimChecked && !run.answerFlagged
            && !thoughts.some(t => t.type === 'observation' && (t.content?.refused || t.content?.tool === 'check'));
          if (clean) learnSkillFromTask({ providerManager: this.agent.providerManager, query, thoughts, answer: result.answer });
          else logger.info('ReAct: not learning a skill from this run (it was corrected or unfinished)');

          this.emit('complete', result);
          return result;
        }

        // Check if we need more information (clarification)
        if (thought.needsClarification) {
          return withTodo({
            success: false,
            needsClarification: true,
            clarificationQuestion: thought.clarificationQuestion,
            clarificationOptions: thought.clarificationOptions,
            thoughts,
            iterations: iteration,
            duration: Date.now() - startTime
          });
        }

        // The to-do tool is pure state on this run: no plugin, no tool-call budget
        if (thought.action?.tool === TODO_TOOL) {
          const before = todo.revision;
          const observation = runTodoTool(todo, thought.action.params || {});
          thoughts.push({ type: 'observation', content: observation, iteration, timestamp: new Date() });
          this.emit('todo', { iteration, todo: observation.result });
          if (todo.revision !== before) await progress('📝 To-do updated');
          if (freeTodoSteps < FREE_TODO_STEPS) freeTodoSteps++;
          continue;
        }

        // Step 2: ACTION - Decide what tool to use
        if (thought.action && thought.action.tool) {
          this._checkBudget(run);
          const action = thought.action;

          // A side effect that already succeeded in this run is never repeated: on 2026-10-02 a
          // run rewrote its to-do list from scratch after each post and created 6 reapption tasks
          // and 5 channel posts for one request. The refusal tells it what it already did.
          // A report posted as a step is checked like a final answer, before it goes out: #1616
          // (2026-10-02) posted reaction sizes for tasks it never fetched, copied from other
          // agents' messages, and only the final answer was being checked. Once per run.
          const reportText = action.tool === 'trellis-notes' && /^(replyChannel|say|appendNote)$/.test(String(action.command))
            ? String(action.params?.text || '') : '';
          // Also at step 1 in a channel: a reply composed from the transcript alone has no step behind it.
          if (reportText.length > 120 && !run.writeAudited && (thoughts.some(t => t.type === 'action') || context.trellis?.recent)) {
            run.writeAudited = true;
            const known = (this.tools || []).flatMap(t => (t.commands || []).map(c => c.command));
            const unrun = unrunCommandsNamed(reportText, thoughts, known).map(c => `${c} (named, never run successfully)`);
            const unsupported = unrun.length ? unrun : await auditAnswer(this.agent?.providerManager, reportText, thoughts, auditWho);
            if (unsupported.length) {
              logger.info(`ReAct: a ${action.command} text has ${unsupported.length} claim(s) no step supports; not posting it`);
              thoughts.push({ type: 'action', content: action, iteration, timestamp: new Date() });
              thoughts.push({ type: 'observation', iteration, timestamp: new Date(), content: {
                tool: action.tool, command: action.command, success: false, refused: true,
                error: `Not posted: the text claims things no step in this run did: ${unsupported.map(u => `"${u}"`).join('; ')}. ` +
                  'Numbers, sizes and ids from other agents\' messages are theirs, not results of yours. Fetch what you need first, or rewrite the text to state only what your steps returned and what you did not check.'
              } });
              continue;
            }
          }

          const repeat = repeatedSideEffect(action, thoughts);
          if (repeat) {
            logger.info(`ReAct: refused a repeat of ${action.tool}.${action.command} (already done at step ${repeat.iteration})`);
            thoughts.push({ type: 'action', content: action, iteration, timestamp: new Date() });
            thoughts.push({ type: 'observation', iteration, timestamp: new Date(), content: {
              tool: action.tool, command: action.command, success: false, refused: true,
              error: `Not run: this run already did this successfully at step ${repeat.iteration} (${repeat.summary}). Doing it again would duplicate it. ` +
                'If the request is complete, give the final answer now with what those steps returned. (Set "allowRepeat": true in params only if a second one was explicitly asked for.)'
            } });
            continue;
          }
          // The same call, same params, twice already: a third returns the same thing. Card 21 #3335
          // (2026-10-06) read /api and /api/reference 13 times, hoping to see past the cut, until
          // the step budget ran out. Polling a job can pass allowRepeat.
          const sameCalls = identicalCalls(action, thoughts);
          if (sameCalls.length >= 2 && action.params?.allowRepeat !== true) {
            logger.info(`ReAct: refused a third identical ${action.tool}.${action.command} (steps ${sameCalls.join(', ')})`);
            thoughts.push({ type: 'action', content: action, iteration, timestamp: new Date() });
            thoughts.push({ type: 'observation', iteration, timestamp: new Date(), content: {
              tool: action.tool, command: action.command, success: false, refused: true,
              error: `Not run: this exact call already ran at steps ${sameCalls.join(' and ')}, and running it again returns the same result. ` +
                'If you need a part that was cut off, ask for that part narrowly (a specific path, id, query or field). Otherwise do the next step, or give the final answer with what you have. ' +
                '(To poll something that changes, set "allowRepeat": true in params.)'
            } });
            continue;
          }
          thoughts.push({ type: 'action', content: action, iteration, timestamp: new Date() });
          this.emit('action', { iteration, action });

          // Tool steps are always reported (briefly); full thoughts only with showThoughts
          await progress(`🔧 ${action.tool}.${action.command}`);
          logger.info(`ReAct action: ${action.tool}.${action.command} ${JSON.stringify(action.params || {}).slice(0, 200)}`);

          // Step 3: OBSERVATION - Execute and observe result
          run.toolCalls++;
          const observation = await this._boundedOperation(
            () => this.executeAction(action, { ...context, signal }),
            budget.maxActionDurationMs,
            signal,
            `Action ${action.tool}.${action.command}`
          );
          thoughts.push({ type: 'observation', content: observation, iteration, timestamp: new Date() });
          this.emit('observation', { iteration, observation });

          if (this.showThoughts && context.showThinking) {
            const obsPreview = typeof observation === 'string'
              ? observation.substring(0, 100)
              : JSON.stringify(observation).substring(0, 100);
            await context.showThinking(`👁️ Observation: ${obsPreview}...`);
          }
        }
      }

      // Out of steps: one last call that may only answer, so the person gets what was done and
      // what is left instead of "Max iterations reached" posted into a channel (card 21 #1277).
      const closing = await this._closingAnswer(query, thoughts, context, guidance).catch(() => null);
      if (closing) {
        const result = withTodo({ success: true, partial: true, answer: closing, thoughts, iterations: iteration, duration: Date.now() - startTime });
        if (this.thoughtStore) await this.thoughtStore.saveThoughtChain(query, thoughts, result);
        this.emit('maxIterations', result);
        return result;
      }

      // Max iterations reached
      const result = withTodo({
        success: false,
        error: 'Max iterations reached without finding an answer',
        reason: 'Max iterations reached without finding an answer',
        thoughts,
        iterations: iteration,
        duration: Date.now() - startTime
      });

      if (this.thoughtStore) {
        await this.thoughtStore.saveThoughtChain(query, thoughts, result);
      }

      this.emit('maxIterations', result);
      return result;

    } catch (error) {
      if (error.terminationType === 'cancelled' || error.terminationType === 'budgetExceeded') {
        return withTodo(this._terminationResult(error, thoughts, iteration, startTime));
      }

      logger.error('ReActAgent error:', error, {
        state: this.getState(),
        query,
        iteration,
        thoughts: thoughts.length
      });
      const result = {
        success: false,
        error: error.message,
        thoughts,
        iterations: iteration,
        duration: Date.now() - startTime
      };

      // Guard — `'error'` emit without listeners synchronously throws.
      if (this.listenerCount('error') > 0) {
        this.emit('error', { error, result });
      }
      return result;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  /**
   * Rebuild a run's to-do list from earlier steps (a task resumed after a clarification):
   * each "todo" sent with a thought is re-applied, each todo tool result restored.
   */
  static replayTodo(todo, thoughts = []) {
    for (const t of thoughts) {
      try {
        if (t?.type === 'thought' && Array.isArray(t.content?.todo)) todo.write(t.content.todo);
        else if (t?.type === 'observation' && t.content?.tool === TODO_TOOL && t.content.result) todo.restore(t.content.result);
      } catch { /* a malformed old entry does not stop the resume */ }
    }
    return todo;
  }

  /**
   * Generate a thought based on current state
   */
  async think(query, history, context, guidance = {}) {
    const prompt = this.buildThinkingPrompt(query, history, guidance);

    try {
      // No retry wrapper here: generateResponse already retries and fails over, and its
      // wall-clock budget is longer than any fixed per-thought race could safely be.
      // context.reasoningModel: one run on another model of the same provider (a model
      // comparison), without touching the agent's model or its provider lock.
      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 1000,
        temperature: 0.3,
        ...(context?.reasoningModel ? { model: context.reasoningModel } : {})
      });

      const content = response.content || response;
      return this.parseThought(content);
    } catch (error) {
      logger.error('ReAct thinking error:', error, {
        query,
        historyLength: history.length
      });
      throw error;
    }
  }

  /** A final answer from the steps taken so far, when the step budget is spent. Null if none. */
  async _closingAnswer(query, history, context, guidance) {
    const prompt = this.buildThinkingPrompt(query, history, guidance) +
      '\n\nYou have no steps left. Do not call a tool. Reply with {"finalAnswer": "..."} only: say plainly what you ' +
      'actually did (only what the observations show succeeded) and what is still not done.';
    const options = { maxTokens: 700, temperature: 0.2, ...(context?.reasoningModel ? { model: context.reasoningModel } : {}) };
    const response = await this.agent.providerManager.generateResponse(prompt, options);
    const raw = String(response?.content || response || '').trim();
    const answer = this.parseThought(raw).finalAnswer;
    if (answer) return String(answer);
    // Plain prose is the answer. JSON without a finalAnswer is the model taking another step:
    // the full prompt still lists every tool. Ask once more with the steps alone and no tools
    // (card 21 #2298, 2026-10-03: this returned nothing and "Max iterations reached" was posted).
    if (raw && !ReActAgent.jsonObjects(raw).length) return raw;
    // Every call, one line each, and the newest results in more detail: with only the last 24
    // entries a /hops call at step 5 dropped out and the summary said it was never made (card 21
    // #3335, 2026-10-06).
    const all = (history || []).filter(h => h.type === 'action' || h.type === 'observation');
    const recent = new Set(all.slice(-12));
    const steps = all.map(h => {
      const c = typeof h.content === 'string' ? h.content : JSON.stringify(h.content);
      if (h.type === 'action') return `Did: ${String(c).slice(0, 200)}`;
      const failed = h.content?.success === false;
      return `Got${failed ? ' (failed)' : ''}: ${String(c).slice(0, recent.has(h) ? 400 : 120)}`;
    }).join('\n').slice(-14000);
    const retry = await this.agent.providerManager.generateResponse(
      `Task: ${query}\n\nWhat was done so far:\n${steps || '(nothing)'}\n\n` +
      `You cannot take any more steps. In plain text (no JSON, no tool calls), in the first person as ${this.agent?.config?.name || 'the agent'} ` +
      '("I read…", not "the agent…"), say what you did, what it found, and what is still not done. Count a call as made if it is listed above. Keep it short.', options);
    const text = String(retry?.content || retry || '').trim();
    if (text && !ReActAgent.jsonObjects(text).length) return text;
    logger.warn('ReAct: no closing answer after running out of steps');
    return null;
  }

  /**
   * Build the prompt for the thinking step
   */
  buildThinkingPrompt(query, history, { relevant = [], pastExamples = '', skills = '', todo = null, channel = '' } = {}) {
    // Relevant tools in full, the rest as a catalog ranked by past performance
    const toolDescriptions = formatToolsForPrompt(this.tools, relevant, this.getPrioritizedTools());

    // Format history
    const lastObservation = [...history].reverse().find(h => h.type === 'observation');
    // The newest read of each target (one card, one URL) is the copy worth keeping in full; an
    // earlier read of the same target is superseded. Card 250 (~6 KB) cut at 3,000 characters
    // lost its second half, so the run read it four more times instead of testing (2026-10-02).
    const readKey = (c) => {
      if (!c || !/^(read\w*|export\w*|get\w*)$/i.test(String(c.command || ''))) return null;
      const id = c.result?.card?.id ?? c.result?.card ?? c.result?.id ?? null;
      return id === null || typeof id === 'object' ? null : `${c.tool}.${c.command}:${id}`;
    };
    const newestRead = new Map();
    history.forEach((h, i) => { if (h.type === 'observation') { const k = readKey(h.content); if (k) newestRead.set(k, i); } });
    const historyText = history.length > 0
      ? history.map((h, idx) => {
          switch (h.type) {
            case 'thought':
              return `Thought: ${h.content.reasoning || JSON.stringify(h.content)}`;
            case 'action':
              return `Action: ${h.content.tool}.${h.content.command}(${JSON.stringify(h.content.params || {})})`;
            case 'observation':
              if (h.content?.tool === TODO_TOOL) {
                return `Observation: to-do list ${h.content.command === 'write' ? 'saved' : 'read'}${h.content.success === false ? ` (failed: ${h.content.error})` : ''}, revision ${h.content.result?.revision ?? 0} (current list shown below)`;
              }
              // The newest observation is what the next step acts on (a card's whole checklist,
              // a file's text), so it is kept long; older ones are context and stay short. At a
              // flat 500 characters a card read lost all but its first steps.
              const obs = typeof h.content === 'string' ? h.content : JSON.stringify(h.content);
              // Instructions read earlier (a walkthrough card, a docs page) are what later steps
              // follow; cut to 500 they were gone a step later and the run re-read card 251 three
              // times out of ten steps (2026-10-02).
              const key = readKey(h.content);
              const superseded = key && newestRead.get(key) !== idx;
              const reference = /^(read\w*|export\w*|get\w*|search\w*|request)$/i.test(String(h.content?.command || ''));
              const limit = superseded ? 200 : h === lastObservation ? 8000 : reference ? 8000 : 1200;
              if (superseded) return `Observation: (an earlier read of the same thing; the newer read below replaces it)`;
              return `Observation: ${obs.substring(0, limit)}${obs.length > limit ? `… [display cut here: ${obs.length - limit} more characters not shown. Fetching the same thing again shows the same cut; ask for the part you need narrowly]` : ''}`;
            default:
              return '';
          }
        }).join('\n')
      : 'No previous steps.';

    const modelLine = typeof this.agent?.currentModelLabel === 'function' ? `\nYou are ${this.agent?.config?.name || 'the agent'}, running on the language model ${this.agent.currentModelLabel()}.` : '';
    return `You are a reasoning agent that thinks step-by-step to solve tasks. You have access to tools that can help you gather information and take actions.${modelLine}

## Available Tools:
${toolDescriptions}

${TODO_TOOL_PROMPT}

${skills ? `## Skills (known procedures; follow one only if it is for THIS request, otherwise ignore it):\n${skills}\n\n` : ''}${pastExamples ? `## Similar Tasks That Worked Before:\n${pastExamples}\n\n` : ''}## Previous Steps:
${historyText}

${todo && !todo.empty ? `## ${todo.promptBlock()}\nKeep it current: mark items done as you finish them.\n\n` : ''}${channel ? `## Where This Came From:\n${channel}\n\n` : ''}## Current Task:
${query}

## Instructions:
Think about what you need to do next. You can either:
1. Use a tool to get information or take an action
2. Provide a final answer if you have enough information
3. Ask for clarification only as a last resort
Be decisive. When the operator asked for something, do it: never ask them to confirm or restate a request they already made, and never stop to ask permission for an ordinary, reversible action (reading, searching, writing or appending to a card, posting a message). Fill gaps from the conversation, the workspace and sensible defaults. Calling a web API, signing up for a service, creating test data there or uploading a file you were asked to is ordinary work: do it, do not ask. Ask only when the request is genuinely ambiguous AND a wrong guess would be costly or impossible to undo (spending money, deleting the operator's data).
A tool result exists only as an Observation after you call the tool. Never say a tool failed, is not callable or "returned no results" unless an Observation below shows exactly that; earlier messages in a channel (including your own) saying a tool was unavailable are not evidence. Call the tool.
Know your tools before you rule one out: never say you lack a capability (web, HTTP, POST, browser, upload, shell) until a ${SEARCH_TOOL} for it came back empty. Any HTTP method, header or body goes through the http tool (http.request). A credential an API returns is saved for you and shown as {{secret:<host>.<field>}}: put that placeholder where the key goes and never write a key, token or password into a reply or a card.
If you will need to check again later (a reaction, a job, a status), call followup.schedule with the task; never promise to "poll again" or "report back" without it.
Your final answer reports what ran and what it returned (status codes, ids, links), not what you intend to do. Report only results from YOUR steps in this run: what other agents posted in a channel is theirs; never present it as yours, and when you have not done a part, say so.

Respond in this JSON format:
{
  "reasoning": "Your step-by-step reasoning about what to do next",
  "action": {
    "tool": "tool_name",
    "command": "action_name",
    "params": { "param1": "value1" }
  },
  "finalAnswer": "Your final answer if you're done (omit if not ready)",
  "needsClarification": false,
  "clarificationQuestion": "Question to ask if needed (omit if not needed)",
  "clarificationOptions": ["Up to 4 short likely answers, if the question has obvious choices (omit otherwise)"],
  "todo": [{"text": "step", "status": "pending|in_progress|done"}]
}

Only include "action" if you need to use a tool. To see the commands of a tool listed only by name, use {"tool": "${DESCRIBE_TOOL}", "command": "describe", "params": {"name": "<tool>"}}. To find a command by keyword across every tool, use {"tool": "${SEARCH_TOOL}", "command": "search", "params": {"query": "<keywords>"}}.
Only include "finalAnswer" if you have completed the task.
Only include "todo" when your to-do list changes, and then send the whole list.
Respond with valid JSON only.`;
  }

  /** The top-level {...} objects in a text that parse as JSON (braces inside strings are skipped). */
  static jsonObjects(text) {
    const out = [];
    const src = String(text || '');
    let depth = 0, start = -1, inString = false, escaped = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { if (depth > 0) inString = true; continue; }
      if (c === '{') { if (depth++ === 0) start = i; continue; }
      if (c === '}' && depth > 0 && --depth === 0) {
        try {
          const v = JSON.parse(src.slice(start, i + 1));
          if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
        } catch { /* not JSON: skip it */ }
      }
    }
    return out;
  }

  /**
   * Parse the thought response from LLM
   */
  parseThought(response) {
    try {
      // Every top-level JSON object in the reply, merged in order. Some models send the step and
      // then a second object (the to-do list, a correction); one greedy match from the first {
      // to the last } is not JSON, and the whole step was lost (3 of 10 steps on card 21 #1268).
      const objects = ReActAgent.jsonObjects(response);
      if (objects.length) {
        const parsed = Object.assign({}, ...objects);
        const options = Array.isArray(parsed.clarificationOptions)
          ? parsed.clarificationOptions.filter(o => typeof o === 'string' && o.trim()).map(o => o.trim().substring(0, 60)).slice(0, 4)
          : [];
        return {
          reasoning: parsed.reasoning || '',
          action: parsed.action || null,
          finalAnswer: parsed.finalAnswer || null,
          needsClarification: (parsed.needsClarification && !!parsed.clarificationQuestion) || false,
          clarificationQuestion: parsed.clarificationQuestion || null,
          clarificationOptions: options,
          ...(Array.isArray(parsed.todo) ? { todo: parsed.todo } : {})
        };
      }

      // Fallback: treat as reasoning text
      return {
        reasoning: response,
        action: null,
        finalAnswer: null,
        needsClarification: false,
        clarificationQuestion: null
      };
    } catch (error) {
      logger.warn('Failed to parse thought response:', error.message);
      return {
        reasoning: response,
        action: null,
        finalAnswer: null,
        needsClarification: false,
        clarificationQuestion: null
      };
    }
  }

  /**
   * Execute an action using the appropriate plugin.
   * Not retried: a plugin command can have side effects that must not be repeated.
   */
  async executeAction(action, context) {
    const { tool, command, params } = action;
    const outcome = await executeTool(this.agent, tool, command, params || {}, context);
    if (tool !== DESCRIBE_TOOL && tool !== SEARCH_TOOL) this.updateToolPerformance(tool, outcome.success);
    if (!outcome.success) {
      logger.warn(`ReAct action ${tool}.${command} failed: ${outcome.error || 'plugin reported failure'}`);
    }
    return { success: outcome.success, tool, command, ...(outcome.error ? { error: outcome.error } : { result: outcome.result }) };
  }

  /**
   * Update tool performance based on execution success or failure
   */
  updateToolPerformance(toolName, success) {
    const performance = this.toolPerformanceCache.get(toolName) || { successCount: 0, failureCount: 0 };
    if (success) {
      performance.successCount += 1;
    } else {
      performance.failureCount += 1;
    }
    this.toolPerformanceCache.set(toolName, performance);
  }

  /**
   * Get tools sorted by past performance (higher success rate first)
   */
  getPrioritizedTools() {
    return [...this.tools].sort((a, b) => {
      const aPerf = this.toolPerformanceCache.get(a.name) || { successCount: 0, failureCount: 0 };
      const bPerf = this.toolPerformanceCache.get(b.name) || { successCount: 0, failureCount: 0 };
      return (bPerf.successCount - bPerf.failureCount) - (aPerf.successCount - aPerf.failureCount);
    });
  }

  /**
   * Check if a query requires complex reasoning
   */
  async needsReasoning(query, context = {}) {
    // Simple heuristics for when to use ReAct
    const indicators = [
      /\b(and then|after that|first|second|finally)\b/i,
      /\b(if|when|unless|based on)\b/i,
      /\b(check|verify|confirm|ensure)\b/i,
      /\b(compare|analyze|evaluate)\b/i,
      /\b(find|search|look for).+\b(and|then)\b/i,
      /\b(multiple|several|various)\b/i
    ];

    // Check if query matches complexity indicators
    for (const pattern of indicators) {
      if (pattern.test(query)) {
        return true;
      }
    }

    // Check query length (longer queries often need reasoning)
    if (query.length > 200) {
      return true;
    }

    return false;
  }

  /**
   * Get the current state of the agent
   */
  getState() {
    const run = this.activeRun;
    return {
      maxIterations: this.maxIterations,
      showThoughts: this.showThoughts,
      toolCount: this.tools.length,
      tools: this.tools.map(t => t.name),
      activeBudget: run ? { ...run.budget } : null,
      cancellation: {
        active: !!run,
        cancelled: !!run?.signal?.aborted,
        toolCalls: run?.toolCalls || 0,
        elapsedMs: run ? Date.now() - run.startTime : 0
      }
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    if (config.maxIterations !== undefined) {
      this.maxIterations = config.maxIterations;
    }
    if (config.showThoughts !== undefined) {
      this.showThoughts = config.showThoughts;
    }
    if (config.thoughtTimeout !== undefined) {
      this.thoughtTimeout = config.thoughtTimeout;
    }
    if (config.executionBudget !== undefined) {
      this.executionBudget = { ...config.executionBudget };
    }
    if (config.budget !== undefined) {
      this.executionBudget = { ...config.budget };
    }
  }
}

export default ReActAgent;
