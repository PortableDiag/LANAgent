import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractParams, fallbackExtract } from '../../src/services/webtools/extractParams.js';

const mapsPlugin = (generateAux) => ({
  name: 'maps',
  commands: [{ command: 'timezone', description: 'Local time for a place', usage: 'timezone({ place: "Tokyo" })  // or lat/lon' }],
  agent: { providerManager: { generateAux } }
});

describe('extractParams pattern fallback', () => {
  test('the model answer wins when it is JSON', async () => {
    const input = 'what time is it in Tokyo';
    const r = await extractParams(mapsPlugin(async () => ({ content: '{"place":"Tokyo, Japan"}' })), 'timezone',
      { query: input, needsParameterExtraction: true, originalInput: input });
    assert.equal(r.place, 'Tokyo, Japan');
  });

  test('non-JSON model answer falls back to the timezone pattern', async () => {
    const input = 'what time is it in Tokyo';
    const r = await extractParams(mapsPlugin(async () => ({ content: 'not json' })), 'timezone',
      { query: input, needsParameterExtraction: true, originalInput: input });
    assert.equal(r.place, 'Tokyo');
    assert.equal(r.originalInput, input);
    assert.equal('query' in r, false);
  });

  test('a throwing model falls back too', async () => {
    const input = 'current time in Sydney?';
    const r = await extractParams(mapsPlugin(async () => { throw new Error('provider down'); }), 'timezone',
      { query: input, needsParameterExtraction: true, originalInput: input });
    assert.equal(r.place, 'Sydney');
  });

  test('no pattern match hands back the original params', async () => {
    const input = 'hello world';
    const params = { query: input, needsParameterExtraction: true, originalInput: input };
    const r = await extractParams(mapsPlugin(async () => ({ content: 'gibberish' })), 'timezone', params);
    assert.equal(r, params);
  });

  test('an action with no patterns is unchanged', async () => {
    const plugin = { ...mapsPlugin(async () => ({ content: 'x' })), commands: [{ command: 'geocode', usage: 'geocode({ query })' }] };
    const input = 'what time is it in Tokyo';
    const params = { query: input, needsParameterExtraction: true, originalInput: input };
    assert.equal(await extractParams(plugin, 'geocode', params), params);
  });
});

describe('fallbackExtract', () => {
  test('strips trailing filler and punctuation', () => {
    assert.deepEqual(fallbackExtract('maps.timezone', 'what time is it in tokyo right now'), { place: 'tokyo' });
    assert.deepEqual(fallbackExtract('maps.timezone', "what's the time in Paris?"), { place: 'Paris' });
    assert.deepEqual(fallbackExtract('maps.timezone', 'what time zone is denver in'), { place: 'denver' });
    assert.deepEqual(fallbackExtract('maps.timezone', 'local time in New York, please'), { place: 'New York' });
  });

  test('unknown key or no match returns null', () => {
    assert.equal(fallbackExtract('maps.weather', 'weather in Oslo'), null);
    assert.equal(fallbackExtract('maps.timezone', 'what time is it'), null);
  });
});
