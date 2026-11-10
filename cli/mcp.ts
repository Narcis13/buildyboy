// bb mcp — the Buildyboy MCP server for a Claude Code coordinator, over stdio. A thin process: every tool is one call
// to POST /api/agent/<tool> on the Buildyboy server, authenticated with an agent token (not the machine token).
//
//   BUILDYBOY_URL           server URL (default: the url in ~/.buildyboy/config.json)
//   BUILDYBOY_AGENT_TOKEN   agent token (bba_…), created in Settings → Agent tokens
//
// Register it (once):  claude mcp add buildyboy -e BUILDYBOY_URL=… -e BUILDYBOY_AGENT_TOKEN=bba_… -- node <repo>/cli/bb.ts mcp
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SHOT_MAX_BYTES, TOOLS, TOOL_NAMES } from '../shared/factory.ts';
import { readClientConfig } from './config.ts';
import { AgentHttpError, UnreachableError, createResilientClient, type AgentClient, type CallOptions, type ResilientClient } from './outbox.ts';

export type { AgentClient };

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Why a fetch failed, e.g. "fetch failed (ECONNREFUSED)". */
function describe(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code ?? err?.cause?.message;
  return `${err?.message ?? String(e)}${cause ? ` (${cause})` : ''}`;
}

/**
 * One POST per tool. Throws UnreachableError when the server cannot be reached (fetch throws, or 502/503/504) and
 * AgentHttpError for every other non-2xx answer: those are real answers (a revoked token is 'unauthorized', not offline).
 */
export function agentClient(url: string, token: string): AgentClient {
  const base = url.replace(/\/$/, '');
  return {
    async call(tool, args, opts?: CallOptions) {
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
      if (opts?.key) headers['idempotency-key'] = opts.key;
      let res: Response;
      try {
        res = await fetch(`${base}/api/agent/${tool}`, { method: 'POST', headers, body: JSON.stringify(args ?? {}), signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        throw new UnreachableError(describe(e));
      }
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
      if (res.status === 502 || res.status === 503 || res.status === 504) throw new UnreachableError(body?.error ?? `HTTP ${res.status}`);
      if (!res.ok) throw new AgentHttpError(body?.error ?? `HTTP ${res.status}`, res.status);
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

/** `layer` adds the outbox, read cache and local governor around the client (tests pass their own, with a fake clock). */
export function createMcpServer(client: AgentClient, layer: ResilientClient = createResilientClient(client)): McpServer {
  const server = new McpServer({ name: 'buildyboy', version: '0.1.0' });
  for (const name of TOOL_NAMES) {
    const tool = TOOLS[name];
    server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      try {
        const sent = name === 'gates_record' ? inlineShots(args as Record<string, unknown>) : args;
        const result = await layer.call(name, sent);
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
  const client = agentClient(url, token);
  const layer = createResilientClient(client, { url, owner: createHash('sha256').update(token).digest('hex').slice(0, 16) });
  const server = createMcpServer(client, layer);
  await server.connect(new StdioServerTransport());
  void layer.start(); // replay whatever an earlier run left in the outbox
  console.error(`[bb mcp] serving ${TOOL_NAMES.length} tools for ${url}`);
}
