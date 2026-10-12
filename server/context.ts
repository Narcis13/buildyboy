import type { DB } from './db.ts';
import type { Bus } from './bus.ts';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  /** public base URL used in links and installers, e.g. https://buildyboy.example */
  publicUrl: string;
  /** repo root (for serving web/dist, plugin, harness-prompt.md) */
  rootDir: string;
  /** long-poll ceiling for PermissionRequest, in ms (hook timeout minus a margin) */
  permissionWaitMs: number;
  /** default Stop hold while walk mode is on, in minutes */
  stopWaitMin: number;
  /** PreToolUse pause ceiling, in ms */
  pauseWaitMs: number;
  production: boolean;
}

export interface Ctx {
  db: DB;
  bus: Bus;
  config: ServerConfig;
  /** notify hook: wired by push/ on startup; no-op in tests */
  notify: (n: Notification) => void;
  /** pending long-poll waiters keyed by pending action id */
  waiters: Map<string, (response: Record<string, unknown> | null) => void>;
  /** wakes PreToolUse pause waiters for a session */
  pauseWaiters: Map<string, Set<() => void>>;
  /** runner SSE connections keyed by machine id */
  runners: Map<string, (cmd: unknown) => void>;
}

export interface Notification {
  type: 'pending' | 'turn_done' | 'job' | 'stale' | 'loop' | 'ci' | 'budget' | 'context' | 'test';
  title: string;
  body: string;
  sessionId?: string;
  url?: string;
  actionId?: string;
  /** offer Allow/Deny buttons */
  actions?: boolean;
}
