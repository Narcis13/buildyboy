// HTTP to the server: JSON posts, a per-job event sender that batches and retries, and an SSE reader.
import type { RunnerEvent } from '../shared/types.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export interface Api {
  post(path: string, body: unknown, timeoutMs?: number): Promise<unknown>;
  url: string;
  token: string;
}

export function makeApi(url: string, token: string): Api {
  return {
    url,
    token,
    async post(path, body, timeoutMs = 20_000) {
      const res = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, `${path} -> ${res.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serial, ordered delivery of one job's events. Output lines are coalesced; transient failures retry with backoff. */
export function eventSender(api: Api, jobId: string, log: (s: string) => void) {
  const queue: RunnerEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let closed = false;

  const pump = async () => {
    let backoff = 1000;
    while (queue.length) {
      const batch = queue.splice(0, 50);
      try {
        await api.post(`/api/runner/jobs/${encodeURIComponent(jobId)}/events`, { events: batch });
        backoff = 1000;
      } catch (e) {
        if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
          log(`job ${jobId}: server rejected events (${e.message}); dropping`);
          continue;
        }
        queue.unshift(...batch);
        // bound memory while the server is away: drop the oldest output, never a status
        let lines = 0;
        for (const ev of queue) if (ev.type === 'output') lines += ev.lines.length;
        while (lines > 20_000) {
          const i = queue.findIndex((ev) => ev.type === 'output');
          if (i < 0) break;
          lines -= (queue[i] as { lines: string[] }).lines.length;
          queue.splice(i, 1);
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };

  const kick = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!running) {
      running = pump().finally(() => {
        running = null;
        if (queue.length) void kick();
      });
    }
    return running;
  };

  return {
    push(ev: RunnerEvent) {
      if (closed) return;
      const last = queue[queue.length - 1];
      if (ev.type === 'output' && last?.type === 'output' && last.lines.length < 500) last.lines.push(...ev.lines);
      else queue.push(ev);
      if (ev.type !== 'output') void kick();
      else if (!timer && !running) timer = setTimeout(() => void kick(), 300);
    },
    /** resolves when everything queued so far has been delivered (or dropped) */
    async flush() {
      while (queue.length || running) await kick();
    },
    close() {
      closed = true;
    },
  };
}

/** Reads one SSE connection; resolves when it ends. Calls `onEvent(event, data)` per message. */
export async function readSSE(api: Api, path: string, onEvent: (event: string, data: string) => void, signal: AbortSignal, idleMs = 70_000): Promise<void> {
  const ac = new AbortController();
  const abort = () => ac.abort();
  signal.addEventListener('abort', abort);
  let idle: NodeJS.Timeout | null = null;
  const bump = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(abort, idleMs); // server pings every 25 s; silence means a dead connection
  };
  try {
    bump();
    const res = await fetch(api.url + path, { headers: { authorization: `Bearer ${api.token}`, accept: 'text/event-stream' }, signal: ac.signal });
    if (!res.ok || !res.body) throw new HttpError(res.status, `${path} -> ${res.status}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      bump();
      buf += dec.decode(chunk as Uint8Array, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) onEvent(event, data.join('\n'));
      }
    }
  } finally {
    if (idle) clearTimeout(idle);
    signal.removeEventListener('abort', abort);
  }
}
