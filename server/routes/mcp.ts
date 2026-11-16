// The Streamable HTTP MCP endpoint (SPEC §11.1): every Buildyboy tool for remote agents and MCP clients that cannot run
// `bb mcp` locally. Stateless: each POST builds a fresh McpServer whose tools run in-process under the caller's agent
// token, through the same callTool as POST /api/agent/<tool>. Both the 2026-07-28 protocol and the 2025-era stateless
// Streamable HTTP clients are served (createMcpHandler's default).
import { Hono } from 'hono';
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import type { Ctx } from '../context.ts';
import { agentFromToken, callerOf, callTool, type AgentIdentity } from '../factory/agent.ts';
import { FactoryError } from '../factory/tasks.ts';
import { MCP_INSTRUCTIONS, MCP_SERVER_INFO, registerTools } from '../../shared/mcp-tools.ts';
import { SHOT_MAX_BYTES } from '../../shared/factory.ts';

export const MCP_PATH = '/mcp';

/** gates_record carries up to 12 screenshots of 5 MB each as base64, so the default 4 MiB body limit is too small. */
const MAX_BODY = 12 * Math.ceil((SHOT_MAX_BYTES * 4) / 3) + 1024 * 1024;

/** A local `path` means nothing to the server: only `bb mcp` reads files, on the agent's machine. */
function checkShots(name: string, args: unknown) {
  if (name !== 'gates_record') return;
  for (const s of (args as { screenshots?: { name?: string; path?: string; base64?: string }[] } | null)?.screenshots ?? []) {
    if (s?.path && !s.base64) {
      throw new FactoryError(400, `screenshot ${s.name ?? '?'}: over HTTP send the image as base64 (with mime); a local path is only read by \`bb mcp\` on the agent's machine`);
    }
  }
}

export function mcpRoutes(ctx: Ctx) {
  const app = new Hono();

  const handler = createMcpHandler(
    ({ authInfo }) => {
      const agent = authInfo?.extra as AgentIdentity | undefined;
      const server = new McpServer({ ...MCP_SERVER_INFO }, { instructions: MCP_INSTRUCTIONS });
      registerTools(server, async (name, args) => {
        if (!agent) throw new Error('unauthorized');
        checkShots(name, args);
        return callTool(ctx, name, args, `agent:${agent.name}`, null, callerOf(agent)).result;
      });
      return server;
    },
    {
      maxRequestBodySize: MAX_BODY,
      onerror: (e) => {
        if (!ctx.config.production || process.env.BUILDYBOY_DEBUG) console.error('[mcp]', e.message);
      },
    },
  );

  app.all(MCP_PATH, async (c) => {
    const agent = agentFromToken(ctx, c.req.header('authorization'));
    if (!agent) {
      return c.json(
        { error: 'unauthorized: send an agent token (Settings → Factory → Agent tokens) as "Authorization: Bearer bba_…"' },
        401,
        { 'www-authenticate': 'Bearer realm="buildyboy"' },
      );
    }
    const authInfo: AuthInfo = { token: 'bba_', clientId: agent.id, scopes: ['agent'], extra: { ...agent } };
    return handler.fetch(c.req.raw, { authInfo });
  });

  // An MCP client that gets a 401 may look for OAuth metadata. There is none (agent tokens are static bearer tokens):
  // answer that plainly instead of letting the PWA's index.html reach a JSON parser.
  app.all('/.well-known/oauth-protected-resource/*', (c) => c.json({ error: 'not found: Buildyboy uses static agent tokens, not OAuth' }, 404));
  app.all('/.well-known/oauth-protected-resource', (c) => c.json({ error: 'not found: Buildyboy uses static agent tokens, not OAuth' }, 404));
  app.all('/.well-known/oauth-authorization-server', (c) => c.json({ error: 'not found: Buildyboy uses static agent tokens, not OAuth' }, 404));
  app.all('/.well-known/openid-configuration', (c) => c.json({ error: 'not found' }, 404));

  return app;
}
