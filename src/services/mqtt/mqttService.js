import Aedes from 'aedes';
import { createServer } from 'net';
import { createServer as createHttpServer } from 'http';
import mqtt from 'mqtt';
import { WebSocketServer, createWebSocketStream } from 'ws';
import NodeCache from 'node-cache';
import { EventEmitter } from 'events';
import mongoose from 'mongoose';
import { logger } from '../../utils/logger.js';
import MqttBroker from '../../models/MqttBroker.js';
import MqttDevice from '../../models/MqttDevice.js';
import MqttState from '../../models/MqttState.js';
import MqttHistory from '../../models/MqttHistory.js';

/**
 * MQTT Service
 * Manages built-in Aedes broker and connections to external brokers
 * Provides unified publish/subscribe interface
 */
class MqttService extends EventEmitter {
  constructor() {
    super();
    this.aedes = null;
    this.tcpServer = null;
    this.wsServer = null;
    this.httpServer = null;
    this.externalClients = new Map();  // brokerId -> mqtt.Client
    this.subscriptions = new Map();    // topic pattern -> Set of callbacks
    this.enabled = false;
    this.brokerEnabled = false;

    // Cache for state lookups (5 minute TTL)
    this.stateCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

    // Statistics
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      clientsConnected: 0,
      externalConnections: 0
    };
  }

  /**
   * Initialize the MQTT service
   */
  async initialize() {
    try {
      logger.info('Initializing MQTT service...');

      // Wait for database connection if not ready
      if (mongoose.connection.readyState !== 1) {
        logger.info('Waiting for database connection...');
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Database connection timeout'));
          }, 30000);

          if (mongoose.connection.readyState === 1) {
            clearTimeout(timeout);
            resolve();
          } else {
            mongoose.connection.once('connected', () => {
              clearTimeout(timeout);
              resolve();
            });
            mongoose.connection.once('error', (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          }
        });
        logger.info('Database connection ready');
      }

      // Load broker configurations from database
      let brokers = await MqttBroker.find({ enabled: true });

      // Check if internal broker exists (enabled or not)
      const internalBrokerExists = await MqttBroker.findOne({ type: 'internal' });

      // Create default internal broker if none exists
      if (!internalBrokerExists) {
        logger.info('No internal broker configured, creating default...');
        const defaultBroker = await MqttBroker.create({
          brokerId: 'internal_default',
          name: 'LANAgent MQTT Broker',
          type: 'internal',
          enabled: true,
          brokerSettings: {
            port: 1883,
            wsPort: 9883,
            requireAuth: false
          },
          subscriptions: [
            { topic: '#', qos: 0, handler: 'process' }
          ],
          status: {
            connected: false
          }
        });
        brokers.push(defaultBroker);
        logger.info('Default internal broker created');
      }

      for (const broker of brokers) {
        if (broker.type === 'internal') {
          await this.startInternalBroker(broker);
        } else if (broker.type === 'external') {
          await this.connectExternalBroker(broker);
        }
      }

      this.enabled = true;
      logger.info('MQTT service initialized successfully');

      return { success: true, stats: this.getStats() };
    } catch (error) {
      logger.error('Failed to initialize MQTT service:', error);
      throw error;
    }
  }

  /**
   * Start the internal Aedes broker
   */
  async startInternalBroker(config) {
    try {
      if (this.aedes) {
        logger.warn('Internal broker already running');
        return;
      }

      const settings = config.brokerSettings || {};

      // Create Aedes instance
      this.aedes = new Aedes({
        id: config.brokerId,
        heartbeatInterval: 60000,
        connectTimeout: 30000
      });

      // Set up authentication if required
      if (settings.requireAuth) {
        this.aedes.authenticate = (client, username, password, callback) => {
          const user = settings.allowedUsers?.find(u => u.username === username);
          if (user && user.password === password?.toString()) {
            callback(null, true);
          } else {
            logger.warn(`MQTT auth failed for user: ${username}`);
            callback(null, false);
          }
        };

        // Set up authorization
        this.aedes.authorizePublish = (client, packet, callback) => {
          // TODO: Implement ACL checking
          callback(null);
        };

        this.aedes.authorizeSubscribe = (client, sub, callback) => {
          // TODO: Implement ACL checking
          callback(null, sub);
        };
      }

      // Event handlers
      this.aedes.on('client', (client) => {
        this.stats.clientsConnected++;
        logger.debug(`MQTT client connected: ${client.id}`);
        this.emit('client:connect', { clientId: client.id });
        this.updateBrokerStatus(config.brokerId, { clientCount: this.stats.clientsConnected });
      });

      this.aedes.on('clientDisconnect', (client) => {
        this.stats.clientsConnected--;
        logger.debug(`MQTT client disconnected: ${client.id}`);
        this.emit('client:disconnect', { clientId: client.id });
        this.updateBrokerStatus(config.brokerId, { clientCount: this.stats.clientsConnected });
      });

      this.aedes.on('publish', async (packet, client) => {
        if (client) {  // Ignore internal publishes
          this.stats.messagesReceived++;
          await this.handleMessage(config.brokerId, packet.topic, packet.payload, {
            qos: packet.qos,
            retain: packet.retain,
            clientId: client?.id
          });
        }
      });

      this.aedes.on('subscribe', (subscriptions, client) => {
        logger.debug(`Client ${client.id} subscribed to:`, subscriptions.map(s => s.topic));
      });

      // Start TCP server
      const tcpPort = settings.port || 1883;
      this.tcpServer = createServer(this.aedes.handle);
      await new Promise((resolve, reject) => {
        this.tcpServer.listen(tcpPort, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info(`MQTT broker listening on TCP port ${tcpPort}`);

      // Start WebSocket server if configured
      const wsPort = settings.wsPort;
      if (wsPort) {
        this.httpServer = createHttpServer();
        this.wsServer = new WebSocketServer({ server: this.httpServer });
        this.wsServer.on('connection', (ws) => {
          const duplex = createWebSocketStream(ws);
          this.aedes.handle(duplex);
        });
        await new Promise((resolve, reject) => {
          this.httpServer.listen(wsPort, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        logger.info(`MQTT WebSocket server listening on port ${wsPort}`);
      }

      this.brokerEnabled = true;

      // Update broker status
      await this.updateBrokerStatus(config.brokerId, {
        connected: true,
        lastConnected: new Date()
      });

      return { success: true, port: tcpPort, wsPort };
    } catch (error) {
      logger.error('Failed to start internal broker:', error);
      await this.updateBrokerStatus(config.brokerId, {
        connected: false,
        lastError: error.message
      });
      throw error;
    }
  }

  /**
   * Stop the internal broker
   */
  async stopInternalBroker() {
    if (!this.aedes) return;

    try {
      // Close WebSocket server
      if (this.httpServer) {
        this.httpServer.close();
        this.httpServer = null;
        this.wsServer = null;
      }

      // Close TCP server
      if (this.tcpServer) {
        this.tcpServer.close();
        this.tcpServer = null;
      }

      // Close Aedes
      await new Promise((resolve) => {
        this.aedes.close(resolve);
      });
      this.aedes = null;
      this.brokerEnabled = false;

      logger.info('Internal MQTT broker stopped');
    } catch (error) {
      logger.error('Error stopping internal broker:', error);
    }
  }

  /**
   * Connect to an external MQTT broker
   */
  async connectExternalBroker(config) {
    try {
      if (this.externalClients.has(config.brokerId)) {
        logger.warn(`Already connected to broker: ${config.brokerId}`);
        return;
      }

      const conn = config.connection || {};
      const tlsConfig = config.tls || {};

      // Build connection options
      const options = {
        host: conn.host || 'localhost',
        port: conn.port || 1883,
        protocol: conn.protocol || 'mqtt',
        clientId: conn.clientId || `lanagent_${config.brokerId}_${Date.now()}`,
        keepalive: conn.keepalive || 60,
        reconnectPeriod: conn.reconnectPeriod || 5000,
        connectTimeout: conn.connectTimeout || 30000
      };

      if (conn.username) {
        options.username = conn.username;
        options.password = conn.password;
      }

      if (tlsConfig.enabled) {
        options.rejectUnauthorized = tlsConfig.rejectUnauthorized !== false;
        if (tlsConfig.ca) options.ca = tlsConfig.ca;
        if (tlsConfig.cert) options.cert = tlsConfig.cert;
        if (tlsConfig.key) options.key = tlsConfig.key;
      }

      // Connect
      const client = mqtt.connect(options);

      // Event handlers
      client.on('connect', async () => {
        logger.info(`Connected to external broker: ${config.name} (${config.brokerId})`);
        this.stats.externalConnections++;

        await this.updateBrokerStatus(config.brokerId, {
          connected: true,
          lastConnected: new Date()
        });

        // Subscribe to configured topics
        if (config.subscriptions?.length > 0) {
          for (const sub of config.subscriptions) {
            client.subscribe(sub.topic, { qos: sub.qos || 0 }, (err) => {
              if (err) {
                logger.error(`Failed to subscribe to ${sub.topic}:`, err);
              } else {
                logger.debug(`Subscribed to ${sub.topic} on ${config.name}`);
              }
            });
          }
        }

        this.emit('broker:connect', { brokerId: config.brokerId, name: config.name });
      });

      client.on('message', async (topic, payload, packet) => {
        this.stats.messagesReceived++;
        await this.handleMessage(config.brokerId, topic, payload, {
          qos: packet.qos,
          retain: packet.retain
        });
      });

      client.on('error', async (error) => {
        logger.error(`External broker error (${config.name}):`, error);
        await this.updateBrokerStatus(config.brokerId, {
          lastError: error.message
        });
        this.emit('broker:error', { brokerId: config.brokerId, error });
      });

      client.on('close', async () => {
        logger.warn(`Disconnected from external broker: ${config.name}`);
        this.stats.externalConnections--;

        await this.updateBrokerStatus(config.brokerId, {
          connected: false,
          lastDisconnected: new Date()
        });

        this.emit('broker:disconnect', { brokerId: config.brokerId });
      });

      client.on('reconnect', () => {
        logger.debug(`Reconnecting to external broker: ${config.name}`);
      });

      // Store client
      this.externalClients.set(config.brokerId, {
        client,
        config
      });

      return { success: true, brokerId: config.brokerId };
    } catch (error) {
      logger.error(`Failed to connect to external broker ${config.name}:`, error);
      await this.updateBrokerStatus(config.brokerId, {
        connected: false,
        lastError: error.message
      });
      throw error;
    }
  }

  /**
   * Disconnect from an external broker
   */
  async disconnectExternalBroker(brokerId) {
    const entry = this.externalClients.get(brokerId);
    if (!entry) return;

    try {
      await new Promise((resolve) => {
        entry.client.end(false, {}, resolve);
      });
      this.externalClients.delete(brokerId);
      logger.info(`Disconnected from external broker: ${brokerId}`);
    } catch (error) {
      logger.error(`Error disconnecting from broker ${brokerId}:`, error);
    }
  }

  /**
   * Handle incoming message from any broker
   */
  async handleMessage(brokerId, topic, payload, options = {}) {
    try {
      const payloadStr = payload.toString();

      // Emit raw message event (for Event Engine)
      this.emit('message', {
        brokerId,
        topic,
        payload: payloadStr,
        qos: options.qos,
        retain: options.retain
      });

      // Update state store
      const state = await MqttState.updateState(topic, brokerId, payloadStr, options);

      // Update cache
      this.stateCache.set(`state:${topic}`, state);

      // Check if we should store history
      const brokerConfig = await MqttBroker.findOne({ brokerId });
      const subscription = brokerConfig?.subscriptions?.find(s => this.topicMatches(s.topic, topic));

      if (subscription?.handler === 'store' || subscription?.handler === 'process') {
        await MqttHistory.recordMessage(topic, brokerId, payloadStr, {
          qos: options.qos,
          retain: options.retain,
          clientId: options.clientId
        });
      }

      // Check for Home Assistant discovery
      if (topic.startsWith('homeassistant/') && topic.endsWith('/config')) {
        await this.handleHADiscovery(brokerId, topic, payloadStr);
      }

      // Update broker stats
      await MqttBroker.updateOne(
        { brokerId },
        { $inc: { 'status.messagesReceived': 1 } }
      );

      // Call registered subscription callbacks
      for (const [pattern, callbacks] of this.subscriptions) {
        if (this.topicMatches(pattern, topic)) {
          for (const callback of callbacks) {
            try {
              await callback(topic, payloadStr, { brokerId, ...options });
            } catch (err) {
              logger.error(`Error in subscription callback for ${pattern}:`, err);
            }
          }
        }
      }

    } catch (error) {
      logger.error('Error handling MQTT message:', error);
    }
  }

  /**
   * Handle Home Assistant MQTT Discovery
   */
  async handleHADiscovery(brokerId, topic, payload) {
    try {
      const config = JSON.parse(payload);
      const parts = topic.split('/');
      // homeassistant/<component>/<node_id>/<object_id>/config
      const component = parts[1];
      const objectId = parts.length >= 4 ? parts[parts.length - 2] : parts[2];

      const deviceId = config.unique_id || `${component}_${objectId}`;

      // Create or update device
      await MqttDevice.findOneAndUpdate(
        { deviceId },
        {
          deviceId,
          brokerId,
          name: config.name || deviceId,
          type: this.mapHAComponentToType(component),
          discoveryMethod: 'homeassistant',
          haDiscovery: {
            component,
            objectId,
            discoveryTopic: topic,
            config
          },
          topics: {
            state: config.state_topic,
            command: config.command_topic,
            availability: config.availability_topic || config.availability?.[0]?.topic,
            attributes: config.json_attributes_topic
          },
          attributes: {
            manufacturer: config.device?.manufacturer,
            model: config.device?.model,
            swVersion: config.device?.sw_version,
            identifiers: config.device?.identifiers
          },
          unit: config.unit_of_measurement,
          deviceClass: config.device_class,
          icon: config.icon
        },
        { upsert: true, new: true }
      );

      logger.info(`Discovered HA device: ${deviceId} (${component})`);
      this.emit('device:discovered', { deviceId, component, config });

    } catch (error) {
      logger.error('Error handling HA discovery:', error);
    }
  }

  /**
   * Map Home Assistant component to device type
   */
  mapHAComponentToType(component) {
    const mapping = {
      sensor: 'sensor',
      binary_sensor: 'binary_sensor',
      switch: 'switch',
      light: 'light',
      climate: 'climate',
      cover: 'cover',
      fan: 'fan',
      lock: 'lock',
      vacuum: 'vacuum',
      camera: 'camera',
      media_player: 'media_player'
    };
    return mapping[component] || 'other';
  }

  /**
   * Publish a message
   */
  async publish(topic, payload, options = {}) {
    const {
      brokerId = null,  // null = internal broker
      qos = 0,
      retain = false
    } = options;

    try {
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

      if (brokerId && this.externalClients.has(brokerId)) {
        // Publish to external broker
        const { client } = this.externalClients.get(brokerId);
        await new Promise((resolve, reject) => {
          client.publish(topic, payloadStr, { qos, retain }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } else if (this.aedes) {
        // Publish to internal broker
        this.aedes.publish({
          topic,
          payload: Buffer.from(payloadStr),
          qos,
          retain
        }, (err) => {
          if (err) logger.error('Error publishing to internal broker:', err);
        });
      } else {
        throw new Error('No broker available for publishing');
      }

      this.stats.messagesSent++;

      // Update broker stats
      if (brokerId) {
        await MqttBroker.updateOne(
          { brokerId },
          { $inc: { 'status.messagesSent': 1 } }
        );
      }

      return { success: true, topic, brokerId };
    } catch (error) {
      logger.error('Error publishing message:', error);
      throw error;
    }
  }

  /**
   * Subscribe to a topic pattern (internal callback registration)
   */
  subscribe(pattern, callback) {
    if (!this.subscriptions.has(pattern)) {
      this.subscriptions.set(pattern, new Set());
    }
    this.subscriptions.get(pattern).add(callback);

    return () => {
      // Return unsubscribe function
      const callbacks = this.subscriptions.get(pattern);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscriptions.delete(pattern);
        }
      }
    };
  }

  /**
   * Get current state for a topic
   */
  async getState(topic) {
    // Check cache first
    const cached = this.stateCache.get(`state:${topic}`);
    if (cached) return cached;

    // Query database
    const state = await MqttState.findOne({ topic });
    if (state) {
      this.stateCache.set(`state:${topic}`, state);
    }
    return state;
  }

  /**
   * Get states by pattern
   */
  async getStatesByPattern(pattern) {
    return MqttState.findByPattern(pattern);
  }

  /**
   * Get device state
   */
  async getDeviceState(deviceId) {
    const device = await MqttDevice.findOne({ deviceId });
    if (!device?.topics?.state) return null;

    return this.getState(device.topics.state);
  }

  /**
   * Send command to device
   */
  async sendDeviceCommand(deviceId, command, options = {}) {
    const device = await MqttDevice.findOne({ deviceId });
    if (!device?.topics?.command) {
      throw new Error(`Device ${deviceId} has no command topic`);
    }

    return this.publish(device.topics.command, command, {
      brokerId: device.brokerId,
      ...options
    });
  }

  /**
   * Update broker status in database
   */
  async updateBrokerStatus(brokerId, status) {
    try {
      await MqttBroker.updateOne(
        { brokerId },
        { $set: { 'status': { ...status } } }
      );
    } catch (error) {
      logger.error('Error updating broker status:', error);
    }
  }

  /**
   * Check if topic matches pattern (supports + and # wildcards)
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
   * Get service statistics
   */
  getStats() {
    return {
      ...this.stats,
      brokerRunning: this.brokerEnabled,
      externalBrokers: this.externalClients.size,
      subscriptionPatterns: this.subscriptions.size,
      cacheStats: this.stateCache.getStats()
    };
  }

  /**
   * Get all connected brokers
   */
  async getBrokers() {
    return MqttBroker.find({});
  }

  /**
   * Get all devices
   */
  async getDevices(filter = {}) {
    return MqttDevice.find(filter);
  }

  /**
   * Add or update a broker configuration
   */
  async saveBroker(brokerData) {
    const broker = await MqttBroker.findOneAndUpdate(
      { brokerId: brokerData.brokerId },
      brokerData,
      { upsert: true, new: true }
    );

    // If enabled, connect/start
    if (broker.enabled) {
      if (broker.type === 'internal' && !this.aedes) {
        await this.startInternalBroker(broker);
      } else if (broker.type === 'external' && !this.externalClients.has(broker.brokerId)) {
        await this.connectExternalBroker(broker);
      }
    }

    return broker;
  }

  /**
   * Delete a broker configuration
   */
  async deleteBroker(brokerId) {
    // Disconnect first
    if (this.externalClients.has(brokerId)) {
      await this.disconnectExternalBroker(brokerId);
    }

    // Delete from database
    await MqttBroker.deleteOne({ brokerId });
    await MqttDevice.deleteMany({ brokerId });
    await MqttState.deleteMany({ brokerId });

    return { success: true };
  }

  /**
   * Shutdown the service
   */
  async shutdown() {
    logger.info('Shutting down MQTT service...');

    // Disconnect external clients
    for (const [brokerId] of this.externalClients) {
      await this.disconnectExternalBroker(brokerId);
    }

    // Stop internal broker
    await this.stopInternalBroker();

    this.enabled = false;
    logger.info('MQTT service shutdown complete');
  }
}

// Export singleton instance
const mqttService = new MqttService();
export default mqttService;
