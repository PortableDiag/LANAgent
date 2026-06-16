import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export class DevEnvPlugin {
    constructor() {
        this.name = 'devenv';
        this.version = '1.0.0';
        this.description = 'Development Environment Automation';
        this.projectsPath = process.env.DEVENV_PROJECTS_PATH || '/home/null/dev-projects';
        this.templatesPath = process.env.DEVENV_TEMPLATES_PATH || '/home/null/dev-templates';
        this.runningProjects = new Map(); // Track running dev servers
        this.projectConfigs = new Map(); // Cache project configurations
    }

    async initialize() {
        logger.info('Initializing Development Environment plugin...');
        
        // Ensure projects directory exists
        try {
            await fs.mkdir(this.projectsPath, { recursive: true });
            await fs.mkdir(this.templatesPath, { recursive: true });
            logger.info(`DevEnv projects directory: ${this.projectsPath}`);
        } catch (error) {
            logger.error('Failed to create DevEnv directories:', error);
            throw error;
        }

        // Create default templates if they don't exist
        await this.initializeTemplates();
        
        logger.info('Development Environment plugin initialized');
    }

    async initializeTemplates() {
        const templates = [
            {
                name: 'react-app',
                type: 'frontend',
                framework: 'React',
                description: 'Modern React application with TypeScript',
                packageJson: {
                    name: 'react-app',
                    version: '1.0.0',
                    dependencies: {
                        react: '^18.2.0',
                        'react-dom': '^18.2.0'
                    },
                    devDependencies: {
                        '@types/react': '^18.2.0',
                        '@types/react-dom': '^18.2.0',
                        '@vitejs/plugin-react': '^4.0.0',
                        typescript: '^5.0.0',
                        vite: '^4.4.0'
                    },
                    scripts: {
                        dev: 'vite',
                        build: 'vite build',
                        preview: 'vite preview'
                    }
                }
            },
            {
                name: 'node-api',
                type: 'backend',
                framework: 'Node.js',
                description: 'Express.js API server with TypeScript',
                packageJson: {
                    name: 'node-api',
                    version: '1.0.0',
                    type: 'module',
                    dependencies: {
                        express: '^4.18.2',
                        cors: '^2.8.5',
                        helmet: '^7.0.0'
                    },
                    devDependencies: {
                        '@types/express': '^4.17.17',
                        '@types/cors': '^2.8.13',
                        nodemon: '^3.0.1',
                        typescript: '^5.0.0'
                    },
                    scripts: {
                        dev: 'nodemon src/index.ts',
                        build: 'tsc',
                        start: 'node dist/index.js'
                    }
                }
            },
            {
                name: 'python-web',
                type: 'backend',
                framework: 'Flask',
                description: 'Python Flask web application',
                requirements: [
                    'Flask==2.3.3',
                    'python-dotenv==1.0.0',
                    'requests==2.31.0'
                ]
            }
        ];

        for (const template of templates) {
            const templatePath = path.join(this.templatesPath, template.name);
            if (!fsSync.existsSync(templatePath)) {
                await fs.mkdir(templatePath, { recursive: true });
                
                if (template.packageJson) {
                    await fs.writeFile(
                        path.join(templatePath, 'package.json'),
                        JSON.stringify(template.packageJson, null, 2)
                    );
                }
                
                if (template.requirements) {
                    await fs.writeFile(
                        path.join(templatePath, 'requirements.txt'),
                        template.requirements.join('\n')
                    );
                }

                // Create basic template files
                await this.createTemplateFiles(templatePath, template);
                
                logger.info(`Created template: ${template.name}`);
            }
        }
    }

    async createTemplateFiles(templatePath, template) {
        switch (template.framework) {
            case 'React':
                await this.createReactTemplateFiles(templatePath);
                break;
            case 'Node.js':
                await this.createNodeTemplateFiles(templatePath);
                break;
            case 'Flask':
                await this.createFlaskTemplateFiles(templatePath);
                break;
        }
    }

    async createReactTemplateFiles(templatePath) {
        // Create basic React structure
        await fs.mkdir(path.join(templatePath, 'src'), { recursive: true });
        await fs.mkdir(path.join(templatePath, 'public'), { recursive: true });
        
        // App.tsx
        const appTsx = `import React from 'react';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>Welcome to React</h1>
        <p>Start building your amazing application!</p>
      </header>
    </div>
  );
}

export default App;`;
        
        await fs.writeFile(path.join(templatePath, 'src', 'App.tsx'), appTsx);
        
        // index.tsx
        const indexTsx = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(<App />);`;
        
        await fs.writeFile(path.join(templatePath, 'src', 'index.tsx'), indexTsx);
        
        // index.html
        const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>React App</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/index.tsx"></script>
</body>
</html>`;
        
        await fs.writeFile(path.join(templatePath, 'index.html'), indexHtml);
        
        // vite.config.ts
        const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true
  }
})`;
        
        await fs.writeFile(path.join(templatePath, 'vite.config.ts'), viteConfig);
    }

    async createNodeTemplateFiles(templatePath) {
        await fs.mkdir(path.join(templatePath, 'src'), { recursive: true });
        
        // index.ts
        const indexTs = `import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to your Node.js API!' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});`;
        
        await fs.writeFile(path.join(templatePath, 'src', 'index.ts'), indexTs);
        
        // tsconfig.json
        const tsconfig = {
            compilerOptions: {
                target: 'ES2020',
                module: 'ESNext',
                moduleResolution: 'node',
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
                strict: true,
                skipLibCheck: true,
                forceConsistentCasingInFileNames: true,
                outDir: './dist',
                rootDir: './src'
            },
            include: ['src/**/*'],
            exclude: ['node_modules', 'dist']
        };
        
        await fs.writeFile(
            path.join(templatePath, 'tsconfig.json'),
            JSON.stringify(tsconfig, null, 2)
        );
    }

    async createFlaskTemplateFiles(templatePath) {
        // app.py
        const appPy = `from flask import Flask, jsonify
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

@app.route('/')
def home():
    return jsonify({
        'message': 'Welcome to your Flask API!',
        'status': 'success'
    })

@app.route('/health')
def health():
    return jsonify({
        'status': 'OK',
        'service': 'Flask API'
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)`;
        
        await fs.writeFile(path.join(templatePath, 'app.py'), appPy);
        
        // .env template
        const envTemplate = `PORT=5000
FLASK_ENV=development
SECRET_KEY=your-secret-key-here`;
        
        await fs.writeFile(path.join(templatePath, '.env.example'), envTemplate);
    }

    async getCommands() {
        return {
            // Project management
            createProject: this.createProject.bind(this),
            listProjects: this.listProjects.bind(this),
            deleteProject: this.deleteProject.bind(this),
            getProjectDetails: this.getProjectDetails.bind(this),
            getProjects: this.getProjects.bind(this), // Alias for web interface
            getStatus: this.getStatus.bind(this), // Status method for web interface
            
            // Template management
            listTemplates: this.listTemplates.bind(this),
            createTemplate: this.createTemplate.bind(this),
            
            // Development operations
            installDependencies: this.installDependencies.bind(this),
            startDevServer: this.startDevServer.bind(this),
            stopDevServer: this.stopDevServer.bind(this),
            buildProject: this.buildProject.bind(this),
            runTests: this.runTests.bind(this),
            
            // Environment management
            getEnvironmentVariables: this.getEnvironmentVariables.bind(this),
            setEnvironmentVariable: this.setEnvironmentVariable.bind(this),
            deleteEnvironmentVariable: this.deleteEnvironmentVariable.bind(this),
            
            // Project monitoring
            getProjectStatus: this.getProjectStatus.bind(this),
            getProjectLogs: this.getProjectLogs.bind(this),
            
            // Git operations
            initGitRepo: this.initGitRepo.bind(this),
            commitChanges: this.commitChanges.bind(this),
            listProjectVersions: this.listProjectVersions.bind(this),
            rollbackProjectVersion: this.rollbackProjectVersion.bind(this),
            
            // Utilities
            getAvailableFrameworks: this.getAvailableFrameworks.bind(this)
        };
    }

    async createProject({ name, type, framework, path: projectPath, template, gitRepo, dependencies }) {
        try {
            const fullPath = projectPath || path.join(this.projectsPath, name);
            
            // Check if project already exists
            if (fsSync.existsSync(fullPath)) {
                throw new Error(`Project ${name} already exists at ${fullPath}`);
            }

            // Create project directory
            await fs.mkdir(fullPath, { recursive: true });
            
            // Clone from git or use template
            if (gitRepo) {
                await this.cloneFromGit(gitRepo, fullPath);
            } else if (template) {
                await this.createFromTemplate(template, fullPath, name);
            } else {
                await this.createEmptyProject(fullPath, name, type, framework);
            }

            // Install additional dependencies if specified
            if (dependencies && dependencies.length > 0) {
                await this.installDependencies({ path: fullPath, packages: dependencies });
            }

            // Initialize git if not from repo
            if (!gitRepo) {
                await this.initGitRepo({ path: fullPath });
            }

            const projectConfig = {
                name,
                type,
                framework,
                path: fullPath,
                created: new Date().toISOString(),
                status: 'created'
            };

            await this.saveProjectConfig(fullPath, projectConfig);
            this.projectConfigs.set(name, projectConfig);

            logger.info(`Created project: ${name} at ${fullPath}`);
            return { success: true, path: fullPath, config: projectConfig };

        } catch (error) {
            logger.error(`Failed to create project ${name}:`, error);
            throw error;
        }
    }

    async cloneFromGit(gitRepo, targetPath) {
        try {
            const { stdout, stderr } = await execAsync(`git clone "${gitRepo}" "${targetPath}"`);
            logger.info(`Cloned repository: ${gitRepo}`);
            return { stdout, stderr };
        } catch (error) {
            logger.error(`Failed to clone repository ${gitRepo}:`, error);
            throw error;
        }
    }

    async createFromTemplate(templateName, targetPath, projectName) {
        const templatePath = path.join(this.templatesPath, templateName);
        
        if (!fsSync.existsSync(templatePath)) {
            throw new Error(`Template ${templateName} not found`);
        }

        // Copy template files
        await this.copyDirectory(templatePath, targetPath);
        
        // Update package.json with project name if it exists
        const packageJsonPath = path.join(targetPath, 'package.json');
        if (fsSync.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
            packageJson.name = projectName;
            await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
        }

        logger.info(`Created project from template: ${templateName}`);
    }

    async createEmptyProject(projectPath, name, type, framework) {
        // Create basic project structure
        await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
        
        // Create basic package.json for Node.js projects
        if (framework === 'Node.js') {
            const packageJson = {
                name,
                version: '1.0.0',
                type: 'module',
                main: 'src/index.js',
                scripts: {
                    start: 'node src/index.js',
                    dev: 'nodemon src/index.js'
                }
            };
            
            await fs.writeFile(
                path.join(projectPath, 'package.json'),
                JSON.stringify(packageJson, null, 2)
            );
        }

        // Create basic index file
        let indexContent = '';
        let indexFile = '';

        switch (framework) {
            case 'Node.js':
                indexFile = 'src/index.js';
                indexContent = `console.log('Hello from ${name}!');\n`;
                break;
            case 'React':
                indexFile = 'src/App.js';
                indexContent = `import React from 'react';\n\nfunction App() {\n  return <h1>Hello from ${name}!</h1>;\n}\n\nexport default App;\n`;
                break;
            case 'Python':
                indexFile = 'main.py';
                indexContent = `print("Hello from ${name}!")\n`;
                break;
            default:
                indexFile = 'src/main.js';
                indexContent = `console.log('Hello from ${name}!');\n`;
        }

        await fs.writeFile(path.join(projectPath, indexFile), indexContent);
        logger.info(`Created empty ${framework} project: ${name}`);
    }

    async copyDirectory(source, target) {
        const files = await fs.readdir(source, { withFileTypes: true });
        
        for (const file of files) {
            const sourcePath = path.join(source, file.name);
            const targetPath = path.join(target, file.name);
            
            if (file.isDirectory()) {
                await fs.mkdir(targetPath, { recursive: true });
                await this.copyDirectory(sourcePath, targetPath);
            } else {
                await fs.copyFile(sourcePath, targetPath);
            }
        }
    }

    async saveProjectConfig(projectPath, config) {
        const configPath = path.join(projectPath, '.devenv.json');
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    }

    async loadProjectConfig(projectPath) {
        const configPath = path.join(projectPath, '.devenv.json');
        if (fsSync.existsSync(configPath)) {
            const content = await fs.readFile(configPath, 'utf8');
            return JSON.parse(content);
        }
        return null;
    }

    async listProjects() {
        try {
            const projects = [];
            const dirs = await fs.readdir(this.projectsPath, { withFileTypes: true });
            
            for (const dir of dirs) {
                if (dir.isDirectory()) {
                    const projectPath = path.join(this.projectsPath, dir.name);
                    const config = await this.loadProjectConfig(projectPath);
                    
                    if (config) {
                        // Add runtime status
                        config.isRunning = this.runningProjects.has(dir.name);
                        if (config.isRunning) {
                            const processInfo = this.runningProjects.get(dir.name);
                            config.port = processInfo.port;
                            config.pid = processInfo.process.pid;
                        }
                        projects.push(config);
                    } else {
                        // Create basic config for projects without .devenv.json
                        const basicConfig = {
                            name: dir.name,
                            path: projectPath,
                            type: 'unknown',
                            framework: 'unknown',
                            status: 'exists',
                            isRunning: false
                        };
                        projects.push(basicConfig);
                    }
                }
            }
            
            return { success: true, projects };
        } catch (error) {
            logger.error('Failed to list projects:', error);
            throw error;
        }
    }

    async deleteProject({ name, path: projectPath }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            
            // Stop dev server if running
            if (this.runningProjects.has(name)) {
                await this.stopDevServer({ name });
            }

            // Remove project directory
            await fs.rm(targetPath, { recursive: true, force: true });
            
            // Clean up cached config
            this.projectConfigs.delete(name);
            
            logger.info(`Deleted project: ${name}`);
            return { success: true, message: `Project ${name} deleted successfully` };

        } catch (error) {
            logger.error(`Failed to delete project ${name}:`, error);
            throw error;
        }
    }

    async getProjectDetails({ name, path: projectPath }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            const config = await this.loadProjectConfig(targetPath);
            
            if (!config) {
                throw new Error(`Project configuration not found for ${name}`);
            }

            // Add runtime information
            config.isRunning = this.runningProjects.has(name);
            if (config.isRunning) {
                const processInfo = this.runningProjects.get(name);
                config.port = processInfo.port;
                config.pid = processInfo.process.pid;
                config.startTime = processInfo.startTime;
            }

            // Get package.json info if it exists
            const packageJsonPath = path.join(targetPath, 'package.json');
            if (fsSync.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
                config.scripts = packageJson.scripts || {};
                config.dependencies = packageJson.dependencies || {};
                config.devDependencies = packageJson.devDependencies || {};
            }

            // Get environment variables
            const envPath = path.join(targetPath, '.env');
            if (fsSync.existsSync(envPath)) {
                const envContent = await fs.readFile(envPath, 'utf8');
                config.envVariables = this.parseEnvFile(envContent);
            } else {
                config.envVariables = {};
            }

            return { success: true, project: config };

        } catch (error) {
            logger.error(`Failed to get project details for ${name}:`, error);
            throw error;
        }
    }

    async listTemplates() {
        try {
            const templates = [];
            const dirs = await fs.readdir(this.templatesPath, { withFileTypes: true });
            
            for (const dir of dirs) {
                if (dir.isDirectory()) {
                    const templatePath = path.join(this.templatesPath, dir.name);
                    
                    // Get template info from package.json or create basic info
                    const packageJsonPath = path.join(templatePath, 'package.json');
                    let templateInfo = { name: dir.name, path: templatePath };
                    
                    if (fsSync.existsSync(packageJsonPath)) {
                        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
                        templateInfo.description = packageJson.description;
                        templateInfo.framework = 'Node.js';
                        templateInfo.type = 'backend';
                    } else {
                        // Check for other framework indicators
                        if (fsSync.existsSync(path.join(templatePath, 'requirements.txt'))) {
                            templateInfo.framework = 'Python';
                            templateInfo.type = 'backend';
                        }
                    }
                    
                    templates.push(templateInfo);
                }
            }
            
            return { success: true, templates };
        } catch (error) {
            logger.error('Failed to list templates:', error);
            throw error;
        }
    }

    async installDependencies({ name, path: projectPath, packages }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            
            // Check if it's a Node.js project
            const packageJsonPath = path.join(targetPath, 'package.json');
            if (fsSync.existsSync(packageJsonPath)) {
                const installCmd = packages ? `npm install ${packages.join(' ')}` : 'npm install';
                const { stdout, stderr } = await execAsync(installCmd, { cwd: targetPath });
                logger.info(`Installed dependencies for ${name}`);
                return { success: true, stdout, stderr };
            }
            
            // Check if it's a Python project
            const requirementsPath = path.join(targetPath, 'requirements.txt');
            if (fsSync.existsSync(requirementsPath)) {
                const { stdout, stderr } = await execAsync('pip install -r requirements.txt', { cwd: targetPath });
                logger.info(`Installed Python dependencies for ${name}`);
                return { success: true, stdout, stderr };
            }
            
            throw new Error(`No dependency file found for project ${name}`);

        } catch (error) {
            logger.error(`Failed to install dependencies for ${name}:`, error);
            throw error;
        }
    }

    async startDevServer({ name, path: projectPath, port }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            
            // Check if already running
            if (this.runningProjects.has(name)) {
                throw new Error(`Dev server for ${name} is already running`);
            }

            let command, args;
            let serverPort = port || 3000;

            // Determine command based on project type
            const packageJsonPath = path.join(targetPath, 'package.json');
            if (fsSync.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
                if (packageJson.scripts && packageJson.scripts.dev) {
                    const devScript = packageJson.scripts.dev.split(' ');
                    command = devScript[0];
                    args = devScript.slice(1);
                } else {
                    command = 'npm';
                    args = ['start'];
                }
            } else if (fsSync.existsSync(path.join(targetPath, 'app.py'))) {
                // Python Flask app
                command = 'python';
                args = ['app.py'];
                serverPort = port || 5000;
            } else {
                throw new Error(`Cannot determine how to start dev server for ${name}`);
            }

            // Set PORT environment variable
            const env = { ...process.env, PORT: serverPort.toString() };

            // Spawn the process
            const childProcess = spawn(command, args, {
                cwd: targetPath,
                env,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Store process info
            this.runningProjects.set(name, {
                process: childProcess,
                port: serverPort,
                startTime: new Date().toISOString(),
                logs: []
            });

            // Handle process output
            childProcess.stdout.on('data', (data) => {
                const message = data.toString();
                this.addProjectLog(name, 'stdout', message);
            });

            childProcess.stderr.on('data', (data) => {
                const message = data.toString();
                this.addProjectLog(name, 'stderr', message);
            });

            childProcess.on('exit', (code) => {
                logger.info(`Dev server for ${name} exited with code ${code}`);
                this.runningProjects.delete(name);
            });

            logger.info(`Started dev server for ${name} on port ${serverPort}`);
            return { 
                success: true, 
                port: serverPort, 
                pid: childProcess.pid,
                message: `Dev server started for ${name} on port ${serverPort}`
            };

        } catch (error) {
            logger.error(`Failed to start dev server for ${name}:`, error);
            throw error;
        }
    }

    async stopDevServer({ name }) {
        try {
            if (!this.runningProjects.has(name)) {
                throw new Error(`No running dev server found for ${name}`);
            }

            const processInfo = this.runningProjects.get(name);
            processInfo.process.kill('SIGTERM');
            
            // Wait a bit for graceful shutdown
            setTimeout(() => {
                if (this.runningProjects.has(name)) {
                    processInfo.process.kill('SIGKILL');
                }
            }, 5000);

            this.runningProjects.delete(name);
            logger.info(`Stopped dev server for ${name}`);
            
            return { success: true, message: `Dev server stopped for ${name}` };

        } catch (error) {
            logger.error(`Failed to stop dev server for ${name}:`, error);
            throw error;
        }
    }

    async buildProject({ name, path: projectPath }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            
            const packageJsonPath = path.join(targetPath, 'package.json');
            if (fsSync.existsSync(packageJsonPath)) {
                const { stdout, stderr } = await execAsync('npm run build', { cwd: targetPath });
                logger.info(`Built project ${name}`);
                return { success: true, stdout, stderr };
            }
            
            throw new Error(`Cannot determine how to build project ${name}`);

        } catch (error) {
            logger.error(`Failed to build project ${name}:`, error);
            throw error;
        }
    }

    async runTests({ name, path: projectPath }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            
            const packageJsonPath = path.join(targetPath, 'package.json');
            if (fsSync.existsSync(packageJsonPath)) {
                const { stdout, stderr } = await execAsync('npm test', { cwd: targetPath });
                logger.info(`Ran tests for project ${name}`);
                return { success: true, stdout, stderr };
            }
            
            throw new Error(`Cannot determine how to run tests for project ${name}`);

        } catch (error) {
            logger.error(`Failed to run tests for project ${name}:`, error);
            throw error;
        }
    }

    addProjectLog(projectName, type, message) {
        if (this.runningProjects.has(projectName)) {
            const processInfo = this.runningProjects.get(projectName);
            processInfo.logs.push({
                type,
                message: message.trim(),
                timestamp: new Date().toISOString()
            });
            
            // Keep only last 100 log entries
            if (processInfo.logs.length > 100) {
                processInfo.logs = processInfo.logs.slice(-100);
            }
        }
    }

    async getProjectLogs({ name, lines = 50 }) {
        try {
            if (this.runningProjects.has(name)) {
                const processInfo = this.runningProjects.get(name);
                const logs = processInfo.logs.slice(-lines);
                return { success: true, logs };
            }
            
            return { success: true, logs: [], message: 'Project not currently running' };

        } catch (error) {
            logger.error(`Failed to get logs for project ${name}:`, error);
            throw error;
        }
    }

    async getProjectStatus({ name, path: projectPath }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            const isRunning = this.runningProjects.has(name);
            
            let status = {
                name,
                path: targetPath,
                isRunning,
                exists: fsSync.existsSync(targetPath)
            };

            if (isRunning) {
                const processInfo = this.runningProjects.get(name);
                status.port = processInfo.port;
                status.pid = processInfo.process.pid;
                status.startTime = processInfo.startTime;
                status.uptime = Date.now() - new Date(processInfo.startTime).getTime();
            }

            return { success: true, status };

        } catch (error) {
            logger.error(`Failed to get status for project ${name}:`, error);
            throw error;
        }
    }

    parseEnvFile(content) {
        const variables = {};
        const lines = content.split('\n');
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith('#')) {
                const [key, ...valueParts] = trimmedLine.split('=');
                if (key && valueParts.length > 0) {
                    variables[key] = valueParts.join('=');
                }
            }
        }
        
        return variables;
    }

    async getEnvironmentVariables({ name, path: projectPath }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            const envPath = path.join(targetPath, '.env');
            
            if (fsSync.existsSync(envPath)) {
                const content = await fs.readFile(envPath, 'utf8');
                const variables = this.parseEnvFile(content);
                return { success: true, variables };
            }
            
            return { success: true, variables: {} };

        } catch (error) {
            logger.error(`Failed to get environment variables for ${name}:`, error);
            throw error;
        }
    }

    async setEnvironmentVariable({ name, path: projectPath, key, value }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            const envPath = path.join(targetPath, '.env');
            
            let content = '';
            if (fsSync.existsSync(envPath)) {
                content = await fs.readFile(envPath, 'utf8');
            }

            const lines = content.split('\n');
            let found = false;

            // Update existing variable or add new one
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith(`${key}=`)) {
                    lines[i] = `${key}=${value}`;
                    found = true;
                    break;
                }
            }

            if (!found) {
                lines.push(`${key}=${value}`);
            }

            await fs.writeFile(envPath, lines.join('\n'));
            logger.info(`Set environment variable ${key} for project ${name}`);
            
            return { success: true, message: `Environment variable ${key} set successfully` };

        } catch (error) {
            logger.error(`Failed to set environment variable for ${name}:`, error);
            throw error;
        }
    }

    async deleteEnvironmentVariable({ name, path: projectPath, key }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            const envPath = path.join(targetPath, '.env');
            
            if (!fsSync.existsSync(envPath)) {
                throw new Error('No .env file found');
            }

            const content = await fs.readFile(envPath, 'utf8');
            const lines = content.split('\n').filter(line => {
                const trimmedLine = line.trim();
                return !trimmedLine.startsWith(`${key}=`);
            });

            await fs.writeFile(envPath, lines.join('\n'));
            logger.info(`Deleted environment variable ${key} for project ${name}`);
            
            return { success: true, message: `Environment variable ${key} deleted successfully` };

        } catch (error) {
            logger.error(`Failed to delete environment variable for ${name}:`, error);
            throw error;
        }
    }

    async initGitRepo({ name, path: projectPath }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            
            if (fsSync.existsSync(path.join(targetPath, '.git'))) {
                return { success: true, message: 'Git repository already exists' };
            }

            await execAsync('git init', { cwd: targetPath });
            
            // Create basic .gitignore
            const gitignoreContent = `node_modules/
dist/
build/
.env
.DS_Store
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.vscode/
.idea/
`;
            
            await fs.writeFile(path.join(targetPath, '.gitignore'), gitignoreContent);
            
            // Initial commit
            await execAsync('git add .', { cwd: targetPath });
            await execAsync('git commit -m "Initial commit"', { cwd: targetPath });
            
            logger.info(`Initialized git repository for project ${name}`);
            return { success: true, message: 'Git repository initialized successfully' };

        } catch (error) {
            logger.error(`Failed to initialize git repo for ${name}:`, error);
            throw error;
        }
    }

    async commitChanges({ name, path: projectPath, message }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            const commitMessage = message || `Update project ${name}`;
            
            await execAsync('git add .', { cwd: targetPath });
            await execAsync(`git commit -m "${commitMessage}"`, { cwd: targetPath });
            
            logger.info(`Committed changes for project ${name}`);
            return { success: true, message: 'Changes committed successfully' };

        } catch (error) {
            logger.error(`Failed to commit changes for ${name}:`, error);
            throw error;
        }
    }

    async listProjectVersions({ name, path: projectPath, limit }) {
        try {
            const targetPath = projectPath || path.join(this.projectsPath, name);
            const gitDir = path.join(targetPath, '.git');

            if (!fsSync.existsSync(gitDir)) {
                return { success: false, error: 'Project is not a git repository' };
            }

            const maxEntries = Math.min(limit || 50, 200);
            const { stdout } = await execAsync(
                `git log --format="%H|%h|%s|%an|%ai" -${maxEntries}`,
                { cwd: targetPath }
            );

            const versions = stdout.trim().split('\n').filter(Boolean).map(line => {
                const [hash, shortHash, subject, author, date] = line.split('|');
                return { hash, shortHash, subject, author, date };
            });

            logger.info(`Listed ${versions.length} versions for project ${name}`);
            return { success: true, versions, total: versions.length };

        } catch (error) {
            logger.error(`Failed to list versions for ${name}:`, error);
            throw error;
        }
    }

    async rollbackProjectVersion({ name, path: projectPath, version }) {
        try {
            if (!version) {
                return { success: false, error: 'Version (commit hash) is required' };
            }

            const targetPath = projectPath || path.join(this.projectsPath, name);
            const gitDir = path.join(targetPath, '.git');

            if (!fsSync.existsSync(gitDir)) {
                return { success: false, error: 'Project is not a git repository' };
            }

            // Validate the commit exists
            try {
                await execAsync(`git cat-file -t ${version}`, { cwd: targetPath });
            } catch {
                return { success: false, error: `Invalid version: ${version}` };
            }

            // Check for uncommitted changes
            const { stdout: status } = await execAsync('git status --porcelain', { cwd: targetPath });
            if (status.trim()) {
                // Auto-commit working changes before rollback
                await execAsync('git add .', { cwd: targetPath });
                await execAsync(`git commit -m "Auto-save before rollback to ${version}"`, { cwd: targetPath });
                logger.info(`Auto-committed working changes before rollback for ${name}`);
            }

            await execAsync(`git checkout ${version} -- .`, { cwd: targetPath });

            logger.info(`Rolled back project ${name} to version ${version}`);
            return { success: true, message: `Project rolled back to version ${version}` };

        } catch (error) {
            logger.error(`Failed to rollback project ${name}:`, error);
            throw error;
        }
    }

    async getAvailableFrameworks() {
        return {
            success: true,
            frameworks: {
                frontend: ['React', 'Vue', 'Angular', 'Vanilla JavaScript'],
                backend: ['Node.js', 'Python', 'Flask', 'Django', 'Express'],
                fullstack: ['Next.js', 'Nuxt.js', 'SvelteKit']
            }
        };
    }

    async getStatus() {
        try {
            // Get Node.js version
            let nodeVersion = 'Unknown';
            try {
                const { stdout } = await execAsync('node --version');
                nodeVersion = stdout.trim();
            } catch (error) {
                logger.warn('Could not get Node.js version:', error);
            }

            // Count active projects
            const projects = await this.listProjects();
            const activeProjects = projects.success ? projects.projects.length : 0;

            // Count running servers
            const runningServers = this.runningProjects.size;

            // Get last build time (check for any recent build artifacts)
            let lastBuild = null;
            try {
                const projectDirs = await fs.readdir(this.projectsPath).catch(() => []);
                let latestBuildTime = 0;
                
                for (const projectDir of projectDirs) {
                    const projectPath = path.join(this.projectsPath, projectDir);
                    const distPath = path.join(projectPath, 'dist');
                    const buildPath = path.join(projectPath, 'build');
                    
                    for (const buildDir of [distPath, buildPath]) {
                        try {
                            const stats = await fs.stat(buildDir);
                            if (stats.mtime.getTime() > latestBuildTime) {
                                latestBuildTime = stats.mtime.getTime();
                                lastBuild = stats.mtime;
                            }
                        } catch (error) {
                            // Build directory doesn't exist, continue
                        }
                    }
                }
            } catch (error) {
                logger.warn('Could not determine last build time:', error);
            }

            return {
                success: true,
                data: {
                    activeProjects,
                    runningServers,
                    nodeVersion,
                    lastBuild: lastBuild ? lastBuild.toISOString() : null,
                    projectsPath: this.projectsPath,
                    templatesPath: this.templatesPath
                }
            };
        } catch (error) {
            logger.error('Failed to get DevEnv status:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async getProjects() {
        try {
            const result = await this.listProjects();
            if (result.success) {
                return {
                    success: true,
                    data: result.projects || []
                };
            } else {
                return {
                    success: false,
                    error: result.error || 'Failed to get projects'
                };
            }
        } catch (error) {
            logger.error('Failed to get DevEnv projects:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async execute(params) {
        const { action, ...args } = params;
        
        try {
            const commands = await this.getCommands();
            if (commands[action]) {
                return await commands[action](args);
            } else {
                throw new Error(`Unknown DevEnv action: ${action}`);
            }
        } catch (error) {
            logger.error(`DevEnv Plugin error in ${action}:`, error);
            throw error;
        }
    }
}