import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bbHome, readClientConfig } from './config.ts';
import { findHc } from '../runner/herdr.ts';

/** ~/.claude, or CLAUDE_CONFIG_DIR as Claude Code itself honours it. */
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
/** ~/.claude.json (user-scope MCP servers); inside CLAUDE_CONFIG_DIR when that is set. */
const claudeJson = () => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'));

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** bb doctor: config, reachability, token validity, spool and breaker state, then what the factory still needs. Returns an exit code. */
export async function doctor(): Promise<number> {
  const cfg = readClientConfig();
  const home = bbHome();
  let ok = true;
  const line = (good: boolean, msg: string) => {
    if (!good) ok = false;
    console.log(`${good ? '✔' : '✘'} ${msg}`);
  };
  line(!!cfg.url && !!cfg.token, `config: ${join(home, 'config.json')} ${cfg.url ? `(server ${cfg.url})` : '(missing url/token — run bb pair)'}`);
  if (cfg.url) {
    try {
      const h = await fetch(`${cfg.url}/api/health`, { signal: AbortSignal.timeout(3000) });
      line(h.ok, `server reachable (${h.status})`);
      const r = await fetch(`${cfg.url}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ envelopes: [] }),
        signal: AbortSignal.timeout(3000),
      });
      line(r.ok, `machine token ${r.ok ? 'accepted' : `rejected (${r.status})`}`);
    } catch (e) {
      line(false, `server unreachable: ${(e as Error).message}`);
    }
  }
  const spool = join(home, 'spool.jsonl');
  const size = existsSync(spool) ? statSync(spool).size : 0;
  console.log(`  spool: ${size} bytes`);
  const breaker = join(home, 'breaker');
  if (existsSync(breaker) && Date.now() - statSync(breaker).mtimeMs < 60_000) console.log('  circuit breaker: open (a recent call failed)');
  await factoryChecks(cfg.url);
  return ok ? 0 : 1;
}

/** The factory's prerequisites (SPEC §11.6). Missing ones are warnings with the exact next step; they never fail the doctor. */
export async function factoryChecks(url: string | undefined): Promise<string[]> {
  const missing: string[] = [];
  const item = (good: boolean, msg: string, fix?: string) => {
    console.log(`${good ? '✔' : '!'} ${msg}`);
    if (!good && fix) {
      console.log(`    → ${fix}`);
      missing.push(msg);
    }
  };
  console.log('factory:');
  const settingsFile = join(claudeDir(), 'settings.json');
  const settings = readJson(settingsFile) ?? {};
  const statusLine = String(settings.statusLine?.command ?? '');
  item(
    /bb-statusline/.test(statusLine),
    `statusline bridge ${/bb-statusline/.test(statusLine) ? 'configured' : statusLine ? 'not configured (another statusLine is set)' : 'not configured'} in ${settingsFile}`,
    'add "statusLine": { "type": "command", "command": "node <buildyboy>/plugin/statusline/bb-statusline.mjs" } (keep an existing one in BUILDYBOY_STATUSLINE_NEXT); this is where rate_limits come from',
  );
  const env = (settings.env ?? {}) as Record<string, unknown>;
  const otel = env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' || env.CLAUDE_CODE_ENABLE_TELEMETRY === 1;
  item(otel && !!env.OTEL_EXPORTER_OTLP_ENDPOINT, `OTEL export ${otel ? (env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'configured' : 'enabled without an endpoint') : 'not configured'}`, 'paste the OTEL snippet from Settings → Snippets into the "env" block of settings.json');
  const cj = readJson(claudeJson()) ?? {};
  const registered = !!cj.mcpServers?.buildyboy || Object.values((cj.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>).some((p) => !!p?.mcpServers?.buildyboy);
  item(registered, `MCP server "buildyboy" ${registered ? 'registered' : 'not registered'} with Claude Code`, 'claude mcp add buildyboy --scope user -e BUILDYBOY_URL=<url> -e BUILDYBOY_AGENT_TOKEN=<bba_…> -- node <buildyboy>/cli/bb.ts mcp');
  const hc = findHc();
  item(!!hc, `herdr hc ${hc ? `found (${hc})` : 'not found'}`, 'install herdr-core, or set BUILDYBOY_HC (or "hcPath" in runner.json) to hc');
  const agentToken = process.env.BUILDYBOY_AGENT_TOKEN;
  if (!url) return missing;
  if (!agentToken) {
    item(false, 'usage data on the server: not checked (no BUILDYBOY_AGENT_TOKEN)', 'create one in Settings → Agent tokens and run bb doctor with BUILDYBOY_AGENT_TOKEN set');
    return missing;
  }
  try {
    const r = await fetch(`${url}/api/governor`, { headers: { authorization: `Bearer ${agentToken}` }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) {
      item(false, `agent token rejected (${r.status})`, 'create a new one in Settings → Agent tokens');
      return missing;
    }
    const g = (await r.json()) as { canStart: boolean; reason: string; usage: { updatedAt: number | null; ageMs: number | null } };
    const fresh = g.usage.updatedAt !== null;
    item(fresh, `usage data ${fresh ? `${Math.round((g.usage.ageMs ?? 0) / 60_000)} min old` : 'never received'}; governor: ${g.canStart ? 'can start' : 'cannot start'} (${g.reason})`, fresh ? undefined : 'run an interactive claude session with the statusline bridge on (subscription plans only)');
  } catch (e) {
    item(false, `governor check failed: ${(e as Error).message}`);
  }
  return missing;
}
