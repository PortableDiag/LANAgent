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
  // Without a key, recipes come from TheMealDB (2026-11-09); only ingredient details still need Spoonacular.
  const noKey = await plugin.execute({ action: 'getIngredientInformation', ingredientId: 9266 });
  assert.equal(noKey.success, false);
  assert.match(noKey.error, /Spoonacular API key/);

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

test('findRecipesByIngredients calls the ingredient endpoint with normalized ingredients and defaults', async (t) => {
  const plugin = makePlugin();
  const calls = [];
  const origGet = axios.get;
  axios.get = async (url, config) => {
    calls.push({ url, params: config.params });
    return {
      data: [
        {
          id: 123,
          title: 'Tomato Basil Pasta',
          usedIngredients: [{ name: 'tomato' }],
          missedIngredients: []
        }
      ]
    };
  };
  t.after(() => { axios.get = origGet; });

  const result = await plugin.execute({
    action: 'findRecipesByIngredients',
    ingredients: [' Tomato  ', 'BASIL', 'tomato']
  });

  assert.equal(result.success, true);
  assert.equal(result.data[0].title, 'Tomato Basil Pasta');
  assert.match(calls[0].url, /\/recipes\/findByIngredients$/);
  assert.equal(calls[0].params.apiKey, 'test-key');
  assert.equal(calls[0].params.ingredients, 'basil,tomato');
  assert.equal(calls[0].params.number, 5);
  assert.equal(calls[0].params.ranking, 1);
  assert.equal(calls[0].params.ignorePantry, false);
});

test('findRecipesByIngredients supports ranking and ignorePantry and caches equivalent requests', async (t) => {
  const plugin = makePlugin();
  const calls = [];
  const origGet = axios.get;
  axios.get = async (url, config) => {
    calls.push({ url, params: config.params });
    return { data: [{ id: 456, title: 'Chicken Rice' }] };
  };
  t.after(() => { axios.get = origGet; });

  const params = {
    action: 'findRecipesByIngredients',
    ingredients: ['rice', 'chicken'],
    number: 3,
    ranking: 2,
    ignorePantry: true
  };

  const first = await plugin.execute(params);
  const second = await plugin.execute({
    ...params,
    ingredients: [' chicken ', 'RICE']
  });

  assert.equal(first.success, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.ingredients, 'chicken,rice');
  assert.equal(calls[0].params.number, 3);
  assert.equal(calls[0].params.ranking, 2);
  assert.equal(calls[0].params.ignorePantry, true);
});

test('findRecipesByIngredients rejects invalid ingredient lists', async () => {
  const plugin = makePlugin();

  const empty = await plugin.execute({
    action: 'findRecipesByIngredients',
    ingredients: []
  });
  assert.equal(empty.success, false);
  assert.match(empty.error, /non-empty array/);

  const invalidItem = await plugin.execute({
    action: 'findRecipesByIngredients',
    ingredients: ['tomato', 42]
  });
  assert.equal(invalidItem.success, false);
  assert.match(invalidItem.error, /each ingredient must be a string/);

  const invalidRanking = await plugin.execute({
    action: 'findRecipesByIngredients',
    ingredients: ['tomato'],
    ranking: 3
  });
  assert.equal(invalidRanking.success, false);
  assert.match(invalidRanking.error, /ranking must be either 1 or 2/);
});

test('findRecipesByIngredients accepts a comma-separated string from chat extraction', async () => {
  const { default: SpoonacularPlugin } = await import('../../src/api/plugins/spoonacular.js');
  const plugin = new SpoonacularPlugin({});
  plugin.config.apiKey = 'test';
  const axios = (await import('axios')).default;
  const original = axios.get;
  let sent;
  axios.get = async (url, cfg) => { sent = cfg.params; return { data: [{ id: 1 }] }; };
  try {
    const result = await plugin.findRecipesByIngredients({ ingredients: 'Chicken, rice and broccoli', number: '3' });
    assert.equal(result.success, true);
    assert.equal(sent.ingredients, 'broccoli,chicken,rice');
    assert.equal(sent.number, 3);
  } finally {
    axios.get = original;
  }
});

test('getIngredientInformation calls the ingredient information endpoint and caches results', async (t) => {
  const plugin = makePlugin();
  const calls = [];
  const origGet = axios.get;
  axios.get = async (url, config) => {
    calls.push({ url, params: config.params });
    return {
      data: {
        id: 9266,
        name: 'banana',
        amount: 100,
        unit: 'grams',
        nutrition: { nutrients: [{ name: 'Calories', amount: 89 }] }
      }
    };
  };
  t.after(() => { axios.get = origGet; });

  const result = await plugin.execute({
    action: 'getIngredientInformation',
    ingredientId: 9266,
    amount: 100,
    unit: 'grams'
  });

  assert.equal(result.success, true);
  assert.equal(result.data.name, 'banana');
  assert.match(calls[0].url, /\/food\/ingredients\/9266\/information$/);
  assert.deepEqual(calls[0].params, {
    apiKey: 'test-key',
    amount: 100,
    unit: 'grams'
  });

  const cached = await plugin.execute({
    action: 'getIngredientInformation',
    ingredientId: 9266,
    amount: 100,
    unit: ' grams '
  });
  assert.deepEqual(cached.data, result.data);
  assert.equal(calls.length, 1);
});

test('getIngredientInformation validates ingredient lookup parameters', async () => {
  const plugin = makePlugin();

  const missingId = await plugin.execute({
    action: 'getIngredientInformation',
    amount: 1,
    unit: 'banana'
  });
  assert.equal(missingId.success, false);
  assert.match(missingId.error, /Validation failed|ingredientId/);

  const invalidAmount = await plugin.execute({
    action: 'getIngredientInformation',
    ingredientId: 9266,
    amount: 0
  });
  assert.equal(invalidAmount.success, false);
  assert.match(invalidAmount.error, /amount must be a positive number/);

  const invalidUnit = await plugin.execute({
    action: 'getIngredientInformation',
    ingredientId: 9266,
    unit: '   '
  });
  assert.equal(invalidUnit.success, false);
  assert.match(invalidUnit.error, /unit must not be empty/);
});
