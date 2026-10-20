import test from 'node:test';
import assert from 'node:assert/strict';
import { MCPToken } from '../../src/models/MCPToken.js';
import { logger } from '../../src/utils/logger.js';

function sourceDoc(overrides = {}) {
  return new MCPToken({
    name: 'client',
    token: 'hashed-old',
    lookupKey: 'old-key',
    tokenPrefix: 'mcp_abcd...',
    permissions: ['system', 'network'],
    allowedTools: ['ping'],
    deniedTools: ['shell'],
    rateLimit: { requests: 5, window: 1000 },
    createdBy: 'api',
    description: 'desc',
    usageThreshold: 50,
    active: true,
    ...overrides
  });
}

function stub(t, source, { updateResult = 'match', updateThrows = false } = {}) {
  const saved = [];
  const deleted = [];
  const updates = [];
  t.mock.method(MCPToken, 'findById', async () => source);
  t.mock.method(MCPToken.prototype, 'save', async function() { saved.push(this); return this; });
  t.mock.method(MCPToken, 'findOneAndUpdate', async (filter, update) => {
    updates.push({ filter, update });
    if (updateThrows) throw new Error('db down');
    return updateResult === 'match' ? { ...source.toObject(), ...update.$set } : null;
  });
  t.mock.method(MCPToken, 'deleteOne', async (filter) => { deleted.push(filter); return { deletedCount: 1 }; });
  return { saved, deleted, updates };
}

test('rotateToken copies the access policy and conditionally invalidates the original', async (t) => {
  const expiresAt = new Date(Date.now() + 3_600_000);
  const source = sourceDoc({ expiresAt });
  const { saved, updates, deleted } = stub(t, source);

  const result = await MCPToken.rotateToken(source._id);

  assert.match(result.token, /^mcp_[0-9a-f]{64}$/);
  assert.equal(saved.length, 1);
  const repl = saved[0];
  assert.notEqual(String(repl._id), String(source._id));
  assert.notEqual(repl.token, result.token, 'plaintext must not be stored');
  assert.deepEqual([...repl.permissions], ['system', 'network']);
  assert.deepEqual([...repl.allowedTools], ['ping']);
  assert.deepEqual([...repl.deniedTools], ['shell']);
  assert.equal(repl.rateLimit.requests, 5);
  assert.equal(repl.usageThreshold, 50);
  assert.equal(repl.expiresAt.getTime(), expiresAt.getTime());
  assert.equal(repl.active, true);

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filter, { _id: source._id, active: true });
  assert.equal(updates[0].update.$set.active, false);
  assert.equal(updates[0].update.$set.revocationReason, 'Token rotated');
  assert.equal(deleted.length, 0);
  assert.equal(result.display.id, repl._id);
});

test('rotateToken refuses a revoked or expired token without creating anything', async (t) => {
  const revoked = sourceDoc({ active: false });
  const s1 = stub(t, revoked);
  await assert.rejects(MCPToken.rotateToken(revoked._id), /revoked/);
  assert.equal(s1.saved.length, 0);
  t.mock.restoreAll();

  const expired = sourceDoc({ expiresAt: new Date(Date.now() - 1000) });
  const s2 = stub(t, expired);
  await assert.rejects(MCPToken.rotateToken(expired._id), /expired/);
  assert.equal(s2.saved.length, 0);
});

test('rotateToken removes the replacement when the original was rotated concurrently', async (t) => {
  const source = sourceDoc();
  const { saved, deleted } = stub(t, source, { updateResult: 'none' });
  await assert.rejects(MCPToken.rotateToken(source._id), /concurrently/);
  assert.equal(saved.length, 1);
  assert.deepEqual(deleted, [{ _id: saved[0]._id }]);
});

test('rotateToken removes the replacement when invalidation fails', async (t) => {
  const source = sourceDoc();
  const { saved, deleted } = stub(t, source, { updateThrows: true });
  await assert.rejects(MCPToken.rotateToken(source._id), /db down/);
  assert.deepEqual(deleted, [{ _id: saved[0]._id }]);
});

test('rotateToken honours expiresIn overrides and validates them', async (t) => {
  const source = sourceDoc({ expiresAt: new Date(Date.now() + 1000) });
  const { saved } = stub(t, source);
  await MCPToken.rotateToken(source._id, { expiresIn: null });
  assert.equal(saved[0].expiresAt, null);
  await assert.rejects(MCPToken.rotateToken(source._id, { expiresIn: -5 }), TypeError);
  await assert.rejects(MCPToken.rotateToken(source._id, { name: '  ' }), TypeError);
});

// ---------------------------------------------------------------------------
// IP allow / block list tests
// ---------------------------------------------------------------------------

test('isIpAllowed returns false for an invalid IP on a restricted token', async (t) => {
  const token = new MCPToken({
    name: 'test',
    token: 'hash',
    tokenPrefix: 'mcp_...',
    allowedIps: ['10.0.0.0/8'],
    blockedIps: []
  });
  t.mock.method(logger, 'warn', () => {});
  const result = token.isIpAllowed('not-an-ip');
  assert.equal(result, false);
  assert.equal(logger.warn.mock.calls.length, 1);
});

test('isIpAllowed blocks IP matching blocked CIDR', async (t) => {
  const token = new MCPToken({
    name: 'test',
    token: 'hash',
    tokenPrefix: 'mcp_...',
    blockedIps: ['192.168.1.0/24']
  });
  t.mock.method(logger, 'debug', () => {});
  const result = token.isIpAllowed('192.168.1.5');
  assert.equal(result, false);
});

test('isIpAllowed allows IP not in blocked list and no allow list', async (t) => {
  const token = new MCPToken({
    name: 'test',
    token: 'hash',
    tokenPrefix: 'mcp_...',
    blockedIps: ['10.0.0.0/8']
  });
  const result = token.isIpAllowed('192.168.1.5');
  assert.equal(result, true);
});

test('isIpAllowed denies IP not in allow list when allow list is set', async (t) => {
  const token = new MCPToken({
    name: 'test',
    token: 'hash',
    tokenPrefix: 'mcp_...',
    allowedIps: ['10.0.0.0/8']
  });
  const result = token.isIpAllowed('192.168.1.5');
  assert.equal(result, false);
});

test('isIpAllowed allows IP in allow list', async (t) => {
  const token = new MCPToken({
    name: 'test',
    token: 'hash',
    tokenPrefix: 'mcp_...',
    allowedIps: ['192.168.1.0/24', '10.0.0.0/8']
  });
  const result = token.isIpAllowed('192.168.1.5');
  assert.equal(result, true);
});

test('isIpAllowed blocked list takes precedence over allow list', async (t) => {
  const token = new MCPToken({
    name: 'test',
    token: 'hash',
    tokenPrefix: 'mcp_...',
    allowedIps: ['192.168.0.0/16'],
    blockedIps: ['192.168.1.0/24']
  });
  t.mock.method(logger, 'debug', () => {});
  const result = token.isIpAllowed('192.168.1.5');
  assert.equal(result, false);
});

test('isIpAllowed supports IPv6', async (t) => {
  const token = new MCPToken({
    name: 'test',
    token: 'hash',
    tokenPrefix: 'mcp_...',
    allowedIps: ['2001:db8::/32']
  });
  const result = token.isIpAllowed('2001:db8::1');
  assert.equal(result, true);
  const result2 = token.isIpAllowed('2001:db9::1');
  assert.equal(result2, false);
});

test('rotateToken copies IP allow/block lists', async (t) => {
  const source = sourceDoc({
    allowedIps: ['10.0.0.0/8'],
    blockedIps: ['10.0.1.0/24']
  });
  const { saved } = stub(t, source);
  await MCPToken.rotateToken(source._id);
  const repl = saved[0];
  assert.deepEqual([...repl.allowedIps], ['10.0.0.0/8']);
  assert.deepEqual([...repl.blockedIps], ['10.0.1.0/24']);
});

test('isIpAllowed matches IPv4-mapped peers and bare host entries', () => {
  const token = new MCPToken({ name: 'test', token: 'hash', tokenPrefix: 'mcp_...', allowedIps: ['203.0.113.7'] });
  assert.equal(token.isIpAllowed('::ffff:203.0.113.7'), true);
  assert.equal(token.isIpAllowed('203.0.113.8'), false);
});

test('isIpAllowed allows an unrestricted token even when the peer address is unknown', () => {
  const token = new MCPToken({ name: 'test', token: 'hash', tokenPrefix: 'mcp_...' });
  assert.equal(token.isIpAllowed(undefined), true);
});

test('generateToken validates and stores IP lists', async (t) => {
  t.mock.method(MCPToken.prototype, 'save', async function() { return this; });
  const { doc } = await MCPToken.generateToken({ name: 'n', allowedIps: [' 10.0.0.0/8 ', '2001:db8::/32'], blockedIps: ['10.0.0.1'] });
  assert.deepEqual([...doc.allowedIps], ['10.0.0.0/8', '2001:db8::/32']);
  assert.deepEqual([...doc.blockedIps], ['10.0.0.1']);
  await assert.rejects(MCPToken.generateToken({ name: 'n', allowedIps: ['10.0.0.0/33'] }), TypeError);
  await assert.rejects(MCPToken.generateToken({ name: 'n', blockedIps: ['not-an-ip'] }), TypeError);
  await assert.rejects(MCPToken.generateToken({ name: 'n', allowedIps: '10.0.0.0/8' }), TypeError);
});
