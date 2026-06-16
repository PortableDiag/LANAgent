import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import fs from 'fs';
import path from 'path';

const PERSISTENT_DIR = path.join(process.env.DATA_PATH || path.join(process.cwd(), 'data'), 'eufy');
const DEFAULT_THROTTLE_MS = 60000;
const TFA_TIMEOUT_MS = 300000; // 5 minutes

export default class EufyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'eufy';
    this.version = '1.0.0';
    this.description = 'Eufy security camera integration — snapshots, device listing, and motion/person detection alerts';

    this.requiredCredentials = [
      { key: 'email', label: 'Eufy Account Email', envVar: 'EUFY_EMAIL', required: true },
      { key: 'password', label: 'Eufy Account Password', envVar: 'EUFY_PASSWORD', required: true }
    ];

    this.commands = [
      {
        command: 'setup',
        description: 'Connect to Eufy account (may require 2FA code)',
        usage: 'setup()',
        examples: [
          'setup eufy',
          'connect eufy',
          'eufy login',
          'connect to my security cameras',
          'link eufy account'
        ]
      },
      {
        command: 'devices',
        description: 'List all Eufy cameras and stations with status',
        usage: 'devices()',
        examples: [
          'list cameras',
          'eufy devices',
          'show security cameras',
          'what cameras are online',
          'show my cameras'
        ]
      },
      {
        command: 'snapshot',
        description: 'Get a snapshot from a camera and send via Telegram',
        usage: 'snapshot({ camera: "front door" })',
        examples: [
          'show me the front door camera',
          'take a snapshot',
          'camera snapshot',
          'snapshot of the backyard',
          'show me what the camera sees',
          'grab a frame from the driveway camera'
        ]
      },
      {
        command: 'alerts',
        description: 'Enable or disable motion/person detection alerts',
        usage: 'alerts({ enabled: true, throttle: 60 })',
        examples: [
          'enable camera alerts',
          'disable motion notifications',
          'turn on person detection alerts',
          'stop camera notifications',
          'set alert cooldown to 2 minutes'
        ]
      },
      {
        command: 'status',
        description: 'Show Eufy connection status and alert configuration',
        usage: 'status()',
        examples: [
          'eufy status',
          'is eufy connected',
          'camera system status',
          'are alerts enabled'
        ]
      }
    ];

    this.eufyClient = null;
    this.connected = false;
    this.connecting = false;
    this.pending2FA = null;
    this.lastAlertTime = {};
    this.alertConfig = {
      enabled: false,
      includeSnapshot: true,
      throttleMs: DEFAULT_THROTTLE_MS
    };
  }

  async initialize() {
    // Load persisted alert config
    try {
      const saved = await PluginSettings.findOne({ pluginName: this.name, settingsKey: 'alertConfig' });
      if (saved?.settingsValue) {
        this.alertConfig = { ...this.alertConfig, ...saved.settingsValue };
        this.logger.info(`Alert config loaded: enabled=${this.alertConfig.enabled}, throttle=${this.alertConfig.throttleMs}ms`);
      }
    } catch (err) {
      this.logger.warn('Failed to load alert config:', err.message);
    }

    // Check if credentials exist (don't connect yet — lazy connect)
    try {
      await this.loadCredentials(this.requiredCredentials);
      this.logger.info('Eufy credentials found. Will connect on first command.');
    } catch {
      this.logger.info('Eufy credentials not configured yet. Use "setup eufy" to begin.');
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'setup':
        return await this.handleSetup();
      case 'devices':
        return await this.handleDevices();
      case 'snapshot':
        return await this.handleSnapshot(data);
      case 'alerts':
        return await this.handleAlerts(data);
      case 'status':
        return await this.handleStatus();
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  // ── Connection Lifecycle ──────────────────────────────────────────

  async ensureConnected() {
    if (this.connected && this.eufyClient) return;
    if (this.connecting) {
      throw new Error('Eufy connection is already in progress. If 2FA was requested, please enter your code.');
    }

    const credentials = await this.loadCredentials(this.requiredCredentials);
    await this.connectToEufy(credentials);
  }

  async connectToEufy(credentials) {
    this.connecting = true;

    try {
      // Ensure persistent directory exists
      if (!fs.existsSync(PERSISTENT_DIR)) {
        fs.mkdirSync(PERSISTENT_DIR, { recursive: true });
      }

      const { EufySecurity } = await import('eufy-security-client');

      const config = {
        username: credentials.email,
        password: credentials.password,
        persistentDir: PERSISTENT_DIR,
        p2pConnectionSetup: 0, // quickest
        pollingIntervalMinutes: 10,
        eventDurationSeconds: 10
      };

      this.eufyClient = await EufySecurity.initialize(config);
      this.setupEventListeners();

      // connect() resolves after login attempt, but "tfa request" or "connect"
      // events fire asynchronously afterward. We need to wait for one of them.
      const connectResult = await Promise.race([
        new Promise(resolve => {
          this.eufyClient.once('connect', () => resolve('connected'));
        }),
        new Promise(resolve => {
          this.eufyClient.once('tfa request', () => resolve('tfa'));
        }),
        new Promise(resolve => {
          this.eufyClient.once('captcha request', () => resolve('captcha'));
        }),
        // Start the connection
        this.eufyClient.connect().then(() => {
          // Give events a moment to fire after connect() resolves
          return new Promise(resolve => setTimeout(() => resolve('resolved'), 3000));
        })
      ]);

      if (connectResult === 'connected' || (connectResult === 'resolved' && this.connected)) {
        this.logger.info('Eufy connected successfully (no 2FA required)');
      } else if (connectResult === 'tfa' || this.pending2FA) {
        this.logger.info('Eufy requires 2FA verification');
      } else if (connectResult === 'captcha') {
        this.connecting = false;
        throw new Error('Eufy requires captcha verification which is not supported. Try again later.');
      } else {
        // connect() resolved but no connect event — may be auth failure
        this.connecting = false;
        if (!this.connected) {
          throw new Error('Eufy login failed. Check your credentials.');
        }
      }
    } catch (err) {
      // If 2FA is pending, don't treat as error
      if (this.pending2FA) return;
      this.connecting = false;
      this.eufyClient = null;
      throw err;
    }
  }

  setupEventListeners() {
    if (!this.eufyClient) return;

    // 2FA request
    this.eufyClient.on('tfa request', () => {
      this.logger.info('Eufy 2FA requested');
      this.pending2FA = {};
      this.pending2FA.promise = new Promise((resolve, reject) => {
        this.pending2FA.resolve = resolve;
        this.pending2FA.reject = reject;
      });

      // Auto-reject after timeout
      this.pending2FA.timer = setTimeout(() => {
        if (this.pending2FA) {
          this.pending2FA.reject(new Error('2FA code timed out after 5 minutes'));
          this.pending2FA = null;
          this.connecting = false;
        }
      }, TFA_TIMEOUT_MS);
    });

    // Connection events
    this.eufyClient.on('connect', () => {
      this.connected = true;
      this.connecting = false;
      this.logger.info('Eufy connected');
    });

    this.eufyClient.on('close', () => {
      this.connected = false;
      this.logger.info('Eufy disconnected');
    });

    // Motion detection
    this.eufyClient.on('device motion detected', (device, state) => {
      if (!state || !this.alertConfig.enabled) return;
      this.handleMotionAlert(device, 'motion');
    });

    // Person detection
    this.eufyClient.on('device person detected', (device, state) => {
      if (!state || !this.alertConfig.enabled) return;
      this.handleMotionAlert(device, 'person');
    });
  }

  async submit2FACode(code) {
    if (!this.pending2FA) {
      return { success: false, error: 'No 2FA request is pending. Run "setup eufy" first.' };
    }

    try {
      clearTimeout(this.pending2FA.timer);

      // Submit the verification code
      await this.eufyClient.connect({ verifyCode: code });

      this.connected = true;
      this.connecting = false;
      this.pending2FA.resolve();
      this.pending2FA = null;

      this.logger.info('Eufy 2FA verified, connected successfully');
      return { success: true };
    } catch (err) {
      this.connecting = false;
      this.pending2FA.reject(err);
      this.pending2FA = null;

      this.logger.error('Eufy 2FA verification failed:', err);
      return { success: false, error: `2FA verification failed: ${err.message}` };
    }
  }

  // ── Command Handlers ──────────────────────────────────────────────

  async handleSetup() {
    try {
      await this.ensureConnected();

      // If 2FA was triggered, prompt the user
      if (this.pending2FA) {
        return {
          success: true,
          type: 'text',
          result: 'Eufy requires 2FA verification. Please enter your code (check your email or SMS).',
          metadata: { setOperation: 'eufy_2fa' }
        };
      }

      return {
        success: true,
        type: 'text',
        result: 'Eufy connected successfully! Try "list cameras" or "take a snapshot".'
      };
    } catch (err) {
      this.logger.error('Eufy setup failed:', err);
      return {
        success: false,
        error: `Eufy setup failed: ${err.message}. Check credentials in the web UI credentials manager.`
      };
    }
  }

  async handleDevices() {
    try {
      await this.ensureConnected();

      const stations = await this.eufyClient.getStations();
      const devices = await this.eufyClient.getDevices();

      if (devices.length === 0 && stations.length === 0) {
        return { success: true, type: 'text', result: 'No Eufy devices found on this account.' };
      }

      let msg = '*Eufy Devices:*\n\n';

      if (stations.length > 0) {
        msg += '*Base Stations:*\n';
        for (const station of stations) {
          const name = station.getName();
          const model = station.getModel();
          msg += `  - ${name} (${model})\n`;
        }
        msg += '\n';
      }

      if (devices.length > 0) {
        msg += '*Cameras:*\n';
        for (const device of devices) {
          const name = device.getName();
          const model = device.getModel();
          const sn = device.getSerial();
          const battery = device.hasBattery() ? ` | Battery: ${device.getBatteryValue()}%` : '';
          msg += `  - *${name}* — ${model} (SN: ${sn}${battery})\n`;
        }
      }

      return { success: true, type: 'text', result: msg };
    } catch (err) {
      this.logger.error('Failed to list devices:', err);
      return { success: false, error: `Failed to list devices: ${err.message}` };
    }
  }

  async handleSnapshot(data) {
    try {
      await this.ensureConnected();

      const { camera, device: deviceName } = data;
      const query = camera || deviceName;

      const devices = await this.eufyClient.getDevices();
      if (devices.length === 0) {
        return { success: false, error: 'No cameras found on this account.' };
      }

      // Find target device
      const device = query ? await this.findDevice(query) : devices[0];
      if (!device) {
        const available = devices.map(d => d.getName()).join(', ');
        return { success: false, error: `Camera "${query}" not found. Available: ${available}` };
      }

      const deviceName_ = device.getName();
      this.logger.info(`Taking snapshot from: ${deviceName_}`);

      // Try pictureUrl first (cloud thumbnail — fast)
      let imageBuffer = null;
      try {
        const pictureUrl = device.getPropertyValue('pictureUrl');
        if (pictureUrl) {
          const axios = (await import('axios')).default;
          const resp = await axios.get(pictureUrl, { responseType: 'arraybuffer', timeout: 15000 });
          imageBuffer = Buffer.from(resp.data);
        }
      } catch (err) {
        this.logger.warn(`pictureUrl fetch failed for ${deviceName_}: ${err.message}`);
      }

      // Fallback: P2P livestream → ffmpeg → single frame
      if (!imageBuffer) {
        try {
          imageBuffer = await this.captureFrameP2P(device);
        } catch (err) {
          this.logger.warn(`P2P capture failed for ${deviceName_}: ${err.message}`);
        }
      }

      if (!imageBuffer) {
        return { success: false, error: `Could not capture snapshot from ${deviceName_}. The camera may be offline or asleep.` };
      }

      const caption = `Snapshot from *${deviceName_}*`;

      try {
        await this.notify(caption, {
          photo: { source: imageBuffer },
          parse_mode: 'Markdown'
        });
      } catch (notifyErr) {
        this.logger.error('Failed to send snapshot via Telegram:', notifyErr);
        return { success: false, error: 'Snapshot captured but failed to send via Telegram.' };
      }

      return {
        success: true,
        type: 'text',
        result: `Snapshot from *${deviceName_}* sent to Telegram.`
      };
    } catch (err) {
      this.logger.error('Snapshot failed:', err);
      return { success: false, error: `Snapshot failed: ${err.message}` };
    }
  }

  async captureFrameP2P(device) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { this.eufyClient.stopStationLivestream(device.getSerial()); } catch { /* ignore */ }
          reject(new Error('P2P livestream timed out after 30s'));
        }
      }, 30000);

      const onData = (d, buffer) => {
        if (d.getSerial() !== device.getSerial()) return;
        chunks.push(Buffer.from(buffer));

        // Once we have some data, extract a frame with ffmpeg
        if (chunks.length >= 5 && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.eufyClient.removeListener('device livestream video data', onData);
          try { this.eufyClient.stopStationLivestream(device.getSerial()); } catch { /* ignore */ }

          const rawH264 = Buffer.concat(chunks);
          this.extractFrameFromH264(rawH264).then(resolve).catch(reject);
        }
      };

      this.eufyClient.on('device livestream video data', onData);

      this.eufyClient.startStationLivestream(device.getSerial()).catch(err => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.eufyClient.removeListener('device livestream video data', onData);
          reject(err);
        }
      });
    });
  }

  async extractFrameFromH264(h264Buffer) {
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    const { PassThrough } = await import('stream');
    const tmpInput = path.join(PERSISTENT_DIR, `frame_in_${Date.now()}.h264`);
    const tmpOutput = path.join(PERSISTENT_DIR, `frame_out_${Date.now()}.jpg`);

    try {
      fs.writeFileSync(tmpInput, h264Buffer);

      await new Promise((resolve, reject) => {
        ffmpeg(tmpInput)
          .frames(1)
          .output(tmpOutput)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      const jpegBuffer = fs.readFileSync(tmpOutput);
      return jpegBuffer;
    } finally {
      try { fs.unlinkSync(tmpInput); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpOutput); } catch { /* ignore */ }
    }
  }

  async handleAlerts(data) {
    const { enabled, enable, disable, throttle, includeSnapshot } = data;

    // Determine desired state
    let wantEnabled = this.alertConfig.enabled;
    if (enabled !== undefined) wantEnabled = !!enabled;
    else if (enable !== undefined) wantEnabled = true;
    else if (disable !== undefined) wantEnabled = false;

    const throttleMs = throttle ? throttle * 1000 : this.alertConfig.throttleMs;
    const wantSnapshot = includeSnapshot !== undefined ? !!includeSnapshot : this.alertConfig.includeSnapshot;

    // If enabling alerts, ensure we're connected
    if (wantEnabled && !this.connected) {
      try {
        await this.ensureConnected();
      } catch (err) {
        return { success: false, error: `Cannot enable alerts — Eufy not connected: ${err.message}` };
      }
    }

    this.alertConfig = {
      enabled: wantEnabled,
      includeSnapshot: wantSnapshot,
      throttleMs
    };

    // Persist config
    try {
      await PluginSettings.findOneAndUpdate(
        { pluginName: this.name, settingsKey: 'alertConfig' },
        { pluginName: this.name, settingsKey: 'alertConfig', settingsValue: this.alertConfig },
        { upsert: true, new: true }
      );
    } catch (err) {
      this.logger.warn('Failed to persist alert config:', err.message);
    }

    const throttleSec = Math.round(throttleMs / 1000);
    const statusMsg = wantEnabled
      ? `Camera alerts *enabled*. Throttle: ${throttleSec}s per device. Snapshots: ${wantSnapshot ? 'on' : 'off'}.`
      : 'Camera alerts *disabled*.';

    return { success: true, type: 'text', result: statusMsg };
  }

  async handleStatus() {
    const devices = this.connected ? await this.eufyClient.getDevices() : [];
    const throttleSec = Math.round(this.alertConfig.throttleMs / 1000);

    let msg = '*Eufy Status:*\n\n';
    msg += `*Connection:* ${this.connected ? 'Connected' : (this.connecting ? 'Connecting...' : 'Disconnected')}\n`;
    msg += `*Devices:* ${this.connected ? devices.length : 'N/A'}\n`;
    msg += `*Alerts:* ${this.alertConfig.enabled ? 'Enabled' : 'Disabled'}\n`;
    msg += `*Alert throttle:* ${throttleSec}s per device\n`;
    msg += `*Include snapshot:* ${this.alertConfig.includeSnapshot ? 'Yes' : 'No'}`;

    return { success: true, type: 'text', result: msg };
  }

  // ── Motion/Person Alert Handling ──────────────────────────────────

  async handleMotionAlert(device, type) {
    const sn = device.getSerial();
    const name = device.getName();
    const now = Date.now();

    // Throttle check
    if (this.lastAlertTime[sn] && (now - this.lastAlertTime[sn]) < this.alertConfig.throttleMs) {
      this.logger.debug(`Alert throttled for ${name} (${type})`);
      return;
    }
    this.lastAlertTime[sn] = now;

    const emoji = type === 'person' ? '🚶' : '🔔';
    const label = type === 'person' ? 'Person detected' : 'Motion detected';
    const caption = `${emoji} *${label}* on *${name}*`;

    this.logger.info(`${label} on ${name} (${sn})`);

    try {
      if (this.alertConfig.includeSnapshot) {
        let imageBuffer = null;
        try {
          const pictureUrl = device.getPropertyValue('pictureUrl');
          if (pictureUrl) {
            const axios = (await import('axios')).default;
            const resp = await axios.get(pictureUrl, { responseType: 'arraybuffer', timeout: 15000 });
            imageBuffer = Buffer.from(resp.data);
          }
        } catch (err) {
          this.logger.warn(`Failed to fetch alert snapshot for ${name}: ${err.message}`);
        }

        if (imageBuffer) {
          await this.notify(caption, {
            photo: { source: imageBuffer },
            parse_mode: 'Markdown'
          });
          return;
        }
      }

      // Text-only alert (no snapshot or snapshot disabled)
      await this.notify(caption, { parse_mode: 'Markdown' });
    } catch (err) {
      this.logger.error(`Failed to send ${type} alert for ${name}:`, err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  async findDevice(nameOrSN) {
    if (!this.eufyClient) return null;
    const devices = await this.eufyClient.getDevices();
    const query = nameOrSN.toLowerCase();

    // Exact serial match
    const bySN = devices.find(d => d.getSerial().toLowerCase() === query);
    if (bySN) return bySN;

    // Fuzzy name match
    return devices.find(d => d.getName().toLowerCase().includes(query)) || null;
  }

  async cleanup() {
    if (this.pending2FA?.timer) {
      clearTimeout(this.pending2FA.timer);
      this.pending2FA = null;
    }
    if (this.eufyClient) {
      try {
        await this.eufyClient.close();
      } catch (err) {
        this.logger.warn('Error closing Eufy client:', err.message);
      }
      this.eufyClient = null;
    }
    this.connected = false;
    this.connecting = false;
  }
}
