import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

export default class AsanaPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'asana';
    this.version = '1.0.0';
    this.description = 'Integrate and automate workflows with Asana\'s project management tools';
    this.commands = [
      {
        command: 'gettasks',
        description: 'Fetch tasks from a specific project',
        usage: 'gettasks({ projectId: "123456" })'
      },
      {
        command: 'createtask',
        description: 'Create a new task in a project',
        usage: 'createtask({ projectId: "123456", name: "New Task" })'
      },
      {
        command: 'updatetask',
        description: 'Update an existing task',
        usage: 'updatetask({ taskId: "789012", name: "Updated Task Name" })'
      },
      {
        command: 'assigntask',
        description: 'Assign a task to a user',
        usage: 'assigntask({ taskId: "789012", assignee: "user@example.com" })'
      },
      {
        command: 'deletetask',
        description: 'Delete a task',
        usage: 'deletetask({ taskId: "789012" })'
      },
      {
        command: 'commenttask',
        description: 'Add a comment to a task',
        usage: 'commenttask({ taskId: "789012", text: "This is a comment" })'
      },
      {
        command: 'getprojectdetails',
        description: 'Fetch details of a specific project',
        usage: 'getprojectdetails({ projectId: "123456" })'
      },
      {
        command: 'updateprojectdetails',
        description: 'Update details of a specific project',
        usage: 'updateprojectdetails({ projectId: "123456", name: "Updated Project Name" })'
      },
      {
        command: 'adddependency',
        description: 'Add a dependency between two tasks',
        usage: 'adddependency({ taskId: "123456", dependsOn: "654321" })'
      },
      {
        command: 'removedependency',
        description: 'Remove a dependency between two tasks',
        usage: 'removedependency({ taskId: "123456", dependsOn: "654321" })'
      },
      {
        command: 'setpriority',
        description: 'Set priority level for a task',
        usage: 'setpriority({ taskId: "789012", priority: "high" })'
      },
      {
        command: 'setduedate',
        description: 'Set due date for a task',
        usage: 'setduedate({ taskId: "789012", dueDate: "2023-12-31" })'
      }
    ];
    
    this.apiKey = process.env.ASANA_API_KEY;
    this.baseUrl = 'https://app.asana.com/api/1.0/';
  }

  async execute(params) {
    const { action } = params;
    
    try {
      switch(action) {
        case 'gettasks':
          return await this.getTasks(params);
          
        case 'createtask':
          return await this.createTask(params);
          
        case 'updatetask':
          return await this.updateTask(params);
          
        case 'assigntask':
          return await this.assignTask(params);
          
        case 'deletetask':
          return await this.deleteTask(params);

        case 'commenttask':
          return await this.commentTask(params);

        case 'getprojectdetails':
          return await this.getProjectDetails(params);

        case 'updateprojectdetails':
          return await this.updateProjectDetails(params);

        case 'adddependency':
          return await this.addDependency(params);

        case 'removedependency':
          return await this.removeDependency(params);

        case 'setpriority':
          return await this.setPriority(params);

        case 'setduedate':
          return await this.setDueDate(params);

        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Asana plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async getTasks(params) {
    this.validateParams(params, { projectId: { required: true, type: 'string' } });
    const { projectId } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Fetching tasks for project ID: ${projectId}`);
      const response = await axios.get(`${this.baseUrl}projects/${projectId}/tasks`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      
      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error fetching tasks:', error.message);
      return { success: false, error: `Failed to fetch tasks: ${error.message}` };
    }
  }

  async createTask(params) {
    this.validateParams(params, {
      projectId: { required: true, type: 'string' },
      name: { required: true, type: 'string' }
    });
    const { projectId, name } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Creating task in project ID: ${projectId}`);
      const response = await axios.post(`${this.baseUrl}tasks`, {
        data: {
          name: name,
          projects: [projectId]
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error creating task:', error.message);
      return { success: false, error: `Failed to create task: ${error.message}` };
    }
  }

  async updateTask(params) {
    this.validateParams(params, {
      taskId: { required: true, type: 'string' },
      name: { required: true, type: 'string' }
    });
    const { taskId, name } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Updating task ID: ${taskId}`);
      const response = await axios.put(`${this.baseUrl}tasks/${taskId}`, {
        data: {
          name: name
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error updating task:', error.message);
      return { success: false, error: `Failed to update task: ${error.message}` };
    }
  }

  async assignTask(params) {
    this.validateParams(params, {
      taskId: { required: true, type: 'string' },
      assignee: { required: true, type: 'string' }
    });
    const { taskId, assignee } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Assigning task ID: ${taskId} to ${assignee}`);
      const response = await axios.put(`${this.baseUrl}tasks/${taskId}`, {
        data: {
          assignee: assignee
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error assigning task:', error.message);
      return { success: false, error: `Failed to assign task: ${error.message}` };
    }
  }

  async deleteTask(params) {
    this.validateParams(params, { taskId: { required: true, type: 'string' } });
    const { taskId } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Deleting task ID: ${taskId}`);
      await axios.delete(`${this.baseUrl}tasks/${taskId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: `Task ${taskId} deleted successfully` };
      
    } catch (error) {
      logger.error('Error deleting task:', error.message);
      return { success: false, error: `Failed to delete task: ${error.message}` };
    }
  }

  async commentTask(params) {
    this.validateParams(params, {
      taskId: { required: true, type: 'string' },
      text: { required: true, type: 'string' }
    });
    const { taskId, text } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Adding comment to task ID: ${taskId}`);
      const response = await axios.post(`${this.baseUrl}tasks/${taskId}/stories`, {
        data: {
          text: text
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error adding comment to task:', error.message);
      return { success: false, error: `Failed to add comment: ${error.message}` };
    }
  }

  /**
   * Fetch details of a specific project
   * @param {Object} params - The parameters for fetching project details
   * @param {string} params.projectId - The ID of the project to fetch
   * @returns {Object} The result of the fetch operation
   */
  async getProjectDetails(params) {
    this.validateParams(params, { projectId: { required: true, type: 'string' } });
    const { projectId } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Fetching details for project ID: ${projectId}`);
      const response = await axios.get(`${this.baseUrl}projects/${projectId}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error fetching project details:', error.message);
      return { success: false, error: `Failed to fetch project details: ${error.message}` };
    }
  }

  /**
   * Update details of a specific project
   * @param {Object} params - The parameters for updating project details
   * @param {string} params.projectId - The ID of the project to update
   * @param {string} params.name - The new name for the project
   * @returns {Object} The result of the update operation
   */
  async updateProjectDetails(params) {
    this.validateParams(params, {
      projectId: { required: true, type: 'string' },
      name: { required: true, type: 'string' }
    });
    const { projectId, name } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Updating details for project ID: ${projectId}`);
      const response = await axios.put(`${this.baseUrl}projects/${projectId}`, {
        data: {
          name: name
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
      
    } catch (error) {
      logger.error('Error updating project details:', error.message);
      return { success: false, error: `Failed to update project details: ${error.message}` };
    }
  }

  /**
   * Add a dependency between two tasks
   * @param {Object} params
   * @param {string} params.taskId - The task that will depend on another
   * @param {string} params.dependsOn - The task to be depended on
   */
  async addDependency(params) {
    this.validateParams(params, {
      taskId: { required: true, type: 'string' },
      dependsOn: { required: true, type: 'string' }
    });
    const { taskId, dependsOn } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Adding dependency: Task ${taskId} depends on ${dependsOn}`);
      const response = await axios.post(`${this.baseUrl}tasks/${taskId}/addDependencies`, {
        data: {
          dependencies: [dependsOn]
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error adding dependency:', error.message);
      return { success: false, error: `Failed to add dependency: ${error.message}` };
    }
  }

  /**
   * Remove a dependency between two tasks
   * @param {Object} params
   * @param {string} params.taskId - The task that will no longer depend on another
   * @param {string} params.dependsOn - The task to be removed from dependencies
   */
  async removeDependency(params) {
    this.validateParams(params, {
      taskId: { required: true, type: 'string' },
      dependsOn: { required: true, type: 'string' }
    });
    const { taskId, dependsOn } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Removing dependency: Task ${taskId} no longer depends on ${dependsOn}`);
      const response = await axios.post(`${this.baseUrl}tasks/${taskId}/removeDependencies`, {
        data: {
          dependencies: [dependsOn]
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error removing dependency:', error.message);
      return { success: false, error: `Failed to remove dependency: ${error.message}` };
    }
  }

  /**
   * Set priority level for a task
   * @param {Object} params
   * @param {string} params.taskId - The ID of the task to update
   * @param {string} params.priority - The priority level to set (e.g., "high", "medium", "low")
   */
  async setPriority(params) {
    this.validateParams(params, {
      taskId: { required: true, type: 'string' },
      priority: { required: true, type: 'string' }
    });
    const { taskId, priority } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Setting priority for task ID: ${taskId} to ${priority}`);
      const response = await axios.put(`${this.baseUrl}tasks/${taskId}`, {
        data: {
          priority: priority
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error setting priority:', error.message);
      return { success: false, error: `Failed to set priority: ${error.message}` };
    }
  }

  /**
   * Set due date for a task
   * @param {Object} params
   * @param {string} params.taskId - The ID of the task to update
   * @param {string} params.dueDate - The due date to set (e.g., "2023-12-31")
   */
  async setDueDate(params) {
    this.validateParams(params, {
      taskId: { required: true, type: 'string' },
      dueDate: { required: true, type: 'string' }
    });
    const { taskId, dueDate } = params;

    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      logger.info(`Setting due date for task ID: ${taskId} to ${dueDate}`);
      const response = await axios.put(`${this.baseUrl}tasks/${taskId}`, {
        data: {
          due_on: dueDate
        }
      }, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error setting due date:', error.message);
      return { success: false, error: `Failed to set due date: ${error.message}` };
    }
  }
}