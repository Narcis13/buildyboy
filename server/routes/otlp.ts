import { Hono } from 'hono';
import type { Ctx } from '../context.ts';

export function otlpRoutes(_ctx: Ctx) {
  const app = new Hono();
  return app;
}
