import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import SpoonacularPlugin from '../../src/api/plugins/spoonacular.js';

const makePlugin = () => {
  const plugin = new SpoonacularPlugin({ providerManager: null });
  plugin.config.apiKey = 'test-key'; // skip initialize() — no mongo/env needed
  return plugin;
};

test('plugin structure matches the apiManager contract', () => {
  const plugin = makePlugin();
  assert.equal(plugin.name, 'spoonacular');
  assert.equal(typeof plugin.version, 'string');
  assert.equal(typeof plugin.execute, 'function');
  assert.ok(plugin.commands.length > 0);
  for (const cmd of plugin.commands) {
    assert.equal(typeof cmd.command, 'string');
    assert.equal(typeof cmd.description, 'string');
    assert.ok(Array.isArray(cmd.examples));
  }
});

test('searchRecipes hits complexSearch, applies default number, caches', async (t) => {
  const plugin = makePlugin();
  const calls = [];
  const origGet = axios.get;
  axios.get = async (url, config) => {
    calls.push({ url, params: config.params });
    return { data: { results: [{ id: 1, title: 'Pasta' }] } };
  };
  t.after(() => { axios.get = origGet; });

  const result = await plugin.execute({ action: 'searchRecipes', query: 'pasta' });
  assert.equal(result.success, true);
  assert.equal(result.data.results[0].title, 'Pasta');
  assert.match(calls[0].url, /\/recipes\/complexSearch$/);
  assert.equal(calls[0].params.number, 5); // declared default applied
  assert.equal(calls[0].params.query, 'pasta');

  // second identical call served from cache — no new HTTP call
  await plugin.execute({ action: 'searchRecipes', query: 'pasta' });
  assert.equal(calls.length, 1);
});

test('execute returns success:false on missing API key and unknown action', async () => {
  const plugin = makePlugin();
  plugin.config.apiKey = null;
  const noKey = await plugin.execute({ action: 'getRandomRecipes' });
  assert.equal(noKey.success, false);
  assert.match(noKey.error, /API key not configured/);

  await assert.rejects(
    () => makePlugin().execute({ action: 'notARealAction' }),
    /Validation failed/
  );
});

test('getRecipeInformation requires a numeric id', async () => {
  const plugin = makePlugin();
  const result = await plugin.execute({ action: 'getRecipeInformation' });
  assert.equal(result.success, false);
  assert.match(result.error, /Validation failed|id/);
});
