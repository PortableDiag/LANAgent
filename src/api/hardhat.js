import express from 'express';
import NodeCache from 'node-cache';
import { authenticateToken as authMiddleware } from '../interfaces/web/auth.js';
import hardhatService from '../services/crypto/hardhatService.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL, check every 1 min

// Rate limiter middleware
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

// Apply rate limiting to all routes
router.use(limiter);

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Initialize Hardhat service
 */
router.post('/init', async (req, res) => {
    try {
        await hardhatService.initialize();
        res.json({ 
            success: true, 
            message: 'Hardhat service initialized' 
        });
    } catch (error) {
        logger.error('Hardhat init error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * List all projects
 */
router.get('/projects', async (req, res) => {
    try {
        const cached = cache.get('projects');
        if (cached !== undefined) return res.json(cached);

        const projects = await hardhatService.listProjects();
        const response = { success: true, projects };
        cache.set('projects', response);
        res.json(response);
    } catch (error) {
        logger.error('List projects error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Create a new project
 */
router.post('/projects', async (req, res) => {
    try {
        const { name, template = 'basic' } = req.body;
        
        if (!name) {
            return res.status(400).json({ 
                error: 'Project name is required' 
            });
        }

        const projectPath = await hardhatService.createProject(name, template);
        cache.del('projects');
        res.json({
            success: true,
            project: {
                name,
                path: projectPath,
                template
            }
        });
    } catch (error) {
        logger.error('Create project error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Get project details
 */
router.get('/projects/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const cacheKey = `project_${name}`;
        const cached = cache.get(cacheKey);
        if (cached !== undefined) return res.json(cached);

        const details = await hardhatService.getProjectDetails(name);
        const response = { success: true, project: details };
        cache.set(cacheKey, response);
        res.json(response);
    } catch (error) {
        logger.error('Get project details error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Create a contract
 */
router.post('/projects/:name/contracts', async (req, res) => {
    try {
        const { name: projectName } = req.params;
        const { contractName, template = 'basic' } = req.body;
        
        if (!contractName) {
            return res.status(400).json({ 
                error: 'Contract name is required' 
            });
        }

        const contractPath = await hardhatService.createContract(
            projectName,
            contractName,
            template
        );
        cache.del(`project_${projectName}`);
        cache.del('projects');
        res.json({
            success: true,
            contract: {
                name: contractName,
                path: contractPath,
                template
            }
        });
    } catch (error) {
        logger.error('Create contract error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Compile project
 */
router.post('/projects/:name/compile', async (req, res) => {
    try {
        const { name } = req.params;
        const result = await hardhatService.compile(name);
        cache.del(`project_${name}`);
        cache.del('projects');
        res.json({
            success: true,
            compilation: result
        });
    } catch (error) {
        logger.error('Compile error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Deploy contract to one or multiple networks
 * Supports both 'network' (string) for single network and 'networks' (array) for multi-network deployment
 */
router.post('/projects/:name/deploy', async (req, res) => {
    try {
        const { name: projectName } = req.params;
        const {
            contractName,
            constructorArgs = [],
            network = 'hardhat',
            networks = null  // Optional: array of networks for multi-network deployment
        } = req.body;

        if (!contractName) {
            return res.status(400).json({
                error: 'Contract name is required'
            });
        }

        // Determine target networks (support both single and multi-network)
        const targetNetworks = networks || [network];

        // Deploy to each network with retry logic
        const deploymentResults = await Promise.all(
            targetNetworks.map(async (targetNetwork) => {
                try {
                    const result = await retryOperation(
                        () => hardhatService.deploy(
                            projectName,
                            contractName,
                            constructorArgs,
                            targetNetwork
                        ),
                        {
                            retries: 3,
                            context: `Deploy ${contractName} to ${targetNetwork}`
                        }
                    );
                    return { network: targetNetwork, success: true, ...result };
                } catch (error) {
                    return { network: targetNetwork, success: false, error: error.message };
                }
            })
        );

        // For backward compatibility: if single network, return in original format
        if (!networks && targetNetworks.length === 1) {
            const result = deploymentResults[0];
            if (!result.success) {
                return res.status(500).json({ error: result.error });
            }
            cache.del(`project_${projectName}`);
            cache.del('projects');
            return res.json({
                success: true,
                deployment: result
            });
        }

        // For multi-network deployment, return array format
        const allSuccessful = deploymentResults.every(r => r.success);
        cache.del(`project_${projectName}`);
        cache.del('projects');
        res.json({
            success: allSuccessful,
            deployments: deploymentResults
        });
    } catch (error) {
        logger.error('Deploy error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Run tests
 */
router.post('/projects/:name/test', async (req, res) => {
    try {
        const { name } = req.params;
        const { testFile } = req.body;

        const result = await hardhatService.runTests(name, testFile);
        cache.del(`project_${name}`);
        cache.del('projects');
        res.json({
            success: result.success,
            test: result
        });
    } catch (error) {
        logger.error('Test error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Get available contract templates
 */
router.get('/templates', async (req, res) => {
    try {
        const cached = cache.get('templates');
        if (cached !== undefined) return res.json(cached);

        const templates = hardhatService.getAvailableTemplates();
        const response = { success: true, templates };
        cache.set('templates', response);
        res.json(response);
    } catch (error) {
        logger.error('Get templates error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
    res.json({
        success: true,
        service: 'hardhat',
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

export default router;
