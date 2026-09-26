import express from 'express';
import fs from 'fs/promises';
import crypto from 'node:crypto';
import { authenticateToken } from './auth.js';
import { logger } from '../../utils/logger.js';

/**
 * OpenAI-compatible chat endpoint.
 *
 * Lets any OpenAI-style client — Home Assistant's "OpenAI Conversation" / Assist,
 * Open WebUI, phone chat apps, scripts using the openai SDK — use the agent as its
 * "model". A request runs through processNaturalLanguage exactly as a Telegram or web
 * message would, so the client gets the agent's plugins, memory and routing, not a
 * bare LLM.
 *
 *   GET  /v1/models
 *   POST /v1/chat/completions   { messages, stream?, user? }
 *
 * Auth: the standard OpenAI client sends `Authorization: Bearer <key>`. Our
 * authenticateToken reads a Bearer value as a JWT, so a Bearer value that is not
 * JWT-shaped is re-presented as an API key (X-API-Key) first. JWTs still work.
 */

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function bearerApiKeyAdapter(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!req.headers['x-api-key'] && auth.startsWith('Bearer ')) {
    const value = auth.slice(7).trim();
    if (value && !JWT_SHAPE.test(value)) {
      req.headers['x-api-key'] = value;
      delete req.headers.authorization;
    }
  }
  next();
}

/** Flatten OpenAI message content (string, or an array of typed parts) to text. */
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
  }
  return content == null ? '' : String(content);
}

/** Render an agent result (text, photo, document, plugin result...) as reply text. */
export function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const text = result.content ?? result.caption ?? result.message ?? result.result ?? result.response;
  let out = typeof text === 'string' ? text : (text != null ? JSON.stringify(text) : '');
  const mediaTypes = ['photo', 'document', 'video', 'audio', 'animation', 'media_group'];
  if (mediaTypes.includes(result.type)) {
    out = `${out}${out ? '\n\n' : ''}(A ${result.type.replace('_', ' ')} was produced; open it from Telegram or the web dashboard.)`;
  }
  if (!out && result.error) out = `Error: ${result.error}`;
  return out || JSON.stringify(result);
}

export function createOpenAICompatRouter(agent) {
  const router = express.Router();
  const modelId = () => (process.env.AGENT_NAME || 'LANAgent').toLowerCase();

  router.use(bearerApiKeyAdapter, authenticateToken);

  router.get('/models', (req, res) => {
    res.json({
      object: 'list',
      data: [{ id: modelId(), object: 'model', created: 0, owned_by: 'lanagent' }]
    });
  });

  router.post('/chat/completions', async (req, res) => {
    const { messages, stream } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: '`messages` must be a non-empty array', type: 'invalid_request_error' } });
    }

    const lastUserIdx = messages.map(m => m?.role).lastIndexOf('user');
    const input = lastUserIdx >= 0 ? messageText(messages[lastUserIdx].content).trim() : '';
    if (!input) {
      return res.status(400).json({ error: { message: 'No user message with text content', type: 'invalid_request_error' } });
    }

    // The client owns its history; hand the earlier turns over as context. The agent keeps its
    // own short follow-up buffer per userId, so each client gets a stable id of its own.
    const history = messages.slice(0, lastUserIdx)
      .filter(m => m?.role === 'user' || m?.role === 'assistant')
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'You'}: ${messageText(m.content).substring(0, 500)}`)
      .join('\n');
    const clientName = req.apiKey?.name || req.user?.userId || 'client';
    const userId = `openai:${req.body.user || clientName}`;

    const started = Date.now();
    let result;
    try {
      result = await agent.processNaturalLanguage(input, {
        userId,
        interface: 'openai',
        ...(history ? { conversationContext: history } : {})
      });
    } catch (error) {
      logger.error('OpenAI-compat request failed:', error);
      return res.status(500).json({ error: { message: error.message, type: 'server_error' } });
    }

    // Media results are not deliverable over this API; remove temp files the agent flagged
    // for deletion after sending, since nothing will send them.
    if (result?.cleanup && result?.path) fs.unlink(result.path).catch(() => {});

    const content = resultText(result);
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(started / 1000);
    logger.info(`OpenAI-compat reply to ${userId} in ${Date.now() - started}ms (${content.length} chars)`);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: modelId(),
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`);
      chunk({ role: 'assistant', content });
      chunk({}, 'stop');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.json({
      id,
      object: 'chat.completion',
      created,
      model: modelId(),
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  });

  return router;
}

export default createOpenAICompatRouter;
