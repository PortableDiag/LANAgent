import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is two levels up from src/utils/
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export const DEPLOY_PATH = path.resolve(process.env.DEPLOY_PATH || PROJECT_ROOT);
export const DATA_PATH = path.resolve(process.env.DATA_PATH || path.join(DEPLOY_PATH, 'data'));
export const LOGS_PATH = path.resolve(process.env.LOGS_PATH || path.join(DEPLOY_PATH, 'logs'));
export const WORKSPACE_PATH = path.resolve(process.env.WORKSPACE_PATH || path.join(DEPLOY_PATH, 'workspace'));
export const TEMP_PATH = path.resolve(process.env.TEMP_PATH || path.join(DEPLOY_PATH, 'temp'));
export const UPLOADS_PATH = path.resolve(process.env.UPLOADS_PATH || path.join(DEPLOY_PATH, 'uploads'));
export const REPO_PATH = path.resolve(process.env.AGENT_REPO_PATH || process.env.REPO_PATH || DEPLOY_PATH);
export const VENV_PATH = path.resolve(process.env.VENV_PATH || path.join(DEPLOY_PATH, 'venv-wakeword'));
export const SCRIPTS_PATH = path.resolve(path.join(DEPLOY_PATH, 'scripts'));
export const WAKE_WORD_MODELS_PATH = path.resolve(
  process.env.WAKE_WORD_MODEL_DIR || path.join(DEPLOY_PATH, 'wake_word_models')
);
export const WAKE_WORD_SAMPLES_PATH = path.resolve(
  process.env.WAKE_WORD_SAMPLE_DIR || path.join(DEPLOY_PATH, 'wake_word_samples')
);

/**
 * Canonical names for directories managed by LANAgent.
 *
 * Uppercase aliases are retained to make the map convenient to use alongside
 * the existing path constants, while lowercase names are the canonical API
 * names.
 */
export const PATH_KEYS = Object.freeze({
  deploy: DEPLOY_PATH,
  data: DATA_PATH,
  logs: LOGS_PATH,
  workspace: WORKSPACE_PATH,
  temp: TEMP_PATH,
  uploads: UPLOADS_PATH,
  repo: REPO_PATH,
  venv: VENV_PATH,
  scripts: SCRIPTS_PATH,
  wakeWordModels: WAKE_WORD_MODELS_PATH,
  wakeWordSamples: WAKE_WORD_SAMPLES_PATH,
  DEPLOY_PATH,
  DATA_PATH,
  LOGS_PATH,
  WORKSPACE_PATH,
  TEMP_PATH,
  UPLOADS_PATH,
  REPO_PATH,
  VENV_PATH,
  SCRIPTS_PATH,
  WAKE_WORD_MODELS_PATH,
  WAKE_WORD_SAMPLES_PATH
});

/**
 * Check whether a candidate path is contained by a selected managed root.
 *
 * @param {string} root - Absolute managed root.
 * @param {string} candidate - Absolute candidate path.
 * @returns {boolean} True when the candidate is the root or one of its descendants.
 */
function isContainedPath(root, candidate) {
  const relativePath = path.relative(root, candidate);

  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Resolve a path below a managed root without allowing path traversal.
 *
 * @param {string} root - Absolute managed root.
 * @param {string[]} segments - Path segments below the root.
 * @returns {string} The resolved, contained path.
 * @throws {TypeError} If a path segment is not a string.
 * @throws {Error} If the resulting path escapes the root.
 */
function resolveContainedPath(root, segments) {
  const normalizedRoot = path.resolve(root);

  for (const segment of segments) {
    if (typeof segment !== 'string') {
      throw new TypeError('Managed path segments must be strings');
    }
  }

  const candidate = path.resolve(normalizedRoot, ...segments);

  if (!isContainedPath(normalizedRoot, candidate)) {
    throw new Error('Path traversal outside the selected managed root is not allowed');
  }

  return candidate;
}

/**
 * Resolve a configured LANAgent directory by name.
 *
 * @param {string} name - A key from PATH_KEYS.
 * @param {...string} segments - Optional nested path segments.
 * @returns {string} An absolute path contained by the selected managed root.
 * @throws {TypeError} If name is not a string.
 * @throws {Error} If the path name is unknown or traversal is attempted.
 */
export function getManagedPath(name, ...segments) {
  if (typeof name !== 'string') {
    throw new TypeError('Managed path name must be a string');
  }

  if (!Object.prototype.hasOwnProperty.call(PATH_KEYS, name)) {
    throw new Error(`Unknown managed path name: ${name}`);
  }

  return resolveContainedPath(PATH_KEYS[name], segments);
}

/**
 * Resolve a relative path within the workspace or another selected root.
 *
 * The default root is WORKSPACE_PATH. A root may be selected with a PATH_KEYS
 * name using `name`, `pathName`, or `rootName`. For integrations that already
 * hold a configured absolute root, `root` may be supplied directly.
 *
 * @param {string} relativePath - Relative path below the selected root.
 * @param {object} [options] - Root selection options.
 * @param {string} [options.name] - PATH_KEYS name.
 * @param {string} [options.pathName] - PATH_KEYS name.
 * @param {string} [options.rootName] - PATH_KEYS name.
 * @param {string} [options.root] - PATH_KEYS name or an absolute root path.
 * @returns {string} An absolute path contained by the selected root.
 * @throws {TypeError} If relativePath or options are invalid.
 * @throws {Error} If the selected root is unknown or traversal is attempted.
 */
export function resolveWorkspacePath(relativePath, options = {}) {
  if (typeof relativePath !== 'string') {
    throw new TypeError('Workspace path must be a string');
  }

  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Workspace path options must be an object');
  }

  if (path.isAbsolute(relativePath)) {
    throw new Error('Workspace path must be relative');
  }

  const namedRoot = options.name || options.pathName || options.rootName;
  let root;

  if (namedRoot !== undefined) {
    root = getManagedPath(namedRoot);
  } else if (options.root !== undefined) {
    if (typeof options.root !== 'string') {
      throw new TypeError('Workspace root must be a string');
    }

    if (Object.prototype.hasOwnProperty.call(PATH_KEYS, options.root)) {
      root = getManagedPath(options.root);
    } else {
      root = path.resolve(options.root);
    }
  } else {
    root = WORKSPACE_PATH;
  }

  return resolveContainedPath(root, [relativePath]);
}

/**
 * Get the server's reachable host address.
 * Priority: AGENT_HOST env > SERVER_IP env > first non-internal IPv4 > 'localhost'
 */
export function getServerHost() {
  if (process.env.AGENT_HOST) return process.env.AGENT_HOST;
  if (process.env.SERVER_IP) return process.env.SERVER_IP;
  // Auto-detect from network interfaces
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return 'localhost';
}
