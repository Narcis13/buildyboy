// bb mcp — the Buildyboy MCP server for a Claude Code coordinator, over stdio. A thin process: every tool is one call
// to POST /api/agent/<tool> on the Buildyboy server, authenticated with an agent token (not the machine token).
//
//   BUILDYBOY_URL           server URL (default: the url in ~/.buildyboy/config.json)
//   BUILDYBOY_AGENT_TOKEN   agent token (bba_…), created in Settings → Agent tokens
//
// Register it (once):  claude mcp add buildyboy -e BUILDYBOY_URL=… -e BUILDYBOY_AGENT_TOKEN=bba_… -- node <repo>/cli/bb.ts mcp
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SHOT_MAX_BYTES, TOOLS, TOOL_NAMES, type ToolName } from '../shared/factory.ts';
import { readClientConfig } from './config.ts';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export interface AgentClient {
  call(tool: ToolName, args: unknown): Promise<unknown>;
}

export function agentClient(url: string, token: string): AgentClient {
  const base = url.replace(/\/$/, '');
  return {
    async call(tool, args) {
      const res = await fetch(`${base}/api/agent/${tool}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body?.result ?? null;
    },
  };
}

/** gates_record: local screenshot paths become base64 uploads, since the server cannot read this machine's files. */
export function inlineShots(args: Record<string, unknown>): Record<string, unknown> {
  const shots = args.screenshots as { name: string; path?: string; base64?: string; mime?: string }[] | undefined;
  if (!shots?.length) return args;
  return {
    ...args,
    screenshots: shots.map((s) => {
      if (s.base64 || !s.path) return s;
      const file = resolve(s.path);
      const size = statSync(file).size;
      if (size > SHOT_MAX_BYTES) throw new Error(`${s.path} is ${size} bytes (limit ${SHOT_MAX_BYTES})`);
      return { name: s.name, base64: readFileSync(file).toString('base64'), mime: s.mime ?? MIME[extname(file).toLowerCase()] };
    }),
  };
}

export function createMcpServer(client: AgentClient): McpServer {
  const server = new McpServer({ name: 'buildyboy', version: '0.1.0' });
  for (const name of TOOL_NAMES) {
    const tool = TOOLS[name];
    server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      try {
        const sent = name === 'gates_record' ? inlineShots(args as Record<string, unknown>) : args;
        const result = await client.call(name, sent);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `${name} failed: ${(e as Error).message}` }], isError: true };
      }
    });
  }
  return server;
}

export async function runMcp(): Promise<void> {
  const url = process.env.BUILDYBOY_URL || readClientConfig().url;
  const token = process.env.BUILDYBOY_AGENT_TOKEN;
  if (!url || !token) {
    console.error('bb mcp: set BUILDYBOY_AGENT_TOKEN (an agent token from Settings → Agent tokens) and BUILDYBOY_URL');
    process.exit(1);
  }
  const server = createMcpServer(agentClient(url, token));
  await server.connect(new StdioServerTransport());
  console.error(`[bb mcp] serving ${TOOL_NAMES.length} tools for ${url}`);
}
