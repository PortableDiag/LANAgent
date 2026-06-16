import { test } from 'node:test';
import assert from 'node:assert/strict';
import SkynetServiceConfig from '../../src/models/SkynetServiceConfig.js';

test('getServiceUsageStats aggregates service usage data by category', async (t) => {
  const mockAggregateResult = [
    {
      category: 'storage',
      services: [
        {
          serviceId: 'upload-file',
          name: 'File Upload',
          totalRequests: 150,
          totalRevenue: 3000,
          lastUsed: new Date('2023-12-01')
        }
      ],
      categoryTotalRequests: 150,
      categoryTotalRevenue: 3000
    },
    {
      category: 'compute',
      services: [
        {
          serviceId: 'run-task',
          name: 'Task Execution',
          totalRequests: 200,
          totalRevenue: 5000,
          lastUsed: new Date('2023-12-02')
        }
      ],
      categoryTotalRequests: 200,
      categoryTotalRevenue: 5000
    }
  ];

  // Stub aggregate, capturing the original so we can restore it after the test.
  const orig = SkynetServiceConfig.aggregate;
  let receivedPipeline;
  SkynetServiceConfig.aggregate = async (pipeline) => {
    receivedPipeline = pipeline;
    return mockAggregateResult;
  };
  t.after(() => { SkynetServiceConfig.aggregate = orig; });

  const result = await SkynetServiceConfig.getServiceUsageStats();

  // The static should pass a non-empty aggregation pipeline through.
  assert.ok(Array.isArray(receivedPipeline) && receivedPipeline.length > 0);

  assert.equal(result.length, 2);
  assert.equal(result[0].category, 'storage');
  assert.equal(result[0].services[0].serviceId, 'upload-file');
  assert.equal(result[0].categoryTotalRequests, 150);
  assert.equal(result[1].category, 'compute');
  assert.equal(result[1].services[0].totalRevenue, 5000);
});

test('getTopServicesByRevenue queries enabled services sorted by revenue', async (t) => {
  const topServices = [
    {
      serviceId: 'run-task',
      name: 'Task Execution',
      description: 'Runs a task',
      category: 'compute',
      totalRequests: 200,
      totalRevenue: 5000,
      lastUsed: new Date('2023-12-02')
    },
    {
      serviceId: 'upload-file',
      name: 'File Upload',
      description: 'Uploads a file',
      category: 'storage',
      totalRequests: 150,
      totalRevenue: 3000,
      lastUsed: new Date('2023-12-01')
    }
  ];

  // Build a chainable query stub mirroring the Mongoose Query API used by the static.
  let findArgs;
  let sortArgs;
  let limitArgs;
  const query = {
    sort(arg) { sortArgs = arg; return this; },
    limit(arg) { limitArgs = arg; return this; },
    select() { return Promise.resolve(topServices); }
  };

  const orig = SkynetServiceConfig.find;
  SkynetServiceConfig.find = (filter) => { findArgs = filter; return query; };
  t.after(() => { SkynetServiceConfig.find = orig; });

  const result = await SkynetServiceConfig.getTopServicesByRevenue({ limit: 5 });

  assert.deepEqual(findArgs, { skynetEnabled: true });
  assert.deepEqual(sortArgs, { totalRevenue: -1 });
  assert.equal(limitArgs, 5);
  assert.equal(result.length, 2);
  assert.equal(result[0].serviceId, 'run-task');
  assert.equal(result[0].totalRevenue, 5000);
});

test('getTopServicesByRevenue defaults limit to 10', async (t) => {
  let limitArgs;
  const query = {
    sort() { return this; },
    limit(arg) { limitArgs = arg; return this; },
    select() { return Promise.resolve([]); }
  };

  const orig = SkynetServiceConfig.find;
  SkynetServiceConfig.find = () => query;
  t.after(() => { SkynetServiceConfig.find = orig; });

  await SkynetServiceConfig.getTopServicesByRevenue();

  assert.equal(limitArgs, 10);
});
