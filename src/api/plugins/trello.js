import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

export default class TrelloPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'trello';
    this.version = '1.0.0';
    this.description = 'API to interact with Trello boards, lists, and cards for task management';
    this.commands = [
      {
        command: 'getboards',
        description: 'Retrieve all boards for the authorized user',
        usage: 'getboards()'
      },
      {
        command: 'createboard',
        description: 'Create a new board',
        usage: 'createboard({ name: "Board Name", defaultLists: false })'
      },
      {
        command: 'getlists',
        description: 'Get lists from a specific board',
        usage: 'getlists({ boardId: "BOARD_ID" })'
      },
      {
        command: 'createlist',
        description: 'Create a new list in a board',
        usage: 'createlist({ boardId: "BOARD_ID", name: "List Name" })'
      },
      {
        command: 'createcard',
        description: 'Create a new card in a list',
        usage: 'createcard({ listId: "LIST_ID", name: "Card Name", desc: "Card Description" })'
      },
      {
        command: 'getcards',
        description: 'Get cards from a list',
        usage: 'getcards({ listId: "LIST_ID" })'
      },
      {
        command: 'updatecard',
        description: 'Update a card',
        usage: 'updatecard({ cardId: "CARD_ID", name: "New Name", desc: "New Description" })'
      },
      {
        command: 'archivecard',
        description: 'Archive a card',
        usage: 'archivecard({ cardId: "CARD_ID" })'
      },
      {
        command: 'unarchivecard',
        description: 'Unarchive a card',
        usage: 'unarchivecard({ cardId: "CARD_ID" })'
      },
      {
        command: 'archivelist',
        description: 'Archive a list',
        usage: 'archivelist({ listId: "LIST_ID" })'
      },
      {
        command: 'unarchivelist',
        description: 'Unarchive a list',
        usage: 'unarchivelist({ listId: "LIST_ID" })'
      },
      {
        command: 'movecard',
        description: 'Move a card from one list to another',
        usage: 'movecard({ cardId: "CARD_ID", targetListId: "TARGET_LIST_ID" })'
      },
      {
        command: 'assignmember',
        description: 'Assign a member to a card',
        usage: 'assignmember({ cardId: "CARD_ID", memberId: "MEMBER_ID" })'
      }
    ];
    
    this.apiKey = process.env.TRELLO_API_KEY;
    this.oauthToken = process.env.TRELLO_OAUTH_TOKEN;
    this.baseUrl = 'https://api.trello.com/1';
  }

  async execute(params) {
    const { action } = params;
    
    try {
      switch(action) {
        case 'getboards':
          return await this.getBoards();
          
        case 'createboard':
          return await this.createBoard(params);
          
        case 'getlists':
          return await this.getLists(params);
          
        case 'createlist':
          return await this.createList(params);
          
        case 'createcard':
          return await this.createCard(params);
          
        case 'getcards':
          return await this.getCards(params);
          
        case 'updatecard':
          return await this.updateCard(params);

        case 'archivecard':
          return await this.archiveCard(params);

        case 'unarchivecard':
          return await this.unarchiveCard(params);

        case 'archivelist':
          return await this.archiveList(params);

        case 'unarchivelist':
          return await this.unarchiveList(params);

        case 'movecard':
          return await this.moveCard(params);

        case 'assignmember':
          return await this.assignMember(params);
          
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: ' + this.commands.map(c => c.command).join(', ')
          };
      }
    } catch (error) {
      logger.error('Trello plugin error:', error);
      return { success: false, error: error.message };
    }
  }
  
  async getBoards() {
    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info('Fetching Trello boards');
      const response = await axios.get(`${this.baseUrl}/members/me/boards`, {
        params: {
          key: this.apiKey,
          token: this.oauthToken
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching boards:', error.message);
      return { success: false, error: 'Failed to retrieve boards: ' + error.message };
    }
  }
  
  async createBoard(params) {
    const { name, defaultLists = true } = params;
    
    this.validateParams(params, { name: { required: true, type: 'string' } });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Creating Trello board: ${name}`);
      const response = await axios.post(`${this.baseUrl}/boards`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          name: name,
          defaultLists: defaultLists
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error creating board:', error.message);
      return { success: false, error: 'Failed to create board: ' + error.message };
    }
  }
  
  async getLists(params) {
    const { boardId } = params;
    
    this.validateParams(params, { boardId: { required: true, type: 'string' } });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Fetching lists from board: ${boardId}`);
      const response = await axios.get(`${this.baseUrl}/boards/${boardId}/lists`, {
        params: {
          key: this.apiKey,
          token: this.oauthToken
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching lists:', error.message);
      return { success: false, error: 'Failed to retrieve lists: ' + error.message };
    }
  }
  
  async createList(params) {
    const { boardId, name } = params;
    
    this.validateParams(params, { 
      boardId: { required: true, type: 'string' }, 
      name: { required: true, type: 'string' } 
    });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Creating list "${name}" in board: ${boardId}`);
      const response = await axios.post(`${this.baseUrl}/lists`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          name: name,
          idBoard: boardId
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error creating list:', error.message);
      return { success: false, error: 'Failed to create list: ' + error.message };
    }
  }
  
  async createCard(params) {
    const { listId, name, desc = '' } = params;
    
    this.validateParams(params, { 
      listId: { required: true, type: 'string' }, 
      name: { required: true, type: 'string' }
    });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Creating card "${name}" in list: ${listId}`);
      const response = await axios.post(`${this.baseUrl}/cards`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          name: name,
          desc: desc,
          idList: listId
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error creating card:', error.message);
      return { success: false, error: 'Failed to create card: ' + error.message };
    }
  }
  
  async getCards(params) {
    const { listId } = params;
    
    this.validateParams(params, { listId: { required: true, type: 'string' } });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Fetching cards from list: ${listId}`);
      const response = await axios.get(`${this.baseUrl}/lists/${listId}/cards`, {
        params: {
          key: this.apiKey,
          token: this.oauthToken
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error fetching cards:', error.message);
      return { success: false, error: 'Failed to retrieve cards: ' + error.message };
    }
  }
  
  async updateCard(params) {
    const { cardId, name, desc } = params;
    
    this.validateParams(params, { cardId: { required: true, type: 'string' } });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      const updateParams = {
        key: this.apiKey,
        token: this.oauthToken
      };
      
      if (name) updateParams.name = name;
      if (desc !== undefined) updateParams.desc = desc;
      
      logger.info(`Updating card: ${cardId}`);
      const response = await axios.put(`${this.baseUrl}/cards/${cardId}`, null, {
        params: updateParams
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error updating card:', error.message);
      return { success: false, error: 'Failed to update card: ' + error.message };
    }
  }

  async archiveCard(params) {
    const { cardId } = params;
    
    this.validateParams(params, { cardId: { required: true, type: 'string' } });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Archiving card: ${cardId}`);
      const response = await axios.put(`${this.baseUrl}/cards/${cardId}/closed`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          value: true
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error archiving card:', error.message);
      return { success: false, error: 'Failed to archive card: ' + error.message };
    }
  }

  async unarchiveCard(params) {
    const { cardId } = params;
    
    this.validateParams(params, { cardId: { required: true, type: 'string' } });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Unarchiving card: ${cardId}`);
      const response = await axios.put(`${this.baseUrl}/cards/${cardId}/closed`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          value: false
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error unarchiving card:', error.message);
      return { success: false, error: 'Failed to unarchive card: ' + error.message };
    }
  }

  async archiveList(params) {
    const { listId } = params;
    
    this.validateParams(params, { listId: { required: true, type: 'string' } });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Archiving list: ${listId}`);
      const response = await axios.put(`${this.baseUrl}/lists/${listId}/closed`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          value: true
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error archiving list:', error.message);
      return { success: false, error: 'Failed to archive list: ' + error.message };
    }
  }

  async unarchiveList(params) {
    const { listId } = params;
    
    this.validateParams(params, { listId: { required: true, type: 'string' } });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Unarchiving list: ${listId}`);
      const response = await axios.put(`${this.baseUrl}/lists/${listId}/closed`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          value: false
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error unarchiving list:', error.message);
      return { success: false, error: 'Failed to unarchive list: ' + error.message };
    }
  }

  /**
   * Move a card from one list to another
   * @param {Object} params - Parameters for moving the card
   * @param {string} params.cardId - The ID of the card to move
   * @param {string} params.targetListId - The ID of the target list
   * @returns {Promise<Object>} - Result of the move operation
   */
  async moveCard(params) {
    const { cardId, targetListId } = params;
    
    this.validateParams(params, { 
      cardId: { required: true, type: 'string' },
      targetListId: { required: true, type: 'string' }
    });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Moving card: ${cardId} to list: ${targetListId}`);
      const response = await axios.put(`${this.baseUrl}/cards/${cardId}`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          idList: targetListId
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error moving card:', error.message);
      return { success: false, error: 'Failed to move card: ' + error.message };
    }
  }

  /**
   * Assign a member to a card
   * @param {Object} params - Parameters for assigning the member
   * @param {string} params.cardId - The ID of the card
   * @param {string} params.memberId - The ID of the member to assign
   * @returns {Promise<Object>} - Result of the assign operation
   */
  async assignMember(params) {
    const { cardId, memberId } = params;
    
    this.validateParams(params, { 
      cardId: { required: true, type: 'string' },
      memberId: { required: true, type: 'string' }
    });

    if (!this.apiKey || !this.oauthToken) {
      return { success: false, error: 'API key or OAuth token not configured' };
    }

    try {
      logger.info(`Assigning member: ${memberId} to card: ${cardId}`);
      const response = await axios.post(`${this.baseUrl}/cards/${cardId}/idMembers`, null, {
        params: {
          key: this.apiKey,
          token: this.oauthToken,
          value: memberId
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error('Error assigning member to card:', error.message);
      return { success: false, error: 'Failed to assign member: ' + error.message };
    }
  }
}
