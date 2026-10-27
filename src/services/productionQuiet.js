/**
 * Is this instance quiet enough to restart? The in-process twin of scripts/deployment/quiet-gate.sh,
 * for the restarts the app does to itself (the hourly deploy-merged-changes job).
 *
 * Until 2026-10-23 that job restarted with no check at all, so anything pushed to main went live
 * at the next run whatever the agent was doing: the deploy scripts waited for a quiet moment and
 * the auto-update did not. Each check is a way a restart has cut something short; keep this list
 * and quiet-gate.sh's in step.
 */
import fs from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import { LOGS_PATH } from '../utils/paths.js';

// Requests being served right now, counted where they arrive; a socket count cannot tell an idle
// keep-alive from a request in flight. external = paid /api/external calls (the gateway's);
// command = POST /api/command/execute (web UI chat, API callers, the deploy's conversation check:
// a second deploy restarted ALICE in the middle of the first one's check on 2026-10-23).
const inFlight = { external: 0, command: 0 };
function tracker(kind) {
  return (req, res, next) => {
    inFlight[kind]++;
    let done = false;
    const end = () => { if (!done) { done = true; inFlight[kind]--; } };
    res.on('finish', end);
    res.on('close', end);
    next();
  };
}
export const trackExternalRequest = tracker('external');
export const trackCommandRequest = tracker('command');
export const externalRequestsInFlight = () => inFlight.external;
export const commandRequestsInFlight = () => inFlight.command;

async function logTail(bytes = 400000) {
  const file = path.join(LOGS_PATH, 'all-activity.log');
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } finally {
    await fh.close();
  }
}

/** Local log timestamps ("2026-10-23 08:17:16") are wall-clock time on this host. */
const logTime = (line) => new Date(line.slice(0, 19).replace(' ', 'T')).getTime();

/**
 * Reasons this instance is busy; an empty array means quiet. Anything that cannot be read counts
 * as busy: a restart is never worth a guess.
 */
// The owner's phone as DialX last reported it ({state, idleSince}), or null when nothing has said.
async function phoneState() {
  const { textxIfStarted } = await import('./textx/index.js');
  return textxIfStarted()?.hub?.dialx?.phoneState || null;
}

export async function busyReasons({ db = mongoose.connection?.db, now = Date.now(), tail = logTail, phone = phoneState } = {}) {
  const busy = [];
  // The owner's own calls too, not only ALICE's: this job could restart ALICE in the middle of one, which the
  // deploy scripts' gate stopped doing in 2.25.662. Unknown is not busy here (no DialX paired = no phone to protect).
  try {
    const p = await phone();
    if (p?.state && !['idle', 'unknown'].includes(p.state)) busy.push(`the owner's phone is on a call (${p.state})`);
    else if (p?.state === 'idle' && p.idleSince && now - p.idleSince < 120000) busy.push('the owner\'s phone call ended under 2 minutes ago');
  } catch (e) {
    busy.push(`cannot read the phone's call state (${e.message})`);
  }
  if (inFlight.external > 0) busy.push(`${inFlight.external} paid request(s) in flight`);
  if (inFlight.command > 0) busy.push(`${inFlight.command} command request(s) being answered`);

  try {
    const lines = await tail();
    if (/ReAct iteration/.test(lines[lines.length - 1] || '')) busy.push('a ReAct run is in progress');
    const asked = lines.filter(l => /NL request from owner|TelegramDashboard received response/.test(l)).pop();
    if (asked && /NL request from owner/.test(asked) && now - logTime(asked) < 300000) busy.push('an owner request is being answered');
  } catch (e) {
    busy.push(`cannot read the activity log (${e.message})`);
  }

  if (!db) {
    busy.push('no database connection');
    return busy;
  }
  const count = async (label, collection, filter) => {
    try {
      const n = await db.collection(collection).countDocuments(filter);
      if (n > 0) busy.push(`${n} ${label}`);
    } catch (e) {
      busy.push(`cannot read ${collection} (${e.message})`);
    }
  };
  await count('TextX message(s) being answered', 'textx_inbox', { pending: true });
  await count('TextX call(s) waiting on the phone', 'textx_outbox',
    { ackedAt: null, 'env.type': 'tool_call', createdAt: { $gte: new Date(now - 600000) } });
  await count('DialX phone call(s) in progress', 'dialx_calls', {
    endedAt: null,
    $or: [
      { startedAt: { $gte: new Date(now - 360000) } },
      { startedAt: null, plannedAt: { $gte: new Date(now - 600000), $lte: new Date(now + 300000) } }
    ]
  });
  return busy;
}

/** Wait up to `waitMs` for a quiet moment. Resolves [] when quiet, else the last reasons seen. */
export async function waitForQuiet({ waitMs = 300000, everyMs = 15000, check = busyReasons, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const busy = await check();
    if (!busy.length || Date.now() + everyMs > deadline) return busy;
    await sleep(everyMs);
  }
}
