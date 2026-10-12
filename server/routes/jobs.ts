import { Hono } from 'hono';
import type { Ctx } from '../context.ts';

export function jobsRoutes(_ctx: Ctx) {
  const app = new Hono();
  return app;
}
