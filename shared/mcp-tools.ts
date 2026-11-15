// The Buildyboy MCP surface, shared by both transports: `bb mcp` (stdio, on the agent's machine, which forwards every
// call to POST /api/agent/<tool>) and the server's own Streamable HTTP endpoint at /mcp (which runs them in-process).
// One registration, so the two can never offer different tools, descriptions or hints.
import type { McpServer } from '@modelcontextprotocol/server';
import { READ_ONLY_TOOLS, TOOLS, TOOL_NAMES, type ToolName } from './factory.ts';

export const MCP_SERVER_INFO = { name: 'buildyboy', version: '0.1.0' } as const;

/** Sent to the client at initialize; most clients put it in the model's context. Keep it short: docs_get has the rest. */
export const MCP_INSTRUCTIONS = [
  'Buildyboy is the control tower of a software factory run by Claude Code agents. It keeps the backlog of packages (tasks),',
  'the subscription usage and the consumption governor, the gates (G1–G5) with their findings and screenshots, the',
  "human's decisions inbox, stop/revert requests and the daily digest. The human follows it all on their phone.",
  '',
  'New here? Call docs_get (topic "start") once: it explains the concepts, the loop and the conventions.',
  '',
  'The coordinator loop, in short:',
  '1. governor_get: start new work only when canStart is true; stopAll means stop the factory.',
  '2. control_get: act on the human\'s stop/revert requests first (ack: true once handled).',
  '3. tasks_list {ready: true}, then tasks_claim (a given id or the next ready one): it returns the package and its',
  '   resources (port, database, migration range).',
  '4. Build the worker prompt with prompts_render / prompts_lint and save it with prompts_save {taskId}.',
  '5. When the worker is done: tasks_update {status: "la_porti"}, then each gate with gates_run + gates_status (on the',
  '   runner) or gates_record (you ran it yourself). Fix what fails; the server counts rounds and blocks at the limit.',
  '6. tasks_update {status: "integrata"} once every gate passes; run the cleanup lines it returns.',
  '7. Ask the human with decision_ask and poll decision_get; never wait on a decision without telling them why.',
  '',
  'Statuses are Romanian: backlog, gata (ready), in_lucru (in progress), la_porti (at the gates), integrata',
  '(integrated), blocata (blocked). Every result is JSON text; a refused call returns isError with the reason.',
].join('\n');

export type ToolCaller = (name: ToolName, args: unknown) => Promise<unknown>;

/** Registers every tool on `server`. `call` runs one tool and returns its JSON result, or throws with the reason. */
export function registerTools(server: McpServer, call: ToolCaller): void {
  const readOnly = new Set<string>(READ_ONLY_TOOLS);
  for (const name of TOOL_NAMES) {
    const tool = TOOLS[name];
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: readOnly.has(name) ? { readOnlyHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const result = await call(name, args);
          // docs_get answers Markdown: give it to the model as text, not as a JSON string
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text' as const, text }] };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `${name} failed: ${(e as Error).message}` }], isError: true };
        }
      },
    );
  }
}
