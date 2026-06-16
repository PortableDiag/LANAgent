import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import Project from '../../models/Project.js';
import { Task } from '../../models/Task.js';
import path from 'path';
import fs from 'fs/promises';

export default class ProjectsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'projects';
    this.version = '2.0.0';
    this.description = 'Project management with task integration (MongoDB-based)';
    this.commands = [
      {
        command: 'create',
        description: 'Create a new project',
        usage: 'create <name> [description]'
      },
      {
        command: 'list',
        description: 'List all projects',
        usage: 'list [status]'
      },
      {
        command: 'update',
        description: 'Update project details',
        usage: 'update <id> [name|description|status|priority] <value>'
      },
      {
        command: 'delete',
        description: 'Delete a project',
        usage: 'delete <id>'
      },
      {
        command: 'assign',
        description: 'Assign tasks to projects',
        usage: 'assign <task-id> to <project-id>'
      },
      {
        command: 'unassign',
        description: 'Remove tasks from projects',
        usage: 'unassign <task-id> from <project-id>'
      },
      {
        command: 'tasks',
        description: 'List tasks in a project',
        usage: 'tasks <project-id>'
      },
      {
        command: 'tag',
        description: 'Add tags to a project',
        usage: 'tag <project-id> <tags...>'
      },
      {
        command: 'untag',
        description: 'Remove tags from a project',
        usage: 'untag <project-id> <tags...>'
      }
    ];
    
    // Ensure projects directory exists for project files
    this.projectsDir = path.join(process.cwd(), 'data', 'projects');
    this.ensureProjectsDirectory();
    
    // Migrate old data if it exists
    this.migrateOldData();
  }

  async ensureProjectsDirectory() {
    try {
      await fs.mkdir(this.projectsDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create projects directory:', error);
    }
  }

  async execute(params) {
    const { action, ...data } = params;
    
    try {
      switch(action) {
        case 'create':
          return await this.createProject(data);
          
        case 'list':
          return await this.listProjects(data);
          
        case 'update':
          return await this.updateProject(data);
          
        case 'delete':
          return await this.deleteProject(data);
          
        case 'assign':
          return await this.assignTask(data);
          
        case 'unassign':
          return await this.unassignTask(data);
          
        case 'tasks':
          return await this.listProjectTasks(data);
          
        case 'tag':
          return await this.tagProject(data);
          
        case 'untag':
          return await this.untagProject(data);
          
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: create, list, update, delete, assign, unassign, tasks, tag, untag' 
          };
      }
    } catch (error) {
      logger.error('Projects plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async createProject(data) {
    const { name, description, priority = 'medium', tags } = data;
    
    if (!name) {
      return { success: false, error: 'Project name is required' };
    }
    
    try {
      // Create project in database
      const project = await Project.create({
        name,
        description,
        priority,
        tags: tags ? (Array.isArray(tags) ? tags : [tags]) : [],
        status: 'planning',
        path: path.join(this.projectsDir, name.toLowerCase().replace(/\s+/g, '-')),
        createdBy: 'agent'
      });
      
      // Create project directory
      try {
        await fs.mkdir(project.path, { recursive: true });
        await fs.writeFile(
          path.join(project.path, 'README.md'),
          `# ${name}\n\n${description || 'Project description'}\n\nCreated: ${new Date().toISOString()}\n`
        );
      } catch (error) {
        logger.warn(`Failed to create project directory: ${error.message}`);
      }
      
      return {
        success: true,
        result: `Created project: ${name}`,
        project: {
          id: project._id,
          name: project.name,
          description: project.description,
          status: project.status,
          priority: project.priority,
          path: project.path
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create project: ${error.message}`
      };
    }
  }

  async listProjects(data) {
    const { status = 'all', limit = 50 } = data;
    
    try {
      const query = {};
      if (status !== 'all') {
        query.status = status;
      }
      
      const projects = await Project.find(query)
        .populate('tasks', 'description status priority')
        .sort({ priority: -1, updatedAt: -1 })
        .limit(limit);
      
      if (projects.length === 0) {
        return {
          success: true,
          result: 'No projects found',
          projects: []
        };
      }
      
      const formatted = projects.map(project => {
        const taskCount = project.tasks.length;
        const completedTasks = project.tasks.filter(t => t.status === 'completed').length;
        return `• [${project.status.toUpperCase()}] ${project.name} - ${taskCount} tasks (${completedTasks} completed) - ${project._id}`;
      }).join('\n');
      
      return {
        success: true,
        result: `Projects:\n${formatted}`,
        projects: projects.map(p => ({
          id: p._id,
          name: p.name,
          description: p.description,
          status: p.status,
          priority: p.priority,
          taskCount: p.tasks.length,
          completedTasks: p.tasks.filter(t => t.status === 'completed').length,
          tags: p.tags
        }))
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list projects: ${error.message}`
      };
    }
  }

  async updateProject(data) {
    const { id, field, value } = data;
    
    if (!id || !field || !value) {
      return { 
        success: false, 
        error: 'Project ID, field name, and value are required' 
      };
    }
    
    try {
      const project = await Project.findById(id);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      
      // Update allowed fields
      const allowedFields = ['name', 'description', 'status', 'priority', 'gitRepo'];
      if (!allowedFields.includes(field)) {
        return { 
          success: false, 
          error: `Invalid field. Allowed fields: ${allowedFields.join(', ')}` 
        };
      }
      
      // Validate status values
      if (field === 'status') {
        const validStatuses = ['planning', 'active', 'paused', 'completed', 'archived'];
        if (!validStatuses.includes(value)) {
          return {
            success: false,
            error: `Invalid status. Valid values: ${validStatuses.join(', ')}`
          };
        }
      }
      
      // Validate priority values
      if (field === 'priority') {
        const validPriorities = ['low', 'medium', 'high', 'critical'];
        if (!validPriorities.includes(value)) {
          return {
            success: false,
            error: `Invalid priority. Valid values: ${validPriorities.join(', ')}`
          };
        }
      }
      
      project[field] = value;
      project.updatedBy = 'agent';
      await project.save();
      
      return {
        success: true,
        result: `Updated project ${field}: ${value}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to update project: ${error.message}`
      };
    }
  }

  async deleteProject(data) {
    const { id } = data;
    
    if (!id) {
      return { success: false, error: 'Project ID is required' };
    }
    
    try {
      const project = await Project.findById(id);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      
      // Remove project directory if it exists
      try {
        await fs.rm(project.path, { recursive: true, force: true });
      } catch (error) {
        logger.warn(`Failed to remove project directory: ${error.message}`);
      }
      
      await project.deleteOne();
      
      return {
        success: true,
        result: `Deleted project: ${project.name}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to delete project: ${error.message}`
      };
    }
  }

  async assignTask(data) {
    const { taskId, projectId } = data;
    
    if (!taskId || !projectId) {
      return { 
        success: false, 
        error: 'Both task ID and project ID are required' 
      };
    }
    
    try {
      const project = await Project.findById(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      
      const task = await Task.findById(taskId);
      if (!task) {
        return { success: false, error: 'Task not found' };
      }
      
      await project.addTask(taskId);
      
      // Also update task with project reference
      task.metadata = task.metadata || new Map();
      task.metadata.set('projectId', projectId.toString());
      task.metadata.set('projectName', project.name);
      await task.save();
      
      return {
        success: true,
        result: `Assigned task "${task.description}" to project "${project.name}"`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to assign task: ${error.message}`
      };
    }
  }

  async unassignTask(data) {
    const { taskId, projectId } = data;
    
    if (!taskId || !projectId) {
      return { 
        success: false, 
        error: 'Both task ID and project ID are required' 
      };
    }
    
    try {
      const project = await Project.findById(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      
      const task = await Task.findById(taskId);
      if (!task) {
        return { success: false, error: 'Task not found' };
      }
      
      await project.removeTask(taskId);
      
      // Remove project reference from task
      if (task.metadata) {
        task.metadata.delete('projectId');
        task.metadata.delete('projectName');
        await task.save();
      }
      
      return {
        success: true,
        result: `Removed task "${task.description}" from project "${project.name}"`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to unassign task: ${error.message}`
      };
    }
  }

  async listProjectTasks(data) {
    const { projectId } = data;
    
    if (!projectId) {
      return { success: false, error: 'Project ID is required' };
    }
    
    try {
      const project = await Project.findById(projectId).populate('tasks');
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      
      if (project.tasks.length === 0) {
        return {
          success: true,
          result: `No tasks assigned to project "${project.name}"`,
          tasks: []
        };
      }
      
      const formatted = project.tasks.map(task => 
        `• [${task.status.toUpperCase()}] ${task.description} (${task.priority}) - ${task._id}`
      ).join('\n');
      
      return {
        success: true,
        result: `Tasks in project "${project.name}":\n${formatted}`,
        tasks: project.tasks.map(t => ({
          id: t._id,
          description: t.description,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate
        }))
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list project tasks: ${error.message}`
      };
    }
  }

  async tagProject(data) {
    const { id, tags } = data;
    
    if (!id || !tags) {
      return { 
        success: false, 
        error: 'Project ID and tags are required' 
      };
    }
    
    try {
      const project = await Project.findById(id);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      
      const tagsArray = Array.isArray(tags) ? tags : [tags];
      project.tags = [...new Set([...project.tags, ...tagsArray])];
      project.updatedBy = 'agent';
      await project.save();
      
      return {
        success: true,
        result: `Added tags to project "${project.name}": ${tagsArray.join(', ')}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to tag project: ${error.message}`
      };
    }
  }

  async untagProject(data) {
    const { id, tags } = data;
    
    if (!id || !tags) {
      return { 
        success: false, 
        error: 'Project ID and tags are required' 
      };
    }
    
    try {
      const project = await Project.findById(id);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      
      const tagsArray = Array.isArray(tags) ? tags : [tags];
      project.tags = project.tags.filter(tag => !tagsArray.includes(tag));
      project.updatedBy = 'agent';
      await project.save();
      
      return {
        success: true,
        result: `Removed tags from project "${project.name}"`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to untag project: ${error.message}`
      };
    }
  }

  /**
   * Migrate old file-based data to MongoDB if it exists
   */
  async migrateOldData() {
    try {
      const oldDataFile = path.join(process.cwd(), 'projects-data.json');
      
      // Check if old file exists
      try {
        await fs.access(oldDataFile);
      } catch {
        return; // No old file to migrate
      }
      
      const data = await fs.readFile(oldDataFile, 'utf8');
      const oldProjects = JSON.parse(data);
      
      logger.info('Migrating old projects data to MongoDB...');
      
      let migratedCount = 0;
      
      // Migrate projects
      for (const oldProject of oldProjects.list || []) {
        try {
          const project = await Project.create({
            name: oldProject.name,
            description: oldProject.description || '',
            status: oldProject.status || 'planning',
            priority: oldProject.priority || 'medium',
            path: oldProject.path || path.join(this.projectsDir, oldProject.name.toLowerCase().replace(/\s+/g, '-')),
            gitRepo: oldProject.gitRepo,
            tags: oldProject.tags || [],
            createdBy: 'migration'
          });
          
          // If old project had task IDs, we'll need to handle those separately
          if (oldProject.tasks && oldProject.tasks.length > 0) {
            logger.warn(`Project "${oldProject.name}" has ${oldProject.tasks.length} tasks that need manual migration`);
          }
          
          migratedCount++;
        } catch (error) {
          logger.error(`Failed to migrate project ${oldProject.name}:`, error);
        }
      }
      
      // Rename old file to backup
      await fs.rename(oldDataFile, oldDataFile + '.migrated');
      logger.info(`Migration completed successfully. Migrated ${migratedCount} projects.`);
    } catch (error) {
      logger.error('Failed to migrate old projects data:', error);
    }
  }

  // Handle API requests from the web interface
  async handleAPIRequest(method, resourceId, data = {}) {
    try {
      switch (method) {
        case 'GET':
          if (resourceId) {
            // Get specific project
            const project = await Project.findById(resourceId).populate('tasks');
            if (!project) {
              return { success: false, error: 'Project not found' };
            }
            return { success: true, project };
          } else {
            // List projects
            const result = await this.listProjects(data);
            return result;
          }
          
        case 'POST':
          // Create project
          return await this.createProject(data);
          
        case 'PUT':
          // Update project
          return await this.updateProject({ id: resourceId, ...data });
          
        case 'DELETE':
          // Delete project
          return await this.deleteProject({ id: resourceId });
          
        default:
          return { success: false, error: `Unsupported method: ${method}` };
      }
    } catch (error) {
      logger.error(`Projects API error for ${method} ${resourceId}:`, error);
      return { success: false, error: error.message };
    }
  }
}