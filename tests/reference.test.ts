// The agents' reference (server/docs/reference.ts) must describe the server as it is: every route, every tool argument.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { API_GROUPS, TOOL_DOCS, UNDOCUMENTED_ROUTES, agentGuide, argRows, endpointAnchor, llmsTxt } from '../server/docs/reference.ts';
import { createAgentToken } from '../server/factory/agent.ts';
import { TOOL_NAMES } from '../shared/factory.ts';
import { startTestServer, type TestServer } from './helpers.ts';

const SITE = { url: 'https://bb.example.test' };

describe('the agents reference', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer({ publicUrl: SITE.url });
  });
  afterAll(() => srv.stop());

  it('documents every route the server registers, and no route it does not', () => {
    const registered = new Set(createApp(srv.ctx).routes.map((r) => `${r.method} ${r.path}`));
    const documented = API_GROUPS.flatMap((g) => g.endpoints.map((e) => `${e.method} ${e.path}`));
    const missing = [...registered].filter((r) => !documented.includes(r) && !UNDOCUMENTED_ROUTES.includes(r));
    const stale = documented.filter((r) => !registered.has(r));
    expect(missing, 'routes without an entry in API_GROUPS').toEqual([]);
    expect(stale, 'entries for routes the server does not have').toEqual([]);
    expect(new Set(documented).size, 'each route once').toBe(documented.length);
    const anchors = API_GROUPS.flatMap((g) => g.endpoints.map(endpointAnchor));
    expect(new Set(anchors).size, 'anchors are unique').toBe(anchors.length);
  });

  it('describes every argument of every tool, and only arguments that exist', () => {
    for (const name of TOOL_NAMES) {
      const rows = argRows(name);
      for (const r of rows) expect(r.desc, `${name}.${r.name}`).not.toBe('');
      const known = new Set(rows.map((r) => r.name));
      for (const key of Object.keys(TOOL_DOCS[name].args)) expect(known.has(key), `${name}: documented argument ${key} does not exist`).toBe(true);
    }
  });

  it('writes a Markdown guide with every tool and endpoint, using this server\'s address', () => {
    const all = agentGuide(SITE, 'all');
    for (const name of TOOL_NAMES) expect(all).toContain(`### ${name}`);
    expect(all).toContain('### ALL /mcp');
    expect(all).toContain(`claude mcp add --transport http buildyboy ${SITE.url}/mcp`);
    expect(agentGuide(SITE, 'start')).not.toContain('### tasks_claim');
    expect(agentGuide(SITE, 'tools', 'tasks_claim')).toMatch(/^### tasks_claim/);
    expect(llmsTxt(SITE)).toContain(`${SITE.url}/docs/agents.md`);
  });

  it('serves the guide and llms.txt without a login', async () => {
    const md = await fetch(`${srv.url}/docs/agents.md?topic=api`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    const text = await md.text();
    expect(text).toContain('# HTTP API reference');
    expect(text).not.toContain('# MCP tool reference');
    const llms = await fetch(`${srv.url}/llms.txt`);
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain('/mcp');
  });

  it('docs_get answers the guide to agents', async () => {
    const token = createAgentToken(srv.ctx, 'docs').token;
    const call = (body: unknown) =>
      fetch(`${srv.url}/api/agent/docs_get`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const start = (await (await call({})).json()) as { result: string };
    expect(start.result).toContain('## The coordinator loop');
    const one = (await (await call({ tool: 'gates_run' })).json()) as { result: string };
    expect(one.result).toMatch(/^### gates_run/);
    expect((await call({ tool: 'nope' })).status).toBe(400);
    expect((await call({ topic: 'everything' })).status).toBe(400);
  });
});
