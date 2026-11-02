import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../../src/api/external/routes/catalog.js';

// Express matches routes in registration order. GET /actions registered after
// GET /:serviceId is read as serviceId='actions' and its handler never runs.
test('GET /actions is registered before GET /:serviceId', () => {
  const paths = router.stack.filter(l => l.route).map(l => l.route.path);
  const actions = paths.indexOf('/actions');
  const byId = paths.indexOf('/:serviceId');
  assert.ok(actions >= 0, 'GET /actions exists');
  assert.ok(byId >= 0, 'GET /:serviceId exists');
  assert.ok(actions < byId, `/actions (${actions}) must precede /:serviceId (${byId})`);
});
