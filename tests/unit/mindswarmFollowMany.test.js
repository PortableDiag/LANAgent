import { test } from 'node:test';
import assert from 'node:assert/strict';
import MindSwarmPlugin, { mindswarmUsernames } from '../../src/api/plugins/mindswarm.js';

function rig(responses = {}) {
  const p = new MindSwarmPlugin({ providerManager: null });
  p.accessToken = 'tok';
  p.username = 'alice_lanagent';
  p.pluginLogger = { info() {}, warn() {}, error() {} };
  const calls = [];
  p._apiRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = responses[`${method} ${path}`];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(body);
    return { data: r ?? { success: true } };
  };
  return { p, calls };
}
const apiError = (msg) => Object.assign(new Error('Request failed'), { response: { data: { error: msg } } });

test('mindswarmUsernames: every shape models produce, deduped (2026-10-31)', () => {
  assert.deepEqual(mindswarmUsernames({ 0: { username: 'orbit' }, 1: { username: 'bolt' }, 2: { username: 'nexus' } }), ['orbit', 'bolt', 'nexus']);
  assert.deepEqual(mindswarmUsernames({ usernames: ['@Orbit', 'https://mindswarm.net/bolt', 'orbit'] }), ['Orbit', 'bolt']);
  assert.deepEqual(mindswarmUsernames({ username: 'orbit, bolt and nexus' }), ['orbit', 'bolt', 'nexus']);
  assert.deepEqual(mindswarmUsernames({}, 'Follow https://mindswarm.net/orbit, https://mindswarm.net/bolt.'), ['orbit', 'bolt']);
  assert.deepEqual(mindswarmUsernames({}), []);
});

test('follow: several accounts in one request; one already followed, one failing', async () => {
  const { p, calls } = rig({ 'post /users/bolt/follow': apiError('Already following this user'), 'post /users/nexus/follow': apiError('User not found') });
  const r = await p.execute({ action: 'follow', 0: { username: 'orbit' }, 1: { username: 'bolt' }, 2: { username: 'nexus' } });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(calls.filter(c => c.method === 'post').map(c => c.path), ['/users/orbit/follow', '/users/bolt/follow', '/users/nexus/follow']);
  assert.match(r.message, /Followed @orbit/);
  assert.match(r.message, /Already following @bolt/);
  assert.match(r.message, /Couldn't follow @nexus \(User not found\)/);
});

test('follow with no account named asks which one, without calling the API', async () => {
  const { p, calls } = rig();
  const r = await p.execute({ action: 'follow' });
  assert.equal(r.success, false);
  assert.match(r.error, /Which MindSwarm account/);
  assert.equal(calls.length, 0);
});

test('follow + "accept their follow requests" accepts only those accounts\' requests', async () => {
  const { p, calls } = rig({
    'get /users/follow-requests': { data: [{ _id: 'r1', requester: { username: 'orbit' } }, { _id: 'r2', requester: { username: 'stranger' } }] }
  });
  const r = await p.execute({ action: 'follow', usernames: ['orbit', 'nexus'], _context: { originalInput: 'follow orbit and nexus and accept their follow requests' } });
  assert.equal(r.success, true, JSON.stringify(r));
  const accepts = calls.filter(c => c.path.startsWith('/users/follow-requests/'));
  assert.deepEqual(accepts.map(c => [c.path, c.body]), [['/users/follow-requests/r1', { action: 'accept' }]]);
  assert.match(r.message, /Accepted follow requests from @orbit/);
});

test('getFollowing answers in words, and per account when asked whether it follows them', async () => {
  const { p } = rig({ 'get /users/alice_lanagent/following': { following: [{ username: 'orbit' }], total: 1, pagination: { hasMore: false } } });
  const all = await p.execute({ action: 'getFollowing' });
  assert.equal(all.message, 'I follow 1 account on MindSwarm: @orbit.');
  const some = await p.execute({ action: 'getFollowing', check: ['Orbit', 'nexus'] });
  assert.equal(some.message, "I follow @Orbit on MindSwarm. I don't follow @nexus.");
  const { p: empty } = rig({ 'get /users/alice_lanagent/following': { following: [], total: 0, pagination: { hasMore: false } } });
  assert.equal((await empty.execute({ action: 'getFollowing' })).message, "I don't follow anyone on MindSwarm yet.");
});

test('getFollowing: the agent\'s own name as "username" means its own list (2026-10-31 "@Alice doesn\'t follow")', async () => {
  const { p, calls } = rig({ 'get /users/alice_lanagent/following': { following: [{ username: 'orbit' }], total: 1, pagination: { hasMore: false } } });
  p.agent = { config: { name: 'ALICE' } };
  const r = await p.execute({ action: 'getFollowing', username: 'Alice', check: ['nexus', 'orbit'] });
  assert.equal(calls[0].path, '/users/alice_lanagent/following');
  assert.equal(r.message, "I follow @orbit on MindSwarm. I don't follow @nexus.");
});

test('followers and follow requests answer in words', async () => {
  const { p } = rig({
    'get /users/alice_lanagent/followers': { followers: [{ username: 'orbit' }, { username: 'nexus' }], total: 2 },
    'get /users/follow-requests': { requests: [], pagination: { hasMore: false } }
  });
  assert.equal((await p.execute({ action: 'getFollowers' })).message, 'I have 2 followers on MindSwarm: @orbit, @nexus.');
  assert.equal((await p.execute({ action: 'getFollowRequests' })).message, 'No pending follow requests on MindSwarm.');
});

test('following a private account says a request was sent, not "Followed" (nexus, 2026-10-31)', async () => {
  const { p } = rig({
    'get /users/nexus': { success: true, data: { user: { username: 'nexus', profile: { private: true } }, isPrivate: true } },
    'get /users/bolt': { success: true, data: { user: { username: 'bolt' }, isPrivate: false } }
  });
  const r = await p.execute({ action: 'follow', usernames: ['nexus', 'bolt'] });
  assert.equal(r.success, true);
  assert.match(r.message, /^Followed @bolt on MindSwarm\./);
  assert.match(r.message, /Follow request to @nexus is waiting for approval: a private account/);
  assert.ok(!/Followed @nexus/.test(r.message));
});

test('"Already following" from a private account that has not approved yet is a pending request', async () => {
  const { p } = rig({
    'post /users/nexus/follow': apiError('Already following this user'),
    'get /users/nexus': { success: true, data: { user: { username: 'nexus' }, isPrivate: true } },
    'post /users/orbit/follow': apiError('Already following this user'),
    'get /users/orbit': { success: true, data: { user: { username: 'orbit' }, isPrivate: true } },
    'get /users/alice_lanagent/following': { following: [{ username: 'orbit' }], pagination: { hasMore: false } }
  });
  const r = await p.execute({ action: 'follow', usernames: ['nexus', 'orbit'] });
  assert.match(r.message, /Follow request to @nexus is waiting for approval/);
  assert.match(r.message, /Already following @orbit/);
});
