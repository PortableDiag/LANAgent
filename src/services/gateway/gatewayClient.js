/**
 * Gateway Client — self-onboarding to api.lanagent.net
 *
 * On first boot (and idempotently on every restart), this service:
 *   1. Ensures a WireGuard keypair exists at data/wireguard/
 *   2. Signs a registration payload with the agent's P2P Ed25519 identity
 *   3. POSTs to https://api.lanagent.net/agents/register
 *   4. If the gateway responds in TUNNEL mode, writes /etc/wireguard/wg0.conf
 *      and brings up wg-quick@wg0 (idempotent: replaces an existing peer
 *      block for the same fingerprint).
 *
 * The gateway probes the agent's serviceUrl first; if it's publicly
 * reachable, DIRECT mode is used and no tunnel is established.
 *
 * No admin key. Auth is the Ed25519 signature on the payload, verified by
 * the gateway against the public key (and fingerprint) the agent sends.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile as _execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { cryptoManager } from '../p2p/cryptoManager.js';

const execFile = promisify(_execFile);

const GATEWAY_URL = (process.env.GATEWAY_URL || 'https://api.lanagent.net').replace(/\/+$/, '');
const WG_DIR = path.join(process.cwd(), 'data', 'wireguard');
const WG_PRIV_PATH = path.join(WG_DIR, 'private.key');
const WG_PUB_PATH = path.join(WG_DIR, 'public.key');
const WG_CONF_PATH = '/etc/wireguard/wg0.conf';
const WG_INTERFACE = 'wg0';
const REGISTER_RETRY_BASE_MS = 30_000; // 30s, doubles each failure up to 30min
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 min — refresh lastSeen

class GatewayClient {
  constructor(agent) {
    this.agent = agent;
    this.registered = false;
    this.mode = null;
    this.agentId = null;
    this.allocatedIp = null;
    this.retryDelay = REGISTER_RETRY_BASE_MS;
    this.heartbeatTimer = null;
  }

  async initialize() {
    logger.info('Gateway client: initialize() entered');
    // Best-effort. Errors logged but never block agent startup.
    try {
      await this._register();
      this._scheduleHeartbeat();
    } catch (err) {
      logger.warn(`Gateway client: initial registration failed (${err.message}) — will retry in background`);
      this._scheduleRetry();
    }
    logger.info('Gateway client: initialize() returning');
  }

  async shutdown() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Connectivity diagnostics: WireGuard tunnel state, gateway reachability and
   * latency, and the gateway's own view of this agent.
   *
   * Read-only — it never re-registers or otherwise mutates gateway state, so it
   * is safe to call while triaging an outage.
   *
   * @returns {Promise<Object>} diagnostics
   */
  async getConnectivityDiagnostics() {
    const diagnostics = {
      timestamp: new Date().toISOString(),
      registered: this.registered,
      mode: this.mode,
      agentId: this.agentId,
      allocatedIp: this.allocatedIp,
      gatewayUrl: GATEWAY_URL,
      tunnel: null,
      reachability: null,
      gatewayView: null
    };

    // Settle each probe independently: a dead tunnel must not hide the fact
    // that the gateway itself is answering (or vice versa).
    const [tunnel, reachability, gatewayView] = await Promise.all([
      this._getTunnelStatus().catch(e => ({ error: e.message })),
      this._probeGateway().catch(e => ({ error: e.message })),
      this._getGatewayView().catch(e => ({ error: e.message }))
    ]);

    diagnostics.tunnel = tunnel;
    diagnostics.reachability = reachability;
    diagnostics.gatewayView = gatewayView;

    return diagnostics;
  }

  /**
   * WireGuard tunnel status, read from `wg show <iface> dump`.
   *
   * `dump` is tab-separated and machine-readable; the human `wg show` output is
   * not safely parseable (its peers are introduced by an unindented `peer:`
   * line while `public key:` belongs to the interface, and endpoints carry a
   * colon-separated port).
   *
   * @returns {Promise<Object>} tunnel status
   */
  async _getTunnelStatus() {
    if (this.mode && this.mode !== 'TUNNEL') {
      return { interface: WG_INTERFACE, configured: false, reason: `mode is ${this.mode}` };
    }

    try {
      const stdout = await this._wgDump();
      const lines = stdout.split('\n').filter(Boolean);
      if (lines.length === 0) {
        return { interface: WG_INTERFACE, configured: false, reason: 'no output from wg show' };
      }

      // First line describes the interface: privkey, pubkey, listen-port, fwmark
      const [, ifacePublicKey, listenPort] = lines[0].split('\t');
      const nowSec = Math.floor(Date.now() / 1000);

      const peers = lines.slice(1).map(line => {
        const [publicKey, , endpoint, allowedIps, latestHandshake, rx, tx, keepalive] = line.split('\t');
        const handshakeSec = Number(latestHandshake) || 0;
        return {
          publicKey,
          // 'off' is what wg prints for an unset endpoint; keep host:port intact.
          endpoint: endpoint && endpoint !== '(none)' ? endpoint : null,
          allowedIps,
          latestHandshake: handshakeSec > 0 ? new Date(handshakeSec * 1000).toISOString() : null,
          handshakeAgeSeconds: handshakeSec > 0 ? nowSec - handshakeSec : null,
          rxBytes: Number(rx) || 0,
          txBytes: Number(tx) || 0,
          persistentKeepalive: keepalive === 'off' ? null : Number(keepalive) || null
        };
      });

      // A peer that has not handshaken in >3 min is stale: WireGuard rekeys
      // roughly every 2 min while traffic flows, so this is the tell for the
      // gateway having dropped our peer entry.
      const stalePeers = peers.filter(p => p.handshakeAgeSeconds === null || p.handshakeAgeSeconds > 180);

      return {
        interface: WG_INTERFACE,
        configured: true,
        publicKey: ifacePublicKey || null,
        listenPort: Number(listenPort) || null,
        peerCount: peers.length,
        stalePeerCount: stalePeers.length,
        healthy: peers.length > 0 && stalePeers.length === 0,
        peers
      };
    } catch (error) {
      return { interface: WG_INTERFACE, configured: false, error: error.message };
    }
  }

  /**
   * Raw `wg show <iface> dump` output. Separated from the parser so the parser
   * can be exercised without wireguard-tools installed.
   * @returns {Promise<string>}
   */
  async _wgDump() {
    const { stdout } = await execFile('wg', ['show', WG_INTERFACE, 'dump'], { timeout: 5000 });
    return stdout;
  }

  /**
   * Probe the gateway's /health endpoint a few times, deriving reachability and
   * latency from the same samples rather than issuing a separate round of
   * requests for each.
   *
   * @returns {Promise<Object>} reachability + latency
   */
  async _probeGateway(samples = 3) {
    const results = [];

    for (let i = 0; i < samples; i++) {
      const start = Date.now();
      try {
        const response = await axios.get(`${GATEWAY_URL}/health`, {
          timeout: 5000,
          validateStatus: () => true
        });
        results.push({
          attempt: i + 1,
          statusCode: response.status,
          ok: response.status < 500,
          latencyMs: Date.now() - start,
          body: i === 0 ? response.data : undefined
        });
      } catch (error) {
        results.push({ attempt: i + 1, ok: false, error: error.message, latencyMs: Date.now() - start });
      }
      if (i < samples - 1) await new Promise(r => setTimeout(r, 100));
    }

    const ok = results.filter(r => r.ok);
    const latencies = ok.map(r => r.latencyMs);

    return {
      url: `${GATEWAY_URL}/health`,
      reachable: ok.length > 0,
      successRate: results.length ? ok.length / results.length : 0,
      averageLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      minLatencyMs: latencies.length ? Math.min(...latencies) : null,
      maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
      samples: results
    };
  }

  /**
   * What the gateway believes about this agent — whether it considers us
   * online, when it last saw us, and our routing reliability.
   *
   * This is the half that catches a one-way failure: we can reach the gateway
   * while it has already written us off.
   *
   * @returns {Promise<Object>} the gateway's view of this agent
   */
  async _getGatewayView() {
    if (!this.registered || !this.agentId) {
      return { status: 'unregistered', registered: this.registered, agentId: this.agentId };
    }

    try {
      const start = Date.now();
      const response = await axios.get(`${GATEWAY_URL}/agents/${encodeURIComponent(this.agentId)}`, {
        timeout: 10000,
        validateStatus: () => true
      });
      const responseTimeMs = Date.now() - start;

      if (response.status === 404) {
        // Registered locally but unknown to the gateway — the state that a
        // dropped peer or a wiped gateway record produces.
        return { status: 'unknown_to_gateway', statusCode: 404, responseTimeMs };
      }

      const agent = response.data?.agent;
      if (response.status >= 400 || !agent) {
        return { status: 'degraded', statusCode: response.status, responseTimeMs };
      }

      return {
        status: agent.online ? 'healthy' : 'stale',
        statusCode: response.status,
        responseTimeMs,
        online: agent.online,
        lastSeen: agent.lastSeen,
        reliability: agent.reliability,
        avgResponseTime: agent.avgResponseTime,
        serviceCount: Array.isArray(agent.services) ? agent.services.length : null
      };
    } catch (error) {
      return { status: 'unreachable', error: error.message };
    }
  }

  /**
   * Ensure a WireGuard keypair exists; return both keys.
   */
  async _ensureWireGuardKeypair() {
    await fs.promises.mkdir(WG_DIR, { recursive: true, mode: 0o700 });
    let priv, pub;
    try {
      priv = (await fs.promises.readFile(WG_PRIV_PATH, 'utf8')).trim();
      pub = (await fs.promises.readFile(WG_PUB_PATH, 'utf8')).trim();
      if (priv && pub) return { privateKey: priv, publicKey: pub };
    } catch { /* generate below */ }
    // Generate via `wg`. Use spawnSync because `wg pubkey` reads its private
    // key from stdin — execFile doesn't support stdin input and would hang.
    try {
      const gen = spawnSync('wg', ['genkey'], { encoding: 'utf8' });
      if (gen.status !== 0) throw new Error(`wg genkey exited ${gen.status}: ${gen.stderr}`);
      priv = gen.stdout.trim();
      const pubGen = spawnSync('wg', ['pubkey'], { input: priv, encoding: 'utf8' });
      if (pubGen.status !== 0) throw new Error(`wg pubkey exited ${pubGen.status}: ${pubGen.stderr}`);
      pub = pubGen.stdout.trim();
    } catch (e) {
      throw new Error(`wg keygen failed — is wireguard-tools installed? (${e.message})`);
    }
    await fs.promises.writeFile(WG_PRIV_PATH, priv + '\n', { mode: 0o600 });
    await fs.promises.writeFile(WG_PUB_PATH, pub + '\n', { mode: 0o644 });
    return { privateKey: priv, publicKey: pub };
  }

  /**
   * Build the signed registration payload using cryptoManager's Ed25519 identity.
   */
  async _buildPayload({ wgPublicKey }) {
    const keys = cryptoManager.getPublicKeys();
    if (!keys?.signPublicKey || !keys?.fingerprint) {
      throw new Error('P2P identity not initialized yet');
    }

    let walletAddress = null;
    try {
      const walletService = (await import('../crypto/walletService.js')).default;
      const info = await walletService.getWalletInfo();
      walletAddress = info?.addresses?.find(a => a.chain === 'bsc' || a.chain === 'eth')?.address || null;
    } catch (e) {
      logger.debug(`Gateway client: wallet lookup failed (${e.message})`);
    }
    if (!walletAddress) throw new Error('no BSC/ETH wallet address available for registration');

    let claimedAgentId = null;
    try {
      const { Agent: AgentModel } = await import('../../models/Agent.js');
      const agentDoc = await AgentModel.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
      claimedAgentId = agentDoc?.erc8004?.agentId || null;
    } catch { /* fine */ }

    const port = parseInt(process.env.AGENT_PORT || '80', 10);
    const serviceUrl = process.env.AGENT_SERVICE_URL ||
      (process.env.AGENT_PUBLIC_HOST ? `http://${process.env.AGENT_PUBLIC_HOST}:${port}` : null);

    const payload = {
      fingerprint: keys.fingerprint,
      publicKey: keys.signPublicKey,
      name: process.env.AGENT_NAME || 'LANAgent',
      walletAddress,
      serviceUrl,
      agentPort: port,
      wgPublicKey,
      version: this.agent?.config?.version || '0.0.0',
      agentId: claimedAgentId,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: cryptographicNonce()
    };
    payload.sig = cryptoManager.sign(payload);
    return payload;
  }

  async _register() {
    logger.info('Gateway client: _register() — ensuring wg keypair');
    const wgKeys = await this._ensureWireGuardKeypair();
    logger.info(`Gateway client: wg keypair ready (pub=${wgKeys.publicKey.slice(0, 12)}...)`);
    logger.info('Gateway client: building signed payload');
    const payload = await this._buildPayload({ wgPublicKey: wgKeys.publicKey });

    logger.info(`Gateway client: registering with ${GATEWAY_URL} (fp=${payload.fingerprint})`);
    const res = await axios.post(`${GATEWAY_URL}/agents/register`, payload, { timeout: 15_000 });
    if (!res.data?.success) {
      throw new Error(`gateway refused registration: ${res.data?.error || 'unknown'}`);
    }

    this.registered = true;
    this.mode = res.data.mode;
    this.agentId = res.data.agentId;
    this.retryDelay = REGISTER_RETRY_BASE_MS;
    logger.info(`Gateway client: registered as agentId=${this.agentId} mode=${this.mode}`);

    if (res.data.tunnel) {
      this.allocatedIp = res.data.tunnel.allocatedIp;
      // Only rewrite wg0.conf + bounce the interface when the tunnel params
      // we'd write actually differ from what's running. Avoids a 5-min-cadence
      // disconnect-reconnect on every heartbeat re-register, which briefly
      // interrupts gateway → agent reachability and inflates log noise.
      const sig = `${wgKeys.publicKey}|${res.data.tunnel.serverPublicKey}|${res.data.tunnel.allocatedIp}|${res.data.tunnel.endpoint}`;
      if (this._tunnelSig !== sig) {
        await this._writeWireGuardConfig(wgKeys.privateKey, res.data.tunnel);
        await this._bringUpTunnel();
        this._tunnelSig = sig;
        logger.info(`Gateway client: tunnel up — ${this.allocatedIp} via ${res.data.tunnel.endpoint}`);
      } else {
        logger.debug(`Gateway client: tunnel unchanged — skipping bounce`);
      }
      // One-shot post-tunnel refresh — schedule ONCE per process lifetime so
      // the gateway can probe our catalog via the now-live tunnel without
      // waiting the full heartbeat interval. Subsequent /register calls
      // (heartbeat, retry) do NOT re-arm this — otherwise we'd loop forever.
      if (!this._postTunnelRefreshScheduled) {
        this._postTunnelRefreshScheduled = true;
        setTimeout(() => {
          this._register().catch(err => {
            logger.debug(`Gateway client: post-tunnel catalog refresh failed (${err.message}) — will retry on heartbeat`);
          });
        }, 7000).unref?.();
      }
    }

    // Persist registration state so we can short-circuit re-registration
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      await SystemSettings.setSetting('gateway.registered', {
        agentId: this.agentId,
        mode: this.mode,
        allocatedIp: this.allocatedIp,
        registeredAt: new Date().toISOString()
      }, 'Last successful gateway self-registration', 'p2p');
    } catch (e) {
      logger.debug(`Gateway client: setSetting failed (${e.message})`);
    }
  }

  async _writeWireGuardConfig(privateKey, tunnel) {
    const conf = [
      '[Interface]',
      `# Auto-generated by gatewayClient. Re-registering will overwrite this file.`,
      `PrivateKey = ${privateKey}`,
      `Address = ${tunnel.allocatedIp}/32`,
      '',
      '[Peer]',
      `# api.lanagent.net gateway`,
      `PublicKey = ${tunnel.serverPublicKey}`,
      `Endpoint = ${tunnel.endpoint}`,
      `AllowedIPs = ${tunnel.gatewayIp}/32`,
      `PersistentKeepalive = 25`,
      ''
    ].join('\n');

    if (process.getuid && process.getuid() === 0) {
      await fs.promises.writeFile(WG_CONF_PATH, conf, { mode: 0o600 });
      return;
    }
    // Non-root: write a tmp file under the agent's uid, then sudo install into
    // /etc/wireguard. install.sh ships a sudoers.d entry for exactly this path
    // pattern.
    const tmp = path.join(os.tmpdir(), `wg0.${process.pid}.conf`);
    await fs.promises.writeFile(tmp, conf, { mode: 0o600 });
    try {
      await execFile('sudo', ['-n', 'install', '-m', '600', '-o', 'root', '-g', 'root', tmp, WG_CONF_PATH]);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }

  async _bringUpTunnel() {
    // wg-quick must be run as root. If the agent isn't root, prepend sudo -n
    // (which depends on the sudoers.d entry seeded by install.sh).
    const isRoot = process.getuid && process.getuid() === 0;
    const runWg = (args) => isRoot
      ? execFile('wg-quick', args)
      : execFile('sudo', ['-n', 'wg-quick', ...args]);
    // Bring down if already up (idempotent), then up
    await runWg(['down', WG_INTERFACE]).catch(() => {});
    await runWg(['up', WG_INTERFACE]);
    // Enable persistence across reboot (best-effort)
    const enableCmd = isRoot
      ? execFile('systemctl', ['enable', `wg-quick@${WG_INTERFACE}`])
      : execFile('sudo', ['-n', 'systemctl', 'enable', `wg-quick@${WG_INTERFACE}`]);
    await enableCmd.catch(() => {});
  }

  _scheduleRetry() {
    setTimeout(async () => {
      try {
        await this._register();
        this._scheduleHeartbeat();
      } catch (err) {
        this.retryDelay = Math.min(this.retryDelay * 2, 30 * 60_000); // cap at 30min
        logger.warn(`Gateway client: retry failed (${err.message}); next attempt in ${Math.round(this.retryDelay/1000)}s`);
        this._scheduleRetry();
      }
    }, this.retryDelay).unref?.();
  }

  _scheduleHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      try { await this._register(); }
      catch (err) { logger.debug(`Gateway client: heartbeat re-register failed (${err.message})`); }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }
}

function cryptographicNonce() {
  return crypto.randomBytes(16).toString('hex');
}

export default GatewayClient;
export { GatewayClient };
