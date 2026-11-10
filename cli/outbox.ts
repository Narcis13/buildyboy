// Offline resilience for `bb mcp`: when the Buildyboy server is unreachable the coordinator keeps working.
//   - writes whose answer can wait (QUEUEABLE_TOOLS) go to an outbox (outbox.jsonl) and are replayed in order, each
//     with its own idempotency key, once the server answers again;
//   - reads fall back to the last successful answer (mcp-cache.json), marked stale; governor_get is computed locally
//     from the statusline sample (statusline/latest.json) with the same pure evaluate() the server uses;
//   - an outage longer than 10 minutes sends one ntfy message (and one when it ends), if ntfyTopic is configured.
// All files live under bbHome() (BUILDYBOY_HOME honoured); paths are resolved at use time.
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_THRESHOLDS, QUEUEABLE_TOOLS, evaluate, windowOf, type GovernorThresholds, type ToolName, type Usage } from '../shared/factory.ts';
import { bbHome, readClientConfig } from './config.ts';

export interface CallOptions {
  /** sent as the `idempotency-key` header: the server answers a repeated key with the stored result */
  key?: string;
}

export interface AgentClient {
  call(tool: ToolName, args: unknown, opts?: CallOptions): Promise<unknown>;
}

/** The server could not be reached: fetch threw (network, refused, timeout) or answered 502/503/504. */
export class UnreachableError extends Error {
  override name = 'UnreachableError';
}

/** The server answered with a real HTTP error (401, 400, 404, 409, 500…): never queued, never "offline". */
export class AgentHttpError extends Error {
  override name = 'AgentHttpError';
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface OutboxItem {
  key: string;
  tool: ToolName;
  args: unknown;
  queuedAt: number;
  /** fingerprint of the agent token that queued it: only a `bb mcp` with the same token replays it */
  owner?: string;
}

export interface ReplayResult {
  sent: number;
  rejected: number;
  remaining: number;
  /** the unreachable error that stopped the replay, if any */
  unreachable: string | null;
}

export interface ResilientOptions {
  /** server URL, for the ntfy message */
  url?: string;
  now?: () => number;
  /** fetch used for ntfy (tests inject one) */
  ntfyFetch?: typeof fetch;
  replayIntervalMs?: number;
  /** how long the server must be unreachable before the phone is told (default 10 min) */
  downAlertMs?: number;
  /** fingerprint of this process's agent token (see OutboxItem.owner) */
  owner?: string;
}

export interface ResilientClient {
  /** one tool call, with outbox / cache / local governor. Throws Error for the model's isError text. */
  call(tool: ToolName, args: unknown): Promise<unknown>;
  /** replay the outbox now (one in flight at a time per process) */
  replay(): Promise<ReplayResult>;
  /** replay once and arm the timer if anything is pending (called at `bb mcp` start) */
  start(): Promise<void>;
  /** wait for in-flight ntfy messages */
  flush(): Promise<void>;
  queued(): number;
  /** clear the timer */
  stop(): void;
}

export const OUTBOX_FILE = 'outbox.jsonl';
export const REJECTED_FILE = 'outbox.rejected.jsonl';
export const CACHE_FILE = 'mcp-cache.json';
export const STATE_FILE = 'mcp-state.json';
export const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const REPLAY_INTERVAL_MS = 30_000;
const DOWN_ALERT_MS = 10 * 60_000;
const NTFY_TIMEOUT_MS = 8_000;

const CACHEABLE: ReadonlySet<string> = new Set(['usage_get', 'governor_get', 'sessions_list', 'sessions_get', 'tasks_list', 'tasks_get', 'decision_get', 'control_get', 'findings_list', 'gates_status', 'prompts_render', 'prompts_lint']);
const QUEUEABLE: ReadonlySet<string> = new Set(QUEUEABLE_TOOLS);

const path = (f: string) => join(bbHome(), f);

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Windows refuses a rename while another process has the target open for a moment (EPERM/EBUSY): retry briefly. */
function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 50 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      pause(20);
    }
  }
}

function atomicWrite(file: string, text: string) {
  mkdirSync(bbHome(), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameRetry(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw e;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** JSON with sorted keys, so the same arguments always give the same cache key. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// ---------- outbox file ----------

export function readOutbox(): OutboxItem[] {
  let text: string;
  try {
    text = readFileSync(path(OUTBOX_FILE), 'utf8');
  } catch {
    return [];
  }
  const items: OutboxItem[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as OutboxItem;
      if (o && typeof o.key === 'string' && typeof o.tool === 'string') items.push(o);
    } catch {
      // a torn line: skipped (and dropped at the next rewrite)
    }
  }
  return items;
}

/**
 * Every `bb mcp` on the machine shares the outbox, so appends and rewrites take a lock file (exclusive create): a
 * rewrite must never drop a line another process appended meanwhile. A lock older than 10 s is a crashed holder's.
 */
function withLock<T>(fn: () => T): T {
  mkdirSync(bbHome(), { recursive: true });
  const lock = path(`${OUTBOX_FILE}.lock`);
  let fd: number | null = null;
  for (let i = 0; fd === null; i++) {
    try {
      fd = openSync(lock, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' && i > 100) throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch {
        // released meanwhile
      }
      if (i > 500) throw new Error(`outbox lock ${lock} is held`);
      pause(10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // gone
    }
  }
}

function appendOutbox(item: OutboxItem) {
  withLock(() => appendFileSync(path(OUTBOX_FILE), `${JSON.stringify(item)}\n`));
}

/** Remove every line with this key, atomically, under the lock, so lines appended by other processes survive. */
function removeFromOutbox(key: string) {
  withLock(() => {
    const rest = readOutbox().filter((i) => i.key !== key);
    if (!rest.length) {
      try {
        unlinkSync(path(OUTBOX_FILE));
      } catch {
        // already gone
      }
      return;
    }
    atomicWrite(path(OUTBOX_FILE), rest.map((i) => JSON.stringify(i)).join('\n') + '\n');
  });
}

// ---------- read cache ----------

interface CacheEntry {
  tool: string;
  at: number;
  result: unknown;
}

const cacheable = (tool: string, args: unknown) => CACHEABLE.has(tool) && !(tool === 'control_get' && (args as { ack?: boolean } | null)?.ack === true);
const cacheKey = (tool: string, args: unknown) => `${tool}:${stable(args ?? {})}`;
const readCache = () => readJson<Record<string, CacheEntry>>(path(CACHE_FILE)) ?? {};

function cachePut(tool: string, args: unknown, result: unknown, at: number) {
  try {
    const json = JSON.stringify(result);
    if (json === undefined || json.length > CACHE_MAX_ENTRY_BYTES) return;
    const all = readCache();
    all[cacheKey(tool, args)] = { tool, at, result };
    const keys = Object.keys(all);
    if (keys.length > CACHE_MAX_ENTRIES) {
      keys
        .sort((a, b) => (all[a]!.at ?? 0) - (all[b]!.at ?? 0))
        .slice(0, keys.length - CACHE_MAX_ENTRIES)
        .forEach((k) => delete all[k]);
    }
    atomicWrite(path(CACHE_FILE), JSON.stringify(all));
  } catch {
    // the cache is best effort
  }
}

function cacheGet(tool: string, args: unknown): CacheEntry | null {
  const e = readCache()[cacheKey(tool, args)];
  return e && typeof e.at === 'number' ? e : null;
}

function staleOf(entry: CacheEntry, now: number): Record<string, unknown> {
  const meta = { stale: true, staleAgeMs: now - entry.at, staleSince: entry.at };
  const r = entry.result;
  return r && typeof r === 'object' && !Array.isArray(r) ? { ...(r as Record<string, unknown>), ...meta } : { ...meta, result: r };
}

// ---------- offline governor ----------

function localGovernor(cached: CacheEntry | null, now: number): Record<string, unknown> {
  const sample = readJson<{ ts?: unknown; session_id?: unknown; rate_limits?: Record<string, unknown> }>(join(bbHome(), 'statusline', 'latest.json'));
  const ts = typeof sample?.ts === 'number' ? sample.ts : null;
  const limits = sample?.rate_limits && typeof sample.rate_limits === 'object' ? sample.rate_limits : null;
  const usage: Usage =
    ts !== null && limits
      ? { fiveHour: windowOf(limits.five_hour), sevenDay: windowOf(limits.seven_day), updatedAt: ts, ageMs: now - ts, sessionId: typeof sample?.session_id === 'string' ? sample.session_id : null }
      : { fiveHour: null, sevenDay: null, updatedAt: null, ageMs: null, sessionId: null };
  const t = (cached?.result as { thresholds?: Partial<GovernorThresholds> } | null)?.thresholds;
  const thresholds: GovernorThresholds =
    t && typeof t.fiveHourPct === 'number' && typeof t.sevenDayPct === 'number' && typeof t.maxAgeMin === 'number' ? { fiveHourPct: t.fiveHourPct, sevenDayPct: t.sevenDayPct, maxAgeMin: t.maxAgeMin } : DEFAULT_THRESHOLDS;
  const v = evaluate(usage, thresholds, now);
  return {
    ...v,
    reason: `local (server unreachable): ${v.reason}`,
    local: true,
    stale: true,
    staleAgeMs: cached ? now - cached.at : null,
    staleSince: cached ? cached.at : null,
  };
}

// ---------- outage state ----------

interface OutageState {
  downSince: number | null;
  /** when the "down" ntfy message went out for this outage */
  downSentAt: number | null;
}

const loadState = (): OutageState => {
  const s = readJson<Partial<OutageState>>(path(STATE_FILE));
  return { downSince: typeof s?.downSince === 'number' ? s.downSince : null, downSentAt: typeof s?.downSentAt === 'number' ? s.downSentAt : null };
};
const saveState = (s: OutageState) => {
  try {
    if (s.downSince === null) unlinkSyncQuiet(path(STATE_FILE));
    else atomicWrite(path(STATE_FILE), JSON.stringify(s));
  } catch {
    // best effort
  }
};
function unlinkSyncQuiet(f: string) {
  try {
    if (existsSync(f)) unlinkSync(f);
  } catch {
    // ignore
  }
}

function ntfyTarget(): string | null {
  let topic: string | undefined;
  try {
    topic = readClientConfig().ntfyTopic;
  } catch {
    return null;
  }
  topic = topic?.trim();
  if (!topic) return null;
  return /^https?:\/\//i.test(topic) ? topic : `https://ntfy.sh/${encodeURIComponent(topic)}`;
}

/** Never throws; true when the message was accepted. */
async function sendNtfy(f: typeof fetch, title: string, body: string): Promise<boolean> {
  try {
    const target = ntfyTarget();
    if (!target) return false;
    const res = await f(target, { method: 'POST', headers: { Title: title }, body, signal: AbortSignal.timeout(NTFY_TIMEOUT_MS) });
    return !!res.ok;
  } catch {
    return false;
  }
}

// ---------- the layer ----------

export function createResilientClient(client: AgentClient, opts: ResilientOptions = {}): ResilientClient {
  const now = opts.now ?? Date.now;
  const ntfyFetch = opts.ntfyFetch ?? fetch;
  const interval = opts.replayIntervalMs ?? REPLAY_INTERVAL_MS;
  const alertAfter = opts.downAlertMs ?? DOWN_ALERT_MS;
  const where = opts.url ?? 'the configured URL';
  let inflight: Promise<ReplayResult> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const pending = new Set<Promise<unknown>>();

  const track = (p: Promise<unknown>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  const mine = (i: OutboxItem) => !i.owner || !opts.owner || i.owner === opts.owner;
  const queuedCount = () => readOutbox().filter(mine).length;

  async function maybeAlert() {
    const s = loadState();
    if (s.downSince === null || s.downSentAt !== null || now() - s.downSince <= alertAfter || !ntfyTarget()) return;
    // claim the message first so parallel failures do not send it twice; give it back if the send fails
    saveState({ ...s, downSentAt: now() });
    const n = queuedCount();
    const ok = await sendNtfy(ntfyFetch, 'Buildyboy server unreachable', `The Buildyboy server at ${where} has been unreachable since ${new Date(s.downSince).toISOString()}. ${n} call${n === 1 ? '' : 's'} queued.`);
    if (!ok) {
      const cur = loadState();
      if (cur.downSince === s.downSince) saveState({ ...cur, downSentAt: null });
    }
  }

  function markDown() {
    try {
      const s = loadState();
      if (s.downSince === null) saveState({ downSince: now(), downSentAt: null });
      arm();
      track(maybeAlert());
    } catch {
      // never throw from here
    }
  }

  function markUp() {
    try {
      const s = loadState();
      if (s.downSince === null) return;
      saveState({ downSince: null, downSentAt: null });
      if (s.downSentAt !== null) track(sendNtfy(ntfyFetch, 'Buildyboy server is back', `The Buildyboy server at ${where} is reachable again (it was unreachable since ${new Date(s.downSince).toISOString()}).`));
    } catch {
      // never throw from here
    }
  }

  function arm() {
    if (timer) return;
    timer = setInterval(() => void tick(), interval);
    timer.unref?.();
  }
  function disarm() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function tick() {
    try {
      await replay();
      if (!queuedCount() && loadState().downSince !== null) {
        // nothing queued to probe with: ask for something cheap so the outage can end
        try {
          await client.call('usage_get', {});
          markUp();
        } catch (e) {
          if (e instanceof AgentHttpError) markUp();
          else if (e instanceof UnreachableError) markDown();
        }
      }
      await maybeAlert();
      if (!queuedCount() && loadState().downSince === null) disarm();
    } catch {
      // the timer must survive anything
    }
  }

  async function doReplay(): Promise<ReplayResult> {
    const result: ReplayResult = { sent: 0, rejected: 0, remaining: 0, unreachable: null };
    for (;;) {
      const item = readOutbox().find(mine);
      if (!item) break;
      try {
        await client.call(item.tool, item.args, { key: item.key });
      } catch (e) {
        if (e instanceof UnreachableError) {
          result.unreachable = e.message;
          markDown();
          break;
        }
        if (e instanceof AgentHttpError) markUp();
        // a real error from the server: it will never succeed, so park it for a human
        try {
          appendFileSync(path(REJECTED_FILE), `${JSON.stringify({ ...item, rejectedAt: now(), status: e instanceof AgentHttpError ? e.status : null, error: (e as Error).message })}\n`);
          removeFromOutbox(item.key);
          result.rejected++;
        } catch {
          break; // cannot persist the decision: stop rather than loop
        }
        continue;
      }
      markUp();
      result.sent++;
      try {
        removeFromOutbox(item.key);
      } catch {
        break; // delivered but still listed: the next replay resends it, and the key makes that harmless
      }
    }
    result.remaining = queuedCount();
    return result;
  }

  function replay(): Promise<ReplayResult> {
    if (inflight) return inflight;
    if (!existsSync(path(OUTBOX_FILE))) return Promise.resolve({ sent: 0, rejected: 0, remaining: 0, unreachable: null });
    const p = doReplay().finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  }

  async function callQueueable(tool: ToolName, args: unknown, replayed: ReplayResult): Promise<unknown> {
    const key = randomUUID();
    const queue = (reason: string) => {
      const queuedAt = now();
      appendOutbox({ key, tool, args, queuedAt, ...(opts.owner ? { owner: opts.owner } : {}) });
      markDown();
      return { queued: true, tool, key, queuedAt, reason };
    };
    // order: when earlier calls are still waiting (server down), this one waits behind them
    if (replayed.remaining > 0) return queue(replayed.unreachable ?? 'earlier calls are still queued');
    try {
      const result = await client.call(tool, args, { key });
      markUp();
      return result;
    } catch (e) {
      if (e instanceof UnreachableError) return queue(e.message);
      if (e instanceof AgentHttpError) markUp();
      throw e;
    }
  }

  function offline(tool: ToolName, args: unknown, e: UnreachableError): unknown {
    const entry = cacheable(tool, args) ? cacheGet(tool, args) : null;
    if (tool === 'governor_get') return localGovernor(entry, now());
    if (entry) return staleOf(entry, now());
    if (cacheable(tool, args)) throw new Error(`server unreachable (${e.message})`);
    throw new Error(`server unreachable (${e.message}); not queued because its answer is needed now`);
  }

  return {
    async call(tool, args) {
      const a = args ?? {};
      const replayed = await replay().catch((): ReplayResult => ({ sent: 0, rejected: 0, remaining: queuedCount(), unreachable: null }));
      if (QUEUEABLE.has(tool)) return callQueueable(tool, a, replayed);
      try {
        const result = await client.call(tool, a);
        markUp();
        if (cacheable(tool, a)) cachePut(tool, a, result, now());
        return result;
      } catch (e) {
        if (e instanceof UnreachableError) {
          markDown();
          return offline(tool, a, e);
        }
        if (e instanceof AgentHttpError) markUp();
        throw e;
      }
    },
    replay,
    async start() {
      await replay().catch(() => undefined);
      if (queuedCount() || loadState().downSince !== null) arm();
    },
    async flush() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    queued: queuedCount,
    stop: disarm,
  };
}
