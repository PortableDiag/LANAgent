import { PluginSettings } from '../../../models/PluginSettings.js';
import { logger } from '../../../utils/logger.js';
import { safeJsonStringify } from '../../../utils/jsonUtils.js';

let killSwitchActive = false;
let killSwitchSchedule = []; // [{start: ISO, end: ISO}, ...] — persisted in PluginSettings
let lastCheck = 0;
const CHECK_INTERVAL = 10000; // 10 seconds

async function refreshKillSwitch() {
  try {
    const value = await PluginSettings.getCached('external-gateway', 'kill_switch', 30);
    killSwitchActive = !!value;
    const sched = await PluginSettings.getCached('external-gateway', 'kill_switch_schedule', 30);
    killSwitchSchedule = Array.isArray(sched) ? sched : [];
  } catch (error) {
    logger.error('Failed to check kill switch:', error);
  }
  lastCheck = Date.now();
}

function isScheduledKillSwitchActive(now = new Date()) {
  if (!Array.isArray(killSwitchSchedule) || killSwitchSchedule.length === 0) return false;
  const t = now.getTime();
  return killSwitchSchedule.some(({ start, end }) => {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return Number.isFinite(s) && Number.isFinite(e) && t >= s && t <= e;
  });
}

/**
 * Persist a kill-switch schedule. Each entry is an ISO start/end pair; the
 * middleware will return 503 for any non-admin request whose timestamp falls
 * within a window. Schedule survives restarts via PluginSettings.
 *
 * @param {Array<{start:string, end:string}>} schedule
 */
export async function setKillSwitchSchedule(schedule) {
  if (!Array.isArray(schedule)) throw new Error('schedule must be an array');
  for (const w of schedule) {
    if (!w?.start || !w?.end) throw new Error('each window needs {start, end} ISO strings');
    if (isNaN(new Date(w.start)) || isNaN(new Date(w.end))) throw new Error('start/end must be parseable dates');
  }
  await PluginSettings.setCached('external-gateway', 'kill_switch_schedule', schedule);
  killSwitchSchedule = schedule;
  logKillSwitchEvent('SCHEDULE_SET', safeJsonStringify(schedule));
}

export function getKillSwitchSchedule() {
  return [...killSwitchSchedule];
}

export function setKillSwitch(active) {
  killSwitchActive = !!active;
  logKillSwitchEvent(killSwitchActive ? 'ACTIVATED' : 'deactivated');
}

export function isKillSwitchActive() {
  return killSwitchActive;
}

export async function killSwitchMiddleware(req, res, next) {
  // Admin routes bypass kill switch (needed to toggle it off)
  if (req.path.startsWith('/admin')) {
    return next();
  }

  if (Date.now() - lastCheck > CHECK_INTERVAL) {
    await refreshKillSwitch();
  }

  if (killSwitchActive || isScheduledKillSwitchActive()) {
    logKillSwitchEvent('BLOCKED', req.path);
    return res.status(503).json({
      success: false,
      error: 'Service temporarily unavailable',
      retryAfter: 60
    });
  }

  next();
}

/**
 * Logs detailed metrics about kill switch activations and deactivations.
 * @param {string} action - The action performed (e.g., 'ACTIVATED', 'deactivated', 'BLOCKED').
 * @param {string} [path] - The request path if applicable.
 */
function logKillSwitchEvent(action, path = '') {
  const eventDetails = {
    timestamp: new Date().toISOString(),
    action,
    path
  };
  logger.info(`Kill switch event: ${safeJsonStringify(eventDetails)}`);
}
