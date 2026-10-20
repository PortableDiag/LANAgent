/**
 * MCP server endpoint, driven end to end by the SDK's own client over Streamable HTTP.
 * The token lookup is stubbed (no database); plugins and the agent are fakes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCPToken } from '../../src/models/MCPToken.js';
import { MCPServerService } from '../../src/services/mcp/mcpServer.js';

const executed = [];
const agent = {
  apiManager: {
    apis: new Map([
      ['docker', { enabled: true, instance: { commands: [
        { command: 'list', description: 'List docker containers', usage: 'list()' },
        { command: 'restart', description: 'Restart a docker container', usage: 'restart({ container })' }
      ] } }],
      ['weather', { enabled: true, instance: { commands: [{ command: 'current', description: 'Current weather' }] } }],
      ['off', { enabled: false, instance: { commands: [{ command: 'x', description: 'disabled plugin' }] } }]
    ]),
    async executeAPI(plugin, method, params) {
      executed.push({ plugin, method, params });
      return { success: true, plugin, action: params.action };
    }
  },
  async processNaturalLanguage(message, context) {
    return { type: 'text', content: `agent heard "${message}" via ${context.interface}` };
  }
};

function tokenDoc({ allowedTools = [], deniedTools = [], permissions = ['*'] } = {}) {
  return {
    name: 'test-token', permissions, allowedTools, deniedTools,
    isToolAllowed: MCPToken.schema.methods.isToolAllowed
  };
}
const TOKENS = {
  mcp_full: tokenDoc(),
  mcp_narrow: tokenDoc({ allowedTools: ['weather_current'] }),
  mcp_lan_only: { ...tokenDoc(), allowedIps: ['10.0.0.0/8'], blockedIps: [], isIpAllowed: MCPToken.schema.methods.isIpAllowed },
  mcp_loopback: { ...tokenDoc(), allowedIps: ['127.0.0.0/8', '::1'], blockedIps: [], isIpAllowed: MCPToken.schema.methods.isIpAllowed }
};
const realValidate = MCPToken.validateToken;

let server, url;
before(async () => {
  MCPToken.validateToken = async (v) => TOKENS[v] || null;
  const svc = new MCPServerService(agent);
  const app = express();
  app.use(express.json());
  app.all('/mcp/server', (req, res) => svc.handleHttpRequest(req, res));
  await new Promise(r => { server = app.listen(0, r); });
  url = new URL(`http://127.0.0.1:${server.address().port}/mcp/server`);
});
after(() => { MCPToken.validateToken = realValidate; server.close(); });

async function connect(token) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const textOf = r => r.content[0].text;

test('an unrestricted token sees the three meta tools', async () => {
  const client = await connect('mcp_full');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['ask_agent', 'call_tool', 'search_tools']);
  await client.close();
});

test('search_tools finds enabled commands only; call_tool runs one through executeAPI', async () => {
  const client = await connect('mcp_full');
  const found = JSON.parse(textOf(await client.callTool({ name: 'search_tools', arguments: { query: 'docker' } })));
  assert.deepEqual(found.tools.map(t => t.name), ['docker_list', 'docker_restart']);
  const none = JSON.parse(textOf(await client.callTool({ name: 'search_tools', arguments: { query: 'disabled' } })));
  assert.equal(none.total, 0);

  const r = await client.callTool({ name: 'call_tool', arguments: { name: 'docker_restart', arguments: { container: 'web' } } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(executed.at(-1), { plugin: 'docker', method: 'execute', params: { container: 'web', action: 'restart' } });
  await client.close();
});

test('ask_agent goes through processNaturalLanguage', async () => {
  const client = await connect('mcp_full');
  const r = await client.callTool({ name: 'ask_agent', arguments: { message: 'disk usage?' } });
  assert.equal(textOf(r), 'agent heard "disk usage?" via mcp');
  await client.close();
});

test('a narrowed token gets its tools directly, no ask_agent, and is refused others', async () => {
  const client = await connect('mcp_narrow');
  const names = (await client.listTools()).tools.map(t => t.name);
  assert.ok(names.includes('weather_current'));
  assert.ok(!names.includes('ask_agent'));

  const ok = await client.callTool({ name: 'weather_current', arguments: {} });
  assert.equal(ok.isError, undefined);
  const denied = await client.callTool({ name: 'call_tool', arguments: { name: 'docker_list' } });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /Permission denied/);
  await client.close();
});

test('a bad token is a 401 before any MCP handling', async () => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer mcp_nope', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(res.status, 401);
});

test('a token whose IP policy excludes the caller is refused with 403', async () => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer mcp_lan_only', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  assert.equal(res.status, 403);
});

test('a token whose IP policy includes the caller connects normally', async () => {
  const client = await connect('mcp_loopback');
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  await client.close();
});
