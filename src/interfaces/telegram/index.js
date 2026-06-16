// Export both the original interface and the enhanced dashboard
export { TelegramInterface } from "./telegram.js";
export { TelegramDashboard } from "./telegramDashboard.js";
export { DashboardVisuals } from "./dashboardVisuals.js";

/**
 * Lazy-loading factory for Telegram-area interfaces. Existing named exports
 * remain for callers that prefer static imports; this factory exists for
 * sites that want on-demand instantiation without pulling all three modules
 * at startup.
 */
const _interfaceLoaders = {
  telegram:  { load: () => import('./telegram.js'),          name: 'TelegramInterface' },
  dashboard: { load: () => import('./telegramDashboard.js'), name: 'TelegramDashboard' },
  visuals:   { load: () => import('./dashboardVisuals.js'),  name: 'DashboardVisuals' }
};

export const loaders = Object.fromEntries(
  Object.entries(_interfaceLoaders).map(([k, v]) => [k, v.load])
);

export async function createInterface(type, options) {
  const entry = _interfaceLoaders[type];
  if (!entry) {
    const known = Object.keys(_interfaceLoaders).join(', ');
    throw new Error(`Unknown interface type: ${type}. Known types: ${known}`);
  }
  let mod;
  try {
    mod = await entry.load();
  } catch (err) {
    throw new Error(`[createInterface] Failed to load '${type}': ${err.message}`);
  }
  const Ctor = mod[entry.name] || mod.default;
  if (typeof Ctor !== 'function') {
    throw new Error(`[createInterface] '${type}' module does not expose a constructible '${entry.name}' export`);
  }
  return new Ctor(options);
}
