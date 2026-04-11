import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const execAsync = promisify(exec);

const DEFAULT_CONFIG = {
  primaryLocation: process.env.DEPLOY_PATH || '/root/lanagent-deploy',
  localBackupPath: process.env.BACKUP_PATH || '/root/lanagent-backups',
  secondaryBackupPath: process.env.BACKUP_SECONDARY_PATH || '',
  offsiteBackupPath: '',
  encryptionEnabled: false,
  maxBackups: 10,
  schedule: '0 1 * * *', // daily at 1 AM
  retentionDays: 30,
  criticalPaths: ['src/', 'config/', 'data/', 'docs/', '.env', 'package.json', 'ecosystem.config.cjs'],
  excludePaths: ['node_modules/', 'logs/', 'tmp/', '.git/', '*.log', '*.tmp', 'data/lancedb/']
};

export class BackupStrategyPlugin extends BasePlugin {
  constructor() {
    super();
    this.name = 'backupStrategy';
    this.version = '2.0.0';
    this.description = 'Automated backup system with encryption, verification, and scheduling';
    this.config = { ...DEFAULT_CONFIG };
    this.backupInProgress = false;
  }

  async initialize() {
    try {
      await this._loadConfig();
      await this._ensureDirs();
      await this._importHistory();
      logger.info('Backup Strategy Plugin initialized (v2)');
      return true;
    } catch (error) {
      logger.error('Backup Strategy init failed:', error);
      return false;
    }
  }

  // ── Persistence ──

  async _getPS() {
    const { PluginSettings } = await import('../../models/PluginSettings.js');
    return PluginSettings;
  }

  async _loadConfig() {
    try {
      const PS = await this._getPS();
      const saved = await PS.getCached(this.name, 'config');
      if (saved && typeof saved === 'object') Object.assign(this.config, saved);
    } catch {}
  }

  async _saveConfig() {
    const PS = await this._getPS();
    await PS.setCached(this.name, 'config', this.config);
  }

  async _loadHistory() {
    try {
      const PS = await this._getPS();
      const saved = await PS.getCached(this.name, 'backupHistory');
      return Array.isArray(saved) ? saved : [];
    } catch { return []; }
  }

  async _saveHistory(history) {
    const PS = await this._getPS();
    await PS.setCached(this.name, 'backupHistory', history);
  }

  async _importHistory() {
    // On first run, scan existing backup dirs and import into DB
    const history = await this._loadHistory();
    if (history.length > 0) return;
    const imported = [];
    for (const dir of [this.config.localBackupPath, this.config.secondaryBackupPath].filter(Boolean)) {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          if (!entry.startsWith('lanagent-') || (!entry.endsWith('.tar.gz') && !entry.endsWith('.tar.gz.enc'))) continue;
          const fullPath = path.join(dir, entry);
          const stat = await fs.stat(fullPath);
          imported.push({
            backupName: entry.replace(/\.tar\.gz(\.enc)?$/, ''),
            type: entry.includes('incremental') ? 'incremental' : 'full',
            timestamp: stat.mtime.toISOString(),
            size: stat.size,
            location: dir,
            filePath: fullPath,
            encrypted: entry.endsWith('.enc'),
            verified: false,
            status: 'imported'
          });
        }
      } catch {}
    }
    if (imported.length) {
      imported.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      await this._saveHistory(imported);
      logger.info(`Imported ${imported.length} existing backups into DB`);
    }
  }

  async _ensureDirs() {
    for (const dir of [this.config.localBackupPath, this.config.secondaryBackupPath].filter(Boolean)) {
      try { await fs.mkdir(dir, { recursive: true }); } catch {}
    }
  }

  // ── Core Operations ──

  async execute(params) {
    const { action, ...args } = params;
    switch (action) {
      case 'createFullBackup': return await this.createFullBackup(args);
      case 'createIncrementalBackup': return await this.createIncrementalBackup(args);
      case 'verifyBackups': return await this.verifyBackups(args);
      case 'listBackups': return await this.listBackups();
      case 'cleanupOldBackups': return await this.cleanupOldBackups(args);
      case 'generateBackupReport': return await this.generateBackupReport(args);
      case 'restoreFromBackup': return await this.restoreFromBackup(args);
      default: throw new Error(`Unknown action: ${action}`);
    }
  }

  async createFullBackup({ location = null, encrypt = null } = {}) {
    if (this.backupInProgress) return { success: false, error: 'Backup already in progress' };
    this.backupInProgress = true;
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `lanagent-full-${timestamp}`;
      const backupDir = location || this.config.localBackupPath;
      await fs.mkdir(backupDir, { recursive: true });
      const archivePath = path.join(backupDir, `${backupName}.tar.gz`);

      logger.info(`Creating full backup: ${backupName}`);
      const startTime = Date.now();

      // Build tar command
      const includes = [];
      for (const p of this.config.criticalPaths) {
        const full = path.join(this.config.primaryLocation, p);
        try { await fs.access(full); includes.push(`"${full}"`); } catch {}
      }
      if (!includes.length) throw new Error('No critical paths accessible');

      const excludes = this.config.excludePaths.map(p => `--exclude="${p}"`).join(' ');
      const cmd = `tar -czf "${archivePath}" ${excludes} ${includes.join(' ')} 2>/dev/null`;
      await execAsync(cmd, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });

      const stat = await fs.stat(archivePath);
      let checksum = null;
      try { checksum = (await execAsync(`sha256sum "${archivePath}"`)).stdout.split(' ')[0]; } catch {}

      // Encrypt if enabled
      const shouldEncrypt = encrypt !== null ? encrypt : this.config.encryptionEnabled;
      let finalPath = archivePath;
      if (shouldEncrypt) {
        finalPath = await this._encrypt(archivePath);
      }

      const entry = {
        backupName, type: 'full',
        timestamp: new Date().toISOString(),
        size: (await fs.stat(finalPath)).size,
        checksum, location: backupDir, filePath: finalPath,
        encrypted: shouldEncrypt, verified: false,
        status: 'completed', duration: Date.now() - startTime
      };

      // Persist
      const history = await this._loadHistory();
      history.unshift(entry);
      await this._saveHistory(history);
      await this._enforceLimit();

      // Copy to secondary if configured
      if (this.config.secondaryBackupPath && this.config.secondaryBackupPath !== backupDir) {
        try {
          await fs.mkdir(this.config.secondaryBackupPath, { recursive: true });
          const secPath = path.join(this.config.secondaryBackupPath, path.basename(finalPath));
          await fs.copyFile(finalPath, secPath);
          logger.info(`Secondary copy: ${secPath}`);
        } catch (e) { logger.warn(`Secondary backup copy failed: ${e.message}`); }
      }

      // Rsync to offsite if configured
      if (this.config.offsiteBackupPath) {
        try {
          await execAsync(`rsync -az "${finalPath}" "${this.config.offsiteBackupPath}/"`, { timeout: 120000 });
          logger.info(`Offsite copy: ${this.config.offsiteBackupPath}`);
        } catch (e) { logger.warn(`Offsite backup failed: ${e.message}`); }
      }

      logger.info(`Backup completed: ${backupName} (${(entry.size / 1024 / 1024).toFixed(1)}MB in ${entry.duration}ms)`);
      return { success: true, backup: entry };
    } catch (error) {
      logger.error('Full backup failed:', error);
      return { success: false, error: error.message };
    } finally {
      this.backupInProgress = false;
    }
  }

  async createIncrementalBackup() {
    // Use rsync for incremental
    if (this.backupInProgress) return { success: false, error: 'Backup already in progress' };
    this.backupInProgress = true;
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `lanagent-incremental-${timestamp}`;
      const backupPath = path.join(this.config.localBackupPath, backupName);
      const startTime = Date.now();

      await execAsync(`rsync -a --delete "${this.config.primaryLocation}/" "${backupPath}/" --exclude node_modules --exclude logs --exclude .git --exclude '*.log'`, { timeout: 300000 });

      const entry = {
        backupName, type: 'incremental',
        timestamp: new Date().toISOString(),
        size: 0, location: this.config.localBackupPath,
        filePath: backupPath, encrypted: false, verified: false,
        status: 'completed', duration: Date.now() - startTime
      };
      try { const { stdout } = await execAsync(`du -sb "${backupPath}"`); entry.size = parseInt(stdout); } catch {}

      const history = await this._loadHistory();
      history.unshift(entry);
      await this._saveHistory(history);
      await this._enforceLimit();

      return { success: true, backup: entry };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      this.backupInProgress = false;
    }
  }

  async verifyBackups({ backupName = null } = {}) {
    const history = await this._loadHistory();
    const toVerify = backupName ? history.filter(b => b.backupName === backupName) : history;
    const results = [];

    for (const backup of toVerify) {
      try {
        const filePath = backup.filePath;
        await fs.access(filePath);
        const stat = await fs.stat(filePath);

        let checksumValid = null;
        if (backup.checksum && !backup.encrypted) {
          const current = (await execAsync(`sha256sum "${filePath}"`)).stdout.split(' ')[0];
          checksumValid = current === backup.checksum;
        }

        let tarValid = null;
        if (filePath.endsWith('.tar.gz')) {
          try { await execAsync(`tar -tzf "${filePath}" > /dev/null 2>&1`); tarValid = true; } catch { tarValid = false; }
        }

        backup.verified = checksumValid !== false && tarValid !== false;
        backup.lastVerified = new Date().toISOString();
        results.push({ name: backup.backupName, valid: backup.verified, size: stat.size, checksumValid, tarValid });
      } catch (e) {
        backup.verified = false;
        results.push({ name: backup.backupName, valid: false, error: e.message });
      }
    }

    await this._saveHistory(history);
    const passed = results.filter(r => r.valid).length;
    return { success: true, results, summary: `${passed}/${results.length} passed` };
  }

  async listBackups() {
    const history = await this._loadHistory();
    return { success: true, backups: history };
  }

  async cleanupOldBackups({ dryRun = false } = {}) {
    const history = await this._loadHistory();
    const max = this.config.maxBackups || 10;
    if (history.length <= max) return { success: true, removed: 0, message: 'Within limit' };

    const sorted = [...history].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const toRemove = sorted.slice(max);
    const removed = [];

    for (const backup of toRemove) {
      if (!dryRun) {
        try { await fs.rm(backup.filePath, { recursive: true, force: true }); } catch {}
        try { await fs.rm(backup.filePath + '.metadata.json', { force: true }); } catch {}
      }
      removed.push(backup.backupName);
    }

    if (!dryRun) {
      await this._saveHistory(sorted.slice(0, max));
    }

    return { success: true, removed: removed.length, names: removed, dryRun };
  }

  async restoreFromBackup({ backupName, targetPath }) {
    if (!backupName) return { success: false, error: 'backupName required' };
    const history = await this._loadHistory();
    const backup = history.find(b => b.backupName === backupName);
    if (!backup) return { success: false, error: 'Backup not found' };

    const target = targetPath || '/tmp/lanagent-restore-' + Date.now();
    await fs.mkdir(target, { recursive: true });

    let archivePath = backup.filePath;
    if (backup.encrypted) {
      archivePath = await this._decrypt(backup.filePath, backup.filePath.replace('.enc', ''));
    }

    if (archivePath.endsWith('.tar.gz')) {
      await execAsync(`tar -xzf "${archivePath}" -C "${target}"`, { timeout: 300000 });
    }

    return { success: true, restoredTo: target, backup: backup.backupName };
  }

  async generateBackupReport() {
    const history = await this._loadHistory();
    const totalSize = history.reduce((s, b) => s + (b.size || 0), 0);
    const lastFull = history.find(b => b.type === 'full');
    const hoursSinceLast = lastFull ? (Date.now() - new Date(lastFull.timestamp)) / 3600000 : Infinity;

    let health = 'healthy';
    if (hoursSinceLast > 72) health = 'critical';
    else if (hoursSinceLast > 48) health = 'warning';

    return {
      success: true,
      report: {
        health, totalBackups: history.length,
        totalSize, totalSizeFormatted: this._fmtBytes(totalSize),
        lastBackup: lastFull?.timestamp || null,
        hoursSinceLastBackup: Math.round(hoursSinceLast),
        config: this.config,
        locations: {
          primary: this.config.localBackupPath,
          secondary: this.config.secondaryBackupPath || 'not configured',
          offsite: this.config.offsiteBackupPath || 'not configured'
        }
      }
    };
  }

  async _enforceLimit() {
    const history = await this._loadHistory();
    const max = this.config.maxBackups || 10;
    if (history.length <= max) return;
    const sorted = [...history].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const toRemove = sorted.slice(max);
    for (const b of toRemove) {
      try { await fs.rm(b.filePath, { recursive: true, force: true }); } catch {}
      logger.info(`Cleaned old backup: ${b.backupName}`);
    }
    await this._saveHistory(sorted.slice(0, max));
  }

  // ── Encryption ──

  async _encrypt(filePath) {
    const key = process.env.BACKUP_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('No BACKUP_ENCRYPTION_KEY or ENCRYPTION_KEY in .env');
    const keyBuf = crypto.createHash('sha256').update(key).digest();
    const iv = crypto.randomBytes(16);
    const input = await fs.readFile(filePath);
    const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
    const encrypted = Buffer.concat([iv, cipher.update(input), cipher.final()]);
    const encPath = filePath + '.enc';
    await fs.writeFile(encPath, encrypted);
    await fs.unlink(filePath);
    return encPath;
  }

  async _decrypt(encPath, outPath) {
    const key = process.env.BACKUP_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('No encryption key configured');
    const keyBuf = crypto.createHash('sha256').update(key).digest();
    const data = await fs.readFile(encPath);
    const iv = data.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
    const decrypted = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
    await fs.writeFile(outPath, decrypted);
    return outPath;
  }

  // ── Utility ──

  _fmtBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  getStatus() {
    return {
      name: this.name, version: this.version, enabled: this.enabled,
      encryptionEnabled: this.config.encryptionEnabled,
      maxBackups: this.config.maxBackups,
      backupInProgress: this.backupInProgress
    };
  }

  // ── HTTP Routes ──

  getRoutes() {
    return [
      { method: 'GET', path: '/status', handler: async () => this.getStatus() },
      { method: 'GET', path: '/config', handler: async () => ({ success: true, config: this.config }) },
      { method: 'POST', path: '/config', handler: async (data) => {
        const allowed = ['localBackupPath','secondaryBackupPath','offsiteBackupPath','encryptionEnabled','maxBackups','schedule'];
        for (const k of allowed) { if (data[k] !== undefined) this.config[k] = data[k]; }
        if (typeof this.config.maxBackups === 'string') this.config.maxBackups = parseInt(this.config.maxBackups) || 10;
        if (typeof this.config.encryptionEnabled === 'string') this.config.encryptionEnabled = this.config.encryptionEnabled === 'true';
        await this._saveConfig();
        await this._ensureDirs();
        return { success: true, config: this.config };
      }},
      { method: 'GET', path: '/history', handler: async () => ({ success: true, backups: await this._loadHistory() }) },
      { method: 'POST', path: '/run', handler: async (data) => await this.createFullBackup(data || {}) },
      { method: 'POST', path: '/verify', handler: async (data) => await this.verifyBackups(data || {}) },
      { method: 'POST', path: '/cleanup', handler: async (data) => await this.cleanupOldBackups(data || {}) },
      { method: 'POST', path: '/restore', handler: async (data) => await this.restoreFromBackup(data || {}) },
      { method: 'GET', path: '/report', handler: async () => await this.generateBackupReport() },
      { method: 'POST', path: '/delete', handler: async (data) => {
        if (!data?.backupName) return { success: false, error: 'backupName required' };
        const history = await this._loadHistory();
        const idx = history.findIndex(b => b.backupName === data.backupName);
        if (idx === -1) return { success: false, error: 'Not found' };
        try { await fs.rm(history[idx].filePath, { recursive: true, force: true }); } catch {}
        history.splice(idx, 1);
        await this._saveHistory(history);
        return { success: true };
      }}
    ];
  }

  // ── Dynamic Web UI ──

  getUIConfig() {
    return {
      menuItem: { id: 'backupStrategy', title: 'Backups', icon: 'fas fa-shield-alt', order: 15, section: 'main' },
      hasUI: true
    };
  }

  getUIContent() {
    return `
<style>
  .bk-cards { display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px; }
  .bk-card { background:var(--bg-secondary);border-radius:10px;padding:14px;text-align:center; }
  .bk-card .val { font-size:22px;font-weight:700;color:var(--accent-color,#00a8ff); }
  .bk-card .lbl { font-size:11px;color:var(--text-muted);margin-top:4px; }
  .bk-section { background:var(--bg-secondary);border-radius:10px;padding:16px;margin-bottom:16px; }
  .bk-section h3 { font-size:14px;margin-bottom:12px; }
  .bk-row { display:flex;gap:8px;margin-bottom:8px;align-items:center; }
  .bk-row label { font-size:12px;color:var(--text-muted);min-width:120px; }
  .bk-row input[type=text], .bk-row input[type=number], .bk-row select { flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-color);font-size:12px; }
  .bk-row input[type=checkbox] { margin-right:6px; }
  .bk-actions { display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px; }
  .bk-table { width:100%;border-collapse:collapse;font-size:12px; }
  .bk-table th { text-align:left;padding:8px;color:var(--text-muted);border-bottom:1px solid var(--border-color);font-weight:600; }
  .bk-table td { padding:8px;border-bottom:1px solid rgba(255,255,255,0.05); }
  .bk-table tr:hover { background:rgba(255,255,255,0.03); }
  .bk-badge { padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600; }
  .bk-badge-ok { background:rgba(76,175,80,0.2);color:#4caf50; }
  .bk-badge-warn { background:rgba(255,152,0,0.2);color:#ff9800; }
  .bk-badge-err { background:rgba(244,67,54,0.2);color:#f44336; }
  .bk-badge-info { background:rgba(0,168,255,0.2);color:#00a8ff; }
  .bk-status-dot { width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px; }
</style>

<h2><i class="fas fa-shield-alt"></i> Backups</h2>
<p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Automated backup system with encryption, verification, and scheduling.</p>

<!-- Status Cards -->
<div class="bk-cards" id="bk-cards">
  <div class="bk-card"><div class="val" id="bk-health">—</div><div class="lbl">Health</div></div>
  <div class="bk-card"><div class="val" id="bk-total">—</div><div class="lbl">Total Backups</div></div>
  <div class="bk-card"><div class="val" id="bk-size">—</div><div class="lbl">Total Size</div></div>
  <div class="bk-card"><div class="val" id="bk-last">—</div><div class="lbl">Last Backup</div></div>
</div>

<!-- Actions -->
<div class="bk-actions">
  <button class="btn btn-primary" onclick="bkRunBackup()"><i class="fas fa-play"></i> Run Backup Now</button>
  <button class="btn btn-secondary" onclick="bkVerifyAll()"><i class="fas fa-check-double"></i> Verify All</button>
  <button class="btn btn-secondary" onclick="bkCleanup()"><i class="fas fa-broom"></i> Cleanup</button>
</div>

<!-- Configuration -->
<div class="bk-section">
  <h3><i class="fas fa-cog"></i> Configuration</h3>
  <div class="bk-row"><label>Primary Path</label><input type="text" id="bk-primary"></div>
  <div class="bk-row"><label>Secondary Path</label><input type="text" id="bk-secondary" placeholder="Optional — second copy location"></div>
  <div class="bk-row"><label>Offsite Path</label><input type="text" id="bk-offsite" placeholder="Optional — rsync destination (user@host:/path)"></div>
  <div class="bk-row"><label>Max Backups</label><input type="number" id="bk-max" min="1" max="999" value="10" style="max-width:80px;"></div>
  <div class="bk-row"><label>Schedule</label>
    <select id="bk-schedule">
      <option value="0 1 * * *">Daily at 1 AM</option>
      <option value="0 */6 * * *">Every 6 hours</option>
      <option value="0 */12 * * *">Every 12 hours</option>
      <option value="0 0 * * 0">Weekly (Sunday midnight)</option>
      <option value="">Manual only</option>
    </select>
  </div>
  <div class="bk-row"><label></label><label style="min-width:auto;"><input type="checkbox" id="bk-encrypt"> Encrypt backups (uses BACKUP_ENCRYPTION_KEY from .env)</label></div>
  <div style="margin-top:8px;"><button class="btn btn-primary btn-sm" onclick="bkSaveConfig()"><i class="fas fa-save"></i> Save Configuration</button></div>
</div>

<!-- Backup History -->
<div class="bk-section">
  <h3><i class="fas fa-history"></i> Backup History</h3>
  <div id="bk-history-container" style="overflow-x:auto;">
    <div style="text-align:center;padding:20px;color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading...</div>
  </div>
</div>

<script>
(async function() {
  const api = async (method, path, body) => {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + dashboard.token, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch('/api/backupStrategy' + path, opts);
    return res.json();
  };

  const fmtBytes = (b) => { if(!b)return '0 B'; const k=1024,s=['B','KB','MB','GB']; const i=Math.floor(Math.log(b)/Math.log(k)); return (b/Math.pow(k,i)).toFixed(1)+' '+s[i]; };
  const fmtDate = (d) => { if(!d)return '—'; const dt=new Date(d); return dt.toLocaleDateString()+' '+dt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); };
  const timeAgo = (d) => { if(!d)return 'never'; const h=Math.round((Date.now()-new Date(d))/3600000); if(h<1)return 'just now'; if(h<24)return h+'h ago'; return Math.round(h/24)+'d ago'; };

  async function loadReport() {
    const r = await api('GET', '/report');
    if (!r.success) return;
    const rp = r.report;
    document.getElementById('bk-health').innerHTML = '<span class="bk-status-dot" style="background:' + (rp.health==='healthy'?'#4caf50':rp.health==='warning'?'#ff9800':'#f44336') + '"></span>' + rp.health;
    document.getElementById('bk-total').textContent = rp.totalBackups;
    document.getElementById('bk-size').textContent = rp.totalSizeFormatted;
    document.getElementById('bk-last').textContent = timeAgo(rp.lastBackup);
  }

  async function loadConfig() {
    const r = await api('GET', '/config');
    if (!r.success) return;
    const c = r.config;
    document.getElementById('bk-primary').value = c.localBackupPath || '';
    document.getElementById('bk-secondary').value = c.secondaryBackupPath || '';
    document.getElementById('bk-offsite').value = c.offsiteBackupPath || '';
    document.getElementById('bk-max').value = c.maxBackups || 10;
    document.getElementById('bk-encrypt').checked = !!c.encryptionEnabled;
    const sel = document.getElementById('bk-schedule');
    for (const opt of sel.options) { if (opt.value === (c.schedule||'')) { opt.selected = true; break; } }
  }

  async function loadHistory() {
    const r = await api('GET', '/history');
    const container = document.getElementById('bk-history-container');
    if (!r.success || !r.backups?.length) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">No backups yet</div>';
      return;
    }
    let html = '<table class="bk-table"><thead><tr><th>Name</th><th>Type</th><th>Date</th><th>Size</th><th>Encrypted</th><th>Verified</th><th>Actions</th></tr></thead><tbody>';
    for (const b of r.backups) {
      const typeBadge = b.type === 'full' ? 'bk-badge-info' : 'bk-badge-warn';
      const verBadge = b.verified ? 'bk-badge-ok' : 'bk-badge-err';
      html += '<tr>' +
        '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + b.backupName + '">' + b.backupName + '</td>' +
        '<td><span class="bk-badge ' + typeBadge + '">' + b.type + '</span></td>' +
        '<td>' + fmtDate(b.timestamp) + '</td>' +
        '<td>' + fmtBytes(b.size) + '</td>' +
        '<td>' + (b.encrypted ? '<i class="fas fa-lock" style="color:#4caf50;"></i>' : '<i class="fas fa-lock-open" style="color:var(--text-muted);"></i>') + '</td>' +
        '<td><span class="bk-badge ' + verBadge + '">' + (b.verified ? 'yes' : 'no') + '</span></td>' +
        '<td><button class="btn btn-sm btn-secondary" onclick="bkVerifyOne(\\'' + b.backupName + '\\')"><i class="fas fa-check"></i></button> <button class="btn btn-sm btn-secondary" onclick="bkDeleteOne(\\'' + b.backupName + '\\')"><i class="fas fa-trash"></i></button></td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  window.bkRunBackup = async () => {
    dashboard.showNotification('Starting backup...', 'info');
    const r = await api('POST', '/run', {});
    if (r.success) {
      dashboard.showNotification('Backup completed: ' + fmtBytes(r.backup?.size), 'success');
      loadReport(); loadHistory();
    } else {
      dashboard.showNotification('Backup failed: ' + r.error, 'error');
    }
  };

  window.bkVerifyAll = async () => {
    dashboard.showNotification('Verifying backups...', 'info');
    const r = await api('POST', '/verify', {});
    if (r.success) { dashboard.showNotification('Verification: ' + r.summary, 'success'); loadHistory(); }
    else dashboard.showNotification('Verification failed', 'error');
  };

  window.bkVerifyOne = async (name) => {
    const r = await api('POST', '/verify', { backupName: name });
    if (r.success) { dashboard.showNotification('Verified: ' + r.summary, 'success'); loadHistory(); }
  };

  window.bkDeleteOne = async (name) => {
    if (!confirm('Delete backup ' + name + '?')) return;
    const r = await api('POST', '/delete', { backupName: name });
    if (r.success) { dashboard.showNotification('Deleted', 'success'); loadReport(); loadHistory(); }
  };

  window.bkCleanup = async () => {
    const r = await api('POST', '/cleanup', { dryRun: false });
    if (r.success) { dashboard.showNotification('Cleaned up ' + r.removed + ' backup(s)', 'success'); loadReport(); loadHistory(); }
  };

  window.bkSaveConfig = async () => {
    const r = await api('POST', '/config', {
      localBackupPath: document.getElementById('bk-primary').value.trim(),
      secondaryBackupPath: document.getElementById('bk-secondary').value.trim(),
      offsiteBackupPath: document.getElementById('bk-offsite').value.trim(),
      maxBackups: parseInt(document.getElementById('bk-max').value) || 10,
      encryptionEnabled: document.getElementById('bk-encrypt').checked,
      schedule: document.getElementById('bk-schedule').value
    });
    if (r.success) dashboard.showNotification('Backup config saved', 'success');
    else dashboard.showNotification('Failed: ' + r.error, 'error');
  };

  await loadReport();
  await loadConfig();
  await loadHistory();
})();
</script>
    `;
  }
}

export default BackupStrategyPlugin;
