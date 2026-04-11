const path = require('path');
const deployPath = process.env.DEPLOY_PATH || process.cwd();
const dotenvPath = path.join(deployPath, '.env');

try { require('dotenv').config({ path: dotenvPath }); } catch (e) { /* dotenv optional */ }

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
    interpreter: 'python3',
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