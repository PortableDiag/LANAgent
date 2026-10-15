import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import VisionPlugin from '../../src/api/plugins/vision.js';
import fs from 'fs/promises';

// A real 1x1 PNG: the plugin identifies the type from the bytes
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

describe('VisionPlugin', () => {
  let plugin, agent;
  let originalReadFile;

  beforeEach(() => {
    agent = {
      providerManager: {
        analyzeImage: async (buf, question, options) => {
          return { analysis: `Answered: ${question} (${options.mimeType})` };
        }
      }
    };
    plugin = new VisionPlugin(agent);
    originalReadFile = fs.readFile;
    fs.readFile = async (filePath) => {
      if (String(filePath).includes('test.png')) {
        return Buffer.from('fake-image-data');
      }
      throw new Error('ENOENT');
    };
  });

  afterEach(() => {
    fs.readFile = originalReadFile;
  });

  it('should analyze a base64 image with valid inputs', async () => {
    const params = {
      action: 'ask',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
      question: 'describe'
    };
    const result = await plugin.execute(params);
    assert.equal(result.success, true);
    assert.equal(result.answers.length, 1);
    assert.equal(result.answers[0].source, 'base64');
    assert.ok(result.answers[0].answer.includes('describe'));
    assert.ok(result.answers[0].answer.includes('image/png'));
  });

  it('infers the type from the bytes when mimeType is omitted', async () => {
    const result = await plugin.execute({ action: 'ask', base64: PNG, question: 'desc' });
    assert.equal(result.success, true);
    assert.ok(result.answers[0].answer.includes('image/png'));
  });

  it('accepts a data: URL', async () => {
    const result = await plugin.execute({ action: 'ask', base64: `data:image/png;base64,${PNG}`, question: 'desc' });
    assert.equal(result.success, true);
  });

  it('refuses a mimeType that contradicts the bytes', async () => {
    const result = await plugin.execute({ action: 'ask', base64: PNG, mimeType: 'image/jpeg', question: 'desc' });
    assert.equal(result.success, false);
    assert.match(result.error, /does not match/);
  });

  it('refuses bytes that are not an image', async () => {
    const result = await plugin.execute({ action: 'ask', base64: 'dGVzdA==', question: 'desc' });
    assert.equal(result.success, false);
    assert.match(result.error, /Not a recognised image/);
  });

  it('should error if mimeType not allowed', async () => {
    const params = { action: 'ask', base64: PNG, mimeType: 'image/bmp', question: 'desc' };
    const result = await plugin.execute(params);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Unsupported mimeType'));
  });

  it('should error if base64 string invalid', async () => {
    const params = { action: 'ask', base64: '!!!invalid', mimeType: 'image/png', question: 'desc' };
    const result = await plugin.execute(params);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Invalid base64 string');
  });

  it('should error if analyzeImage returns no text', async () => {
    agent.providerManager.analyzeImage = async () => ({ analysis: '' });
    const params = { action: 'ask', base64: PNG, mimeType: 'image/png', question: 'desc' };
    const result = await plugin.execute(params);
    assert.equal(result.success, false);
    assert.ok(result.answers[0].error.includes('the vision model returned no text'));
  });

  it('should analyze a file path successfully', async () => {
    const params = { action: 'ask', path: '/tmp/test.png', question: 'what is it' };
    const result = await plugin.execute(params);
    assert.equal(result.success, true);
    assert.equal(result.answers.length, 1);
    assert.equal(result.answers[0].path, '/tmp/test.png');
    assert.ok(result.answers[0].answer.includes('what is it'));
  });

  it('should reject file outside allowed roots', async () => {
    const params = { action: 'ask', path: '/etc/passwd', question: 'a' };
    const result = await plugin.execute(params);
    assert.equal(result.success, false);
    assert.ok(result.answers.some(a => a.error.includes('outside the agent')));
  });

  it('should handle both path and base64 together', async () => {
    const params = {
      action: 'ask',
      path: '/tmp/test.png',
      base64: PNG,
      question: 'multi'
    };
    const result = await plugin.execute(params);
    assert.equal(result.success, true);
    assert.equal(result.answers.length, 2);
    assert.ok(result.answers.find(a => a.source === 'base64'));
    assert.ok(result.answers.find(a => a.path === '/tmp/test.png'));
  });
});
