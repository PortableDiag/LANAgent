import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import IpifyPlugin from '../../src/api/plugins/ipifyorg.js';

test('detects a public IPv6 address using the IPv6 endpoint', async () => {
  const originalGet = axios.get;
  const calls = [];

  axios.get = async (url) => {
    calls.push(url);
    return { data: { ip: '2001:db8::1234' } };
  };

  try {
    const plugin = new IpifyPlugin({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      }
    });

    const result = await plugin.getPublicIpByProtocol({ protocol: 'v6' });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /api6\.ipify\.org/);
    assert.equal(result.success, true);
    assert.equal(result.data.addresses.v6.address, '2001:db8::1234');
    assert.equal(result.partial, undefined);
  } finally {
    axios.get = originalGet;
  }
});

const quiet = { logger: { info() {}, warn() {}, error() {}, debug() {} } };

test('dual returns a partial result when only IPv4 answers', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (/api6/.test(url)) { const e = new Error('no v6'); e.response = { status: 400 }; throw e; }
    return { data: { ip: '203.0.113.7' } };
  };
  try {
    const plugin = new IpifyPlugin(quiet);
    const r = await plugin.getPublicIpByProtocol({ protocol: 'dual' });
    assert.equal(r.success, true);
    assert.equal(r.partial, true);
    assert.equal(r.data.addresses.v4.address, '203.0.113.7');
    assert.ok(r.data.unavailable.v6);
  } finally {
    axios.get = originalGet;
  }
});

test('an IPv4 answer on the v6 endpoint is rejected, not reported as IPv6', async () => {
  const originalGet = axios.get;
  axios.get = async () => ({ data: { ip: '203.0.113.7' } });
  try {
    const plugin = new IpifyPlugin(quiet);
    await assert.rejects(plugin.getPublicIpByProtocol({ protocol: 'v6' }), /unexpected protocol/);
  } finally {
    axios.get = originalGet;
  }
});

test('forceRefresh bypasses the cached public IP result', async () => {
  const originalGet = axios.get;
  let calls = 0;

  axios.get = async () => {
    calls += 1;
    return { data: { ip: `203.0.113.${calls}` } };
  };

  try {
    const plugin = new IpifyPlugin(quiet);

    const first = await plugin.getPublicIp();
    const cached = await plugin.getPublicIp();
    const refreshed = await plugin.getPublicIp({ forceRefresh: true });

    assert.equal(calls, 2);
    assert.equal(first.source, 'fetched');
    assert.equal(cached.source, 'cache');
    assert.equal(cached.data.ip, '203.0.113.1');
    assert.equal(refreshed.source, 'fetched');
    assert.equal(refreshed.data.ip, '203.0.113.2');
  } finally {
    axios.get = originalGet;
  }
});

test('clearCache invalidates the selected protocol cache', async () => {
  const originalGet = axios.get;
  let calls = 0;

  axios.get = async () => {
    calls += 1;
    return { data: { ip: '203.0.113.7' } };
  };

  try {
    const plugin = new IpifyPlugin(quiet);

    const first = await plugin.getPublicIpByProtocol({ protocol: 'v4' });
    const cached = await plugin.getPublicIpByProtocol({ protocol: 'v4' });
    const cleared = await plugin.clearCache({ scope: 'v4' });
    const fetched = await plugin.getPublicIpByProtocol({ protocol: 'v4' });

    assert.equal(calls, 2);
    assert.equal(first.source, 'fetched');
    assert.equal(cached.source, 'cache');
    assert.equal(cleared.success, true);
    assert.equal(cleared.data.scope, 'v4');
    assert.equal(cleared.data.cleared, true);
    assert.equal(fetched.source, 'fetched');
  } finally {
    axios.get = originalGet;
  }
});

test('clearCache invalidates formatted JSON and text results', async () => {
  const originalGet = axios.get;
  let calls = 0;

  axios.get = async (url) => {
    calls += 1;
    if (url.includes('format=text')) {
      return { data: '203.0.113.8\n' };
    }
    return { data: { ip: '203.0.113.8' } };
  };

  try {
    const plugin = new IpifyPlugin(quiet);

    await plugin.getFormattedIp({ format: 'json' });
    await plugin.getFormattedIp({ format: 'text' });
    const cachedJson = await plugin.getFormattedIp({ format: 'json' });
    const cachedText = await plugin.getFormattedIp({ format: 'text' });

    assert.equal(calls, 2);
    assert.equal(cachedJson.source, 'cache');
    assert.equal(cachedText.source, 'cache');

    const cleared = await plugin.clearCache({ scope: 'formatted' });
    const fetchedJson = await plugin.getFormattedIp({ format: 'json' });
    const fetchedText = await plugin.getFormattedIp({ format: 'text' });

    assert.equal(cleared.success, true);
    assert.equal(cleared.data.scope, 'formatted');
    assert.equal(fetchedJson.source, 'fetched');
    assert.equal(fetchedText.source, 'fetched');
    assert.equal(calls, 4);
  } finally {
    axios.get = originalGet;
  }
});

test('a zero cache TTL is rejected (NodeCache would keep it forever)', async () => {
  const plugin = new IpifyPlugin(quiet);
  const r = await plugin.getPublicIp({ cacheTtlSeconds: 0 }).catch(e => ({ success: false, error: e.message }));
  assert.equal(r.success, false);
});

// New tests for getIpGeolocation

test('getIpGeolocation with a specific IP returns structured geolocation data', async () => {
  const originalGet = axios.get;
  const mockGeoData = {
    status: 'success',
    country: 'United States',
    countryCode: 'US',
    region: 'CA',
    regionName: 'California',
    city: 'Mountain View',
    zip: '94043',
    lat: 37.4056,
    lon: -122.0775,
    timezone: 'America/Los_Angeles',
    isp: 'Google LLC',
    org: 'Google Public DNS',
    as: 'AS15169 Google LLC',
    query: '8.8.8.8'
  };

  axios.get = async (url) => {
    if (url.includes('ip-api.com')) {
      return { data: mockGeoData };
    }
    throw new Error('Unexpected URL');
  };

  try {
    const plugin = new IpifyPlugin(quiet);
    const result = await plugin.getIpGeolocation({ ip: '8.8.8.8' });

    assert.equal(result.success, true);
    assert.equal(result.source, 'fetched');
    assert.equal(result.data.ip, '8.8.8.8');
    assert.equal(result.data.country, 'United States');
    assert.equal(result.data.countryCode, 'US');
    assert.equal(result.data.city, 'Mountain View');
    assert.equal(result.data.lat, 37.4056);
    assert.equal(result.data.lon, -122.0775);
    assert.equal(result.data.isp, 'Google LLC');
    assert.equal(result.data.org, 'Google Public DNS');
    assert.equal(result.data.as, 'AS15169 Google LLC');
  } finally {
    axios.get = originalGet;
  }
});

test('getIpGeolocation without IP uses public IP', async () => {
  const originalGet = axios.get;
  const publicIp = '1.2.3.4';
  const mockGeoData = {
    status: 'success',
    country: 'Australia',
    countryCode: 'AU',
    region: 'NSW',
    regionName: 'New South Wales',
    city: 'Sydney',
    zip: '2000',
    lat: -33.8688,
    lon: 151.2093,
    timezone: 'Australia/Sydney',
    isp: 'Example ISP',
    org: 'Example Org',
    as: 'AS12345 Example',
    query: publicIp
  };

  axios.get = async (url) => {
    if (url.includes('ip-api.com')) {
      assert.ok(url.includes(publicIp), 'URL should contain the public IP');
      return { data: mockGeoData };
    }
    throw new Error('Unexpected URL');
  };

  try {
    const plugin = new IpifyPlugin(quiet);
    // Stub getPublicIp to return a known IP
    const originalGetPublicIp = plugin.getPublicIp;
    plugin.getPublicIp = async () => ({
      success: true,
      data: { ip: publicIp }
    });

    const result = await plugin.getIpGeolocation({});

    assert.equal(result.success, true);
    assert.equal(result.source, 'fetched');
    assert.equal(result.data.ip, publicIp);
    assert.equal(result.data.country, 'Australia');
    assert.equal(result.data.city, 'Sydney');
  } finally {
    axios.get = originalGet;
  }
});

test('getIpGeolocation caches results and forceRefresh bypasses cache', async () => {
  const originalGet = axios.get;
  let callCount = 0;

  axios.get = async (url) => {
    if (url.includes('ip-api.com')) {
      callCount++;
      return {
        data: {
          status: 'success',
          country: `Country${callCount}`,
          countryCode: 'XX',
          region: '',
          regionName: '',
          city: '',
          zip: '',
          lat: 0,
          lon: 0,
          timezone: '',
          isp: '',
          org: '',
          as: '',
          query: '8.8.8.8'
        }
      };
    }
    throw new Error('Unexpected URL');
  };

  try {
    const plugin = new IpifyPlugin(quiet);

    const first = await plugin.getIpGeolocation({ ip: '8.8.8.8' });
    assert.equal(first.source, 'fetched');
    assert.equal(first.data.country, 'Country1');

    const cached = await plugin.getIpGeolocation({ ip: '8.8.8.8' });
    assert.equal(cached.source, 'cache');
    assert.equal(cached.data.country, 'Country1');

    const refreshed = await plugin.getIpGeolocation({ ip: '8.8.8.8', forceRefresh: true });
    assert.equal(refreshed.source, 'fetched');
    assert.equal(refreshed.data.country, 'Country2');

    assert.equal(callCount, 2);
  } finally {
    axios.get = originalGet;
  }
});

test('getIpGeolocation throws error when ip-api.com returns status fail', async () => {
  const originalGet = axios.get;

  axios.get = async (url) => {
    if (url.includes('ip-api.com')) {
      return {
        data: {
          status: 'fail',
          message: 'invalid query'
        }
      };
    }
    throw new Error('Unexpected URL');
  };

  try {
    const plugin = new IpifyPlugin(quiet);
    await assert.rejects(
      plugin.getIpGeolocation({ ip: '8.8.8.8' }),
      /invalid query/
    );
  } finally {
    axios.get = originalGet;
  }
});

test('getIpGeolocation rejects invalid IP address', async () => {
  const plugin = new IpifyPlugin(quiet);
  await assert.rejects(
    plugin.getIpGeolocation({ ip: 'not-an-ip' }),
    /Invalid IP address/
  );
});

test('getIpGeolocation rejects cacheTtlSeconds of 0', async () => {
  const plugin = new IpifyPlugin(quiet);
  await assert.rejects(
    plugin.getIpGeolocation({ ip: '8.8.8.8', cacheTtlSeconds: 0 }),
    /cacheTtlSeconds/
  );
});

test('getIpGeolocation answers private addresses locally, without a network call', async () => {
  const originalGet = axios.get;
  let calls = 0;
  axios.get = async () => { calls++; return { data: {} }; };
  try {
    const plugin = new IpifyPlugin(quiet);
    for (const ip of ['192.168.1.20', '10.0.0.7', '172.20.1.1', '127.0.0.1', '::1', 'fe80::1', 'fd00::5']) {
      await assert.rejects(plugin.getIpGeolocation({ ip }), /private or local address/, ip);
    }
    assert.equal(calls, 0);
  } finally {
    axios.get = originalGet;
  }
});
