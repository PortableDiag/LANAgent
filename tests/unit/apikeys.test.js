import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ApiKeysPlugin from '../../src/api/plugins/apikeys.js';
import ApiKey from '../../src/models/ApiKey.js';
import { logger } from '../../src/utils/logger.js';

describe('ApiKeysPlugin update command', () => {
  let plugin;
  let origFindByIdAndUpdate;
  let origStoreMemory;
  let origLoggerInfo, origLoggerWarn, origLoggerError;

  before(() => {
    origLoggerInfo = logger.info;
    origLoggerWarn = logger.warn;
    origLoggerError = logger.error;
    logger.info = () => {};
    logger.warn = () => {};
    logger.error = () => {};

    origFindByIdAndUpdate = ApiKey.findByIdAndUpdate;

    const agent = { storeMemory: async () => {} };
    plugin = new ApiKeysPlugin(agent);
    plugin.validateParams = () => true;
    origStoreMemory = plugin.storeMemory;
    plugin.storeMemory = async () => {};
  });

  after(() => {
    logger.info = origLoggerInfo;
    logger.warn = origLoggerWarn;
    logger.error = origLoggerError;
    plugin.storeMemory = origStoreMemory;
    ApiKey.findByIdAndUpdate = origFindByIdAndUpdate;
  });

  it('should have update command registered', () => {
    const cmd = plugin.commands.find(c => c.command === 'update');
    assert.ok(cmd, 'update command not found');
    assert.equal(cmd.description, "Update an existing API key's metadata");
  });

  it('should update key with all fields', async () => {
    const keyId = 'key1';
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const updatedKey = { id: keyId, name: 'New', description: 'Desc', rateLimit: 200, expiresAt };
    ApiKey.findByIdAndUpdate = async (id, update, opts) => {
      assert.equal(id, keyId);
      assert.deepStrictEqual(opts, { new: true, runValidators: true });
      return updatedKey;
    };
    const result = await plugin.execute({
      action: 'update', keyId, name: 'New', description: 'Desc', rateLimit: 200, expiresIn: '30d'
    });
    assert.deepStrictEqual(result, {
      success: true,
      message: 'API key updated successfully',
      key: { id: keyId, name: 'New', description: 'Desc', rateLimit: 200, expiresAt }
    });
  });

  it('should update only provided fields', async () => {
    const keyId = 'key2';
    ApiKey.findByIdAndUpdate = async (id, update) => {
      assert.deepStrictEqual(update, { $set: { description: 'Only desc' } });
      return { id: keyId, name: 'Old', description: 'Only desc', rateLimit: 100, expiresAt: null };
    };
    const result = await plugin.execute({ action: 'update', keyId, description: 'Only desc' });
    assert.equal(result.success, true);
    assert.equal(result.key.description, 'Only desc');
  });

  it('should throw if no fields provided', async () => {
    await assert.rejects(
      plugin.execute({ action: 'update', keyId: 'key3' }),
      /No fields to update provided/
    );
  });

  it('should return success false if key not found', async () => {
    ApiKey.findByIdAndUpdate = async () => null;
    const result = await plugin.execute({ action: 'update', keyId: 'missing', name: 'X' });
    assert.deepStrictEqual(result, { success: false, error: 'API key not found' });
  });

  it('calculateExpiration should parse duration strings', () => {
    const now = Date.now();
    const d = plugin.calculateExpiration('7d');
    assert.ok(d.getTime() - now >= 6 * 24 * 60 * 60 * 1000);
    const h = plugin.calculateExpiration('24h');
    assert.ok(h.getTime() - now >= 23 * 60 * 60 * 1000);
    const m = plugin.calculateExpiration('60m');
    assert.ok(m.getTime() - now >= 59 * 60 * 1000);
  });

  it('rejects values that would weaken or corrupt the key', async () => {
    let called = false;
    ApiKey.findByIdAndUpdate = async () => { called = true; return null; };
    await assert.rejects(plugin.execute({ action: 'update', keyId: 'k', expiresIn: 'forever' }), /Invalid expiration format/);
    await assert.rejects(plugin.execute({ action: 'update', keyId: 'k', expiresIn: null }), /expiresIn must be/);
    await assert.rejects(plugin.execute({ action: 'update', keyId: 'k', rateLimit: 0 }), /rateLimit must be/);
    await assert.rejects(plugin.execute({ action: 'update', keyId: 'k', rateLimit: 'abc' }), /rateLimit must be/);
    await assert.rejects(plugin.execute({ action: 'update', keyId: 'k', name: '  ' }), /name must be/);
    assert.equal(called, false, 'no write may happen on invalid input');
  });

  it('a mutation drops the cached key list; a list does not', async () => {
    plugin.cache.set('listKeys:{}', [{ name: 'stale' }]);
    await plugin.execute({ action: 'list' }).catch(() => {});
    assert.ok(plugin.cache.get('listKeys:{}'), 'list must not flush its own cache');
    ApiKey.findByIdAndUpdate = async () => ({ id: 'k', name: 'Fresh', description: '', rateLimit: 100, expiresAt: null });
    await plugin.execute({ action: 'update', keyId: 'k', name: 'Fresh' });
    assert.equal(plugin.cache.get('listKeys:{}'), undefined);
  });
});
