/**
 * A to-do list the reasoning agent keeps for itself during one multi-step task.
 *
 * Pure in-memory state on the run — it never calls a plugin. The model writes the whole
 * list ([{text, status}]) or reads it back; every call returns the full list with a revision
 * number that goes up only when the list actually changes. The list is re-injected into the
 * prompt on every iteration, so the plan survives a long run, and rendered compactly for the
 * user's progress line ("☑ done · ▶ current · ☐ next").
 */

export const TODO_TOOL = 'todo';
export const TODO_STATUSES = ['pending', 'in_progress', 'done'];
export const MAX_TODO_ITEMS = 30;
export const MAX_TODO_TEXT = 300;

const STATUS_ALIASES = {
  pending: 'pending', todo: 'pending', open: 'pending', 'not_started': 'pending',
  in_progress: 'in_progress', 'in-progress': 'in_progress', inprogress: 'in_progress', active: 'in_progress', current: 'in_progress', doing: 'in_progress',
  done: 'done', completed: 'done', complete: 'done', finished: 'done'
};

const MARKS = { done: '☑', in_progress: '▶', pending: '☐' };

function normalizeItem(raw) {
  if (typeof raw === 'string') raw = { text: raw };
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text ?? raw.content ?? raw.task ?? raw.title ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const status = STATUS_ALIASES[String(raw.status ?? 'pending').trim().toLowerCase()] || 'pending';
  return { text: text.length > MAX_TODO_TEXT ? `${text.slice(0, MAX_TODO_TEXT - 1)}…` : text, status };
}

export class TodoList {
  constructor() {
    this.items = [];
    this.revision = 0;
  }

  /** Replace the whole list. Returns the snapshot after writing. */
  write(items) {
    if (!Array.isArray(items)) throw new Error('todo items must be an array of {text, status}');
    const next = items.map(normalizeItem).filter(Boolean).slice(0, MAX_TODO_ITEMS);
    if (JSON.stringify(next) !== JSON.stringify(this.items)) {
      this.items = next;
      this.revision++;
    }
    return this.snapshot();
  }

  /** Put back a snapshot (resuming a parked task) without inventing a new revision. */
  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return;
    this.items = snapshot.items.map(normalizeItem).filter(Boolean).slice(0, MAX_TODO_ITEMS);
    this.revision = Number.isInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : 0;
  }

  snapshot() {
    const counts = { pending: 0, in_progress: 0, done: 0 };
    for (const i of this.items) counts[i.status]++;
    return { revision: this.revision, items: this.items.map(i => ({ ...i })), counts };
  }

  get empty() { return this.items.length === 0; }

  /**
   * Compact progress text for a chat: one line per item, long lists trimmed around the
   * current item ("… 3 done" / "+2 more").
   */
  render({ maxItems = 8, maxText = 48 } = {}) {
    if (this.empty) return '';
    const clip = t => (t.length > maxText ? `${t.slice(0, maxText - 1)}…` : t);
    const lines = this.items.map(i => `${MARKS[i.status]} ${clip(i.text)}`);
    if (lines.length <= maxItems) return lines.join('\n');

    // Keep the window around the first unfinished item
    const firstOpen = this.items.findIndex(i => i.status !== 'done');
    const anchor = firstOpen === -1 ? this.items.length - maxItems : Math.max(0, firstOpen - 1);
    const start = Math.min(anchor, this.items.length - maxItems);
    const out = [];
    if (start > 0) out.push(`… ${start} earlier`);
    out.push(...lines.slice(start, start + maxItems));
    const after = this.items.length - (start + maxItems);
    if (after > 0) out.push(`+${after} more`);
    return out.join('\n');
  }

  /** The list as the model sees it each iteration. */
  promptBlock() {
    if (this.empty) return '';
    const lines = this.items.map((i, n) => `${n + 1}. [${i.status}] ${i.text}`);
    return `Your to-do list (revision ${this.revision}):\n${lines.join('\n')}`;
  }
}

/**
 * The `todo` tool: params.items (or params.todos) writes the full list; no items reads it.
 * Always answers with the full list and its revision.
 */
export function runTodoTool(list, params = {}) {
  const items = params?.items ?? params?.todos ?? params?.list;
  try {
    const snap = items === undefined || items === null ? list.snapshot() : list.write(items);
    return { success: true, tool: TODO_TOOL, command: items == null ? 'read' : 'write', result: snap };
  } catch (error) {
    return { success: false, tool: TODO_TOOL, command: 'write', error: error.message, result: list.snapshot() };
  }
}

export const TODO_TOOL_PROMPT = `**${TODO_TOOL}**: your own to-do list for this task (not a plugin; costs nothing). For work with 3+ steps, write it early and keep it current.
  - write: {"tool": "${TODO_TOOL}", "command": "write", "params": {"items": [{"text": "…", "status": "pending|in_progress|done"}]}} — always the FULL list
  - read: {"tool": "${TODO_TOOL}", "command": "read", "params": {}}
  Or, to save a step, add "todo": [ …full list… ] next to a real "action" in your JSON.`;
