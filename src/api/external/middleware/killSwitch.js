import { PluginSettings } from '../../../models/PluginSettings.js';
import { logger } from '../../../utils/logger.js';

let killSwitchActive = false;
let lastCheck = 0;
const CHECK_INTERVAL = 10000; // 10 seconds

async function refreshKillSwitch() {
  try {
    const value = await PluginSettings.getCached('external-gateway', 'kill_switch', 30);
    killSwitchActive = !!value;
  } catch (error) {
    logger.error('Failed to check kill switch:', error);
  }
  lastCheck = Date.now();
}

export function setKillSwitch(active) {
  killSwitchActive = !!active;
  logger.warn(`External gateway kill switch ${killSwitchActive ? 'ACTIVATED' : 'deactivated'}`);
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

  if (killSwitchActive) {
    return res.status(503).json({
      success: false,
      error: 'Service temporarily unavailable',
      retryAfter: 60
    });
  }

  next();
}
