import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import VonagePlugin from '../../src/api/plugins/vonage.js';
import { logger } from '../../src/utils/logger.js';

describe('VonagePlugin numberinsight', () => {
  let plugin;
  let originalGet;
  let originalInfo;
  let originalError;
  let lastCall;

  before(() => {
    process.env.VONAGE_API_KEY = 'test-key';
    process.env.VONAGE_API_SECRET = 'test-secret';
    plugin = new VonagePlugin({});
    originalGet = axios.get;
    originalInfo = logger.info;
    originalError = logger.error;
    logger.info = () => {};
    logger.error = () => {};
  });

  after(() => {
    axios.get = originalGet;
    logger.info = originalInfo;
    logger.error = originalError;
    delete process.env.VONAGE_API_KEY;
    delete process.env.VONAGE_API_SECRET;
  });

  const stub = (data) => {
    axios.get = async (url, opts) => { lastCall = { url, opts }; return { data }; };
  };

  it('basic lookup hits api.nexmo.com and returns country/formatting, no carrier fields', async () => {
    // Shape of a real Number Insight Basic response: no current_carrier.
    stub({
      status: 0,
      status_message: 'Success',
      international_format_number: '15550100000',
      national_format_number: '(555) 010-0000',
      country_code: 'US',
      country_code_iso3: 'USA',
      country_name: 'United States of America',
      country_prefix: '1'
    });
    const result = await plugin.execute({ action: 'numberinsight', number: '15550100000' });
    assert.equal(result.success, true);
    assert.equal(lastCall.url, 'https://api.nexmo.com/ni/basic/json');
    assert.equal(lastCall.opts.params.number, '15550100000');
    assert.deepEqual(result.data, {
      level: 'basic',
      internationalNumber: '15550100000',
      nationalNumber: '(555) 010-0000',
      country: 'United States of America',
      countryCode: 'US',
      countryPrefix: '1'
    });
    assert.equal('network' in result.data, false);
  });

  it('standard lookup returns carrier and line type', async () => {
    stub({
      status: 0,
      country_name: 'United States of America',
      country_code: 'US',
      current_carrier: { name: 'Example Carrier', network_type: 'mobile' },
      ported: 'not_ported',
      request_price: '0.00500000'
    });
    const result = await plugin.execute({ action: 'numberinsight', number: '15550100000', level: 'standard' });
    assert.equal(result.success, true);
    assert.equal(lastCall.url, 'https://api.nexmo.com/ni/standard/json');
    assert.equal(result.data.network, 'Example Carrier');
    assert.equal(result.data.type, 'mobile');
    assert.equal(result.data.ported, 'not_ported');
  });

  it('unknown level falls back to basic', async () => {
    stub({ status: 0, country_name: 'Canada' });
    await plugin.execute({ action: 'numberinsight', number: '15550100001', level: 'advanced' });
    assert.equal(lastCall.url, 'https://api.nexmo.com/ni/basic/json');
  });

  it('non-zero status is an error', async () => {
    stub({ status: 3, status_message: 'Invalid request' });
    const result = await plugin.execute({ action: 'numberinsight', number: 'bad' });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid request/);
  });

  it('network failure is an error', async () => {
    axios.get = async () => { throw new Error('Network error'); };
    const result = await plugin.execute({ action: 'numberinsight', number: '15550100000' });
    assert.equal(result.success, false);
    assert.match(result.error, /Network error/);
  });

  it('missing number is rejected', async () => {
    const result = await plugin.execute({ action: 'numberinsight' });
    assert.equal(result.success, false);
    assert.match(result.error, /number/);
  });
});
