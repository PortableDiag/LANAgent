import express from 'express';
import { authenticateToken } from './auth.js';
import { getTextX } from '../../services/textx/index.js';
import { logger } from '../../utils/logger.js';

/**
 * TextX routes (docs/TEXTX.md).
 *
 *   /textx/v1/*   the phone's endpoint. Its own auth: a pairing kid plus frames sealed under
 *                 the pairing key, so it is open to any network like /api/external.
 *   /api/textx/*  pairing management for the dashboard (JWT or API key).
 */

export function createTextXPhoneRouter(agent) {
  const router = express.Router();
  router.use(express.raw({ type: () => true, limit: '6mb' }));
  router.all('*', async (req, res) => {
    // express.json (mounted app-wide) has already parsed application/json bodies.
    const body = Buffer.isBuffer(req.body) ? req.body
      : (req.body && typeof req.body === 'object' && Object.keys(req.body).length ? Buffer.from(JSON.stringify(req.body)) : null);
    const out = await getTextX(agent).transport.http({
      method: req.method,
      path: `/textx/v1${req.path}`,
      query: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '',
      headers: { authorization: req.headers.authorization, 'x-textx-device': req.headers['x-textx-device'] },
      body
    });
    res.status(out.status);
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    res.end(out.body);
  });
  return router;
}

export function createTextXAdminRouter(agent) {
  const router = express.Router();
  router.use(authenticateToken);

  router.get('/status', async (req, res) => {
    try {
      res.json({ success: true, data: await getTextX(agent).status() });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Mint a pairing. The response is the only time the key exists outside this agent.
  router.post('/pair', async (req, res) => {
    try {
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      const data = await getTextX(agent).pair(req.body?.name, { requestOrigin });
      res.json({ success: true, data });
    } catch (error) {
      logger.error('TextX pairing failed:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.patch('/devices/:id', async (req, res) => {
    const d = await getTextX(agent).update(req.params.id, req.body || {}).catch(() => null);
    if (!d) return res.status(404).json({ success: false, error: 'No such pairing' });
    res.json({ success: true, data: d });
  });

  router.delete('/devices/:id', async (req, res) => {
    const ok = await getTextX(agent).revoke(req.params.id).catch(() => false);
    if (!ok) return res.status(404).json({ success: false, error: 'No such pairing' });
    res.json({ success: true });
  });

  return router;
}
