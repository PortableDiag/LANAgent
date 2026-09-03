import { Router } from 'express';
import { execFile } from 'child_process';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { hybridAuth } from '../middleware/hybridAuth.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

const MAX_CODE_SIZE = 64 * 1024; // 64KB
const DEFAULT_TIMEOUT = 10;
const MAX_TIMEOUT = 30;
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB stdout/stderr cap

// Runtime configuration bounds
// cpuShares follows Docker's relative scale: 1024 = the full 2-CPU allowance
const RUNTIME_BOUNDS = {
  memory: { min: 128, max: 512 }, // MB
  cpuShares: { min: 100, max: 1024 },
  timeout: { min: 1, max: MAX_TIMEOUT }
};
const MAX_CPUS = 2; // matches the pre-configurable fixed limit

const LANGUAGE_CONFIG = {
  python: {
    image: 'python:3.12-alpine',
    cmd: ['python3', '-']
  },
  node: {
    image: 'node:20-alpine',
    cmd: ['node', '--input-type=module', '-e', '']  // placeholder, code via stdin
  },
  bash: {
    image: 'alpine:3.19',
    cmd: ['sh']
  },
  ruby: {
    image: 'ruby:3.3-alpine',
    cmd: ['ruby']
  },
  go: {
    image: 'golang:1.22-alpine',
    cmd: ['sh', '-c', 'cat > /tmp/main.go && go run /tmp/main.go']
  },
  php: {
    image: 'php:8.3-cli-alpine',
    cmd: ['php']  // reads from stdin
  },
  java: {
    image: 'eclipse-temurin:17-alpine',
    cmd: ['sh', '-c', 'cat > /tmp/Main.java && javac -d /build /tmp/Main.java && java -cp /build Main'],
    needsExecTmpfs: true
  },
  rust: {
    image: 'rust:1.84-alpine',
    cmd: ['sh', '-c', 'cat > /tmp/main.rs && rustc /tmp/main.rs -o /build/main && /build/main'],
    needsExecTmpfs: true
  },
  c: {
    image: 'gcc:14',
    cmd: ['sh', '-c', 'cat > /tmp/main.c && gcc /tmp/main.c -o /build/main -lm && /build/main'],
    needsExecTmpfs: true
  },
  cpp: {
    image: 'gcc:14',
    cmd: ['sh', '-c', 'cat > /tmp/main.cpp && g++ /tmp/main.cpp -o /build/main -lm && /build/main'],
    needsExecTmpfs: true
  },
  typescript: {
    image: 'node:20-alpine',
    cmd: ['sh', '-c', 'npx --yes tsx --eval "$(cat)"']
  },
  perl: {
    image: 'perl:5.40-slim',
    cmd: ['perl']
  },
  kotlin: {
    image: 'zenika/kotlin:1.9',
    cmd: ['sh', '-c', 'cat > /tmp/main.kt && kotlinc /tmp/main.kt -include-runtime -d /build/main.jar 2>/dev/null && java -jar /build/main.jar'],
    needsExecTmpfs: true
  }
};

/**
 * Validates runtime configuration against security bounds
 * @param {Object} runtimeConfig - The runtime configuration to validate
 * @returns {Object} Validated configuration with defaults applied
 */
export function validateRuntimeConfig(runtimeConfig = {}) {
  const validated = {};
  
  // Validate memory
  if (runtimeConfig.memory !== undefined) {
    const memory = parseInt(runtimeConfig.memory);
    if (isNaN(memory) || memory < RUNTIME_BOUNDS.memory.min || memory > RUNTIME_BOUNDS.memory.max) {
      throw new Error(`Memory must be between ${RUNTIME_BOUNDS.memory.min}MB and ${RUNTIME_BOUNDS.memory.max}MB`);
    }
    validated.memory = memory;
  }
  
  // Validate CPU shares
  if (runtimeConfig.cpuShares !== undefined) {
    const cpuShares = parseInt(runtimeConfig.cpuShares);
    if (isNaN(cpuShares) || cpuShares < RUNTIME_BOUNDS.cpuShares.min || cpuShares > RUNTIME_BOUNDS.cpuShares.max) {
      throw new Error(`CPU shares must be between ${RUNTIME_BOUNDS.cpuShares.min} and ${RUNTIME_BOUNDS.cpuShares.max}`);
    }
    validated.cpuShares = cpuShares;
  }
  
  // Validate timeout
  if (runtimeConfig.timeout !== undefined) {
    const timeout = parseInt(runtimeConfig.timeout);
    if (isNaN(timeout) || timeout < RUNTIME_BOUNDS.timeout.min || timeout > RUNTIME_BOUNDS.timeout.max) {
      throw new Error(`Timeout must be between ${RUNTIME_BOUNDS.timeout.min}s and ${RUNTIME_BOUNDS.timeout.max}s`);
    }
    validated.timeout = timeout;
  }
  
  return validated;
}

// Map relative cpuShares (100–1024) onto the fixed CPU allowance; unset = full allowance
export function cpusFromShares(cpuShares) {
  if (cpuShares === undefined) return MAX_CPUS;
  return Math.round((cpuShares / 1024) * MAX_CPUS * 100) / 100;
}

// Node needs special handling — read from stdin via process.stdin
// python3 - reads from stdin, sh reads from stdin, ruby reads from stdin
// node -e reads from arg, so we use a stdin wrapper
function getDockerCmd(language) {
  if (language === 'node') {
    // Read stdin into a variable and eval it
    return ['node', '-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>eval(d))'];
  }
  return LANGUAGE_CONFIG[language].cmd;
}

router.post('/execute',
  ...hybridAuth('code-sandbox', 20),
  async (req, res) => {
    const { language, code, timeout: reqTimeout, runtimeConfig } = req.body;

    // Validate language
    if (!language || !LANGUAGE_CONFIG[language]) {
      return res.status(400).json({
        success: false,
        error: `Invalid language. Supported: ${Object.keys(LANGUAGE_CONFIG).join(', ')}`
      });
    }

    // Validate code
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid code parameter' });
    }

    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_SIZE) {
      return res.status(400).json({ success: false, error: `Code exceeds maximum size of ${MAX_CODE_SIZE / 1024}KB` });
    }

    // Validate runtime configuration
    let validatedRuntimeConfig;
    try {
      validatedRuntimeConfig = validateRuntimeConfig(runtimeConfig);
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const timeout = validatedRuntimeConfig.timeout || Math.min(Math.max(parseInt(reqTimeout) || DEFAULT_TIMEOUT, 1), MAX_TIMEOUT);
    const config = LANGUAGE_CONFIG[language];
    const cmd = getDockerCmd(language);

    // Build Docker arguments with custom runtime config
    const dockerArgs = [
      'run',
      '--rm',
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,size=64m',
      ...(config.needsExecTmpfs ? ['--tmpfs', '/build:rw,exec,size=128m'] : []),
      '--memory', `${validatedRuntimeConfig.memory || 256}m`,
      '--memory-swap', `${validatedRuntimeConfig.memory || 256}m`,
      '--cpus', `${cpusFromShares(validatedRuntimeConfig.cpuShares)}`,
      '--pids-limit', '64',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--user', '1000:1000',
      '--stop-timeout', String(timeout),
      '-i',                // keep stdin open for piping code
      config.image,
      ...cmd
    ];

    const startTime = Date.now();
    const controller = new AbortController();
    const nodeTimeout = setTimeout(() => controller.abort(), (timeout + 5) * 1000);

    try {
      const result = await new Promise((resolve, reject) => {
        const proc = execFile('docker', dockerArgs, {
          signal: controller.signal,
          maxBuffer: MAX_OUTPUT_SIZE,
          timeout: (timeout + 5) * 1000
        }, (error, stdout, stderr) => {
          if (controller.signal.aborted) {
            return resolve({ stdout: '', stderr: 'Execution timed out', exitCode: 124 });
          }
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: error ? (error.code || 1) : 0
          });
        });

        // Pipe code via stdin
        proc.stdin.write(code);
        proc.stdin.end();
      });

      clearTimeout(nodeTimeout);
      const executionTime = Date.now() - startTime;

      // Truncate output if needed
      const maxOut = 100000; // 100KB response cap
      const stdout = result.stdout.length > maxOut ? result.stdout.slice(0, maxOut) + '\n... (truncated)' : result.stdout;
      const stderr = result.stderr.length > maxOut ? result.stderr.slice(0, maxOut) + '\n... (truncated)' : result.stderr;

      res.json({
        success: true,
        stdout,
        stderr,
        exitCode: result.exitCode,
        executionTime: `${executionTime}ms`,
        language,
        runtimeConfig: validatedRuntimeConfig
      });
    } catch (error) {
      clearTimeout(nodeTimeout);
      logger.error('Sandbox execution error:', error);

      if (error.name === 'AbortError' || error.killed) {
        return res.json({
          success: true,
          stdout: '',
          stderr: 'Execution timed out',
          exitCode: 124,
          executionTime: `${Date.now() - startTime}ms`,
          language,
          runtimeConfig: validatedRuntimeConfig
        });
      }

      res.status(500).json({ success: false, error: 'Sandbox execution failed' });
    }
  }
);

router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    languages: Object.keys(LANGUAGE_CONFIG),
    limits: {
      maxCodeSize: MAX_CODE_SIZE,
      maxTimeout: MAX_TIMEOUT,
      maxOutputSize: MAX_OUTPUT_SIZE,
      runtimeBounds: RUNTIME_BOUNDS
    }
  });
});

export default router;
