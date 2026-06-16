import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

/**
 * Lightweight accessor for the global agent singleton.
 * Used by services that don't have a direct agent reference
 * (e.g., crypto strategies) to access agent-level services like P2P.
 *
 * Wraps the singleton in an EventEmitter so services can subscribe to
 * lifecycle transitions: 'initialized' (first time set), 'reconfigured'
 * (set to a different instance), 'destroyed' (cleared).
 */
class AgentAccessor extends EventEmitter {
  constructor() {
    super();
    this._agent = null;

    // Initialize state history tracking with in-memory cache.
    // Default retention: 1000 entries (enforced manually, see _storeStateSnapshot),
    // TTL: 24 hours. NOTE: maxKeys is intentionally NOT set — node-cache throws
    // on .set() once maxKeys is exceeded, which would be a footgun on the
    // getAgentState() storage path. Oldest-key eviction is handled by us.
    this.stateHistory = new NodeCache({
      stdTTL: 24 * 60 * 60, // 24 hours in seconds
      checkperiod: 600 // Check for expired keys every 10 minutes
    });
    this.maxStateHistory = 1000; // Cap snapshots; evict oldest beyond this

    // Track state transition events
    this.transitionEvents = [];
    this.maxTransitionEvents = 1000; // Keep last 1000 events

    // Listen to own events to track state changes. The transition type is
    // bound explicitly because the emitted events do not carry a `type` field.
    this.on('initialized', (e) => this._handleStateTransition('initialized', e));
    this.on('reconfigured', (e) => this._handleStateTransition('reconfigured', e));
    this.on('destroyed', (e) => this._handleStateTransition('destroyed', e));
  }

  setGlobalAgent(agent) {
    const previous = this._agent;
    this._agent = agent;
    if (previous && !agent) {
      logger.info('agentAccessor: agent destroyed');
      this.emit('destroyed', { timestamp: Date.now() });
    } else if (!previous && agent) {
      logger.info('agentAccessor: agent initialized');
      this.emit('initialized', { timestamp: Date.now(), agent });
    } else if (previous && agent && previous !== agent) {
      logger.info('agentAccessor: agent reconfigured');
      this.emit('reconfigured', { timestamp: Date.now(), previous, current: agent });
    }
  }

  getGlobalAgent() {
    return this._agent;
  }

  /**
   * Best-effort snapshot of the running agent. Returns what we can observe
   * via well-known fields on the Agent instance — currently the loaded
   * plugin names via apiManager.apis. Fields with no real data source
   * return empty arrays rather than placeholders.
   */
  getAgentState() {
    const agent = this._agent;
    if (!agent) {
      return { status: 'uninitialized', plugins: [], timestamp: Date.now() };
    }
    const plugins = [];
    try {
      const apis = agent.apiManager?.apis;
      if (apis && typeof apis.entries === 'function') {
        for (const [name, entry] of apis.entries()) {
          plugins.push({
            name,
            enabled: entry?.enabled !== false,
            description: entry?.instance?.description || null
          });
        }
      }
    } catch (err) {
      logger.debug(`agentAccessor.getAgentState: plugin enumeration failed: ${err.message}`);
    }
    const state = {
      status: 'active',
      agentId: agent.erc8004AgentId || null,
      name: agent.name || process.env.AGENT_NAME || null,
      plugins,
      timestamp: Date.now()
    };

    // Store state in history
    this._storeStateSnapshot(state);

    return state;
  }

  /**
   * Store a snapshot of the agent state in history.
   * Evicts the oldest snapshot when the cap is reached so node-cache never
   * throws (we deliberately do not set maxKeys on the cache).
   * @private
   */
  _storeStateSnapshot(state) {
    if (this.stateHistory.keys().length >= this.maxStateHistory) {
      // Evict the oldest key (smallest timestamp).
      const keys = this.stateHistory.keys();
      let oldestKey = keys[0];
      let oldestTime = parseInt(oldestKey.split('_')[1], 10);
      for (const key of keys) {
        const t = parseInt(key.split('_')[1], 10);
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = key;
        }
      }
      this.stateHistory.del(oldestKey);
    }
    const key = `state_${state.timestamp}`;
    this.stateHistory.set(key, state);
  }

  /**
   * Handle state transition events.
   * @param {string} type - Transition type ('initialized'|'reconfigured'|'destroyed')
   * @param {Object} event - Emitted event payload
   * @private
   */
  _handleStateTransition(type, event) {
    this.transitionEvents.push({
      type,
      timestamp: event.timestamp,
      data: {
        agentId: event.agent?.erc8004AgentId || event.current?.erc8004AgentId || null,
        previousAgentId: event.previous?.erc8004AgentId || null,
        currentAgentId: event.current?.erc8004AgentId || null
      }
    });

    // Maintain maximum history size
    if (this.transitionEvents.length > this.maxTransitionEvents) {
      this.transitionEvents = this.transitionEvents.slice(-this.maxTransitionEvents);
    }
  }

  /**
   * Get historical snapshots of agent states.
   * @param {number} limit - Maximum number of history entries to return (default: 50)
   * @returns {Array} Array of timestamped state snapshots (newest first)
   */
  getAgentStateHistory(limit = 50) {
    const keys = this.stateHistory.keys();

    // Sort keys by timestamp (newest first)
    keys.sort((a, b) => {
      const timeA = parseInt(a.split('_')[1], 10);
      const timeB = parseInt(b.split('_')[1], 10);
      return timeB - timeA;
    });

    const limitedKeys = keys.slice(0, limit);
    return limitedKeys.map((key) => this.stateHistory.get(key)).filter(Boolean);
  }

  /**
   * Get chronological agent lifecycle events.
   * @returns {Array} Array of state transition events (oldest first)
   */
  getStateTransitionEvents() {
    return [...this.transitionEvents].sort((a, b) => a.timestamp - b.timestamp);
  }
}

const agentAccessor = new AgentAccessor();

export function setGlobalAgent(agent) {
  agentAccessor.setGlobalAgent(agent);
}

export function getGlobalAgent() {
  return agentAccessor.getGlobalAgent();
}

export function getAgentState() {
  return agentAccessor.getAgentState();
}

export function getAgentStateHistory(limit) {
  return agentAccessor.getAgentStateHistory(limit);
}

export function getStateTransitionEvents() {
  return agentAccessor.getStateTransitionEvents();
}

export { agentAccessor };
