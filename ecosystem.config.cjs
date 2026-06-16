const path = require('path');
const fs = require('fs');
const deployPath = process.env.DEPLOY_PATH || process.cwd();
const dotenvPath = path.join(deployPath, '.env');

try { require('dotenv').config({ path: dotenvPath }); } catch (e) { /* dotenv optional */ }

// Prefer the AI detector's per-service venv (created by scripts/setup/install.sh)
// over system python3. Falls back to system python3 for deployments that
// pre-date the venv step — ai-detector will fail to start there, but at least
// the failure mode stays the same as today rather than blocking PM2 boot.
const detectorVenvPython = path.join(deployPath, 'src/services/ai-detector/.venv/bin/python3');
const detectorInterpreter = fs.existsSync(detectorVenvPython) ? detectorVenvPython : 'python3';

module.exports = {
  apps: [{
    name: process.env.PM2_PROCESS || 'lan-agent',
    script: './src/index.js',
    cwd: deployPath,
    node_args: '--max-old-space-size=4096',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AGENT_PORT: process.env.AGENT_PORT || '80'
    },
    error_file: './logs/pm2-errors.log',
    out_file: './logs/pm2-output.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '4G',
    max_restarts: 10,
    min_uptime: '5m',
    kill_timeout: 10000,
    listen_timeout: 300000,
    env_production: {
      ...process.env,
      NODE_ENV: 'production',
      AGENT_PORT: process.env.AGENT_PORT || '80'
    }
  },
  {
    name: 'ai-detector',
    script: 'src/services/ai-detector/detector_service.py',
    interpreter: detectorInterpreter,
    args: '--port 5100',
    cwd: deployPath,
    env: {
      TRANSFORMERS_CACHE: path.join(deployPath, 'data', 'model-cache'),
      PYTHONUNBUFFERED: '1',
      DETECTOR_PORT: '5100',
      LOG_LEVEL: 'INFO'
    },
    error_file: './logs/detector-errors.log',
    out_file: './logs/detector-output.log',
    log_file: './logs/detector-combined.log',
    time: true,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '3G',
    max_restarts: 5,
    min_uptime: '10s'
  }]
};