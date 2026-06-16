import { logger } from '../../utils/logger.js';
import { BaseAgentHandler } from './BaseAgentHandler.js';
import { SSHConnection } from '../../models/SSHConnection.js';
import { retryOperation } from '../../utils/retryUtils.js';

/**
 * ServerMaintenanceAgent
 *
 * Monitors and maintains a target server via SSH.
 * Runs hourly via maintenance:heartbeat event.
 *
 * Safe operations (auto): disk/mem/cpu checks, journal cleanup, apt autoclean, tmp cleanup
 * Dangerous operations (approval required): apt upgrade, service restart, reboot, docker prune
 *
 * Alerts via Telegram only when issues are found.
 */
export class ServerMaintenanceAgent extends BaseAgentHandler {
  constructor(mainAgent, agentDoc) {
    super(mainAgent, agentDoc);
    this.sshConnectionId = null;
    this.checkResults = {};
  }

  getDefaultConfig() {
    return {
      targetHost: process.env.MAINTENANCE_TARGET_HOST || 'localhost',
      targetUser: process.env.MAINTENANCE_TARGET_USER || 'root',
      hostname: process.env.MAINTENANCE_TARGET_HOSTNAME || 'server',
      checks: {
        disk: {
          enabled: true,
          warningThresholdPct: 80,
          criticalThresholdPct: 95,
          // Media drives (HDD1-6, MediaLibrary*) are expected to be nearly full.
          // Only alert if free space drops below minFreeGB (not percentage-based).
          mediaDrivePatterns: ['/media/HDD', '/media/ML'],
          mediaMinFreeGB: 20,
          // High-capacity drives that are expected to be mostly full — use a higher warning threshold
          highThresholdDrives: {
            '/media/NASMedia': { warningThresholdPct: 95 }
          },
          // Security drive: auto-run cleanup script when usage exceeds threshold
          securityDrive: {
            mount: '/media/Security',
            cleanupScript: '/media/Security/clear.sh',
            cleanupThresholdPct: 85
          }
        },
        memory: { enabled: true, warningThresholdPct: 85 },
        cpu: { enabled: true, warningLoadAvg: 4.0 },
        services: { enabled: true, watch: ['sshd', 'smbd', 'docker'] },
        docker: { enabled: true },
        updates: { enabled: true },
        ntp: { enabled: true, maxDriftSec: 5 },
        uptime: { enabled: true },
        temperature: { enabled: true, warningTempC: 75 }
      },
      // Monitored application services — auto-restart on crash, skip if manually stopped
      monitoredServices: {
        enabled: true,
        apps: [
          // calibre systemd unit is broken (--daemonize causes exit code 1), check process instead
          { name: 'calibre', unit: 'calibre', checkMethod: 'process', processPattern: 'calibre-server', restartCmd: 'systemctl restart calibre', port: 8080 },
          { name: 'jellyfin', unit: 'jellyfin', checkMethod: 'systemd', port: 8096 },
          { name: 'radarr', unit: 'radarr', checkMethod: 'systemd', port: 7878 },
          { name: 'sonarr', unit: 'sonarr', checkMethod: 'systemd', port: 8989 },
          { name: 'lidarr', unit: 'lidarr', checkMethod: 'systemd', port: 8686 },
          { name: 'readarr', unit: 'readarr', checkMethod: 'systemd', port: 8787 },
          { name: 'prowlarr', unit: 'prowlarr', checkMethod: 'systemd', port: 9696 },
          { name: 'expressvpn', unit: 'expressvpn-service', checkMethod: 'systemd', statusCmd: 'expressvpnctl status 2>/dev/null || expressvpn status', altUnits: ['expressvpn'] },
          { name: 'transmission', unit: 'transmission-daemon', checkMethod: 'systemd', port: 9091, requiresVpn: true },
          { name: 'vsftpd', unit: 'vsftpd', checkMethod: 'systemd' }
        ]
      },
      autoCleanup: {
        journalctl: true,
        aptCache: true,
        tmpFiles: true,
        dockerPrune: false
      },
      approvalRequired: ['apt_upgrade', 'service_restart', 'reboot', 'docker_prune', 'disk_cleanup_large']
    };
  }

  getDefaultState() {
    return {
      lastCheck: null,
      lastSuccessfulCheck: null,
      consecutiveFailures: 0,
      diskUsage: {},
      memoryUsage: {},
      pendingUpdates: 0,
      services: {},
      dockerContainers: [],
      alerts: [],
      pendingApprovals: [],
      lastCleanup: null,
      uptimeDays: 0,
      // Tracked per monitored app: { running, manuallyStopped, version, lastSeen, errors }
      monitoredApps: {},
      // Set on first successful check — records which apps were running at baseline
      baselineRecorded: false
    };
  }

  async initialize() {
    await super.initialize();

    // Ensure domainConfig has defaults
    const config = this.getConfig();
    if (!config.targetHost) {
      await this.updateConfig(this.getDefaultConfig());
    } else {
      // Always sync monitoredServices.apps from code defaults so new apps are picked up
      const defaults = this.getDefaultConfig();
      if (defaults.monitoredServices?.apps) {
        const currentApps = config.monitoredServices?.apps || [];
        const defaultApps = defaults.monitoredServices.apps;
        if (currentApps.length !== defaultApps.length) {
          logger.info(`ServerMaintenanceAgent: Syncing monitoredServices apps from ${currentApps.length} to ${defaultApps.length}`);
          await this.updateConfig({ monitoredServices: { ...config.monitoredServices, apps: defaultApps } });
        }
      }
    }

    // Ensure domainState has defaults
    const state = this.getState();
    if (!state.lastCheck && state.lastCheck !== null) {
      await this.updateState(this.getDefaultState());
    }

    // Find SSH connection for goliath
    const cfg = this.getConfig();
    try {
      const conn = await SSHConnection.findOne({ host: cfg.targetHost });
      if (conn) {
        this.sshConnectionId = conn.connectionId;
        logger.info(`ServerMaintenanceAgent: Found SSH connection ${this.sshConnectionId} for ${cfg.hostname}`);
      } else {
        logger.warn(`ServerMaintenanceAgent: No SSH connection found for ${cfg.targetHost}`);
      }
    } catch (error) {
      logger.error('ServerMaintenanceAgent: Failed to find SSH connection:', error.message);
    }

    logger.info(`ServerMaintenanceAgent initialized for: ${this.agentDoc.name}`);
  }

  async execute(options = {}) {
    const config = this.getConfig();
    const hostname = config.hostname || 'goliath';
    this.checkResults = {};

    logger.info(`ServerMaintenanceAgent: Starting maintenance check for ${hostname}`);

    try {
      // Connect to host via SSH
      const connected = await this.connectSSH();
      if (!connected) {
        await this.handleConnectionFailure();
        return { success: false, error: 'SSH connection failed' };
      }

      // Run all enabled checks in parallel
      const checks = this.buildCheckList(config);
      const results = await Promise.allSettled(checks.map(c => c.fn()));

      // Map results back to check names
      const checkReport = [];
      for (let i = 0; i < checks.length; i++) {
        const name = checks[i].name;
        const result = results[i];
        if (result.status === 'fulfilled') {
          this.checkResults[name] = result.value;
          checkReport.push(result.value);
        } else {
          this.checkResults[name] = { name, status: 'error', message: result.reason?.message || 'Unknown error' };
          checkReport.push(this.checkResults[name]);
        }
      }

      // Perform safe auto-cleanup
      let cleanupResult = null;
      if (config.autoCleanup) {
        cleanupResult = await this.performAutoCleanup(config);
      }

      // Analyze results and build alerts
      const alerts = this.analyzeResults(checkReport);

      // Queue dangerous actions for approval if needed
      await this.queueApprovals(config);

      // Check for new alerts vs previously seen ones (suppress repeated warnings)
      const previousAlertKeys = new Set((this.getState().alertKeys || []));
      const currentAlertKeys = alerts.map(a => `${a.check}:${a.message}`);
      const newAlerts = currentAlertKeys.filter(k => !previousAlertKeys.has(k));
      const hasCritical = alerts.some(a => a.severity === 'critical');

      // Update state
      const stateUpdate = {
        lastCheck: new Date().toISOString(),
        lastSuccessfulCheck: new Date().toISOString(),
        consecutiveFailures: 0,
        diskUsage: this.checkResults.disk?.data || {},
        memoryUsage: this.checkResults.memory?.data || {},
        pendingUpdates: this.checkResults.updates?.data?.count || 0,
        services: this.checkResults.services?.data || {},
        dockerContainers: this.checkResults.docker?.data || [],
        alerts,
        alertKeys: currentAlertKeys,
        uptimeDays: this.checkResults.uptime?.data?.days || 0,
        lastCleanup: cleanupResult ? new Date().toISOString() : this.getState().lastCleanup
      };
      if (this.checkResults.monitoredApps?.data) {
        const appKeys = Object.keys(this.checkResults.monitoredApps.data);
        logger.info(`ServerMaintenanceAgent: persisting monitoredApps: ${appKeys.length} apps [${appKeys.join(', ')}]`);
        stateUpdate.monitoredApps = this.checkResults.monitoredApps.data;
        stateUpdate.baselineRecorded = true;
      }
      await this.updateState(stateUpdate);

      // Send Telegram alert only for NEW or CRITICAL issues — suppress repeated warnings
      if (hasCritical || newAlerts.length > 0) {
        const message = this.buildAlertMessage(checkReport, alerts, cleanupResult);
        await this.sendTelegramAlert(message);
      } else if (alerts.length > 0) {
        logger.info(`ServerMaintenanceAgent: ${alerts.length} repeated warning(s) suppressed — no new alerts`);
      }

      await this.log('maintenance_check', {
        hostname,
        checksRun: checks.length,
        alerts: alerts.length,
        cleanup: !!cleanupResult
      });

      // Disconnect SSH
      await this.disconnectSSH();

      const summary = `${hostname}: ${checks.length} checks, ${alerts.length} alert(s)`;
      logger.info(`ServerMaintenanceAgent: ${summary}`);

      return { success: true, summary, alerts: alerts.length, checksRun: checks.length };

    } catch (error) {
      logger.error(`ServerMaintenanceAgent: Maintenance check failed:`, error);
      await this.disconnectSSH();

      const state = this.getState();
      await this.updateState({
        lastCheck: new Date().toISOString(),
        consecutiveFailures: (state.consecutiveFailures || 0) + 1
      });

      // Alert on repeated failures
      if ((state.consecutiveFailures || 0) >= 2) {
        await this.sendTelegramAlert(
          `*${hostname} Maintenance Alert*\n\n` +
          `Failed ${(state.consecutiveFailures || 0) + 1} consecutive checks.\n` +
          `Error: ${error.message}`
        );
      }

      return { success: false, error: error.message };
    }
  }

  buildCheckList(config) {
    const checks = [];
    const c = config.checks || {};

    if (c.disk?.enabled) checks.push({ name: 'disk', fn: () => this.checkDisk(c.disk) });
    if (c.memory?.enabled) checks.push({ name: 'memory', fn: () => this.checkMemory(c.memory) });
    if (c.cpu?.enabled) checks.push({ name: 'cpu', fn: () => this.checkCPU(c.cpu) });
    if (c.services?.enabled) checks.push({ name: 'services', fn: () => this.checkServices(c.services) });
    if (c.docker?.enabled) checks.push({ name: 'docker', fn: () => this.checkDocker() });
    if (c.updates?.enabled) checks.push({ name: 'updates', fn: () => this.checkUpdates() });
    if (c.ntp?.enabled) checks.push({ name: 'ntp', fn: () => this.checkNTP() });
    if (c.uptime?.enabled) checks.push({ name: 'uptime', fn: () => this.checkUptime() });
    if (c.temperature?.enabled) checks.push({ name: 'temperature', fn: () => this.checkTemperature(c.temperature) });
    if (config.monitoredServices?.enabled) checks.push({ name: 'monitoredApps', fn: () => this.checkMonitoredServices(config.monitoredServices) });

    return checks;
  }

  // --- SSH Helpers ---

  async connectSSH() {
    if (!this.sshConnectionId) {
      logger.error('ServerMaintenanceAgent: No SSH connection ID configured');
      return false;
    }

    try {
      const result = await retryOperation(
        () => this.mainAgent.apiManager.executeAPI('ssh', 'execute', {
          action: 'connect',
          id: this.sshConnectionId
        }),
        { maxRetries: 2, baseDelay: 3000, operationName: 'SSH connect to goliath' }
      );
      return result?.success === true;
    } catch (error) {
      logger.error(`ServerMaintenanceAgent: SSH connect failed:`, error.message);
      return false;
    }
  }

  async disconnectSSH() {
    if (!this.sshConnectionId) return;
    try {
      await this.mainAgent.apiManager.executeAPI('ssh', 'execute', {
        action: 'disconnect',
        connectionId: this.sshConnectionId
      });
    } catch (error) {
      logger.debug(`ServerMaintenanceAgent: SSH disconnect error (non-fatal):`, error.message);
    }
  }

  async runSSHCommand(command) {
    const result = await this.mainAgent.apiManager.executeAPI('ssh', 'execute', {
      action: 'execute',
      connectionId: this.sshConnectionId,
      command
    });

    if (!result?.success) {
      throw new Error(`SSH command failed: ${result?.error || 'unknown error'}`);
    }

    return result.data?.stdout || '';
  }

  // --- Check Methods ---

  async checkDisk(config) {
    const output = await this.runSSHCommand('df -h --output=target,pcent,avail | grep -v Mounted');
    const mounts = {};
    let status = 'ok';
    const issues = [];
    const mediaPatterns = config.mediaDrivePatterns || ['/media/HDD', '/media/ML'];
    const mediaMinFreeGB = config.mediaMinFreeGB || 20;
    const secCfg = config.securityDrive || {};

    for (const line of output.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;

      const mount = parts[0];
      const usedPct = parseInt(parts[1], 10);
      const avail = parts[2];

      if (isNaN(usedPct)) continue;

      mounts[mount] = { usedPct, avail };

      // Parse available space to GB for comparison
      const availGB = this.parseSpaceToGB(avail);

      // Media drives (HDD1-6, MediaLibrary*): these are expected near-full.
      // Only alert if free space drops below mediaMinFreeGB, not on percentage.
      const isMediaDrive = mediaPatterns.some(p => mount.startsWith(p));
      if (isMediaDrive) {
        if (availGB !== null && availGB < mediaMinFreeGB) {
          status = 'critical';
          issues.push(`${mount} at ${usedPct}% — only ${avail} free (media drive critical)`);
        }
        // Otherwise, media drives at 99% with 40-50G free is normal — no alert
        continue;
      }

      // Security drive: auto-cleanup when above threshold
      if (secCfg.mount && mount === secCfg.mount) {
        if (usedPct >= (secCfg.cleanupThresholdPct || 85)) {
          logger.info(`ServerMaintenanceAgent: Security drive at ${usedPct}%, running cleanup`);
          await this.runSecurityCleanup(secCfg);
          issues.push(`${mount} at ${usedPct}% — auto-cleanup triggered`);
          if (status !== 'critical') status = 'warning';
        }
        continue;
      }

      // High-threshold drives: use per-drive override thresholds
      const highThreshold = config.highThresholdDrives?.[mount];
      if (highThreshold) {
        const warnAt = highThreshold.warningThresholdPct || 95;
        if (usedPct >= warnAt) {
          if (status !== 'critical') status = 'warning';
          issues.push(`${mount} at ${usedPct}% (warning)`);
        }
        continue;
      }

      // All other drives: standard thresholds
      if (usedPct >= (config.criticalThresholdPct || 95)) {
        status = 'critical';
        issues.push(`${mount} at ${usedPct}% (critical)`);
      } else if (usedPct >= (config.warningThresholdPct || 80)) {
        if (status !== 'critical') status = 'warning';
        issues.push(`${mount} at ${usedPct}% (warning)`);
      }
    }

    return { name: 'disk', status, data: mounts, issues };
  }

  parseSpaceToGB(str) {
    if (!str) return null;
    const match = str.match(/^([\d.]+)([TGMK])?$/i);
    if (!match) return null;
    const val = parseFloat(match[1]);
    const unit = (match[2] || '').toUpperCase();
    if (unit === 'T') return val * 1024;
    if (unit === 'G') return val;
    if (unit === 'M') return val / 1024;
    if (unit === 'K') return val / (1024 * 1024);
    return val;
  }

  async runSecurityCleanup(secCfg) {
    const script = secCfg.cleanupScript || '/media/Security/clear.sh';
    try {
      const output = await this.runSSHCommand(`bash ${script} 2>&1`);
      logger.info(`ServerMaintenanceAgent: Security cleanup output: ${output.trim()}`);

      // Check usage after cleanup
      const postOutput = await this.runSSHCommand(`df -h --output=pcent,avail ${secCfg.mount} | tail -1`);
      const postParts = postOutput.trim().split(/\s+/);
      logger.info(`ServerMaintenanceAgent: Security drive after cleanup: ${postParts[0]} used, ${postParts[1]} free`);

      await this.log('security_cleanup', {
        script,
        output: output.trim(),
        postCleanup: postOutput.trim()
      });
    } catch (error) {
      logger.error(`ServerMaintenanceAgent: Security cleanup failed:`, error.message);
    }
  }

  async checkMemory(config) {
    const output = await this.runSSHCommand('free -m');
    const lines = output.trim().split('\n');
    let status = 'ok';
    const issues = [];
    const data = {};

    for (const line of lines) {
      if (line.startsWith('Mem:')) {
        const parts = line.split(/\s+/);
        const total = parseInt(parts[1], 10);
        const used = parseInt(parts[2], 10);
        const usedPct = Math.round((used / total) * 100);
        data.totalMB = total;
        data.usedMB = used;
        data.usedPct = usedPct;

        if (usedPct >= (config.warningThresholdPct || 85)) {
          status = 'warning';
          issues.push(`Memory at ${usedPct}%`);
        }
      } else if (line.startsWith('Swap:')) {
        const parts = line.split(/\s+/);
        data.swapTotalMB = parseInt(parts[1], 10);
        data.swapUsedMB = parseInt(parts[2], 10);
      }
    }

    return { name: 'memory', status, data, issues };
  }

  async checkCPU(config) {
    const output = await this.runSSHCommand('cat /proc/loadavg');
    const parts = output.trim().split(/\s+/);
    const load1 = parseFloat(parts[0]);
    const load5 = parseFloat(parts[1]);
    const load15 = parseFloat(parts[2]);

    let status = 'ok';
    const issues = [];

    if (load1 >= (config.warningLoadAvg || 4.0)) {
      status = 'warning';
      issues.push(`Load avg: ${load1}/${load5}/${load15}`);
    }

    return { name: 'cpu', status, data: { load1, load5, load15 }, issues };
  }

  async checkServices(config) {
    const watchList = config.watch || ['sshd', 'smbd', 'docker'];
    const data = {};
    let status = 'ok';
    const issues = [];

    for (const svc of watchList) {
      try {
        const output = await this.runSSHCommand(`systemctl is-active ${svc} 2>/dev/null || echo inactive`);
        const svcStatus = output.trim();
        data[svc] = svcStatus;

        if (svcStatus !== 'active') {
          status = 'critical';
          issues.push(`${svc} is ${svcStatus}`);
        }
      } catch {
        data[svc] = 'unknown';
        status = 'warning';
        issues.push(`${svc} check failed`);
      }
    }

    return { name: 'services', status, data, issues };
  }

  async checkDocker() {
    let status = 'ok';
    const issues = [];
    const data = [];

    try {
      const output = await this.runSSHCommand("docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null");
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        const [name, ...statusParts] = line.split('\t');
        const containerStatus = statusParts.join('\t');
        data.push({ name, status: containerStatus });

        if (containerStatus && containerStatus.toLowerCase().includes('unhealthy')) {
          status = 'warning';
          issues.push(`Container ${name} is unhealthy`);
        }
      }
    } catch {
      // Docker might not be installed
      return { name: 'docker', status: 'ok', data: [], issues: [], message: 'Docker not available' };
    }

    return { name: 'docker', status, data, issues };
  }

  async checkUpdates() {
    let count = 0;
    try {
      const output = await this.runSSHCommand('apt list --upgradable 2>/dev/null | grep -c upgradable || echo 0');
      count = parseInt(output.trim(), 10) || 0;
    } catch {
      count = 0;
    }

    // Informational only — apt updates are routine and should not generate alerts
    return {
      name: 'updates',
      status: 'ok',
      data: { count },
      issues: []
    };
  }

  async checkNTP() {
    let status = 'ok';
    const issues = [];

    try {
      const output = await this.runSSHCommand('timedatectl show --property=NTPSynchronized --value 2>/dev/null || echo unknown');
      const synced = output.trim();

      if (synced === 'no') {
        status = 'warning';
        issues.push('NTP not synchronized');
      }

      return { name: 'ntp', status, data: { synchronized: synced === 'yes' }, issues };
    } catch {
      return { name: 'ntp', status: 'ok', data: { synchronized: null }, issues: [] };
    }
  }

  async checkUptime() {
    try {
      const output = await this.runSSHCommand('uptime -s');
      const bootTime = new Date(output.trim());
      const days = Math.floor((Date.now() - bootTime.getTime()) / (1000 * 60 * 60 * 24));

      return {
        name: 'uptime',
        status: 'ok',
        data: { bootTime: bootTime.toISOString(), days },
        issues: []
      };
    } catch {
      return { name: 'uptime', status: 'ok', data: { days: 0 }, issues: [] };
    }
  }

  async checkTemperature(config) {
    let status = 'ok';
    const issues = [];
    const data = { temps: [] };

    try {
      // Try sensors first, then thermal zones
      let output;
      try {
        output = await this.runSSHCommand('sensors 2>/dev/null | grep -oP "[+-]\\d+\\.\\d+°C" | head -5');
      } catch {
        output = '';
      }

      if (!output.trim()) {
        output = await this.runSSHCommand('cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null || echo ""');
        // thermal_zone temps are in millidegrees
        for (const line of output.trim().split('\n')) {
          const raw = parseInt(line.trim(), 10);
          if (!isNaN(raw) && raw > 0) {
            const tempC = raw / 1000;
            data.temps.push(tempC);
            if (tempC >= (config.warningTempC || 75)) {
              status = 'warning';
              issues.push(`Temperature: ${tempC}°C`);
            }
          }
        }
      } else {
        for (const match of output.matchAll(/[+-](\d+\.?\d*)/g)) {
          const tempC = parseFloat(match[1]);
          data.temps.push(tempC);
          if (tempC >= (config.warningTempC || 75)) {
            status = 'warning';
            issues.push(`Temperature: ${tempC}°C`);
          }
        }
      }
    } catch {
      // No temperature data available
    }

    return { name: 'temperature', status, data, issues };
  }

  // --- Monitored Application Services ---

  async checkMonitoredServices(config) {
    const apps = config.apps || [];
    const state = this.getState();
    const prevApps = state.monitoredApps || {};
    const isBaseline = !state.baselineRecorded;
    const data = {};
    let status = 'ok';
    const issues = [];
    const restartedApps = [];

    for (const app of apps) {
      const prev = prevApps[app.name] || {};
      const appState = {
        running: false,
        manuallyStopped: prev.manuallyStopped || false,
        version: prev.version || null,
        lastSeen: prev.lastSeen || null,
        error: null,
        extra: null
      };

      try {
        // Determine if service is running
        if (app.checkMethod === 'process') {
          appState.running = await this.isProcessRunning(app.processPattern);
        } else {
          // systemd check — try primary unit, then alternate units if defined
          let activeState = await this.getSystemdState(app.unit);
          if (activeState !== 'active' && app.altUnits) {
            for (const alt of app.altUnits) {
              activeState = await this.getSystemdState(alt);
              if (activeState === 'active') break;
            }
          }
          appState.running = activeState === 'active';
        }

        // ExpressVPN: also check connection status
        if (app.statusCmd) {
          try {
            const statusOutput = await this.runSSHCommand(`${app.statusCmd} 2>/dev/null || echo "unknown"`);
            const cleaned = statusOutput.replace(/\x1b\[[0-9;]*m/g, '').trim();
            appState.extra = cleaned;
            // If expressvpn daemon is active but not connected, flag it
            if (app.name === 'expressvpn' && appState.running && !cleaned.toLowerCase().includes('connected to') && !cleaned.toLowerCase().includes('not logged in')) {
              issues.push(`expressvpn: daemon running but not connected (${cleaned})`);
              if (status !== 'critical') status = 'warning';
            }
          } catch {
            // Non-fatal
          }
        }

        // Fetch version (throttled — only on first run or if we don't have one yet)
        if (!appState.version) {
          appState.version = await this.getAppVersion(app);
        }

        if (appState.running) {
          appState.lastSeen = new Date().toISOString();
          // If it was marked manually stopped but is now running, clear the flag
          if (appState.manuallyStopped) {
            appState.manuallyStopped = false;
            logger.info(`ServerMaintenanceAgent: ${app.name} was manually stopped but is now running again`);
          }
        } else if (!appState.running) {
          // Service is not running
          if (isBaseline) {
            // First check — just record the state, don't act
            logger.info(`ServerMaintenanceAgent: Baseline - ${app.name} is not running (recording as-is)`);
            appState.manuallyStopped = true;
          } else if (appState.manuallyStopped) {
            // Already known to be manually stopped — just note it
            logger.debug(`ServerMaintenanceAgent: ${app.name} still manually stopped, skipping`);
          } else if (prev.running) {
            // Was running last time, now it's not — determine cause
            const wasCleanStop = await this.wasCleanStop(app);
            if (wasCleanStop) {
              // Manual/clean stop — mark it, don't restart
              appState.manuallyStopped = true;
              issues.push(`${app.name}: manually stopped since last check`);
              if (status !== 'critical') status = 'warning';
              logger.info(`ServerMaintenanceAgent: ${app.name} was cleanly stopped — marking as manual`);
            } else {
              // Crash — auto-restart
              logger.warn(`ServerMaintenanceAgent: ${app.name} appears crashed — attempting restart`);
              const restarted = await this.restartApp(app);
              if (restarted) {
                appState.running = true;
                appState.lastSeen = new Date().toISOString();
                appState.error = null;
                restartedApps.push(app.name);
                issues.push(`${app.name}: crashed and auto-restarted`);
              } else {
                appState.error = 'Restart failed';
                status = 'critical';
                issues.push(`${app.name}: crashed, restart FAILED`);
              }
            }
          } else {
            // Was not running before either and not manually stopped — might have been missed
            // Treat as manually stopped to avoid unexpected starts
            appState.manuallyStopped = true;
          }
        }
      } catch (error) {
        const errMsg = error?.message || String(error);
        appState.error = errMsg;
        issues.push(`${app.name}: check error — ${errMsg}`);
        if (status !== 'critical') status = 'warning';
        logger.warn(`ServerMaintenanceAgent: ${app.name} check threw: ${errMsg}`);
      }

      data[app.name] = appState;
    }

    // Debug: log which apps made it into data vs configured
    const configuredNames = apps.map(a => a.name);
    const dataNames = Object.keys(data);
    if (dataNames.length !== configuredNames.length) {
      const missing = configuredNames.filter(n => !dataNames.includes(n));
      logger.warn(`ServerMaintenanceAgent: monitoredApps mismatch — configured ${configuredNames.length} but data has ${dataNames.length}. Missing: ${missing.join(', ')}`);
    }

    // Log restarts
    if (restartedApps.length > 0) {
      await this.log('service_auto_restart', { restarted: restartedApps });
    }

    return { name: 'monitoredApps', status, data, issues };
  }

  async isProcessRunning(pattern) {
    try {
      const output = await this.runSSHCommand(`pgrep -f "${pattern}" >/dev/null 2>&1 && echo running || echo stopped`);
      return output.trim() === 'running';
    } catch {
      return false;
    }
  }

  async getSystemdState(unit) {
    try {
      const output = await this.runSSHCommand(`systemctl is-active ${unit} 2>/dev/null || echo inactive`);
      return output.trim();
    } catch {
      return 'unknown';
    }
  }

  async wasCleanStop(app) {
    // For process-based checks, we can't easily tell — assume crash
    if (app.checkMethod === 'process') return false;

    try {
      // Check systemd Result field: "success" = clean stop, anything else = crash/failure
      const output = await this.runSSHCommand(
        `systemctl show -p Result ${app.unit} --value 2>/dev/null || echo unknown`
      );
      const result = output.trim();
      return result === 'success';
    } catch {
      return false;
    }
  }

  async restartApp(app) {
    // VPN pre-check: refuse to restart VPN-dependent services if VPN is not connected
    if (app.requiresVpn) {
      try {
        const vpnState = await this.runSSHCommand(`systemctl is-active expressvpn-service 2>/dev/null || systemctl is-active expressvpn 2>/dev/null || echo inactive`);
        if (vpnState.trim() !== 'active') {
          logger.warn(`ServerMaintenanceAgent: Refusing to restart ${app.name} — expressvpn service is not active`);
          return false;
        }
        const vpnStatus = await this.runSSHCommand(`expressvpnctl status 2>/dev/null || expressvpn status 2>/dev/null || echo "unknown"`);
        const cleaned = vpnStatus.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (!cleaned.toLowerCase().includes('connected to')) {
          logger.warn(`ServerMaintenanceAgent: Refusing to restart ${app.name} — VPN not connected (${cleaned})`);
          return false;
        }
        logger.info(`ServerMaintenanceAgent: VPN connected, proceeding with ${app.name} restart`);
      } catch (error) {
        logger.warn(`ServerMaintenanceAgent: Refusing to restart ${app.name} — VPN check failed: ${error.message}`);
        return false;
      }
    }

    const cmd = app.restartCmd || `systemctl restart ${app.unit}`;
    try {
      await this.runSSHCommand(`${cmd} 2>&1`);
      // Verify it came back
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (app.checkMethod === 'process') {
        return await this.isProcessRunning(app.processPattern);
      } else {
        const state = await this.getSystemdState(app.unit);
        return state === 'active';
      }
    } catch (error) {
      logger.error(`ServerMaintenanceAgent: Failed to restart ${app.name}:`, error.message);
      return false;
    }
  }

  async getAppVersion(app) {
    try {
      // For expressvpn: try expressvpnctl first (newer CLI), fall back to legacy
      if (app.name === 'expressvpn') {
        const ctlVer = await this.runSSHCommand('expressvpnctl --version 2>/dev/null || echo ""');
        if (ctlVer.trim()) return ctlVer.trim();
      }

      // Try dpkg (works for jellyfin, calibre, sonarr, etc.)
      const output = await this.runSSHCommand(
        `dpkg -l ${app.name} 2>/dev/null | awk '/^ii/{print $3}' || echo ""`
      );
      const ver = output.trim();
      if (ver) return ver;

      // For *arr apps: read API key from config.xml and query local API
      if (['radarr', 'sonarr', 'lidarr', 'readarr', 'prowlarr'].includes(app.name) && app.port) {
        const apiVer = ['lidarr', 'readarr', 'prowlarr'].includes(app.name) ? 'v1' : 'v3';
        const apiKeyOut = await this.runSSHCommand(
          `sed -n 's/.*<ApiKey>\\(.*\\)<\\/ApiKey>.*/\\1/p' /var/lib/${app.name}/config.xml 2>/dev/null || echo ""`
        );
        const apiKey = apiKeyOut.trim();
        if (apiKey) {
          const jsonOut = await this.runSSHCommand(
            `curl -sf http://localhost:${app.port}/api/${apiVer}/system/status?apikey=${apiKey} 2>/dev/null || echo "{}"`
          );
          try {
            const parsed = JSON.parse(jsonOut.trim());
            if (parsed.version) return parsed.version;
          } catch {
            // Failed to parse, skip
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // --- Cleanup ---

  async performAutoCleanup(config) {
    const cleanup = config.autoCleanup || {};
    const results = [];

    try {
      if (cleanup.journalctl) {
        const output = await this.runSSHCommand('journalctl --vacuum-time=7d 2>&1 | tail -1');
        results.push(`journal: ${output.trim()}`);
      }
    } catch (e) {
      results.push(`journal: error - ${e.message}`);
    }

    try {
      if (cleanup.aptCache) {
        await this.runSSHCommand('apt-get autoclean -y 2>&1 | tail -1');
        results.push('apt autoclean: done');
      }
    } catch (e) {
      results.push(`apt autoclean: error - ${e.message}`);
    }

    try {
      if (cleanup.tmpFiles) {
        const output = await this.runSSHCommand('find /tmp -type f -atime +7 -delete 2>/dev/null; echo "done"');
        results.push(`tmp cleanup: ${output.trim()}`);
      }
    } catch (e) {
      results.push(`tmp cleanup: error - ${e.message}`);
    }

    logger.info(`ServerMaintenanceAgent: Auto-cleanup: ${results.join(', ')}`);
    return results;
  }

  // --- Approvals ---

  async queueApprovals(config) {
    const approvalRequired = config.approvalRequired || [];

    // Queue apt upgrade if many updates pending
    if (approvalRequired.includes('apt_upgrade') && this.checkResults.updates?.data?.count > 10) {
      const count = this.checkResults.updates.data.count;
      await this.requestApproval(
        'apt_upgrade',
        `${count} apt updates available on ${config.hostname}. Run apt-get upgrade?`,
        { updateCount: count }
      );
      logger.info(`ServerMaintenanceAgent: Queued approval for apt_upgrade (${count} updates)`);
    }

    // Queue service restart if any watched service is down
    if (approvalRequired.includes('service_restart') && this.checkResults.services) {
      const down = Object.entries(this.checkResults.services.data || {})
        .filter(([, status]) => status !== 'active');
      for (const [svc, status] of down) {
        await this.requestApproval(
          'service_restart',
          `Service ${svc} is ${status} on ${config.hostname}. Restart it?`,
          { service: svc, currentStatus: status }
        );
        logger.info(`ServerMaintenanceAgent: Queued approval for service_restart: ${svc}`);
      }
    }

    // Queue docker prune if configured
    if (approvalRequired.includes('docker_prune') && config.autoCleanup?.dockerPrune) {
      await this.requestApproval(
        'docker_prune',
        `Run docker system prune on ${config.hostname}?`,
        {}
      );
    }
  }

  async onApproved(approval) {
    const action = approval.action;
    const data = approval.data || {};
    const config = this.getConfig();
    const hostname = config.hostname || 'goliath';

    logger.info(`ServerMaintenanceAgent: Executing approved action: ${action}`);

    try {
      const connected = await this.connectSSH();
      if (!connected) {
        logger.error('ServerMaintenanceAgent: Cannot execute approved action - SSH connection failed');
        return;
      }

      let output;
      switch (action) {
        case 'apt_upgrade':
          output = await this.runSSHCommand('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1 | tail -5');
          await this.sendTelegramAlert(`*${hostname}*: apt upgrade completed.\n\`\`\`\n${output}\n\`\`\``);
          break;

        case 'service_restart':
          output = await this.runSSHCommand(`systemctl restart ${data.service} && systemctl is-active ${data.service}`);
          await this.sendTelegramAlert(`*${hostname}*: Restarted service \`${data.service}\` — now ${output.trim()}`);
          break;

        case 'reboot':
          await this.sendTelegramAlert(`*${hostname}*: Reboot initiated by approved action.`);
          await this.runSSHCommand('reboot');
          break;

        case 'docker_prune':
          output = await this.runSSHCommand('docker system prune -af 2>&1 | tail -5');
          await this.sendTelegramAlert(`*${hostname}*: Docker prune completed.\n\`\`\`\n${output}\n\`\`\``);
          break;

        default:
          logger.warn(`ServerMaintenanceAgent: Unknown approved action: ${action}`);
      }

      await this.disconnectSSH();
      await this.log('approved_action', { action, data, success: true });

    } catch (error) {
      logger.error(`ServerMaintenanceAgent: Approved action ${action} failed:`, error);
      await this.sendTelegramAlert(`*${hostname}*: Approved action \`${action}\` failed: ${error.message}`);
      await this.disconnectSSH();
    }
  }

  // --- Analysis & Alerts ---

  analyzeResults(checkReport) {
    const alerts = [];
    for (const check of checkReport) {
      if (check.status === 'warning' || check.status === 'critical') {
        for (const issue of (check.issues || [])) {
          alerts.push({ check: check.name, severity: check.status, message: issue });
        }
      }
    }
    return alerts;
  }

  buildAlertMessage(checkReport, alerts, cleanupResult) {
    const config = this.getConfig();
    const hostname = config.hostname || 'goliath';
    const lines = [`*Server Maintenance Report: ${hostname}*\n`];

    // Issues first
    for (const alert of alerts) {
      const icon = alert.severity === 'critical' ? '❌' : '⚠️';
      lines.push(`${icon} *${alert.check}*: ${alert.message}`);
    }

    // Summary of OK checks
    const okChecks = checkReport.filter(c => c.status === 'ok').map(c => c.name);
    if (okChecks.length > 0) {
      lines.push(`\n✅ OK: ${okChecks.join(', ')}`);
    }

    // Uptime
    const upDays = this.checkResults.uptime?.data?.days;
    if (upDays !== undefined) {
      lines.push(`⏱ Uptime: ${upDays} day(s)`);
    }

    // Monitored apps summary
    const appData = this.checkResults.monitoredApps?.data;
    if (appData) {
      const running = Object.entries(appData).filter(([, a]) => a.running);
      const stopped = Object.entries(appData).filter(([, a]) => !a.running && a.manuallyStopped);
      const failed = Object.entries(appData).filter(([, a]) => !a.running && !a.manuallyStopped);

      if (failed.length > 0) {
        lines.push(`\n🔴 Down: ${failed.map(([n]) => n).join(', ')}`);
      }
      if (stopped.length > 0) {
        lines.push(`⏸ Stopped: ${stopped.map(([n]) => n).join(', ')}`);
      }
      lines.push(`🟢 Running: ${running.length}/${Object.keys(appData).length} apps`);

      // ExpressVPN connection info
      const vpn = appData.expressvpn;
      if (vpn?.extra && vpn.running) {
        const connMatch = vpn.extra.match(/Connected to (.+)/i);
        if (connMatch) lines.push(`🔒 VPN: ${connMatch[1]}`);
      }
    }

    // Cleanup
    if (cleanupResult && cleanupResult.length > 0) {
      lines.push(`\n🧹 Cleanup: ${cleanupResult.length} task(s) run`);
    }

    return lines.join('\n');
  }

  async sendTelegramAlert(message) {
    try {
      const telegram = this.mainAgent?.interfaces?.get('telegram');
      if (telegram) {
        await telegram.sendNotification(message, { parse_mode: 'Markdown' });
        logger.info('ServerMaintenanceAgent: Telegram alert sent');
      } else {
        logger.debug('ServerMaintenanceAgent: Telegram interface not available');
      }
    } catch (error) {
      logger.error('ServerMaintenanceAgent: Failed to send Telegram alert:', error.message);
    }
  }

  async handleConnectionFailure() {
    const state = this.getState();
    const failures = (state.consecutiveFailures || 0) + 1;

    await this.updateState({
      lastCheck: new Date().toISOString(),
      consecutiveFailures: failures
    });

    if (failures >= 3) {
      const config = this.getConfig();
      await this.sendTelegramAlert(
        `*${config.hostname || 'goliath'} UNREACHABLE*\n\n` +
        `Failed to connect via SSH for ${failures} consecutive attempts.\n` +
        `Host: ${config.targetHost}`
      );
    }

    await this.log('connection_failure', { consecutiveFailures: failures });
  }
  /**
   * Dynamic intent generation for vector intent system.
   * Returns intents based on configured hostname and monitored apps.
   */
  getIntents() {
    const config = this.getConfig();
    const hostname = config.hostname || 'server';
    const apps = config.monitoredServices?.apps || [];
    const intents = [];

    // General server management intents
    intents.push({
      id: `maintenance_status_${hostname}`,
      name: `${hostname}ServerStatus`,
      description: `Check the status of the ${hostname} server — disk, memory, services, updates`,
      plugin: '_subagent',
      action: 'maintenance_status',
      category: 'system',
      examples: [
        `check ${hostname} status`,
        `how is ${hostname} doing`,
        `${hostname} server health`,
        `is ${hostname} running ok`
      ]
    });

    intents.push({
      id: `maintenance_update_${hostname}`,
      name: `${hostname}AptUpdate`,
      description: `Run apt update and upgrade on the ${hostname} server`,
      plugin: '_subagent',
      action: 'maintenance_apt_upgrade',
      category: 'system',
      examples: [
        `update ${hostname}`,
        `upgrade ${hostname} server`,
        `run apt upgrade on ${hostname}`,
        `install updates on ${hostname}`
      ]
    });

    // Per-app intents
    for (const app of apps) {
      intents.push({
        id: `maintenance_update_${hostname}_${app.name}`,
        name: `${hostname}Update${app.name}`,
        description: `Update or upgrade ${app.name} on the ${hostname} server`,
        plugin: '_subagent',
        action: 'maintenance_update_app',
        category: 'system',
        examples: [
          `update ${app.name} on ${hostname}`,
          `upgrade ${app.name} on the ${hostname} server`,
          `can you update ${app.name} on ${hostname}`,
          `install latest ${app.name} on ${hostname}`
        ],
        params: { appName: app.name, hostname }
      });

      intents.push({
        id: `maintenance_restart_${hostname}_${app.name}`,
        name: `${hostname}Restart${app.name}`,
        description: `Restart the ${app.name} service on the ${hostname} server`,
        plugin: '_subagent',
        action: 'maintenance_restart_app',
        category: 'system',
        examples: [
          `restart ${app.name} on ${hostname}`,
          `reboot ${app.name} on the ${hostname} server`
        ],
        params: { appName: app.name, hostname }
      });

      intents.push({
        id: `maintenance_check_${hostname}_${app.name}`,
        name: `${hostname}Check${app.name}`,
        description: `Check the status and version of ${app.name} on the ${hostname} server`,
        plugin: '_subagent',
        action: 'maintenance_check_app',
        category: 'system',
        examples: [
          `check ${app.name} on ${hostname}`,
          `is ${app.name} running on ${hostname}`,
          `${app.name} status on ${hostname}`
        ],
        params: { appName: app.name, hostname }
      });
    }

    return intents;
  }

  /**
   * Handle a specific command routed from the intent system.
   * @param {string} action - The action to perform
   * @param {object} params - Parameters including appName, hostname
   * @returns {object} - { success, message }
   */
  async handleCommand(action, params = {}) {
    const config = this.getConfig();
    const hostname = config.hostname || 'server';
    const apps = config.monitoredServices?.apps || [];

    try {
      const connected = await this.connectSSH();
      if (!connected) {
        return { success: false, message: `Cannot connect to ${hostname} via SSH` };
      }

      let output, app;

      switch (action) {
        case 'maintenance_status': {
          const uptime = await this.runSSHCommand('uptime -p');
          const disk = await this.runSSHCommand('df -h / | tail -1');
          const mem = await this.runSSHCommand('free -h | head -2');
          const updates = await this.runSSHCommand('apt list --upgradable 2>/dev/null | grep -c upgradable || echo 0');
          await this.disconnectSSH();
          return {
            success: true,
            message: `**${hostname} Status**\nUptime: ${uptime.trim()}\nDisk: ${disk.trim()}\nMemory:\n\`\`\`\n${mem.trim()}\n\`\`\`\nPending updates: ${updates.trim()}`
          };
        }

        case 'maintenance_apt_upgrade':
          output = await this.runSSHCommand('apt-get update -qq 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1 | tail -10');
          await this.disconnectSSH();
          return { success: true, message: `**${hostname}** apt upgrade completed:\n\`\`\`\n${output.trim()}\n\`\`\`` };

        case 'maintenance_update_app': {
          app = apps.find(a => a.name.toLowerCase() === (params.appName || '').toLowerCase());
          if (!app) {
            await this.disconnectSSH();
            return { success: false, message: `App "${params.appName}" not found on ${hostname}. Available: ${apps.map(a => a.name).join(', ')}` };
          }

          // Check current status first
          let preStatusCmd = app.statusCmd || `systemctl is-active ${app.unit} 2>/dev/null || echo inactive`;
          if (app.name === 'expressvpn') {
            preStatusCmd = 'expressvpnctl status 2>/dev/null || expressvpn status 2>/dev/null || echo unknown';
          }
          const preStatus = await this.runSSHCommand(preStatusCmd).catch(() => 'unknown');
          const preVersion = await this.getAppVersion(app) || 'unknown';

          // Check if the app reports a new version available
          // For expressvpn: use expressvpnctl if available (new CLI), ignore legacy binary
          let appStatusCmd = `${app.name} status 2>/dev/null || echo ""`;
          if (app.name === 'expressvpn') {
            appStatusCmd = `expressvpnctl status 2>/dev/null || expressvpn status 2>/dev/null || echo ""`;
          }
          const appStatus = await this.runSSHCommand(appStatusCmd).catch(() => '');
          const cleanStatus = appStatus.replace(/\x1b\[[0-9;]*m/g, '').trim();
          const newVersionAvailable = /new version.*available|update.*available|download.*latest/i.test(cleanStatus);

          let updateOutput;
          if (newVersionAvailable) {
            // App has its own update notification — can't auto-update standalone packages
            // Report the situation clearly instead of pretending apt worked
            updateOutput = `${app.name} reports a new version is available but it requires manual download.\n` +
              `Current version: ${preVersion}\n` +
              `Status: ${cleanStatus}\n` +
              `This app is installed from a standalone .deb package, not apt.`;
            await this.disconnectSSH();
            return {
              success: false,
              message: `**${hostname}**: ${app.name} needs manual update\n\`\`\`\n${updateOutput}\n\`\`\``
            };
          }

          // Try apt update for the specific package
          output = await this.runSSHCommand(`apt-get update -qq 2>&1 && apt-get install --only-upgrade -y ${app.name} 2>&1 | tail -10`);

          // Check if apt actually upgraded anything
          const upgraded = /upgraded|newly installed|Unpacking/.test(output);
          if (upgraded) {
            // Restart the service after a real update
            const rstCmd = app.restartCmd || `systemctl restart ${app.unit}`;
            await this.runSSHCommand(`${rstCmd} 2>&1`).catch(() => {});
          }

          const postVersion = await this.getAppVersion(app) || 'unknown';
          let postStatusCmd = app.statusCmd || `systemctl is-active ${app.unit} 2>/dev/null || echo inactive`;
          if (app.name === 'expressvpn') {
            postStatusCmd = 'expressvpnctl status 2>/dev/null || expressvpn status 2>/dev/null || echo unknown';
          }
          const postStatus = await this.runSSHCommand(postStatusCmd).catch(() => 'unknown');

          await this.disconnectSSH();
          const statusLine = `Status: ${postStatus.replace(/\x1b\[[0-9;]*m/g, '').trim()}`;
          if (upgraded) {
            return { success: true, message: `**${hostname}**: Updated ${app.name} (${preVersion} → ${postVersion})\n${statusLine}` };
          }
          return { success: true, message: `**${hostname}**: ${app.name} is already up to date (${postVersion})\n${statusLine}` };
        }

        case 'maintenance_restart_app':
          app = apps.find(a => a.name.toLowerCase() === (params.appName || '').toLowerCase());
          if (!app) {
            await this.disconnectSSH();
            return { success: false, message: `App "${params.appName}" not found on ${hostname}` };
          }
          const restarted = await this.restartApp(app);
          await this.disconnectSSH();
          return { success: restarted, message: restarted ? `Restarted ${app.name} on ${hostname}` : `Failed to restart ${app.name} on ${hostname}` };

        case 'maintenance_check_app': {
          app = apps.find(a => a.name.toLowerCase() === (params.appName || '').toLowerCase());
          if (!app) {
            await this.disconnectSSH();
            return { success: false, message: `App "${params.appName}" not found on ${hostname}` };
          }
          const chkVersion = await this.getAppVersion(app) || 'unknown';
          // For expressvpn: check both service and connection status
          let chkStatus;
          if (app.name === 'expressvpn') {
            const svcState = await this.runSSHCommand('systemctl is-active expressvpn-service 2>/dev/null || systemctl is-active expressvpn 2>/dev/null || echo inactive');
            const connState = await this.runSSHCommand('expressvpnctl status 2>/dev/null || expressvpn status 2>/dev/null || echo unknown');
            chkStatus = `service: ${svcState.trim()}, ${connState.replace(/\x1b\[[0-9;]*m/g, '').trim()}`;
          } else {
            chkStatus = await this.runSSHCommand(`systemctl is-active ${app.unit} 2>/dev/null || echo inactive`);
            chkStatus = chkStatus.trim();
          }
          await this.disconnectSSH();
          return { success: true, message: `**${app.name}** on ${hostname}: ${chkStatus}, version: ${chkVersion}` };
        }

        case 'maintenance_run_command':
          if (!params.command) {
            await this.disconnectSSH();
            return { success: false, message: 'No command specified' };
          }
          output = await this.runSSHCommand(params.command);
          await this.disconnectSSH();
          return { success: true, message: `**${hostname}**:\n\`\`\`\n${output.trim()}\n\`\`\`` };

        default:
          await this.disconnectSSH();
          return { success: false, message: `Unknown maintenance action: ${action}` };
      }
    } catch (error) {
      try { await this.disconnectSSH(); } catch {}
      return { success: false, message: `${hostname} maintenance error: ${error.message}` };
    }
  }
}

export default ServerMaintenanceAgent;
