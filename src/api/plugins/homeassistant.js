import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

/**
 * Home Assistant REST plugin.
 *
 * Complements the MQTT service, which only *discovers* HA devices from
 * `homeassistant/.../config` topics: this talks to HA's REST API with a
 * long-lived access token, so the agent can read any entity's state and call
 * any service (lights, scenes, scripts, climate, covers, automations).
 *
 * Entities can be named by entity_id ("light.kitchen") or by friendly name
 * ("kitchen light"); names are resolved against the cached state list.
 * Registers disabled until HASS_URL + HASS_TOKEN (or stored credentials) exist.
 */
export default class HomeAssistantPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'homeassistant';
    this.version = '1.0.0';
    this.description = 'Read entity states and call services on a Home Assistant server';

    this.requiredCredentials = [
      { key: 'url', label: 'Home Assistant URL (e.g. http://homeassistant.local:8123)', envVar: 'HASS_URL', required: true },
      { key: 'token', label: 'Long-lived access token', envVar: 'HASS_TOKEN', required: true }
    ];

    this.commands = [
      {
        command: 'list_entities',
        description: 'List Home Assistant entities, optionally filtered by domain (light, switch, sensor, climate...) or a search term',
        usage: 'list_entities({ domain: "light", search: "kitchen" })',
        examples: ['list my home assistant lights', 'what sensors does home assistant have', 'show home assistant entities in the garage']
      },
      {
        command: 'get_state',
        description: 'Get the current state and attributes of one Home Assistant entity',
        usage: 'get_state({ entity: "sensor.living_room_temperature" })',
        examples: ['what is the living room temperature in home assistant', 'is the garage door open according to home assistant', 'home assistant state of the front door lock']
      },
      {
        command: 'call_service',
        description: 'Call any Home Assistant service, e.g. light.turn_on with brightness, scene.turn_on, script.turn_on, climate.set_temperature',
        usage: 'call_service({ domain: "climate", service: "set_temperature", entity: "climate.hallway", data: { temperature: 21 } })',
        examples: ['set the hallway thermostat to 21 in home assistant', 'activate the movie night scene in home assistant', 'run the goodnight script in home assistant']
      },
      {
        command: 'turn_on',
        description: 'Turn on a Home Assistant entity (light, switch, fan, scene, script...)',
        usage: 'turn_on({ entity: "light.kitchen" })',
        examples: ['home assistant turn on the kitchen light', 'switch on the porch light via home assistant']
      },
      {
        command: 'turn_off',
        description: 'Turn off a Home Assistant entity',
        usage: 'turn_off({ entity: "switch.fan" })',
        examples: ['home assistant turn off the bedroom fan', 'switch off the porch light via home assistant']
      },
      {
        command: 'toggle',
        description: 'Toggle a Home Assistant entity',
        usage: 'toggle({ entity: "light.desk" })',
        examples: ['toggle the desk lamp in home assistant']
      }
    ];

    this.config = { url: null, token: null, timeoutMs: 10000 };
    this.cache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
    this.initialized = false;
  }

  async initialize() {
    const credentials = await this.loadCredentials(this.requiredCredentials);
    this.config.url = String(credentials.url).replace(/\/+$/, '');
    this.config.token = credentials.token;

    // Fail fast on a wrong URL or token so the plugin registers disabled with a clear reason
    const res = await this.request('get', '/api/');
    this.logger.info(`Connected to Home Assistant at ${this.config.url}: ${res?.message || 'ok'}`);
    this.initialized = true;
  }

  async request(method, path, data) {
    const response = await retryOperation(() => axios({
      method,
      url: `${this.config.url}${path}`,
      data,
      timeout: this.config.timeoutMs,
      headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' }
    }), { retries: 2 });
    return response.data;
  }

  async getStates(force = false) {
    if (!force) {
      const cached = this.cache.get('states');
      if (cached) return cached;
    }
    const states = await this.request('get', '/api/states');
    this.cache.set('states', states);
    return states;
  }

  /**
   * Resolve an entity_id or a friendly name to an entity_id. Exact id wins, then an
   * exact friendly name, then the single entity whose name contains every word.
   */
  async resolveEntity(entity, domain) {
    if (!entity) throw new Error('No entity given');
    const needle = String(entity).trim().toLowerCase();
    const states = await this.getStates();
    const pool = domain ? states.filter(s => s.entity_id.startsWith(`${domain}.`)) : states;

    const byId = pool.find(s => s.entity_id.toLowerCase() === needle);
    if (byId) return byId.entity_id;

    const name = s => (s.attributes?.friendly_name || '').toLowerCase();
    const byName = pool.filter(s => name(s) === needle);
    if (byName.length === 1) return byName[0].entity_id;

    const words = needle.split(/[\s_.]+/).filter(Boolean);
    const partial = pool.filter(s => words.every(w => name(s).includes(w) || s.entity_id.toLowerCase().includes(w)));
    if (partial.length === 1) return partial[0].entity_id;
    if (partial.length > 1) {
      throw new Error(`"${entity}" matches ${partial.length} entities: ${partial.slice(0, 8).map(s => s.entity_id).join(', ')}. Be more specific.`);
    }
    throw new Error(`No Home Assistant entity matches "${entity}"`);
  }

  summarize(state) {
    const unit = state.attributes?.unit_of_measurement ? ` ${state.attributes.unit_of_measurement}` : '';
    const label = state.attributes?.friendly_name || state.entity_id;
    return `${label} (${state.entity_id}): ${state.state}${unit}`;
  }

  async execute(params) {
    const { action, ...data } = params;
    this.validateParams(params, {
      action: { required: true, type: 'string', enum: this.commands.map(c => c.command) }
    });

    if (params.needsParameterExtraction && this.agent.providerManager) {
      Object.assign(data, await this.extractParameters(params.originalInput || params.input, action));
    }

    try {
      switch (action) {
        case 'list_entities':
          return await this.listEntities(data);
        case 'get_state':
          return await this.getState(data.entity || data.entity_id);
        case 'call_service':
          this.validateParams(data, {
            domain: { required: true, type: 'string' },
            service: { required: true, type: 'string' }
          });
          return await this.callService(data.domain, data.service, data.entity || data.entity_id, data.data);
        case 'turn_on':
        case 'turn_off':
        case 'toggle': {
          const entityId = await this.resolveEntity(data.entity || data.entity_id);
          // homeassistant.* works across domains; scenes and scripts only turn on
          const domain = entityId.split('.')[0];
          const svcDomain = ['scene', 'script'].includes(domain) ? domain : 'homeassistant';
          const service = ['scene', 'script'].includes(domain) ? 'turn_on' : action;
          return await this.callService(svcDomain, service, entityId, data.data);
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      const status = error.response?.status;
      const message = status === 401 ? 'Home Assistant rejected the token (401)' : error.message;
      this.logger.error(`${action} failed: ${message}`);
      return { success: false, error: message };
    }
  }

  async listEntities({ domain, search, limit = 50 } = {}) {
    let states = await this.getStates();
    if (domain) states = states.filter(s => s.entity_id.startsWith(`${domain}.`));
    if (search) {
      const words = String(search).toLowerCase().split(/\s+/).filter(Boolean);
      states = states.filter(s => {
        const hay = `${s.entity_id} ${s.attributes?.friendly_name || ''}`.toLowerCase();
        return words.every(w => hay.includes(w));
      });
    }
    const shown = states.slice(0, limit);
    return {
      success: true,
      count: states.length,
      entities: shown.map(s => ({ entity_id: s.entity_id, name: s.attributes?.friendly_name, state: s.state })),
      result: states.length
        ? `${states.length} entities${states.length > shown.length ? ` (showing ${shown.length})` : ''}:\n` + shown.map(s => `• ${this.summarize(s)}`).join('\n')
        : 'No matching Home Assistant entities.'
    };
  }

  async getState(entity) {
    const entityId = await this.resolveEntity(entity);
    const state = await this.request('get', `/api/states/${encodeURIComponent(entityId)}`);
    return { success: true, entity_id: entityId, state: state.state, attributes: state.attributes, lastChanged: state.last_changed, result: this.summarize(state) };
  }

  async callService(domain, service, entity, extra = {}) {
    const body = { ...(typeof extra === 'object' && extra ? extra : {}) };
    if (entity) body.entity_id = await this.resolveEntity(entity);
    const changed = await this.request('post', `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, body);
    this.cache.del('states');
    const after = Array.isArray(changed) ? changed.filter(s => !body.entity_id || s.entity_id === body.entity_id) : [];
    return {
      success: true,
      result: `Called ${domain}.${service}${body.entity_id ? ` on ${body.entity_id}` : ''}` + (after.length ? `. Now: ${after.map(s => this.summarize(s)).join('; ')}` : ''),
      changed: after.map(s => ({ entity_id: s.entity_id, state: s.state }))
    };
  }

  async extractParameters(input, action) {
    const prompt = `Extract parameters from: "${input}"
For the Home Assistant action "${action}". Return JSON only, using these keys where relevant:
entity (entity_id or the device's name as the user said it), domain, service, search, data (object of service data such as brightness_pct, temperature, color_name).`;
    const response = await this.agent.providerManager.generateResponse(prompt, { temperature: 0.2, maxTokens: 200 });
    return safeJsonParse(response.content, {}) || {};
  }

  async getAICapabilities() {
    return { enabled: true, examples: this.commands.flatMap(cmd => cmd.examples || []) };
  }
}
