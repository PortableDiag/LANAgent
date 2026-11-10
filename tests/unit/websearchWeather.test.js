// Weather: a remark from the extractor is not a city (2026-11-09: "The sentence does not specify a particular location.").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSearchPlugin from '../../src/api/plugins/websearch.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

test('only a place name counts as a location', () => {
  for (const bad of ['', null, 'The sentence does not specify a particular location.', 'unknown', 'none', "user's location", 'current location', 'here'])
    assert.equal(WebSearchPlugin.placeOf(bad), null, String(bad));
  for (const ok of ['London', 'New York', 'Portland, OR', 'San Luis Obispo']) assert.equal(WebSearchPlugin.placeOf(ok), ok);
});

test('no place: the owner is asked, a paid caller gets an error, and neither reads or calls wttr.in', async () => {
  const get = PluginSettings.getCached;
  PluginSettings.getCached = async () => null;
  const saved = process.env.WEATHER_DEFAULT_LOCATION; delete process.env.WEATHER_DEFAULT_LOCATION;
  try {
    const p = new WebSearchPlugin({});
    const own = await p.getWeather('The sentence does not specify a particular location.');
    assert.equal(own.success, true); assert.equal(own.needsInput, true); assert.match(own.result, /Which city/);
    const paid = await p.getWeather('unknown', { external: true });
    assert.equal(paid.success, false); assert.match(paid.error, /location is required/);
  } finally { PluginSettings.getCached = get; if (saved) process.env.WEATHER_DEFAULT_LOCATION = saved; }
});
