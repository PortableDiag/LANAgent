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
    const { language, code, timeout: reqTimeout } = req.body;

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

    const timeout = Math.min(Math.max(parseInt(reqTimeout) || DEFAULT_TIMEOUT, 1), MAX_TIMEOUT);
    const config = LANGUAGE_CONFIG[language];
    const cmd = getDockerCmd(language);

    const dockerArgs = [
      'run',
      '--rm',
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,size=64m',
      ...(config.needsExecTmpfs ? ['--tmpfs', '/build:rw,exec,size=128m'] : []),
      '--memory', '256m',
      '--memory-swap', '256m',
      '--cpus', '2',
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
        language
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
          language
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
      maxOutputSize: MAX_OUTPUT_SIZE
    }
  });
});

export default router;
