import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureRequest } from '../../src/models/FeatureRequest.js';
import { setupFeatureRequestRoutes } from '../../src/interfaces/web/featureRequests.js';

const original = FeatureRequest.findOneAndUpdate;
afterEach(() => { FeatureRequest.findOneAndUpdate = original; });

describe('FeatureRequest upvote/downvote', () => {
  it('upvote is one atomic $inc of +1', async () => {
    const calls = [];
    FeatureRequest.findOneAndUpdate = async (...args) => { calls.push(args); return { _id: '123', votes: 6 }; };
    const doc = await FeatureRequest.upvote('123');
    assert.equal(doc.votes, 6);
    assert.deepEqual(calls, [[{ _id: '123' }, { $inc: { votes: 1 } }, { new: true }]]);
  });

  it('downvote is one atomic $inc of -1', async () => {
    const calls = [];
    FeatureRequest.findOneAndUpdate = async (...args) => { calls.push(args); return { _id: '456', votes: 2 }; };
    await FeatureRequest.downvote('456');
    assert.deepEqual(calls[0][1], { $inc: { votes: -1 } });
  });

  it('returns null for a missing request', async () => {
    FeatureRequest.findOneAndUpdate = async () => null;
    assert.equal(await FeatureRequest.upvote('missing'), null);
  });

  it('a failed write is NOT retried ($inc is not idempotent)', async () => {
    let n = 0;
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    FeatureRequest.findOneAndUpdate = async () => { n++; throw err; };
    await assert.rejects(FeatureRequest.upvote('123'), e => e === err);
    assert.equal(n, 1);
  });
});

describe('POST /api/feature-requests/:id/vote', () => {
  const routes = {};
  const app = new Proxy({}, { get: (_, method) => (path, ...handlers) => { routes[`${method} ${path}`] = handlers.at(-1); } });
  setupFeatureRequestRoutes(app, {});
  const vote = routes['post /api/feature-requests/:id/vote'];
  const call = async (id, body) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await vote({ params: { id }, body }, res);
    return res;
  };

  it('uses the atomic static and returns the new count', async () => {
    FeatureRequest.findOneAndUpdate = async (_f, u) => ({ votes: 10 + u.$inc.votes });
    const r = await call('abc', { direction: 'down' });
    assert.equal(r.code, 200);
    assert.equal(r.body.data.votes, 9);
  });

  it('404 for a missing request, 400 for a bad direction', async () => {
    FeatureRequest.findOneAndUpdate = async () => null;
    assert.equal((await call('nope', { direction: 'up' })).code, 404);
    assert.equal((await call('abc', { direction: 'sideways' })).code, 400);
  });
});
