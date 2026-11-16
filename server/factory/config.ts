// The factory's global config (Settings → Factory): gate_max_rounds, and `fill` for every template. §11.7's per-repo
// config now lives in the projects (SPEC §12.1, migration 009); GET/PUT /api/factory/config keep its old shape for the
// Settings card: a repo is a project with legacy fields (machine, checkout and recipe = its line file, plus
// config.legacy), and saving a repo writes them back onto its project, creating one for a new repo.
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { legacyRepoConfigSchema, type FactoryConfig, type RepoFactoryConfig } from '../../shared/factory.ts';
import { createProject, listProjectRows, projectByRepo, projectConfig, setProjectConfig, setProjectColumns } from './projects.ts';

export const DEFAULT_MAX_ROUNDS = 3;

export const repoConfigSchema = legacyRepoConfigSchema.extend({
  repo: z.string().trim().min(1).max(200),
  machineId: z.string().max(64).nullable().default(null),
  checkout: z.string().trim().max(1000).default(''),
  recipe: z.string().trim().max(1000).default(''),
});
export const factoryConfigSchema = z.object({
  maxRounds: z.number().int().min(1).max(50),
  repos: z.array(repoConfigSchema).max(50),
});

/** gate_max_rounds (default 3) */
export function maxRounds(ctx: Ctx): number {
  const n = ctx.db.getSetting<unknown>('gate_max_rounds', DEFAULT_MAX_ROUNDS);
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ROUNDS;
}

/** GET /api/factory/config: the round limit and, per project with legacy fields, its §11.7 repo config. */
export function factoryConfig(ctx: Ctx): FactoryConfig {
  const repos = listProjectRows(ctx).flatMap((p): RepoFactoryConfig[] => {
    const legacy = projectConfig(p).legacy;
    return legacy ? [{ repo: p.repo ?? p.key, machineId: p.machine_id, checkout: p.checkout ?? '', recipe: p.line_file, ...legacy }] : [];
  });
  return { maxRounds: maxRounds(ctx), repos };
}

/**
 * PUT /api/factory/config. Each repo's fields go onto the project of that repo (a new project for a new repo); a
 * project that had legacy fields and is no longer listed loses them (the project and its packages stay).
 */
export function saveFactoryConfig(ctx: Ctx, cfg: z.input<typeof factoryConfigSchema>, actor = 'web') {
  const c = factoryConfigSchema.parse(cfg);
  ctx.db.tx(() => {
    ctx.db.setSetting('gate_max_rounds', c.maxRounds);
    const kept = new Set<string>();
    for (const r of c.repos) {
      const { repo, machineId, checkout, recipe, ...legacy } = r;
      const p = projectByRepo(ctx, repo, true) ?? createProject(ctx, { key: undefined, name: undefined, repo }, actor);
      setProjectColumns(ctx, p.key, { machineId: machineId || null, checkout: checkout || null, lineFile: recipe || 'factory.json' });
      setProjectConfig(ctx, p.key, { ...projectConfig(p), legacy });
      kept.add(p.key);
    }
    for (const p of listProjectRows(ctx)) {
      const { legacy, ...rest } = projectConfig(p);
      if (legacy && !kept.has(p.key)) setProjectConfig(ctx, p.key, rest);
    }
  });
}

/** Replaces {name} placeholders with known values; unknown ones are left as they are. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}
