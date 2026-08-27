import { PluginSettings } from '../../../models/PluginSettings.js';
import { logger } from '../../../utils/logger.js';
import { safeJsonStringify } from '../../../utils/jsonUtils.js';
import { retryOperation } from '../../../utils/retryUtils.js';

let killSwitchActive = false;
let killSwitchSchedule = []; // [{start: ISO, end: ISO}, ...] — persisted in PluginSettings
let lastCheck = 0;
const CHECK_INTERVAL = 10000; // 10 seconds

// Store previous state to detect changes
let previousKillSwitchState = {
  active: false,
  scheduledActive: false
};

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
 * Notify configured webhook URLs about kill switch state changes
 * @param {string} action - The action that triggered the notification
 */
async function notifyOnStateChange(action) {
  try {
    const hooks = await PluginSettings.getCached('external-gateway', 'kill_switch_notification_hooks', 30);
    
    if (!Array.isArray(hooks) || hooks.length === 0) {
      return;
    }

    const currentState = {
      active: killSwitchActive,
      scheduledActive: isScheduledKillSwitchActive(),
      schedule: [...killSwitchSchedule],
      timestamp: new Date().toISOString(),
      action
    };

    const payload = {
      event: 'kill_switch_state_change',
      data: currentState
    };

    const notifications = hooks.map(async (hookUrl) => {
      if (typeof hookUrl !== 'string' || !hookUrl.startsWith('http')) {
        logger.warn(`Invalid webhook URL: ${hookUrl}`);
        return;
      }

      try {
        await retryOperation(async () => {
          const response = await fetch(hookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: safeJsonStringify(payload),
            signal: AbortSignal.timeout(10000)
          });

          if (!response.ok) {
            throw new Error(`Webhook failed with status ${response.status}`);
          }
        }, {
          retries: 3,
          minTimeout: 1000,
          maxTimeout: 10000
        });
      } catch (error) {
        logger.error(`Failed to send notification to ${hookUrl}:`, error);
      }
    });

    await Promise.allSettled(notifications);
  } catch (error) {
    logger.error('Error in notifyOnStateChange:', error);
  }
}

/**
 * Check if kill switch state has changed and trigger notifications if needed.
 * Notification delivery is fire-and-forget: webhooks (with retries) can take
 * seconds, and this runs inside request middleware and admin routes.
 */
function checkAndNotifyStateChange(action) {
  const currentActive = killSwitchActive;
  const currentScheduledActive = isScheduledKillSwitchActive();

  // Check if either manual or scheduled state has changed
  if (currentActive !== previousKillSwitchState.active ||
      currentScheduledActive !== previousKillSwitchState.scheduledActive) {

    // Update previous state
    previousKillSwitchState = {
      active: currentActive,
      scheduledActive: currentScheduledActive
    };

    notifyOnStateChange(action).catch((error) => {
      logger.error('Kill switch notification dispatch failed:', error);
    });
  }
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
  checkAndNotifyStateChange('SCHEDULE_UPDATED');
  logKillSwitchEvent('SCHEDULE_SET', safeJsonStringify(schedule));
}

export function getKillSwitchSchedule() {
  return [...killSwitchSchedule];
}

export function setKillSwitch(active) {
  killSwitchActive = !!active;
  checkAndNotifyStateChange(killSwitchActive ? 'ACTIVATED' : 'DEACTIVATED');
  logKillSwitchEvent(killSwitchActive ? 'ACTIVATED' : 'DEACTIVATED');
}

export function isKillSwitchActive() {
  return killSwitchActive;
}

/**
 * Configure webhook URLs for kill switch notifications
 * @param {string[]} hooks - Array of webhook URLs
 */
export async function setKillSwitchNotificationHooks(hooks) {
  if (!Array.isArray(hooks)) {
    throw new Error('hooks must be an array of URLs');
  }
  
  // Validate each URL
  for (const hook of hooks) {
    if (typeof hook !== 'string' || !hook.startsWith('http')) {
      throw new Error(`Invalid webhook URL: ${hook}`);
    }
  }
  
  await PluginSettings.setCached('external-gateway', 'kill_switch_notification_hooks', hooks);
  logger.info(`Kill switch notification hooks updated: ${hooks.length} hooks configured`);
}

/**
 * Get currently configured webhook URLs for kill switch notifications
 * @returns {Promise<string[]>} Array of webhook URLs
 */
export async function getKillSwitchNotificationHooks() {
  try {
    const hooks = await PluginSettings.getCached('external-gateway', 'kill_switch_notification_hooks', 30);
    return Array.isArray(hooks) ? [...hooks] : [];
  } catch (error) {
    logger.error('Failed to retrieve kill switch notification hooks:', error);
    return [];
  }
}

/**
 * Report current kill-switch status for the admin dashboard. Refreshes from
 * PluginSettings first so the reported state reflects DB truth, not a stale
 * in-memory snapshot. Before the first check, lastCheck/nextCheck are null
 * (rather than a 1970 epoch).
 * @returns {Promise<Object>}
 */
export async function getKillSwitchStatus() {
  await refreshKillSwitch();
  return {
    active: killSwitchActive,
    scheduledActive: isScheduledKillSwitchActive(),
    schedule: [...killSwitchSchedule],
    lastCheck: lastCheck ? new Date(lastCheck).toISOString() : null,
    nextCheck: lastCheck ? new Date(lastCheck + CHECK_INTERVAL).toISOString() : null,
    checkInterval: CHECK_INTERVAL
  };
}

export async function killSwitchMiddleware(req, res, next) {
  // Admin routes bypass kill switch (needed to toggle it off)
  if (req.path.startsWith('/admin')) {
    return next();
  }

  if (Date.now() - lastCheck > CHECK_INTERVAL) {
    await refreshKillSwitch();
    // checkAndNotifyStateChange compares against the last-notified state and
    // no-ops when nothing changed; delivery is fire-and-forget.
    checkAndNotifyStateChange('STATE_REFRESHED');
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
 * @param {string} action - The action performed (e.g., 'ACTIVATED', 'DEACTIVATED', 'BLOCKED').
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
