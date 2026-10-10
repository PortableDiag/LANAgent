import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import WhoisPlugin from '../../src/api/plugins/whois.js';

describe('WhoisPlugin SSL expiration alerts', () => {
  let plugin;
  let mockAgent;
  let mockScheduler;
  let scheduleCalls;
  let cancelCalls;

  beforeEach(() => {
    scheduleCalls = [];
    cancelCalls = [];
    mockScheduler = {
      agenda: {
        define: () => {},
        schedule: (date, name, data) => {
          scheduleCalls.push({ date, name, data });
        },
        cancel: (query) => {
          cancelCalls.push(query);
          return Promise.resolve(1);
        }
      }
    };
    mockAgent = {
      services: {
        get: (name) => name === 'taskScheduler' ? mockScheduler : undefined
      },
      notify: () => {}
    };
    plugin = new WhoisPlugin(mockAgent);
    const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    plugin.getSslInfo = async (domain) => ({
      success: true,
      data: {
        domain,
        validTo: futureDate.toISOString(),
        valid: true,
        issuer: 'Test CA',
        subject: 'test.example.com',
        validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        serialNumber: '123',
        version: 3,
        signatureAlgorithm: 'sha256WithRSAEncryption',
        subjectAlternativeNames: ['test.example.com']
      }
    });
  });

  it('should schedule SSL expiration alert with correct parameters', async () => {
    const domain = 'example.com';
    const daysBefore = 30;
    const result = await plugin.setSslExpirationAlert(domain, daysBefore);
    assert.ok(result.success);
    assert.equal(cancelCalls.length, 1);
    assert.deepStrictEqual(cancelCalls[0], { name: 'whois-ssl-expiration-alert', 'data.domain': domain });
    assert.equal(scheduleCalls.length, 1);
    const call = scheduleCalls[0];
    assert.equal(call.name, 'whois-ssl-expiration-alert');
    assert.equal(call.data.domain, domain);
    assert.equal(call.data.daysBefore, daysBefore);
    const expectedAlertTime = new Date(Date.now() + (90 - daysBefore) * 24 * 60 * 60 * 1000).getTime();
    const actualAlertTime = call.date.getTime();
    assert.ok(Math.abs(actualAlertTime - expectedAlertTime) < 1000, 'Alert date should be expiration minus daysBefore');
  });

  it('should return error if scheduler not available', async () => {
    plugin.scheduler = undefined;
    const result = await plugin.setSslExpirationAlert('example.com', 30);
    assert.equal(result.success, false);
    assert.match(result.error, /Scheduler not available/);
  });

  it('should return error if SSL info fetch fails', async () => {
    plugin.getSslInfo = async () => ({ success: false, error: 'SSL lookup failed' });
    const result = await plugin.setSslExpirationAlert('example.com', 30);
    assert.equal(result.success, false);
    assert.match(result.error, /Failed to read SSL expiration date/);
  });

  it('should return error if SSL validTo is missing', async () => {
    plugin.getSslInfo = async () => ({ success: true, data: { domain: 'example.com' } });
    const result = await plugin.setSslExpirationAlert('example.com', 30);
    assert.equal(result.success, false);
    assert.match(result.error, /no validTo field/);
  });

  it('should return error if alert date is in the past', async () => {
    const pastExpiration = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    plugin.getSslInfo = async () => ({
      success: true,
      data: { domain: 'example.com', validTo: pastExpiration.toISOString() }
    });
    const result = await plugin.setSslExpirationAlert('example.com', 30);
    assert.equal(result.success, false);
    assert.match(result.error, /Alert date is in the past/);
  });

  it('should cancel SSL expiration alert', async () => {
    const domain = 'example.com';
    const result = await plugin.cancelSslExpirationAlert(domain);
    assert.ok(result.success);
    assert.equal(result.cancelled, 1);
    assert.equal(cancelCalls.length, 1);
    assert.deepStrictEqual(cancelCalls[0], { name: 'whois-ssl-expiration-alert', 'data.domain': domain });
  });

  it('should return error on cancel if scheduler not available', async () => {
    plugin.scheduler = undefined;
    const result = await plugin.cancelSslExpirationAlert('example.com');
    assert.equal(result.success, false);
    assert.match(result.error, /Scheduler not available/);
  });
  it('alert job: renewed certificate reschedules instead of notifying', async () => {
    const notes = [];
    mockAgent.notify = async (m) => { notes.push(m); };
    plugin.whoisjson = {};
    const oldExpiry = new Date(Date.now() + 5 * 864e5).toISOString();
    await plugin.handleSslExpirationAlert({ attrs: { _id: 'job1', data: { domain: 'example.com', expiresAt: oldExpiry, daysBefore: 30 } } });
    assert.equal(notes.length, 0);
    assert.equal(scheduleCalls.length, 1);
    assert.deepStrictEqual(cancelCalls[0], { name: 'whois-ssl-expiration-alert', 'data.domain': 'example.com', _id: { $ne: 'job1' } });
  });

  it('alert job: unrenewed certificate notifies', async () => {
    const notes = [];
    mockAgent.notify = async (m) => { notes.push(m); };
    plugin.whoisjson = {};
    const expiry = new Date(Date.now() + 90 * 864e5).toISOString(); // same as live validTo (within a day)
    await plugin.handleSslExpirationAlert({ attrs: { _id: 'j', data: { domain: 'example.com', expiresAt: expiry, daysBefore: 30 } } });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /SSL certificate expiration warning: example.com/);
    assert.equal(scheduleCalls.length, 0);
  });

  it('alert job: failed live re-check still notifies', async () => {
    const notes = [];
    mockAgent.notify = async (m) => { notes.push(m); };
    plugin.whoisjson = {};
    plugin.getSslInfo = async () => { throw new Error('network'); };
    await plugin.handleSslExpirationAlert({ attrs: { data: { domain: 'example.com', expiresAt: new Date().toISOString(), daysBefore: 30 } } });
    assert.equal(notes.length, 1);
  });

  it('rejects non-positive daysBefore', async () => {
    const r = await plugin.setSslExpirationAlert('example.com', 0);
    assert.equal(r.success, false);
    assert.equal(scheduleCalls.length, 0);
  });

  it('execute coerces a numeric-string daysBefore from AI extraction', async () => {
    plugin.whoisjson = {};
    const r = await plugin.execute({ action: 'setSslExpirationAlert', domain: 'example.com', daysBefore: '30' });
    assert.ok(r.success, r.error);
    assert.equal(scheduleCalls[0].data.daysBefore, 30);
  });
});
