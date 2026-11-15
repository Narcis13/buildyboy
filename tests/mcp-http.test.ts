// The Streamable HTTP MCP endpoint at /mcp, driven by the official MCP client over real HTTP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAgentToken, revokeAgentToken } from '../server/factory/agent.ts';
import { createMachine } from '../server/auth.ts';
import { READ_ONLY_TOOLS, TOOL_NAMES } from '../shared/factory.ts';
import { startTestServer, type TestServer } from './helpers.ts';

// 1×1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

describe('MCP over Streamable HTTP', () => {
  let srv: TestServer;
  let token: string;
  let tokenId: string;
  const clients: Client[] = [];

  const connect = async (bearer: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
    const client = new Client({ name: 'bb-test', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const json = (r: ToolResult) => JSON.parse(r.content.map((c) => c.text).join('\n'));

  beforeAll(async () => {
    srv = await startTestServer();
    const t = createAgentToken(srv.ctx, 'remote');
    token = t.token;
    tokenId = t.id;
  });
  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await srv.stop();
  });

  it('refuses a request without a valid agent token', async () => {
    const res = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const machine = createMachine(srv.ctx, 'm').token;
    const res2 = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${machine}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res2.status).toBe(401);
    // OAuth discovery after a 401 gets a JSON 404, not the PWA's index.html
    const meta = await fetch(`${srv.url}/.well-known/oauth-protected-resource/mcp`);
    expect(meta.status).toBe(404);
    expect(meta.headers.get('content-type')).toContain('application/json');
  });

  it('lists every tool with its hints and sends the instructions', async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const readOnly = new Set<string>(READ_ONLY_TOOLS);
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(readOnly.has(t.name));
    expect(client.getInstructions()).toMatch(/docs_get/);
  });

  it('runs the tools in-process under the agent token', async () => {
    const client = await connect(token);
    const created = await call(client, 'tasks_create', { id: 'H1', title: 'Over HTTP', status: 'gata' });
    expect(created.isError).toBeFalsy();
    expect(json(created)).toMatchObject({ id: 'H1', status: 'gata', ready: true });
    const listed = json(await call(client, 'tasks_list', { ready: true }));
    expect(listed.map((t: { id: string }) => t.id)).toContain('H1');
    const detail = json(await call(client, 'tasks_get', { id: 'H1' }));
    expect(detail.events[0].actor).toBe('agent:remote');
    const docs = await call(client, 'docs_get', { topic: 'start' });
    expect(docs.content[0].text).toMatch(/^# Buildyboy for agents/);
  });

  it('returns refusals as error results with the server\'s reason', async () => {
    const client = await connect(token);
    const dup = await call(client, 'tasks_create', { id: 'H1', title: 'again' });
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toMatch(/already exists/);
    const unknown = await call(client, 'tasks_get', { id: 'NOPE' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toMatch(/unknown task NOPE/);
  });

  it('takes screenshots as base64 and explains that a local path cannot work', async () => {
    const client = await connect(token);
    await call(client, 'tasks_create', { id: 'H2', title: 'Shots' });
    const byPath = await call(client, 'gates_record', { taskId: 'H2', gate: 'G4', verdict: 'pass', summary: 'x', screenshots: [{ name: 'desktop', path: 'C:/shot.png' }] });
    expect(byPath.isError).toBe(true);
    expect(byPath.content[0].text).toMatch(/base64/);
    const ok = await call(client, 'gates_record', { taskId: 'H2', gate: 'G4', verdict: 'pass', summary: 'looks right', screenshots: [{ name: 'desktop', base64: PNG }] });
    expect(ok.isError).toBeFalsy();
    expect(json(ok).shots).toHaveLength(1);
  });

  it('answers GET with 405 (stateless: no sessions to resume)', async () => {
    const res = await fetch(`${srv.url}/mcp`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
  });

  it('stops working the moment the token is revoked', async () => {
    const client = await connect(token);
    revokeAgentToken(srv.ctx, tokenId);
    await expect(client.callTool({ name: 'usage_get', arguments: {} })).rejects.toThrow();
  });
});
