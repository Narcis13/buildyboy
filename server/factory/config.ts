// The factory's per-repo config (Settings → Factory, SPEC §11.7): where the gate recipe lives, which runner runs it,
// and the ranges tasks_claim allocates from. Plus gate_max_rounds. Stored as settings, edited only from the PWA.
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { FactoryConfig, RepoFactoryConfig } from '../../shared/factory.ts';

export const DEFAULT_MAX_ROUNDS = 3;

const port = z.number().int().min(1).max(65535).nullable();
export const repoConfigSchema = z.object({
  repo: z.string().trim().min(1).max(200),
  machineId: z.string().max(64).nullable().default(null),
  checkout: z.string().trim().max(1000).default(''),
  recipe: z.string().trim().max(1000).default(''),
  worktree: z.string().trim().max(1000).default(''),
  portFrom: port.default(null),
  portTo: port.default(null),
  dbPrefix: z.string().trim().max(60).regex(/^[\w-]*$/, 'letters, digits, _ and - only').default(''),
  migrationFrom: z.number().int().min(0).max(1_000_000).nullable().default(null),
  migrationBlock: z.number().int().min(1).max(1000).default(10),
  cleanup: z.array(z.string().max(2000)).max(30).default([]),
});
export const factoryConfigSchema = z.object({
  maxRounds: z.number().int().min(1).max(50),
  repos: z.array(repoConfigSchema).max(50),
});

export function factoryConfig(ctx: Ctx): FactoryConfig {
  const n = ctx.db.getSetting<unknown>('gate_max_rounds', DEFAULT_MAX_ROUNDS);
  const repos = z.array(repoConfigSchema).safeParse(ctx.db.getSetting<unknown>('factory_repos', []));
  return { maxRounds: typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ROUNDS, repos: repos.success ? repos.data : [] };
}

export function saveFactoryConfig(ctx: Ctx, cfg: FactoryConfig) {
  ctx.db.setSetting('gate_max_rounds', cfg.maxRounds);
  ctx.db.setSetting('factory_repos', cfg.repos);
}

export function repoConfig(ctx: Ctx, repo: string | null): RepoFactoryConfig | null {
  if (!repo) return null;
  return factoryConfig(ctx).repos.find((r) => r.repo.toLowerCase() === repo.trim().toLowerCase()) ?? null;
}

/** Replaces {name} placeholders with known values; unknown ones are left as they are. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}
