import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bbHome, readClientConfig } from './config.ts';
import { findHc } from '../runner/herdr.ts';
import { RUNNER_VERSION } from '../runner/main.ts';
import { KIT_RUNNER_VERSION } from '../shared/factory.ts';
import { enabledGates, LINE_FILE_DEFAULT, resolveLine } from '../shared/line.ts';

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

/** "0.10.1" vs "0.2.0": negative when a < b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Whether the current folder holds a valid line file (§12.3). Absent is not a problem: not every folder is a factory repo. */
function lineCheck(dir: string, item: (good: boolean, msg: string, fix?: string) => void) {
  const file = join(dir, LINE_FILE_DEFAULT);
  if (!existsSync(file)) {
    console.log(`  no ${LINE_FILE_DEFAULT} in ${dir} (put a repo on the factory with /buildyboy:factory-init)`);
    return;
  }
  let r: ReturnType<typeof resolveLine>;
  try {
    r = resolveLine(JSON.parse(readFileSync(file, 'utf8')), { checkoutDir: dir });
  } catch (e) {
    item(false, `${file}: not valid JSON (${(e as Error).message})`, `fix it, then bb line check ${dir}`);
    return;
  }
  if (r.ok) item(true, `${LINE_FILE_DEFAULT} valid: gates ${enabledGates(r.line).join(' ') || 'none'}${r.line.qa ? ', QA' : ''}${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''}: bb line check)` : ''}`);
  else item(false, `${LINE_FILE_DEFAULT} invalid: ${r.errors[0]}${r.errors.length > 1 ? ` (+${r.errors.length - 1} more)` : ''}`, `bb line check ${dir} lists every error`);
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
  const runnerJson = readJson(join(bbHome(), 'runner.json'));
  const hc = findHc(runnerJson?.hcPath);
  item(!!hc, `herdr hc ${hc ? `found (${hc})` : 'not found'}`, 'install herdr-core, or set BUILDYBOY_HC (or "hcPath" in runner.json) to hc');
  // §12.4: the kit's built-in steps need runner 0.2.0. A runner reports the version of the code it started from, so this
  // checkout's version is what `bb runner` runs here after a restart.
  const kitReady = compareVersions(RUNNER_VERSION, KIT_RUNNER_VERSION) >= 0;
  item(
    kitReady,
    `runner code in this checkout: ${RUNNER_VERSION}${kitReady ? '' : ` (the kit needs ${KIT_RUNNER_VERSION})`}${runnerJson ? '' : ' · no runner.json, so no runner on this machine'}`,
    kitReady ? undefined : 'update this checkout, then restart bb runner',
  );
  lineCheck(process.cwd(), item);
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
