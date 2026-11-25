/**
 * The stage: what a program on the owner's own machines needs to draw this agent's body dancing (Gapless, the music player;
 * 2119 #635, the owner's yes 2026-11-25). Read only, and only with the stage key: the body worn now, the look on it, the
 * dances that suit it, the set it stands in. Nothing is pushed, nothing can be changed here.
 *
 *   GET /stage/v1/state         the state; ETag / 304
 *   GET /stage/v1/files/<sha>   a file the state names now; ETag = its sha256
 *
 * Off until a key was made (data/stage/key.sha256 holds only its hash). A lent body (the owner's Bots & Borgs link) says
 * `lent: true`: to be drawn, never kept.
 */
import express from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { DATA_PATH } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

const TYPES = { '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
export const stageKeyFile = () => path.join(DATA_PATH, 'stage', 'key.sha256');

/** Whether this request carries the stage key. False when there is none. */
export async function stageAllowed(header, keyFile = stageKeyFile()) {
  const m = /^Bearer\s+(\S{20,200})$/.exec(String(header || ''));
  const want = (await fs.readFile(keyFile, 'utf8').catch(() => '')).trim().toLowerCase();
  if (!m || !/^[0-9a-f]{64}$/.test(want)) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), Buffer.from(want, 'hex'));
}

export function createStageRouter(agent, { keyFile = stageKeyFile(), store = () => { const e = agent?.apiManager?.apis?.get?.('botsandborgs'); return e?.enabled === false ? null : (e?.instance || e || null); } } = {}) {
  const r = express.Router();
  r.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (await stageAllowed(req.headers.authorization, keyFile).catch(() => false)) return next();
    return res.status(401).json({ error: 'the stage key' });
  });
  const read = async () => {
    const s = store();
    if (!s?.stageState) return null;
    return s.stageState();
  };
  r.get('/state', async (req, res) => {
    try {
      const got = await read();
      if (!got) return res.status(503).json({ error: 'no body to show' });
      const body = JSON.stringify(got.state);
      const tag = `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
      res.setHeader('ETag', tag);
      if (req.headers['if-none-match'] === tag) return res.status(304).end();
      res.type('application/json').send(body);
    } catch (e) { logger.warn(`Stage: ${e.message}`); res.status(500).json({ error: 'not readable now' }); }
  });
  r.get('/files/:sha', async (req, res) => {
    try {
      const got = await read();
      const file = /^[0-9a-f]{64}$/.test(req.params.sha) ? got?.files.get(req.params.sha) : null;
      if (!file) return res.status(404).json({ error: 'not named by the state now' });
      const tag = `"${req.params.sha}"`;
      res.setHeader('ETag', tag);
      if (req.headers['if-none-match'] === tag) return res.status(304).end();
      const { size } = await fs.stat(file);
      res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', size);
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (e) { logger.warn(`Stage: ${e.message}`); if (!res.headersSent) res.status(500).json({ error: 'not readable now' }); }
  });
  return r;
}
