import path from 'path';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { TextXHub } from './textxHub.js';
import { mongoCallStore } from './dialx.js';
import { mongoStore } from './textxStore.js';
import { createTransport } from './textxTransport.js';
import { TextXRelayClient, DEFAULT_RELAY_URL } from './textxRelayClient.js';
import { newPairing, pairingUri } from './textxCrypto.js';
import { cryptoManager } from '../p2p/cryptoManager.js';
import { DATA_PATH, DEPLOY_PATH } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

/**
 * TextX: this agent as a conversation in the TextX SMS app (docs/TEXTX.md).
 *
 * One service per process: the hub (protocol), its store, the transport shared by the local
 * endpoint and the relay link, and pairing. Env:
 *   TEXTX_RELAY=off            no relay link (phones then need the LAN, a VPN or TEXTX_PUBLIC_URL)
 *   TEXTX_RELAY_URL            default wss://api.lanagent.net/textx/relay/agent
 *   TEXTX_PUBLIC_URL           a direct public origin to put in pairing QRs instead of the relay
 *   TEXTX_RELAY_CONNECT_ADDRESS  dial this IP for the relay (TLS still checks its hostname); for a host
 *                              whose firewall only allows a tunnel, e.g. the relay's WireGuard address
 */

let service = null;

export function relayBase(relayUrl, fingerprint) {
  const u = new URL(relayUrl);
  return `https://${u.host}/r/${fingerprint}`;
}

async function identity() {
  return cryptoManager.identity || cryptoManager.loadOrCreateIdentity();
}

export function getTextX(agent) {
  if (service) return service;
  const store = mongoStore();
  const hub = new TextXHub({ store, agent, logger, callStore: mongoCallStore() });
  const transport = createTransport(hub, {
    filesDir: path.join(DATA_PATH, 'textx', 'files'),
    avatarFile: () => (agent?.agentModel?.avatarPath ? path.join(DEPLOY_PATH, agent.agentModel.avatarPath) : null),
    logger
  });
  const relayEnabled = String(process.env.TEXTX_RELAY || 'on').toLowerCase() !== 'off';
  const relayUrl = process.env.TEXTX_RELAY_URL || DEFAULT_RELAY_URL;
  const relay = new TextXRelayClient({ transport, identity, url: relayUrl, connectAddress: process.env.TEXTX_RELAY_CONNECT_ADDRESS || null, logger });

  async function ensureRelay() {
    if (!relayEnabled) return;
    const live = (await store.listDevices()).some(d => !d.revokedAt);
    if (live) relay.start();
    else relay.stop();
  }

  /** The URL a new pairing's QR carries. */
  async function pairingBase(requestOrigin) {
    if (process.env.TEXTX_PUBLIC_URL) return process.env.TEXTX_PUBLIC_URL.replace(/\/+$/, '');
    if (relayEnabled) return relayBase(relayUrl, (await identity()).fingerprint);
    return requestOrigin;
  }

  async function pair(name, { requestOrigin } = {}) {
    const { kid, key } = newPairing();
    const base = await pairingBase(requestOrigin);
    const device = await store.createDevice({ name: String(name || 'Phone').slice(0, 60), kid, key, base });
    await ensureRelay();
    const uri = pairingUri(base, kid, key);
    logger.info(`TextX: new pairing "${device.name}" (${kid.slice(0, 6)}…) via ${base}`);
    return { id: device.id, name: device.name, base, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 320 }) };
  }

  const publicDevice = (d) => ({
    id: d.id, name: d.name, kid: `${d.kid.slice(0, 6)}…`, base: d.base, bound: !!d.deviceId, boundAt: d.boundAt,
    lastSeenAt: d.lastSeenAt, appVersion: d.appVersion, client: d.client || null, tools: d.capabilities || [], notify: !!d.notify,
    connected: hub.isConnected(d.id), revoked: !!d.revokedAt,
    watches: (d.watches || []).filter(w => new Date(w.until) > new Date()).map(w => ({ thread: w.title || w.threadId, purpose: w.purpose, until: w.until }))
  });

  async function devices() { return (await store.listDevices()).filter(d => !d.revokedAt).map(publicDevice); }

  async function update(id, { notify, name } = {}) {
    const patch = {};
    if (typeof notify === 'boolean') patch.notify = notify;
    if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 60);
    const d = await store.updateDevice(id, patch);
    return d ? publicDevice(d) : null;
  }

  /** Revoke (§6.7): the pairing's key is deleted with it, so nothing sealed under it opens again. */
  async function revoke(id) {
    const d = await store.getDevice(id);
    if (!d) return false;
    hub.sessions.get(String(id))?.close(4401, 'pairing revoked');
    await store.deleteDevice(id);
    await hub.refreshDialXPaired();
    await ensureRelay();
    logger.info(`TextX: pairing "${d.name}" revoked`);
    return true;
  }

  /** Accept phone WebSockets on this HTTP server at /textx/v1/ws (local and LAN access). */
  function attachServer(server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      if ((req.url || '').split('?')[0] !== '/textx/v1/ws') return;
      // Upgrade first and refuse with 4401 after: socket.io destroys upgrades nothing answered quickly.
      wss.handleUpgrade(req, socket, head, async (ws) => {
        const handlers = await transport.ws({
          headers: req.headers,
          send: (text) => { if (ws.readyState === 1) ws.send(text); },
          close: (code, reason) => ws.close(code, reason)
        }).catch(() => null);
        if (!handlers) { ws.close(4401, 'unknown pairing'); return; }
        ws.on('message', (data, isBinary) => { if (!isBinary) handlers.onMessage(String(data)); });
        ws.on('close', () => handlers.onClose());
        ws.on('error', () => {});
      });
    });
  }

  const sweep = setInterval(() => transport.sweepFiles().catch(() => {}), 6 * 3600 * 1000);
  sweep.unref?.();
  ensureRelay().catch(e => logger.warn(`TextX relay not started: ${e.message}`));
  hub.recoverInterrupted().catch(e => logger.warn(`TextX: could not check for interrupted answers: ${e.message}`));

  service = { hub, store, transport, relay, pair, devices, update, revoke, attachServer, ensureRelay,
    status: async () => ({ relay: relayEnabled ? relay.status() : { enabled: false }, devices: await devices() }) };
  return service;
}

/** Agent notifications to opted-in phones; a no-op until TextX has been started. */
export async function textxNotify(text) {
  if (service) await service.hub.notify(text);
}

export default getTextX;
