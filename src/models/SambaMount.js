import mongoose from 'mongoose';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Default space reader: df on the local mount point.
 *
 * execFile, not exec — there is no shell, so a mount point containing shell
 * metacharacters cannot escape into a command. `-k -P` are POSIX: 1024-byte
 * blocks and exactly one unwrapped line per filesystem.
 */
const runDfDefault = (mountPoint) =>
  execFileAsync('df', ['-k', '-P', mountPoint], { timeout: 10000 }).then(({ stdout }) => stdout);

const sambaMountSchema = new mongoose.Schema({
  mountId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  server: {
    type: String,
    required: true
  },
  share: {
    type: String,
    required: true
  },
  mountPoint: {
    type: String,
    required: true
  },
  username: {
    type: String,
    required: true
  },
  domain: String,
  options: [String],
  // Security note: In production, these should be encrypted
  password: {
    type: String,
    select: false // Don't return by default
  },
  // Mount status (not persisted, updated at runtime)
  mounted: {
    type: Boolean,
    default: false
  },
  lastMountedAt: Date,
  lastError: String
}, {
  timestamps: true
});

// Index for fast lookups
sambaMountSchema.index({ server: 1, share: 1 });

/**
 * Report total/used/available space for a mounted CIFS share.
 *
 * The figures come from df on the local mount point. For a mounted CIFS
 * filesystem the kernel reports the *server's* share capacity, so this is a
 * real reading of the remote share rather than of the local disk.
 *
 * smbclient is deliberately not used: the stored password is ciphertext
 * (src/api/plugins/samba.js encrypts it before saving and decrypts it only in
 * memory), so it cannot authenticate as-is, and putting a credential on a shell
 * command line exposes it in `ps` output and in exec error messages. The plugin
 * already avoids that for testMount by passing SMBCLIENT_PASSWORD via env.
 *
 * @param {string} mountId - The mount identifier
 * @param {Object} [deps] - Injection point for tests; `runDf(mountPoint)` resolves df's stdout
 * @returns {Promise<Object>} total/used/available in bytes, plus utilization and threshold flags
 */
sambaMountSchema.statics.getShareSpace = async function(mountId, { runDf = runDfDefault } = {}) {
  const mount = await this.findOne({ mountId });
  if (!mount) {
    throw new Error(`Mount with ID ${mountId} not found`);
  }

  // Absolute path so df can never read the mount point as an option bundle.
  const mountPoint = path.resolve(mount.mountPoint);

  let stdout;
  try {
    stdout = await runDf(mountPoint);
  } catch (error) {
    logger.error(`df failed for Samba mount ${mountId} at ${mountPoint}: ${error.message}`);
    throw new Error(`Cannot read space for ${mountId}: ${mountPoint} is not accessible`);
  }

  const lines = String(stdout).trim().split('\n');
  const dataLine = lines[lines.length - 1];
  // filesystem, 1K-blocks, used, available, capacity%, mounted-on
  const match = dataLine.match(/^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
  if (!match) {
    throw new Error(`Failed to parse df output for ${mountId}`);
  }

  const [, filesystem, blocks, usedBlocks, availBlocks, , mountedOn] = match;

  // df on a directory that is NOT a mount point silently reports the filesystem
  // that owns the parent path — i.e. the local disk. Returning that as the
  // share's capacity would be a wrong reading dressed up as a live one, so
  // refuse instead of answering.
  const normalize = (p) => p.replace(/\/+$/, '') || '/';
  if (normalize(mountedOn) !== normalize(mountPoint)) {
    throw new Error(
      `Share ${mountId} is not mounted at ${mountPoint} (df reports ${mountedOn}); mount it before asking for its space`
    );
  }

  const total = Number(blocks) * 1024;
  const used = Number(usedBlocks) * 1024;
  const available = Number(availBlocks) * 1024;
  const utilization = total > 0 ? Math.round((used / total) * 100) : 0;

  return {
    mountId,
    mountPoint,
    filesystem,
    total,
    used,
    available,
    utilization,
    warning: utilization > 85,
    critical: utilization > 95
  };
};

/**
 * Space for several mounts in one call, at most `concurrency` df runs at a time.
 *
 * Results keep the order of `mountIds`. A mount that fails (unknown id, not
 * mounted, df unreadable) lands in `errors` and does not fail the batch.
 * Nothing is retried: getShareSpace's failures are deterministic, and df already
 * carries its own 10s timeout, so a retry would only multiply the wait on an
 * unmounted share.
 *
 * @param {string[]} mountIds - Mount identifiers
 * @param {Object} [options]
 * @param {number} [options.concurrency=3] - Maximum concurrent df calls
 * @param {Function} [options.runDf] - Injection point for tests; passed through to getShareSpace
 * @returns {Promise<{results: Object[], errors: {mountId: string, error: string}[]}>}
 */
sambaMountSchema.statics.getBatchSpace = async function(mountIds = [], { concurrency = 3, runDf = runDfDefault } = {}) {
  const ids = [...new Set(mountIds)];
  const outcomes = new Array(ids.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      try {
        outcomes[i] = { ok: true, value: await this.getShareSpace(ids[i], { runDf }) };
      } catch (error) {
        logger.warn(`Batch space check failed for mount ${ids[i]}: ${error.message}`);
        outcomes[i] = { ok: false, value: { mountId: ids[i], error: error.message } };
      }
    }
  };

  const width = Math.max(1, Math.min(Number(concurrency) || 1, ids.length));
  await Promise.all(Array.from({ length: width }, worker));

  return {
    results: outcomes.filter(o => o.ok).map(o => o.value),
    errors: outcomes.filter(o => !o.ok).map(o => o.value)
  };
};

export const SambaMount = mongoose.model('SambaMount', sambaMountSchema);
