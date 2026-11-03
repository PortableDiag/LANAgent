import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import FREDPlugin from '../../src/api/plugins/fred.js';

const mockAgent = {
  logger: { info() {}, warn() {}, error() {} },
  providerManager: null
};

describe('FREDPlugin - getLatestObservation', () => {
  let plugin;
  let originalAxiosGet;

  before(() => {
    originalAxiosGet = axios.get;
  });

  after(() => {
    axios.get = originalAxiosGet;
  });

  it('should return the latest observation with date and value', async () => {
    plugin = new FREDPlugin(mockAgent);
    plugin.config.apiKey = 'test-key';

    const mockResponse = {
      data: {
        observations: [
          { date: '2024-01-01', value: '123.45' }
        ]
      }
    };

    axios.get = async () => mockResponse;

    const result = await plugin.getLatestObservation({ seriesId: 'GDP' });
    assert.equal(result.success, true);
    assert.equal(result.data.date, '2024-01-01');
    assert.equal(result.data.value, '123.45');
    assert.equal(result.fromCache, undefined); // first call not cached
  });

  it('should cache the result and return from cache on second call', async () => {
    plugin = new FREDPlugin(mockAgent);
    plugin.config.apiKey = 'test-key';

    let callCount = 0;
    axios.get = async () => {
      callCount++;
      return {
        data: {
          observations: [{ date: '2024-02-01', value: '99.9' }]
        }
      };
    };

    const first = await plugin.getLatestObservation({ seriesId: 'UNRATE' });
    assert.equal(first.success, true);
    assert.equal(callCount, 1);

    const second = await plugin.getLatestObservation({ seriesId: 'UNRATE' });
    assert.equal(second.success, true);
    assert.equal(second.fromCache, true);
    assert.equal(callCount, 1); // no additional API call
  });

  it('should throw an error when no observations are returned', async () => {
    plugin = new FREDPlugin(mockAgent);
    plugin.config.apiKey = 'test-key';

    axios.get = async () => ({ data: { observations: [] } });

    await assert.rejects(
      () => plugin.getLatestObservation({ seriesId: 'GDP' }),
      /No observations found/
    );
  });

  it('should throw an error when the API call fails', async () => {
    plugin = new FREDPlugin(mockAgent);
    plugin.config.apiKey = 'test-key';

    axios.get = async () => { throw new Error('Network error'); };

    await assert.rejects(
      () => plugin.getLatestObservation({ seriesId: 'GDP' }),
      /Failed to fetch latest observation/
    );
  });

  it('skips FRED\'s "." placeholder for a missing value', async () => {
    plugin = new FREDPlugin(mockAgent);
    plugin.config.apiKey = 'test-key';
    let sent;
    axios.get = async (_url, opts) => {
      sent = opts.params;
      return { data: { observations: [{ date: '2026-11-03', value: '.' }, { date: '2026-11-02', value: '4.33' }] } };
    };
    const r = await plugin.getLatestObservation({ seriesId: 'DFF' });
    assert.equal(r.data.date, '2026-11-02');
    assert.equal(r.data.value, '4.33');
    assert.equal(sent.sort_order, 'desc');
  });
});
