import type { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { promptsRoutes } from './prompts.ts';
import { jobsRoutes } from './jobs.ts';
import { installRoutes } from './install.ts';
import { otlpRoutes } from './otlp.ts';
import { pushRoutes } from './push.ts';

/** Feature route modules, each owning its own paths. */
export function extraRoutes(ctx: Ctx): Hono[] {
  return [promptsRoutes(ctx), jobsRoutes(ctx), installRoutes(ctx), otlpRoutes(ctx), pushRoutes(ctx)] as Hono[];
}
