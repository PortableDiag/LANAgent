import { EventEmitter } from 'events';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';
import EventRule from '../../models/EventRule.js';
import MqttState from '../../models/MqttState.js';
import MqttDevice from '../../models/MqttDevice.js';
import mqttService from './mqttService.js';

/**
 * Event Engine
 * Rule-based automation processor
 * NO AI in the hot path - pure pattern matching and rule evaluation
 */
class EventEngine extends EventEmitter {
  constructor() {
    super();
    this.enabled = false;
    this.rules = new Map();              // ruleId -> rule document
    this.topicRuleIndex = new Map();     // topic pattern -> Set of ruleIds
    this.debounceTimers = new Map();     // ruleId -> timer
    this.throttleState = new Map();      // ruleId -> { lastFired, count }
    this.variables = new Map();          // Runtime variables set by rules
    this.pendingActions = new Map();     // ruleId -> pending delayed actions

    // Cache for condition evaluations
    this.conditionCache = new NodeCache({ stdTTL: 5, checkperiod: 10 });

    // Agenda reference (set during integration)
    this.agenda = null;
  }

  /**
   * Initialize the Event Engine
   */
  async initialize(agenda = null) {
    try {
      logger.info('Initializing Event Engine...');

      this.agenda = agenda;

      // Load all enabled rules
      await this.loadRules();

      // Subscribe to MQTT messages
      mqttService.on('message', (msg) => this.handleMessage(msg));

      // Subscribe to device discoveries
      mqttService.on('device:discovered', (data) => this.handleDeviceDiscovery(data));

      this.enabled = true;
      logger.info(`Event Engine initialized with ${this.rules.size} rules`);

      return { success: true, ruleCount: this.rules.size };
    } catch (error) {
      logger.error('Failed to initialize Event Engine:', error);
      throw error;
    }
  }

  /**
   * Load rules from database
   */
  async loadRules() {
    const rules = await EventRule.find({ enabled: true });

    this.rules.clear();
    this.topicRuleIndex.clear();

    for (const rule of rules) {
      this.rules.set(rule.ruleId, rule);
      this.indexRule(rule);
    }

    // Set up scheduled rules with Agenda
    if (this.agenda) {
      await this.setupScheduledRules(rules.filter(r => r.triggerType === 'schedule'));
    }

    return rules.length;
  }

  /**
   * Index a rule for fast topic matching
   */
  indexRule(rule) {
    if (rule.triggerType === 'mqtt' && rule.mqttTrigger?.topic) {
      const topic = rule.mqttTrigger.topic;
      if (!this.topicRuleIndex.has(topic)) {
        this.topicRuleIndex.set(topic, new Set());
      }
      this.topicRuleIndex.get(topic).add(rule.ruleId);
    }
  }

  /**
   * Set up scheduled rules with Agenda
   */
  async setupScheduledRules(scheduledRules) {
    for (const rule of scheduledRules) {
      if (!rule.scheduleTrigger?.cron) continue;

      const jobName = `eventRule:${rule.ruleId}`;

      // Define the job
      this.agenda.define(jobName, async () => {
        await this.executeRule(rule, { triggerType: 'schedule', timestamp: new Date() });
      });

      // Schedule the job
      await this.agenda.every(rule.scheduleTrigger.cron, jobName, {}, {
        timezone: rule.scheduleTrigger.timezone || 'UTC'
      });

      // Store job reference
      rule.scheduleTrigger.agendaJobId = jobName;
      await rule.save();

      logger.debug(`Scheduled rule ${rule.name} with cron: ${rule.scheduleTrigger.cron}`);
    }
  }

  /**
   * Handle incoming MQTT message
   */
  async handleMessage(msg) {
    if (!this.enabled) return;

    const { topic, payload, brokerId, qos, retain } = msg;
    const startTime = Date.now();

    try {
      // Find matching rules using index
      const matchingRuleIds = new Set();

      for (const [pattern, ruleIds] of this.topicRuleIndex) {
        if (this.topicMatches(pattern, topic)) {
          for (const ruleId of ruleIds) {
            matchingRuleIds.add(ruleId);
          }
        }
      }

      // Also check for catch-all patterns like #
      if (this.topicRuleIndex.has('#')) {
        for (const ruleId of this.topicRuleIndex.get('#')) {
          matchingRuleIds.add(ruleId);
        }
      }

      // Process matching rules
      for (const ruleId of matchingRuleIds) {
        const rule = this.rules.get(ruleId);
        if (!rule || !rule.enabled) continue;

        // Check payload filter
        if (!this.checkPayloadFilter(rule.mqttTrigger.payloadFilter, payload)) {
          continue;
        }

        // Check broker filter
        if (rule.mqttTrigger.brokerId && rule.mqttTrigger.brokerId !== 'any') {
          if (rule.mqttTrigger.brokerId !== brokerId) continue;
        }

        // Process rule with throttle/debounce handling
        await this.processRule(rule, {
          triggerType: 'mqtt',
          topic,
          payload,
          brokerId,
          qos,
          retain
        });
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 100) {
        logger.warn(`Event Engine processing took ${elapsed}ms for topic: ${topic}`);
      }

    } catch (error) {
      logger.error('Error processing message in Event Engine:', error);
    }
  }

  /**
   * Check if payload matches filter
   */
  checkPayloadFilter(filter, payload) {
    if (!filter || !filter.type) return true;

    try {
      let value = payload;

      // Parse JSON if needed
      try {
        value = JSON.parse(payload);
      } catch {
        // Not JSON, use raw value
      }

      // Extract value using JSON path if specified
      if (filter.jsonPath && typeof value === 'object') {
        const parts = filter.jsonPath.split('.');
        for (const part of parts) {
          value = value?.[part];
        }
      }

      switch (filter.type) {
        case 'equals':
          return String(value) === String(filter.value);

        case 'contains':
          return String(value).includes(String(filter.value));

        case 'regex':
          return new RegExp(filter.value).test(String(value));

        case 'numeric':
          const numValue = parseFloat(value);
          const filterNum = parseFloat(filter.value);
          if (isNaN(numValue)) return false;

          switch (filter.operator) {
            case 'gt': return numValue > filterNum;
            case 'lt': return numValue < filterNum;
            case 'gte': return numValue >= filterNum;
            case 'lte': return numValue <= filterNum;
            case 'eq': return numValue === filterNum;
            case 'neq': return numValue !== filterNum;
            default: return true;
          }

        default:
          return true;
      }
    } catch (error) {
      logger.error('Error checking payload filter:', error);
      return false;
    }
  }

  /**
   * Process a rule with throttle/debounce handling
   */
  async processRule(rule, context) {
    // Check throttle
    if (rule.throttle?.enabled) {
      const throttleKey = rule.ruleId;
      const throttleState = this.throttleState.get(throttleKey) || { lastFired: 0, count: 0 };
      const now = Date.now();

      if (now - throttleState.lastFired < rule.throttle.interval) {
        if (throttleState.count >= (rule.throttle.maxFirings || 1)) {
          logger.debug(`Rule ${rule.name} throttled`);
          return;
        }
        throttleState.count++;
      } else {
        throttleState.lastFired = now;
        throttleState.count = 1;
      }

      this.throttleState.set(throttleKey, throttleState);
    }

    // Handle debounce
    if (rule.debounce?.enabled) {
      const debounceKey = rule.ruleId;

      // Clear existing timer
      if (this.debounceTimers.has(debounceKey)) {
        clearTimeout(this.debounceTimers.get(debounceKey));
      }

      // Set new timer
      const timer = setTimeout(async () => {
        this.debounceTimers.delete(debounceKey);
        await this.executeRule(rule, context);
      }, rule.debounce.delay || 1000);

      this.debounceTimers.set(debounceKey, timer);
      return;
    }

    // Execute immediately
    await this.executeRule(rule, context);
  }

  /**
   * Execute a rule
   */
  async executeRule(rule, context) {
    const startTime = Date.now();

    try {
      // Evaluate conditions
      if (rule.conditions?.length > 0) {
        const conditionsMet = await this.evaluateConditions(rule.conditions, context);
        if (!conditionsMet) {
          logger.debug(`Rule ${rule.name} conditions not met`);
          return;
        }
      }

      logger.info(`Executing rule: ${rule.name}`);

      // Execute actions
      for (const action of rule.actions) {
        await this.executeAction(action, context, rule);
      }

      // Record successful firing
      const executionTime = Date.now() - startTime;
      await rule.recordFiring(context.topic || context.triggerType, executionTime);

      this.emit('rule:fired', {
        ruleId: rule.ruleId,
        name: rule.name,
        context,
        executionTime
      });

    } catch (error) {
      logger.error(`Error executing rule ${rule.name}:`, error);
      await rule.recordError(error);

      this.emit('rule:error', {
        ruleId: rule.ruleId,
        name: rule.name,
        error
      });
    }
  }

  /**
   * Evaluate conditions
   */
  async evaluateConditions(conditions, context) {
    for (const condition of conditions) {
      const result = await this.evaluateCondition(condition, context);
      if (!result) return false;
    }
    return true;
  }

  /**
   * Evaluate a single condition
   */
  async evaluateCondition(condition, context) {
    try {
      switch (condition.type) {
        case 'state':
          return this.evaluateStateCondition(condition.state, context);

        case 'time':
          return this.evaluateTimeCondition(condition.time);

        case 'day':
          return this.evaluateDayCondition(condition.time);

        case 'and':
          if (condition.conditions) {
            for (const c of condition.conditions) {
              if (!(await this.evaluateCondition(c, context))) return false;
            }
          }
          return true;

        case 'or':
          if (condition.conditions) {
            for (const c of condition.conditions) {
              if (await this.evaluateCondition(c, context)) return true;
            }
          }
          return false;

        default:
          return true;
      }
    } catch (error) {
      logger.error('Error evaluating condition:', error);
      return false;
    }
  }

  /**
   * Evaluate state condition
   */
  async evaluateStateCondition(state, context) {
    let value;

    // Get value from topic or device
    if (state.topic) {
      const stateDoc = await MqttState.findOne({ topic: state.topic });
      value = stateDoc?.payload?.parsed ?? stateDoc?.payload?.raw;
    } else if (state.deviceId) {
      const device = await MqttDevice.findOne({ deviceId: state.deviceId });
      value = device?.state?.value;
    }

    // Extract attribute if specified
    if (state.attribute && typeof value === 'object') {
      value = value[state.attribute];
    }

    // Compare
    const compareValue = state.value;

    switch (state.operator) {
      case 'eq':
        return String(value) === String(compareValue);
      case 'neq':
        return String(value) !== String(compareValue);
      case 'gt':
        return parseFloat(value) > parseFloat(compareValue);
      case 'lt':
        return parseFloat(value) < parseFloat(compareValue);
      case 'gte':
        return parseFloat(value) >= parseFloat(compareValue);
      case 'lte':
        return parseFloat(value) <= parseFloat(compareValue);
      case 'contains':
        return String(value).includes(String(compareValue));
      case 'not_contains':
        return !String(value).includes(String(compareValue));
      case 'regex':
        return new RegExp(compareValue).test(String(value));
      default:
        return true;
    }
  }

  /**
   * Evaluate time condition
   */
  evaluateTimeCondition(time) {
    const now = new Date();
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentTime = currentHours * 60 + currentMinutes;

    if (time.after) {
      const [afterH, afterM] = time.after.split(':').map(Number);
      const afterTime = afterH * 60 + afterM;
      if (currentTime < afterTime) return false;
    }

    if (time.before) {
      const [beforeH, beforeM] = time.before.split(':').map(Number);
      const beforeTime = beforeH * 60 + beforeM;
      if (currentTime >= beforeTime) return false;
    }

    if (time.weekdays?.length > 0) {
      const currentDay = now.getDay();
      if (!time.weekdays.includes(currentDay)) return false;
    }

    return true;
  }

  /**
   * Evaluate day condition
   */
  evaluateDayCondition(time) {
    if (!time?.weekdays?.length) return true;
    const currentDay = new Date().getDay();
    return time.weekdays.includes(currentDay);
  }

  /**
   * Execute a single action
   */
  async executeAction(action, context, rule) {
    try {
      switch (action.type) {
        case 'mqtt_publish':
          await this.executePublishAction(action.mqttPublish, context);
          break;

        case 'device_command':
          await this.executeDeviceCommand(action.deviceCommand, context);
          break;

        case 'delay':
          await this.executeDelayAction(action.delay, rule, context);
          break;

        case 'notify':
          await this.executeNotifyAction(action.notify, context);
          break;

        case 'webhook':
          await this.executeWebhookAction(action.webhook, context);
          break;

        case 'set_variable':
          this.executeSetVariable(action.setVariable, context);
          break;

        case 'run_rule':
          await this.executeRunRule(action.runRule, context);
          break;

        default:
          logger.warn(`Unknown action type: ${action.type}`);
      }
    } catch (error) {
      logger.error(`Error executing action ${action.type}:`, error);
      throw error;
    }
  }

  /**
   * Execute MQTT publish action
   */
  async executePublishAction(config, context) {
    let payload = config.payload;

    // Template replacement
    if (typeof payload === 'string') {
      payload = this.replaceTemplates(payload, context);
    } else if (typeof payload === 'object') {
      payload = JSON.parse(this.replaceTemplates(JSON.stringify(payload), context));
    }

    await mqttService.publish(config.topic, payload, {
      brokerId: config.brokerId,
      qos: config.qos || 0,
      retain: config.retain || false
    });

    logger.debug(`Published to ${config.topic}:`, payload);
  }

  /**
   * Execute device command action
   */
  async executeDeviceCommand(config, context) {
    let command = config.command;

    // Template replacement
    if (typeof command === 'string') {
      command = this.replaceTemplates(command, context);
    }

    await mqttService.sendDeviceCommand(config.deviceId, command, config.parameters);
    logger.debug(`Sent command to device ${config.deviceId}:`, command);
  }

  /**
   * Execute delay action
   */
  async executeDelayAction(config, rule, context) {
    return new Promise((resolve) => {
      const timerId = setTimeout(() => {
        this.pendingActions.delete(rule.ruleId);
        resolve();
      }, config.duration);

      if (config.cancelOnRetrigger) {
        // Cancel previous if exists
        if (this.pendingActions.has(rule.ruleId)) {
          clearTimeout(this.pendingActions.get(rule.ruleId));
        }
        this.pendingActions.set(rule.ruleId, timerId);
      }
    });
  }

  /**
   * Execute notification action
   */
  async executeNotifyAction(config, context) {
    const message = this.replaceTemplates(config.message, context);
    const title = config.title ? this.replaceTemplates(config.title, context) : undefined;

    // Emit event for notification system to handle
    this.emit('notify', {
      channel: config.channel,
      message,
      title,
      data: config.data
    });

    logger.info(`Notification (${config.channel}): ${message}`);
  }

  /**
   * Execute webhook action
   */
  async executeWebhookAction(config, context) {
    const url = this.replaceTemplates(config.url, context);
    let body = config.body;

    if (body && typeof body === 'string') {
      body = this.replaceTemplates(body, context);
    } else if (body && typeof body === 'object') {
      body = JSON.parse(this.replaceTemplates(JSON.stringify(body), context));
    }

    const response = await fetch(url, {
      method: config.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }

    logger.debug(`Webhook executed: ${config.method || 'POST'} ${url}`);
  }

  /**
   * Execute set variable action
   */
  executeSetVariable(config, context) {
    let value = config.value;

    if (typeof value === 'string') {
      value = this.replaceTemplates(value, context);
    }

    this.variables.set(config.name, value);
    logger.debug(`Set variable ${config.name} = ${value}`);
  }

  /**
   * Execute run rule action
   */
  async executeRunRule(config, context) {
    const rule = this.rules.get(config.ruleId);
    if (!rule) {
      throw new Error(`Rule ${config.ruleId} not found`);
    }

    await this.executeRule(rule, { ...context, triggeredBy: 'rule' });
  }

  /**
   * Replace template variables in string
   */
  replaceTemplates(str, context) {
    if (typeof str !== 'string') return str;

    return str
      // Context variables
      .replace(/\{\{topic\}\}/g, context.topic || '')
      .replace(/\{\{payload\}\}/g, context.payload || '')
      .replace(/\{\{brokerId\}\}/g, context.brokerId || '')
      .replace(/\{\{timestamp\}\}/g, new Date().toISOString())
      // User variables
      .replace(/\{\{var\.(\w+)\}\}/g, (_, name) => this.variables.get(name) || '')
      // JSON path from payload
      .replace(/\{\{payload\.(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
        try {
          let value = JSON.parse(context.payload);
          for (const part of path.split('.')) {
            value = value?.[part];
          }
          return String(value ?? '');
        } catch {
          return '';
        }
      });
  }

  /**
   * Handle device discovery
   */
  async handleDeviceDiscovery(data) {
    logger.info(`Device discovered by Event Engine: ${data.deviceId}`);
    this.emit('device:discovered', data);
  }

  /**
   * Check if topic matches pattern
   */
  topicMatches(pattern, topic) {
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    for (let i = 0; i < patternParts.length; i++) {
      const patternPart = patternParts[i];

      if (patternPart === '#') {
        return true;
      }

      if (patternPart === '+') {
        if (i >= topicParts.length) return false;
        continue;
      }

      if (i >= topicParts.length || patternPart !== topicParts[i]) {
        return false;
      }
    }

    return patternParts.length === topicParts.length;
  }

  /**
   * Add a new rule
   */
  async addRule(ruleData) {
    const rule = await EventRule.create({
      ruleId: ruleData.ruleId || `rule_${Date.now()}`,
      ...ruleData
    });

    this.rules.set(rule.ruleId, rule);
    this.indexRule(rule);

    // Set up schedule if needed
    if (rule.triggerType === 'schedule' && this.agenda) {
      await this.setupScheduledRules([rule]);
    }

    this.emit('rule:added', { ruleId: rule.ruleId, name: rule.name });
    return rule;
  }

  /**
   * Update a rule
   */
  async updateRule(ruleId, updates) {
    const rule = await EventRule.findOneAndUpdate(
      { ruleId },
      { ...updates, updatedAt: new Date() },
      { new: true }
    );

    if (!rule) {
      throw new Error(`Rule ${ruleId} not found`);
    }

    // Re-index
    this.rules.set(rule.ruleId, rule);

    // Rebuild topic index
    await this.loadRules();

    this.emit('rule:updated', { ruleId: rule.ruleId, name: rule.name });
    return rule;
  }

  /**
   * Delete a rule
   */
  async deleteRule(ruleId) {
    await EventRule.deleteOne({ ruleId });
    this.rules.delete(ruleId);

    // Cancel any pending actions
    if (this.debounceTimers.has(ruleId)) {
      clearTimeout(this.debounceTimers.get(ruleId));
      this.debounceTimers.delete(ruleId);
    }

    if (this.pendingActions.has(ruleId)) {
      clearTimeout(this.pendingActions.get(ruleId));
      this.pendingActions.delete(ruleId);
    }

    // Rebuild topic index
    await this.loadRules();

    this.emit('rule:deleted', { ruleId });
    return { success: true };
  }

  /**
   * Get all rules
   */
  async getRules(filter = {}) {
    return EventRule.find(filter).sort({ priority: -1 });
  }

  /**
   * Get a single rule
   */
  async getRule(ruleId) {
    return EventRule.findOne({ ruleId });
  }

  /**
   * Trigger a rule manually
   */
  async triggerRule(ruleId) {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new Error(`Rule ${ruleId} not found`);
    }

    await this.executeRule(rule, { triggerType: 'manual', timestamp: new Date() });
    return { success: true, ruleId };
  }

  /**
   * Get engine statistics
   */
  getStats() {
    return {
      enabled: this.enabled,
      ruleCount: this.rules.size,
      topicPatterns: this.topicRuleIndex.size,
      pendingDebounces: this.debounceTimers.size,
      pendingActions: this.pendingActions.size,
      variableCount: this.variables.size
    };
  }

  /**
   * Shutdown the engine
   */
  async shutdown() {
    this.enabled = false;

    // Clear all timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const timer of this.pendingActions.values()) {
      clearTimeout(timer);
    }
    this.pendingActions.clear();

    logger.info('Event Engine shutdown complete');
  }
}

// Export singleton instance
const eventEngine = new EventEngine();
export default eventEngine;
