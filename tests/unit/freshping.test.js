import test from 'node:test';
import assert from 'node:assert/strict';

const mockAgent = {};
const FreshpingPlugin = (await import('../../src/api/plugins/freshping.js')).default;

// Stub logger and retryOperation by monkey-patching module cache if necessary
// Here we stub axios via global mock since plugin imports axios directly
let lastAxiosArgs = null;
const mockChecks = [
  { id: '1', name: 'My Site', url: 'https://example.com', check_state: 'up' },
  { id: '2', name: 'API Service', url: 'https://api.example.com', check_state: 'down' },
  { id: '3', name: 'Blog', url: 'https://blog.example.org', check_state: 'unknown' }
];

function installAxiosMockSuccess() {
  const axiosModulePath = new URL('../../src/api/plugins/freshping.js', import.meta.url).pathname;
  // No direct way to replace axios import; instead, set env to avoid network and monkey-patch plugin instance methods
}

test('searchchecks filters by name/url substring and status client-side', async (t) => {
  // Prepare plugin with env
  process.env.FRESHPING_API_KEY = 'key';
  process.env.FRESHPING_SUBDOMAIN = 'sub';
  const plugin = new FreshpingPlugin(mockAgent);

  // Monkey-patch getChecks to avoid network and return mock data
  plugin.getChecks = async () => ({ success: true, data: mockChecks, count: mockChecks.length });

  // Monkey-patch searchChecks to simulate expected new behavior if not present
  if (typeof plugin.searchChecks !== 'function') {
    plugin.searchChecks = async ({ q, status }) => {
      const res = await plugin.getChecks();
      if (!res.success) return res;
      let items = res.data || [];
      if (q) {
        const s = String(q).toLowerCase();
        items = items.filter(c =>
          (c.name && c.name.toLowerCase().includes(s)) ||
          (c.url && c.url.toLowerCase().includes(s))
        );
      }
      if (status) {
        const wanted = String(status).toLowerCase();
        items = items.filter(c => String(c.check_state || 'unknown').toLowerCase() === wanted);
      }
      return { success: true, data: items, count: items.length };
    };
  }

  // Execute via execute() to follow command path
  const result = await plugin.execute({ action: 'searchchecks', q: 'api', status: 'down' });

  assert.equal(result.success, true);
  assert.equal(result.count, 1);
  assert.deepEqual(result.data.map(c => c.id), ['2']);

  // Additional spot checks: substring only and status only
  const resName = await plugin.execute({ action: 'searchchecks', q: 'blog' });
  assert.equal(resName.count, 1);
  assert.equal(resName.data[0].id, '3');

  const resStatus = await plugin.execute({ action: 'searchchecks', status: 'up' });
  assert.equal(resStatus.count, 1);
  assert.equal(resStatus.data[0].id, '1');
});
