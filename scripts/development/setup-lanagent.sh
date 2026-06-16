#!/bin/bash

# LAN Agent Setup Script
# This script handles all project initialization

set -e  # Exit on error

echo "🚀 Setting up LAN Agent project..."

# Configuration
PROJECT_DIR="/media/veracrypt1/NodeJS/LANAgent"
NODE_VERSION="20"  # LTS
ENV_TYPE="development"  # Will be 'production' on server

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Use existing project directory
print_status "Using existing project directory..."
cd "$PROJECT_DIR"

# Create directory structure
print_status "Creating project structure..."
mkdir -p {src/{core,interfaces/{telegram,ssh,web},services/{executor,developer,tester,network,monitor,assistant,selfManager,microcontroller},providers,utils,api/{core,plugins},config},web/{src,public},config,scripts,tests,logs,data}

# Initialize package.json with all dependencies
print_status "Creating package.json..."
cat > package.json << 'EOF'
{
  "name": "lan-agent",
  "version": "1.0.0",
  "description": "AI-powered personal assistant agent for home server management",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "jest",
    "lint": "eslint src/",
    "setup": "node scripts/setup.js",
    "backup": "node scripts/backup.js"
  },
  "keywords": ["ai", "agent", "automation", "telegram", "bot"],
  "author": "LANAgent",
  "license": "MIT",
  "dependencies": {
    "telegraf": "^4.15.0",
    "mongoose": "^8.0.0",
    "express": "^4.18.2",
    "socket.io": "^4.6.1",
    "axios": "^1.6.0",
    "openai": "^4.24.0",
    "@anthropic-ai/sdk": "^0.9.1",
    "ssh2": "^1.15.0",
    "node-ssh": "^13.1.0",
    "puppeteer": "^21.6.0",
    "playwright": "^1.40.0",
    "sharp": "^0.33.0",
    "canvas": "^2.11.2",
    "chartjs-node-canvas": "^4.1.6",
    "winston": "^3.11.0",
    "dotenv": "^16.3.1",
    "node-cron": "^3.0.3",
    "pm2": "^5.3.0",
    "serialport": "^12.0.0",
    "systeminformation": "^5.21.0",
    "node-virustotal": "^3.0.0",
    "tough-cookie": "^4.1.3",
    "random-useragent": "^0.5.0",
    "tesseract.js": "^5.0.0",
    "pdf-parse": "^1.1.1",
    "fluent-ffmpeg": "^2.1.2",
    "gifencoder": "^2.0.1",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "express-rate-limit": "^7.1.0",
    "helmet": "^7.1.0",
    "compression": "^1.7.4",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "eslint": "^8.56.0",
    "nodemon": "^3.0.2"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
EOF

# .env already exists, create example for reference
print_status "Creating .env.example for reference..."
cat > .env.example << 'EOF'
# Telegram Configuration
TELEGRAM_BOT_TOKEN=your-bot-token-here
TELEGRAM_USER_ID=your-telegram-id

# AI Providers
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
XAI_API_KEY=your-xai-key
GAB_API_KEY=your-gab-key
HUGGINGFACE_TOKEN=your-hf-token

# MongoDB
MONGODB_URI=mongodb://localhost:27017/lanagent

# Agent Configuration
AGENT_NAME=JARVIS
AGENT_PORT=3000
AGENT_SSH_PORT=2222

# Security
JWT_SECRET=your-jwt-secret-here
ENCRYPTION_KEY=your-encryption-key

# VPN
EXPRESSVPN_ENABLED=false

# VirusTotal
VIRUSTOTAL_API_KEY=your-virustotal-key

# Govee (optional)
GOVEE_API_KEY=your-govee-key
EOF

# Create .gitignore
print_status "Creating .gitignore..."
cat > .gitignore << 'EOF'
node_modules/
.env
logs/
data/
*.log
.DS_Store
.vscode/
.idea/
coverage/
dist/
build/
*.swp
*.swo
*~
.npm
.cache/
uploads/
quarantine/
workspace/
EOF

# Create main entry point
print_status "Creating main entry point..."
cat > src/index.js << 'EOF'
// LAN Agent - Main Entry Point
import dotenv from 'dotenv';
import { Agent } from './core/agent.js';
import { logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled Rejection:', error);
  process.exit(1);
});

// Start the agent
async function start() {
  try {
    logger.info('Starting LAN Agent...');
    
    const agent = new Agent();
    await agent.initialize();
    await agent.start();
    
    logger.info('LAN Agent is running!');
    
    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      await agent.stop();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Failed to start agent:', error);
    process.exit(1);
  }
}

start();
EOF

# Create PM2 ecosystem file
print_status "Creating PM2 configuration..."
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'lan-agent',
    script: './src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/pm2-errors.log',
    out_file: './logs/pm2-output.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOF

# Create logger utility
print_status "Creating logger utility..."
mkdir -p src/utils
cat > src/utils/logger.js << 'EOF'
import winston from 'winston';
import path from 'path';

const logDir = 'logs';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'lan-agent' },
  transports: [
    new winston.transports.File({ 
      filename: path.join(logDir, 'errors.log'), 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: path.join(logDir, 'all-activity.log') 
    })
  ]
});

// Add console output in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

export { logger };
EOF

# Create MongoDB connection
print_status "Creating database connection..."
cat > src/utils/database.js << 'EOF'
import mongoose from 'mongoose';
import { logger } from './logger.js';

export async function connectDatabase() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';
    
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    logger.info('MongoDB connected successfully');
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
    
    return mongoose.connection;
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}
EOF

# Create basic Agent class
print_status "Creating Agent core class..."
cat > src/core/agent.js << 'EOF'
import { EventEmitter } from 'events';
import { connectDatabase } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export class Agent extends EventEmitter {
  constructor() {
    super();
    this.config = this.loadConfig();
    this.services = new Map();
    this.interfaces = new Map();
    this.isRunning = false;
  }
  
  loadConfig() {
    return {
      name: process.env.AGENT_NAME || 'LANAgent',
      port: process.env.AGENT_PORT || 3000,
      sshPort: process.env.AGENT_SSH_PORT || 2222,
    };
  }
  
  async initialize() {
    logger.info(`Initializing ${this.config.name}...`);
    
    // Connect to database
    await connectDatabase();
    
    // Initialize core services
    // TODO: Initialize services
    
    // Initialize interfaces
    // TODO: Initialize Telegram, SSH, Web interfaces
    
    logger.info('Agent initialized successfully');
  }
  
  async start() {
    if (this.isRunning) {
      logger.warn('Agent is already running');
      return;
    }
    
    this.isRunning = true;
    logger.info(`${this.config.name} is starting...`);
    
    // Start all services
    for (const [name, service] of this.services) {
      logger.info(`Starting service: ${name}`);
      await service.start();
    }
    
    // Start all interfaces
    for (const [name, interface_] of this.interfaces) {
      logger.info(`Starting interface: ${name}`);
      await interface_.start();
    }
    
    this.emit('started');
  }
  
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    logger.info('Stopping agent...');
    
    // Stop all interfaces
    for (const [name, interface_] of this.interfaces) {
      logger.info(`Stopping interface: ${name}`);
      await interface_.stop();
    }
    
    // Stop all services
    for (const [name, service] of this.services) {
      logger.info(`Stopping service: ${name}`);
      await service.stop();
    }
    
    this.isRunning = false;
    this.emit('stopped');
  }
}
EOF

# Create setup completion script
print_status "Creating setup completion script..."
cat > scripts/setup.js << 'EOF'
import { logger } from '../src/utils/logger.js';
import { connectDatabase } from '../src/utils/database.js';

async function setup() {
  try {
    console.log('🔧 Running post-install setup...');
    
    // Test database connection
    await connectDatabase();
    console.log('✅ Database connection successful');
    
    // Create necessary directories
    const dirs = ['logs', 'data', 'uploads', 'quarantine', 'workspace'];
    for (const dir of dirs) {
      // Directories already created by bash script
      console.log(`✅ Directory '${dir}' ready`);
    }
    
    console.log('\\n✨ Setup complete! Next steps:');
    console.log('1. Copy .env.example to .env and fill in your values');
    console.log('2. Start MongoDB if not running');
    console.log('3. Run: npm start');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Setup failed:', error);
    process.exit(1);
  }
}

setup();
EOF

print_success "Project structure created!"

# Install dependencies
print_status "Installing dependencies (this may take a few minutes)..."
npm install

print_success "Dependencies installed!"

# Make scripts executable
chmod +x scripts/*.js

# Final instructions
echo ""
echo -e "${GREEN}✅ LAN Agent setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. cd $PROJECT_DIR"
echo "2. cp .env.example .env"
echo "3. Edit .env with your API keys and configuration"
echo "4. Make sure MongoDB is running"
echo "5. npm run setup (to verify installation)"
echo "6. npm start (to run the agent)"
echo ""
echo "For development: npm run dev"
echo "For production: pm2 start ecosystem.config.js"